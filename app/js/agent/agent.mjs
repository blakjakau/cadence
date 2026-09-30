// agent.mjs
import workspaceClient from "../workspace-client.mjs";
import agentTools from "./agent-tools.mjs";
import AgentBackup from "./agent-backup.mjs";
import { Block, Inline, Button } from "../elements.mjs";

export class Agent {
	constructor(aiManager, session, connection) {
		this.aiManager = aiManager;
		this.session = session;
		this.connection = connection; // Instantiated AI adapter subclass
		this._abortAgent = false;
		this.throttleBar = null;
		this.haltBar = null;
		this._throttleResolve = null;
		this.consecutiveHaltCount = 0;
		this.repetitionHaltCount = 0;
		this.protocolFlagRepeatCount = 0;
		this.subAgentsCreated = [];
		this.reportedSubAgents = new Set();
	}

	stop(reason = "User requested stop") {
		this._abortAgent = true;
		if (this.throttleBar) {
			this.throttleBar.remove();
			this.throttleBar = null;
		}
		if (this._throttleResolve) {
			this._throttleResolve();
			this._throttleResolve = null;
		}
		if (this.connection) {
			this.connection.stop(reason);
		}
		// Cascade abort to all active child sub-agents
		const parentId = this.session.id;
		for (const [subId, run] of this.aiManager.runningSessions) {
			if (run.type === 'agent' && run.instance?.session?.parentId === parentId) {
				run.instance.stop(`Parent agent aborted: ${reason}`);
			}
		}
	}

	async run(userMessage, userMessageElement) {
		let loopCount = 0;
		this._abortAgent = false;
		let isThrottled = true;
		const { aiManager, session, connection } = this;
		const now = Date.now();
		if (!session.currentCycleStartTimestamp) {
			session.currentCycleStartTimestamp = now;
		}
		if (!session.lastMilestoneTimestamp) {
			session.lastMilestoneTimestamp = session.createdAt || now;
		}
		if (!session.checkpoints || session.checkpoints.length === 0) {
			session.checkpoints = [{ name: "session_start", timestamp: session.lastMilestoneTimestamp }];
		}
		const connConfig = connection?.config || {};
		const hasRateLimits = !!(connConfig.rpmLimit || connConfig.rpdLimit || connConfig.tpmLimit || connConfig.requestsPerMin || connection?.requestsPerMin);
		const maxTurns = connConfig.maxTurns !== undefined ? connConfig.maxTurns : (connection?.config?.maxTurns || 0);
		// Calculate soft throttle iteration threshold as 1/3 of maxTurns (0 for unlimited turns)
		const maxIterations = maxTurns > 0 ? Math.max(1, Math.round(maxTurns / 3)) : 0;
		let nextThrottleThreshold = maxIterations > 0 ? maxIterations : Infinity;

		while (aiManager.runningSessions.has(session.id)) {
			if (this._abortAgent) break;

			loopCount++;

			// Check maxTurns limit (0 = unlimited / off)
			if (maxTurns > 0 && loopCount > maxTurns) {
				console.warn(`🛑 [Agent Loop Halted] Reached connection maximum turn limit of ${maxTurns} turns.`);
				
				const haltPromise = new Promise(resolve => {
					if (this.haltBar) {
						this.haltBar.remove();
					}
					const haltBar = new Block();
					this.haltBar = haltBar;
					haltBar.className = "agent-throttle-bar";
					haltBar.style.borderLeft = "4px solid var(--accent, #e5a50a)";
					
					haltBar.innerHTML = `
						<ui-icon style="vertical-align: middle; margin-right: 4px; font-size: 16px;">pause_circle</ui-icon>
						<span class="throttle-text">Agent halted: reached limit of ${maxTurns} turns.</span>
						<ui-button class="throttle-toggle theme-button primary" style="padding: 4px 8px; font-size: 11px; margin-left: 12px; min-width: 90px;">Continue &gt;</ui-button>
					`;

					const btn = haltBar.querySelector('.throttle-toggle');
					btn.onclick = () => {
						haltBar.remove();
						this.haltBar = null;
						loopCount = 1; // Reset counter for the next batch
						nextThrottleThreshold = maxIterations > 0 ? maxIterations : Infinity;
						isThrottled = true;
						aiManager.setSessionProcessing(session.id, true, 'agent', null);
						aiManager._updateTabStatus(session.id, "active");
						resolve();
					};

					aiManager.chatContainer.append(haltBar);
					if (aiManager.conversationArea) {
						aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
					}
				});

				aiManager.setSessionProcessing(session.id, false);
				aiManager._updateTabStatus(session.id, "halted");

				await haltPromise;
				if (this._abortAgent || !aiManager.runningSessions.has(session.id)) break;
			}

			// Apply throttle threshold if max_iterations is set (> 0)
			if (maxIterations > 0 && loopCount >= nextThrottleThreshold) {
				if (!this.throttleBar) {
					isThrottled = true;
					this.throttleBar = new Block();
					this.throttleBar.className = "agent-throttle-bar";
					this.throttleBar.innerHTML = `
						<ui-icon style="vertical-align: middle; margin-right: 4px; font-size: 16px;">speed</ui-icon>
						<span class="throttle-text"></span>
						<ui-button class="throttle-toggle theme-button" style="padding: 4px 8px; font-size: 11px; margin-left: 12px; min-width: 80px;">Continue &gt;</ui-button>
					`;
					const btn = this.throttleBar.querySelector('.throttle-toggle');
					btn.onclick = () => {
						isThrottled = false;
						nextThrottleThreshold = loopCount + maxIterations;
						if (this.throttleBar) {
							this.throttleBar.remove();
							this.throttleBar = null;
						}
						if (this._throttleResolve) {
							this._throttleResolve();
							this._throttleResolve = null;
						}
					};
					aiManager.chatContainer.append(this.throttleBar);
				}
				if (this.throttleBar) {
					this.throttleBar.querySelector('.throttle-text').innerText = `Agent execution throttled due to long running task: ${loopCount} of ${maxTurns} turns`;
				}

				if (isThrottled) {
					await new Promise(r => {
						this._throttleResolve = r;
						setTimeout(() => {
							this._throttleResolve = null;
							r();
						}, 7000);
					});
				}
			}

			// Begin multi-file atomic transaction for this turn
			const turnTxId = `tx_${session.id}_${loopCount}_${Date.now()}`;
			session.turnTransactionId = turnTxId;
			await AgentBackup.beginTransaction(turnTxId);

			// Check and compile any newly completed sub-agents at start of turn
			const compiledResults = await this.checkAndCompileSubAgentResults(session);
			if (compiledResults) {
				const toolResponseMessage = {
					id: crypto.randomUUID(),
					role: "user",
					type: "tool_response",
					content: `[Tool Response: create_sub_agent]\n\n${compiledResults}`,
					timestamp: Date.now()
				};
				session.messages.push(toolResponseMessage);
				session.lastModified = Date.now();
				await workspaceClient.setSession(session.id, session);
				
				// Re-render UI to display the new tool response message
				if (aiManager.isSessionViewed(session.id)) {
					aiManager.historyManager.render();
				}

				// If we added results, we want the agent to see them and re-evaluate its next step
				// without necessarily sending a new prompt request immediately.
				// This loop will continue and proceed to model inference with the updated history.
				continue; 
			}


			// Phase 3.3 — Preemptive cycle compaction: if a prior prompt crossed the summarization
			// threshold without a separate compaction connection (or the background compaction failed),
			// run the compaction NOW on the session's own (primary) connection, bounded by a timeout so
			// the turn is never stalled indefinitely. A content-only seed (if any) remains as a continuity
			// anchor throughout; it is replaced in-place on success. A brief progress chip lets the user
			// know the turn is momentarily delayed.
			if (session._pendingCycleCompaction) {
				delete session._pendingCycleCompaction;
				// Phase 3.3 — Mitigate the preemption's interruption of the user's flow with a brief
				// toast (matches the cascade toast), in addition to the in-conversation progress chip.
				if (window.modal?.toast) window.modal.toast("History compaction in progress…", 2500);
				let preemptEl = null;
				if (aiManager.isSessionViewed(session.id) && aiManager.conversationArea) {
					preemptEl = new Block();
					preemptEl.className = "agent-tool-progress";
					preemptEl.innerHTML = `<ui-icon class="spin">cached</ui-icon> Compacting prior cycle…`;
					aiManager.conversationArea.append(preemptEl);
					if (aiManager._shouldAutoScroll() && aiManager.conversationArea) aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
				}
				try {
					const COMPACT_TIMEOUT_MS = 90000;
					let timedOut = false;
					const compacted = await Promise.race([
						aiManager.historyManager.autoCompactAgentCycle(session, {
							// Force the compaction onto the session's own (primary) connection — the whole point
							// of the preemption when no separate compaction connection is available.
							connectionId: session.connectionId,
							progress: (msg) => { if (preemptEl) preemptEl.textContent = msg; }
						}),
						new Promise(resolve => setTimeout(() => {
							// Promise.race does NOT cancel the in-flight compaction — it keeps running on the
							// main connection and will land the real summary (replacing the seed in place).
							// So we must NOT clear the seed here; it's still a live anchor.
							timedOut = true;
							console.warn("Cycle compaction timed out after 90s — proceeding without the summary (seed anchor retained).");
							resolve(false);
						}, COMPACT_TIMEOUT_MS))
					]);
					if (!compacted && !timedOut) {
						// Genuine no-op (no boundary) or failure — clear the stale seed anchor so it doesn't
						// linger as a placeholder. (On timeout the seed is retained; the in-flight compaction
						// will replace it in place when it completes.)
						aiManager.historyManager.clearPendingSeed(session);
					}
				} catch (e) {
					console.warn("Preemptive cycle compaction failed; proceeding with seed anchor:", e);
					aiManager.historyManager.clearPendingSeed(session);
				} finally {
					if (preemptEl) preemptEl.remove();
				}
			}

			const modelMessageId = crypto.randomUUID();
			const responseBlock = aiManager.historyManager.createStreamingBlock(modelMessageId, "model", session.id);
			if (aiManager.isSessionViewed(session.id)) {
				aiManager._startGlow(session.id);
				aiManager.conversationArea.append(responseBlock);
				const shouldScrollAtStart = aiManager._shouldAutoScroll();
				if (shouldScrollAtStart && aiManager.conversationArea) {
					aiManager.scrollToBottom(true);
				}
			}

			let currentFullResponse = "";
			let streamForciblyEnded = false;
			let forcedReason = "";

			let messagesForAI = null;
			let systemPrompt = null;
			let callbacks = null;

			const runPromise = new Promise((resolve, reject) => {
				callbacks = {
					onUpdate: (fullResponse, updateData = null) => {
						if (streamForciblyEnded) return;
						currentFullResponse = fullResponse;
						const toolCalls = updateData?.toolCalls ?? callbacks.toolCalls;
						const thought = updateData?.thought ?? callbacks.thought;
						const isThinking = updateData?.isThinking ?? callbacks.isThinking;
						if (toolCalls && toolCalls.length > 0) {
							aiManager._startGlow(session.id);
						} else {
							aiManager._stopGlow(session.id);
						}
						const shouldScroll = aiManager._shouldAutoScroll();
						responseBlock.updateContent(fullResponse, false, toolCalls, thought, isThinking);
						if (aiManager.isSessionViewed(session.id) && shouldScroll && aiManager.conversationArea) {
							aiManager.scrollToBottom(true);
						}

						// Scan streaming tokens for early truncation
						const check = aiManager._checkStreamingResponse(fullResponse, session);
						if (check.shouldAbort) {
							streamForciblyEnded = true;
							forcedReason = check.reason;
							connection.stop(check.reason);
							
							// Save immediately since connection.stop throws AbortError which doesn't trigger onError
							aiManager._finalizeModelMessage(currentFullResponse, forcedReason, callbacks, modelMessageId, responseBlock, session)
								.then(finalizedResponse => resolve(finalizedResponse))
								.catch(err => reject(err));
						}
					},
					onDone: async (fullResponse) => {
						if (streamForciblyEnded) return;
						currentFullResponse = fullResponse;
						aiManager._stopGlow(session.id);
						const finalizedResponse = await aiManager._finalizeModelMessage(fullResponse, null, callbacks, modelMessageId, responseBlock, session);
						resolve(finalizedResponse);
					},
					onError: async (err) => {
						aiManager._stopGlow(session.id);
						if (streamForciblyEnded) {
							resolve(currentFullResponse);
							return;
						}
						reject(err);
					},
					onPrefillProgress: (progressData) => {
						if (streamForciblyEnded) return;
						const total = progressData.total;
						const cache = progressData.cache || 0;
						const processed = progressData.processed;
						const pct = (total - cache > 0) ? Math.round(((processed - cache) / (total - cache)) * 100) : (total > 0 ? Math.round((processed / total) * 100) : 0);
						aiManager._showPrefillProgress(responseBlock, pct, progressData);
					}
				};

				messagesForAI = aiManager.historyManager.prepareMessagesForAI(session);
				aiManager.getSystemPrompt(session).then(sysPrompt => {
					systemPrompt = sysPrompt;
					connection.chat(messagesForAI, callbacks, systemPrompt, session);
				}).catch(reject);
			});

			try {
				let responseContent = await runPromise;

				if (forcedReason === "secondary_thought" || forcedReason === "secondary_tool_call") {
					if (this.protocolFlagRepeatCount < 5) {
						this.protocolFlagRepeatCount++;
						console.warn(`⚠️ [Agent Protocol Flag Detected] Removing last response and re-submitting (Attempt ${this.protocolFlagRepeatCount} of 5)...`);

						// 1. Remove the model response and the protocol flag alert message from session.messages
						session.messages = session.messages.filter(m => m.id !== modelMessageId && !(m.type === "system_message" && m.content.includes("Agent Protocol Flag")));
						session.lastModified = Date.now();
						await workspaceClient.setSession(session.id, session);

						// 2. Remove the response block element
						if (responseBlock && typeof responseBlock.remove === "function") {
							responseBlock.remove();
						}

						// 3. Update DOM if active
						if (aiManager.isSessionViewed(session.id)) {
							aiManager.historyManager.render();
						}

						// 4. Show recovery progress bar
						const autoMsg = new Block();
						autoMsg.className = "agent-tool-progress";
						
						const spinIcon = document.createElement("ui-icon");
						spinIcon.className = "spin";
						spinIcon.textContent = "cached";
						
						const msgText = new Inline();
						msgText.textContent = `Recovering from Agent Protocol Flag (Attempt ${this.protocolFlagRepeatCount} of 5)...`;
						
						autoMsg.append(spinIcon, msgText);

						if (aiManager.isSessionViewed(session.id)) {
							aiManager.conversationArea.append(autoMsg);
							if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}
						await new Promise(r => setTimeout(r, 1500));
						autoMsg.remove();

						loopCount--; // Decrement loopCount to retry this step in the loop
						continue; // Go to next loop iteration
					} else {
						// 5 recovery attempts exhausted: halt and display the flag with a button to continue for another 5 repeats.
						console.error("❌ [Agent Protocol Flag] 5 attempts exhausted. Halting agent.");
						
						// Show the flag/halt banner with a Continue button
						const haltPromise = new Promise(resolve => {
							const haltBar = new Block();
							haltBar.className = "agent-halt-bar";
							
							const iconEl = document.createElement("ui-icon");
							iconEl.textContent = "warning";
							iconEl.className = "halt-icon";

							const textEl = new Inline();
							textEl.className = "halt-text";
							textEl.innerHTML = "⚠️ <b>Agent Halted:</b> Agent Protocol Flag triggered 5 times consecutively.";

							const actionsEl = new Block();
							actionsEl.className = "halt-actions";

							const continueBtn = new Button("Continue (5 More Attempts)");
							continueBtn.className = "halt-continue theme-button";
							continueBtn.onclick = async () => {
								haltBar.remove();
								this.protocolFlagRepeatCount = 0; // Reset for another 5 attempts

								// Remove the model response and the protocol flag alert message from session.messages
								session.messages = session.messages.filter(m => m.id !== modelMessageId && !(m.type === "system_message" && m.content.includes("Agent Protocol Flag")));
								session.lastModified = Date.now();
								await workspaceClient.setSession(session.id, session);

								if (responseBlock && typeof responseBlock.remove === "function") {
									responseBlock.remove();
								}

								if (aiManager.isSessionViewed(session.id)) {
									aiManager.historyManager.render();
								}
								
								// Set status back to processing
								aiManager.setSessionProcessing(session.id, true, 'agent', null);

								resolve();
							};

							actionsEl.append(continueBtn);
							haltBar.append(iconEl, textEl, actionsEl);
							aiManager.chatContainer.append(haltBar);

							// Scroll to make sure it's visible
							if (aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						});

						aiManager.setSessionProcessing(session.id, false);
						aiManager._updateTabStatus(session.id, "halted");

						await haltPromise;

						loopCount--; // Decrement loopCount to retry this step in the loop
						continue; // Go to next loop iteration
					}
				}

				if (forcedReason === "repetition_loop") {
					if (this.repetitionHaltCount < 5) {
						this.repetitionHaltCount++;
						console.warn(`⚠️ [Agent Repetition Loop Detected] Trimming and injecting directive (Attempt ${this.repetitionHaltCount} of 5)...`);

						// 1. Trim the model response content
						let trimmedContent = responseContent;
						const repCheck = aiManager._detectRepetition(responseContent);
						if (repCheck.detected && repCheck.pattern) {
							const patternLen = repCheck.pattern.length;
							trimmedContent = responseContent.slice(0, responseContent.length - (patternLen * (repCheck.count - 1)));
						}

						// 2. Update the model message in session history
						if (session && session.messages) {
							const msgIdx = session.messages.findIndex(m => m.id === modelMessageId);
							if (msgIdx !== -1) {
								session.messages[msgIdx].content = trimmedContent;
								session.messages[msgIdx].isTrimmed = true;
							}
						}

						// 3. Scale temperature to force more randomness
						session.temperatureOverride = Math.min(0.98, 0.75 + (this.repetitionHaltCount * 0.05));

						// 4. Build dynamic warning directive
						let warningContent = "[SYSTEM WARNING: You have entered a generation loop repeating the same action. You must immediately choose a DIFFERENT action or tool, vary your arguments, and break this loop.]";
						if (repCheck.detected && repCheck.pattern) {
							if (repCheck.pattern.includes("<tool_call")) {
								const toolNameMatch = repCheck.pattern.match(/<tool_call\s+name="([^"]+)"/);
								if (toolNameMatch) {
									const toolName = toolNameMatch[1];
									warningContent = `[SYSTEM WARNING: You have entered a loop repeatedly calling the tool \`${toolName}\` with identical or highly similar parameters. You MUST choose a different tool, check your search/replace parameters, or proceed with a different method to solve the objective.]`;
								}
							}
						}

						// 5. Create and append the system directive message
						const directiveMsg = {
							id: crypto.randomUUID(),
							role: "user",
							type: "system_directive",
							content: warningContent,
							timestamp: Date.now()
						};
						session.messages.push(directiveMsg);
						session.lastModified = Date.now();
						await workspaceClient.setSession(session.id, session);

						// 6. Update DOM if active
						if (aiManager.isSessionViewed(session.id)) {
							if (responseBlock && typeof responseBlock.updateContent === "function") {
								responseBlock.updateContent(trimmedContent);
							}
							aiManager.historyManager.render();
							if (aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}

						// 7. Briefly pause, then continue the loop
						const autoMsg = document.createElement("div");
						autoMsg.className = "agent-tool-progress";
						autoMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> <span>Recovering from repetition loop (Attempt ${this.repetitionHaltCount} of 5)...</span>`;
						if (aiManager.isSessionViewed(session.id)) {
							aiManager.conversationArea.append(autoMsg);
							if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}
						await new Promise(r => setTimeout(r, 1500));
						autoMsg.remove();

						loopCount--; // Decrement to retry this turn
						continue; // Go to next loop iteration
					} else {
						// 5 recovery attempts exhausted: close agent loop and prompt user to continue
						console.error("❌ [Agent Repetition Loop] 5 recovery attempts exhausted.");
						delete session.temperatureOverride;

						const haltPromise = new Promise(resolve => {
							const errorBlock = document.createElement("div");
							errorBlock.className = "response-block warning-block";
							errorBlock.style.border = "1px solid var(--color-error, #dc3545)";
							errorBlock.style.background = "var(--bg-secondary)";
							errorBlock.style.padding = "12px 16px";
							errorBlock.style.borderRadius = "var(--borderRadius)";
							errorBlock.style.margin = "8px 0 16px 0";
							errorBlock.innerHTML = `
								<div style="font-weight: 500; display: flex; align-items: center; gap: 8px;">
									<ui-icon style="color: var(--color-error, #dc3545);">error</ui-icon>
									<span><b>Agent Halted:</b> Repetitive generation loop detected. 5 recovery attempts were exhausted.</span>
								</div>
								<div style="margin-top: 8px; display: flex; gap: 12px; align-items: center; margin-left: 24px;">
									<button class="theme-button primary rep-continue-btn" style="padding: 4px 10px; font-size: 11px; font-weight: 600; min-width: 80px; cursor: pointer; border-radius: var(--borderRadius); border: none;">Continue (5 More Attempts)</button>
								</div>
							`;

							const btn = errorBlock.querySelector(".rep-continue-btn");
							btn.onclick = async () => {
								errorBlock.remove();
								this.repetitionHaltCount = 0; // Reset for another 5 attempts

								if (responseBlock && typeof responseBlock.remove === "function") {
									responseBlock.remove();
								}

								if (aiManager.isSessionViewed(session.id)) {
									aiManager.historyManager.render();
								}

								aiManager.setSessionProcessing(session.id, true, 'agent', null);
								resolve();
							};

							if (aiManager.isSessionViewed(session.id)) {
								aiManager.conversationArea.append(errorBlock);
								if (aiManager.conversationArea) {
									aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
								}
							}
						});

						aiManager.setSessionProcessing(session.id, false);
						aiManager._updateTabStatus(session.id, "halted");

						await haltPromise;

						loopCount--; // Decrement to retry this turn
						continue; // Go to next loop iteration
					}
				}

				// Retrieve structured tool calls directly from callbacks or model message in session
				let toolCalls = [];
				const lastModelMsg = session?.messages ? session.messages.find(m => m.id === modelMessageId) : null;
				const sourceToolCalls = (callbacks && callbacks.toolCalls && callbacks.toolCalls.length > 0)
					? callbacks.toolCalls
					: (lastModelMsg?.toolCalls || []);

				// Model-lead context pruning: if the model issues cull_history(idx), treat it as a control signal
				// (not a real tool). Resolve idx against the transient cullIndex (dialogue position → source id),
				// move the pruning marker forward, strip the marker text, and continue WITHOUT producing a tool response.
				// if (typeof aiManager.historyManager.getcullIndex === "function") {
				// 	const cullIndex = aiManager.historyManager.getcullIndex();
				// 	// TEMP DIAGNOSTIC (remove after live cull_history test):
				// 	console.log("[cull_history DIAG] hasMatch=" + (typeof responseContent === "string" ? responseContent.match(/cull_history\s*\(\s*(\d+)\s*\)/) !== null : "NOT-A-STRING") + " | mapSize=" + (cullIndex ? cullIndex.size : "NULL") + " | contentTail=" + (typeof responseContent === "string" ? JSON.stringify(responseContent.slice(-120)) : "n/a"));
				// 	if (cullIndex) {
				// 		const m = responseContent.match(/cull_history\s*\(\s*(\d+)\s*\)/);
				// 		if (m) {
				// 			const idx = parseInt(m[1], 10);
				// 			const id = cullIndex.get(idx);
				// 			if (id != null) {
				// 				session.contextHeadMsgId = id;
				// 				if (session.lastModified != null) {
				// 					session.lastModified = Date.now();
				// 				}
				// 				responseContent = responseContent.split(`cull_history(${m[1].trim()})`).join("");
				// 				console.log("[cull_history DIAG] RESOLVED idx=" + idx + " -> id=" + id + " | stripped");
				// 			} else {
				// 				console.warn(`[Agent] Ignored invalid cull_history(${idx}) â out of range / not culleable. | mapKeys=` + [...cullIndex.keys()]);
				// 			}
				// 		}
				// 	} else {
				// 		console.warn("[cull_history DIAG] cullIndex is NULL â map never built or not exposed.");
				// 	}
				// } else {
				// 	console.warn("[cull_history DIAG] getcullIndex is not a function on historyManager.");
				// }

				if (sourceToolCalls && sourceToolCalls.length > 0) {
					toolCalls = sourceToolCalls.map(tc => {
						const callObj = tc.functionCall || tc;
						const sig = tc.thoughtSignature || tc.thought_signature || callObj.thoughtSignature || callObj.thought_signature || lastModelMsg?.thoughtSignature || callbacks?.thoughtSignature;
						return {
							id: tc.id || `call_${crypto.randomUUID()}`,
							name: callObj.name || tc.name,
							arguments: callObj.args || callObj.arguments || {},
							...(sig ? { thoughtSignature: sig } : {})
						};
					});
				} else if (!aiManager.isKnownReasoningModel(session)) {
					toolCalls = aiManager._parseAllToolCalls(responseContent);
				}

				const regex = /<[^>]*>/g;
				const sessionAgentMode = session ? (session.agentMode ?? aiManager.agentMode) : aiManager.agentMode;
				
				if (toolCalls.length === 0 || !sessionAgentMode) {
					if (!sessionAgentMode) {
						aiManager.setSessionProcessing(session.id, false);
						if (aiManager.isSessionViewed(session.id)) {
							aiManager._dispatchContextUpdate("append_model");
						}
						return;
					}

					// Check if the response contains anything other than thought blocks or XML tags
					let strippedThoughts = (responseContent || "").trim();
					if (!aiManager.isKnownReasoningModel(session)) {
						strippedThoughts = strippedThoughts
							.replace(/<thought>[\s\S]*?<\/thought>/gi, '')
							.replace(/<think>[\s\S]*?<\/think>/gi, '')
							.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '')
							.replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
							.replace(/<[^>]*>/g, '')
							.trim();
					}

					// If the model finished without making a tool-call and produced no output other than thought:
					// Crop the turn (remove incomplete/empty model turn) and automatically resubmit the last user/system turn.
					if (strippedThoughts.length === 0) {
						if (this.emptyTurnRetryCount === undefined) {
							this.emptyTurnRetryCount = 0;
						}

						if (this.emptyTurnRetryCount < 5) {
							this.emptyTurnRetryCount++;
							console.warn(`⚠️ [Agent Empty Output / Thought Only] Model finished without tool calls or output text. Cropping turn and resubmitting (Attempt ${this.emptyTurnRetryCount} of 5)...`);

							// 1. Remove empty/thought-only model turn from session history
							if (session && session.messages) {
								session.messages = session.messages.filter(m => m.id !== modelMessageId);
								session.lastModified = Date.now();
								await workspaceClient.setSession(session.id, session);
							}

							// 2. Remove the response block element from the DOM
							if (responseBlock && typeof responseBlock.remove === "function") {
								responseBlock.remove();
							}

							// 3. Re-render UI to keep conversation clean
							if (aiManager.isSessionViewed(session.id)) {
								aiManager.historyManager.render();
							}

							// 4. Show brief progress indicator
							const retryProgress = document.createElement("div");
							retryProgress.className = "agent-tool-progress";
							retryProgress.innerHTML = `<ui-icon class="spin">cached</ui-icon> <span>No tool call made. Resubmitting turn (Attempt ${this.emptyTurnRetryCount} of 5)...</span>`;
							if (aiManager.isSessionViewed(session.id)) {
								aiManager.conversationArea.append(retryProgress);
								if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
									aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
								}
							}
							await new Promise(r => setTimeout(r, 1000));
							retryProgress.remove();

							loopCount--; // Retry this turn iteration
							continue;
						} else {
							console.error("❌ [Agent Empty Output] 5 resubmit attempts exhausted.");
							this.emptyTurnRetryCount = 0;
						}
					}

					// Sub-agents MUST always end with a tool call — re-inject a directive instead of halting
					if (session.parentId) {
						if (this.consecutiveHaltCount < 3) {
							this.consecutiveHaltCount++;
							console.warn(`⚠️ [Sub-Agent] Ended turn without a tool call. Injecting directive (Attempt ${this.consecutiveHaltCount} of 3)...`);

							// Strip the empty model turn from history
							if (session && session.messages) {
								session.messages = session.messages.filter(m => m.id !== modelMessageId);
								session.lastModified = Date.now();
								await workspaceClient.setSession(session.id, session);
							}
							if (responseBlock && responseBlock.parentNode) {
								responseBlock.remove();
							}

							// Inject a firm directive as a user message
							const directiveMsg = {
								id: crypto.randomUUID(),
								role: "user",
								type: "system_directive",
								content: "You MUST finish your turn with a tool call. If you have completed your task, you must return your conclusion via the `sub_agent_complete` tool. If you are blocked or need information from the user, call `query`. Otherwise, continue your work with another tool call.",
								timestamp: Date.now()
							};
							session.messages.push(directiveMsg);
							session.lastModified = Date.now();
							await workspaceClient.setSession(session.id, session);

							if (aiManager.isSessionViewed(session.id)) {
								aiManager.historyManager.render();
							}

							loopCount--; // Don't count this as a real iteration
							continue;
						} else {
							console.error("❌ [Sub-Agent] 3 directive attempts exhausted. Forcing sub_agent_complete.");
							// Force a completion so the parent agent isn't left hanging
							try {
								await this.aiManager.historyManager && true; // no-op to ensure we're still live
								const subSession = await workspaceClient.getSession(session.id);
								if (subSession && !subSession.completedResult) {
									subSession.completedResult = "Sub-agent halted: model repeatedly ended turns without a tool call.";
									subSession.lastModified = Date.now();
									await workspaceClient.setSession(session.id, subSession);
								}
							} catch (e) {
								console.error("[Sub-Agent] Failed to force completion:", e);
							}
							aiManager.setSessionProcessing(session.id, false);
							aiManager._updateTabStatus(session.id, "halted");
							break;
						}
					}

					if (responseContent.replace(regex, "").length > 50) {
						session.lastModified = Date.now();
						await workspaceClient.setSession(session.id, session);
						aiManager._updateTabStatus(session.id, "completed");
						aiManager.setSessionProcessing(session.id, false);
						if (aiManager.isSessionViewed(session.id)) {
							aiManager._dispatchContextUpdate("append_model");
						}
						return;
					}

					// No more tool calls: agent is done or halted!
					// Auto-continue logic
					if (aiManager.autoContinue && this.consecutiveHaltCount < 3) {
							this.consecutiveHaltCount++;
							console.warn(`⚠️ [Agent Loop Halted] Auto-continuing (Attempt ${this.consecutiveHaltCount} of 3)...`);

							// Strip the last model turn
							if (session && session.messages) {
								session.messages = session.messages.filter(m => m.id !== modelMessageId);
								session.lastModified = Date.now();
								await workspaceClient.setSession(session.id, session);
							}
							if (responseBlock && responseBlock.parentNode) {
								responseBlock.remove();
							}

							const autoMsg = document.createElement("div");
							autoMsg.className = "agent-tool-progress";
							autoMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> <span>Auto-continuing (Attempt ${this.consecutiveHaltCount} of 3)...</span>`;

							if (aiManager.isSessionViewed(session.id)) {
								aiManager.conversationArea.append(autoMsg);
								if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
									aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
								}
							}
							await new Promise(r => setTimeout(r, 1200));
							autoMsg.remove();

							loopCount--; // Decrement since we stripped this turn and want to retry
							continue; // Go to next loop iteration
						} else {
							// Manual Continue and Halt Bar logic
							const warnBlock = document.createElement("div");
							warnBlock.className = "response-block warning-block";
							warnBlock.style.border = "1px solid var(--color-warning, #b58900)";
							warnBlock.style.background = "var(--bg-secondary)";
							warnBlock.style.padding = "12px 16px";
							warnBlock.style.borderRadius = "var(--borderRadius)";
							warnBlock.style.margin = "8px 0 16px 0";
							warnBlock.innerHTML = `
								<div style="font-weight: 500; display: flex; align-items: center; gap: 8px;">
									<ui-icon style="color: var(--color-warning, #b58900);">warning</ui-icon>
									<span><b>Agent Loop Halted:</b> The model stopped generating without producing a tool call or completing a task.</span>
								</div>
								<div style="margin-top: 8px; display: flex; gap: 12px; align-items: center; margin-left: 24px;">
									<button class="warn-continue-btn theme-button" style="padding: 4px 10px; font-size: 11px; font-weight: 600; min-width: 80px; cursor: pointer; border-radius: var(--borderRadius); border: none;">Continue</button>
									<label style="font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; color: var(--text-secondary);">
										<input type="checkbox" class="warn-auto-toggle" ${aiManager.autoContinue ? 'checked' : ''} style="cursor: pointer; width: 13px; height: 13px;">
										Auto-Continue
									</label>
								</div>
							`;
							if (aiManager.isSessionViewed(session.id)) {
								aiManager.conversationArea.append(warnBlock);
							}

							// LOG the last request to console.warn() for troubleshooting
							console.warn("⚠️ [Agent Loop Halted] The model stopped generating without producing a tool call or completing a task. Last Request Details:", {
								systemPrompt,
								messages: messagesForAI,
								modelResponse: responseContent
							});

							const shouldScroll = aiManager._shouldAutoScroll();
							if (aiManager.isSessionViewed(session.id)) {
								// Show the persistent bottom halt bar
								aiManager._showHaltBar(modelMessageId, responseBlock, warnBlock);
								if (shouldScroll && aiManager.conversationArea) {
									aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
								}
							}
						}

					aiManager.setSessionProcessing(session.id, false);
					aiManager._updateTabStatus(session.id, "halted");
					if (aiManager.isSessionViewed(session.id)) {
						aiManager._dispatchContextUpdate("append_model");
					}
					break;
				}

				// Reset consecutive halt count since the agent generated valid tool calls
				this.consecutiveHaltCount = 0;
				this.repetitionHaltCount = 0;
				this.protocolFlagRepeatCount = 0;
				delete session.temperatureOverride;

				// Execute all parsed tool calls sequentially
				let accumulatedResponses = [];
				let hasPlan = false;
				let hasDone = false;
				let blockRemainingTools = false;
				let mustWait = false;

				const getActiveSubAgentIds = () => {
					const activeIds = [];
					for (const [id, run] of aiManager.runningSessions) {
						if (run.type === 'agent' && run.instance?.session?.parentId === session.id) {
							if (run.instance?.session?.isWaitingForParent) {
								continue;
							}
							activeIds.push(id);
						}
					}
					return activeIds;
				};

				for (const toolCall of toolCalls) {
					if (blockRemainingTools) {
						accumulatedResponses.push(`[Tool Response: ${toolCall.name}]\n\nError: Tool execution blocked because sub-agents are running.`);
						continue;
					}

					let toolResult = "";
					let approved = true;

					// Validate required arguments before executing or showing approvals
					const validationError = aiManager._validateToolArguments(toolCall, session);
					if (validationError) {
						accumulatedResponses.push(`[Tool Response: ${toolCall.name}]\n\n${validationError}`);
						continue;
					}

					// Identify if tool is destructive
					const isDestructive = ["create_file"].includes(toolCall.name);
					const isForgiveness = (session?.forgivenessMode ?? aiManager.forgivenessMode) === true;
					if (isDestructive && !isForgiveness) {
						approved = await aiManager._showAgentApprovalCard(toolCall);
					}

					if (approved) {
						// Add temporary message block explaining what tool is running
						const progressMsg = document.createElement("div");
						progressMsg.className = "agent-tool-progress";
						progressMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> Running tool: <code>${toolCall.name}</code>...`;
						const shouldScroll = aiManager._shouldAutoScroll();
						if (aiManager.isSessionViewed(session.id)) {
							aiManager.conversationArea.append(progressMsg);
							if (shouldScroll) {
								aiManager.scrollToBottom(true);
							}
						}

						try {
							toolResult = await agentTools.execute(toolCall.name, toolCall.arguments, session.id);
							if (typeof toolResult === 'string' && toolResult.startsWith("__AGENT_HALT_AWAITING_COMMAND_APPROVAL__")) {
								progressMsg.remove();
								// Halt the current agent loop cleanly.
								// When the user clicks Approve or Deny, the approval handler will execute the command and resume the agent.
								aiManager.setSessionProcessing(session.id, false);
								aiManager._updateTabStatus(session.id, "halted");
								return;
							}
							if (toolCall.name === "query") {
								loopCount = 0;
								nextThrottleThreshold = maxIterations > 0 ? maxIterations : Infinity;
								isThrottled = true;
								if (this.throttleBar) {
									this.throttleBar.remove();
									this.throttleBar = null;
								}
								if (this._throttleResolve) {
									this._throttleResolve();
									this._throttleResolve = null;
								}
							}
						} catch (e) {
							toolResult = `Error executing tool: ${e.message}`;
						}

						progressMsg.remove();
					} else {
						toolResult = `Error: User rejected the change to ${toolCall.arguments.path || "file"}.`;
					}

					// Check wait conditions
					if (toolCall.name === "create_sub_agent") {
						const match = toolResult.match(/\[Sub-Agent (ai-session-[a-f0-9-]+) spawned/);
						if (match) {
							const subAgentId = match[1];
							if (!this.subAgentsCreated) {
								this.subAgentsCreated = [];
							}
							if (!this.subAgentsCreated.includes(subAgentId)) {
								this.subAgentsCreated.push(subAgentId);
							}
						}
						
						const createAnother = toolCall.arguments.create_another === true || toolCall.arguments.create_another === "true";
						if (!createAnother) {
							blockRemainingTools = true;
							mustWait = true;
						}
					} else {
						const activeSubAgents = getActiveSubAgentIds();
						if (activeSubAgents.length > 0) {
							blockRemainingTools = true;
							mustWait = true;
						}
					}

					let responseTitle = `[Tool Response: ${toolCall.name}]`;
					if (toolCall.name === "read_file" && toolCall.arguments && toolCall.arguments.path) {
						const path = toolCall.arguments.path;
						const start = parseInt(toolCall.arguments.startLine);
						const count = parseInt(toolCall.arguments.lineCount);
						if (!isNaN(start) && !isNaN(count)) {
							const end = start + count - 1;
							responseTitle = `[Tool Response: read_file ${path} #L${start}-${end}]`;
						} else if (!isNaN(start)) {
							responseTitle = `[Tool Response: read_file ${path} #L${start}]`;
						} else {
							responseTitle = `[Tool Response: read_file ${path}]`;
						}
					} else if (toolCall.name === "web_fetch" && toolCall.arguments && toolCall.arguments.url) {
						const url = toolCall.arguments.url;
						const start = parseInt(toolCall.arguments.start_line ?? toolCall.arguments.startLine);
						const count = parseInt(toolCall.arguments.line_count ?? toolCall.arguments.lineCount);
						const endVal = parseInt(toolCall.arguments.end_line ?? toolCall.arguments.endLine);
						const noSummary = !!(toolCall.arguments.no_summary ?? toolCall.arguments.noSummary);
						const grep = toolCall.arguments.grep ?? toolCall.arguments.search ?? toolCall.arguments.query;
						let suffix = "";
						if (grep && typeof grep === 'string' && grep.trim()) {
							suffix += ` grep:"${grep.trim()}"`;
						} else if (!isNaN(start) && !isNaN(count)) {
							const calculatedEnd = start + count - 1;
							suffix += calculatedEnd > start ? ` #L${start}-${calculatedEnd}` : ` #L${start}`;
						} else if (!isNaN(start) && !isNaN(endVal)) {
							suffix += ` #L${start}-${endVal}`;
						} else if (!isNaN(start)) {
							suffix += ` #L${start}`;
						} else if (!isNaN(count) && count > 0) {
							suffix += ` #L1-${count}`;
						}
						if (noSummary) {
							suffix += ` (raw)`;
						}
						responseTitle = `[Tool Response: web_fetch ${url}${suffix}]`;
					} else if (toolCall.name === "scratchpad_write" && toolCall.arguments) {
						const mode = (toolCall.arguments.mode || "replace").toLowerCase();
						responseTitle = `[Tool Response: scratchpad_write (${mode})]`;
					}
					accumulatedResponses.push(`${responseTitle}\n\n${toolResult}`);

					if (toolCall.name === "create_implementation_plan") {
						hasPlan = true;
					}

					if (toolCall.name === "done") {
						hasDone = true;
					}
				}

				if (mustWait) {
					const waitMsg = document.createElement("div");
					waitMsg.className = "agent-tool-progress";
					waitMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> Waiting for sub-agents to complete...`;
					const shouldScroll = aiManager._shouldAutoScroll();
					if (aiManager.isSessionViewed(session.id)) {
						aiManager.conversationArea.append(waitMsg);
						if (shouldScroll) {
							aiManager.scrollToBottom(true);
						}
					}

					await new Promise(resolve => {
						let resolved = false;
						const checkOrResolve = () => {
							if (resolved) return;
							if (this._abortAgent) {
								resolved = true;
								cleanup();
								resolve();
								return;
							}
							const activeIds = getActiveSubAgentIds();
							if (activeIds.length === 0) {
								resolved = true;
								cleanup();
								resolve();
							}
						};

						const handler = () => checkOrResolve();
						window.addEventListener('subagent-updated', handler);
						const safetyTimer = setInterval(checkOrResolve, 4000);

						const cleanup = () => {
							window.removeEventListener('subagent-updated', handler);
							clearInterval(safetyTimer);
						};

						checkOrResolve();
					});

					waitMsg.remove();

					const compiled = await this.checkAndCompileSubAgentResults(session);
					if (compiled) {
						accumulatedResponses.push(compiled);
					}
				}

				// Append all accumulated tool results as a single user response to feed back into conversation
				if (accumulatedResponses.length > 0) {
					const toolContent = accumulatedResponses.join("\n\n---\n\n");
					const toolResponseMessage = {
						id: crypto.randomUUID(),
						role: "user",
						type: "tool_response",
						content: toolContent,
						timestamp: Date.now(),
						tokenCount: aiManager?.ai?.estimateTokens ? aiManager.ai.estimateTokens(toolContent) : Math.ceil(toolContent.length / 3.2)
					};
					session.messages.push(toolResponseMessage);
					session.lastModified = Date.now();
					await workspaceClient.setSession(session.id, session);

					// Asynchronously tokenize tool results and live-update turn wrapper input tokens
					aiManager.historyManager.tokenizeMessage(toolResponseMessage, session).catch(err => {
						console.warn("[Agent] Async tool_response tokenization error:", err);
					});
				}

				// Commit turn transaction group
				if (session.turnTransactionId) {
					await AgentBackup.commitTransaction(session.turnTransactionId);
					delete session.turnTransactionId;
				}

				if (hasPlan) {
					// Phase 3.4 — The loop BREAKS after a plan-accept turn (no next turn exists), so the
					// turn-start preemption (Phase 3.3) cannot cover this case. Keep the post-turn path,
					// but delegate to the centralized autoCompactAgentCycle so the boundary/span
					// computation, HEAD-anchored insertion, archive, and Phase 2.1 prior-cycle context
					// stay consistent with the auto/manual/background paths. No-op (safe) when there's
					// no unsummarized done boundary (e.g. plan-accept turns that didn't end with done).
					try {
						let summaryProgressMsg = null;
						if (aiManager.isSessionViewed(session.id) && aiManager.conversationArea) {
							summaryProgressMsg = document.createElement("div");
							summaryProgressMsg.className = "agent-tool-progress";
							summaryProgressMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> Generating cycle summary...`;
							aiManager.conversationArea.append(summaryProgressMsg);
							if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}
						await aiManager.historyManager.autoCompactAgentCycle(session, {
							progress: (msg) => { if (summaryProgressMsg) summaryProgressMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> ${msg}`; }
						});
						if (summaryProgressMsg) summaryProgressMsg.remove();
					} catch (e) {
						console.error("Error generating cycle summary:", e);
					}
				}

				if (hasPlan || hasDone) {
					const shouldAutoMilestone = session.autoMilestones ?? (aiManager.config?.defaultAutoMilestones !== false);
					if (shouldAutoMilestone) {
						session.lastMilestoneTimestamp = Date.now();
					}
					delete session.currentCycleStartTimestamp;
					session.lastModified = Date.now();
					await workspaceClient.setSession(session.id, session);
					aiManager.setSessionProcessing(session.id, false);
					if (hasPlan) {
						aiManager._updateTabStatus(session.id, "halted");
					} else {
						aiManager._updateTabStatus(session.id, "completed");
					}
				}

				// Update the model message block in the DOM
				const modelMessage = session.messages.find(m => m.id === modelMessageId);
				if (modelMessage && responseBlock) {
					const contentDiv = responseBlock.querySelector('.model-turn-content');
					const targetContainer = contentDiv || responseBlock;
					targetContainer.innerHTML = aiManager.messageRenderer.renderResponseContent(responseContent, modelMessage, true, null, session);
					aiManager.messageRenderer.addCodeBlockButtons(targetContainer, modelMessage, session);
					const summarySpan = responseBlock.querySelector('.model-turn-summary');
					if (summarySpan) {
						summarySpan.innerHTML = aiManager.messageRenderer.getModelTurnSummary(responseContent, modelMessage, null, session);
					}
					const tokensSpan = responseBlock.querySelector('.turn-tokens-container');
					if (tokensSpan) {
						tokensSpan.innerHTML = aiManager.messageRenderer.getModelTurnTokens(responseContent, modelMessage, session);
					}
				}

				if (hasPlan || hasDone) {
					if (aiManager.isSessionViewed(session.id)) {
						aiManager._dispatchContextUpdate("append_model");
					}
					break;
				}

			} catch (e) {
				console.error("Agent Loop Error:", e);

				const isUnavailable = connection && typeof connection._isTemporaryUnavailableError === 'function' && connection._isTemporaryUnavailableError(e);
				if (isUnavailable) {
					if (aiManager.isSessionViewed(session.id)) {
						aiManager._showTryAgainBanner(e);
					}
					aiManager.setSessionProcessing(session.id, false);
					aiManager._updateTabStatus(session.id, "halted");
					break;
				}

				const errBlock = document.createElement("div");
				errBlock.className = "response-block warning-block";
				errBlock.style.border = "1px solid var(--color-error, #dc3545)";
				errBlock.style.background = "var(--bg-secondary)";
				errBlock.style.padding = "12px 16px";
				errBlock.style.borderRadius = "var(--borderRadius)";
				errBlock.style.margin = "8px 0 16px 0";
				errBlock.innerHTML = `
					<div style="font-weight: 500; display: flex; align-items: center; gap: 8px;">
						<ui-icon style="color: var(--color-error, #dc3545);">error</ui-icon>
						<span><b>Agent Execution Error:</b> ${this.aiManager._escapeHtml(e.message || "An unexpected error occurred during execution.")}</span>
					</div>
					<div style="margin-top: 8px; display: flex; gap: 12px; align-items: center; margin-left: 24px;">
						<button class="theme-button primary resume-agent-btn" style="padding: 4px 10px; font-size: 11px; font-weight: 600; min-width: 80px; cursor: pointer; border-radius: var(--borderRadius); border: none; display: flex; align-items: center; gap: 4px;">
							<ui-icon style="font-size: 13px;">refresh</ui-icon> Resume
						</button>
					</div>
				`;

				const resumeBtn = errBlock.querySelector(".resume-agent-btn");
				resumeBtn.onclick = async () => {
					errBlock.remove();

					// 1. Remove the failed streaming block element if in DOM
					if (responseBlock && typeof responseBlock.remove === "function") {
						responseBlock.remove();
					}

					// 2. Remove incomplete/failed model turn from session history if present
					if (session && session.messages) {
						session.messages = session.messages.filter(m => m.id !== modelMessageId);
						session.lastModified = Date.now();
						await workspaceClient.setSession(session.id, session);
					}

					if (aiManager.isSessionViewed(session.id)) {
						aiManager.historyManager.render();
					}

					// 3. Re-run agent from last completed tool_result or user prompt
					aiManager.setSessionProcessing(session.id, true, 'agent', connection);
					aiManager._updateTabStatus(session.id, "running");
					const agent = new Agent(aiManager, session, connection);
					const runningSession = aiManager.runningSessions.get(session.id);
					if (runningSession) {
						runningSession.instance = agent;
					}
					await agent.run(null, null);
				};

				if (aiManager.isSessionViewed(session.id)) {
					aiManager.conversationArea.append(errBlock);
				}

				aiManager.setSessionProcessing(session.id, false);
				aiManager._updateTabStatus(session.id, "halted");
				break;
			}
		}

		if (this.throttleBar) {
			this.throttleBar.remove();
			this.throttleBar = null;
		}
		if (this._throttleResolve) {
			this._throttleResolve();
			this._throttleResolve = null;
		}
	}

	async checkAndCompileSubAgentResults(session) {
		try {
			const allSessions = await workspaceClient.getSessions();
			const subSessions = allSessions.filter(s => s && s.parentId === session.id);
			if (subSessions.length === 0) return null;

			if (!session.reportedSubAgents) {
				session.reportedSubAgents = [];
			}

			let compiledResults = "\n=== SUB-AGENT RESULTS ===\n";
			let hasNewResults = false;

			for (const subSessionData of subSessions) {
				// Use the in-memory running sub-agent session if it is currently/was recently active
				const running = this.aiManager.runningSessions.get(subSessionData.id);
				const subSession = (running && running.instance?.session) ? running.instance.session : subSessionData;

				const isRunning = this.aiManager.runningSessions.has(subSession.id);
				const isCompleted = !!subSession.completedResult;
				const isWaiting = !!subSession.isWaitingForParent;

				// If subagent is waiting for parent feedback, report the query
				if (isWaiting && subSession.pendingParentQuery && !session.reportedSubAgents.includes(subSession.id + "-waiting-" + subSession.lastModified)) {
					session.reportedSubAgents.push(subSession.id + "-waiting-" + subSession.lastModified);
					hasNewResults = true;
					compiledResults += `\nSub-Agent ID: ${subSession.id}\nObjective: ${subSession.name}\nStatus: Waiting for Parent Feedback\nQuery from Sub-Agent:\n"${subSession.pendingParentQuery}"\n-----------------------\n`;
				} else if (!isRunning && isCompleted && !session.reportedSubAgents.includes(subSession.id)) {
					session.reportedSubAgents.push(subSession.id);
					hasNewResults = true;

					const status = isCompleted ? "Completed" : "Failed/Halted";
					const resultText = subSession.completedResult || "No result reported (crashed or aborted).";
					compiledResults += `\nSub-Agent ID: ${subSession.id}\nObjective: ${subSession.name}\nStatus: ${status}\nResult:\n${resultText}\n-----------------------\n`;
				}
			}

			if (hasNewResults) {
				return compiledResults;
			}
		} catch (e) {
			console.error("[Agent] Error compiling sub-agent results:", e);
		}
		return null;
	}
}
