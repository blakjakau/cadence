// ai-manager-history.mjs

import { Block, Button } from "./elements.mjs"
import DEFAULT_WELCOME_MESSAGE_MARKDOWN from "./ai-manager-setup-guide.mjs"
import workspaceClient from "./workspace-client.mjs"
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

	clear() {
		if (this.manager.activeSession) {
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

		// console.debug("[History Render Debug] rendering messages:", this.chatHistory.map(m => ({ id: m.id, role: m.role, type: m.type, contentPreview: m.content ? m.content.substring(0, 60) : "" })));

		this.conversationArea.innerHTML = ""; // Clear existing messages
		this.populateFileBar(); // Always populate file bar

		// If AI is not configured, show the setup guide and hide empty state.
		if (!this.manager.ai.isConfigured()) {
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

		// Use the new element factory for each message in the history
		for (let i = 0; i < this.chatHistory.length; i++) {
			const message = this.chatHistory[i];
			if (message.type === 'file_context') continue;
			
			const element = this.manager.rawViewMode
				? this._createExpanderMessageElement(message, i)
				: this._createMessageElement(message, i); // No isNewMessage for full render

			if (element) this.conversationArea.append(element);
		}

		// Re-append the active streaming block if we are currently processing/generating
		if (this.manager._isProcessing && this.activeStreamingBlock) {
			this.conversationArea.append(this.activeStreamingBlock);
		} else {
			this.activeStreamingBlock = null;
		}
	}


	/**
	 * NEW: Dynamically creates and appends a single message element to the DOM.
	 * This is used for new incoming messages (user prompts, model responses, system messages, file contexts).
	 * @param {Object} message - The message object to append.
	 */
	appendMessageElement(message) {
		if (!this.conversationArea) return;
		
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

	createStreamingBlock(messageId, type = "model") {
		if (this.manager.rawViewMode) {
			const message = { id: messageId, type, content: "" };
			const element = this._createExpanderMessageElement(message, this.chatHistory.length);
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
					sizeSpan.textContent = `(${sizeInKB} KB)`;
				}
			};
			
			element.finalize = (fullResponse, finalizedMessage) => {
				this.activeStreamingBlock = null; // Clear active streaming reference
				element.updateContent(fullResponse);
				const deleteIcon = element.querySelector(".delete-raw-item");
				if (deleteIcon) {
					deleteIcon.onclick = (e) => {
						e.stopPropagation();
						this._handleDeleteSingleMessage(messageId);
					};
				}
			};
			this.activeStreamingBlock = element;
			return element;
		} else {
			const responseBlock = new Block();
			responseBlock.classList.add("response-block");
			if (type === "error") responseBlock.classList.add("error-block");
			responseBlock.dataset.messageId = messageId;
			
			responseBlock.updateContent = (fullResponse) => {
				responseBlock.innerHTML = this.manager.messageRenderer.renderResponseContent(fullResponse);
				this.manager.messageRenderer.addCodeBlockButtons(responseBlock);
			};
			
			responseBlock.finalize = (fullResponse, finalizedMessage) => {
				this.activeStreamingBlock = null; // Clear active streaming reference
				responseBlock.innerHTML = this.manager.messageRenderer.renderResponseContent(fullResponse, finalizedMessage);
				this.manager.messageRenderer.addCodeBlockButtons(responseBlock, finalizedMessage);
				const deleteButton = this._createSingleDeleteButton(messageId);
				responseBlock.append(deleteButton);
			};
			this.activeStreamingBlock = responseBlock;
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

		if (message.type === "user") {
			const wrapper = new Block();
			wrapper.classList.add("prompt-pill-wrapper");
			wrapper.dataset.messageId = message.id;

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
			element.innerHTML = this.manager.messageRenderer.renderResponseContent(message.content, message);
			
			const deleteButton = this._createSingleDeleteButton(message.id);
			element.append(deleteButton);
			
			if (message.type === "model") this.manager.messageRenderer.addCodeBlockButtons(element, message);

		} else if (message.type === "system_message") {
			element = new Block();
			element.classList.add("system-message-block");
			element.dataset.messageId = message.id;
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
			element.innerHTML = `<strong>Current Task:</strong><br>${this.md.render(message.content)}`;

			const deleteButton = this._createSingleDeleteButton(message.id);
			element.append(deleteButton);
		}

		return element;
	}

	_createExpanderMessageElement(message, index) {
		const expanderBlock = new Block();
		expanderBlock.classList.add("chat-turn-expander");
		expanderBlock.dataset.messageId = message.id;

		const header = document.createElement("div");
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
		}

		// First 40 characters for preview
		const previewText = message.content ? message.content.substring(0, 40).replace(/\n/g, " ") : "";
		const previewSuffix = (message.content && message.content.length > 40) ? "..." : "";

		const sizeInBytes = message.content ? new TextEncoder().encode(message.content).length : 0;
		const sizeInKB = (sizeInBytes / 1024).toFixed(2);

		header.innerHTML = `
			<ui-icon>${iconName}</ui-icon>
			<span class="role-label">${roleLabel} <small class="item-size-badge" style="opacity: 0.6; font-size: 10px; margin-left: 4px;">(${sizeInKB} KB)</small></span>
			<span class="content-preview">${this._escapeHtml(previewText)}${previewSuffix}</span>
			<ui-icon class="delete-raw-item" title="Delete this turn permanently" style="font-size: 16px; color: var(--text-secondary); cursor: pointer; margin-left: auto; margin-right: 8px; transition: color 0.2s;" onmouseover="this.style.color='var(--color-error)'" onmouseout="this.style.color='var(--text-secondary)'">delete</ui-icon>
			<ui-icon class="expand-arrow" style="margin-left: 0;">expand_more</ui-icon>
		`;

		const contentDiv = document.createElement("div");
		contentDiv.className = "expander-content";
		contentDiv.style.display = "none";

		const pre = document.createElement("pre");
		pre.className = "raw-content-block";
		pre.textContent = message.content || "";
		contentDiv.append(pre);

		header.onclick = () => {
			const isExpanded = contentDiv.style.display !== "none";
			contentDiv.style.display = isExpanded ? "none" : "block";
			header.querySelector(".expand-arrow").textContent = isExpanded ? "expand_more" : "expand_less";
			expanderBlock.classList.toggle("expanded", !isExpanded);
		};

		const deleteIcon = header.querySelector(".delete-raw-item");
		if (message.type === "system_prompt_raw" && deleteIcon) {
			deleteIcon.remove();
		} else if (deleteIcon) {
			deleteIcon.onclick = (e) => {
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
			existingToast.remove();
		}

		const toastEl = document.createElement('div');
		toastEl.className = "undo-delete-toast";
		toastEl.style.position = 'fixed';
		toastEl.style.bottom = '20px';
		toastEl.style.left = '50%';
		toastEl.style.transform = 'translateX(-50%) translateY(10px)';
		toastEl.style.backgroundColor = 'var(--theme-dark, #333)';
		toastEl.style.color = '#fff';
		toastEl.style.padding = '12px 24px';
		toastEl.style.borderRadius = 'var(--radius, 8px)';
		toastEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
		toastEl.style.zIndex = '99999';
		toastEl.style.opacity = '0';
		toastEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
		toastEl.style.display = 'flex';
		toastEl.style.alignItems = 'center';
		toastEl.style.gap = '16px';
		toastEl.style.fontSize = '14px';

		const textSpan = document.createElement('span');
		textSpan.textContent = "Message deleted from history.";
		toastEl.appendChild(textSpan);

		const undoBtn = document.createElement('button');
		undoBtn.textContent = "Undo";
		undoBtn.style.background = 'var(--theme, #0089cd)';
		undoBtn.style.color = '#fff';
		undoBtn.style.border = 'none';
		undoBtn.style.padding = '6px 12px';
		undoBtn.style.borderRadius = '4px';
		undoBtn.style.cursor = 'pointer';
		undoBtn.style.fontWeight = 'bold';
		undoBtn.style.fontSize = '12px';
		undoBtn.style.transition = 'filter 0.2s';
		undoBtn.onmouseover = () => { undoBtn.style.filter = 'brightness(1.2)'; };
		undoBtn.onmouseout = () => { undoBtn.style.filter = 'none'; };

		undoBtn.onclick = async () => {
			if (this.manager.activeSession) {
				this.manager.activeSession.messages.splice(originalIndex, 0, deletedMessage);
				this.manager.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.manager.activeSession.id, this.manager.activeSession);
				this.render();
				this.manager._dispatchContextUpdate("undo_delete");
			}
			toastEl.style.opacity = '0';
			toastEl.style.transform = 'translateX(-50%) translateY(10px)';
			setTimeout(() => toastEl.remove(), 300);
		};

		toastEl.appendChild(undoBtn);
		document.body.appendChild(toastEl);

		// Fade in
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				toastEl.style.opacity = '1';
				toastEl.style.transform = 'translateX(-50%) translateY(0)';
			});
		});

		// Automatically fade out and remove after 6 seconds
		const timeoutId = setTimeout(() => {
			toastEl.style.opacity = '0';
			toastEl.style.transform = 'translateX(-50%) translateY(10px)';
			setTimeout(() => {
				if (toastEl.parentNode) {
					toastEl.remove();
				}
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
				.map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
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

	prepareMessagesForAI() {
		// Create a deep enough copy of messages to avoid modifying the original history.
		let messages = (this.manager.activeSession?.messages || []).map(msg => ({ ...msg }));

		// 1. Extract the Evergreen Task State
		const taskStateMessage = messages.find(msg => msg.type === "task_state");
		
		// 2. Separate chat/system/file messages from the protected task state
		// We filter out task_state from the main pool so it doesn't get pruned.
		let chatHistory = messages.filter(
			(msg) => msg.type !== "task_state" && msg.type !== "system_message" && msg.role !== "temp_ai_response"
		);

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
			const targetLimit = Math.floor((this.ai?.MAX_CONTEXT_TOKENS || 8192) * 0.8);
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
		const allowedTokens = Math.floor(maxTokens * 0.8);
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
					content: `EVERGREEN IMPLEMENTATION PLAN:\n${this.manager.activeSession.implementationPlan}`
				});
			}
			if (this.manager.activeSession?.taskList) {
				contextForAI.push({
					role: "system",
					content: `EVERGREEN TASK LIST:\n${this.manager.activeSession.taskList}`
				});
			}
		}

		if (taskStateMessage) {
			contextForAI.push({
				role: "system",
				content: `CURRENT TASK STATUS:\n${taskStateMessage.content}`
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

		if (currentTokens > allowedTokens) {
			console.warn(`Context window exceeded 80% headroom limit even after pruning. Estimated: ${currentTokens}, Allowed: ${allowedTokens}`);
		}

		return contextForAI;
	}
}

export default AIManagerHistory
