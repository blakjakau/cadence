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
		this.consecutiveHaltCount = 0;
		this.repetitionHaltCount = 0;
		this.protocolFlagRepeatCount = 0;
		this.subAgentsCreated = [];
		this.reportedSubAgents = new Set();
	}

	stop(reason = "User requested stop") {
		this._abortAgent = true;
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
		const maxLoops = 15;
		this._abortAgent = false;
		let isThrottled = true;
		const { aiManager, session, connection } = this;
		const connConfig = connection?.config || {};
		const hasRateLimits = !!(connConfig.rpmLimit || connConfig.rpdLimit || connConfig.tpmLimit || connConfig.requestsPerMin || connection?.requestsPerMin);
		const maxTurns = connConfig.maxTurns !== undefined ? connConfig.maxTurns : (connection?.config?.maxTurns || 0);

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

			// Apply throttle only if the connection specifies rate limits (RPM, RPD, TPM)
			if (hasRateLimits && loopCount > maxLoops) {
				if (!this.throttleBar) {
					this.throttleBar = document.createElement("div");
					this.throttleBar.className = "agent-throttle-bar";
					this.throttleBar.innerHTML = `
						<ui-icon style="vertical-align: middle; margin-right: 4px; font-size: 16px;">speed</ui-icon>
						<span class="throttle-text"></span>
						<ui-button class="throttle-toggle theme-button" style="padding: 4px 8px; font-size: 11px; margin-left: 12px; min-width: 80px;">Continue &gt;</ui-button>
					`;
					const btn = this.throttleBar.querySelector('.throttle-toggle');
					btn.onclick = () => {
						isThrottled = false;
						if (this.throttleBar) {
							this.throttleBar.remove();
							this.throttleBar = null;
						}
					};
					aiManager.chatContainer.append(this.throttleBar);
				}
				if (this.throttleBar) {
					this.throttleBar.querySelector('.throttle-text').innerText = `Agent execution throttled due to long running task: ${loopCount} of ${maxLoops} iterations`;
				}

				if (isThrottled) {
					await new Promise(r => setTimeout(r, 7000));
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
					role: "system", // Should this be "system" or "tool_response"?
					type: "tool_response",
					content: compiledResults,
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
					onUpdate: (fullResponse) => {
						if (streamForciblyEnded) return;
						currentFullResponse = fullResponse;
						if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
							aiManager._startGlow(session.id);
						} else {
							aiManager._stopGlow(session.id);
						}
						const shouldScroll = aiManager._shouldAutoScroll();
						responseBlock.updateContent(fullResponse);
						if (aiManager.isSessionViewed(session.id) && shouldScroll && aiManager.conversationArea) {
							aiManager.scrollToBottom(true);
						}

						// Scan streaming tokens for early truncation
						const check = aiManager._checkStreamingResponse(fullResponse);
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
				const responseContent = await runPromise;

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

				if (sourceToolCalls && sourceToolCalls.length > 0) {
					toolCalls = sourceToolCalls.map(tc => {
						const callObj = tc.functionCall || tc;
						return {
							id: tc.id || `call_${crypto.randomUUID()}`,
							name: callObj.name || tc.name,
							arguments: callObj.args || callObj.arguments || {}
						};
					});
				} else {
					toolCalls = aiManager._parseAllToolCalls(responseContent);
				}

				const regex = /<[^>]*>/g;
				
				if (toolCalls.length === 0 || !aiManager.agentMode) {
					if (!aiManager.agentMode) {
						aiManager.setSessionProcessing(session.id, false);
						if (aiManager.isSessionViewed(session.id)) {
							aiManager._dispatchContextUpdate("append_model");
						}
						return;
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
						aiManager.setSessionProcessing(session.id, false);
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
					const validationError = aiManager._validateToolArguments(toolCall);
					if (validationError) {
						accumulatedResponses.push(`[Tool Response: ${toolCall.name}]\n\n${validationError}`);
						continue;
					}

					// Identify if tool is destructive
					const isDestructive = ["create_file"].includes(toolCall.name);
					if (isDestructive && !aiManager.forgivenessMode) {
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
								if (this.throttleBar) {
									this.throttleBar.remove();
									this.throttleBar = null;
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
					const toolResponseMessage = {
						id: crypto.randomUUID(),
						role: "user",
						type: "tool_response",
						content: accumulatedResponses.join("\n\n---\n\n"),
						timestamp: Date.now()
					};
					session.messages.push(toolResponseMessage);
					session.lastModified = Date.now();
					await workspaceClient.setSession(session.id, session);
				}

				// Commit turn transaction group
				if (session.turnTransactionId) {
					await AgentBackup.commitTransaction(session.turnTransactionId);
					delete session.turnTransactionId;
				}

				if (hasPlan) {
					try {
						const messages = session.messages;
						let lastDoneMsgIdx = -1;
						for (let i = messages.length - 1; i >= 0; i--) {
							const msg = messages[i];
							if ((msg.type === "tool_response" && msg.content && msg.content.includes("[Tool Response: done]")) ||
								(msg.role === "model" && msg.toolCalls && msg.toolCalls.some(tc => (tc.functionCall?.name || tc.name) === "done"))) {
								const hasSummary = messages.some(m => m.type === "cycle_summary" && (m.cycleEndMsgId === msg.id || m.cycleEndMsgId === messages[i+1]?.id));
								if (!hasSummary) {
									lastDoneMsgIdx = i;
									break;
								}
							}
						}

						if (lastDoneMsgIdx !== -1) {
							let endIdx = lastDoneMsgIdx;
							if (messages[lastDoneMsgIdx].role === "model" && 
								messages[lastDoneMsgIdx + 1] && 
								messages[lastDoneMsgIdx + 1].type === "tool_response") {
								endIdx = lastDoneMsgIdx + 1;
							}
							
							let cycleStartIdx = -1;
							for (let i = endIdx - 2; i >= 0; i--) {
								const msg = messages[i];
								if (msg.type === "cycle_summary" || 
									(msg.type === "tool_response" && msg.content && msg.content.includes("[Tool Response: done]")) ||
									(msg.role === "model" && msg.toolCalls && msg.toolCalls.some(tc => (tc.functionCall?.name || tc.name) === "done"))) {
									cycleStartIdx = i + 1;
									break;
								}
							}
							if (cycleStartIdx === -1) {
								cycleStartIdx = messages.findIndex(msg => msg.type === "user" || msg.type === "model");
							}

							if (cycleStartIdx !== -1 && cycleStartIdx <= endIdx) {
								const cycleMessages = messages.slice(cycleStartIdx, endIdx + 1);
								
								const summaryProgressMsg = document.createElement("div");
								summaryProgressMsg.className = "agent-tool-progress";
								summaryProgressMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> Generating cycle summary...`;
								if (aiManager.isSessionViewed(session.id)) {
									aiManager.conversationArea.append(summaryProgressMsg);
									if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
										aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
									}
								}

								const result = await aiManager.generateCycleSummary(cycleMessages);
								
								summaryProgressMsg.remove();

								if (result && result.summary) {
									const summaryMessage = {
										id: crypto.randomUUID(),
										role: "system",
										type: "cycle_summary",
										title: result.title,
										content: result.summary,
										timestamp: Date.now(),
										cycleStartMsgId: messages[cycleStartIdx].id,
										cycleEndMsgId: messages[endIdx].id
									};
									session.messages.splice(endIdx + 1, 0, summaryMessage);
									session.lastModified = Date.now();
									await workspaceClient.setSession(session.id, session);
									
									if (aiManager.isSessionViewed(session.id)) {
										aiManager.historyManager.render();
										if (aiManager.conversationArea) {
											aiManager.scrollToBottom(true);
										}
									}
								}
							}
						}
					} catch (e) {
						console.error("Error generating cycle summary:", e);
					}
				}

				if (hasPlan || hasDone) {
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
					targetContainer.innerHTML = aiManager.messageRenderer.renderResponseContent(responseContent, modelMessage, true);
					aiManager.messageRenderer.addCodeBlockButtons(targetContainer, modelMessage);
					const summarySpan = responseBlock.querySelector('.model-turn-summary');
					if (summarySpan) {
						summarySpan.innerHTML = aiManager.messageRenderer.getModelTurnSummary(responseContent, modelMessage);
					}
					const tokensSpan = responseBlock.querySelector('.turn-tokens-container');
					if (tokensSpan) {
						tokensSpan.innerHTML = aiManager.messageRenderer.getModelTurnTokens(responseContent, modelMessage);
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
				errBlock.className = "response-block error-block";
				errBlock.innerHTML = `Agent Execution Error: ${e.message}`;
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
