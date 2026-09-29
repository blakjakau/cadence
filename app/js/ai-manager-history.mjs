// ai-manager-history.mjs

import { Block, Button, Inline, Icon } from "./elements.mjs"
import DEFAULT_WELCOME_MESSAGE_MARKDOWN from "./ai-manager-setup-guide.mjs"
import workspaceClient from "./workspace-client.mjs"
import { getAgentDirectives } from "./ai-manager-agent-prompt.mjs"
import AIConnections, { resolvePrefillTokens } from "./ai-connections.mjs"
import agentTools from "./agent/agent-tools.mjs"
import { Agent } from "./agent/agent.mjs"
	import { normalizePolicy, mergePolicies, evaluateCommand, segmentMatchesRule, segmentPrograms, subChipsFor } from "./util/command-rules.mjs"
import { parseCommandLine, classifyProgram, annotateCommand } from "./util/command-parser.mjs"
import { buildCullIndex } from "./ai-manager-cull-index.mjs"
export const MAX_RECENT_MESSAGES_TO_PRESERVE = 5
export const MAX_DIRECT_CYCLE_SUMMARIES = 3

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

	/**
	 * Resolves a session object by ID, preferring the in-memory running-session reference
	 * (so mutations stay in sync with the live agent), then the active session, then a
	 * network fetch. Returns null if the session cannot be resolved.
	 * @param {string} sessionId
	 * @returns {Promise<object|null>}
	 */
	async _resolveSessionById(sessionId) {
		if (!sessionId) return null;
		const running = this.manager.runningSessions.get(sessionId);
		if (running) {
			const s = running.session || (running.instance && running.instance.session);
			if (s) return s;
		}
		if (this.manager.activeSession && this.manager.activeSession.id === sessionId) {
			return this.manager.activeSession;
		}
		try {
			return await workspaceClient.getSession(sessionId);
		} catch (e) {
			console.warn("[AIManagerHistory] _resolveSessionById failed for", sessionId, e);
			return null;
		}
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
		// 1. Add pinned root chips
		const pinnedRoots = this.manager.activeSession?.pinnedRoots || [];
		const workspaceFolders = window.workspace?.folders || [];
		for (const rootPath of pinnedRoots) {
			const matchingFolder = workspaceFolders.find(f => f === rootPath) || rootPath;
			const norm = matchingFolder.replace(/\\/g, '/').replace(/\/+$/, '');
			const rootName = norm.split('/').filter(Boolean).pop() || matchingFolder;
			this.manager.fileBar.addRoot({ name: rootName, path: matchingFolder, id: `rootchip-${rootPath}` });
		}
		// 2. Add pinned skill chips
		const pinnedSkills = this.manager.activeSession?.pinnedSkills || [];
		for (const skillName of pinnedSkills) {
			this.manager.fileBar.addSkill({ name: skillName, id: `skillchip-${skillName}` });
		}
		// 3. Add file context chips
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
					
					this.manager._autoscrollEnabled = subSession ? (subSession.autoscrollEnabled !== false) : true;
					if (this.manager._autoscrollEnabled) {
						this.manager._hideAutoscrollChip();
					} else {
						this.manager._showAutoscrollChip();
					}

					if (pendingQueryCard && !subSession?.scrollTop) {
						console.debug("[Scroll Debug] Scrolling sub-agent query card into view.");
						pendingQueryCard.scrollIntoView({ behavior: "auto", block: "nearest" });
					} else if (subSession) {
						this.conversationArea.scrollTop = subSession.scrollTop || 0;
					}
				} else {
					console.debug("[Scroll Debug] Switching to Parent. savedScrollTop:", this.manager.activeSession?.scrollTop, "pendingQueryCard:", !!pendingQueryCard);
					
					this.manager._autoscrollEnabled = this.manager.activeSession ? (this.manager.activeSession.autoscrollEnabled !== false) : true;
					if (this.manager._autoscrollEnabled) {
						this.manager._hideAutoscrollChip();
					} else {
						this.manager._showAutoscrollChip();
					}

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
			// Only REAL summaries collapse a span. Content-only seeds (isSeed) are in-flight
			// placeholders ("Compacting cycle…") — collapsing their span would hide live turns
			// behind an empty placeholder (the exact corruption seen in the sub-agent view).
			const summaries = subMessages.filter(msg => msg.type === "cycle_summary" && !msg.isSeed);
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

			let currentSubModelTurnContent = null;
			for (let i = 0; i < subMessages.length; i++) {
				const message = subMessages[i];
				if (message.type === 'file_context') continue;
				if (summarizedIds.has(message.id)) continue;
				
				const element = this._createMessageElement(message, i, false, subSession);
				if (!element) continue;

				if (message.type === "model" || message.type === "error") {
					currentSubModelTurnContent = element.querySelector(".model-turn-content");
					this.conversationArea.append(element);
				} else if (
					(message.type === "agent_command_output" || 
					 message.type === "agent_command_approval" || 
					 message.type === "tool_response" || 
					 (message.content && message.content.startsWith("[Tool Response:"))) &&
					currentSubModelTurnContent
				) {
					currentSubModelTurnContent.append(element);
				} else {
					if (message.type === "user") {
						currentSubModelTurnContent = null;
					}
					this.conversationArea.append(element);
				}
			}

			if (runningSubAgent && runningSubAgent.responseBlock) {
				this.conversationArea.append(runningSubAgent.responseBlock);
			}

			if (!isSwitchingSession) {
				setTimeout(() => {
					const pendingQueryCard = this.conversationArea.querySelector(".agent-query-block:not(.answered)");
					console.debug("[Scroll Debug] Sub-Agent Update. shouldScroll:", shouldScroll, "pendingQueryCard:", !!pendingQueryCard);
					if (shouldScroll) {
						this.manager.scrollToBottom(true);
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

		// Scope the parent branch to the *viewed* session (not necessarily the active tab).
		// `viewedSessionId` is the sub-agent id when one is being viewed, else the active
		// session id. Resolve its messages locally so collapse-last-turn state and the
		// streaming-detection below operate on the viewed session, not the active tab.
		const viewedSessionId = this.manager.activeSession?.activeSubAgentSessionId || this.manager.activeSessionId;
		const viewedSession = await this._resolveSessionById(viewedSessionId);
		const history = (viewedSession && viewedSession.messages) || this.chatHistory;

		// If history is empty, show the empty state background.
		if (history.length === 0) {
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

		// Collect IDs of messages that have been summarized to skip rendering them directly in the chat history.
		// Only REAL summaries collapse a span. Content-only seeds (isSeed) are in-flight placeholders
		// ("Compacting cycle…") — collapsing their span would hide live turns behind an empty placeholder.
		const summarizedIds = new Set();
		let lastSummarizedIdx = -1;
		const summaries = history.filter(msg => msg.type === "cycle_summary" && !msg.isSeed);
		for (const summary of summaries) {
			const startId = summary.cycleStartMsgId;
			const endId = summary.cycleEndMsgId;
			if (startId && endId) {
				const startIdx = history.findIndex(m => m.id === startId);
				const endIdx = history.findIndex(m => m.id === endId);
				if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
					for (let j = startIdx; j <= endIdx; j++) {
						summarizedIds.add(history[j].id);
					}
					if (endIdx > lastSummarizedIdx) {
						lastSummarizedIdx = endIdx;
					}
				}
			}
		}

		// In condensedViewMode: identify the current cycle messages (after the last cycle summary)
		// and determine the allowed message IDs.
		// Rule: If currently generating, active turn is the streaming block, so keep only the previous 1 completed turn from history.
		// If idle (not generating), keep the last 2 completed turns (current turn + previous turn).
		// Scope streaming-detection to the *viewed* session so collapse-last-turn state
		// does not cross between the active tab and a different viewed/source session.
		const runningSession = this.manager.runningSessions.get(viewedSessionId) || this.manager.runningSessions.get(this.manager.activeSessionId);
		const hasActiveStreaming = !!(runningSession && runningSession.responseBlock);
		const condensedAllowedIds = new Set();

		if (this.manager.condensedViewMode && !this.manager.rawViewMode) {
			// Find all unsummarized, non-file_context, non-cycle_summary messages (the active cycle)
			const activeCycleMessages = [];
			for (let i = lastSummarizedIdx + 1; i < history.length; i++) {
				const msg = history[i];
				if (msg.type !== 'file_context' && !summarizedIds.has(msg.id) && msg.type !== 'cycle_summary') {
					activeCycleMessages.push(msg);
				}
			}

			// Group active cycle messages into discrete user-initiated or assistant turns
			const turns = [];
			let currentTurn = [];
			for (const msg of activeCycleMessages) {
				if (msg.type === "user" || msg.type === "model" || msg.type === "error") {
					if (currentTurn.length > 0) {
						turns.push(currentTurn);
					}
					currentTurn = [msg];
				} else {
					currentTurn.push(msg);
				}
			}
			if (currentTurn.length > 0) {
				turns.push(currentTurn);
			}

			// If we have an active streaming block, that streaming block is the "current turn".
			// So from existing completed history, we only keep the 1 latest turn (the previous turn).
			// If not streaming, we keep the last 2 turns (current completed turn + previous completed turn).
			const countToKeep = hasActiveStreaming ? 1 : 2;
			const turnsToKeep = turns.slice(-countToKeep);
			for (const turn of turnsToKeep) {
				for (const msg of turn) {
					condensedAllowedIds.add(msg.id);
				}
			}
		}

		// Collect and build past cycle summaries block
		let cycleSummariesWrapper = null;
		const cycleSummaryMessages = [];
		if (!this.manager.rawViewMode) {
			for (let i = 0; i < history.length; i++) {
				const message = history[i];
				if (message.type === "cycle_summary") {
					cycleSummaryMessages.push({ message, index: i });
				}
			}

			if (cycleSummaryMessages.length > 0) {
				const lastSummaryObj = cycleSummaryMessages[cycleSummaryMessages.length - 1].message;
				const newestTitle = lastSummaryObj.title || (lastSummaryObj.content ? (lastSummaryObj.content.split(/[.\n]/)[0].trim().substring(0, 75) + "...") : "Task Cycle Compacted");
				const olderCount = cycleSummaryMessages.length - 1;
				const groupTitleText = olderCount > 0 ? `${newestTitle} (+${olderCount} older cycle${olderCount > 1 ? 's' : ''})` : newestTitle;

				cycleSummariesWrapper = new Block();
				cycleSummariesWrapper.className = "cycle-summaries-group-block";

				const groupHeader = new Block();
				groupHeader.className = "cycle-summaries-group-header";

				const groupExpandIcon = new Icon();
				groupExpandIcon.className = "cycle-summaries-group-expand-icon";
				groupExpandIcon.textContent = "chevron_right";

				const groupTypeIcon = new Icon();
				groupTypeIcon.className = "cycle-summaries-group-type-icon";
				groupTypeIcon.textContent = "compress";

				const groupTitleSpan = new Inline();
				groupTitleSpan.className = "cycle-summaries-group-title";
				groupTitleSpan.textContent = groupTitleText;

				const groupCountBadge = new Inline();
				groupCountBadge.className = "cycle-summaries-group-badge";
				groupCountBadge.textContent = `${cycleSummaryMessages.length} cycle${cycleSummaryMessages.length > 1 ? 's' : ''}`;

				groupHeader.append(groupExpandIcon, groupTypeIcon, groupTitleSpan, groupCountBadge);

				const groupBody = new Block();
				groupBody.className = "cycle-summaries-group-body";

				for (const { message, index } of cycleSummaryMessages) {
					const summaryElement = this._createMessageElement(message, index, false, viewedSession);
					if (summaryElement) {
						groupBody.append(summaryElement);
					}
				}

				groupHeader.onclick = (e) => {
					e.stopPropagation();
					if (cycleSummariesWrapper.hasAttribute("expanded")) {
						cycleSummariesWrapper.removeAttribute("expanded");
					} else {
						cycleSummariesWrapper.setAttribute("expanded", "");
					}
				};

				cycleSummariesWrapper.append(groupHeader, groupBody);
			}
		}

		// Use the new element factory for each message in the history
		let currentModelTurnContent = null;
		let cycleSummariesAppended = false;

		for (let i = 0; i < history.length; i++) {
			const message = history[i];
			if (message.type === 'file_context') continue;
			if (summarizedIds.has(message.id)) continue;

			if (message.type === 'cycle_summary') {
				if (!this.manager.rawViewMode) {
					if (!cycleSummariesAppended && cycleSummariesWrapper) {
						this.conversationArea.append(cycleSummariesWrapper);
						cycleSummariesAppended = true;
					}
					continue;
				}
			}

			if (this.manager.condensedViewMode && !this.manager.rawViewMode && message.type !== 'cycle_summary' && !condensedAllowedIds.has(message.id)) {
				continue;
			}
			
			const element = this.manager.rawViewMode
				? this._createExpanderMessageElement(message, i)
				: this._createMessageElement(message, i, false, viewedSession); // No isNewMessage for full render

			if (!element) continue;

			if (!this.manager.rawViewMode) {
				if (message.type === "model" || message.type === "error") {
					currentModelTurnContent = element.querySelector(".model-turn-content");
					this.conversationArea.append(element);
				} else if (
					(message.type === "agent_command_output" || 
					 message.type === "agent_command_approval" || 
					 message.type === "tool_response" || 
					 (message.content && message.content.startsWith("[Tool Response:"))) &&
					currentModelTurnContent
				) {
					// Nest the command execution, approval cards, and tool responses inside the model turn that triggered them
					currentModelTurnContent.append(element);
				} else {
					if (message.type === "user") {
						currentModelTurnContent = null; // User prompt resets the turn
					}
					this.conversationArea.append(element);
				}
			} else {
				this.conversationArea.append(element);
			}
		}

		// Re-append the active streaming block if we are currently processing/generating
		if (runningSession && runningSession.responseBlock) {
			this.conversationArea.append(runningSession.responseBlock);
		}

		// Manage default expanded state:
		const modelTurnBlocks = Array.from(this.conversationArea.querySelectorAll(".model-turn-block"));

		modelTurnBlocks.forEach((block, idx) => {
			const isLast = (idx === modelTurnBlocks.length - 1);
			const manuallyExpanded = block.dataset.manuallyExpanded;
			
			if (manuallyExpanded === "true") {
				block.setAttribute("expanded", "");
			} else if (manuallyExpanded === "false") {
				block.removeAttribute("expanded");
			} else {
				// In condensed view:
				// If streaming: active streaming block is expanded, previous turn is collapsed.
				// If idle: only the last turn is kept open if desired, or collapsed.
				if (hasActiveStreaming) {
					if (block.classList.contains("streaming") || isLast) {
						block.setAttribute("expanded", "");
					} else {
						block.removeAttribute("expanded");
					}
				} else {
					if (this.manager.condensedViewMode && !this.manager.rawViewMode) {
						// In condensed mode when idle, previous turns are collapsed
						block.removeAttribute("expanded");
					} else {
						if (isLast) {
							block.setAttribute("expanded", "");
						} else {
							block.removeAttribute("expanded");
						}
					}
				}
			}
		});

		// Render pending queued prompts (scoped to the viewed session, not the active tab)
		if (viewedSession && viewedSession.promptQueue) {
			for (const pendingMsg of viewedSession.promptQueue) {
				const pendingElement = this._createMessageElement({
					id: pendingMsg.id,
					type: "pending",
					content: pendingMsg.content
				}, 0, false, viewedSession);
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
				if (shouldScroll) {
					this.manager.scrollToBottom(true);
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
		if (this.manager.condensedViewMode && !this.manager.rawViewMode && this.manager.isSessionViewed(targetSessionId)) {
			// Trigger a clean re-render to enforce the condensed window (previous turn + new active turn)
			this.render();
		}
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
			
			let rawPendingResponse = null;
			let rawRafId = null;

			const applyRawUpdate = (fullResponse) => {
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

				if (this.manager.isSessionViewed(targetSessionId) && this.manager._shouldAutoScroll() && this.manager.conversationArea) {
					this.manager.conversationArea.scrollTop = this.manager.conversationArea.scrollHeight;
				}
			};

			// Attach dynamic content updater with requestAnimationFrame throttling
			element.updateContent = (fullResponse, immediate = false) => {
				rawPendingResponse = fullResponse;
				if (immediate) {
					if (rawRafId) {
						cancelAnimationFrame(rawRafId);
						rawRafId = null;
					}
					applyRawUpdate(rawPendingResponse);
					return;
				}
				if (!rawRafId) {
					rawRafId = requestAnimationFrame(() => {
						rawRafId = null;
						applyRawUpdate(rawPendingResponse);
					});
				}
			};
			
			element.finalize = (fullResponse, finalizedMessage) => {
				if (rawRafId) {
					cancelAnimationFrame(rawRafId);
					rawRafId = null;
				}
				const running = this.manager.runningSessions.get(targetSessionId);
				if (running) running.responseBlock = null;
				this._localActiveStreamingBlock = null;
				element.updateContent(fullResponse, true);
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
			// If there are existing model turn blocks in the DOM, auto-collapse them unless manually expanded by the user.
			// Only do this when the target session is the one currently being viewed — a background session's
			// new turn must not collapse the active tab's open turn wrappers (the DOM shows the active tab).
			if (this.conversationArea && this.manager.isSessionViewed(targetSessionId)) {
				const existingTurnBlocks = this.conversationArea.querySelectorAll(".model-turn-block");
				existingTurnBlocks.forEach(b => {
					if (!b.dataset.manuallyExpanded) {
						b.removeAttribute("expanded");
					}
				});
			}

			const responseBlock = new Block();
			responseBlock.sessionId = targetSessionId;
			responseBlock.classList.add("response-block", "model-turn-block", "streaming");
			if (type === "error") responseBlock.classList.add("error-block");
			responseBlock.dataset.messageId = messageId;
			responseBlock.setAttribute("expanded", "");
			
			// Header
			const header = new Block();
			header.className = "model-turn-header";

			const expandIcon = new Icon();
			expandIcon.className = "expand-icon";
			expandIcon.textContent = "chevron_right";

			const summarySpan = new Inline();
			summarySpan.className = "model-turn-summary";
			summarySpan.innerHTML = `Generating response...`;

			const tokensSpan = new Inline();
			tokensSpan.className = "turn-tokens-container";

			const replayButton = this._createSingleReplayButton(messageId, true);

			const deleteButton = this._createSingleDeleteButton(messageId);
			deleteButton.classList.add("delete-turn-btn");

			const { wrapper: actionsWrapper, buttons: actionsButtons } = this._createTurnActionsWrapper();
			actionsButtons.append(replayButton, deleteButton);

			header.append(expandIcon, summarySpan, tokensSpan, actionsWrapper);

			// Content Body
			const contentDiv = new Block();
			contentDiv.className = "model-turn-content";

			header.onclick = (e) => {
				if (e.target.closest('.delete-history-button') || e.target.closest('.delete-turn-btn') || e.target.closest('.replay-history-button') || e.target.closest('.replay-turn-btn')) return;
				if (responseBlock.hasAttribute('expanded')) {
					responseBlock.removeAttribute('expanded');
					responseBlock.dataset.manuallyExpanded = "false";
				} else {
					responseBlock.setAttribute('expanded', '');
					responseBlock.dataset.manuallyExpanded = "true";
				}
			};

			responseBlock.append(header, contentDiv);
			responseBlock.finalizedSegmentDivs = [];
			responseBlock.activeSegmentDiv = null;
			
			let pendingFullResponse = null;
			let pendingToolCalls = null;
			let pendingThought = null;
			let pendingIsThinking = false;
			let rafId = null;

			const applyUpdate = (fullResponse, toolCalls = null, thought = null, isThinking = false) => {
				if (fullResponse || thought) {
					const prefillContainer = responseBlock.querySelector('.prefill-progress-container');
					if (prefillContainer) {
						prefillContainer.remove();
					}
				}
				
				const targetSession = this.manager.runningSessions.get(targetSessionId)?.session || this.manager.runningSessions.get(targetSessionId)?.instance?.session || (this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : null);
				const skipXml = this.manager.isKnownReasoningModel(targetSession);
				const liveMsgObj = { 
					id: messageId, 
					toolCalls: toolCalls || [],
					thought: thought || "",
					isThinking: !!isThinking
				};

				// Update live summary
				summarySpan.innerHTML = this.manager.messageRenderer.getModelTurnSummary(fullResponse, liveMsgObj, skipXml, targetSession);
				tokensSpan.innerHTML = this.manager.messageRenderer.getModelTurnTokens(fullResponse, liveMsgObj, targetSession);

				const segments = this.manager.messageRenderer.segmentContent(fullResponse, skipXml);
				
				if (!responseBlock.activeSegmentDiv) {
					responseBlock.activeSegmentDiv = document.createElement("div");
					contentDiv.append(responseBlock.activeSegmentDiv);
				}

				while (segments.length > responseBlock.finalizedSegmentDivs.length + 1) {
					const segmentIndex = responseBlock.finalizedSegmentDivs.length;
					const finalizedText = segments[segmentIndex];
					
					const existingExpander = responseBlock.activeSegmentDiv.querySelector('.tool-call-preview-expander');
					const wasUserClosed = existingExpander && existingExpander.dataset.userToggled === 'true' && !existingExpander.open;

					// Finalized/earlier segments must not render the trailing tool calls of the active message,
					// and only segment 0 should receive the thought block.
					const finalizedMsgObj = { 
						id: messageId, 
						toolCalls: [], 
						thought: segmentIndex === 0 ? (thought || "") : "", 
						isThinking: false 
					};
					this.manager.messageRenderer.renderResponseSegment(responseBlock.activeSegmentDiv, finalizedText, finalizedMsgObj, true, skipXml, targetSession);
					// Attach code block buttons once the segment is closed/finalized
					this.manager.messageRenderer.addCodeBlockButtons(responseBlock.activeSegmentDiv);
					
					if (wasUserClosed) {
						const newExpander = responseBlock.activeSegmentDiv.querySelector('.tool-call-preview-expander');
						if (newExpander) {
							newExpander.removeAttribute('open');
							newExpander.dataset.userToggled = 'true';
						}
					}

					responseBlock.finalizedSegmentDivs.push(responseBlock.activeSegmentDiv);
					
					responseBlock.activeSegmentDiv = document.createElement("div");
					contentDiv.append(responseBlock.activeSegmentDiv);
				}
				
				const activeText = segments[segments.length - 1];
				const existingExpander = responseBlock.activeSegmentDiv.querySelector('.tool-call-preview-expander');
				const wasUserClosed = existingExpander && existingExpander.dataset.userToggled === 'true' && !existingExpander.open;

				// Trailing active segment only hosts the thought block if it is the first/only segment
				const activeMsgObj = responseBlock.finalizedSegmentDivs.length === 0
					? liveMsgObj
					: { ...liveMsgObj, thought: "", isThinking: false };

				this.manager.messageRenderer.renderResponseSegment(responseBlock.activeSegmentDiv, activeText, activeMsgObj, true, skipXml, targetSession);
				// NOTE: Action buttons are delayed until this block is closed by new segments or generation finishes

				if (wasUserClosed) {
					const newExpander = responseBlock.activeSegmentDiv.querySelector('.tool-call-preview-expander');
					if (newExpander) {
						newExpander.removeAttribute('open');
						newExpander.dataset.userToggled = 'true';
					}
				}

				if (this.manager.isSessionViewed(targetSessionId) && this.manager._shouldAutoScroll() && this.manager.conversationArea) {
					this.manager.scrollToBottom(true);
				}
			};

			responseBlock.updateContent = (fullResponse, immediate = false, toolCalls = null, thought = null, isThinking = false) => {
				pendingFullResponse = fullResponse;
				if (toolCalls !== null) pendingToolCalls = toolCalls;
				if (thought !== null) pendingThought = thought;
				pendingIsThinking = !!isThinking;
				if (immediate) {
					if (rafId) {
						cancelAnimationFrame(rafId);
						rafId = null;
					}
					applyUpdate(pendingFullResponse, pendingToolCalls, pendingThought, pendingIsThinking);
					return;
				}
				if (!rafId) {
					rafId = requestAnimationFrame(() => {
						rafId = null;
						applyUpdate(pendingFullResponse, pendingToolCalls, pendingThought, pendingIsThinking);
					});
				}
			};
			
			responseBlock.finalize = (fullResponse, finalizedMessage) => {
				if (rafId) {
					cancelAnimationFrame(rafId);
					rafId = null;
				}
				const running = this.manager.runningSessions.get(targetSessionId);
				if (running) running.responseBlock = null;
				this._localActiveStreamingBlock = null;
				
				const targetSession = this.manager.runningSessions.get(targetSessionId)?.session || this.manager.runningSessions.get(targetSessionId)?.instance?.session || (this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : null);
				const skipXml = this.manager.isKnownReasoningModel(targetSession);

				responseBlock.classList.remove("streaming");
				summarySpan.innerHTML = this.manager.messageRenderer.getModelTurnSummary(fullResponse, finalizedMessage, skipXml, targetSession);
				contentDiv.innerHTML = this.manager.messageRenderer.renderResponseContent(fullResponse, finalizedMessage, true, skipXml, targetSession);
				// Attach code block buttons to the complete finalized message
				this.manager.messageRenderer.addCodeBlockButtons(contentDiv, finalizedMessage, targetSession);

				const tokenCount = typeof finalizedMessage.tokenCount === 'number' ? finalizedMessage.tokenCount : this.ai.estimateTokens([finalizedMessage]);
				responseBlock.setAttribute("title", `Tokens: ${tokenCount}`);
				tokensSpan.innerHTML = this.manager.messageRenderer.getModelTurnTokens(fullResponse, finalizedMessage, targetSession);

				// Asynchronously tokenize the finalized message and update counts
				this.tokenizeMessage(finalizedMessage, this.manager.runningSessions.get(targetSessionId)?.instance?.session || (this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : null)).catch(err => {
					console.warn("[HistoryManager] Async turn tokenization error:", err);
				});

				if (this.manager.condensedViewMode && !this.manager.rawViewMode && this.manager.isSessionViewed(targetSessionId)) {
					this.render();
				}
			};

			const runningBlock = this.manager.runningSessions.get(targetSessionId);
			if (runningBlock) runningBlock.responseBlock = responseBlock;
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
	_createMessageElement(message, index, isNew = false, session = null) {
		if (!message.id) {
			message.id = crypto.randomUUID();
		}

		// Source session this message belongs to (not necessarily the active tab).
		const targetSession = session || this.manager.activeSession;

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
					const firstUserMsg = subSession.messages?.find(m => m.role === "user" || m.type === "user");
					const objectiveText = firstUserMsg?.content ? (firstUserMsg.content.length > 60 ? firstUserMsg.content.slice(0, 60) + "…" : firstUserMsg.content) : "Sub-agent task";
					desc.textContent = subSession.systemPromptOverride ? 
						(subSession.systemPromptOverride.match(/"([^"]+)"/)?.[1] || objectiveText) : 
						objectiveText;

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

			const { wrapper: actionsWrapper, buttons: actionsButtons } = this._createTurnActionsWrapper();

			actionsButtons.append(this._createSingleEditButton(message.id));
			actionsButtons.append(this._createSingleReplayButton(message.id));
			actionsButtons.append(this._createSingleCompactButton(message.id));
			actionsButtons.append(this._createSingleDeleteButton(message.id));
			
			wrapper.append(actionsWrapper);
			element = wrapper;

		} else if (message.type === "model" || message.type === "error") {
			element = new Block();
			element.classList.add("response-block", "model-turn-block");
			if (message.type === "error") element.classList.add("error-block");
			element.dataset.messageId = message.id;
			element.setAttribute("title", `Tokens: ${tokenCount}`);

			// Expander Header
			const header = new Block();
			header.className = "model-turn-header";

			const expandIcon = new Icon();
			expandIcon.className = "expand-icon";
			expandIcon.textContent = "chevron_right";

			const summarySpan = new Inline();
			summarySpan.className = "model-turn-summary";
			summarySpan.innerHTML = message.type === "error" ? `Error: ${this._escapeHtml(message.content || "")}` : this.manager.messageRenderer.getModelTurnSummary(message.content, message, null, targetSession);

			const tokensSpan = new Inline();
			tokensSpan.className = "turn-tokens-container";
			tokensSpan.innerHTML = message.type === "error" ? "" : this.manager.messageRenderer.getModelTurnTokens(message.content, message, targetSession);

			const replayButton = this._createSingleReplayButton(message.id, true);

			const deleteButton = this._createSingleDeleteButton(message.id);
			deleteButton.classList.add("delete-turn-btn");

			const { wrapper: actionsWrapper, buttons: actionsButtons } = this._createTurnActionsWrapper();
			actionsButtons.append(this._createSingleCompactButton(message.id), replayButton, deleteButton);

			header.append(expandIcon, summarySpan, tokensSpan, actionsWrapper);

			// Content Body
			const contentDiv = new Block();
			contentDiv.className = "model-turn-content";
			const skipXml = this.manager.isKnownReasoningModel(targetSession);
			contentDiv.innerHTML = this.manager.messageRenderer.renderResponseContent(message.content, message, isNew, skipXml, targetSession);

			header.onclick = (e) => {
				if (e.target.closest('.delete-history-button') || e.target.closest('.delete-turn-btn') || e.target.closest('.replay-history-button') || e.target.closest('.replay-turn-btn')) return;
				if (element.hasAttribute('expanded')) {
					element.removeAttribute('expanded');
					element.dataset.manuallyExpanded = "false";
				} else {
					element.setAttribute('expanded', '');
					element.dataset.manuallyExpanded = "true";
				}
			};

			element.append(header, contentDiv);
			
			if (message.type === "model") {
				this.manager.messageRenderer.addCodeBlockButtons(contentDiv, message, targetSession);

				// Add manual cycle summarization trigger button if this model message called "done" and isn't summarized yet
				if (message.toolCalls?.some(tc => (tc.functionCall?.name || tc.name) === "done")) {
					const allMsgs = this.chatHistory;
					const msgIdx = allMsgs.findIndex(m => m.id === message.id);
					if (msgIdx !== -1) {
						const nextMsg = allMsgs[msgIdx + 1];
						const isDoneResponse = nextMsg && this._toolResponseHasDone(nextMsg); // Atom-aware: a done-confirmation may be one of several joined tool responses, so split on the separator and prefix-match each atom (avoids false-positives on the phrase appearing mid-content).
						if (isDoneResponse) {
										const hasSummary = this.hasCycleSummaryCovering(allMsgs, msgIdx) || this.hasCycleSummaryCovering(allMsgs, msgIdx + 1); // Phase 1.5 — span-coverage instead of adjacency (head-anchored summaries aren't adjacent to the done block).
							if (!hasSummary) {
								const summarizeBtn = new Button("Compact Cycle");
								summarizeBtn.className = "summarize-cycle-trigger-btn theme-button primary";
								summarizeBtn.icon = "compress";
								
								summarizeBtn.onclick = async (e) => {
									e.stopPropagation();
									summarizeBtn.disabled = true;
									summarizeBtn.text = "Compacting...";
									
									try {
										// Capture STABLE ids up-front: the boundary (this done block) and the span's end
										// (the trailing tool_response). The cascade below inserts summaries BEFORE this
										// cycle, which shifts raw indices — so everything after it re-locates by id.
										const boundaryMsgId = allMsgs[msgIdx].id;
										const endMsgId = nextMsg.id;
										const activeSession = this.manager.activeSession;

										// Phase 1.3 — Cascade: compact ALL earlier unsummarized cycles (newest-first) BEFORE
										// the clicked cycle, so the user manually compacting a later cycle while earlier
										// ones are still raw keeps the spans contiguous and chronologically ordered.
										// Best-effort (never fails the target compaction) and render: false — the target
										// compaction below does the single final render.
										try {
											await this.compactEarlierCyclesUpTo(activeSession, endMsgId, { render: false });
										} catch (cascErr) {
											console.error("Error during manual cascade compaction of earlier cycles:", cascErr); // Best-effort — continue to the target.
										}

										// Re-locate the target boundary by its STABLE id against the CURRENT array (the
										// cascade's insertions shifted raw indices), then re-derive its span.
										const curBoundaryIdx = allMsgs.findIndex(m => m.id === boundaryMsgId);
										if (curBoundaryIdx === -1) throw new Error("Target boundary no longer present");
										const targetSpan = this._findCycleSpanForEnd(allMsgs, curBoundaryIdx);
										if (!targetSpan || targetSpan.cycleStartIdx === -1 || targetSpan.cycleStartIdx >= targetSpan.endIdx) return; // Span too small — nothing to compact.

										const cycleStartIdx = targetSpan.cycleStartIdx;
										const cycleEndIdx = targetSpan.endIdx;
										if (cycleStartIdx < cycleEndIdx) { // Span too small (<2 messages) to summarize meaningfully.
											const cycleMsgs = allMsgs.slice(cycleStartIdx, cycleEndIdx + 1);
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
													cycleEndMsgId: allMsgs[cycleEndIdx].id
												};
												activeSession.messages.splice(cycleStartIdx, 0, summaryMessage); // Phase 1.1 â HEAD-anchor the summary at the span's start so cycles stay contiguous (this cycle's raw span follows the summary; the next cycle starts after it).
												activeSession.lastModified = Date.now();
												await workspaceClient.setSession(activeSession.id, activeSession);
												// Best-effort: archive the raw span out of the main record into the archive.
												await this._archiveCycleSpan(activeSession, summaryMessage);
												this.render();
											}
										}
									} catch (err) {
										console.error("Failed to generate summary manually:", err);
										summarizeBtn.disabled = false;
										summarizeBtn.text = "Compact Cycle";
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
									contentDiv.append(summarizeBtn);
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
			// Content-only seeds (isSeed) are transient in-flight placeholders ("Compacting cycle…")
			// that get replaced in-place by the real summary when the background compaction completes.
			// They must NOT render as a visible block — they have no real summary content, and a
			// dangling seed (compaction failed / never ran) would render as an empty "Task Cycle
			// Compacted" placeholder (the exact corruption seen in the sub-agent view). Return null
			// so the caller's `if (!element) continue` skips it. The span it anchored is NOT collapsed
			// (the hide-loops skip seeds), so the live turns it covered remain visible.
			if (!message.isSeed) {
			const targetSessionId = message.subSessionId || this.manager.activeSessionId;
			element = new Block();
			element.classList.add("cycle-summary-block");
			element.dataset.messageId = message.id;
			element.setAttribute("title", `Tokens: ${tokenCount}`);
			
			const summaryTitleText = message.title || (message.content ? (message.content.split(/[.\n]/)[0].trim().substring(0, 75) + "...") : "Task Cycle Compacted");
			
			const header = new Block();
			header.className = "cycle-summary-header";
			
			const expandIcon = new Icon();
			expandIcon.className = "cycle-expand-icon";
			expandIcon.textContent = "chevron_right";
			
			const compressIcon = new Icon();
			compressIcon.className = "cycle-type-icon";
			compressIcon.textContent = "compress";
			
			const titleSpan = new Inline();
			titleSpan.className = "cycle-summary-title";
			titleSpan.textContent = summaryTitleText;

			const actionsContainer = new Block();
			actionsContainer.className = "cycle-summary-actions";

			const editBtn = new Icon();
			editBtn.className = "cycle-summary-action-btn";
			editBtn.textContent = "edit";
			editBtn.title = "Edit Title and Summary";
			editBtn.onclick = async (e) => {
				e.stopPropagation();
				const currentTitle = message.title || summaryTitleText;
				
				const newTitle = await window.modal.prompt("Edit Cycle Title (max 10 words):", "Edit Cycle Title", currentTitle);
				if (newTitle === null) return;
				
				let finalTitle = newTitle.trim();
				const words = finalTitle.split(/\s+/).filter(Boolean);
				if (words.length > 10) {
					finalTitle = words.slice(0, 10).join(" ") + "...";
				}
				
				message.title = finalTitle;
				message.lastModified = Date.now();
				
				const activeSession = this.manager.runningSessions.get(targetSessionId)?.instance?.session ||
				                      (this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : await workspaceClient.getSession(targetSessionId));
				if (activeSession) {
					const msgInSession = activeSession.messages.find(m => m.id === message.id);
					if (msgInSession) {
						msgInSession.title = finalTitle;
						activeSession.lastModified = Date.now();
						await workspaceClient.setSession(targetSessionId, activeSession);
					}
				}
				this.render();
			};

			const regenBtn = new Icon();
			regenBtn.className = "cycle-summary-action-btn";
			regenBtn.textContent = "refresh";
			regenBtn.title = "Regenerate Summary";
			regenBtn.onclick = async (e) => {
				e.stopPropagation();
				const startId = message.cycleStartMsgId;
				const endId = message.cycleEndMsgId;

				const originalTitleHtml = titleSpan.innerHTML;
				titleSpan.innerHTML = `<ui-icon class="spin" style="font-size: 14px; vertical-align: middle; margin-right: 4px;">cached</ui-icon> <em>Regenerating summary...</em>`;
				regenBtn.classList.add("spin");
				try {
					// Span may live in the main record (unarchived / legacy) or in the per-session archive — the resolver handles both.
					const cycleMsgs = await this._resolveCycleSpanMessages(targetSessionId, startId, endId, message.id);
					if (!cycleMsgs || cycleMsgs.length === 0) {
						window.modal.notice("Cannot regenerate summary: original cycle messages are no longer available.", "Regenerate Summary");
						titleSpan.innerHTML = originalTitleHtml;
						return;
					}
					const result = await this.manager.generateCycleSummary(cycleMsgs);
					if (result && (result.title || result.summary)) {
						message.title = result.title;
						message.content = result.summary;
						message.lastModified = Date.now();
						
						const activeSession = this.manager.runningSessions.get(targetSessionId)?.instance?.session ||
						                      (this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : await workspaceClient.getSession(targetSessionId));
						if (activeSession) {
							const msgInSession = activeSession.messages.find(m => m.id === message.id);
							if (msgInSession) {
								msgInSession.title = result.title;
								msgInSession.content = result.summary;
								activeSession.lastModified = Date.now();
								await workspaceClient.setSession(targetSessionId, activeSession);
							}
						}
						window.modal.toast("Cycle summary regenerated.");
						this.render();
					} else {
						titleSpan.innerHTML = originalTitleHtml;
					}
				} catch (err) {
					console.error("Failed to regenerate cycle summary:", err);
					titleSpan.innerHTML = originalTitleHtml;
					window.modal.notice(`Failed to regenerate summary: ${err.message}`, "Error");
				} finally {
					regenBtn.classList.remove("spin");
				}
			};

			actionsContainer.append(editBtn, regenBtn);
			header.append(expandIcon, compressIcon, titleSpan, actionsContainer);
			
			const bodyContainer = new Block();
			bodyContainer.className = "cycle-summary-body";

			const contentDiv = new Block();
			contentDiv.className = "cycle-summary-content";
			contentDiv.innerHTML = this.md.render(message.content);

			const detailsExpander = new Block();
			detailsExpander.className = "cycle-details-expander";

			const detailsHeader = new Block();
			detailsHeader.className = "cycle-details-header";
			const detailsCaret = new Icon();
			detailsCaret.className = "cycle-details-caret";
			detailsCaret.textContent = "chevron_right";
			const detailsLabel = new Inline();
			detailsLabel.className = "cycle-details-label";
			detailsLabel.textContent = "Detailed Conversation History";
			detailsHeader.append(detailsCaret, detailsLabel);

			const detailContainer = new Block();
			detailContainer.className = "cycle-summary-detail-container";
			
				detailsHeader.onclick = async (e) => {
					e.stopPropagation();
					const isExpanded = detailsExpander.hasAttribute("expanded");
					if (isExpanded) {
						detailsExpander.removeAttribute("expanded");
					} else {
						detailsExpander.setAttribute("expanded", "");
							if (detailContainer.children.length === 0) {
								// Span may live in the main record (unarchived / legacy) or in the per-session archive â the resolver handles both.
								const cycleMsgs = await this._resolveCycleSpanMessages(targetSessionId, message.cycleStartMsgId, message.cycleEndMsgId, message.id);
								if (cycleMsgs && cycleMsgs.length) {
									for (const cMsg of cycleMsgs) {
										if (cMsg.type === 'file_context' || cMsg.type === 'cycle_summary') continue;
										const cEl = this._createMessageElement(cMsg, -1);
										if (!cEl) continue;
										const nestedDelete = cEl.querySelector(".delete-history-button");
										if (nestedDelete) nestedDelete.remove();
										const nestedReplay = cEl.querySelector(".replay-history-button");
										if (nestedReplay) nestedReplay.remove();
										const nestedEdit = cEl.querySelector(".edit-history-button");
										if (nestedEdit) nestedEdit.remove();
										detailContainer.append(cEl);
								}
							} else {
								const emptyDetail = new Block();
								emptyDetail.className = "cycle-summary-empty-detail";
								emptyDetail.textContent = "Detailed history for this cycle is not available (it may have been pruned or deleted from the conversation).";
								detailContainer.append(emptyDetail);
							}
						}
					}
				};

			detailsExpander.append(detailsHeader, detailContainer);
			bodyContainer.append(contentDiv, detailsExpander);

			header.onclick = () => {
				if (element.hasAttribute("expanded")) {
					element.removeAttribute("expanded");
				} else {
					element.setAttribute("expanded", "");
				}
			};

			element.append(header, bodyContainer);
			} // end if (!message.isSeed)
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

					// Force re-enable autoscroll when submitting query response
					this.manager._autoscrollEnabled = true;
					this.manager._hideAutoscrollChip();
					if (this.manager.activeSession) {
						this.manager.activeSession.autoscrollEnabled = true;
					}
					if (this.manager.activeSubAgentSession) {
						this.manager.activeSubAgentSession.autoscrollEnabled = true;
					}

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
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submitAnswer();
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
		} else if (message.type === "agent_command_approval") {
			if (message.status === "approved") {
				// Approved command cards are hidden since the execution output block carries the command
				return null;
			}

			element = new Block();
			element.classList.add("response-block", "agent-command-approval-block");
			element.dataset.messageId = message.id;

			const header = new Block();
			header.className = "agent-query-header";
			const icon = new Icon();
			icon.textContent = "terminal";
			const title = new Inline();
			title.className = "agent-query-title";
			title.textContent = "Terminal Command Approval Request";
			header.append(icon, title);

			const cmdBox = new Block();
			cmdBox.className = "agent-cmd-box";
			cmdBox.innerHTML = `<code>$ ${this._escapeHtml(message.command)}</code>`;

			element.append(header, cmdBox);

			if (message.status === "pending") {
				const targetSessionId = message.subSessionId || this.manager.activeSessionId;

				// Re-parse (lean storage: the message only carries the command string).
				const parsed = parseCommandLine(message.command);
				const programs = parsed.programs || [];

				// JIT purge: a newer approval request supersedes any *older* pending
				// approval cards in the same session — they become inert status tags.
				// (Only earlier messages are superseded; a still-pending card that
				// appears later in history is the one that supersedes this one.)
				const owningSession = this._getOwningSessionForMessage(message);
				if (owningSession && Array.isArray(owningSession.messages)) {
					const idx = owningSession.messages.indexOf(message);
					let supersededAny = false;
					for (let i = 0; i < idx; i++) {
						const m = owningSession.messages[i];
						if (m.type === "agent_command_approval" && m.status === "pending") {
							m.status = "superseded";
							supersededAny = true;
						}
					}
					if (supersededAny) {
						owningSession.lastModified = Date.now();
						void workspaceClient.setSession(targetSessionId, owningSession);
					}
				}

				if (programs.length === 0) {
					// Fallback: the command could not be parsed into programs —
					// keep the legacy single Approve/Deny card.
					this._buildLegacyApprovalActions(element, message, targetSessionId);
				} else {
					this._buildPerSegmentApprovalCard(element, message, targetSessionId, parsed);
					// The tokenized snippet inside the approval card replaces the
					// plain command box — hide it (kept in the DOM for a11y).
					cmdBox.classList.add("agent-cmd-box-hidden");
				}
			} else {
				const statusTag = new Block();
				statusTag.className = `agent-query-answer answered ${message.status}`;
				statusTag.textContent = message.status === "approved" ? "✓ Approved by user"
					: message.status === "superseded" ? "⊘ Superseded by a newer approval request"
					: "✗ Denied by user";
				element.append(statusTag);
			}
		} else if (message.type === "agent_command_output") {
			element = new Block();
			element.classList.add("response-block", "agent-cmd-output-block");
			element.dataset.messageId = message.id;

			const statusText = message.status === "running" ? "Running..." : (message.status === "completed" ? "Completed" : "Failed");
			const details = document.createElement("details");
			details.open = true;

			const summary = document.createElement("summary");
			summary.innerHTML = `<ui-icon style="font-size: 14px; vertical-align: middle;">terminal</ui-icon> <code>$ ${this._escapeHtml(message.command)}</code> <span style="opacity: 0.8; font-weight: normal; margin-left: auto;">[${statusText}]</span>`;

			const pre = document.createElement("pre");
			pre.style.maxHeight = "300px";
			pre.style.overflowY = "auto";
			pre.style.padding = "8px";
			pre.style.margin = "4px 0 0 0";
			pre.style.background = "#1e1e1e";
			pre.style.color = "#d4d4d4";
			pre.style.borderRadius = "4px";
			
			const code = document.createElement("code");
			code.textContent = message.output || "(Waiting for output...)";
			pre.append(code);

			details.append(summary, pre);
			element.append(details);
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

		if (tokenCount >= 3000) {
			expanderBlock.classList.add("size-red");
		} else if (tokenCount >= 2000) {
			expanderBlock.classList.add("size-orange");
		} else if (tokenCount >= 1000) {
			expanderBlock.classList.add("size-yellow");
		}

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

	// ---------------------------------------------------------------------
	// Terminal command approval — per-segment (program-level) policy UI
	// ---------------------------------------------------------------------

	/**
	 * Returns the in-memory session whose messages array contains the given
	 * approval message (sub-session if it carries a subSessionId, else the
	 * active session). Returns null if the session is not currently in memory.
	 */
	_getOwningSessionForMessage(message) {
		const targetSessionId = message.subSessionId || this.manager.activeSessionId;
		const running = this.manager.runningSessions.get(targetSessionId);
		if (running && running.instance?.session) return running.instance.session;
		if (this.manager.activeSessionId === targetSessionId) return this.manager.activeSession;
		return null;
	}

	/**
	 * Resolves the session object for a given session id (running sub-session,
	 * the active session, or fetched from the workspace).
	 */
	async _resolveApprovalSession(targetSessionId) {
		return this.manager.runningSessions.get(targetSessionId)?.instance?.session ||
			(this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : await workspaceClient.getSession(targetSessionId));
	}

	/**
	 * Normalizes a session's commandPolicy to the canonical { allow, block }
	 * shape (tolerating the legacy { whitelist, blacklist } shape).
	 */
	_normalizeSessionPolicy(session) {
		const p = session?.commandPolicy || {};
		const allow = Array.isArray(p.allow) ? p.allow : (Array.isArray(p.whitelist) ? p.whitelist : []);
		const block = Array.isArray(p.block) ? p.block : (Array.isArray(p.blacklist) ? p.blacklist : []);
		session.commandPolicy = { allow, block };
		return session.commandPolicy;
	}

		/**
		 * Adds a program-level rule to a policy list, deduping by program name.
		 * If `subs` (a first-arg string or an array of first-args) is provided
		 * and no rule exists yet, the new rule carries a subs filter so only
		 * those subcommands are matched (e.g. allow `git status`).
		 *
		 * Never narrows an existing rule:
		 * - Broad (subs-less) rule already present: it already covers this
		 *   subcommand, so the choice is a no-op. Adding a subs filter here
		 *   would make the policy MORE restrictive (e.g. approving `git
		 *   status` "always" when `git` is broadly allowed would stop `git
		 *   reset` from auto-approving).
		 * - Sub-filtered rule already present: the new sub is ADDED to its
		 *   list (union) so approving a new subcommand extends the filter
		 *   rather than replacing or dropping it.
		 */
		_pushProgramRule(list, program, subs) {
			// `subs` may be a single first-arg string or an array of first-args
			// (one "add <sub>" checkbox per distinct subcommand on the approval
			// card). Normalize to a deduped lowercase array, or null when no
			// sub context was provided.
			let subsArr = null;
			if (typeof subs === "string" && subs.trim()) subsArr = [subs.trim().toLowerCase()];
			else if (Array.isArray(subs)) {
				subsArr = [...new Set(subs.map(s => String(s).trim().toLowerCase()).filter(Boolean))];
				if (subsArr.length === 0) subsArr = null;
			}
			const existing = list.find(r => (r && typeof r === "object" && r.program ? r.program === program : r === program));
			if (existing && typeof existing === "object" && existing.program) {
				if (Array.isArray(existing.subs) && existing.subs.length > 0 && subsArr) {
					// Sub-filtered rule: extend (union) with the new subs.
					const toAdd = subsArr.filter(s => !existing.subs.includes(s));
					if (toAdd.length > 0) {
						existing.subs = [...existing.subs, ...toAdd].sort((a, b) => a.localeCompare(b));
					}
				}
				// Broad rule (or no new sub context): already covers this
				// subcommand -> no-op. Never narrow a broad rule to a subs rule.
				return;
			}
			const rule = { program };
			if (subsArr) rule.subs = subsArr;
			list.push(rule);
		}

	/**
	 * Determines the preloaded policy selector value for a program based on the
	 * merged master + session policies.
	 */
	_initialPolicyValue(program, master, session) {
		const inList = (list, name) => (list || []).some(r =>
			(typeof r === "string" ? r === name : r && typeof r === "object" && r.program === name));
		const m = normalizePolicy(master);
		const s = normalizePolicy(session);
		if (inList(s.block, program)) return "block_session";
		if (inList(m.block, program)) return "block_always";
		if (inList(s.allow, program)) return "allow_session";
		if (inList(m.allow, program)) return "allow_always";
		return "allow_once";
	}

	/**
	 * Builds the legacy single Approve/Deny card, used as a fallback when a
	 * command cannot be parsed into programs.
	 */
	_buildLegacyApprovalActions(element, message, targetSessionId) {
		const actions = new Block();
		actions.className = "agent-cmd-actions";
		actions.style.display = "flex";
		actions.style.flexDirection = "column";
		actions.style.gap = "8px";
		actions.style.marginTop = "8px";

		const noteInput = document.createElement("input");
		noteInput.type = "text";
		noteInput.placeholder = "Optional feedback or reason for refusal...";
		noteInput.className = "agent-query-input";
		noteInput.style.width = "100%";

		const btnRow = new Block();
		btnRow.style.display = "flex";
		btnRow.style.gap = "8px";
		btnRow.style.justifyContent = "flex-end";

		const denyBtn = new Button("Deny");
		denyBtn.className = "theme-button danger";
		denyBtn.onclick = async () => {
			actions.style.display = "none";
			message.status = "rejected";

			const activeSession = await this._resolveApprovalSession(targetSessionId);
			if (activeSession) {
				delete activeSession.pendingQueryId;
				activeSession.messages.push({
					id: crypto.randomUUID(),
					role: "user",
					type: "tool_response",
					content: `[Tool Response: run_command]\n\nCommand execution rejected by user.`,
					timestamp: Date.now()
				});
				activeSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSessionId, activeSession);
			}

			this.render();
			this.manager.setSessionProcessing(targetSessionId, true, 'agent', null);
			this.manager._updateTabStatus(targetSessionId, "running");
			const agent = new Agent(this.manager, activeSession, this.manager.ai);
			await agent.run(null, null);
		};

		const approveBtn = new Button("Approve");
		approveBtn.className = "theme-button primary";
		approveBtn.onclick = async () => {
			actions.style.display = "none";

			const activeSession = await this._resolveApprovalSession(targetSessionId);
			if (activeSession) {
				delete activeSession.pendingQueryId;
				activeSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSessionId, activeSession);
			}

			// Defense-in-depth: honor persisted block rules even on the legacy
			// card (a legacy { command } block rule can match an unparseable
			// command). Refuse to execute if the merged policy blocks it.
			const merged = mergePolicies(this.manager.config?.commandPolicy || { allow: [], block: [] }, activeSession ? this._normalizeSessionPolicy(activeSession) : null);
			const policyBlocked = evaluateCommand(message.command, merged).decision === "blocked";
			message.status = policyBlocked ? "rejected" : "approved";

			this.render();
			this.manager.setSessionProcessing(targetSessionId, true, 'agent', null);
			this.manager._updateTabStatus(targetSessionId, "running");

			const responseText = policyBlocked
				? `Command execution rejected by workspace security policy (a persisted block rule applies) for command: ${message.command}`
				: await agentTools.executeTerminalCommand(message.command, message.cwd, targetSessionId);

			if (activeSession) {
				activeSession.messages.push({
					id: crypto.randomUUID(),
					role: "user",
					type: "tool_response",
					content: `[Tool Response: run_command]\n\n${responseText}`,
					timestamp: Date.now()
				});
				activeSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSessionId, activeSession);
			}

			this.render();
			const agent = new Agent(this.manager, activeSession, this.manager.ai);
			await agent.run(null, null);
		};

		btnRow.append(denyBtn, approveBtn);
		actions.append(noteInput, btnRow);
		element.append(actions);
	}

	/**
	 * Renders a command line with its programs and subcommands (first-args)
	 * highlighted, using `annotateCommand` for precise character offsets.
	 * Returns a <Block> with a <code> snippet. Falls back to a plain escaped
	 * string if annotation yields no spans.
	 *
	 * `subTokens` (optional) maps subcommand (first-arg) text for which a
	 * "only <sub>" checkbox is rendered in the approval card. Matching
	 * subcommand tokens are tagged with `data-subtoken` so the checkbox's
	 * hover/focus (see `_bindSubtokenHover`) can highlight the exact token
	 * (`.agent-cmd-sub-hl` in ai-chat.css).
	 */
	_buildAnnotatedSnippet(command, subTokens = null) {
		const box = new Block();
		box.className = "agent-cmd-annotated";

		const code = document.createElement("code");
		code.className = "agent-cmd-annotated-code";

		let html = "";
		try {
			const { command: cmd, spans } = annotateCommand(command);
			if (spans.length === 0) {
				code.textContent = cmd;
			} else {
				let cursor = 0;
				for (const s of spans) {
					if (s.start > cursor) html += this._escapeHtml(cmd.slice(cursor, s.start));
					const cls = s.kind === "program" ? "cmd-hl-program" : "cmd-hl-subcommand";
					const label = s.kind === "program" ? "Program" : "Subcommand";
					const dataAttr = (s.kind === "subcommand" && subTokens && subTokens.has(s.name))
						? ` data-subtoken="${this._escapeHtml(s.name)}"` : "";
					html += `<span class="cmd-hl ${cls}" title="${label}: ${this._escapeHtml(s.name)}"${dataAttr}>${this._escapeHtml(cmd.slice(s.start, s.end))}</span>`;
					cursor = s.end;
				}
				if (cursor < cmd.length) html += this._escapeHtml(cmd.slice(cursor));
				code.innerHTML = html;
			}
		} catch {
			code.textContent = String(command || "");
		}

		box.append(code);
		return box;
	}

	/**
	 * Binds a "only <sub>" checkbox to its subcommand token in the tokenized
	 * snippet: hovering (or keyboard-focusing) the checkbox highlights the
	 * matching token with full colour and bold (`.agent-cmd-sub-hl`), and
	 * unbinds it on leave/blur. CSS alone can't match arbitrary attribute
	 * values across elements, so the binding is done here. `scope` limits the
	 * lookup to this card so multiple approval cards don't cross-highlight.
	 */
	_bindSubtokenHover(scope, flagLabel, sub) {
		const token = () => scope.querySelector(
			`code.agent-cmd-annotated-code span[data-subtoken="${CSS.escape(sub)}"]`);
		const highlight = () => {
			const t = token();
			if (t) t.classList.add("agent-cmd-sub-hl");
		};
		const unhighlight = () => {
			const t = token();
			if (t) t.classList.remove("agent-cmd-sub-hl");
		};
		flagLabel.addEventListener("mouseenter", highlight);
		flagLabel.addEventListener("mouseleave", unhighlight);
		// Keyboard accessibility: the checkbox is focusable, so focus/blur
		// mirror the hover behaviour.
		flagLabel.addEventListener("focusin", highlight);
		flagLabel.addEventListener("focusout", unhighlight);
	}

	/**
	 * Builds the per-segment approval card: one row per detected program with a
	 * risk chip and a policy selector, plus a single Ok button.
	 */
	_buildPerSegmentApprovalCard(element, message, targetSessionId, parsed) {
		const session = this.manager.runningSessions.get(targetSessionId)?.instance?.session ||
			(this.manager.activeSessionId === targetSessionId ? this.manager.activeSession : null);
		const sessionPolicy = session ? this._normalizeSessionPolicy(session) : { allow: [], block: [] };
		const masterPolicy = this.manager.config?.commandPolicy || { allow: [], block: [] };
		const mergedPolicy = mergePolicies(masterPolicy, sessionPolicy);

		const card = new Block();
		card.className = "agent-cmd-program-list";
		card.style.display = "flex";
		card.style.flexDirection = "column";
		card.style.gap = "6px";

		// Distinct first-args (subcommands) observed per program, in first-
		// seen order. Each one not already covered by a policy allow rule
		// gets its own "add <sub>" checkbox on the program row.
		const subArgsByProgram = new Map();
		for (const program of parsed.programs) {
			const args = [];
			const seen = new Set();
			for (const s of parsed.segments) {
				if (s.program !== program || !s.args || s.args.length === 0) continue;
				const a = s.args[0];
				if (!seen.has(a)) { seen.add(a); args.push(a); }
			}
			subArgsByProgram.set(program, args);
		}
		// Tokenized command snippet: programs and subcommands are highlighted
		// (subdued by default; see ai-chat.css) so the user can see exactly
		// what will run before deciding. The subcommand tokens that will get
		// an "add <sub>" checkbox are tagged (data-subtoken) so hovering the
		// checkbox restores the exact token to full colour + bold.
		const subTokens = new Map();
		for (const [program, args] of subArgsByProgram) {
			for (const a of args) subTokens.set(a, program);
		}
		card.append(this._buildAnnotatedSnippet(message.command, subTokens));

		const selectOptions = [
			["allow_once", "Allow Once"],
			["allow_session", "Allow this session"],
			["allow_always", "Allow always"],
			["block_once", "Block once"],
			["block_session", "Block this session"],
			["block_always", "Block always"]
		];

		const selectorRefs = new Map();
		// Per-program "add <sub>" checkbox refs: one per distinct first-arg
		// not already in the policy's allow list (checked = include that sub
		// in the rule; only honored for new programs).
		const subFlagRefs = new Map();
		for (const program of parsed.programs) {
			const row = new Block();
			row.className = "agent-cmd-program-row";

			// Top-level segments carry their own risk; recursively-extracted
			// programs (find -exec, xargs, sh -c, $()) have no segment of their
			// own, so classify them directly (unknown → high risk).
			const seg = parsed.segments.find(s => s.program === program);
			const { category: risk, reason } = seg ? { category: seg.risk, reason: seg.riskReason } : classifyProgram(program);
			// Traffic-light dot: color signals the risk, the (text) reason is
			// surfaced via the program name's title attribute. Uses Block (not
			// Inline) because the dot carries no content: the global
			// `ui-inline:empty { display: none }` rule would hide an empty
			// inline element and its 10x10 box would never render.
			const dot = new Block();
			dot.className = `agent-cmd-risk-dot risk-${risk}`;

			const name = new Inline();
			name.className = "agent-cmd-program-name";
			name.textContent = program;
			name.title = reason;

			// Auditability: surface the subcommand (first-arg) filters already
			// configured for this program across the merged policy, e.g. allow
			// `git status` / block `git reset`. Empty cell when none configured.
			const subsCell = new Inline();
			subsCell.className = "agent-cmd-subs-cell";
			const { allowSubs, blockSubs } = subChipsFor(program, mergedPolicy);
			const addSubChip = (label, subs, kind) => {
				const c = new Inline();
				c.className = `agent-cmd-subs-chip subs-${kind}`;
				c.textContent = `${label}(${subs.join(", ")})`;
				c.title = `Only the subcommands [${subs.join(", ")}] are ${kind === "allow" ? "allowed" : "blocked"}; other invocations of ${program} ${kind === "allow" ? "require approval" : "are not blocked"}.`;
				subsCell.append(c);
			};
			if (allowSubs) addSubChip("allow", allowSubs, "allow");
			if (blockSubs) addSubChip("block", blockSubs, "block");

			// "New program" check: used for dimming and the flag's tooltip.
			const isNewProgram = !mergedPolicy.allow.some(r => r.program === program) &&
				!mergedPolicy.block.some(r => r.program === program);
			// Focus new programs: rows whose program already has a rule in the
			// merged policy are dimmed so the ones needing a decision stand out.
			if (!isNewProgram) row.classList.add("agent-cmd-row-dimmed");
			// "Add <sub>" flags: one checkbox per DISTINCT first-arg observed
			// for this program, skipping subs already covered by a policy allow
			// rule (allow or block) — those are already audited via the subs
			// chips above and the rule handler unions them into the existing
			// filter anyway. For NEW programs the checked subs decide whether
			// the written rule is subs-limited (any checked) or broad (none);
			// for programs with an existing rule the handler unions each checked
			// sub into the filter. No first-arg context -> no flags.
			const firstArgs = subArgsByProgram.get(program) || [];
			const existingSubs = new Set();
			for (const kind of ["allow", "block"]) {
				for (const list of [masterPolicy, sessionPolicy]) {
					for (const r of list[kind] || []) {
						if (r && r.program === program && Array.isArray(r.subs)) {
							for (const s of r.subs) existingSubs.add(s);
						}
					}
				}
			}
			const flagRefs = [];
			for (const sub of firstArgs) {
				if (existingSubs.has(sub)) continue; // already in the policy
				const flag = document.createElement("input");
				flag.type = "checkbox";
				flag.className = "agent-cmd-limit-flag";
				flag.dataset.sub = sub; // submit handler maps checked flags → subs
				flag.title = isNewProgram
					? `Checked: \`${program} ${sub}\` is included in the rule. Unchecked: \`${program} ${sub}\` is not (other checked subs or a broad rule still apply).`
					: `Checked: \`${sub}\` is added to the existing ${program} subcommand filter. Unchecked: the existing filter is left unchanged.`;
				const flagLabel = document.createElement("label");
				flagLabel.className = "agent-cmd-limit-flag-label";
				flagLabel.title = flag.title;
				// Visual binding: hovering/focusing this checkbox highlights the
				// matching subcommand token in the tokenized snippet (full
				// colour + bold), so the user sees exactly which token the rule
				// would apply to.
				this._bindSubtokenHover(card, flagLabel, sub);
				const flagText = document.createElement("span");
				flagText.className = "agent-cmd-limit-flag-text";
				flagText.textContent = ` add ${sub}`;
				flagLabel.append(flag, flagText);
				// Register the checkbox (default unchecked) so the Ok handler can
				// read the current state at submit time.
				flagRefs.push(flag);
				row.append(flagLabel);
			}
			if (flagRefs.length > 0) subFlagRefs.set(program, flagRefs);

			const sel = document.createElement("select");
			sel.className = "agent-cmd-policy-select";
			for (const [value, label] of selectOptions) {
				const opt = document.createElement("option");
				opt.value = value;
				opt.textContent = label;
				sel.appendChild(opt);
			}
			sel.value = this._initialPolicyValue(program, masterPolicy, sessionPolicy);
			selectorRefs.set(program, sel);

			row.append(dot, name, subsCell);
			row.append(sel);
			card.append(row);
		}

		if (parsed.warnings && parsed.warnings.length > 0) {
			const warnBlock = new Block();
			warnBlock.className = "agent-cmd-warnings";
			for (const w of parsed.warnings) {
				const line = new Inline();
				line.className = "agent-cmd-warning-line";
				line.textContent = "⚠ " + w;
				warnBlock.append(line);
			}
			card.append(warnBlock);
		}

		const okRow = new Block();
		okRow.className = "agent-cmd-ok-row";
		const okBtn = new Button("Ok");
		okBtn.className = "theme-button primary";
		okBtn.onclick = async () => {
			okBtn.disabled = true;

			const decisions = new Map();
			for (const program of parsed.programs) {
				decisions.set(program, selectorRefs.get(program).value);
			}

			const activeSession = await this._resolveApprovalSession(targetSessionId);
			const master = this.manager.config?.commandPolicy || { allow: [], block: [] };
			const sp = activeSession ? this._normalizeSessionPolicy(activeSession) : { allow: [], block: [] };

			// Subcommand (first-arg) context for each program, so "always
			// allow/block" can write a precise subs rule (e.g. allow `git
			// status`) rather than a broad program rule. Programs extracted
			// from nested substitutions have no segment/args context -> null.
			const subsContext = new Map();
			for (const program of parsed.programs) {
				const args = subArgsByProgram.get(program) || [];
				subsContext.set(program, args.length > 0 ? args[0] : null);
			}

			const blockedPrograms = [];
			for (const [program, choice] of decisions) {
				// Persistence: only session/always choices write a rule.
				// *_once choices are instance-only (no rule written).
				// When the program has a first-arg context, the rule carries a
				// subs filter so only that subcommand is allowed/blocked.
				let subs = subsContext.get(program);
				// Per-sub "add <sub>" checkboxes (one per distinct first-arg not
				// already in the policy's allow list). For NEW programs they
				// decide the rule shape: any checked → subs-limited rule to the
				// checked subs, none checked → broad rule. For programs with an
				// existing rule each checked sub is unioned into the filter
				// (unchecked subs are left unchanged), so the default first-arg
				// behavior is preserved when no checkbox is present.
				const flags = subFlagRefs.get(program);
				if (flags && flags.length > 0) {
					const hasExistingRule = master.allow.some(r => r.program === program) ||
						master.block.some(r => r.program === program) ||
						sp.allow.some(r => r.program === program) ||
						sp.block.some(r => r.program === program);
					const checked = flags.filter(f => f.checked).map(f => f.dataset.sub).filter(Boolean);
					if (!hasExistingRule) {
						// Any checked → subs-limited rule to the checked subs;
						// none checked → broad rule.
						subs = checked.length > 0 ? checked : null;
					} else if (checked.length > 0) {
						// Existing rule: union the checked subs into its filter
						// (a subs-less existing rule is left broad — never
						// narrow). No checked subs -> leave the rule unchanged.
						subs = checked;
					}
				}
				if (choice === "allow_session") this._pushProgramRule(sp.allow, program, subs);
				else if (choice === "allow_always") this._pushProgramRule(master.allow, program, subs);
				else if (choice === "block_session") this._pushProgramRule(sp.block, program, subs);
				else if (choice === "block_always") this._pushProgramRule(master.block, program, subs);
				// This-instance decision: ANY block choice (incl. block_once)
				// rejects the command for this run.
				if (choice.startsWith("block")) blockedPrograms.push(program);
			}

			// Persist policy changes.
			if (activeSession) {
				delete activeSession.pendingQueryId;
				activeSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSessionId, activeSession);
			}
			this.manager.saveCommandPolicy(master);

			// Re-evaluate against the merged policy (which now includes the rules
			// just written above). This is the authoritative gate: it honors any
			// pre-existing persisted block/allow rules, not just the UI choices.
			// Block wins over allow.
			const merged = mergePolicies(this.manager.config?.commandPolicy || master, activeSession ? this._normalizeSessionPolicy(activeSession) : null);
			const policyBlocked = evaluateCommand(message.command, merged).decision === "blocked";

			const isRejected = blockedPrograms.length > 0 || policyBlocked;
			if (policyBlocked && blockedPrograms.length === 0) {
				// The user made no explicit block choice, but a persisted rule
				// blocks the command — report the programs the policy blocks.
				// Enumerate top-level AND nested-substitution programs so a block
				// rule on a nested program (e.g. `wc` in `total=$(cat | wc)`) is
				// reported, not just the top-level program.
				const parsedForBlock = parseCommandLine(message.command);
				for (const rule of merged.block) {
					if (!rule.program) continue; // legacy { command } rule: no program to report
					const target = rule.program.toLowerCase();
					for (const seg of parsedForBlock.segments) {
						if (segmentMatchesRule(seg, rule, message.command) &&
							segmentPrograms(seg).includes(target) &&
							!blockedPrograms.includes(target)) {
							blockedPrograms.push(target);
						}
					}
				}
			}

			message.status = isRejected ? "rejected" : "approved";

			this.render();
			this.manager.setSessionProcessing(targetSessionId, true, 'agent', null);
			this.manager._updateTabStatus(targetSessionId, "running");

			let responseText;
			if (blockedPrograms.length > 0) {
				responseText = `Command execution rejected by security policy. The following programs are not allowed: ${blockedPrograms.join(", ")}.`;
			} else {
				const cmdResult = await agentTools.executeTerminalCommand(message.command, message.cwd, targetSessionId, message.timeoutMs);
				responseText = cmdResult;
			}

			if (activeSession) {
				activeSession.messages.push({
					id: crypto.randomUUID(),
					role: "user",
					type: "tool_response",
					content: `[Tool Response: run_command]\n\n${responseText}`,
					timestamp: Date.now()
				});
				activeSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSessionId, activeSession);
			}

			this.render();
			const agent = new Agent(this.manager, activeSession, this.manager.ai);
			await agent.run(null, null);
		};

		okRow.append(okBtn);
		card.append(okRow);
		element.append(card);
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

	/**
	 * Creates a turn actions wrapper: an always-visible vertical ellipsis followed by
	 * a collapsible button container (edit/replay/delete). Buttons expand on hover of the wrapper.
	 * @returns {{wrapper: HTMLElement, buttons: HTMLElement}}
	 */
	_createTurnActionsWrapper() {
		const wrapper = new Inline();
		wrapper.className = "turn-actions-wrapper";

		const ellipsis = new Icon();
		ellipsis.className = "turn-actions-ellipsis";
		ellipsis.textContent = "more_vert";

		const buttons = new Inline();
		buttons.className = "turn-actions-buttons";

		wrapper.append(ellipsis, buttons);
		return { wrapper, buttons };
	}

	_createSingleEditButton(messageId) {
		const editButton = new Button();
		editButton.classList.add("edit-history-button");
		editButton.icon = "edit";
		editButton.title = "Edit this prompt (prunes subsequent turns and copies into editor)";
		editButton.on("click", async (e) => {
			e.stopPropagation();
			if (this.manager._isProcessing) {
				console.warn("AI is currently processing another request. Please wait.");
				return;
			}
			const confirmed = await window.modal.confirm("This will prune all subsequent turns, are you sure?", "Edit Prompt");
			if (confirmed) {
				this.manager.editMessage(messageId);
			}
		});
		return editButton;
	}

	_createSingleReplayButton(messageId, isTurnHeader = false) {
		const replayButton = new Button();
		replayButton.classList.add("replay-history-button");
		if (isTurnHeader) {
			replayButton.classList.add("replay-turn-btn");
		}
		replayButton.icon = "replay";
		replayButton.title = "Replay this turn (prunes subsequent turns and regenerates from here)";
		replayButton.on("click", async (e) => {
			e.stopPropagation();
			const confirmed = await window.modal.confirm("Are you sure you want to replay from this turn? This will permanently delete all subsequent messages in this session and request a new response.", "Replay Turn");
			if (confirmed) {
				this.manager.replayMessage(messageId);
			}
		});
		return replayButton;
	}

	_createSingleDeleteButton(messageId) {
		const deleteButton = new Button();
		deleteButton.classList.add("delete-history-button");
		deleteButton.icon = "delete";
		deleteButton.title = "Delete this message (Ctrl+Click to delete this and all subsequent turns)";
		deleteButton.on("click", (e) => {
			e.stopPropagation();
			const pruneForward = e.ctrlKey || e.metaKey;
			this._handleDeleteSingleMessage(messageId, pruneForward);
		});
		return deleteButton;
	}

	/**
	 * Hover-menu trigger that compacts the cycle whose END POINT is the given turn. The clicked
	 * turn becomes the span's end (give-or-take for safe tool/response pairing: if the clicked
	 * turn is a model/error turn and the NEXT message is its trailing tool_response, the span's
	 * end is extended to include that response so nothing dangles after it). Earlier unsummarized
	 * cycles are cascaded first (Phase 1.3) so the resulting spans stay contiguous.
	 */
	_createSingleCompactButton(messageId) {
		const compactButton = new Button();
		compactButton.classList.add("compact-cycle-btn");
		compactButton.icon = "compress";
		compactButton.title = "Compact the cycle ending at this turn (earlier cycles are compacted first)";

		compactButton.onclick = async (e) => {
			e.stopPropagation();
			if (compactButton.disabled) return; // Already compacting — ignore re-entrancy (Button has no native disabled click-suppression).
			const activeSession = this.manager.activeSession;
			if (!activeSession) return;
			const allMsgs = activeSession.messages;

			// Resolve the END point: the clicked turn's index, extended to include an immediate
			// trailing tool_response (safe pairing — the response belongs to the clicked turn).
			let endIdx = allMsgs.findIndex(m => m.id === messageId);
			if (endIdx === -1) return; // Turn no longer in history.
			const clickedMsg = allMsgs[endIdx];
			const nextMsg = allMsgs[endIdx + 1];
			const isModelTurn = clickedMsg.type === "model" || clickedMsg.type === "error" || clickedMsg.role === "model";
			if (isModelTurn && nextMsg && nextMsg.type === "tool_response") {
				endIdx++; // Pull the trailing tool_response into the span.
			}

			const span = this._findCycleSpanForEndPoint(allMsgs, endIdx);
			if (!span || span.cycleStartIdx === -1 || span.cycleStartIdx >= span.endIdx) {
				window.modal?.toast?.("Span too small to compact — the cycle around this turn has fewer than two messages.");
				return;
			}
			const endMsgId = allMsgs[span.endIdx].id;

			// Already summarized? No-op with a notice (the cascade + span helpers below would
			// otherwise re-compact the same span — keep this explicit and cheap).
			if (this.hasCycleSummaryCovering(allMsgs, span.endIdx) || this.hasCycleSummaryCovering(allMsgs, span.cycleStartIdx)) {
				window.modal?.toast?.("This cycle is already compacted.");
				return;
			}

			compactButton.disabled = true;
			compactButton.icon = "cached";
			compactButton.title = "Compacting cycle…";

			try {
				// Phase 1.3 — Cascade: compact ALL earlier unsummarized cycles BEFORE this one (newest-first),
				// so the spans stay contiguous and chronologically ordered. Best-effort: a cascade failure
				// must not prevent this cycle from compacting.
				try {
					await this.compactEarlierCyclesUpTo(activeSession, endMsgId, { render: false });
				} catch (cascErr) {
					console.error("Error during cascade compaction of earlier cycles:", cascErr); // Best-effort — continue.
				}

				// Re-locate the END point by its STABLE id (the cascade's head-insertions shifted raw
				// indices) and re-derive the span.
				const curEndIdx = allMsgs.findIndex(m => m.id === endMsgId);
				if (curEndIdx === -1) throw new Error("Target turn no longer present");
				const curSpan = this._findCycleSpanForEndPoint(allMsgs, curEndIdx);
				if (!curSpan || curSpan.cycleStartIdx === -1 || curSpan.cycleStartIdx >= curSpan.endIdx) return; // Span too small — nothing to compact.

				await this._compactCycleSpan(activeSession, curSpan.cycleStartIdx, curSpan.endIdx, { render: true });
			} catch (err) {
				console.error("Failed to compact cycle from turn:", err);
				compactButton.disabled = false;
				compactButton.icon = "compress";
				compactButton.title = "Compact the cycle ending at this turn (earlier cycles are compacted first)";
			}
		};

		return compactButton;
	}

	/**
	 * Generalized span computation for an ARBITRARY end point (not just a cycle boundary): given
	 * an index `endIdx`, scans BACKWARDS for the previous `cycle_summary` or cycle boundary and
	 * returns the span starting just after it. Falls back to the first user/model message when no
	 * previous marker exists. Returns {cycleStartIdx, endIdx} or null when the span is too small
	 * (fewer than two messages) — mirrors `_findCycleSpanForEnd`'s backward scan, minus the
	 * boundary-specific trailing-tool_response pull (the caller decides pairing).
	 */
	_findCycleSpanForEndPoint(messages, endIdx) {
		if (!messages || endIdx < 0 || endIdx >= messages.length) return null;

		let cycleStartIdx = -1; // Scan backwards for a previous CYCLE SUMMARY only — start AFTER it (summary-only boundaries: a cycle's span is everything since the last summary, or the session start).
		for (let i = endIdx - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.type === "cycle_summary") {
				cycleStartIdx = i + 1;
				break;
			}
		}

		if (cycleStartIdx === -1) { // No previous marker — fall back to the first conversational message.
			const fallbackIdx = messages.findIndex(msg => msg.role === "user" || msg.role === "model");
			cycleStartIdx = fallbackIdx;
		}

		if (cycleStartIdx === -1 || cycleStartIdx >= endIdx) return null; // Span too small (<2 messages).

		return { cycleStartIdx, endIdx };
	}

	async _handleDeleteSingleMessage(messageId, pruneForward = false) {
		if (!this.manager.activeSession) return;

		const msgIndex = this.chatHistory.findIndex(msg => msg.id === messageId);
		if (msgIndex === -1) {
			console.warn(`Attempted to delete a message with ID ${messageId} that was not found.`);
			return;
		}

		if (pruneForward) {
			if (this.manager._isProcessing) {
				console.warn("AI is currently processing another request. Please wait.");
				return;
			}
			const deletedMessages = this.manager.activeSession.messages.slice(msgIndex);
			await this.manager.deleteSubAgentsInMessages(deletedMessages);

			this.manager.activeSession.messages.splice(msgIndex);
			this.manager.activeSession.lastModified = Date.now();
			await workspaceClient.setSession(this.manager.activeSession.id, this.manager.activeSession);

			this.render();

			this.manager._setButtonsDisabledState(this.manager._isProcessing);
			this.manager._dispatchContextUpdate("delete_item");
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
					let actionsWrapper = userElement.querySelector(".turn-actions-wrapper");
					let actionsButtons;
					if (!actionsWrapper) {
						const created = this._createTurnActionsWrapper();
						actionsWrapper = created.wrapper;
						actionsButtons = created.buttons;
						userElement.append(actionsWrapper);
					} else {
						actionsButtons = actionsWrapper.querySelector(".turn-actions-buttons");
					}
					actionsButtons.append(this._createSingleEditButton(userMessage.id));
					actionsButtons.append(this._createSingleReplayButton(userMessage.id));
					actionsButtons.append(this._createSingleCompactButton(userMessage.id));
					actionsButtons.append(this._createSingleDeleteButton(userMessage.id));
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

	/**
	 * Asynchronously tokenizes a single message using the provider's tokenize endpoint,
	 * persists the exact count to session storage, and updates matching DOM badges in real time.
	 */
	async tokenizeMessage(message, sessionObj = null) {
		if (!message || !this.ai || !this.ai.isConfigured()) return;
		if (typeof message.tokenCount === 'number') return;
		if (typeof this.ai.tokenize !== 'function') return;
		if (message.type === 'system_message' || message.type === 'error' || message.role === 'temp_ai_response') {
			message.tokenCount = 0;
			return;
		}

		const targetSession = sessionObj || this.manager.activeSession;
		let textToTokenize = message.content || "";
		if (message.type === 'file_context') {
			textToTokenize = `--- File: ${message.id || message.filename || 'unknown'} ---\n\`\`\`${message.language || ''}\n${message.content}\n\`\`\``;
		} else if (message.role === 'model' || message.type === 'model') {
			let fullOutputText = message.content || "";
			if (message.thought && !fullOutputText.includes(message.thought)) {
				fullOutputText += "\n" + message.thought;
			}
			if (message.toolCalls && message.toolCalls.length > 0) {
				for (const tc of message.toolCalls) {
					const callObj = tc.functionCall || tc;
					const tcText = `${callObj.name || ""}: ${JSON.stringify(callObj.args || callObj.arguments || {})}`;
					if (!fullOutputText.includes(tcText)) {
						fullOutputText += "\n" + tcText;
					}
				}
			}
			textToTokenize = fullOutputText;
		}

		if (!textToTokenize.trim()) {
			message.tokenCount = 0;
			return;
		}

		try {
			const count = await this.ai.tokenize(textToTokenize);
			if (typeof count === 'number') {
				message.tokenCount = count;
				if (targetSession) {
					const msgInSession = targetSession.messages.find(m => m.id === message.id);
					if (msgInSession) {
						msgInSession.tokenCount = count;
					}
					targetSession.lastModified = Date.now();
					await workspaceClient.setSession(targetSession.id, targetSession);
				}

				// Update any DOM elements showing token counts for this message or preceding model turn
				if (this.manager.conversationArea) {
					// 1. If this was a model turn, update its own turn-tokens-container
					const modelBlock = this.manager.conversationArea.querySelector(`.model-turn-block[data-message-id="${message.id}"]`);
					if (modelBlock) {
						const tokensSpan = modelBlock.querySelector('.turn-tokens-container');
						if (tokensSpan) {
							tokensSpan.innerHTML = this.manager.messageRenderer.getModelTurnTokens(message.content, message, targetSession);
						}
					}

					// 2. If this was a tool_response, find and update the preceding model turn's turn-tokens-container
					if (message.type === 'tool_response' && targetSession) {
						const msgIdx = targetSession.messages.findIndex(m => m.id === message.id);
						if (msgIdx > 0) {
							const prevMsg = targetSession.messages[msgIdx - 1];
							if (prevMsg && (prevMsg.type === 'model' || prevMsg.role === 'model')) {
								const prevBlock = this.manager.conversationArea.querySelector(`.model-turn-block[data-message-id="${prevMsg.id}"]`);
								if (prevBlock) {
									const tokensSpan = prevBlock.querySelector('.turn-tokens-container');
									if (tokensSpan) {
										tokensSpan.innerHTML = this.manager.messageRenderer.getModelTurnTokens(prevMsg.content, prevMsg, targetSession);
									}
								}
							}
						}
					}
				}
				this.manager._dispatchContextUpdate("tokens_updated");
			}
		} catch (err) {
			console.warn("[HistoryManager] tokenizeMessage error:", err);
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
			delete session.evergreenPlanTaskTokenCount;
			delete session.scratchpadTokenCount;
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
				} else if (msg.role === 'model' || msg.type === 'model') {
					let fullOutputText = msg.content || "";
					if (msg.thought && !fullOutputText.includes(msg.thought)) {
						fullOutputText += "\n" + msg.thought;
					}
					if (msg.toolCalls && msg.toolCalls.length > 0) {
						for (const tc of msg.toolCalls) {
							const callObj = tc.functionCall || tc;
							const tcText = `${callObj.name || ""}: ${JSON.stringify(callObj.args || callObj.arguments || {})}`;
							if (!fullOutputText.includes(tcText)) {
								fullOutputText += "\n" + tcText;
							}
						}
					}
					textToTokenize = fullOutputText;
				}

				const count = await this.ai.tokenize(textToTokenize);
				if (typeof count === 'number') {
					msg.tokenCount = count;
					updated = true;
				}
			}
		}

		// Combined evergreen plan & task list token count (single system turn: `EVERGREEN PLAN & TASKS:` with whichever sections exist)
		if ((session.implementationPlan || session.taskList) && typeof session.evergreenPlanTaskTokenCount !== 'number') {
			const sections = [];
			if (session.implementationPlan) sections.push(`IMPLEMENTATION PLAN:\n${session.implementationPlan}`);
			if (session.taskList) sections.push(`TASK LIST:\n${session.taskList}`);
			const textToTokenize = `EVERGREEN PLAN & TASKS:\n${sections.join("\n\n")}`;
			const count = await this.ai.tokenize(textToTokenize);
			if (typeof count === 'number') {
				session.evergreenPlanTaskTokenCount = count;
				updated = true;
			}
		} else if (!session.implementationPlan && !session.taskList && session.evergreenPlanTaskTokenCount !== undefined) {
			delete session.evergreenPlanTaskTokenCount;
			updated = true;
		}

		if (session.scratchpad && typeof session.scratchpadTokenCount !== 'number') {
			const textToTokenize = `=== CADENCE'S SCRATCHPAD ===\n${session.scratchpad}\n================================`;
			const count = await this.ai.tokenize(textToTokenize);
			if (typeof count === 'number') {
				session.scratchpadTokenCount = count;
				updated = true;
			}
		} else if (!session.scratchpad && session.scratchpadTokenCount !== undefined) {
			delete session.scratchpadTokenCount;
			updated = true;
		}

		if (updated) {
			session.lastModified = Date.now();
			await workspaceClient.setSession(session.id, session);
			this.render();
			this.manager._dispatchContextUpdate("tokens_updated");
		}
	}

	/**
	 * True when a tool_response message's content contains a done-confirmation response.
	 * A single tool_response message can ACCUMULATE multiple tool results, joined by a
	 * "\n\n---\n\n" separator (see the agent loop, which joins accumulatedResponses). A naive
	 * substring match on the whole content false-positives on ANY atom that merely MENTIONS
	 * the phrase (e.g. a file being edited contains the literal text, or another response's
	 * output quotes it), so the content is split on the separator and each atom is checked
	 * with a PREFIX match — the done marker must start an atom to be a real response.
	 */
	_toolResponseHasDone(msg) {
		if (!msg || msg.type !== "tool_response" || !msg.content) return false;
		const SEP = "\n\n---\n\n";
		const DONE_MARKER = "[Tool Response: done]";
		const atoms = msg.content.split(SEP);
		for (const atom of atoms) {
			if (atom.trimStart().startsWith(DONE_MARKER)) return true;
		}
		return false;
	}

	/**
	 * Determines if a message is a cycle boundary marker.
	 * Cycle boundaries include:
	 * 1. Done boundary: model turn invoking done, or tool_response confirming done
	 * 2. Accepted plan boundary: model turn with planStatus === "accepted", or tool_response for an accepted plan
	 * Note: Rejected or unactioned plans remain normal history and are NOT cycle boundaries.
	 */
	isCycleBoundary(msg, idx = -1, allMsgs = null) {
		if (!msg) 
			return false;

		// 1. Done boundary: tool_response confirming done, or model turn invoking done.
		// A done-cycle emits TWO adjacent markers — the model turn (which invoked done) and the
		// tool_response that confirms it. To avoid counting a single cycle as two boundaries (the
		// cascade would then compact the same span twice), the tool_response is the CANONICAL
		// marker: the model turn is only a boundary when its done-confirmation has NOT yet been
		// appended (in-flight). Once the tool_response is present, it alone marks the boundary.
		if (msg.type === "tool_response" && this._toolResponseHasDone(msg)) 
			return true;
		const hasDoneCall = Array.isArray(msg.toolCalls) && msg.toolCalls.some(tc => (tc.functionCall?.name || tc.name) === "done");
		const nextMsg = allMsgs ? allMsgs[idx + 1] : null;
		const confirmationPresent = nextMsg && nextMsg.type === "tool_response" && this._toolResponseHasDone(nextMsg);
		if ((msg.role === "model" || msg.type === "model") && hasDoneCall && !confirmationPresent) 
			return true;

		// 2. Accepted plan boundary:
		// Only accepted plans are cycle boundaries. Rejected or unactioned plans remain normal history.
		// The ACCEPTED model turn is the CANONICAL marker (acceptance is recorded on it). The
		// tool_response that immediately follows it is the same cycle's own response — NOT a
		// separate boundary (otherwise one plan cycle would be counted twice).
		if ((msg.role === "model" || msg.type === "model") && msg.planStatus === "accepted") 
			return true;

		return false;
	}

	/**
	/**
	 * Best-effort archival of a just-summarized cycle's RAW messages out of the main
	 * session record and into the per-session archive record. Call AFTER the summary
	 * object has been inserted into `targetSession.messages` and persisted.
	 *
	 * Only final (non-seed) summaries are archived — seeds are ephemeral placeholders
	 * whose span may still be mutating. The span's raw message IDs are computed from
	 * the local array (the same set the UI expander would have shown), and the server
	 * extracts them by ID (never trusting a client-side copy of the messages). On
	 * success the raw messages are spliced out of the local array and the summary is
	 * marked `archived: true`. On failure everything stays in the main record and the
	 * span simply remains eligible for a future archive attempt — nothing is ever lost.
	 *
	 * @param {object} targetSession session object whose `messages` array holds the summary
	 * @param {object} summaryMsg    the cycle_summary message (must have cycleStartMsgId/cycleEndMsgId)
	 * @returns {Promise<boolean>} true if the span was archived and removed locally
	 */
	async _archiveCycleSpan(targetSession, summaryMsg) {
		/**
		 * A sub-agent marker message (`[sub-agent:<id>]` user msg) is a structural
		 * anchor for its sub-session card — it must survive archival so the sub-agent
		 * stays linked to its parent thread in-place. Returning true keeps it in the
		 * main record while everything else in the span is moved out.
		 */
		const isSubAgentMarker = (m) => m.type === "user" && m.content && m.content.startsWith("[sub-agent:");
		try {
			if (!targetSession || !summaryMsg || summaryMsg.isSeed) return false;
			const startId = summaryMsg.cycleStartMsgId;
			const endId = summaryMsg.cycleEndMsgId;
			if (!startId || !endId) return false;

			const messages = targetSession.messages;
			const startIdx = messages.findIndex(m => m.id === startId);
			const endIdx = messages.findIndex(m => m.id === endId);
			if (startIdx === -1 || endIdx === -1) return false; // Span already archived or pruned.
			const lo = Math.min(startIdx, endIdx);
			const hi = Math.max(startIdx, endIdx);

			// Raw messages in the span the expander would have shown: skip the summary
			// markers/seed placeholders and the summary itself (it stays in the main record).
			const rawMsgIds = messages.slice(lo, hi + 1)
				.filter(m => m.type !== "cycle_summary" && m.id !== summaryMsg.id && !isSubAgentMarker(m))
				.map(m => m.id);
			if (rawMsgIds.length === 0) return false;

			await workspaceClient.archiveCycleSpan(targetSession.id, {
				removeMsgIds: rawMsgIds,
				markSummaryId: summaryMsg.id
			});

			// Reflect the move locally: drop exactly the ids the server moved (NOT a range
			// splice) so sub-agent marker messages — excluded above — stay in the main
			// record and remain in place. The server moves only the ids we send, so this
			// keeps local state in sync with the persisted blob.
			const removedIds = new Set(rawMsgIds);
			let writeIdx = 0;
			for (let i = 0; i < messages.length; i++) {
				if (removedIds.has(messages[i].id)) continue;
				if (writeIdx !== i) messages[writeIdx] = messages[i];
				writeIdx++;
			}
			messages.length = writeIdx;
			summaryMsg.archived = true;
			targetSession.lastModified = Date.now();
			await workspaceClient.setSession(targetSession.id, targetSession);
			return true;
		} catch (e) {
			// Best-effort: keep everything in the main record; the span stays eligible for a future attempt.
			console.warn("[AIManagerHistory] Failed to archive cycle span:", e);
			return false;
		}
	}

	/**
	 * Load-time JIT backfill for legacy sessions: compacted cycles created BEFORE the
	 * archive feature kept their raw span in the main session record forever. This
	 * splits every still-unarchived non-seed cycle_summary whose raw span is still
	 * present locally out into the per-session archive record — reusing the exact same
	 * atomic server operation (`archiveCycleSpan`) as new compactions — and marks the
	 * summary `archived: true` locally, persisting once at the end.
	 *
	 * Idempotent & cheap when clean: candidates are summaries that are not `archived`
	 * yet; once a summary is flagged (or its span is no longer local), it never
	 * re-triggers, so subsequent loads are a single O(n) scan with zero writes.
	 * Trusts the server: only the IDs it reports as actually moved are spliced out of
	 * the local array. Each span moves in one server transaction (atomic), so a
	 * crash mid-backfill leaves remaining spans eligible on the next load — nothing
	 * is ever lost. Safe to call fire-and-forget from switchSession; the caller skips
	 * sessions with a running agent.
	 *
	 * @param {object} targetSession session object to backfill (its `messages` array)
	 * @returns {Promise<number>} total raw messages actually moved into the archive (0 = nothing to do)
	 */
	async backfillArchives(targetSession) {
		if (!targetSession || !Array.isArray(targetSession.messages)) return 0;
		const messages = targetSession.messages;

		// Candidates: real (non-seed) summaries with a span range, not yet archived.
		// Array order = oldest first.
		const candidates = messages.filter(m => m.type === "cycle_summary" && !m.isSeed && !m.archived && m.cycleStartMsgId && m.cycleEndMsgId);
		if (candidates.length === 0) return 0; // Clean session — a single scan, zero writes.

		if (window.modal?.toast) {
			window.modal.toast(candidates.length === 1
				? "Updating chat history storage format…"
				: `Updating chat history storage format (${candidates.length} compacted cycles)…`);
		}

		let movedTotal = 0;
		let localDirty = false;

		for (const summary of candidates) {
			const startIdx = messages.findIndex(m => m.id === summary.cycleStartMsgId);
			const endIdx = messages.findIndex(m => m.id === summary.cycleEndMsgId);

			if (startIdx === -1 || endIdx === -1) {
				// Span no longer local (already archived or pruned) — flag it so we stop scanning it.
				if (!summary.archived) {
					summary.archived = true;
					localDirty = true;
				}
				continue;
			}
			const lo = Math.min(startIdx, endIdx);
			const hi = Math.max(startIdx, endIdx);

			// Raw span messages (same rule as _archiveCycleSpan / the expander): skip
			// cycle_summary markers and the summary itself, which stay in the main record.
			// Sub-agent marker messages are also structural anchors and must survive archival.
			const isSubAgentMarker = (m) => m.type === "user" && m.content && m.content.startsWith("[sub-agent:");
			const rawMsgIds = messages.slice(lo, hi + 1)
				.filter(m => m.type !== "cycle_summary" && m.id !== summary.id && !isSubAgentMarker(m))
				.map(m => m.id);
			if (rawMsgIds.length === 0) {
				summary.archived = true;
				localDirty = true;
				continue;
			}

			try {
				// Atomic per-span move; the server also marks the summary archived in the persisted blob.
				const res = await workspaceClient.archiveCycleSpan(targetSession.id, {
					removeMsgIds: rawMsgIds,
					markSummaryId: summary.id
				});

				// Trust the server: splice out only the IDs it reports as actually moved.
				const moved = Array.isArray(res?.ids) ? new Set(res.ids) : null;
				if (moved && moved.size) {
					let writeIdx = 0;
					for (let i = 0; i < messages.length; i++) {
						if (moved.has(messages[i].id)) {
							movedTotal++;
						} else {
							if (writeIdx !== i) messages[writeIdx] = messages[i];
							writeIdx++;
						}
					}
					messages.length = writeIdx;
					localDirty = true;
				}

				// Keep local state consistent with the persisted blob (belt-and-suspenders:
				// the server already set `archived` via markSummaryId).
				summary.archived = true;
				localDirty = true;
			} catch (e) {
				// Span failed to move — stop here; the remaining candidates stay eligible on
				// the next load and nothing already-moved is lost (each span is atomic).
				console.warn(`[AIManagerHistory] Archive backfill failed for summary ${summary.id}; remaining spans will retry on next load:`, e);
				break;
			}
		}

		if (localDirty) {
			targetSession.lastModified = Date.now();
			await workspaceClient.setSession(targetSession.id, targetSession);
			// Re-render only if this session is still active (the user may have switched
			// tabs during the async backfill) so the trimmed array is reflected in the DOM.
			if (this.manager.activeSession === targetSession) {
				this.render();
			}
		}

		if (movedTotal > 0 && window.modal?.toast) {
			window.modal.toast(movedTotal === 1 ? "Chat history storage format updated (1 message archived)" : `Chat history storage format updated (${movedTotal} messages archived)`);
		}
		return movedTotal;
	}

	/**
	 * Resolve the raw messages of a compacted cycle span for the UI (expander / regenerate).
	 * Tries the local `chatHistory` first (fast path for unarchived / pre-archival sessions),
	 * then falls back to the per-session archive record. Returns an array of raw messages
	 * (in order, excluding cycle_summary markers and the summary itself), or null when the
	 * span is no longer available anywhere (treat as pruned).
	 *
	 * @param {string} sessionId     session whose archive to consult
	 * @param {string} startId       summary.cycleStartMsgId
	 * @param {string} endId         summary.cycleEndMsgId
	 * @param {string} summaryId     summary.id (excluded from results)
	 * @param {object[]} [localMsgs] local message array to check first (default this.chatHistory)
	 * @returns {Promise<object[]|null>}
	 */
	async _resolveCycleSpanMessages(sessionId, startId, endId, summaryId = null, localMsgs = null) {
		const strip = (arr) => arr.filter(m => m.type !== "cycle_summary" && m.id !== summaryId);

		// 1. Local fast path (unarchived / pre-archival sessions).
		const msgs = localMsgs || this.chatHistory;
		if (msgs.length) {
			const startIdx = msgs.findIndex(m => m.id === startId);
			const endIdx = msgs.findIndex(m => m.id === endId);
			if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
				return strip(msgs.slice(startIdx, endIdx + 1));
			}
		}

		// 2. Archive fallback (span was moved out of the main record).
		try {
			const doc = await workspaceClient.getSessionArchive(sessionId);
			if (doc && Array.isArray(doc.spans)) {
				const span = doc.spans.find(s => s.startMsgId === startId && s.endMsgId === endId);
				if (span && Array.isArray(span.messages) && span.messages.length) {
					return strip(span.messages);
				}
			}
		} catch (e) {
			console.warn("[AIManagerHistory] Failed to fetch session archive for span:", e);
		}

		// 3. Not found anywhere — treat as pruned.
		return null;
	}

	/**
	 * Agent-mode auto-compaction: condenses the most recent COMPLETED task cycle (ended with a `done` tool call, or an accepted implementation plan, and not yet summarized) into one cycle_summary message — reusing exactly what the manual "Summarize Cycle" path in agent.mjs does, so UI rendering stays identical. No-op unless the target session is in agent mode AND has at least one completed-but-unsummarized boundary; returns true only if a new summary was actually inserted and persisted (idempotent — boundaries already carrying an adjacent cycle_summary are skipped).
	 */
	/**
	 * Phase 1.3 — Cascade compaction. Given a target cycle's span end id (`targetCycleEndMsgId`, the stable id of the target's last message),
	 * compacts every EARLIER completed-but-unsummarized cycle in the session so all cycles are summarized in
	 * chronological order. Each earlier cycle is compacted on its own (separate-connection) path so the cascade runs
	 * in the background without blocking the caller, and the newest earlier cycle is compacted first (closest to the
	 * target) so the summary closest to the target lands soonest.
	 *
	 * Returns a list of the newly-created summary objects (empty when there was nothing to cascade).
	 */
	async compactEarlierCyclesUpTo(targetSession, targetCycleEndMsgId, opts = null) {
		const { connectionId = null, progress = null, render: shouldRender = true } = opts || {};
		if (!targetSession) return [];
		const messages = targetSession.messages;

		// Locate the target boundary (the latest boundary whose span ends at targetCycleEndMsgId).
		let targetBoundaryIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (!this.isCycleBoundary(messages[i], i, messages)) continue;
			// endIdx = boundary + trailing tool_response (mirrors _findCycleBoundary's trailing-tool_response logic).
			let endIdx = i;
			const nextMsg = messages[i + 1];
			if ((messages[i].role === "model" || messages[i].type === "model") && nextMsg && nextMsg.type === "tool_response") {
				endIdx = i + 1;
			}
			// Accept EITHER the boundary's own id (the auto path passes messages[lastBoundaryIdx].id) or its
			// span-end id (the manual path passes the trailing tool_response's id).
			if (messages[i].id === targetCycleEndMsgId || messages[endIdx]?.id === targetCycleEndMsgId) {
				targetBoundaryIdx = i;
				break;
			}
		}
		if (targetBoundaryIdx === -1) return []; // Target boundary not found — nothing to cascade before it.
		// Capture the target boundary's STABLE message id (its raw index shifts as earlier cycles get
		// head-anchored summaries spliced in before them). The cascade clamps each earlier cycle's span end
		// to just before this boundary so archiving an earlier span never deletes the target's boundary message.
		const targetBoundaryId = messages[targetBoundaryIdx].id;

		// Walk ALL boundaries strictly before the target, in original (chronological) order. Track the boundary
		// MESSAGE ID (stable across the cascade's own insertions) rather than a raw index, which shifts as earlier
		// cycles get head-anchored summaries spliced in before them.
		const boundaries = [];
		for (let i = 0; i < targetBoundaryIdx; i++) {
			if (!this.isCycleBoundary(messages[i], i, messages)) continue;
			// Idempotency: skip cycles already summarized. Use span-coverage (not adjacency) so it works for BOTH
			// head-anchored (summary before the span) and legacy tail-anchored (summary after the span) formats.
			const hasSummary = messages.some(m => m.type === "cycle_summary" && !m.isSeed && this._spanCoversMsgId(messages, m, messages[i].id));
			if (!hasSummary) {
				boundaries.push({ boundaryMsgId: messages[i].id });
			}
		}

		// Compact the earlier cycles, newest-first (closest to the target first). Each is independent — a failure
		// on one cycle must not prevent the others from compacting (best-effort cascade).
		// Phase 3.5 - Mitigate the cascade's interruption of the user's flow with a brief toast (the cascade
		// compacts N earlier cycles in sequence, each an AI call, so the turn can be delayed noticeably).
		// A single earlier cycle is a quick single AI call (no flag needed — the target compaction's own chip
		// covers it), so only flag when there's more than one. Skipped when the session isn't being viewed.
		// Duration scales with the cycle count so the toast doesn't vanish mid-cascade.
		if (boundaries.length > 1 && this.manager.isSessionViewed?.(targetSession.id) && window.modal?.toast) {
			window.modal.toast(`Compacting ${boundaries.length} earlier cycles...`, Math.min(10000, 3000 + boundaries.length * 3000));
		}

		const newSummaries = [];
		for (let b = boundaries.length - 1; b >= 0; b--) {
			try {
				if (progress) progress(`Compacting earlier cycle ${boundaries.length - b} of ${boundaries.length}…`);
				// Re-locate this boundary by its STABLE message id against the CURRENT array (earlier insertions
				// have shifted raw indices), then re-derive its span.
				const curBoundaryIdx = messages.findIndex(m => m.id === boundaries[b].boundaryMsgId);
				if (curBoundaryIdx === -1) continue; // Boundary no longer present — skip.
				const span = this._findCycleSpanForEnd(messages, curBoundaryIdx);
				if (!span || span.cycleStartIdx === -1 || span.cycleStartIdx >= span.endIdx) continue; // Span too small — skip.
				// Span bleed-forward guard: this earlier cycle's span must never swallow a LATER boundary's
				// message (the target's done/plan turn). _findCycleSpanForEnd's backward scan stops at the
				// NEAREST previous boundary, so a large unsummarized earlier cycle can stretch forward past
				// the target; archiving that range would delete the target's boundary message and break the
				// caller's re-location (→ "Target boundary no longer present"). Re-locate the target by its
				// STABLE id against the CURRENT array (earlier insertions shifted raw indices) and clamp this
				// span's end to just before it so archiving preserves the target.
				const targetCurIdx = messages.findIndex(m => m.id === targetBoundaryId);
				if (targetCurIdx === -1) continue; // Target gone — nothing left to guard against; skip this cycle.
				const clampedEnd = span.endIdx < targetCurIdx ? span.endIdx : targetCurIdx - 1;
				if (clampedEnd <= span.cycleStartIdx) continue; // Clamp removed the span — skip.
				const summaryMessage = await this._compactCycleSpan(targetSession, span.cycleStartIdx, clampedEnd, {
					connectionId,
					progress: progress ? (msg) => { try { progress(msg); } catch (_) {} } : null,
					render: false // Don't re-render after every cycle — the cascade re-renders once at the end.
				});
				if (summaryMessage) newSummaries.push(summaryMessage);
			} catch (e) {
				console.error("Error during cascade compaction of an earlier cycle:", e); // Best-effort — continue with the rest.
			}
		}

		// Re-render once, at the end, so the UI collapses all newly-summarized spans in a single pass (avoids a
		// render storm when several earlier cycles are compacted in sequence). Skipped when the caller (the manual
		// "Compact Cycle" path) will do its own single render after compacting the target cycle.
		if (shouldRender && newSummaries.length > 0 && this.manager.isSessionViewed?.(targetSession.id)) {
			this.render({ isNewMessage: true });
			const conversationArea = this.conversationArea;
			if (conversationArea) conversationArea.scrollTop = conversationArea.scrollHeight;
		}

		return newSummaries;
	}

	/**
	 * Phase 1.4 — Returns true when the cycle_summary `summary`'s span [cycleStartMsgId..cycleEndMsgId] covers the
	 * message with id `msgId`. Works for BOTH head-anchored (summary before the span) and legacy tail-anchored
	 * (summary after the span) summaries, because it compares the min/max of the two id positions against the
	 * target index. Used by the cascade and the "Compact Cycle" button: head-anchored summaries no longer sit
	 * adjacent to the done block, so the old adjacency check misses them.
	 */
	_spanCoversMsgId(messages, summary, msgId) {
		if (!summary || !msgId) return false;
		const startIdx = messages.findIndex(m => m.id === summary.cycleStartMsgId);
		const endIdx = messages.findIndex(m => m.id === summary.cycleEndMsgId);
		const targetIdx = messages.findIndex(m => m.id === msgId);
		if (startIdx === -1 || endIdx === -1 || targetIdx === -1) return false;
		const lo = Math.min(startIdx, endIdx);
		const hi = Math.max(startIdx, endIdx);
		return targetIdx >= lo && targetIdx <= hi;
	}

	async autoCompactAgentCycle(sessionObj = null, opts = null) {
		const { connectionId = null, progress = null } = opts || {}; // Phase 3.3 — optional override: force compaction onto a specific connection (the session's primary connection when the agent loop preempts) and report progress via callback. Null = primary connection + in-conversation chip (unchanged behavior).
		const targetSession = sessionObj || this.manager.activeSession;
		if (!targetSession || !this.ai?.isConfigured()) return false;

		const agentModeEnabled = targetSession.agentMode ?? this.manager.agentMode;
		if (!agentModeEnabled) return false; // Standard mode has its own performSummarization() path.

		const messages = targetSession.messages;
		if (messages.length < 2) return false;

		// Locate the latest completed cycle boundary not already summarized. Idempotency via SPAN-COVERAGE
		// (not adjacency): a head-anchored summary sits at the span's start (far from the boundary), so the
		// old ±1 adjacency check would miss it and re-compact an already-summarized cycle.
		let lastBoundaryIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (!this.isCycleBoundary(messages[i], i, messages)) continue;
			if (this.hasCycleSummaryCovering(messages, i)) continue; // Already summarized — keep scanning older boundaries.
			lastBoundaryIdx = i;
			break;
		}

		if (lastBoundaryIdx === -1) return false; // No completed cycle awaiting summarization yet.

		// Phase 1.3 — Cascade: compact ALL earlier unsummarized cycles (newest-first) BEFORE the target cycle, so every
		// cycle is summarized in chronological order and the spans stay contiguous. The cascade compacts strictly
		// earlier cycles, so it never touches the target's own span. It's a no-op (returns []) when every earlier
		// cycle is already summarized. Runs on the same connection + progress channel as the target compaction.
		await this.compactEarlierCyclesUpTo(targetSession, messages[lastBoundaryIdx].id, {
			connectionId,
			progress: progress ? (msg) => { try { progress(msg); } catch (_) {} } : null
		});

		// Re-locate the target span by its STABLE boundary message id (the cascade's insertions shifted raw indices),
		// then re-derive its span against the current array.
		const targetBoundaryIdx = messages.findIndex(m => m.id === messages[lastBoundaryIdx].id);
		if (targetBoundaryIdx === -1) return false; // Boundary no longer present — safe no-op.
		const targetSpan = this._findCycleSpanForEnd(messages, targetBoundaryIdx);
		if (!targetSpan || targetSpan.cycleStartIdx === -1 || targetSpan.cycleStartIdx >= targetSpan.endIdx) return false; // Span too small (<2 messages) to summarize meaningfully.

		const { cycleStartIdx, endIdx } = targetSpan;
		const cycleMessages = messages.slice(cycleStartIdx, endIdx + 1);

		// Capture the span bounds by STABLE message id BEFORE the await: the summary AI call is long, and other
		// code (a concurrent background compaction's seed clear/archive, a new prompt append, a sub-agent marker
		// push) can mutate `messages` while it's in flight — the preemption's Promise.race timeout does NOT cancel
		// the in-flight compaction, so a timed-out compaction can still land while the next turn appends messages.
		const startMsgId = cycleMessages[0]?.id;
		const endMsgId = cycleMessages[cycleMessages.length - 1]?.id;
		if (!startMsgId || !endMsgId) return false; // Span not fully present — nothing to summarize.

		let progressEl = null;
		const reportProgress = (msg) => { // Unified progress reporting: an explicit callback takes priority (agent-loop preemption); otherwise the in-conversation progress chip (default path).
			if (progress) { try { progress(msg); } catch (_) {} }
			else if (progressEl) progressEl.innerHTML = `<ui-icon class="spin">cached</ui-icon> ${msg}`;
		};
		if (!progress && this.manager.isSessionViewed?.(targetSession.id) && this.conversationArea) {
			progressEl = document.createElement("div");
			progressEl.className = "agent-tool-progress";
			progressEl.innerHTML = `<ui-icon class="spin">cached</ui-icon> Compacting cycle...`;
			this.conversationArea.append(progressEl);
			if (this.manager._shouldAutoScroll?.() && this.conversationArea) {
				this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
			}
		}

		try {
			reportProgress("Compacting cycle...");
			const result = await this.manager.generateCycleSummary(cycleMessages, connectionId ? { connectionId } : null); // Phase 3.3 — honor the connection override (e.g. the session's primary connection when the agent loop preempts).
			if (!result || !result.summary) return false; // AI unavailable or returned nothing — safe no-op.

			// Re-derive the span's head position by STABLE id (insertions during the await may have shifted raw
			// indices), so the head-anchored splice and the summary's cycleStartMsgId/cycleEndMsgId stay correct.
			const curStartIdx = messages.findIndex(m => m.id === startMsgId);
			if (curStartIdx === -1) return false; // Span's head no longer present (archived concurrently) — safe no-op.
			const summaryMessage = {
				id: crypto.randomUUID(),
				role: "system",
				type: "cycle_summary",
				title: result.title,
				content: result.summary,
				timestamp: Date.now(),
				cycleStartMsgId: startMsgId, // render() already hides the covered span and shows this block instead — identical to manual-path behavior.
				cycleEndMsgId: endMsgId
			};

			messages.splice(curStartIdx, 0, summaryMessage); // Phase 1.1 — HEAD-anchor at the span start so cycles are contiguous (this cycle's raw span follows the summary; the next cycle starts after it).
			targetSession.lastModified = Date.now();
			await workspaceClient.setSession(targetSession.id, targetSession);

			// Best-effort: move the raw span out of the main record into the archive (never fails the compaction).
			await this._archiveCycleSpan(targetSession, summaryMessage);

			if (this.manager.isSessionViewed?.(targetSession.id)) {
				this.render({ isNewMessage: true }); // Collapse the just-summarized span into its summary block automatically.
				const conversationArea = this.conversationArea;
				if (conversationArea) conversationArea.scrollTop = conversationArea.scrollHeight;
			}

			return true;
		} catch (e) {
			console.error("Error during automatic agent cycle compaction:", e); // Safe no-op on failure — the prompt proceeds without compacting.
			return false;
		} finally {
			if (progressEl) progressEl.remove();
		}
	}

	// MARK: cycle-seed helpers

	/**
	 * Extracts the last model turn's CONTENT ONLY (strips thought/reasoning blocks and tool calls) as a lightweight seed for a new cycle while the full compaction is still in flight. Returns a trimmed string, or null when there is no usable model content. Marker strings are built via concatenation so the literal channel/tool-call markers never appear verbatim in this source.
	 */
	_extractLastModelContent(messages) {
		const LT = "<", SL = "</";
		const thoughtOpen = LT + "thought>", thoughtClose = SL + "thought>";
		const channelOpen = LT + "|channel>thought", channelClose = LT + "channel|>";
		const toolOpen = LT + "tool_call>", toolClose = SL + "tool_call>";
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!(msg.role === "model" || msg.type === "model")) continue;
			let content = (msg.content || "");
			content = content.replace(new RegExp(thoughtOpen + "[\\s\\S]*?" + thoughtClose, "gi"), "");
			content = content.replace(new RegExp(channelOpen + "[\\s\\S]*?" + channelClose, "gi"), "");
			content = content.replace(new RegExp(toolOpen + "[\\s\\S]*?" + toolClose, "gi"), "");
			content = content.trim();
			if (content) return content;
		}
		return null;
	}

	/**
	 * Inserts a transient cycle_summary seed (last model output, content-only) as a stand-in for the in-flight compaction so the new cycle starts with a continuity anchor. Marked `isSeed: true` so the background compaction can replace it with the real summary when it completes. The seed's `cycleStartMsgId`/`cycleEndMsgId` point to the cycle being compacted so `prepareMessagesForAI` can hide the covered span while the seed is in place.
	 */
	_insertCycleSeed(targetSession, cycleStartIdx, cycleStartMsgId, cycleEndMsgId, content) {
		const messages = targetSession.messages;
		const seed = {
			id: crypto.randomUUID(),
			role: "system",
			type: "cycle_summary",
			title: "Compacting cycle…",
			content,
			timestamp: Date.now(),
			isSeed: true,
			cycleStartMsgId,
			cycleEndMsgId
		};
		messages.splice(cycleStartIdx, 0, seed); // Phase 2.3 — HEAD-anchor the seed at the span's head so it occupies the exact position the real summary will take (in-place swap on completion keeps contiguity). // Append at the end — the new cycle's first conversational message follows it.
		targetSession.lastModified = Date.now();
		workspaceClient.setSession(targetSession.id, targetSession);
		if (this.manager.isSessionViewed?.(targetSession.id)) {
			this.render({ isNewMessage: true });
		}
		return seed.id;
	}

	/**
	 * Inserts a content-only cycle_summary seed TAIL-anchored (right after the span's end) as a stand-in for an
	 * in-flight background compaction. Unlike _insertCycleSeed (HEAD-anchored at the span's head), the tail
	 * position means the seed is NEVER inside the span it covers — so the span's token tally and the backward
	 * summary-stop used by checkCycleCompactionTrigger stay clean while the compaction is in flight.
	 * autoCompactAgentCycleAsync replaces the seed in-place when the real summary arrives (seed-present
	 * outcome), preserving the tail position.
	 */
	_insertTailSeed(targetSession, cycleStartMsgId, cycleEndMsgId, content) {
		const messages = targetSession.messages;
		const endIdx = messages.findIndex(m => m.id === cycleEndMsgId);
		const seed = {
			id: crypto.randomUUID(),
			role: "system",
			type: "cycle_summary",
			title: "Compacting cycle…",
			content,
			timestamp: Date.now(),
			isSeed: true,
			cycleStartMsgId,
			cycleEndMsgId
		};
		messages.splice(endIdx + 1, 0, seed); // TAIL-anchor: right after the covered span's last message.
		targetSession.lastModified = Date.now();
		workspaceClient.setSession(targetSession.id, targetSession);
		if (this.manager.isSessionViewed?.(targetSession.id)) {
			this.render({ isNewMessage: true });
		}
		return seed.id;
	}

	/**
	 * Token-based cycle compaction trigger: when the UNCOMPACTED region (everything after the most recent real
	 * cycle_summary, up to and including the head message) reaches 1× the connection's maxPrefill, kicks off a
	 * compaction of that region. Called fire-and-forget from prepareMessagesForAI (agent block) and from the
	 * prompt gate, so it must be cheap on the common "no trigger" path: one backward scan + a token tally of the
	 * tail region.
	 *
	 * - headId given → span = messages after the last cycle_summary up to (and including) the head message.
	 * - headId null  → span = the tail region after the last cycle_summary (prompt-gate path, where the new
	 *   prompt hasn't been appended yet).
	 * - Skips when the region starts at a cycle_summary (previous summary) or is already covered by a real
	 *   summary (hasCycleSummaryCovering at the head), i.e. there is no uncompacted region.
	 * - Token tally uses per-message tokenCount when present (cached archive case), else estimateTokens.
	 *
	 * On trigger: a separate (non-primary) connection → tail seed (so the seed never falls inside its own
	 * span) + fire-and-forget autoCompactAgentCycleAsync on that connection (its Phase 3.2 failure path sets
	 * _pendingCycleCompaction so the agent-loop preemption picks it up). No separate connection → set
	 * _pendingCycleCompaction so the agent-loop preemption (toast + progress chip) compacts it on the next
	 * turn start. Returns true when compaction was triggered.
	 */
	checkCycleCompactionTrigger(targetSession, opts = {}) {
		const { maxTok = null, headId = null, source = "manual" } = opts;
		if (!targetSession || !this.ai?.isConfigured()) return false;
		const agentModeEnabled = targetSession.agentMode ?? this.manager.agentMode;
		if (!agentModeEnabled) return false; // Standard mode has its own performSummarization() path.

		const messages = targetSession.messages;
		if (messages.length < 2) return false;

		// Re-entrancy guard: a compaction is already in flight (a seed anchor is present) or already deferred
		// to the agent-loop preemption — don't double-fire (a second background compaction would insert a
		// second tail seed and both would race to replace each other's seeds).
		if (targetSession._pendingCycleCompaction || messages.some(m => m.type === "cycle_summary" && m.isSeed)) return false;

		// Resolve the token budget (1× the connection's maxPrefill): explicit override, else the session
		// connection's maxPrefill, else 0.8×n_ctx (mirrors prepareMessagesForAI's agent-block resolution).
		const conn = AIConnections.getConnection(targetSession.connectionId || AIConnections.defaultConnectionId);
		const maxContextTokens = this.ai.MAX_CONTEXT_TOKENS || 8192;
		const maxTokResolved = maxTok ?? resolvePrefillTokens(conn?.maxPrefill) ?? Math.floor(maxContextTokens * 0.8);
		if (!maxTokResolved || maxTokResolved <= 0) return false; // No usable budget — nothing to compare against.
		const maxTokens = maxTokResolved;
		// Threshold = 1× the connection's maxPrefill: the uncompacted region is condensed once it reaches
		// the window budget. (The sliding window itself culls the view at 1×, so compacting at 1× keeps the
		// uncompacted region from pushing the window head back into older cycles.)
		const threshold = maxTokResolved;

		// Locate the span: from just after the last real cycle_summary (or session start) up to the head
		// message (or the tail). Seeds (isSeed) are excluded from the stop — an in-flight tail seed is not
		// a real summary yet, so the region it anchors is still uncompacted.
		let stopIdx = -1; // Index of the last REAL summary (or -1 = session start).
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.type === "cycle_summary" && !m.isSeed) { stopIdx = i; break; }
		}
		let headIdx = messages.length - 1; // Tail region by default.
		if (headId) {
			headIdx = messages.findIndex(m => m.id === headId);
			if (headIdx === -1) return false; // Head not in the record (archived) — nothing to trigger from.
			if (headIdx <= stopIdx) return false; // Head is at/before the last summary — region is empty.
		}

		const spanStartIdx = stopIdx + 1;
		if (spanStartIdx >= headIdx) return false; // Empty region.

		// Idempotency: if the head is already inside a real summary's span, the region is covered — skip.
		if (this.hasCycleSummaryCovering(messages, headIdx)) return false;

		// Token tally across the uncompacted region.
		let tokens = 0;
		for (let i = spanStartIdx; i <= headIdx; i++) {
			const msg = messages[i];
			tokens += (msg.tokenCount != null && msg.tokenCount > 0) ? msg.tokenCount : this.ai.estimateTokens([msg]);
		}
		if (tokens < threshold) return false; // Below maxPrefill — no trigger (cheap path, runs every prompt).

		// Triggered. Prefer a separate (non-primary) connection for a background compaction so the current
		// prompt proceeds unblocked; otherwise defer to the agent-loop preemption on the next turn start.
		const primaryConnId = targetSession.connectionId;
		const hasSeparate = this.manager._hasSeparateCompactionConnection?.(primaryConnId);
		if (hasSeparate) {
			const headMsg = messages[headIdx];
			const lastModelText = this._extractLastModelContent(messages.slice(spanStartIdx, headIdx + 1)) || "Cycle compacted.";
			this._insertTailSeed(targetSession, messages[spanStartIdx].id, headMsg.id, lastModelText);
			// Fire-and-forget: the async path cascades earlier cycles, then compacts this span on the chosen
			// separate connection. Its Phase 3.2 failure path sets _pendingCycleCompaction for preemption.
			this.autoCompactAgentCycleAsync(targetSession).catch(err =>
				console.error(`Error during background compaction trigger (${source}):`, err));
			console.log(`Cycle compaction triggered (${source}): ${tokens} tokens ≥ ${threshold} (maxTok ${maxTokens}) — background on separate connection.`);
			return true;
		}

		targetSession._pendingCycleCompaction = true; // Agent-loop preemption (toast + progress chip) on the next turn start.
		console.log(`Cycle compaction triggered (${source}): ${tokens} tokens ≥ ${threshold} (maxTok ${maxTokens}) — deferred to agent-loop preemption (no separate connection).`);
		return true;
	}

	/**
	 * Removes the in-flight content-only seed (isSeed) from the session, if one is present. Called when a
	 * preemptive/background compaction is a no-op or fails and the seed would otherwise linger as a stale
	 * "Compacting cycle" placeholder. Safe no-op when no seed is present.
	 */
	clearPendingSeed(sessionObj = null) {
		const targetSession = sessionObj || this.manager.activeSession;
		if (!targetSession) return false;
		const messages = targetSession.messages;
		const seedIdx = messages.findIndex(m => m.type === "cycle_summary" && m.isSeed);
		if (seedIdx === -1) return false; // No seed present — nothing to clear.
		messages.splice(seedIdx, 1);
		targetSession.lastModified = Date.now();
		return workspaceClient.setSession(targetSession.id, targetSession).then(() => {
			if (this.manager.isSessionViewed?.(targetSession.id)) this.render();
			return true;
		}).catch(() => false);
	}

	/**
	 * Phase 1.5 — Returns true when a real (non-seed) cycle_summary's span [cycleStartMsgId..cycleEndMsgId]
	 * covers the message at `msgIdx`. Works for BOTH head-anchored (summary before the span) and legacy
	 * tail-anchored (summary after the span) summaries, because it compares the min/max of the two id
	 * positions against the target index. Used by the "Compact Cycle" button: head-anchored summaries no
	 * longer sit adjacent to the done block, so the old adjacency check misses them.
	 */
	hasCycleSummaryCovering(messages, msgIdx) {
		const targetId = messages[msgIdx]?.id;
		if (!targetId) return false;
		for (const m of messages) {
			if (m.type !== "cycle_summary" || m.isSeed) continue;
			if (!m.cycleStartMsgId || !m.cycleEndMsgId) continue;
			const startIdx = messages.findIndex(x => x.id === m.cycleStartMsgId);
			const endIdx = messages.findIndex(x => x.id === m.cycleEndMsgId);
			if (startIdx === -1 || endIdx === -1) continue; // span archived out of the main record — no local done block to hide.
			const lo = Math.min(startIdx, endIdx);
			const hi = Math.max(startIdx, endIdx);
			if (msgIdx >= lo && msgIdx <= hi) return true;
		}
		return false;
	}

	/**
	 * Synchronously inserts a lightweight content-only seed (last model output, thoughts/tool-calls stripped) for the latest completed-but-unsummarized cycle, as a stand-in for the in-flight background compaction. Returns the seed ID if a seed was inserted, or null when there is no boundary or no usable model content. Safe no-op on failure — the prompt proceeds without a seed.
	 */
	seedCycleIfCompacting(targetSession) {
		try {
			const messages = targetSession.messages;
			const boundary = this._findCycleBoundary(messages);
			if (!boundary) return null; // No completed cycle awaiting summarization yet.
			const { cycleStartIdx, endIdx } = boundary;
			const content = this._extractLastModelContent(messages.slice(0, endIdx + 1));
			if (!content) return null; // No usable model content to seed with.
			return this._insertCycleSeed(targetSession, cycleStartIdx, messages[cycleStartIdx].id, messages[endIdx].id, content);
		} catch (e) {
			console.error("Error seeding cycle for background compaction:", e); // Safe no-op on failure.
			return null;
		}
	}

	/**
	 * Locates the latest COMPLETED-but-unsummarized task cycle boundary and computes its span (cycleStartIdx..endIdx). Mirrors agent.mjs' manual path exactly, including its idempotency guard. Returns null when there is no such boundary or the span is too small to summarize meaningfully.
	 */
	_findCycleBoundary(messages) {
		const isToolResponse = (msg) => msg && msg.type === "tool_response"; // Operator precedence: must parenthesize the comparison itself, not just `!!` on a possibly-undefined value.

		// Locate the latest completed cycle boundary not already summarized. Idempotency via SPAN-COVERAGE
		// (not adjacency): a head-anchored summary sits at the span's start (far from the boundary), so the
		// old ±1 adjacency check would miss it and re-compact an already-summarized cycle. Seeds (isSeed)
		// are excluded by hasCycleSummaryCovering, so an in-flight compaction still finds its boundary.
		let lastBoundaryIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (!this.isCycleBoundary(messages[i], i, messages)) continue;
			if (this.hasCycleSummaryCovering(messages, i)) continue; // Already summarized — keep scanning older boundaries.
			lastBoundaryIdx = i;
			break;
		}

		if (lastBoundaryIdx === -1) return null; // No completed cycle awaiting summarization yet.

		let endIdx = lastBoundaryIdx;
		const nextMsg = messages[lastBoundaryIdx + 1];
		if ((messages[lastBoundaryIdx].role === "model" || messages[lastBoundaryIdx].type === "model") && isToolResponse(nextMsg)) {
			endIdx = lastBoundaryIdx + 1; // Pull the trailing accumulated tool_response into the summarized span so nothing dangles after it.
		}

		// Find start of current boundary so we scan strictly BEFORE it for the previous boundary
		let boundaryStartIdx = endIdx;
		if (isToolResponse(messages[endIdx]) && endIdx > 0 && (messages[endIdx - 1].role === "model" || messages[endIdx - 1].type === "model")) {
			boundaryStartIdx = endIdx - 1;
		}

		let cycleStartIdx = -1; // Scan backwards for a previous CYCLE SUMMARY only — start AFTER it (summary-only boundaries: cycles are contiguous spans since the last summary).
		for (let i = boundaryStartIdx - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.type === "cycle_summary") {
				cycleStartIdx = i + 1;
				break;
			}
		}

		if (cycleStartIdx === -1) { // No previous boundary found anywhere before this one — fall back to the first conversational message, mirroring agent.mjs' manual path exactly.
			const fallbackIdx = messages.findIndex(msg => msg.role === "user" || msg.role === "model");
			cycleStartIdx = fallbackIdx; // -1 if there's no user/model turn at all — handled by the span guard below (never summarize an empty / non-conversational span).
		}

		if (cycleStartIdx === -1 || cycleStartIdx >= endIdx) return null; // Span too small (<2 messages) to summarize meaningfully — same guard as performSummarization().

		return { cycleStartIdx, endIdx };
	}

	/**
	 * Phase 1.4 â Given a boundary INDEX (a `done`-turn / accepted-plan model turn), derives that cycle's span {cycleStartIdx, endIdx} by applying the same trailing-tool_response + backward-scan logic as _findCycleBoundary. Returns null when the boundary is invalid or the span is too small.
	 */
	_findCycleSpanForEnd(messages, boundaryIdx) {
		if (!messages || boundaryIdx < 0 || boundaryIdx >= messages.length) return null;
		const isToolResponse = (msg) => msg && msg.type === "tool_response";

		let endIdx = boundaryIdx;
		const nextMsg = messages[boundaryIdx + 1];
		if ((messages[boundaryIdx].role === "model" || messages[boundaryIdx].type === "model") && isToolResponse(nextMsg)) {
			endIdx = boundaryIdx + 1; // Pull the trailing accumulated tool_response into the summarized span so nothing dangles after it.
		}

		let boundaryStartIdx = endIdx;
		if (isToolResponse(messages[endIdx]) && endIdx > 0 && (messages[endIdx - 1].role === "model" || messages[endIdx - 1].type === "model")) {
			boundaryStartIdx = endIdx - 1;
		}

		let cycleStartIdx = -1; // Scan backwards for a previous CYCLE SUMMARY only — start AFTER it (summary-only boundaries: cycles are contiguous spans since the last summary).
		for (let i = boundaryStartIdx - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.type === "cycle_summary") {
				cycleStartIdx = i + 1;
				break;
			}
		}

		if (cycleStartIdx === -1) { // No previous boundary found â fall back to the first conversational message.
			const fallbackIdx = messages.findIndex(msg => msg.role === "user" || msg.role === "model");
			cycleStartIdx = fallbackIdx;
		}

		if (cycleStartIdx === -1 || cycleStartIdx >= endIdx) return null; // Span too small.

		return { cycleStartIdx, endIdx };
	}

	/**
	 * Phase 1.4 â Compacts a specific cycle span (cycleStartIdx..endIdx) into one HEAD-anchored cycle_summary:
	 * generates the summary via the manager, splices it at the span's head, persists, archives the raw span, and
	 * re-renders. Returns the inserted summary message object, or null when the AI is unavailable / returns nothing.
	 * Shared by autoCompactAgentCycle (latest cycle), the cascade (earlier cycles), and the agent-loop preemption.
	 */
	async _compactCycleSpan(targetSession, cycleStartIdx, endIdx, opts = null) {
		const { connectionId = null, progress = null, render: shouldRender = true } = opts || {};
		const messages = targetSession.messages;
		if (cycleStartIdx < 0 || endIdx >= messages.length || cycleStartIdx >= endIdx) return null;

		const cycleMessages = messages.slice(cycleStartIdx, endIdx + 1);
		// Capture the span's stable message ids BEFORE the await: the summary AI call is long, and other
		// code (a concurrent compaction's seed clear/archive, a new prompt append, a sub-agent marker push)
		// can mutate `messages` while it's in flight, so the raw indices are only valid at capture time.
		const startMsgId = cycleMessages[0]?.id;
		const endMsgId = cycleMessages[cycleMessages.length - 1]?.id;
		if (!startMsgId || !endMsgId) return null; // Span not fully present — safe no-op.
		const result = await this.manager.generateCycleSummary(cycleMessages, connectionId ? { connectionId } : null);
		if (!result || !result.summary) return null; // AI unavailable or returned nothing — safe no-op.

		// Re-derive the span's head position by STABLE id (insertions during the await may have shifted raw
		// indices), so the head-anchored splice and the summary's cycleStartMsgId/cycleEndMsgId stay correct.
		const curStartIdx = messages.findIndex(m => m.id === startMsgId);
		if (curStartIdx === -1) return null; // Span's head no longer present (archived concurrently) — safe no-op.
		const summaryMessage = {
			id: crypto.randomUUID(),
			role: "system",
			type: "cycle_summary",
			title: result.title,
			content: result.summary,
			timestamp: Date.now(),
			cycleStartMsgId: startMsgId,
			cycleEndMsgId: endMsgId
		};

		messages.splice(curStartIdx, 0, summaryMessage); // HEAD-anchor so cycles are contiguous.
		targetSession.lastModified = Date.now();
		await workspaceClient.setSession(targetSession.id, targetSession);

		// Best-effort: move the raw span out of the main record into the archive (never fails the compaction).
		await this._archiveCycleSpan(targetSession, summaryMessage);

		// Re-render so the just-summarized span collapses into its summary block. Skipped when the caller is
		// compacting multiple cycles in sequence (the cascade) — it re-renders once at the end instead, so the
		// UI isn't re-rendered N times for N cycles.
		if (shouldRender && this.manager.isSessionViewed?.(targetSession.id)) {
			this.render({ isNewMessage: true });
			const conversationArea = this.conversationArea;
			if (conversationArea) conversationArea.scrollTop = conversationArea.scrollHeight;
		}

		return summaryMessage;
	}

	/**
	 * Fire-and-forget background compaction: locates the latest completed-but-unsummarized cycle and summarizes it on a separate (non-primary) connection without blocking the caller. The caller may have pre-inserted a lightweight content-only seed (via _insertTailSeed — tail-anchored, so the seed never falls inside its own span — or _insertCycleSeed) as a stand-in; when the real summary arrives the seed is replaced in-place so the covered span collapses into the full <compacted_cycle> block. When no seed is present the summary is head-spliced before the cycle.
	 * @param {Object} [opts] - { connectionId } optional: force the compaction (cascade + summary) onto a specific connection; null = _selectCompactionConnection picks the fastest separate connection (unchanged behavior).
	 */
	async autoCompactAgentCycleAsync(sessionObj = null, opts = null) {
		const { connectionId = null } = opts || {}; // Optional override: run the background compaction (cascade + summary) on a specific connection. Null = _selectCompactionConnection picks the fastest separate connection (unchanged behavior).
		const targetSession = sessionObj || this.manager.activeSession;
		if (!targetSession || !this.ai?.isConfigured()) return false;

		const agentModeEnabled = targetSession.agentMode ?? this.manager.agentMode;
		if (!agentModeEnabled) return false; // Standard mode has its own performSummarization() path.

		const messages = targetSession.messages;
		if (messages.length < 2) return false;

		// Phase 1.3 — Cascade FIRST (sequentially, before the target is located): compact all earlier unsummarized
		// cycles so the target's span boundaries stay stable. This runs on the same separate connection as the
		// target compaction (non-blocking to the prompt — the whole function is fire-and-forget). Running it
		// sequentially (not as a parallel fire-and-forget) avoids an index-shift race: the cascade's insertions
		// settle BEFORE the target span is derived, so the target's cycleStartMsgId/cycleEndMsgId stay correct.
		// Best-effort — a cascade failure must not prevent the target from compacting.
		try {
			const preBoundary = this._findCycleBoundary(messages);
			if (preBoundary) {
				const preEndIdx = preBoundary.endIdx;
				await this.compactEarlierCyclesUpTo(targetSession, messages[preEndIdx].id, { connectionId, render: false });
			}
		} catch (cascErr) {
			console.error("Error during background cascade compaction of earlier cycles:", cascErr); // Best-effort — continue to the target.
		}

		// Re-locate the boundary at run time (not at call time) so it stays robust to messages appended while the summary AI call is in flight, AND to the cascade's own insertions above.
		const boundary = this._findCycleBoundary(messages);
		if (!boundary) return false; // No completed cycle awaiting summarization yet, or span too small to summarize meaningfully.
		const { cycleStartIdx, endIdx } = boundary;
		const cycleMessages = messages.slice(cycleStartIdx, endIdx + 1);

		// Capture the span bounds by STABLE message id BEFORE the await: the summary AI call is long,
		// and other code (a concurrent compaction's seed clear/archive, a new prompt append, a
		// sub-agent marker push) can mutate `messages` while it's in flight, so the raw indices are
		// only valid at capture time. The post-await re-derivation below looks the bounds up by id.
		const startMsgId = cycleMessages[0]?.id;
		const endMsgId = cycleMessages[cycleMessages.length - 1]?.id;
		if (!startMsgId || !endMsgId) return false; // Span not fully present — nothing to summarize.

		try {
			const result = await this.manager.generateCycleSummary(cycleMessages, { connectionId });
			if (!result || !result.summary) {
				// Phase 3.2 — the background (separate-connection) compaction produced nothing (AI unavailable or
				// returned empty). Mark the session so the agent loop preempts it onto the main connection on its
				// next turn. The seed (if present) remains as the continuity anchor until the preemption replaces it.
				targetSession._pendingCycleCompaction = true;
				return false;
			}

			// Re-derive the target's span bounds by STABLE message id (the cascade's insertions above, and any
			// `messages` mutation during the await, may have shifted raw indices), so cycleStartMsgId/cycleEndMsgId
			// and the splice position stay correct.
			const curStartIdx = messages.findIndex(m => m.id === startMsgId);
			const curEndIdx = messages.findIndex(m => m.id === endMsgId);
			if (curStartIdx === -1 || curEndIdx === -1) return false; // Target span no longer present — safe no-op.

			const summaryMessage = {
				id: crypto.randomUUID(),
				role: "system",
				type: "cycle_summary",
				title: result.title,
				content: result.summary,
				timestamp: Date.now(),
				cycleStartMsgId: startMsgId,
				cycleEndMsgId: endMsgId
			};

			// Replace the content-only seed (if present) with the real summary so the covered span collapses into the full block instead of leaving a dangling placeholder.
			const seedIdx = messages.findIndex(m => m.type === "cycle_summary" && m.isSeed);
			if (seedIdx !== -1) {
				messages[seedIdx] = summaryMessage; // In-place swap keeps the seed's position (end of the covered span) stable.
			} else {
				messages.splice(curStartIdx, 0, summaryMessage); // Phase 1.1 — HEAD-anchor (no seed was present). Cycles stay contiguous: this cycle's raw span follows the summary; the next cycle starts after it.
			}
			targetSession.lastModified = Date.now();
			await workspaceClient.setSession(targetSession.id, targetSession);

			// Best-effort: move the raw span out of the main record into the archive (never fails the compaction).
			await this._archiveCycleSpan(targetSession, summaryMessage);

			if (this.manager.isSessionViewed?.(targetSession.id)) {
				this.render({ isNewMessage: true }); // Collapse the just-summarized span into its summary block automatically.
				const conversationArea = this.conversationArea;
				if (conversationArea) conversationArea.scrollTop = conversationArea.scrollHeight;
			}

			return true;
		} catch (e) {
			console.error("Error during background agent cycle compaction:", e);
			// Phase 3.2 — the background (separate-connection) compaction failed. Mark the session so the
			// agent loop preempts it onto the main connection on its next turn. The seed (if present)
			// remains as the continuity anchor until the preemption replaces it in place.
			targetSession._pendingCycleCompaction = true;
			return false;
		}
	}

	/**
	 * Builds a single markdown "compacted history" block from all non-seed cycle_summary
	 * messages in chronological order. Every cycle gets a "## <title>" line; the last
	 * MAX_DIRECT_CYCLE_SUMMARIES cycles additionally include their full summary content.
	 * Older cycles are title-only.
	 *
	 * Returns the markdown string, or null when there are no real (non-seed) summaries.
	 */
	_buildCompactedHistoryMarkdown(sessionMessages) {
		const summaries = (sessionMessages || []).filter(
			(msg) => msg && msg.type === "cycle_summary" && !msg.isSeed
		);
		if (summaries.length === 0) return null;

		const n = summaries.length;
		const directCount = Math.min(MAX_DIRECT_CYCLE_SUMMARIES, n);
		const lines = ["# Compacted History"];
		for (let i = 0; i < n; i++) {
			const s = summaries[i];
			let title = s.title || "";
			if (!title && s.content) title = s.content.split(/[.\n]/)[0].trim();
			if (!title) title = "Completed Task";
			lines.push(`** ${title} **`);
			if (i >= n - directCount && s.content && s.content.trim()) {
				lines.push(s.content.trim());
			}
		}
		return lines.join("\n");
	}

	prepareMessagesForAI(sessionObj = null) {
		const targetSession = sessionObj || this.manager.activeSession;
		const isAgentMode = targetSession ? (targetSession.agentMode ?? this.manager.agentMode) : this.manager.agentMode;
		// Create a deep enough copy of messages to avoid modifying the original history.
		let messages = (targetSession?.messages || []).map(msg => ({ ...msg }));

		// 1. Extract the Evergreen Task State
		const taskStateMessage = messages.find(msg => msg.type === "task_state");
		
		// 2. Separate chat/system/file messages from the protected task state
		// We filter out task_state from the main pool so it doesn't get pruned.
		let chatHistory = messages.filter(
			(msg) => msg.type !== "task_state" && msg.type !== "system_message" && msg.type !== "agent_query" && msg.type !== "agent_command_approval" && msg.type !== "agent_command_output" && msg.role !== "temp_ai_response"
		);

		// Pruning gate: Substitute completed cycles with summaries.
		// All non-seed cycle summaries are collapsed into a SINGLE markdown "compacted history" turn:
		// every cycle gets a "## title" line; the last MAX_DIRECT_CYCLE_SUMMARIES cycles also carry
		// their full summary content. Older cycles are title-only. The raw turns covered by the
		// summaries are still spliced out (collapsed) so nothing is double-sent.
		const compactedMarkdown = this._buildCompactedHistoryMarkdown(chatHistory);
		const summaries = chatHistory.filter(msg => msg.type === "cycle_summary");
		if (summaries.length > 0) {
			// Every cycle_summary (seed or not) covers a raw span [cycleStartMsgId .. cycleEndMsgId]
			// that has been summarized. The seed's comment explicitly notes these spans exist so
			// prepareMessagesForAI can "hide the covered span." So we collapse (drop) the raw turns
			// for EVERY summary, and only emit the single compacted_history turn (titles for all
			// non-seed summaries, content for the last MAX_DIRECT_CYCLE_SUMMARIES) in its place.
			const n = chatHistory.length;
			const covered = new Array(n).fill(false);

				// Find each summary's [startIdx .. endIdx] raw span in the original array and mark
				// those raw turns as covered. This applies to seeds as well: a seed's span exists
				// precisely so the in-flight cycle is hidden from the prompt.
				// Note: for ARCHIVED spans the raw messages have been moved out of the main record
				// (into the per-session archive), so findIndex returns -1 and the loop `continue`s —
				// the covered[] masking is a no-op for those spans, which is exactly what we want.
				// The compacted_history turn is still emitted from the summary object (kept in the
				// main record), so prompt correctness is unaffected by archival.
				for (let i = 0; i < n; i++) {
				const msg = chatHistory[i];
				if (msg.type !== "cycle_summary") continue;
				if (msg.cycleStartMsgId && msg.cycleEndMsgId) {
					const startIdx = chatHistory.findIndex(m => m.id === msg.cycleStartMsgId);
					const endIdx = chatHistory.findIndex(m => m.id === msg.cycleEndMsgId);
					if (startIdx === -1 || endIdx === -1) continue;
					const lo = Math.min(startIdx, endIdx);
					const hi = Math.max(startIdx, endIdx);
					for (let k = lo; k <= hi; k++) {
						covered[k] = true;
					}
				}
			}

			let newChatHistory = [];
			let compactedPlaced = false;

			for (let i = 0; i < n; i++) {
				const msg = chatHistory[i];

				// Phase 1.2 — A cycle_summary (head-anchored or legacy) is never sent as a raw turn.
				// Its covered raw spans are already dropped by the covered[] masking above; the summary's
				// content is folded into the single compacted_history turn emitted later.
				if (msg.type === "cycle_summary") continue;

				// A summary object (seed or not) is never sent; it only marks a span to collapse.
				// When we hit the FIRST non-seed summary, emit the single compacted_history turn
				// in its place (the raw turns it covers were already marked covered above and
				// are dropped by the check below).
				/*if (msg.type === "cycle_summary") {
					if (!msg.isSeed && !compactedPlaced && compactedMarkdown) {
						newChatHistory.push({
							id: msg.id,
							role: "system",
							type: "compacted_history",
							content: compactedMarkdown,
							timestamp: msg.timestamp
						});
						compactedPlaced = true;
					}
					continue;
				}*/
				// Raw turn: keep only if it isn't part of a summarized span.
				if (!covered[i]) {
					newChatHistory.push(msg);
				}
			}
			chatHistory = newChatHistory;
		}
		
		// Calculate extra tokens of evergreen plan & tasks (combined turn), scratchpad, directives, task state, and system prompt
		let extraTokens = 0;
		if (isAgentMode) {
			const plan = targetSession?.implementationPlan;
			const taskList = targetSession?.taskList;
			if (plan || taskList) {
				const sections = [];
				if (plan) sections.push(`IMPLEMENTATION PLAN:\n${plan}`);
				if (taskList) sections.push(`TASK LIST:\n${taskList}`);
				extraTokens += this.ai.estimateTokens([{
					role: "system",
					content: `=== EVERGREEN PLAN & TASKS ===:\n${sections.join("\n\n")}\n================================`,
					tokenCount: targetSession.evergreenPlanTaskTokenCount
				}]);
			}
			if (targetSession?.scratchpad) {
				extraTokens += this.ai.estimateTokens([{
					role: "system",
					content: `=== CADENCE'S SCRATCHPAD ===\n${targetSession.scratchpad}\n================================`,
					tokenCount: targetSession.scratchpadTokenCount
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
		
		if (isAgentMode && chatHistory.length > 0) {
			const hasPlan = !!targetSession?.implementationPlan;
			const hasTasks = !!targetSession?.taskList;
			const hasAcceptedPlan = targetSession?.messages?.some(m => m.planStatus === "accepted") || false;
			const planningMode = targetSession ? (targetSession.planningMode ?? (this.manager.config?.defaultPlanningMode ?? true)) : (this.manager.config?.defaultPlanningMode ?? true);
			
			let hasCompletedAllTasks = false;
			if (hasTasks && targetSession.taskList) {
				hasCompletedAllTasks = !targetSession.taskList.includes("- [ ]") && !targetSession.taskList.includes("* [ ]");
			}

			const directivesText = getAgentDirectives({
				hasPlan,
				hasTasks,
				hasAcceptedPlan,
				hasCompletedAllTasks,
				planningMode,
				isSubAgent: !!(targetSession && targetSession.parentId)
			});

			if (directivesText) {
				extraTokens += this.ai.estimateTokens(`[SYSTEM]\n${directivesText}`);
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

		// Strip XML thought blocks from the context for non-reasoning models.
		// For native reasoning models, thoughts are preserved in msg.thought and
		// discussion of <thought> tags in msg.content is preserved.
		if (!this.manager.isKnownReasoningModel(targetSession)) {
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
		}

		// NEW: Strip redundant full read_file outputs (keeping only the latest read for each file)
		const fullReads = [];
		for (let msgIdx = 0; msgIdx < chatHistory.length; msgIdx++) {
			const msg = chatHistory[msgIdx];
			if (!msg.content || typeof msg.content !== 'string') continue;
			
			const chunks = msg.content.split('\n\n---\n\n');
			for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
				const chunk = chunks[chunkIdx];
				const headerMatch = chunk.match(/^\[Tool Response: read_file ([^\]\n]+)\]/);
				if (headerMatch && !headerMatch[1].includes('#')) {
					const filePath = headerMatch[1].trim();
					fullReads.push({
						msgIdx,
						chunkIdx,
						path: filePath,
						header: headerMatch[0]
					});
				}
			}
		}

		const lastReadIdxByPath = new Map();
		for (let i = 0; i < fullReads.length; i++) {
			lastReadIdxByPath.set(fullReads[i].path, i);
		}

		for (let i = 0; i < fullReads.length; i++) {
			const isLast = lastReadIdxByPath.get(fullReads[i].path) === i;
			if (!isLast) {
				const { msgIdx, chunkIdx, header } = fullReads[i];
				const msg = chatHistory[msgIdx];
				const chunks = msg.content.split('\n\n---\n\n');
				chunks[chunkIdx] = `${header}\n\n[content obsolete, see later turns]`;
				chatHistory[msgIdx] = {
					...msg,
					content: chunks.join('\n\n---\n\n')
				};
			}
		}

		// NEW: If Agent Mode is turned OFF, strip out agent-specific tags and filter tool responses 
		// to prevent chat history prompt contamination/few-shot leakage.
		if (!isAgentMode) {
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
		const fileContexts = isAgentMode ? [] : chatHistory.filter(msg => msg.type === "file_context");
		let dialogueHistory = chatHistory.filter(msg => msg.type !== "file_context");

		// Advanced Dialogue Pruning in Agent Mode (Dynamic sliding window with cache-friendly head tracking)
		if (isAgentMode) {
			const maxContextTokens = this.ai?.MAX_CONTEXT_TOKENS || 8192;
			// Prefill bounds now come from the session's connection (absolute token
			// selects). Unset/"none" falls back to legacy 40%/80% of n_ctx.
			const conn = AIConnections.getConnection(targetSession?.connectionId || AIConnections.defaultConnectionId);
			const minTok = resolvePrefillTokens(conn?.minPrefill) ?? Math.floor(maxContextTokens * 0.4);
			const maxTok = resolvePrefillTokens(conn?.maxPrefill) ?? Math.floor(maxContextTokens * 0.8);

			const minTargetLimit = Math.max(1000, minTok - extraTokens);
			const maxTargetLimit = Math.max(minTargetLimit, maxTok - extraTokens); // sanity: max can't fall below min

			const n = dialogueHistory.length;
			const userPrompts = dialogueHistory.filter(msg => msg.type === "user");

			// Precompute token counts for dialogue history
			const msgTokenCounts = new Array(n);
			let totalDialogueCosts = 0;
			for (let i = 0; i < n; i++) {
				msgTokenCounts[i] = typeof dialogueHistory[i].tokenCount === 'number' ? dialogueHistory[i].tokenCount : this.ai.estimateTokens([dialogueHistory[i]]);
				totalDialogueCosts += msgTokenCounts[i];
			}
			const fileContextTotalTokens = this.ai.estimateTokens(fileContexts);

			const nonUserPrunedCostBefore = new Array(n + 1);
			nonUserPrunedCostBefore[0] = 0;
			for (let i = 0; i < n; i++) {
				nonUserPrunedCostBefore[i + 1] = nonUserPrunedCostBefore[i] + (dialogueHistory[i].type !== "user" ? msgTokenCounts[i] : 0);
			}

			// Locate current window head index if stored on the session
			let currentHeadIndex = 0;
			if (targetSession?.contextHeadMsgId) {
				const foundIdx = dialogueHistory.findIndex(m => m.id === targetSession.contextHeadMsgId);
				if (foundIdx !== -1) {
					currentHeadIndex = foundIdx;
				}
			}

			// Calculate estimated context tokens from current window head
			// Pair candidateIndex properly
			if (dialogueHistory[currentHeadIndex]?.type === "tool_response" && currentHeadIndex > 0) {
				currentHeadIndex = currentHeadIndex - 1;
			}
			const currentHeadTokens = fileContextTotalTokens + totalDialogueCosts - nonUserPrunedCostBefore[currentHeadIndex];

			let sliceIndex = currentHeadIndex;

			// If current context exceeds maxTargetLimit (e.g. 80%), aggressively cull back down to minTargetLimit (e.g. 40%)
			if (currentHeadTokens > maxTargetLimit) {
				for (let count = 1; count <= n; count++) {
					const rawBoundary = n - count;
					let candidateIndex = dialogueHistory[rawBoundary].type === "tool_response" && rawBoundary > 0 ? rawBoundary - 1 : rawBoundary;
					const testTokens = fileContextTotalTokens + totalDialogueCosts - nonUserPrunedCostBefore[candidateIndex];
					if (testTokens <= minTargetLimit) {
						sliceIndex = candidateIndex;
					} else {
						break;
					}
				}
			}

			// Update tracked window head on session
			if (targetSession && dialogueHistory[sliceIndex]) {
				targetSession.contextHeadMsgId = dialogueHistory[sliceIndex].id;
			}

			// Token-based cycle compaction trigger (agent mode): when the uncompacted region after the last
			// cycle_summary (up to the window head) reaches 1× maxTok, kick off a background compaction on a
			// separate connection (or defer to the agent-loop preemption when none is available). Fire-and-forget —
			// the check is synchronous/cheap (below threshold it's a no-op) and the current prompt's prepared
			// output is unaffected.
			this.checkCycleCompactionTrigger(targetSession, {
				maxTok,
				headId: dialogueHistory[sliceIndex]?.id,
				source: "prepare"
			});

			if (sliceIndex > 0) {
				const recentHistory = dialogueHistory.slice(sliceIndex);
				const keepIds = new Set();
				userPrompts.forEach(m => keepIds.add(m.id));
				recentHistory.forEach(m => keepIds.add(m.id));
				// Evergreen exemption: the compacted_history turn carries the entire
				// summary history (all cycle titles + last-3 summaries) and must never be
				// pruned out of the window, or the AI loses the context of every cycle
				// that has already run.
				dialogueHistory.forEach(m => {
					if (m && m.type === "compacted_history") keepIds.add(m.id);
				});
				
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
								content: `[SYSTEM(${skipped} turns pruned for context length)]`
							});
						}
						newDialogueHistory.push(dialogueHistory[i]);
						lastKeptIndex = i;
					}
				}
				dialogueHistory = newDialogueHistory;
			}
		}

		// Recombine file contexts and pruned dialogue history
		chatHistory = [...fileContexts, ...dialogueHistory];

		// 3. Handle code block stripping in the chat history
		const stripCodeBlocks = this.manager.ai.config.stripCodeBlocksFromContext;
		if (stripCodeBlocks) {
			const codeBlockWithHeaderRegex = /(?:^|\n)\s*(?:#{1,6}[^\n]*\n+)?\s*```(?:\w+)?\n[\s\S]*?\n\s*```/g;
			chatHistory = chatHistory.map((msg, index) => {
				const isLastMessage = index === chatHistory.length - 1;
				const isToolResponse = msg.content && msg.content.startsWith('[Tool Response:');
				
				if (!isLastMessage && !isToolResponse && (msg.type === 'model' || msg.type === 'user') && msg.content) {
					return {
						...msg,
						content: msg.content.replace(codeBlockWithHeaderRegex, '\n\n<OBSOLETE CODE STRIPPED>\n\n').trim()
					};
				}
				return msg;
			});
		}

		// 4. Prune the chat history to fit within 40% of the context window (leaving 60% headroom for response)
		const maxTokens = this.ai.MAX_CONTEXT_TOKENS || 4096;
		const allowedTokens = Math.max(1000, Math.floor(maxTokens * 0.4) - extraTokens);
		let currentTokens = this.ai.estimateTokens(chatHistory);
		const minimumMessagesToKeep = 1;

		if (currentTokens > allowedTokens) {
			// Pair-safe, oldest-first eviction: a blind shift() would orphan tool responses from their model turn and drop user instructions outright. Instead we evict in "units": contiguous spans starting at a MODEL message that carries tool calls — those turns plus every immediately-following response are removed together so no call is left without its answer (and vice-versa, an unpaired leading response can't be dropped on its own). User messages never form or contain part of an eviction unit: they carry the task timeline and stay. Leading re-derivable noise before a unit's start index — file_context attachments & system_message entries like pruned-gap markers / stale task-state lines — is dropped along with it since tools can recover that content on demand.
			const isToolResponse = (msg) => msg.type === "tool_response" || (!!(msg.content && msg.content.startsWith("[Tool Response:")));

			while (currentTokens > allowedTokens && chatHistory.length > minimumMessagesToKeep) {
				let foundUnit = false;

				for (let i = 0; !foundUnit && i < chatHistory.length; i++) {
					const msg = chatHistory[i];
					if (!msg || isToolResponse(msg)) continue; // Orphaned responses can't be evicted on their own — they'd lose the pairing context.

					// Only model turns carrying tool calls form eviction units (their content may also embed serialized "[Tool Response:" text, but those are already handled via type).
					if (!msg.toolCalls || msg.toolCalls.length === 0) continue; // user instructions / plain system noise — protected by design, never dropped here.

					foundUnit = true; // i..unitEndIndex inclusive — evict ONLY this span [i..end]. Everything before `i` (user instructions especially) is left untouched: user turns carry the task timeline and are never dropped by this pass even if they precede an evicted unit.

					let unitEndIndex = i; // A model turn whose responses were pruned away earlier still forms a valid standalone unit (nothing to pair with).
					
					// Pull in every immediately-following response so the call and its answer are evicted as one unit — never orphaned.
					while (unitEndIndex + 1 < chatHistory.length && isToolResponse(chatHistory[unitEndIndex + 1])) {
						unitEndIndex++;
					}

					const evictionUnit = chatHistory.slice(i, unitEndIndex + 1); // Exact [i..end] span only — leading content (user instructions / other protected turns) before `i` is NOT included here.
					const evictedTokens = Math.max(0, this.ai.estimateTokens(evictionUnit));
					
					// If the unit had no token cost or failed to reduce count, break loop safely
					if (evictedTokens <= 0) {
						foundUnit = false;
						break;
					}
					
					currentTokens -= evictedTokens; // Exact cost of what we're removing
					chatHistory.splice(i, evictionUnit.length);
				}

				if (!foundUnit) {
					break; // No more safe units — all remaining content is protected user instruction / task timeline. Stop here rather than drop them blindly like shift() used to do; the over-cap warning below will still flag that we're out of budget regardless of which messages were evicted (which this pass now logs implicitly via what's left).
				}
			}
		}




		// Model-lead pruning: build a transient visible-turn → messageId map over the culleable dialogue
		// turns, keyed by a SEQUENTIAL VISIBLE-TURN COUNTER (NOT the raw array position). See
		// ai-manager-cull-index.mjs for the index-space contract: cull_history(N) = "keep the Nth visible
		// dialogue turn onward." Gap markers, empty model turns, and evergreen/directive prepends are not
		// counted. Rebuilt every call (short-lived, this.cullIndex) and exposed so the cull_history tool can
		// resolve cull_history(idx) → message id.
		// NOTE: read from this culleable source (chatHistory/dialogueHistory), NOT the reconstructed
		// contextForAI, because reconstruction drops .id (see the reconstruction block below).
		this.cullIndex = buildCullIndex(chatHistory);

		// 5. Reconstruct the context for the AI
		// We always want the Task State to be the very first thing the AI sees.
		const contextForAI = [];

		// NEW: Prepend the compacted history so it's clearly BEFORE the tasklist, plan and scratchpad, mitigating 
		// confusion around chonology
		
		if(compactedMarkdown) {
			contextForAI.push({
				role: "system",
				type: "compacted_history",
				content: compactedMarkdown
			});
		}

		// NEW: Prepend the combined evergreen plan & task checklist (single system turn) at the top of AI context in Agent Mode,
		// followed immediately by the evergreen scratchpad notes (framed with explicit delimiters so they read as
		// our own working notes rather than a user instruction). Directives stay the final turn.
		if (isAgentMode) {
			const plan = targetSession?.implementationPlan;
			const taskList = targetSession?.taskList;
			if (plan || taskList) {
				const sections = [];
				if (plan) sections.push(`IMPLEMENTATION PLAN:\n${plan}`);
				if (taskList) sections.push(`TASK LIST:\n${taskList}`);
				contextForAI.push({
					role: "system",
					content: `EVERGREEN PLAN & TASKS:\n${sections.join("\n\n")}`,
					tokenCount: targetSession.evergreenPlanTaskTokenCount
				});
			}
			if (targetSession?.scratchpad) {
				contextForAI.push({
					role: "system",
					content: `=== CADENCE'S SCRATCHPAD ===\n${targetSession.scratchpad}\n================================`,
					tokenCount: targetSession.scratchpadTokenCount
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

		if (isAgentMode && contextForAI.length > 0) {
			const hasPlan = !!targetSession?.implementationPlan;
			const hasTasks = !!targetSession?.taskList;
			const hasAcceptedPlan = targetSession?.messages?.some(m => m.planStatus === "accepted") || false;
			const planningMode = targetSession ? (targetSession.planningMode ?? (this.manager.config?.defaultPlanningMode ?? true)) : (this.manager.config?.defaultPlanningMode ?? true);
			
			let hasCompletedAllTasks = false;
			if (hasTasks && targetSession.taskList) {
				hasCompletedAllTasks = !targetSession.taskList.includes("- [ ]") && !targetSession.taskList.includes("* [ ]");
			}

			const directivesText = getAgentDirectives({
				hasPlan,
				hasTasks,
				hasAcceptedPlan,
				hasCompletedAllTasks,
				planningMode,
				isSubAgent: !!(targetSession && targetSession.parentId)
			});

			if (directivesText) {
				// Pushed last so the directives are the final turn the model sees.
				// A push at the very end never splits a model tool call from its tool response.
				// [SYSTEM] prefix makes provenance explicit: trailing array-internal system messages
				// degrade to user turns on most providers, so this prevents reading it as a user instruction.
				contextForAI.push({
					role: "system",
					content: `[SYSTEM]\n${directivesText}`
				});
			}
		}

		// Layer Outlines First
		chatHistory.forEach(msg => {
			if (msg.type === "file_context" && msg.mode === "outline" && msg.outline) {
				contextForAI.push({
					role: "user",
					content: `--- Outline: ${msg.id} ---\n\`\`\`${msg.language}\n${msg.outline}\n\`\`\``,
					...(typeof msg.tokenCount === 'number' ? { tokenCount: msg.tokenCount } : {})
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
						...(typeof msg.tokenCount === 'number' ? { tokenCount: msg.tokenCount } : {})
					});
				}
			} else {
				let content = msg.content;
				let toolCalls = msg.toolCalls;
				
				const msgIdx = chatHistory.indexOf(msg);
				const hasToolResponse = (toolName) => {
					for (let i = msgIdx + 1; i < chatHistory.length; i++) {
						const nextMsg = chatHistory[i];
						if (nextMsg.type === "tool_response" && nextMsg.content) {
							const regex = /\[Tool Response: ([^\]]+)\]/g;
							let match;
							while ((match = regex.exec(nextMsg.content)) !== null) {
								const responseToolName = match[1].split(' ')[0];
								if (responseToolName === toolName) {
									return true;
								}
							}
						}
					}
					return false;
				};

				if (msg.role === "model") {
					if (content && content.includes("<tool_call")) {
						const toolCallRegex = /<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi;
						content = content.replace(toolCallRegex, (match, toolName) => {
							if (hasToolResponse(toolName)) {
								return match;
							}
							return "";
						}).trim();
					}
					if (toolCalls && toolCalls.length > 0) {
						toolCalls = toolCalls.filter(tc => {
							const callObj = tc.functionCall || tc;
							return hasToolResponse(callObj.name);
						});
					}
					if ((!content || !content.trim()) && (!toolCalls || toolCalls.length === 0)) {
						return; // Hide/omit this empty model message from context
					}
				}
				// Strip any stray XML tags from content
				if (content) {
					content = content
						.replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '')
						.replace(/<tool_call[\s\S]*?>/gi, '')
						.replace(/<\/tool_call>/gi, '')
						.trim();
				}

				const contextItem = {
					role: msg.role,
					content: content,
					...(typeof msg.tokenCount === 'number' ? { tokenCount: msg.tokenCount } : {})
				};
				
				const msgSig = msg.thoughtSignature || msg.thought_signature;
				if (this.ai.supportsJSONTools && toolCalls && toolCalls.length > 0) {
					contextItem.toolCalls = toolCalls.map(tc => {
						const callObj = tc.functionCall || tc;
						const sig = tc.thoughtSignature || tc.thought_signature || callObj.thoughtSignature || callObj.thought_signature || msgSig;
						return {
							...tc,
							...(sig ? { thoughtSignature: sig } : {})
						};
					});
				}
				if (msg.thought) {
					contextItem.thought = msg.thought;
				}
				if (msgSig) {
					contextItem.thoughtSignature = msgSig;
				}
				
				contextForAI.push(contextItem);
			}
		});



		if (currentTokens > allowedTokens) {
			console.warn(`Context window exceeded headroom limit even after pruning. Estimated: ${currentTokens}, Allowed: ${allowedTokens}`);
		}

		return contextForAI;
	}

	// Expose the transient index→messageId map for cull_history(idx) interception.
	// Returns a fresh Map (rebuilt per prepareMessagesForAI call); caller reads it before parsing tools.
	getcullIndex() {
		return this.cullIndex || null;
	}
}

export default AIManagerHistory
