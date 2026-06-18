// ai-manager-history.mjs

import { Block, Button, Inline, Icon } from "./elements.mjs"
import DEFAULT_WELCOME_MESSAGE_MARKDOWN from "./ai-manager-setup-guide.mjs"
import workspaceClient from "./workspace-client.mjs"
import { getAgentDirectives } from "./ai-manager-agent-prompt.mjs"
export const MAX_RECENT_MESSAGES_TO_PRESERVE = 5

class AIManagerHistory {
	constructor(aiManager) {
		this.manager = aiManager // Reference to the main AIManager
		// REMOVED: this.chatHistory = [] // History is now owned by AIManager's activeSession
		
		if(window.markdownit) {
			this.md = aiManager.md
	        // Pre-render the welcome message HTML
	        this._defaultWelcomeMessageHtml = this.md.render(DEFAULT_WELCOME_MESSAGE_MARKDOWN);
		}
	}

	get ai() {
		return this.manager.ai
	}

	get conversationArea() {
		return this.manager.conversationArea
	}

	// NEW: Getter to always return the messages of the currently active session
	get chatHistory() {
		return this.manager.activeSession?.messages || [];
	}

	get activeStreamingBlock() {
		const runningSession = this.manager.runningSessions.get(this.manager.activeSessionId);
		if (runningSession) return runningSession.responseBlock;
		return this._localActiveStreamingBlock;
	}

	set activeStreamingBlock(val) {
		const targetSessionId = val?.sessionId || this.manager.activeSessionId;
		const runningSession = this.manager.runningSessions.get(targetSessionId);
		if (runningSession) {
			runningSession.responseBlock = val;
		}
		this._localActiveStreamingBlock = val;
	}

	clear() {
		if (this.manager.activeSession) {
			this.manager.deleteSubAgentsInMessages(this.manager.activeSession.messages);
			this.manager.activeSession.messages = []; // Clear the active session's messages
			this.manager.activeSession.promptInput = ""; // Clear its current prompt input
			this.manager.activeSession.promptHistory = []; // Clear its command history
			this.manager.promptEditor.setValue(""); // Clear the UI prompt area via ACE API
			this.manager.promptIndex = 0; // Reset prompt history index to the "new prompt" line
			this.manager._unsentPromptBuffer = null; // Also clear the unsent prompt buffer
			this.manager._resizePromptArea(); // Resize prompt area after clearing
		}
		this.manager.fileBar.clear(); // Clear the file context bar
		this.render(); // Re-render to show empty state/welcome message
		this.manager._dispatchContextUpdate("clear_active_session"); // Dispatch update to save changes
	}

	// REWRITTEN addMessage() to dynamically append new system messages.
	loadSessionMessages(messagesArray, autoScroll=false) {
		// This method is now solely responsible for telling the UI to render
		// the messages of the *newly active* session. `this.chatHistory` getter
		// already points to the correct place.
		this.render();
		// Dispatch an update to ensure the UI (progress bar, etc.) reflects the loaded state.
		this.manager._dispatchContextUpdate("session_messages_loaded");
		
		// if(autoScroll) {
		// 	setTimeout(()=>{
		// 		this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
		// 	}, 50)
		// }
	}

	/**
	 * Adds a message object to the active session's history and re-renders the UI.
	 * @param {Object} messageObject - The message to add (e.g., {type: "system_message", content: "..."}).
	 * @param {boolean} [autoScroll=true] - Whether to automatically scroll to the bottom.
	 */
	addMessage(messageObject, autoScroll = true) { // Default remains true for other message types
		if (this.manager.activeSession) {
			// New logic: System messages should never cause an auto-scroll.
			if (messageObject.type === 'system_message') {
				autoScroll = false;
			}

			this.manager.activeSession.messages.push(messageObject);
			this.manager.activeSession.lastModified = Date.now(); // Update last modified timestamp
			this.appendMessageElement(messageObject); // Append the new message directly
			if (this.conversationArea && autoScroll) { // Scroll only if requested and not a system message
				this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
			}
			this.manager._dispatchContextUpdate("add_message", { messageType: messageObject.type });
		}
	}

    // Method to display the default welcome message
    _showDefaultWelcomeMessage() {
        if (this.conversationArea) {
            this.conversationArea.innerHTML = this._defaultWelcomeMessageHtml;
        }
    }

	/**
	 * Populates the FileBar with chips representing file_context messages.
	 */
	populateFileBar() {
		if (!this.manager.fileBar) return;
		this.manager.fileBar.clear();
		for (const message of this.chatHistory) {
			if (message.type === 'file_context') {
				this.manager.fileBar.add(message);
			}
		}
	}

	/**
	 * The main render method, used when loading a full session history.
	 * Clears the existing UI and rebuilds it from the current chatHistory.
	 */
	async render({ isNewMessage = false } = {}) {
		if (!this.conversationArea) return;

		const shouldScroll = this.manager._shouldAutoScroll();
		const viewedSessionId = this.manager.activeSession?.activeSubAgentSessionId || this.manager.activeSessionId;
		const isSwitchingSession = this._lastViewedSessionId !== viewedSessionId;
		console.debug("[Scroll Debug] render() called. viewedSessionId:", viewedSessionId, "previous:", this._lastViewedSessionId, "isSwitchingSession:", isSwitchingSession);
		this._lastViewedSessionId = viewedSessionId;

		const activeSubAgentSessionId = this.manager.activeSession?.activeSubAgentSessionId;

		if (isSwitchingSession) {
			this.conversationArea.style.scrollBehavior = 'auto'; // Make scroll instant
			this.conversationArea.style.transition = "opacity 100ms linear"
			this.conversationArea.style.opacity = 0

			setTimeout(async () => {
				await this._actualRender({ shouldScroll, isSwitchingSession });

				// Restore the scroll position instantly while scrollBehavior is 'auto'
				void this.conversationArea.scrollTop;
				const pendingQueryCard = this.conversationArea.querySelector(".agent-query-block:not(.answered)");
				if (activeSubAgentSessionId) {
					const runningSubAgent = this.manager.runningSessions.get(activeSubAgentSessionId);
					const subSession = (runningSubAgent && runningSubAgent.instance?.session)
						? runningSubAgent.instance.session
						: await workspaceClient.getSession(activeSubAgentSessionId);
					
					console.debug("[Scroll Debug] Switching to Sub-Agent. savedScrollTop:", subSession?.scrollTop, "pendingQueryCard:", !!pendingQueryCard);
					if (pendingQueryCard && !subSession?.scrollTop) {
						console.debug("[Scroll Debug] Scrolling sub-agent query card into view.");
						pendingQueryCard.scrollIntoView({ behavior: "auto", block: "nearest" });
					} else if (subSession) {
						this.conversationArea.scrollTop = subSession.scrollTop || 0;
					}
				} else {
					console.debug("[Scroll Debug] Switching to Parent. savedScrollTop:", this.manager.activeSession?.scrollTop, "pendingQueryCard:", !!pendingQueryCard);
					if (pendingQueryCard && !this.manager.activeSession?.scrollTop) {
						console.debug("[Scroll Debug] Scrolling parent query card into view.");
						pendingQueryCard.scrollIntoView({ behavior: "auto", block: "nearest" });
					} else if (this.manager.activeSession) {
						this.conversationArea.scrollTop = this.manager.activeSession.scrollTop || 0;
					}
				}

				setTimeout(() => {
					this.conversationArea.style.scrollBehavior = ''; // Restore smooth scrolling
					this.conversationArea.style.opacity = 1
				}, 50);
			}, 100);
		} else {
			await this._actualRender({ shouldScroll, isSwitchingSession });
		}
	}

	async _actualRender({ shouldScroll, isSwitchingSession }) {
		this.manager._updateGlowForViewedSession();

		const activeSubAgentSessionId = this.manager.activeSession?.activeSubAgentSessionId;
		if (activeSubAgentSessionId) {
			this.conversationArea.innerHTML = ""; // Clear existing messages
			this.populateFileBar(); // Always populate file bar

			// Sticky back button
			const header = new Block();
			header.className = "sub-agent-back-header";
			header.innerHTML = `<ui-icon>arrow_back</ui-icon> <span>Back to parent thread</span>`;
			header.onclick = () => {
				if (this.manager.activeSession) {
					console.debug("[Scroll Debug] Exiting sub-agent. Saving sub-agent scroll position:", this.conversationArea.scrollTop);
					const subSession = this.manager.activeSubAgentSession;
					if (subSession) {
						subSession.scrollTop = this.conversationArea.scrollTop;
						workspaceClient.setSession(activeSubAgentSessionId, subSession);
					} else {
						workspaceClient.getSession(activeSubAgentSessionId).then(s => {
							if (s) {
								s.scrollTop = this.conversationArea.scrollTop;
								workspaceClient.setSession(activeSubAgentSessionId, s);
							}
						});
					}

					delete this.manager.activeSession.activeSubAgentSessionId;
					this.render();
				}
			};
			this.conversationArea.appendChild(header);

			// Load sub-agent session data: reuse running sub-agent session if active
			const runningSubAgent = this.manager.runningSessions.get(activeSubAgentSessionId);
			const subSession = (runningSubAgent && runningSubAgent.instance?.session)
				? runningSubAgent.instance.session
				: await workspaceClient.getSession(activeSubAgentSessionId);
			if (!subSession) {
				const errorMsg = new Block();
				errorMsg.className = "sub-agent-error-msg";
				errorMsg.textContent = "Error: Sub-agent session not found or deleted.";
				this.conversationArea.appendChild(errorMsg);
				return;
			}

			this.manager.activeSubAgentSession = subSession;

			// Render messages
			const subMessages = subSession.messages || [];
			const summarizedIds = new Set();
			const summaries = subMessages.filter(msg => msg.type === "cycle_summary");
			for (const summary of summaries) {
				const startId = summary.cycleStartMsgId;
				const endId = summary.cycleEndMsgId;
				if (startId && endId) {
					const startIdx = subMessages.findIndex(m => m.id === startId);
					const endIdx = subMessages.findIndex(m => m.id === endId);
					if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
						for (let j = startIdx; j <= endIdx; j++) {
							summarizedIds.add(subMessages[j].id);
						}
					}
				}
			}

			for (let i = 0; i < subMessages.length; i++) {
				const message = subMessages[i];
				if (message.type === 'file_context') continue;
				if (summarizedIds.has(message.id)) continue;
				
				const element = this._createMessageElement(message, i);
				if (element) this.conversationArea.append(element);
			}

			if (runningSubAgent && runningSubAgent.responseBlock) {
				this.conversationArea.append(runningSubAgent.responseBlock);
			}

			if (!isSwitchingSession) {
				setTimeout(() => {
					const pendingQueryCard = this.conversationArea.querySelector(".agent-query-block:not(.answered)");
					console.debug("[Scroll Debug] Sub-Agent Update. shouldScroll:", shouldScroll, "pendingQueryCard:", !!pendingQueryCard);
					if (pendingQueryCard && shouldScroll) {
						console.debug("[Scroll Debug] Scrolling sub-agent query card into view (update).");
						pendingQueryCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
					} else if (shouldScroll) {
						this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
					}
				}, 100);
			}

			return;
		}

		this.manager.activeSubAgentSession = null;
		this.conversationArea.innerHTML = ""; // Clear existing messages
		this.populateFileBar(); // Always populate file bar

		// If AI is not configured, show the setup guide and hide empty state.
		if (!this.manager.ai || !this.manager.ai.isConfigured()) {
			this._showDefaultWelcomeMessage();
			this.manager._emptyStateElement.style.display = 'none';
			return;
		}

		// If history is empty, show the empty state background.
		if (this.chatHistory.length === 0) {
			this.manager._emptyStateElement.style.display = 'flex';
			return; // Nothing else to render
		}

		// If we have history, hide empty state and render messages.
		this.manager._emptyStateElement.style.display = 'none';

		// In raw history view, prepend the active system prompt
		if (this.manager.rawViewMode) {
			try {
				const systemPromptContent = await this.manager.getSystemPrompt();
				if (systemPromptContent) {
					const sysMessage = {
						id: "system-prompt-raw-expander",
						type: "system_prompt_raw",
						content: systemPromptContent
					};
					const element = this._createExpanderMessageElement(sysMessage, -1);
					if (element) {
						element.style.border = "1px dashed var(--theme)";
						this.conversationArea.append(element);
					}
				}
			} catch (e) {
				console.warn("Failed to get system prompt for raw view:", e);
			}
		}

		// Collect IDs of messages that have been summarized to skip rendering them directly in the chat history
		const summarizedIds = new Set();
		const summaries = this.chatHistory.filter(msg => msg.type === "cycle_summary");
		for (const summary of summaries) {
			const startId = summary.cycleStartMsgId;
			const endId = summary.cycleEndMsgId;
			if (startId && endId) {
				const startIdx = this.chatHistory.findIndex(m => m.id === startId);
				const endIdx = this.chatHistory.findIndex(m => m.id === endId);
				if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
					for (let j = startIdx; j <= endIdx; j++) {
						summarizedIds.add(this.chatHistory[j].id);
					}
				}
			}
		}

		// Use the new element factory for each message in the history
		for (let i = 0; i < this.chatHistory.length; i++) {
			const message = this.chatHistory[i];
			if (message.type === 'file_context') continue;
			if (summarizedIds.has(message.id)) continue;
			
			const element = this.manager.rawViewMode
				? this._createExpanderMessageElement(message, i)
				: this._createMessageElement(message, i); // No isNewMessage for full render

			if (element) this.conversationArea.append(element);
		}

		// Re-append the active streaming block if we are currently processing/generating
		const runningSession = this.manager.runningSessions.get(this.manager.activeSessionId);
		if (runningSession && runningSession.responseBlock) {
			this.conversationArea.append(runningSession.responseBlock);
		}

		// Render pending queued prompts
		if (this.manager.activeSession && this.manager.activeSession.promptQueue) {
			for (const pendingMsg of this.manager.activeSession.promptQueue) {
				const pendingElement = this._createMessageElement({
					id: pendingMsg.id,
					type: "pending",
					content: pendingMsg.content
				});
				if (pendingElement) {
					this.conversationArea.append(pendingElement);
				}
			}
		}

		// Scroll active unanswered query card into view if auto-scroll is allowed, or restore parent session scroll position
		if (!isSwitchingSession) {
			setTimeout(() => {
				const pendingQueryCard = this.conversationArea.querySelector(".agent-query-block:not(.answered)");
				console.debug("[Scroll Debug] Parent Update. shouldScroll:", shouldScroll, "pendingQueryCard:", !!pendingQueryCard);
				if (pendingQueryCard && shouldScroll) {
					console.debug("[Scroll Debug] Scrolling parent query card into view (update).");
					pendingQueryCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
				} else if (shouldScroll) {
					this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
				}
			}, 100);
		}
	}


	/**
	 * NEW: Dynamically creates and appends a single message element to the DOM.
	 * This is used for new incoming messages (user prompts, model responses, system messages, file contexts).
	 * @param {Object} message - The message object to append.
	 */
	appendMessageElement(message) {
		if (!this.conversationArea) return;

		// If viewing a sub-agent session, do not append parent messages to DOM
		if (this.manager.activeSession?.activeSubAgentSessionId) {
			return;
		}
		
		// Hide empty state background if it's visible
		this.manager._emptyStateElement.style.display = 'none';

		// If this is the first message being added to an empty history,
		// ensure the conversation area is clear of any welcome/setup text.
		if (this.chatHistory.length === 1) {
			this.conversationArea.innerHTML = '';
		}
		
		// Find the index of the message within the chatHistory array.
		// This is important for _createMessageElement to determine if a delete button should be added.
		const index = this.chatHistory.findIndex(m => m.id === message.id);

		const element = this.manager.rawViewMode
			? this._createExpanderMessageElement(message, index)
			: this._createMessageElement(message, index, true); // Always new when appended

		if (element) {
			this.conversationArea.append(element);
		}
		return element;
	}

	createStreamingBlock(messageId, type = "model", sessionId = null) {
		const targetSessionId = sessionId || this.manager.activeSessionId;
		if (this.manager.rawViewMode) {
			const message = { id: messageId, type, content: "" };
			const element = this._createExpanderMessageElement(message, this.chatHistory.length);
			element.sessionId = targetSessionId;
			// Open the expander by default for active streaming
			const contentDiv = element.querySelector(".expander-content");
			if (contentDiv) contentDiv.style.display = "block";
			const expandArrow = element.querySelector(".expand-arrow");
			if (expandArrow) expandArrow.textContent = "expand_less";
			element.classList.add("expanded");
			
			// Attach dynamic content updater
			element.updateContent = (fullResponse) => {
				const pre = element.querySelector(".raw-content-block");
				if (pre) pre.textContent = fullResponse;
				
				const previewText = fullResponse ? fullResponse.substring(0, 40).replace(/\n/g, " ") : "";
				const previewSuffix = (fullResponse && fullResponse.length > 40) ? "..." : "";
				const previewSpan = element.querySelector(".content-preview");
				if (previewSpan) previewSpan.textContent = this._escapeHtml(previewText) + previewSuffix;

				const sizeSpan = element.querySelector(".item-size-badge");
				if (sizeSpan) {
					const sizeInBytes = fullResponse ? new TextEncoder().encode(fullResponse).length : 0;
					const sizeInKB = (sizeInBytes / 1024).toFixed(2);
					const estTokens = this.ai.estimateTokens(fullResponse);
					sizeSpan.textContent = `(${sizeInKB} KB | ${estTokens} tokens)`;
				}
			};
			
			element.finalize = (fullResponse, finalizedMessage) => {
				const running = this.manager.runningSessions.get(targetSessionId);
				if (running) running.responseBlock = null;
				this._localActiveStreamingBlock = null;
				element.updateContent(fullResponse);
				const deleteIcon = element.querySelector(".delete-raw-item");
				if (deleteIcon) {
					deleteIcon.onclick = (e) => {
						e.stopPropagation();
						this._handleDeleteSingleMessage(messageId);
					};
				}
			};
			const running = this.manager.runningSessions.get(targetSessionId);
			if (running) running.responseBlock = element;
			this._localActiveStreamingBlock = element;
			return element;
		} else {
			const responseBlock = new Block();
			responseBlock.sessionId = targetSessionId;
			responseBlock.classList.add("response-block");
			if (type === "error") responseBlock.classList.add("error-block");
			responseBlock.dataset.messageId = messageId;
			responseBlock.finalizedSegmentDivs = [];
			responseBlock.activeSegmentDiv = null;
			
			responseBlock.updateContent = (fullResponse) => {
				if (fullResponse) {
					const prefillContainer = responseBlock.querySelector('.prefill-progress-container');
					if (prefillContainer) {
						prefillContainer.remove();
					}
				}
				const segments = this.manager.messageRenderer.segmentContent(fullResponse);
				
				if (!responseBlock.activeSegmentDiv) {
					responseBlock.activeSegmentDiv = document.createElement("div");
					responseBlock.append(responseBlock.activeSegmentDiv);
				}

				while (segments.length > responseBlock.finalizedSegmentDivs.length + 1) {
					const segmentIndex = responseBlock.finalizedSegmentDivs.length;
					const finalizedText = segments[segmentIndex];
					
					responseBlock.activeSegmentDiv.innerHTML = this.manager.messageRenderer.renderResponseContent(finalizedText, null, true);
					this.manager.messageRenderer.addCodeBlockButtons(responseBlock.activeSegmentDiv);
					
					responseBlock.finalizedSegmentDivs.push(responseBlock.activeSegmentDiv);
					
					responseBlock.activeSegmentDiv = document.createElement("div");
					responseBlock.append(responseBlock.activeSegmentDiv);
				}
				
				const activeText = segments[segments.length - 1];
				responseBlock.activeSegmentDiv.innerHTML = this.manager.messageRenderer.renderResponseContent(activeText, null, true);
				this.manager.messageRenderer.addCodeBlockButtons(responseBlock.activeSegmentDiv);
			};
			
			responseBlock.finalize = (fullResponse, finalizedMessage) => {
				const running = this.manager.runningSessions.get(targetSessionId);
				if (running) running.responseBlock = null;
				this._localActiveStreamingBlock = null;
				responseBlock.innerHTML = this.manager.messageRenderer.renderResponseContent(fullResponse, finalizedMessage, true);
				this.manager.messageRenderer.addCodeBlockButtons(responseBlock, finalizedMessage);
				const deleteButton = this._createSingleDeleteButton(messageId);
				responseBlock.append(deleteButton);
				
				const tokenCount = typeof finalizedMessage.tokenCount === 'number' ? finalizedMessage.tokenCount : this.ai.estimateTokens([finalizedMessage]);
				responseBlock.setAttribute("title", `Tokens: ${tokenCount}`);
			};
			const running = this.manager.runningSessions.get(targetSessionId);
			if (running) running.responseBlock = responseBlock;
			this._localActiveStreamingBlock = responseBlock;
			return responseBlock;
		}
	}

	/**
	 * NEW: Factory method to create a DOM element for any given message object.
	 * This centralizes UI creation logic for individual messages.
	 * @param {Object} message The message object from the chat history.
	 * @param {number} index The message's index in the chat history array (needed for delete button logic).
	 * @returns {HTMLElement|null} The generated DOM element or null if message is invalid.
	 */
	_createMessageElement(message, index, isNew = false) {
		if (!message.id) {
			message.id = crypto.randomUUID();
		}

		let element;
		const tokenCount = typeof message.tokenCount === 'number' ? message.tokenCount : this.ai.estimateTokens([message]);

		if (message.type === "pending") {
			const wrapper = new Block();
			wrapper.classList.add("pending-prompt-pill-wrapper");

			const messageBlock = new Block();
			messageBlock.classList.add("prompt-pill", "pending-prompt-pill");
			messageBlock.innerHTML = this.md.render(message.content);
			wrapper.append(messageBlock);

			const controlsDiv = new Block();
			controlsDiv.className = "prompt-controls";

			const editLink = new Inline();
			editLink.className = "prompt-controls-link";
			editLink.textContent = "Edit";
			editLink.onclick = (e) => {
				e.preventDefault();
				this.manager.editQueuedPrompt(this.manager.activeSessionId, message.id);
			};

			const divider = new Inline();
			divider.className = "prompt-controls-divider";
			divider.textContent = "|";

			const deleteLink = new Inline();
			deleteLink.className = "prompt-controls-link delete";
			deleteLink.textContent = "Delete";
			deleteLink.onclick = (e) => {
				e.preventDefault();
				this.manager.deleteQueuedPrompt(this.manager.activeSessionId, message.id);
			};

			controlsDiv.append(editLink, divider, deleteLink);
			wrapper.appendChild(controlsDiv);

			element = wrapper;

		} else if (message.type === "user" && message.content && message.content.startsWith("[sub-agent:")) {
			// Extract sub-agent ID
			const subAgentId = message.content.substring(11, message.content.length - 1);
			
			const wrapper = new Block();
			wrapper.className = "prompt-pill-wrapper sub-agent-pill-wrapper";
			wrapper.dataset.messageId = message.id;

			const card = new Block();
			card.className = "sub-agent-trigger-card";

			const header = new Block();
			header.className = "sub-agent-card-header";

			const title = new Block();
			title.className = "sub-agent-card-title";
			title.innerHTML = `<ui-icon>developer_board</ui-icon> <span>Loading Sub-Agent...</span>`;

			const badge = new Inline();
			badge.className = "sub-agent-card-badge";
			badge.textContent = "Checking";

			header.appendChild(title);
			header.appendChild(badge);
			card.appendChild(header);

			const desc = new Block();
			desc.className = "sub-agent-card-desc";
			desc.textContent = "Fetching sub-agent details...";
			card.appendChild(desc);

			wrapper.appendChild(card);
			element = wrapper;

			// Fetch details asynchronously: reuse running sub-agent session if active
			const runningSub = window.ui?.aiManager?.runningSessions.get(subAgentId);
			const getSubSessionPromise = (runningSub && runningSub.instance?.session)
				? Promise.resolve(runningSub.instance.session)
				: workspaceClient.getSession(subAgentId);

			getSubSessionPromise.then(subSession => {
				if (subSession) {
					title.querySelector("span").textContent = subSession.name;
					desc.textContent = subSession.systemPromptOverride ? 
						(subSession.systemPromptOverride.match(/"([^"]+)"/)?.[1] || "Sub-agent task") : 
						"Sub-agent task";

					// Check running status in pool
					const running = window.ui?.aiManager?.runningSessions.get(subAgentId);
					if (running && subSession.pendingQueryId) {
						badge.textContent = "Needs Input";
						badge.className = "sub-agent-card-badge pending-query";
						card.classList.add("has-pending-query");
					} else if (running) {
						badge.textContent = "Running";
						badge.className = "sub-agent-card-badge running";
					} else if (subSession.completedResult) {
						badge.textContent = "Completed";
						badge.className = "sub-agent-card-badge completed";
					} else {
						badge.textContent = "Halted";
						badge.className = "sub-agent-card-badge halted";
					}
				} else {
					title.querySelector("span").textContent = "Deleted Sub-Agent";
					desc.textContent = "This sub-agent session was deleted.";
					badge.textContent = "N/A";
					badge.className = "sub-agent-card-badge halted";
				}
			}).catch(err => {
				console.error("Error loading sub-agent details:", err);
			});

			card.onclick = () => {
				if (this.manager.activeSession) {
					console.debug("[Scroll Debug] Saving parent session scroll position:", this.conversationArea.scrollTop);
					this.manager.activeSession.scrollTop = this.conversationArea.scrollTop;
					this.manager.activeSession.activeSubAgentSessionId = subAgentId;
					this.render();
				}
			};
		} else if (message.type === "user") {
			const wrapper = new Block();
			wrapper.classList.add("prompt-pill-wrapper");
			wrapper.dataset.messageId = message.id;
			wrapper.setAttribute("title", `Tokens: ${tokenCount}`);

			const messageBlock = new Block();
			messageBlock.classList.add("prompt-pill");
			messageBlock.innerHTML = this.md.render(message.content);
			wrapper.append(messageBlock);

			const replayButton = this._createSingleReplayButton(message.id);
			wrapper.append(replayButton);

			const deleteButton = this._createSingleDeleteButton(message.id);
			wrapper.append(deleteButton);
			element = wrapper;

		} else if (message.type === "model" || message.type === "error") {
			element = new Block();
			element.classList.add("response-block");
			if (message.type === "error") element.classList.add("error-block");
			element.dataset.messageId = message.id;
			element.setAttribute("title", `Tokens: ${tokenCount}`);
			element.innerHTML = this.manager.messageRenderer.renderResponseContent(message.content, message, isNew);
			
			const deleteButton = this._createSingleDeleteButton(message.id);
			element.append(deleteButton);
			
			if (message.type === "model") {
				this.manager.messageRenderer.addCodeBlockButtons(element, message);

				// Add manual cycle summarization trigger button if this model message called "done" and isn't summarized yet
				if (message.toolCalls?.some(tc => (tc.functionCall?.name || tc.name) === "done")) {
					const allMsgs = this.chatHistory;
					const msgIdx = allMsgs.findIndex(m => m.id === message.id);
					if (msgIdx !== -1) {
						const nextMsg = allMsgs[msgIdx + 1];
						const isDoneResponse = nextMsg && nextMsg.type === "tool_response" && nextMsg.content && nextMsg.content.includes("[Tool Response: done]");
						if (isDoneResponse) {
							const hasSummary = allMsgs.some(m => m.type === "cycle_summary" && m.cycleEndMsgId === nextMsg.id);
							if (!hasSummary) {
								const summarizeBtn = new Button("Summarize Cycle");
								summarizeBtn.className = "summarize-cycle-trigger-btn theme-button primary";
								summarizeBtn.icon = "summarize";
								
								summarizeBtn.onclick = async (e) => {
									e.stopPropagation();
									summarizeBtn.disabled = true;
									summarizeBtn.text = "Summarizing...";
									
									try {
										let cycleStartIdx = -1;
										for (let i = msgIdx - 1; i >= 0; i--) {
											const prevMsg = allMsgs[i];
											if (prevMsg.type === "cycle_summary" || 
												(prevMsg.type === "tool_response" && prevMsg.content && prevMsg.content.includes("[Tool Response: done]")) ||
												(prevMsg.role === "model" && prevMsg.toolCalls && prevMsg.toolCalls.some(tc => (tc.functionCall?.name || tc.name) === "done"))) {
												cycleStartIdx = i + 1;
												break;
											}
										}
										if (cycleStartIdx === -1) {
											cycleStartIdx = allMsgs.findIndex(m => m.type === "user" || m.type === "model");
										}
										
										if (cycleStartIdx !== -1 && cycleStartIdx <= msgIdx + 1) {
											const cycleMsgs = allMsgs.slice(cycleStartIdx, msgIdx + 2);
											const result = await this.manager.generateCycleSummary(cycleMsgs);
											if (result && result.summary) {
												const summaryMessage = {
													id: crypto.randomUUID(),
													role: "system",
													type: "cycle_summary",
													title: result.title,
													content: result.summary,
													timestamp: Date.now(),
													cycleStartMsgId: allMsgs[cycleStartIdx].id,
													cycleEndMsgId: nextMsg.id
												};
												this.manager.activeSession.messages.splice(msgIdx + 2, 0, summaryMessage);
												this.manager.activeSession.lastModified = Date.now();
												await workspaceClient.setSession(this.manager.activeSession.id, this.manager.activeSession);
												this.render();
											}
										}
									} catch (err) {
										console.error("Failed to generate summary manually:", err);
										summarizeBtn.disabled = false;
										summarizeBtn.text = "Summarize Cycle";
									}
								};
 
								const doneBlock = Array.from(element.querySelectorAll(".tool-call-block")).find(block => block.querySelector("code")?.textContent === "done");
								if (doneBlock) {
									const headerEl = doneBlock.querySelector(".tool-call-header");
									if (headerEl) {
										summarizeBtn.classList.add("inside-header");
										const badge = headerEl.querySelector(".tool-call-status-badge");
										if (badge) {
											headerEl.insertBefore(summarizeBtn, badge);
										} else {
											headerEl.append(summarizeBtn);
										}
									} else {
										doneBlock.append(summarizeBtn);
									}
								} else {
									summarizeBtn.classList.add("outside-header");
									element.append(summarizeBtn);
								}
							}
						}
					}
				}
			}

		} else if (message.type === "system_message") {
			element = new Block();
			element.classList.add("system-message-block");
			element.dataset.messageId = message.id;
			element.setAttribute("title", `Tokens: ${tokenCount}`);
			element.innerHTML = this.md.render(message.content);

			const deleteButton = this._createSingleDeleteButton(message.id);
			element.append(deleteButton);

			if (isNew && index === this.chatHistory.length - 1) {
				element.classList.add("system-message-sticky-fade");
				element.addEventListener('animationend', () => {
					element.classList.remove('system-message-sticky-fade');
				}, { once: true });
				element.addEventListener('click', () => {
					element.classList.remove('system-message-sticky-fade');
				}, { once: true });
			}
		} else if (message.type === "task_state") {
			element = new Block();
			element.classList.add("task-state-block");
			element.dataset.messageId = message.id;
			element.setAttribute("title", `Tokens: ${tokenCount}`);
			element.innerHTML = `<strong>Current Task:</strong><br>${this.md.render(message.content)}`;

			const deleteButton = this._createSingleDeleteButton(message.id);
			element.append(deleteButton);
		} else if (message.type === "cycle_summary") {
			element = new Block();
			element.classList.add("cycle-summary-block");
			element.dataset.messageId = message.id;
			element.setAttribute("title", `Tokens: ${tokenCount}`);
			
			const summaryTitleText = message.title || (message.content ? (message.content.split(/[.\n]/)[0].trim().substring(0, 75) + "...") : "Cycle Completed & Summarized");
			
			const header = new Block();
			header.className = "cycle-summary-header";
			
			const icon = new Icon();
			icon.textContent = "summarize";
			
			const titleSpan = new Inline();
			titleSpan.className = "cycle-summary-title";
			titleSpan.textContent = summaryTitleText;
			
			const toggleBtn = new Button("Show Detail");
			toggleBtn.className = "toggle-history-btn theme-button secondary hidden";
			
			header.append(icon, titleSpan, toggleBtn);
			
			const contentDiv = new Block();
			contentDiv.className = "cycle-summary-content hidden";
			contentDiv.innerHTML = this.md.render(message.content);
			
			const detailContainer = new Block();
			detailContainer.className = "cycle-summary-detail-container hidden";
			
			toggleBtn.onclick = (e) => {
				e.stopPropagation();
				const isExpanded = !detailContainer.classList.contains("hidden");
				if (isExpanded) {
					detailContainer.classList.add("hidden");
					toggleBtn.text = "Show Detail";
				} else {
					if (detailContainer.children.length === 0) {
						const startId = message.cycleStartMsgId;
						const endId = message.cycleEndMsgId;
						const allMsgs = this.chatHistory;
						const startIdx = allMsgs.findIndex(m => m.id === startId);
						const endIdx = allMsgs.findIndex(m => m.id === endId);
						if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
							const cycleMsgs = allMsgs.slice(startIdx, endIdx + 1);
							for (const cMsg of cycleMsgs) {
								if (cMsg.type === 'file_context' || cMsg.type === 'cycle_summary') continue;
								const cEl = this._createMessageElement(cMsg, allMsgs.indexOf(cMsg));
								if (cEl) {
									const nestedDelete = cEl.querySelector(".delete-history-button");
									if (nestedDelete) nestedDelete.remove();
									const nestedReplay = cEl.querySelector(".replay-history-button");
									if (nestedReplay) nestedReplay.remove();
									detailContainer.append(cEl);
								}
							}
						} else {
							const emptyDetail = new Block();
							emptyDetail.className = "cycle-summary-empty-detail";
							emptyDetail.textContent = "Detailed history for this cycle is not available (it may have been pruned or deleted from the conversation).";
							detailContainer.append(emptyDetail);
						}
					}
					detailContainer.classList.remove("hidden");
					toggleBtn.text = "Hide Detail";
				}
			};
 
			const showMoreLink = new Block();
			showMoreLink.className = "show-more-link";
			showMoreLink.textContent = "Show Summary";
			
			showMoreLink.onclick = (e) => {
				e.stopPropagation();
				const isCollapsed = contentDiv.classList.contains("hidden");
				if (isCollapsed) {
					contentDiv.classList.remove("hidden");
					showMoreLink.textContent = "Hide Summary";
					toggleBtn.classList.remove("hidden");
				} else {
					contentDiv.classList.add("hidden");
					showMoreLink.textContent = "Show Summary";
					toggleBtn.classList.add("hidden");
					detailContainer.classList.add("hidden");
					toggleBtn.text = "Show Detail";
				}
			};
 
			element.append(header, contentDiv, showMoreLink, detailContainer);
			
			const deleteButton = this._createSingleDeleteButton(message.id);
			element.append(deleteButton);
		} else if (message.type === "agent_query") {
			element = new Block();
			element.classList.add("agent-query-block");
			element.dataset.messageId = message.id;
			if (message.subSessionId) {
				element.dataset.subSessionId = message.subSessionId;
			}

			const queryHeader = new Block();
			queryHeader.className = "agent-query-header";
			const queryIcon = new Icon();
			queryIcon.textContent = "help";
			const queryTitle = new Inline();
			queryTitle.className = "agent-query-title";
			queryTitle.textContent = "Sub-Agent Question";
			queryHeader.append(queryIcon, queryTitle);

			const queryText = new Block();
			queryText.className = "agent-query-text";
			queryText.textContent = message.content;

			element.append(queryHeader, queryText);

			if (message.answered) {
				const answerBlock = new Block();
				answerBlock.className = "agent-query-answer answered";
				const answerLabel = new Inline();
				answerLabel.className = "agent-query-answer-label";
				answerLabel.textContent = "Your answer: ";
				const answerText = new Inline();
				answerText.className = "agent-query-answer-text";
				answerText.textContent = message.answer || "";
				answerBlock.append(answerLabel, answerText);
				element.append(answerBlock);
			} else {
				const inputRow = new Block();
				inputRow.className = "agent-query-input-row";

				const answerInput = document.createElement("textarea");
				answerInput.className = "agent-query-input agent-query-textarea";
				answerInput.placeholder = "Type your answer...";
				answerInput.rows = 1;
				answerInput.style.resize = "none";
				answerInput.style.overflowY = "hidden";

				const adjustHeight = () => {
					answerInput.style.height = "auto";
					answerInput.style.height = answerInput.scrollHeight + "px";
				};
				answerInput.addEventListener("input", adjustHeight);

				const submitBtn = new Button("Answer");
				submitBtn.className = "agent-query-submit theme-button";

				const submitAnswer = () => {
					const answer = answerInput.value.trim();
					if (!answer) return;
					const resolver = window._agentQueryResolvers?.[message.id];
					if (resolver) {
						delete window._agentQueryResolvers[message.id];
						resolver(answer);
					}
					// Optimistically update UI
					inputRow.remove();
					const answerBlock = new Block();
					answerBlock.className = "agent-query-answer answered";
					const answerLabel = new Inline();
					answerLabel.className = "agent-query-answer-label";
					answerLabel.textContent = "Your answer: ";
					const answerText = new Inline();
					answerText.className = "agent-query-answer-text";
					answerText.textContent = answer;
					answerBlock.append(answerLabel, answerText);
					element.append(answerBlock);
				};

				submitBtn.onclick = submitAnswer;
				answerInput.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						if (e.ctrlKey || e.metaKey) {
							e.preventDefault();
							submitAnswer();
						}
					}
				});

				inputRow.append(answerInput, submitBtn);
				element.append(inputRow);

				if (message.subSessionId && this.manager.isSessionViewed(message.subSessionId)) {
					setTimeout(() => {
						answerInput.focus();
						adjustHeight();
					}, 100);
				}
			}
		}

		return element;
	}

	_createExpanderMessageElement(message, index) {
		const expanderBlock = new Block();
		expanderBlock.classList.add("chat-turn-expander");
		expanderBlock.dataset.messageId = message.id;

		const header = new Block();
		header.className = "expander-header";

		// Determine icon and label based on message role/type
		let iconName = "info";
		let roleLabel = "system";

		if (message.type === "user") {
			iconName = "person";
			roleLabel = "User";
		} else if (message.type === "model") {
			iconName = "smart_toy";
			roleLabel = "AI Assistant";
		} else if (message.type === "error") {
			iconName = "error";
			roleLabel = "Error";
		} else if (message.type === "task_state") {
			iconName = "assignment";
			roleLabel = "Task State";
		} else if (message.type === "system_message") {
			iconName = "info";
			roleLabel = "System";
		} else if (message.type === "system_prompt_raw") {
			iconName = "settings_suggest";
			roleLabel = "System Prompt";
		} else if (message.type === "cycle_summary") {
			iconName = "summarize";
			roleLabel = "Cycle Summary";
		} else if (message.type === "agent_query") {
			iconName = "help";
			roleLabel = "Sub-Agent Question";
		}

		// First 40 characters for preview
		const previewText = message.content ? message.content.substring(0, 40).replace(/\n/g, " ") : "";
		const previewSuffix = (message.content && message.content.length > 40) ? "..." : "";

		const tokenCount = typeof message.tokenCount === 'number' ? message.tokenCount : this.ai.estimateTokens([message]);
		const sizeInBytes = message.content ? new TextEncoder().encode(message.content).length : 0;
		const sizeInKB = (sizeInBytes / 1024).toFixed(2);

		const icon = new Icon();
		icon.textContent = iconName;

		const roleLabelSpan = new Inline();
		roleLabelSpan.className = "role-label";
		roleLabelSpan.textContent = roleLabel + " ";

		const badge = new Inline();
		badge.className = "item-size-badge";
		badge.textContent = `(${sizeInKB} KB | ${tokenCount} tokens)`;
		roleLabelSpan.append(badge);

		const previewSpan = new Inline();
		previewSpan.className = "content-preview";
		previewSpan.textContent = `${previewText}${previewSuffix}`;

		const deleteIcon = new Icon();
		deleteIcon.className = "delete-raw-item";
		deleteIcon.title = "Delete this turn permanently";
		deleteIcon.textContent = "delete";

		const arrowIcon = new Icon();
		arrowIcon.className = "expand-arrow";
		arrowIcon.textContent = "expand_more";

		header.append(icon, roleLabelSpan, previewSpan, deleteIcon, arrowIcon);

		const contentDiv = new Block();
		contentDiv.className = "expander-content hidden";

		const pre = document.createElement("pre");
		pre.className = "raw-content-block";
		pre.textContent = message.content || "";
		contentDiv.append(pre);

		header.onclick = () => {
			const isExpanded = !contentDiv.classList.contains("hidden");
			if (isExpanded) {
				contentDiv.classList.add("hidden");
				arrowIcon.textContent = "expand_more";
				expanderBlock.classList.remove("expanded");
			} else {
				contentDiv.classList.remove("hidden");
				arrowIcon.textContent = "expand_less";
				expanderBlock.classList.add("expanded");
			}
		};

		const deleteIconHeader = deleteIcon;
		if (message.type === "system_prompt_raw" && deleteIconHeader) {
			deleteIconHeader.remove();
		} else if (deleteIconHeader) {
			deleteIconHeader.onclick = (e) => {
				e.stopPropagation();
				this._handleDeleteSingleMessage(message.id);
			};
		}

		expanderBlock.append(header, contentDiv);
		return expanderBlock;
	}

	_escapeHtml(unsafe) {
		return unsafe
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	/**
	 * Sets or updates the persistent "task_state" message.
	 */
	setTaskState(content) {
		const existingIndex = this.chatHistory.findIndex(m => m.type === "task_state");
		const message = {
			id: existingIndex !== -1 ? this.chatHistory[existingIndex].id : crypto.randomUUID(),
			type: "task_state",
			role: "system",
			content: content,
			timestamp: Date.now()
		};

		if (existingIndex !== -1) {
			this.manager.activeSession.messages[existingIndex] = message;
			this.render();
		} else {
			this.manager.activeSession.messages.unshift(message);
			this.render();
		}
		this.manager._dispatchContextUpdate("task_state_updated");
	}

	_createSingleReplayButton(messageId) {
		const replayButton = new Button();
		replayButton.classList.add("replay-history-button");
		replayButton.icon = "replay";
		replayButton.title = "Replay this prompt (deletes subsequent turns and regenerates)";
		replayButton.on("click", (e) => {
			e.stopPropagation();
			if (confirm("Are you sure you want to replay this prompt? This will permanently delete all subsequent messages in this session and request a new response.")) {
				this.manager.replayMessage(messageId);
			}
		});
		return replayButton;
	}

	_createSingleDeleteButton(messageId) {
		const deleteButton = new Button();
		deleteButton.classList.add("delete-history-button");
		deleteButton.icon = "delete";
		deleteButton.title = "Delete this message permanently";
		deleteButton.on("click", (e) => {
			e.stopPropagation();
			this._handleDeleteSingleMessage(messageId);
		});
		return deleteButton;
	}

	async _handleDeleteSingleMessage(messageId) {
		if (!this.manager.activeSession) return;

		const msgIndex = this.chatHistory.findIndex(msg => msg.id === messageId);
		if (msgIndex === -1) {
			console.warn(`Attempted to delete a message with ID ${messageId} that was not found.`);
			return;
		}

		const deletedMessage = this.chatHistory[msgIndex];

		this.manager.activeSession.messages.splice(msgIndex, 1);
		this.manager.activeSession.lastModified = Date.now();
		await workspaceClient.setSession(this.manager.activeSession.id, this.manager.activeSession);

		this.render();

		this.manager._setButtonsDisabledState(this.manager._isProcessing);
		this.manager._dispatchContextUpdate("delete_item");

		this._showUndoToast(deletedMessage, msgIndex);
	}

	_showUndoToast(deletedMessage, originalIndex) {
		// If there is an existing undo toast, remove it first
		const existingToast = document.querySelector(".undo-delete-toast");
		if (existingToast) {
			if (existingToast.dataset.timeoutId) {
				clearTimeout(parseInt(existingToast.dataset.timeoutId));
			}
			if (existingToast.dataset.deletedMessageJson) {
				try {
					const prevMsg = JSON.parse(existingToast.dataset.deletedMessageJson);
					this.manager.deleteSubAgentsInMessages([prevMsg]);
				} catch (e) {
					console.error("Failed to clean up sub-agents for early dismissed message:", e);
				}
			}
			existingToast.remove();
		}

		const toastEl = new Block();
		toastEl.className = "undo-delete-toast";
		toastEl.dataset.deletedMessageJson = JSON.stringify(deletedMessage);

		const textSpan = new Inline();
		textSpan.textContent = "Message deleted from history.";
		toastEl.appendChild(textSpan);

		const undoBtn = new Button("Undo");
		undoBtn.className = "undo-delete-toast-btn";

		undoBtn.onclick = async () => {
			if (toastEl.dataset.timeoutId) {
				clearTimeout(parseInt(toastEl.dataset.timeoutId));
			}
			if (this.manager.activeSession) {
				this.manager.activeSession.messages.splice(originalIndex, 0, deletedMessage);
				this.manager.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.manager.activeSession.id, this.manager.activeSession);
				this.render();
				this.manager._dispatchContextUpdate("undo_delete");
			}
			toastEl.classList.remove("visible");
			setTimeout(() => toastEl.remove(), 300);
		};

		toastEl.appendChild(undoBtn);
		document.body.appendChild(toastEl);

		// Fade in
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				toastEl.classList.add("visible");
			});
		});

		// Automatically fade out and remove after 6 seconds
		const timeoutId = setTimeout(() => {
			toastEl.classList.remove("visible");
			setTimeout(() => {
				if (toastEl.parentNode) {
					toastEl.remove();
				}
				this.manager.deleteSubAgentsInMessages([deletedMessage]);
			}, 300);
		}, 6000);

		toastEl.dataset.timeoutId = timeoutId.toString();
	}

	/**
	 * Handles the deletion of a file context item from the history.
	 * REWRITTEN to perform direct DOM removal before modifying the active session's messages.
	 * @param {string} fileId - The unique ID of the file context item to remove.
	 */
	_handleDeleteFileContextItem(fileId) {
		if (!this.manager.activeSession) return;

		// Remove the chip from the FileBar UI
		this.manager.fileBar.remove(fileId);

		// Then update the data array
		this.manager.activeSession.messages = this.manager.activeSession.messages.filter(
			(item) => item.id !== fileId
		);

		this.manager.activeSession.lastModified = Date.now(); // Update last modified timestamp
		
		// Re-enable buttons state as history has changed
		this.manager._setButtonsDisabledState(this.manager._isProcessing);
		this.manager._dispatchContextUpdate("delete_item"); // Dispatch update to save changes
	}

	// OLD addContextFile is removed as AIManager.generate handles it directly.
	// OLD _appendFileContextUI is replaced by _createFileContextElement and appendMessageElement.

	/**
	 * NEW: Method to add a delete button to the last user message after a model response is received.
	 * This function ensures the delete button appears for full conversation turns.
	 */
	addInteractionToLastUserMessage(userMessage) {
		if (!userMessage || !userMessage.id) return;

		// Find the user message element in the DOM
		const userElement = this.conversationArea.querySelector(`[data-message-id="${userMessage.id}"]`);
		if (userElement && userElement.classList.contains("prompt-pill-wrapper")) {
			// Check if a delete button already exists to prevent duplicates on re-renders
			if (!userElement.querySelector(".delete-history-button")) {
				const userPromptIndex = this.chatHistory.findIndex(msg => msg.id === userMessage.id);
				if (userPromptIndex !== -1) { // Check that message is still in history
					const replayButton = this._createSingleReplayButton(userMessage.id);
					userElement.append(replayButton);

					const deleteButton = this._createSingleDeleteButton(userMessage.id);
					userElement.append(deleteButton);
				}
			}
		}
	}

	async performSummarization() {
		if (this.manager._isProcessing) {
			console.warn("AI is currently processing or summarizing. Please wait.")
			return
		}
        // Do not summarize if AI is not configured or no active session
        if (!this.manager.ai || !this.manager.ai.isConfigured() || !this.manager.activeSession) {
            console.warn("AI is not configured or no active session. Cannot perform summarization.");
            this.addMessage({
                type: "system_message",
                content: `AI is not configured or no active session. Cannot perform summarization. Please set up your AI provider in the settings or create a new chat.`,
                timestamp: Date.now(),
            });
            return;
        }

		this.manager._isProcessing = true
		this.manager._setButtonsDisabledState(true)

		const summarizeButton = this.manager.summarizeButton;
		let originalButtonContent = '';

		try {
			// Replace button content with a spinner
			if (summarizeButton) {
				originalButtonContent = summarizeButton.innerHTML;
				summarizeButton.innerHTML = '<div class="button-spinner"></div>';
				summarizeButton.classList.add('loading');
			}

			// All operations now directly on this.manager.activeSession.messages.
            const conversationMessages = this.manager.activeSession.messages;
            
			// Find the starting point of the actual conversation, skipping all initial file contexts.
			const firstConversationIndex = conversationMessages.findIndex((msg) => msg.type !== "file_context")

			// If there's no conversation yet (e.g., only files have been added), we can't summarize.
			if (firstConversationIndex === -1) {
				console.info("No conversational messages found to summarize.")
				return // Exit gracefully. The 'finally' block will re-enable buttons.
			}

			// Create a contiguous block of the entire conversation to date.
			// This block is guaranteed to start with a user/model message.
			const conversationBlock = conversationMessages.slice(firstConversationIndex)

			// From this block, get only the messages that are part of the dialogue (user/model).
			// This neatly filters out any UI-only 'system_message' entries that might be inside the block.
			const eligibleMessages = conversationBlock.filter((msg) => msg.type === "user" || msg.type === "model")

			// Determine how many of the OLDEST eligible messages we should summarize.
			const targetPercentage = this.manager.config.summarizeTargetPercentage / 100
			const totalEligible = eligibleMessages.length

			// Calculate how many messages we could possibly summarize without touching the most recent ones.
			const maxPossibleToSummarize = Math.max(0, totalEligible - MAX_RECENT_MESSAGES_TO_PRESERVE)
			// Calculate the number of messages our percentage setting is targeting.
			const numberToTargetForSummarization = Math.floor(totalEligible * targetPercentage)
			// The final number to summarize is the smaller of the two, ensuring we never touch the preserved messages.
			const finalNumberToSummarize = Math.min(numberToTargetForSummarization, maxPossibleToSummarize)

			if (finalNumberToSummarize < 2) {
				// Need at least a user/model back-and-forth to be meaningful.
				console.info("Not enough old messages to create a meaningful summary.")
				return
			}

			// Identify the exact block in the original history that needs to be replaced.
			// We do this by finding the index of the Nth eligible message within our conversationBlock.
			let eligibleCount = 0
			let endIndexInConversationBlock = -1
			for (let i = 0; i < conversationBlock.length; i++) {
				if (conversationBlock[i].type === "user" || conversationBlock[i].type === "model") {
					eligibleCount++
				}
				if (eligibleCount === finalNumberToSummarize) {
					endIndexInConversationBlock = i
					break
				}
			}

			// This slice now correctly includes any interspersed 'system_message' entries that will be removed.
			const actualMessagesToReplace = conversationBlock.slice(0, endIndexInConversationBlock + 1)
			const tokensBeforeSummary = this.ai.estimateTokens(actualMessagesToReplace)

			// Create the clean prompt content using only the eligible messages from the block we're replacing.
			const summarizationPromptContent = actualMessagesToReplace
				.filter((msg) => msg.type === "user" || msg.type === "model")
				.map((msg) => {
					let content = msg.content || "";
					content = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
					content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
					content = content.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '');
					return `${msg.role === "user" ? "User" : "Assistant"}: ${content.trim()}`;
				})
				.join("\n\n")

			const summarizationPrompt = `Please summarize the following conversation very concisely, focusing on key topics, questions, and outcomes. Do not add any new information or conversational filler. Just the summary.\n\n${summarizationPromptContent}`
			const internalMessagesForAI = [{ role: "user", content: summarizationPrompt }]

			// Perform the AI call using the original promise/callback structure.
			let summaryResponse = ""
			await new Promise((resolve, reject) => {
				this.ai.chat(internalMessagesForAI, {
					onUpdate: (response) => {
						summaryResponse = response // Capture streaming response
					},
					onDone: () => resolve(), // Resolve the promise when AI is finished
					onError: (error) => reject(error), // Reject the promise on error
				})
			})

			// If we got a summary, replace the old history with the new summary.
			if (summaryResponse) {
				const summaryMessage = {
					id: crypto.randomUUID(),
					role: "model",
					type: "model",
					content: `**Summary of prior conversation:**\n\n${summaryResponse}`,
					timestamp: Date.now(),
				}
				const tokensAfterSummary = this.ai.estimateTokens([summaryMessage])

				const systemMessage = {
					id: crypto.randomUUID(),
					type: "system_message",
					content: `History summarized: **${tokensBeforeSummary}** tokens condensed to **${tokensAfterSummary}** tokens.`,
					timestamp: Date.now(),
				}

				// The splice operation is now simpler and more robust.
				const spliceStartIndex = firstConversationIndex
				const spliceCount = actualMessagesToReplace.length

				// Modify the active session's messages directly
				this.manager.activeSession.messages.splice(spliceStartIndex, spliceCount, summaryMessage); // Insert summary at the top
				this.manager.activeSession.messages.push(systemMessage); // Append system message to the end
				this.manager.activeSession.lastModified = Date.now(); // Update last modified timestamp for the session

				this.render({ isNewMessage: true }); // Render with the new summary and flag the last message as new and sticky
				this.manager._dispatchContextUpdate("summarize", {
					summaryDetails: { tokensBefore: tokensBeforeSummary, tokensAfter: tokensAfterSummary },
				})
			}
		} catch (error) {
			console.error("Error during summarization:", error)
			this.addMessage({ // Use addMessage as it will then trigger render
				type: "system_message",
				content: `Error during summarization: ${error.message}`,
				timestamp: Date.now(),
			})
			this.manager._dispatchContextUpdate("summarize_error")
		} finally {
			this.manager._isProcessing = false
			// Restore button content and remove spinner
			if (summarizeButton) {
				summarizeButton.innerHTML = originalButtonContent;
				summarizeButton.classList.remove('loading');
			}
			this.manager._setButtonsDisabledState(false)
		}
	}

	async updateMessageTokenCounts(session) {
		if (!session || !this.ai || !this.ai.isConfigured()) return;
		if (typeof this.ai.tokenize !== 'function') return;

		let updated = false;

		if (session.tokenizedForProvider !== this.ai.providerId) {
			for (const msg of session.messages) {
				delete msg.tokenCount;
			}
			delete session.implementationPlanTokenCount;
			delete session.taskListTokenCount;
			session.tokenizedForProvider = this.ai.providerId;
			updated = true;
		}

		for (const msg of session.messages) {
			if (typeof msg.tokenCount !== 'number' && msg.content) {
				if (msg.type === 'system_message' || msg.type === 'error' || msg.role === 'temp_ai_response') {
					msg.tokenCount = 0;
					updated = true;
					continue;
				}

				let textToTokenize = msg.content;
				if (msg.type === 'file_context') {
					textToTokenize = `--- File: ${msg.id || msg.filename || 'unknown'} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\``;
				}

				const count = await this.ai.tokenize(textToTokenize);
				if (typeof count === 'number') {
					msg.tokenCount = count;
					updated = true;
				}
			}
		}

		if (session.implementationPlan && typeof session.implementationPlanTokenCount !== 'number') {
			const textToTokenize = `EVERGREEN IMPLEMENTATION PLAN:\n${session.implementationPlan}`;
			const count = await this.ai.tokenize(textToTokenize);
			if (typeof count === 'number') {
				session.implementationPlanTokenCount = count;
				updated = true;
			}
		} else if (!session.implementationPlan && session.implementationPlanTokenCount !== undefined) {
			delete session.implementationPlanTokenCount;
			updated = true;
		}

		if (session.taskList && typeof session.taskListTokenCount !== 'number') {
			const textToTokenize = `EVERGREEN TASK LIST:\n${session.taskList}`;
			const count = await this.ai.tokenize(textToTokenize);
			if (typeof count === 'number') {
				session.taskListTokenCount = count;
				updated = true;
			}
		} else if (!session.taskList && session.taskListTokenCount !== undefined) {
			delete session.taskListTokenCount;
			updated = true;
		}

		if (updated) {
			session.lastModified = Date.now();
			await workspaceClient.setSession(session.id, session);
			this.render();
			this.manager._dispatchContextUpdate("tokens_updated");
		}
	}

	prepareMessagesForAI(sessionObj = null) {
		const targetSession = sessionObj || this.manager.activeSession;
		// Create a deep enough copy of messages to avoid modifying the original history.
		let messages = (targetSession?.messages || []).map(msg => ({ ...msg }));

		// 1. Extract the Evergreen Task State
		const taskStateMessage = messages.find(msg => msg.type === "task_state");
		
		// 2. Separate chat/system/file messages from the protected task state
		// We filter out task_state from the main pool so it doesn't get pruned.
		let chatHistory = messages.filter(
			(msg) => msg.type !== "task_state" && msg.type !== "system_message" && msg.type !== "agent_query" && msg.role !== "temp_ai_response"
		);

		// Pruning gate: Substitute older completed cycles with their summaries, keeping only the most recent completed cycle in full.
		const summaries = chatHistory.filter(msg => msg.type === "cycle_summary");
		if (summaries.length > 0) {
			let newChatHistory = [];
			let i = 0;
			while (i < chatHistory.length) {
				const msg = chatHistory[i];
				if (msg.type === "cycle_summary") {
					const isLastSummary = msg.id === summaries[summaries.length - 1].id;
					if (isLastSummary) {
						// Keep the most recent completed cycle in full. Omit the summary message itself to avoid redundancy.
						i++;
						continue;
					} else {
						// This is an older cycle. Substitute the summary in place of the cycle messages.
						const startId = msg.cycleStartMsgId;
						const endId = msg.cycleEndMsgId;
						if (startId && endId) {
							const startIdx = newChatHistory.findIndex(m => m.id === startId);
							const replaceStartIdx = startIdx !== -1 ? startIdx : 0;
							newChatHistory.splice(replaceStartIdx, newChatHistory.length - replaceStartIdx, {
								id: msg.id,
								role: "user",
								type: "cycle_summary",
								content: `**Cycle: ${msg.title || "Completed Task"}**\n\n${msg.content}`,
								timestamp: msg.timestamp
							});
							i++;
							continue;
						}
					}
				}
				newChatHistory.push(msg);
				i++;
			}
			chatHistory = newChatHistory;
		}

		// Calculate extra tokens of evergreen plan, task list, directives, task state, and system prompt
		let extraTokens = 0;
		if (this.manager.agentMode) {
			if (this.manager.activeSession?.implementationPlan) {
				extraTokens += this.ai.estimateTokens([{
					role: "system",
					content: `EVERGREEN IMPLEMENTATION PLAN:\n${this.manager.activeSession.implementationPlan}`,
					tokenCount: this.manager.activeSession.implementationPlanTokenCount
				}]);
			}
			if (this.manager.activeSession?.taskList) {
				extraTokens += this.ai.estimateTokens([{
					role: "system",
					content: `EVERGREEN TASK LIST:\n${this.manager.activeSession.taskList}`,
					tokenCount: this.manager.activeSession.taskListTokenCount
				}]);
			}
		}
		if (taskStateMessage) {
			extraTokens += this.ai.estimateTokens([{
				role: "system",
				content: `CURRENT TASK STATUS:\n${taskStateMessage.content}`,
				tokenCount: taskStateMessage.tokenCount
			}]);
		}
		
		if (this.manager.agentMode && chatHistory.length > 0) {
			const hasPlan = !!this.manager.activeSession?.implementationPlan;
			const hasTasks = !!this.manager.activeSession?.taskList;
			const hasAcceptedPlan = this.manager.activeSession?.messages?.some(m => m.planStatus === "accepted") || false;
			
			let hasCompletedAllTasks = false;
			if (hasTasks && this.manager.activeSession.taskList) {
				hasCompletedAllTasks = !this.manager.activeSession.taskList.includes("- [ ]") && !this.manager.activeSession.taskList.includes("* [ ]");
			}

			const directivesText = getAgentDirectives({
				hasPlan,
				hasTasks,
				hasAcceptedPlan,
				hasCompletedAllTasks
			});

			if (directivesText) {
				extraTokens += this.ai.estimateTokens(directivesText);
			}
		}

		// System prompt estimate
		const activeSystemPrompt = this.ai?.config?.system || "";
		if (activeSystemPrompt) {
			extraTokens += this.ai.estimateTokens(activeSystemPrompt);
		} else {
			extraTokens += 500;
		}
		extraTokens += 500; // general safety headroom

		// NEW: Always strip thought blocks from the context.
		// Native reasoning models will get confused and try to explicitly output the tags
		// if they see them in the few-shot history.
		chatHistory = chatHistory.map(msg => {
			if (msg.content) {
				let newContent = msg.content;
				newContent = newContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
				newContent = newContent.replace(/<think>[\s\S]*?<\/think>/gi, '');
				newContent = newContent.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '');
				return {
					...msg,
					content: newContent.trim()
				};
			}
			return msg;
		}).filter(msg => msg.content && msg.content.trim() !== "");

		// NEW: If Agent Mode is turned OFF, strip out agent-specific tags and filter tool responses 
		// to prevent chat history prompt contamination/few-shot leakage.
		if (!this.manager.agentMode) {
			chatHistory = chatHistory.filter(msg => msg.type !== "tool_response");
			chatHistory = chatHistory.map(msg => {
				if (msg.content) {
					let newContent = msg.content;
					// Strip XML tool calls
					newContent = newContent.replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '');
					// Strip legacy implementation plan and task list XML tags
					newContent = newContent.replace(/<implementation_plan>[\s\S]*?<\/implementation_plan>/gi, '');
					newContent = newContent.replace(/<task_list>[\s\S]*?<\/task_list>/gi, '');
					// Strip JSON project management tools (if they leaked in as native tool calls)
					// (These shouldn't be in msg.content if they are native, but if they were serialized, strip them)
					newContent = newContent.replace(/<tool_call\s+name=["'](create_implementation_plan|update_task_list|complete_task|done)["']\s*>[\s\S]*?<\/tool_call>/gi, '');
					// Strip legacy task completion signals
					// Strip task completion signals
					newContent = newContent.replace(/<complete_task>[\s\S]*?<\/complete_task>/gi, '');
					return {
						...msg,
						content: newContent.trim()
					};
				}
				return msg;
			}).filter(msg => msg.content && msg.content.trim() !== "");
		}

		// Partition chat history into file contexts and dialogue history to preserve attachments
		const fileContexts = this.manager.agentMode ? [] : chatHistory.filter(msg => msg.type === "file_context");
		let dialogueHistory = chatHistory.filter(msg => msg.type !== "file_context");

		// Advanced Dialogue Pruning in Agent Mode
		if (this.manager.agentMode) {
			// Instead of a fixed message count (like 14), prune oldest dialogue turns ONLY if the estimated tokens exceed the target limit.
			// For all providers target 80% of their MAX_CONTEXT_TOKENS (defined in their settings/props).
			// BUT preserve ALL user instructions to maintain chronological task timeline.
			const targetLimit = Math.max(1000, Math.floor((this.ai?.MAX_CONTEXT_TOKENS || 8192) * 0.8) - extraTokens);
			const currentTokens = this.ai.estimateTokens([...fileContexts, ...dialogueHistory]);
			if (currentTokens > targetLimit) {
				const userPrompts = dialogueHistory.filter(msg => msg.type === "user");
				
				// Search backwards to find the maximum number of recent dialogue turns we can keep
				let sliceIndex = 0;
				for (let count = 1; count <= dialogueHistory.length; count++) {
					let candidateIndex = dialogueHistory.length - count;
					
					// Fix paired pruning boundary:
					// If the candidate message is a tool_response, we must keep its model message as well.
					if (candidateIndex > 0 && dialogueHistory[candidateIndex].type === "tool_response") {
						candidateIndex -= 1;
					}
					
					const recentHistory = dialogueHistory.slice(candidateIndex);
					
					const keepIds = new Set();
					userPrompts.forEach(m => keepIds.add(m.id));
					recentHistory.forEach(m => keepIds.add(m.id));
					
					const testDialogue = dialogueHistory.filter(msg => keepIds.has(msg.id));
					const testHistory = [...fileContexts, ...testDialogue];
					const testTokens = this.ai.estimateTokens(testHistory);
					
					if (testTokens <= targetLimit) {
						sliceIndex = candidateIndex;
					} else {
						break;
					}
				}
				
				if (sliceIndex > 0) {
					const recentHistory = dialogueHistory.slice(sliceIndex);
					const keepIds = new Set();
					userPrompts.forEach(m => keepIds.add(m.id));
					recentHistory.forEach(m => keepIds.add(m.id));
					
					const newDialogueHistory = [];
					let lastKeptIndex = -1;
					
					for (let i = 0; i < dialogueHistory.length; i++) {
						if (keepIds.has(dialogueHistory[i].id)) {
							const skipped = i - lastKeptIndex - 1;
							if (skipped > 0) {
								newDialogueHistory.push({
									id: `pruned-gap-${i}`,
									role: "system",
									type: "system_message",
									content: `[${skipped} turns pruned for context length]`
								});
							}
							newDialogueHistory.push(dialogueHistory[i]);
							lastKeptIndex = i;
						}
					}
					dialogueHistory = newDialogueHistory;
				}
			}
		}

		// Recombine file contexts and pruned dialogue history
		chatHistory = [...fileContexts, ...dialogueHistory];

		// 3. Handle code block stripping in the chat history
		const stripCodeBlocks = this.manager.ai.config.stripCodeBlocksFromContext;
		if (stripCodeBlocks) {
			const codeBlockWithHeaderRegex = /(?:^|\n)\s*(?:#{1,6}[^\n]*\n+)?\s*```(?:\w+)?\n[\s\S]*?\n\s*```/g;
			chatHistory.forEach((msg, index) => {
				const isLastMessage = index === chatHistory.length - 1;
				const isToolResponse = msg.content && msg.content.startsWith('[Tool Response:');
				
				if (!isLastMessage && !isToolResponse && (msg.type === 'model' || msg.type === 'user') && msg.content) {
					msg.content = msg.content.replace(codeBlockWithHeaderRegex, '\n\n<OBSOLETE CODE STRIPPED>\n\n').trim();
				}
			});
		}

		// 4. Prune the chat history to fit within 80% of the context window (leaving 20% headroom for response)
		const maxTokens = this.ai.MAX_CONTEXT_TOKENS || 4096;
		const allowedTokens = Math.max(1000, Math.floor(maxTokens * 0.8) - extraTokens);
		let currentTokens = this.ai.estimateTokens(chatHistory);
		const minimumMessagesToKeep = 1;

		while (currentTokens > allowedTokens && chatHistory.length > minimumMessagesToKeep) {
			chatHistory.shift(); // Remove oldest message
			currentTokens = this.ai.estimateTokens(chatHistory);
		}

		// 5. Reconstruct the context for the AI
		// We always want the Task State to be the very first thing the AI sees.
		const contextForAI = [];

		// NEW: Prepend evergreen plan and task checklist at the top of AI context in Agent Mode
		if (this.manager.agentMode) {
			if (this.manager.activeSession?.implementationPlan) {
				contextForAI.push({
					role: "system",
					content: `EVERGREEN IMPLEMENTATION PLAN:\n${this.manager.activeSession.implementationPlan}`,
					tokenCount: this.manager.activeSession.implementationPlanTokenCount
				});
			}
			if (this.manager.activeSession?.taskList) {
				contextForAI.push({
					role: "system",
					content: `EVERGREEN TASK LIST:\n${this.manager.activeSession.taskList}`,
					tokenCount: this.manager.activeSession.taskListTokenCount
				});
			}
		}

		if (taskStateMessage) {
			contextForAI.push({
				role: "system",
				content: `CURRENT TASK STATUS:\n${taskStateMessage.content}`,
				tokenCount: taskStateMessage.tokenCount
			});
		}

		// Layer Outlines First
		chatHistory.forEach(msg => {
			if (msg.type === "file_context" && msg.mode === "outline" && msg.outline) {
				contextForAI.push({
					role: "user",
					content: `--- Outline: ${msg.id} ---\n\`\`\`${msg.language}\n${msg.outline}\n\`\`\``,
				});
			}
		});

		// Add remaining chat history and Full file contexts
		chatHistory.forEach(msg => {
			if (msg.type === "file_context") {
				if (msg.mode !== "outline") {
					contextForAI.push({
						role: "user",
						content: `--- File: ${msg.id} ---\n\`\`\`${msg.language}\n${msg.content}\n\`\`\``,
					});
				}
			} else {
				let content = msg.content;
				let toolCalls = msg.toolCalls;
				
				if (this.ai.supportsJSONTools) {
					// Self-healing: if no toolCalls are present on the message, but content has XML, parse them!
					if ((!toolCalls || toolCalls.length === 0) && content && content.includes('<tool_call')) {
						const parsed = this.manager._parseAllToolCalls(content);
						if (parsed && parsed.length > 0) {
							toolCalls = parsed.map(ptc => ({
								functionCall: {
									name: ptc.name,
									args: ptc.arguments
								}
							}));
						}
					}
					
					// Strip XML from content for JSON-native models
					if (content) {
						content = content.replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '').trim();
					}
				} else {
					// For non-JSON-native models, if they have JSON toolCalls but no XML in content, append it
					if (toolCalls && toolCalls.length > 0 && (!content || !content.includes("<tool_call"))) {
						for (const tc of toolCalls) {
							const callObj = tc.functionCall || tc;
							let xml = `\n<tool_call name="${callObj.name}">\n`;
							const args = callObj.args || callObj.arguments || {};
							let argsObj = {};
							try {
								argsObj = typeof args === 'string' ? JSON.parse(args) : args;
							} catch (e) {
								console.error("[History] Failed to parse tool call args:", args, e);
								argsObj = {};
							}
							for (const [k, v] of Object.entries(argsObj)) {
								const stringValue = typeof v === 'object' ? JSON.stringify(v) : v;
								xml += `  <${k}>${stringValue}</${k}>\n`;
							}
							xml += `</tool_call>\n`;
							content += xml;
						}
					}
				}

				const contextItem = {
					role: msg.role,
					content: content
				};
				
				if (this.ai.supportsJSONTools && toolCalls && toolCalls.length > 0) {
					contextItem.toolCalls = toolCalls;
				}
				if (msg.thoughtSignature) {
					contextItem.thoughtSignature = msg.thoughtSignature;
				}
				
				contextForAI.push(contextItem);
			}
		});

		if (this.manager.agentMode && contextForAI.length > 0) {
			const hasPlan = !!this.manager.activeSession?.implementationPlan;
			const hasTasks = !!this.manager.activeSession?.taskList;
			const hasAcceptedPlan = this.manager.activeSession?.messages?.some(m => m.planStatus === "accepted") || false;
			
			let hasCompletedAllTasks = false;
			if (hasTasks && this.manager.activeSession.taskList) {
				hasCompletedAllTasks = !this.manager.activeSession.taskList.includes("- [ ]") && !this.manager.activeSession.taskList.includes("* [ ]");
			}

			const directivesText = getAgentDirectives({
				hasPlan,
				hasTasks,
				hasAcceptedPlan,
				hasCompletedAllTasks
			});

			if (directivesText) {
				contextForAI.splice(contextForAI.length - 1, 0, {
					role: "system",
					content: directivesText
				});
			}
		}

		if (currentTokens > allowedTokens) {
			console.warn(`Context window exceeded 80% headroom limit even after pruning. Estimated: ${currentTokens}, Allowed: ${allowedTokens}`);
		}

		return contextForAI;
	}
}

export default AIManagerHistory
