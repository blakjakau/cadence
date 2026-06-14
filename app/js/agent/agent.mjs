// agent.mjs
import workspaceClient from "../workspace-client.mjs";
import agentTools from "./agent-tools.mjs";

export class Agent {
	constructor(aiManager, session, connection) {
		this.aiManager = aiManager;
		this.session = session;
		this.connection = connection; // Instantiated AI adapter subclass
		this._abortAgent = false;
		this.throttleBar = null;
		this.consecutiveHaltCount = 0;
		this.repetitionHaltCount = 0;
	}

	stop(reason = "User requested stop") {
		this._abortAgent = true;
		if (this.connection) {
			this.connection.stop(reason);
		}
	}

	async run(userMessage, userMessageElement) {
		let loopCount = 0;
		const maxLoops = 15;
		this._abortAgent = false;
		let isThrottled = true;
		this.throttleBar = null;

		const { aiManager, session, connection } = this;

		while (aiManager.runningSessions.has(session.id)) {
			if (this._abortAgent) break;

			loopCount++;

			if (loopCount > maxLoops) {
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
						isThrottled = !isThrottled;
						if (isThrottled) {
							btn.innerText = "Continue >";
							this.throttleBar.classList.remove('unthrottled');
						} else {
							btn.innerText = "Throttle";
							this.throttleBar.classList.add('unthrottled');
						}
					};
					aiManager.chatContainer.append(this.throttleBar);
				}
				this.throttleBar.querySelector('.throttle-text').innerText = `Agent execution throttled due to long running task: ${loopCount} of ${maxLoops} iterations`;

				if (isThrottled) {
					await new Promise(r => setTimeout(r, 7000));
				}
			}

			const modelMessageId = crypto.randomUUID();
			const responseBlock = aiManager.historyManager.createStreamingBlock(modelMessageId, "model", session.id);
			if (aiManager.activeSessionId === session.id) {
				aiManager._startGlow(session.id);
				aiManager.conversationArea.append(responseBlock);
				const shouldScrollAtStart = aiManager._shouldAutoScroll();
				if (shouldScrollAtStart && aiManager.conversationArea) {
					aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
				}
			}

			let currentFullResponse = "";
			let streamForciblyEnded = false;
			let forcedReason = "";

			let messagesForAI = null;
			let systemPrompt = null;

			const runPromise = new Promise((resolve, reject) => {
				const callbacks = {
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
						if (aiManager.activeSessionId === session.id && shouldScroll && aiManager.conversationArea) {
							aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
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
				aiManager.getSystemPrompt().then(sysPrompt => {
					systemPrompt = sysPrompt;
					connection.chat(messagesForAI, callbacks, systemPrompt);
				}).catch(reject);
			});

			try {
				const responseContent = await runPromise;

				if (forcedReason === "repetition_loop") {
					if (this.repetitionHaltCount < 3) {
						this.repetitionHaltCount++;
						console.warn(`⚠️ [Agent Repetition Loop Detected] Trimming and injecting directive (Attempt ${this.repetitionHaltCount} of 3)...`);

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

						// 3. Create and append the system directive message
						const directiveMsg = {
							id: crypto.randomUUID(),
							role: "user",
							type: "system_directive",
							content: "[SYSTEM WARNING: You previously entered a generation loop trying to choose a plan. You must immediately choose ONE action and format your response now. Avoid conversational preamble.]",
							timestamp: Date.now()
						};
						session.messages.push(directiveMsg);
						session.lastModified = Date.now();
						await workspaceClient.setSession(session.id, session);

						// 4. Update DOM if active
						if (aiManager.activeSessionId === session.id) {
							if (responseBlock && typeof responseBlock.updateContent === "function") {
								responseBlock.updateContent(trimmedContent);
							}
							aiManager.historyManager.render();
							if (aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}

						// 5. Briefly pause, then continue the loop
						const autoMsg = document.createElement("div");
						autoMsg.className = "agent-tool-progress";
						autoMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> <span>Recovering from repetition loop (Attempt ${this.repetitionHaltCount} of 3)...</span>`;
						if (aiManager.activeSessionId === session.id) {
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
						// 3 attempts exhausted: close agent loop and notify user
						console.error("❌ [Agent Repetition Loop] 3 recovery attempts exhausted. Exiting loop.");
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
								<span><b>Agent Halted:</b> Repetitive generation loop detected. 3 recovery attempts were exhausted.</span>
							</div>
						`;
						if (aiManager.activeSessionId === session.id) {
							aiManager.conversationArea.append(errorBlock);
							if (aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}
						aiManager.setSessionProcessing(session.id, false);
						aiManager._updateTabStatus(session.id, "halted");
						break;
					}
				}

				// Parse tool calls
				const toolCalls = aiManager._parseAllToolCalls(responseContent);
				const regex = /<[^>]*>/g;
				
				if (toolCalls.length === 0 || !aiManager.agentMode) {
					if (!aiManager.agentMode) {
						aiManager.setSessionProcessing(session.id, false);
						if (aiManager.activeSessionId === session.id) {
							aiManager._dispatchContextUpdate("append_model");
						}
						return;
					}
					if (responseContent.replace(regex, "").length > 50) {
						aiManager.setSessionProcessing(session.id, false);
						return;
					}
					// No more tool calls: agent is done!
					if (!responseContent.includes("<complete_task>")) {
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

							if (aiManager.activeSessionId === session.id) {
								aiManager.conversationArea.append(autoMsg);
								if (aiManager._shouldAutoScroll() && aiManager.conversationArea) {
									aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
								}
							}
							await new Promise(r => setTimeout(r, 1200));
							autoMsg.remove();

							loopCount--; // Decrement since we stripped this turn and want to retry
							continue; // Go to next loop iteration
						}

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
							if (aiManager.activeSessionId === session.id) {
								aiManager.conversationArea.append(warnBlock);
							}

						// LOG the last request to console.warn() for troubleshooting
						console.warn("⚠️ [Agent Loop Halted] The model stopped generating without producing a tool call or completing a task. Last Request Details:", {
							systemPrompt,
							messages: messagesForAI,
							modelResponse: responseContent
						});

						const shouldScroll = aiManager._shouldAutoScroll();
						if (aiManager.activeSessionId === session.id) {
							// Show the persistent bottom halt bar
							aiManager._showHaltBar(modelMessageId, responseBlock, warnBlock);
							if (shouldScroll && aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}
					}

					aiManager.setSessionProcessing(session.id, false);
					aiManager._updateTabStatus(session.id, "halted");
					if (aiManager.activeSessionId === session.id) {
						aiManager._dispatchContextUpdate("append_model");
					}
					break;
				}

				// Reset consecutive halt count since the agent generated valid tool calls
				this.consecutiveHaltCount = 0;
				this.repetitionHaltCount = 0;

				// Execute all parsed tool calls sequentially
				let accumulatedResponses = [];
				let hasPlan = false;
				let hasDone = false;

				for (const toolCall of toolCalls) {
					let toolResult = "";
					let approved = true;

					// Validate required arguments before executing or showing approvals
					const validationError = aiManager._validateToolArguments(toolCall);
					if (validationError) {
						accumulatedResponses.push(`[Tool Response: ${toolCall.name}]\n\n${validationError}`);

						// Render tool finished/failed block in the chat
						const toolConfBlock = document.createElement("div");
						toolConfBlock.className = "agent-tool-finished";
						toolConfBlock.innerHTML = `
							<ui-icon style="color: var(--color-error, #dc3545);">close</ui-icon>
							<span>Tool <code>${toolCall.name}</code> failed validation.</span>
						`;
						const shouldScroll = aiManager._shouldAutoScroll();
						if (aiManager.activeSessionId === session.id) {
							aiManager.conversationArea.append(toolConfBlock);
							if (shouldScroll && aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}
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
						if (aiManager.activeSessionId === session.id) {
							aiManager.conversationArea.append(progressMsg);
							if (shouldScroll && aiManager.conversationArea) {
								aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
							}
						}

						try {
							toolResult = await agentTools.execute(toolCall.name, toolCall.arguments, session.id);
						} catch (e) {
							toolResult = `Error executing tool: ${e.message}`;
						}

						progressMsg.remove();
					} else {
						toolResult = `Error: User rejected the change to ${toolCall.arguments.path || "file"}.`;
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

					// Render simple system or message confirmation of tool run in the chat
					const toolConfBlock = document.createElement("div");
					toolConfBlock.className = "agent-tool-finished";
					toolConfBlock.innerHTML = `
						<ui-icon style="vertical-align: middle;">${approved ? 'done' : 'close'}</ui-icon>
						<span>Tool <code>${toolCall.name}</code> finished.</span>
					`;
					const shouldScroll = aiManager._shouldAutoScroll();
					if (aiManager.activeSessionId === session.id) {
						aiManager.conversationArea.append(toolConfBlock);
						if (shouldScroll && aiManager.conversationArea) {
							aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
						}
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
								if (aiManager.activeSessionId === session.id) {
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
									
									if (aiManager.activeSessionId === session.id) {
										aiManager.historyManager.render();
										if (aiManager.conversationArea) {
											aiManager.conversationArea.scrollTop = aiManager.conversationArea.scrollHeight;
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
				if (modelMessage) {
					responseBlock.innerHTML = aiManager.messageRenderer.renderResponseContent(responseContent, modelMessage, true);
					aiManager.messageRenderer.addCodeBlockButtons(responseBlock, modelMessage);
				}

				if (hasPlan || hasDone) {
					if (aiManager.activeSessionId === session.id) {
						aiManager._dispatchContextUpdate("append_model");
					}
					break;
				}

			} catch (e) {
				console.error("Agent Loop Error:", e);

				const isUnavailable = connection && typeof connection._isTemporaryUnavailableError === 'function' && connection._isTemporaryUnavailableError(e);
				if (isUnavailable) {
					if (aiManager.activeSessionId === session.id) {
						aiManager._showTryAgainBanner(e);
					}
					aiManager.setSessionProcessing(session.id, false);
					aiManager._updateTabStatus(session.id, "halted");
					break;
				}

				const errBlock = document.createElement("div");
				errBlock.className = "response-block error-block";
				errBlock.innerHTML = `Agent Execution Error: ${e.message}`;
				if (aiManager.activeSessionId === session.id) {
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
}
