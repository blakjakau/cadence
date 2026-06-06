// ai-manager.mjs
// Styles for this module are located in css/ai-manager.css
import { Block, Button, Icon, TabBar, TabItem, FileBar } from "./elements.mjs"
import Ollama from "./ai-ollama.mjs"
import Claude from "./ai-claude.mjs"
import Gemini from "./ai-gemini.mjs"
import LlamaCpp from "./ai-llamacpp.mjs"
import AIManagerHistory, { MAX_RECENT_MESSAGES_TO_PRESERVE } from "./ai-manager-history.mjs"
import AIManagerSettings from "./ai-manager-settings.mjs"
import AIManagerMessageRenderer from "./ai-manager-message-renderer.mjs" // NEW: Settings manager
import AIManagerSessions from "./ai-manager-sessions.mjs" // NEW: Sessions manager
import workspaceClient from "./workspace-client.mjs"
import agentTools from "./agent/agent-tools.mjs"

import DiffHandler from "./tools/diff-handler.mjs"
import AgentBackup from "./agent/agent-backup.mjs"
import systemPromptBuilder from './genericSystemPrompt.mjs'; // NEW: For building prompts
import getAgentSystemPrompt from './ai-manager-agent-prompt.mjs'; // NEW: For building agent prompts
import hljs from "./tools/highlightjs.mjs"
import { tools } from "./ai-manager-tools-schema.mjs"
const MAX_PROMPT_HISTORY = 50 // This is now PER-SESSION

const promptEditorSettings = {
	useSoftTabs: false,
	tabSize: 4,
	newLineMode: "auto",
	fontSize: 12,
	fontFamily: "roboto mono",
	minLines: 3,
	maxLines: 20,
	wrap: true,
	indentedSoftWrap: false,
	showGutter: false,
	highlightActiveLine: false,
	showPrintMargin: false,

	enableBasicAutocompletion: true,
	enableLiveAutocompletion: true
}
class AIManager {
	constructor() {
		this.ai = null
		this.aiProvider = "ollama" // Default AI provider
		this.aiProviders = {
			ollama: Ollama,
			claude: Claude,
			gemini: Gemini,
			llamacpp: LlamaCpp,
		}
		// NEW: Settings logic is moved to AIManagerSettings
		this.settingsManager = new AIManagerSettings(this);
		this.messageRenderer = new AIManagerMessageRenderer(this);
		this.sessionsManager = new AIManagerSessions(this);

		// NEW: Default system prompt config
		this.systemPromptConfig = {
			specialization: "JavaScript (ECMAScript), HTML, CSS, and Node.js", technologies: [], avoidedTechnologies: [], tone: ["warm", "playful", "cheeky"],
		};

		this.panel = null
		this.promptEditor = null // Will hold the ACE editor instance
		this.conversationArea = null
		this.chatContainer = null;
		this.fileBar = null; // NEW: for file context chips
		this.submitButton = null
		// Initialize markdown-it with highlight.js for code highlighting
		this.md = window.markdownit({ // hljs is available globally via <script> tag
			highlight: function (str, lang) {
				if (lang && hljs.getLanguage(lang)) {
					return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
				}
				// For 'diff' or other unhandled languages, return empty string to let markdown-it
				// perform its default escaping. The raw content is then read by _addCodeBlockButtons.
				return '';
			}
		});

		this.historyManager = new AIManagerHistory(this)

		this.contextStaleNotice = null; // New element for context currency check
		this._emptyStateElement = null; // NEW: For empty state background
		this._contextStaleResolve = null; // To resolve/reject the context stale promise		
		this.useWorkspaceSettings = false
		this._isProcessing = false // Flag to track if AI is busy (generating or summarizing)

		// Reference to the AI info display element
		this.aiInfoDisplay = null;
		this.editBufferDisplay = null; // NEW: Edit buffer display

		// Load summarization and mode settings defaults
		this.config = {
			summarizeThreshold: 85,
			summarizeTargetPercentage: 50,
			defaultAgentMode: false,
			defaultPlanningMode: true,
		}

		// NEW: Session Management Properties
		this.allSessionMetadata = []; // Array of {id, name, createdAt, lastModified} - used for UI list
		this.activeSessionId = null; // ID of the currently active session
		this.activeSession = null; // The full active session object {id, name, messages, promptInput, promptHistory}
		this.promptIndex = -1; // Index for the current session's prompt history (Ctrl+Up/Down)
		this._unsentPromptBuffer = null; // NEW: To store unsubmitted prompt during history navigation

		// NEW: Session TabBar properties
		this.sessionTabBar = null;
		this.newSessionButton = null;
		this.settingsButton = null; // NEW: Reference for settings button

		this.saveWorkspaceTimeout = null; // For debouncing workspace saves from _dispatchContextUpdate
		this.agentMode = false; // NEW: Toggle between standard chat and agentic tool loop
		this.agentModeToggle = null;
		this.planningMode = false; // NEW: Toggle planning mode
		this.planningModeToggle = null;
		this.forgivenessMode = false; // NEW: Toggle Permission vs Forgiveness mode
		this.isPaused = false; // NEW: Track if agent is paused
		this.rawViewMode = false; // NEW: Tracks alternate expander raw view
		this.rawViewButton = null;
		this.autoContinue = localStorage.getItem("aiAutoContinue") === "true"; // NEW: Auto-continue on agent loop halt
		this.consecutiveHaltCount = 0; // NEW: Track consecutive loop halts
		this.haltBar = null; // NEW: Persistent halt notification bar
	}

	async init(panel) {
		this.panel = panel
		await this.loadSettings()
		this._loadSystemPromptConfig(); // NEW: Load prompt settings

		// Initialize the AI provider instance
		this.ai = new this.aiProviders[this.aiProvider]();

		// Wrap AI initialization in try-catch to prevent UI freeze on configuration errors
		try {
			await this.ai.init(); // Initialize with loaded settings. This is where the Ollama error occurs.
		} catch (error) {
			console.error("AIManager: Error initializing AI provider:", error);
			// Display an error message to the user in the conversation area
			this.historyManager.addMessage({
				type: "system_message",
				content: `Error initializing AI provider (${this.aiProvider}). Please check your settings. Details: ${error.message}`,
				timestamp: Date.now(),
			}, false);
			// Ensure UI is not blocked
			this._isProcessing = false;
			this._setButtonsDisabledState(false);
		}

		// Load summarization settings from storage, overriding defaults
		const storedSummarizeThreshold = localStorage.getItem("summarizeThreshold")
		if (storedSummarizeThreshold !== null) {
			this.config.summarizeThreshold = parseInt(storedSummarizeThreshold);
		}
		const storedSummarizeTargetPercentage = localStorage.getItem("summarizeTargetPercentage")
		if (storedSummarizeTargetPercentage !== null) {
			this.config.summarizeTargetPercentage = parseInt(storedSummarizeTargetPercentage);
		}

		this._createUI();
		this._initPromptEditor();
		this.settingsManager.init(); // NEW: Initialize settings manager
		this._setupPanel();

		this._updateAIInfoDisplay();
		this._updatePromptAreaPlaceholder(); // Ensure placeholder is correct after init
		this._updateAgentProgressPanel();
		window.addEventListener('setting-changed', this._handleSettingChangedExternally.bind(this));
	}

	async getSystemPrompt() {
		let basePrompt = "";
		if (this.agentMode) {
			const modelName = (this.ai && this.ai.config && this.ai.config.model) ? this.ai.config.model.toLowerCase() : '';
			const supportsJSONTools = !!(this.ai && this.ai.supportsJSONTools);
			
			const hasPlan = !!this.activeSession?.implementationPlan;
			const hasTasks = !!this.activeSession?.taskList;
			const hasAcceptedPlan = this.activeSession?.messages?.some(m => m.planStatus === "accepted") || false;
			
			let hasCompletedAllTasks = false;
			if (hasTasks && this.activeSession.taskList) {
				hasCompletedAllTasks = !this.activeSession.taskList.includes("- [ ]") && !this.activeSession.taskList.includes("* [ ]");
			}

			basePrompt = getAgentSystemPrompt(modelName, {
				supportsJSONTools,
				hasPlan,
				hasTasks,
				hasAcceptedPlan,
				hasCompletedAllTasks,
				planningMode: this.planningMode
			});
		} else {
			basePrompt = systemPromptBuilder(this.getSystemPromptConfig());
		}

		// Persistent memory scratch-pad: read .cadence.md from active workspace roots
		const folders = window.workspace?.folders || [];
		const hints = [];
		for (const folder of folders) {
			try {
				const filePath = `${folder}/.cadence.md`;
				const fileData = await window.conduit.wsRead(filePath);
				if (fileData && !fileData.error && fileData.content) {
					hints.push(fileData.content.trim());
				}
			} catch (e) {
				// Ignore if file doesn't exist or is unreachable
			}
		}

		if (hints.length > 0) {
			const compiledHints = hints.join("\n\n---\n\n");
			basePrompt += `\n\n=== USER PERSISTENT HINTS & MEMORY SCRATCH-PAD ===\nThe following persistent memory and hints have been pre-loaded by the user. Adhere to any instructions, style guidelines, project information, rules, or preferences specified below:\n\n${compiledHints}\n=================================================`;
		}

		return basePrompt;
	}

	/**
	 * NEW: Gets the active system prompt configuration, checking workspace first.
	 * @returns {object} The active system prompt configuration.
	 */
	getSystemPromptConfig() {
		const hasWorkspaceConfig = window.workspace?.systemPromptConfig && Object.keys(window.workspace.systemPromptConfig).length > 0;
		return hasWorkspaceConfig ? window.workspace.systemPromptConfig : (window.app?.systemPromptConfig || this.systemPromptConfig);
	}

	/**
	 * NEW: Loads the system prompt config from the correct source (workspace or app).
	 */
	_loadSystemPromptConfig() {
		const hasWorkspaceConfig = !!(window.workspace?.systemPromptConfig && Object.keys(window.workspace.systemPromptConfig).length > 0);
		this.systemPromptConfig = hasWorkspaceConfig ? window.workspace.systemPromptConfig : (window.app?.systemPromptConfig || this.systemPromptConfig);
	}

	/**
	 * NEW: Callback for the settings manager to save system prompt settings.
	 * @param {object} config - The new system prompt configuration.
	 * @param {boolean} useWorkspaceSettings - Whether to save to workspace or global app config.
	 */
	saveSystemPromptConfig(config, useWorkspaceSettings) {
		if (useWorkspaceSettings) {
			window.workspace.systemPromptConfig = config;
			if (window.app.systemPromptConfig) delete window.app.systemPromptConfig; // Clear global if using workspace
			if (window.saveWorkspace) window.saveWorkspace();
		} else {
			window.app.systemPromptConfig = config;
			if (window.workspace.systemPromptConfig) delete window.workspace.systemPromptConfig; // Clear workspace if using global
			if (window.saveAppConfig) window.saveAppConfig(); // Persist global settings
		}
	}

	set editor(editor) {
		this.ai.editor = editor
	}

	get editor() {
		return this.ai.editor
	}

	focus() {
		this.promptEditor?.focus()
	}

	_setupPanel() {
		this.panel.setAttribute("id", "ai-panel")
	}

	_createUI() {
		// --- Session TabBar UI ---
		this.sessionTabBar = new TabBar();
		this.sessionTabBar.classList.add('ai-session-tabs');
		this.sessionTabBar.setAttribute('slim', '');
		this.sessionTabBar.classList.add('tabs-inverted');
		this.sessionTabBar.exclusiveDropType = "ai-tab"
		this.sessionTabBar.click = (e) => this.switchSession(e.tab.config.id);
		this.sessionTabBar.close = (e) => this.sessionsManager.closeSessionTab(e.tab.config.id, e.tab);

		const aiMenu = document.getElementById("ai_tab_context");
		if (aiMenu) {
			this.sessionTabBar.context = (e) => {
				aiMenu._activeTab = e.tab;
				aiMenu.showAt(e);
			};
			aiMenu.click = (action) => {
				const tab = aiMenu._activeTab;
				if (!tab) return;
				const sessionId = tab.config.id;
				
				if (action === "rename") {
					this.switchSession(sessionId);
					this.sessionsManager.renameCurrentSession();
				} else if (action === "copy") {
					this.sessionsManager.copySession(sessionId);
				} else if (action === "archive") {
					this.sessionsManager.closeSessionTab(sessionId, tab);
				} else if (action === "delete") {
					this.sessionsManager.deleteSession(sessionId, tab);
				}
			};
		}


		this.newSessionButton = new Button("");
		this.newSessionButton.icon = "add_comment";
		this.newSessionButton.title = "New Chat";
		this.newSessionButton.classList.add('new-session-button');
		this.newSessionButton.on('click', () => this.createNewSession());

		this.historyButton = new Button("");
		this.historyButton.icon = "history";
		this.historyButton.title = "Chat History";
		this.historyButton.classList.add('history-button');
		this.historyButton.on('click', () => this.sessionsManager.showHistoryModal());

		this.settingsButton = new Button("");
		this.settingsButton.icon = "settings";
		this.settingsButton.classList.add("settings-button");
		this.settingsButton.onclick = () => this.toggleSettingsPanel();

		this.rawViewButton = new Button("");
		this.rawViewButton.icon = "unfold_more";
		this.rawViewButton.title = "Toggle Raw / Expander View";
		this.rawViewButton.classList.add("raw-view-button");
		this.rawViewButton.onclick = () => this.toggleRawView();

		this.sessionTabBar.append(this.historyButton, this.newSessionButton)

		// --- NEW FileBar and Context Progress Bar ---
		const fileBarContainer = new Block();
		fileBarContainer.classList.add('ai-filebar-container');

		this.fileBar = new FileBar();
		this.fileBar.classList.add('ai-file-context-bar');
		// Listen for requests to remove a file, originating from a chip's close button
		this.fileBar.on('file-remove-request', (e) => {
			const fileId = e.detail.fileId;
			// Find the message before it gets deleted to retrieve the filename
			const fileMessage = this.activeSession?.messages.find(m => m.id === fileId);
			if (fileMessage) {
				this.historyManager.addMessage({
					type: 'system_message',
					content: `**${fileMessage.filename}** removed from this context.`,
					timestamp: Date.now()
				}, false);
			}
			// Proceed with the deletion
			this.historyManager._handleDeleteFileContextItem(fileId);
		});
		
		this.fileBar.on('file-mode-toggle', (e) => {
			const fileId = e.detail.fileId;
			const mode = e.detail.mode;
			const fileMessage = this.activeSession?.messages.find(m => m.id === fileId);
			if (fileMessage) {
				fileMessage.mode = mode;
				if (mode === 'outline' && !fileMessage.outline) {
					window.conduit.wsGetOutline(fileMessage.id).then(res => {
						fileMessage.outline = res.data;
						this.historyManager.render();
						this._dispatchContextUpdate("file_mode_changed");
					}).catch(err => console.error("Failed to get outline", err));
				} else {
					this._dispatchContextUpdate("file_mode_changed");
				}
			}
		});
		this.progressBar = this._createProgressBar();
		fileBarContainer.append(this.fileBar, this.progressBar);

		// --- Other UI Elements ---
		this.conversationArea = this._createConversationArea();
		this.submitButton = this._createSubmitButton();
		const promptContainer = this._createPromptContainer();
		this.settingsPanel = this.settingsManager.createPanel(); // NEW: Create panel via manager

		this.chatContainer = new Block();
		this.chatContainer.classList.add('ai-chat-container');
		this.editBufferDisplay = this._createEditBufferDisplay();
		this._emptyStateElement = this._createEmptyStateElement();
		this.chatContainer.append(fileBarContainer, this.editBufferDisplay, this.conversationArea, this._emptyStateElement);

		// Listen for file focus requests from chips in the conversation area
		this.chatContainer.addEventListener('file-focus-request', async (e) => {
			let path = e.detail.path;
			try {
				if (agentTools && typeof agentTools._resolveAndValidatePath === 'function') {
					path = agentTools._resolveAndValidatePath(path);
				}
			} catch (err) {
				console.warn("[AIManager] Failed to resolve path relative to workspace:", err);
			}

			let tab = await this.ai._getTabSessionByPath(path);
			if (!tab && window.ui?.fileList?.open) {
				await window.ui.fileList.open(path);
				tab = await this.ai._getTabSessionByPath(path);
			}
			if (tab) {
				tab.click();
				// Wait for the tab switch to complete and focus the editor
				setTimeout(() => {
					const editor = window.editors.find(ed => ed.id?.includes(tab.config.session.id));
					// Fallback: if we can't find it by ID, try to find it by the session's editor
					if (editor) {
						editor.focus();
					} else if (tab.config.session && tab.config.session.editor) {
						tab.config.session.editor.focus();
					}
				}, 100);
			}
		});

		this.panel.append(this.chatContainer, this.settingsPanel, this.sessionTabBar, promptContainer);
	}

	_createEditBufferDisplay() {
		const display = new Block();
		display.classList.add("edit-buffer-display");
		display.style.display = "none";
		display.innerHTML = `
			<div class="header">Pending Edits</div>
			<div class="file-list"></div>
			<div style="display: flex; gap: 8px; margin-top: 8px;">
				<button class="commit-button theme-button">Commit All</button>
				<button class="discard-button theme-button secondary" style="background: var(--bg-hover); color: var(--text-color);">Discard All</button>
			</div>
		`;
		display.querySelector(".commit-button").onclick = async () => {
			await agentTools.commitEdits();
			this._renderEditBuffer();
		};
		display.querySelector(".discard-button").onclick = async () => {
			const confirmed = await window.modal.confirm("Are you sure you want to discard all pending edits? This will undo all changes made by the AI agent to your active buffers.", "Discard Pending Edits");
			if (confirmed) {
				await agentTools.discardEdits();
				this._renderEditBuffer();
			}
		};
		return display;
	}

	async _renderEditBuffer() {
		if (!this.editBufferDisplay) return;
		const buffer = agentTools.getEditBuffer();
		const files = Object.keys(buffer);
		if (files.length === 0) {
			this.editBufferDisplay.style.display = "none";
			return;
		}
		this.editBufferDisplay.style.display = "block";
		const list = this.editBufferDisplay.querySelector(".file-list");
		list.innerHTML = files.map(f => `<div title="${this._escapeHtml(f)}">${this._escapeHtml(f.split('/').pop())}</div>`).join('');
	}

	_updateAgentProgressPanel() {
		document.querySelectorAll('.plan-tasks-view').forEach(view => {
			if (window.ui.renderPlanTasksView) {
				window.ui.renderPlanTasksView(view);
			}
		});
	}

	_createConversationArea() {
		const conversationArea = new Block()
		conversationArea.classList.add("conversation-area")
		return conversationArea
	}

	_shouldAutoScroll() {
		if (!this.conversationArea) return false;
		// Use Math.ceil to handle fractional scroll positions from high-DPI screens or browser zoom
		// We use Math.max to avoid negative distances if scrollHeight < clientHeight
		const distanceToBottom = Math.max(0, this.conversationArea.scrollHeight - this.conversationArea.clientHeight) - Math.ceil(this.conversationArea.scrollTop);
		return distanceToBottom <= 50;
	}

	_createProgressBar() {
		const progressBar = document.createElement("div")
		progressBar.classList.add("progress-bar")
		progressBar.setAttribute("title", "Context window utilization")
		progressBar.style.display = "block" // Now always visible

		const progressBarInner = document.createElement("div")
		progressBarInner.classList.add("progress-bar-inner")
		progressBar.appendChild(progressBarInner)
		return progressBar;
	}

	/**
	 * Creates a new spinner element wrapped in a container for centering.
	 * @returns {HTMLElement} The spinner container element.
	 */
	_createSpinner() {
		const spinnerContainer = document.createElement('div');
		spinnerContainer.classList.add('spinner-container');
		const spinner = document.createElement('div');
		spinner.classList.add('loading-spinner');
		spinnerContainer.append(spinner);
		return spinnerContainer;
	}

	_createPromptContainer() {
		const promptContainer = new Block()
		promptContainer.classList.add("prompt-container")

		this.promptArea = this._createPromptArea()

		const buttonContainer = new Block()
		buttonContainer.classList.add("button-container");
		
		this.artifactsButton = document.createElement("button");
		this.artifactsButton.className = "artifacts-tab-btn theme-button secondary";
		this.artifactsButton.title = "Open Session Settings & Artifacts";
		this.artifactsButton.innerHTML = `<ui-icon style="font-size: 14px; margin-right: 4px;">playlist_add_check</ui-icon>Settings & Artifacts`;
		this.artifactsButton.style.display = "flex";
		this.artifactsButton.style.alignItems = "center";
		this.artifactsButton.style.fontSize = "11.5px";
		this.artifactsButton.style.fontWeight = "600";
		this.artifactsButton.style.padding = "3px 8px";
		this.artifactsButton.style.borderRadius = "var(--borderRadius)";
		this.artifactsButton.onclick = () => {
			if (window.ui?.openPlanAndTaskList) {
				window.ui.openPlanAndTaskList();
			}
		};

		this.aiInfoDisplay = document.createElement("select");
		this.aiInfoDisplay.classList.add("ai-info-display", "ai-provider-select");
		this.aiInfoDisplay.addEventListener('change', (e) => {
			this.switchAiProvider(e.target.value);
		});


		buttonContainer.append(this.artifactsButton);
		buttonContainer.append(this.aiInfoDisplay); // Element is created, but content will be set by _updateAIInfoDisplay()
		buttonContainer.append(this.rawViewButton); // Add raw view button
		buttonContainer.append(this.settingsButton);
		this.stopButton = document.createElement("button");
		this.stopButton.className = "agentic-stop-btn";
		this.stopButton.style.display = "none";
		this.stopButton.innerHTML = `<ui-icon>stop</ui-icon> Stop`;
		this.stopButton.onclick = () => this.stopAgent();

		this.pauseButton = document.createElement("button");
		this.pauseButton.className = "agentic-pause-btn pause-btn";
		this.pauseButton.style.display = "none";
		this.pauseButton.innerHTML = `<ui-icon>pause</ui-icon> Pause`;
		this.pauseButton.onclick = () => this.isPaused ? this.resumeAgent() : this.pauseAgent();

		const spacer = document.createElement("div");
		buttonContainer.append(spacer)
		buttonContainer.append(this.stopButton)
		buttonContainer.append(this.pauseButton)
		
		if (this.submitButton) {
			buttonContainer.append(this.submitButton)
		}

		promptContainer.append(this.promptArea)
		promptContainer.append(buttonContainer)

		return promptContainer
	}

	_createPromptArea() {
		// This now creates the container for the ACE editor.
		const promptAreaContainer = document.createElement("div")
		promptAreaContainer.classList.add("prompt-area")
		promptAreaContainer.setAttribute("id", "ai-prompt-editor-container")
		// The editor instance is created and configured in _initPromptEditor
		return promptAreaContainer;
	}

	// NEW METHOD: Initialize the ACE editor for the prompt area
	_initPromptEditor() {
		if (!window.ace || !this.promptArea) return; // Ensure ACE and container are ready

		this.promptEditor = ace.edit(this.promptArea);
		this.promptEditor.id = "ai-prompt-editor"
		this.promptEditor.session.setMode("ace/mode/markdown");
		this.promptEditor.setOptions(promptEditorSettings)
		this.promptEditor.renderer.setScrollMargin(4, 4, 4, 4);

		// Sync theme and keybindings with the main editor
		if (window.editors && window.editors.length > 0) {
			const mainEditor = window.editors[0];
			this.promptEditor.setTheme(mainEditor.getTheme());
			// disabled this, we actually don't want to sync the keyboard handler
			// this.promptEditor.setKeyboardHandler(mainEditor.getKeyboardHandler());
			if (!window.editors.includes(this.promptEditor)) {
				window.editors.push(this.promptEditor);
			}
		}

		// NEW: Remove default conflicting keybindings before adding our own.
		this.promptEditor.on("ready", () => {
			console.log("removing some default commands")
			this.promptEditor.commands.removeCommand('movelinesup');
			this.promptEditor.commands.removeCommand('movelinesdown');
		})

		this.promptEditor.commands.addCommand({
			name: "submitPrompt",
			bindKey: { win: "Ctrl-Enter", mac: "Ctrl-Enter|Command-Enter" },
			exec: () => this.generate(),
		});

		this.promptEditor.commands.addCommand({
			name: "promptHistoryUp",
			bindKey: { win: "Alt-Up", mac: "Alt-Up" },
			exec: () => {
				if (this.activeSession?.promptHistory?.length > 0) {
					// If we are at the "new prompt" line, save the current input before navigating up.
					if (this.promptIndex === this.activeSession.promptHistory.length) {
						this._unsentPromptBuffer = this.promptEditor.getValue();
					}
					this.promptIndex = Math.max(0, this.promptIndex - 1);
					this.promptEditor.setValue(this.activeSession.promptHistory[this.promptIndex] || "", -1);
				}
			},
		});

		this.promptEditor.commands.addCommand({
			name: "promptHistoryDown",
			bindKey: { win: "Alt-Down", mac: "Alt-Down" },
			exec: () => {
				if (this.activeSession?.promptHistory?.length > 0) {
					this.promptIndex = Math.min(this.activeSession.promptHistory.length, this.promptIndex + 1);
					// If we navigate to the end, restore the unsent buffer; otherwise, use history.
					const prompt = this.promptIndex === this.activeSession.promptHistory.length
						? (this._unsentPromptBuffer || "")
						: this.activeSession.promptHistory[this.promptIndex];
					this.promptEditor.setValue(prompt || "", -1);
				}
			},
		});

		this.promptEditor.on("change", () => this._resizePromptArea());
		this.promptEditor.resize(); // Perform initial resize
	}

	// NEW METHOD: Encapsulates prompt area resizing logic
	_resizePromptArea() {
		if (this.promptEditor) {
			// ACE's auto-resize is handled by minLines/maxLines options.
			// We just need to call resize() to trigger it.
			this.promptEditor.resize();
			// --- Custom & EXCLUSIVE Autocompleter for @file context ---
			const langTools = ace.require("ace/ext/language_tools");
			const fileContextCompleter = {
				// This regex tells ACE what constitutes a "word" for this completer.
				// It will activate on '@' and replace the whole token.
				identifierRegexps: [/@[\w.#\-]*/],
				getCompletions: (editor, session, pos, prefix, callback) => {
					// Only activate this completer for our AI prompt editor
					if (editor.id !== "ai-prompt-editor") {
						return callback(null, []);
					}
					// Check if the cursor is inside an @-word
					const line = session.getLine(pos.row).substring(0, pos.column);
					const match = line.match(/@(\S*)$/);
					if (!match) {
						// No @-word found, so we provide no completions.
						return callback(null, []);
					}
					
					const searchTerm = match[1];
					
					// Handle Symbol Lookup (@file.js#symbol)
					if (searchTerm.includes('#')) {
						const parts = searchTerm.split('#');
						const fileFilter = parts[0];
						const symbolQuery = parts[1];
						
						window.conduit.wsSearchSymbols(symbolQuery).then(results => {
							if (!results || !results.data) return callback(null, []);
							let filtered = results.data;
							if (fileFilter) {
								filtered = filtered.filter(s => s.filePath.toLowerCase().includes(fileFilter.toLowerCase()));
							}
							const completions = filtered.map(sym => ({
								caption: `${sym.name} (${sym.type}) - ${sym.filePath.split('/').pop()}`,
								value: `${sym.filePath}#${sym.name}`,
								meta: "Symbol"
							}));
							callback(null, completions);
						}).catch(() => callback(null, []));
						return;
					}

					const fileResults = window.ui.fileList.find(searchTerm, 20);
					const fileCompletions = fileResults.map(item => ({
						caption: item.name,
						value: item.path, // Insert the full path when selected.
						meta: "File Context"
					}));
					// 2. Define and filter our default static options.
					const defaultContextOptions = [
						{ value: 'open', caption: '@open', meta: 'All open files' },
						{ value: 'code', caption: '@code', meta: 'Current file/selection' }
					];
					const filteredDefaults = defaultContextOptions.filter(opt =>
						opt.caption.startsWith(`@${searchTerm}`)
					);

					// 3. Combine the static options and the file results.
					const allCompletions = [...filteredDefaults, ...fileCompletions];
					callback(null, allCompletions);
				}
			};
			// By setting the completers array directly on the editor instance,
			// we prevent the default ACE completers (keywords, snippets) from running.
			this.promptEditor.completers = [fileContextCompleter];
		}
	}

	// NEW METHOD: Updates the prompt area placeholder text based on AI configuration
	_updatePromptAreaPlaceholder() {
		if (!this.promptEditor) return;

		if (this.ai && this.ai.isConfigured()) {
			this.promptEditor.setReadOnly(false);
			if (this.agentMode) {
				this.promptEditor.setOption("placeholder", "Ask Cadence to list/read/edit files... (use @ to tag files)");
			} else {
				this.promptEditor.setOption("placeholder", "Enter your prompt here...");
			}
		} else {
			this.promptEditor.setReadOnly(true);
			this.promptEditor.setOption("placeholder", "AI is not configured. Go to Settings (gear icon) to set up a provider.");
		}
	}

	_createSubmitButton() {
		const submitButton = new Button("Send")
		submitButton.icon = "send"
		submitButton.classList.add("submit-button", "theme-button")
		submitButton.on("click", () => this.generate())
		this._setButtonsDisabledState(this._isProcessing) // Initial state
		return submitButton
	}

	/**
	 * NEW METHOD: Creates the UI element for displaying context currency warnings.
	 */
	_createContextStaleNoticeElement() {
		const noticeBlock = new Block();
		// This notice is now an inline chat message. It reuses system-message styling
		// and removes the old 'notice-bar' class to avoid CSS conflicts.
		noticeBlock.classList.add("system-message-block", "context-stale-notice");
		noticeBlock.innerHTML = `
			<span class="message"></span>
			<div class="button-group">
				<button class="update-button theme-button">Update Context</button>
				<button class="keep-old-button theme-button">Keep Old</button>
				<button class="cancel-button">Cancel</button>
			</div>
		`;

		noticeBlock.querySelector(".update-button").addEventListener("click", () => {
			if (this._contextStaleResolve) {
				this._contextStaleResolve(true); // User chose to update
				this._hideContextStaleNotice();
			}
		});

		noticeBlock.querySelector(".keep-old-button").addEventListener("click", () => {
			if (this._contextStaleResolve) {
				this._contextStaleResolve(false); // User chose to keep old
				this._hideContextStaleNotice();
			}
		});
		noticeBlock.querySelector(".cancel-button").addEventListener("click", () => {
			if (this._contextStaleResolve) {
				this._contextStaleResolve('cancel'); // User chose to cancel
				this._hideContextStaleNotice();
			}
		});
		return noticeBlock;
	}

	// NEW: Create the background element for when the chat is empty
	_createEmptyStateElement() {
		const el = document.createElement('div');
		el.className = 'ai-background-element';
		el.innerHTML = `
			<ui-icon icon="developer_board" style="font-size: 48px; opacity: 0.5;">developer_board</ui-icon>
			<div class="caption">AI Assistant Ready<br/>Type a prompt to begin.</div>
		`;
		el.style.display = 'none'; // Initially hidden
		return el;
	}

	_showContextStaleNotice(message) {
		this.contextStaleNotice = this._createContextStaleNoticeElement();
		const messageElement = this.contextStaleNotice.querySelector(".message");
		const updateButton = this.contextStaleNotice.querySelector(".update-button");

		messageElement.innerHTML = this.md.render(message);
		this.conversationArea.append(this.contextStaleNotice);

		// Focus the update button so the user can just press Enter to accept the update.
		// A slight delay ensures the element is fully rendered and focusable.
		setTimeout(() => updateButton.focus(), 100);
	}

	_hideContextStaleNotice() {
		if (this.contextStaleNotice && this.contextStaleNotice.parentElement) {
			this.contextStaleNotice.remove();
		}
		this.contextStaleNotice = null;
	}

	// Helper to disable/enable relevant buttons
	_setButtonsDisabledState(disabled) {
		const isAIConfigured = this.ai && this.ai.isConfigured() && !this._isProcessing; // Also consider overall processing state

		if (this.submitButton) {
			this.submitButton.disabled = disabled || !isAIConfigured;
			this.submitButton.style.display = this._isProcessing ? 'none' : 'flex';
		}

		if (this.stopButton) {
			this.stopButton.style.display = this._isProcessing ? 'flex' : 'none';
		}

		if (this.pauseButton) {
			this.pauseButton.style.display = this._isProcessing ? 'flex' : 'none';
		}

		// Also disable all history delete buttons while processing
		if (this.conversationArea) {
			this.conversationArea.querySelectorAll('.delete-history-button').forEach(btn => btn.disabled = disabled);
		}

		// Disable session management buttons while processing
		if (this.newSessionButton) this.newSessionButton.disabled = disabled;
		if (this.sessionTabBar) {
			this.sessionTabBar.querySelectorAll('ui-tab-item').forEach(tab => {
				tab.close.style.pointerEvents = disabled ? 'none' : '';
				tab.style.pointerEvents = disabled ? 'none' : 'auto';
			});
		}

		this._updatePromptAreaPlaceholder(); // Update prompt area disabled state
	}

	/**
	 * NEW: Switches the AI provider, re-initializes it, and updates the UI.
	 * This is called by the settings manager.
	 * @param {string} newProviderValue - The key for the new provider (e.g., 'ollama').
	 */
	async switchAiProvider(newProviderValue) {
		this.aiProvider = newProviderValue;
		localStorage.setItem("aiProvider", this.aiProvider);

		this.ai = new this.aiProviders[this.aiProvider]();

		try {
			const providerConfig = window.workspace.aiConfig?.[this.aiProvider] || window.app.aiConfig?.[this.aiProvider];
			if (providerConfig) {
				const useWorkspaceSettings = !!window.workspace.aiConfig?.[this.aiProvider];
				await this.ai.setOptions(providerConfig, null, null, useWorkspaceSettings, useWorkspaceSettings ? 'workspace' : 'global');
			}
			await this.ai.init();
			this.historyManager.addMessage({
				type: "system_message",
				content: `AI provider switched to **${this.aiProvider}**. ` +
					(this.ai.isConfigured()
						? `Current model: **${this.ai.config.model}**`
						: `Please configure the provider settings.`),
				timestamp: Date.now()
			}, false);
		} catch (error) {
			console.error("AIManager: Error initializing new AI provider during switch:", error);
			this.historyManager.addMessage({
				type: "system_message",
				content: `Error switching to ${this.aiProvider} provider. Check settings. Details: ${error.message}`,
				timestamp: Date.now()
			}, false);
		} finally {
			// Always re-render settings form, update UI, and dispatch events
			this.settingsManager.renderForm();
			this._updateAIInfoDisplay();
			this._dispatchContextUpdate("ai_provider_switched");
			this.historyManager.render();
			this._setButtonsDisabledState(this._isProcessing);
			this._updatePromptAreaPlaceholder();
		}
	}

	toggleSettingsPanel() {
		this.chatContainer.classList.toggle("hidden")
		this.settingsManager.toggle(); // NEW: Use the manager

		// If settings panel is being hidden, re-render chat history
		if (!this.settingsPanel.classList.contains("active")) {
			this.historyManager.render() // Re-render history to show/hide welcome message
			this._dispatchContextUpdate("settings_closed") // Dispatch on settings panel close
		} else {
			// If settings panel is being shown, (re)render its content to reflect current values
			this._updateAIInfoDisplay(); // Ensure display is updated when panel opens
			this._dispatchContextUpdate("settings_opened") // Dispatch on settings panel open
		}
	}

	// Helper method to update progress bar color based on percentage
	_updateProgressBarColor(progressBarInner, percentage) {
		// Remove all color classes first
		progressBarInner.classList.remove("threshold-yellow", "threshold-orange", "threshold-red")

		if (percentage >= 90) {
			progressBarInner.classList.add("threshold-red")
		} else if (percentage >= 80) {
			progressBarInner.classList.add("threshold-orange")
		} else if (percentage >= 66) {
			progressBarInner.classList.add("threshold-yellow")
		}
		// If percentage is below 66, no specific color class is added,
		// and it will default to the original --theme color defined in CSS.
	}

	/**
	 * Centralized method to update context-sensitive UI elements like the progress bar and AI info display.
	 * This is now called directly by _dispatchContextUpdate.
	 * @param {object} detail - The event detail object from _dispatchContextUpdate.
	 */
	_updateContextUI(detail) {
		// Update Progress Bar
		if (this.progressBar && this.ai) {
			const { estimatedWindow, estimatedTokensFullHistory, maxContextTokens } = detail
			const progressBarInner = this.progressBar.querySelector(".progress-bar-inner")

			// Only show progress bar if AI is configured, otherwise hide or set to 0
			if (this.ai.isConfigured() && maxContextTokens > 0) {
				this.progressBar.style.display = "block";
				const percentage = Math.min(100, (estimatedWindow / maxContextTokens) * 100)
				progressBarInner.style.width = `${percentage}%`
				this.progressBar.setAttribute(
					"title",
					`Context: ${estimatedWindow} / ${maxContextTokens} tokens (${Math.round(percentage)}%)`
				)
				this._updateProgressBarColor(progressBarInner, percentage)
			} else {
				this.progressBar.style.display = "none"; // Hide progress bar if not configured
				progressBarInner.style.width = "0%";
				this.progressBar.setAttribute("title", `AI not configured or max tokens unknown.`);
				this._updateProgressBarColor(progressBarInner, 0); // Reset color
			}
		}
		// AI Info Display is updated by _updateAIInfoDisplay() directly.
	}

	// Method to update the AI info display element
	_updateAIInfoDisplay() {
		if (this.aiInfoDisplay && this.ai) {
			// Clear existing options
			this.aiInfoDisplay.innerHTML = "";
			
			// Populate options
			Object.keys(this.aiProviders).forEach(provider => {
				// Try to find the model name in current config or workspace/app settings
				const config = (provider === this.aiProvider) 
					? this.ai.config 
					: (window.workspace.aiConfig?.[provider] || window.app.aiConfig?.[provider]);

				// Suppress unconfigured providers from the quick list
				if (!config?.model) {
					return;
				}

				const option = document.createElement("option");
				option.value = provider;
				let label = provider.charAt(0).toUpperCase() + provider.slice(1);
				label += ` (${config.model})`;
				
				option.textContent = label;
				if (provider === this.aiProvider) {
					option.selected = true;
				}
				this.aiInfoDisplay.appendChild(option);
			});

			if (this.ai.isConfigured()) {
				const modelName = this.ai.config?.model || "No Model";
				this.aiInfoDisplay.setAttribute("title", `Provider: ${this.aiProvider}, Model: ${modelName}`);
			} else {
				this.aiInfoDisplay.setAttribute("title", `Provider: ${this.aiProvider}, Status: Not Configured`);
			}
		}
	}

	// Handler for 'setting-changed' events dispatched by AI provider instances
	_handleSettingChangedExternally(event) {
		this._updateAIInfoDisplay();
		this._dispatchContextUpdate("settings_change_external");
		this.historyManager.render(); // Re-render history to show/hide welcome message
		this._setButtonsDisabledState(this._isProcessing); // Ensure buttons are updated
		this._updatePromptAreaPlaceholder(); // Update placeholder
	}

	toggleRawView() {
		this.rawViewMode = !this.rawViewMode;
		this.rawViewButton.icon = this.rawViewMode ? "unfold_less" : "unfold_more";
		this.rawViewButton.classList.toggle("active", this.rawViewMode);
		this.historyManager.render();
	}

	// --- Session Management Delegation ---
	get allSessionMetadata() { return this.sessionsManager.allSessionMetadata; }
	set allSessionMetadata(val) { this.sessionsManager.allSessionMetadata = val; }

	get activeSessionId() { return this.sessionsManager.activeSessionId; }
	set activeSessionId(val) { this.sessionsManager.activeSessionId = val; }

	get activeSession() { return this.sessionsManager.activeSession; }
	set activeSession(val) { this.sessionsManager.activeSession = val; }

	get promptIndex() { return this.sessionsManager.promptIndex; }
	set promptIndex(val) { this.sessionsManager.promptIndex = val; }

	get _unsentPromptBuffer() { return this.sessionsManager._unsentPromptBuffer; }
	set _unsentPromptBuffer(val) { this.sessionsManager._unsentPromptBuffer = val; }

	async loadSessions(aiSessionsMetadata = [], activeSessionId = null) {
		return this.sessionsManager.loadSessions(aiSessionsMetadata, activeSessionId);
	}

	async createNewSession() {
		return this.sessionsManager.createNewSession();
	}

	async switchSession(sessionId) {
		return this.sessionsManager.switchSession(sessionId);
	}

	async deleteSession(sessionId, tab) {
		return this.sessionsManager.deleteSession(sessionId, tab);
	}

	async renameCurrentSession() {
		return this.sessionsManager.renameCurrentSession();
	}

	async proceedWithImplementationPlan(comment = "", isAccepted = true) {
		return this.sessionsManager.proceedWithImplementationPlan(comment, isAccepted);
	}

	_populateInitialTabs() {
		return this.sessionsManager._populateInitialTabs();
	}

	// The old _updateSessionUI method is no longer needed and has been removed.


	/**
	 * Dispatches a custom 'context-update' event with the current chat state.
	 * This now also includes the metadata for workspace and full data for the active session.
	 * @param {string} type - The type of update (e.g., 'append_user', 'summarize', 'clear', 'settings_change').
	 * @param {object} [details={}] - Additional details relevant to the update type.
	 */
	_dispatchContextUpdate(type, details = {}) {
		// Ensure ai, historyManager are available
		if (!this.ai || !this.historyManager) {
			console.warn("Attempted to dispatch context update before AI or History Manager was ready.");
			return;
		}

		// Calculate tokens based on the active session's messages
		const estimatedTokensFullHistory = (this.ai.isConfigured() && this.activeSession) ? this.ai.estimateTokens(this.activeSession.messages) : 0;
		const estimatedWindow = (this.ai.isConfigured() && this.activeSession) ? this.ai.estimateTokens(this.historyManager.prepareMessagesForAI()) : 0;
		const maxContextTokens = this.ai.isConfigured() ? this.ai.MAX_CONTEXT_TOKENS : 0;

		const shouldPassSessionData = this.activeSession && type !== "session_deleted" && type !== "session_closed";

		const eventDetail = {
			aiProvider: this.aiProvider,
			runMode: "chat", // Always chat mode now
			estimatedTokensFullHistory: estimatedTokensFullHistory,
			estimatedWindow: estimatedWindow,
			maxContextTokens: maxContextTokens,
			type: type,
			// NEW: Pass the metadata for workspace and a deep copy of the full active session for IndexedDB save
			aiSessionsMetadata: {
				activeSessionId: this.activeSessionId,
				sessions: JSON.parse(JSON.stringify(this.allSessionMetadata)) // Deep copy to prevent mutation issues
			},
			activeSessionData: shouldPassSessionData ? JSON.parse(JSON.stringify(this.activeSession)) : null, // Deep copy of active session
			...details,
		};

		// Directly update the AIManager's own UI (progress bar) before dispatching
		this._updateContextUI(eventDetail);
		this._setButtonsDisabledState(this._isProcessing);

		this.panel.dispatchEvent(new CustomEvent("context-update", { detail: eventDetail }))
	}

	stopAgent() {
		this._abortAgent = true;
		if (this.ai && typeof this.ai.stop === 'function') {
			this.ai.stop();
		}
		this._isProcessing = false;
		this._setButtonsDisabledState(false);
		this.consecutiveHaltCount = 0;
		if (this.haltBar) {
			this.haltBar.remove();
			this.haltBar = null;
		}
	}

	pauseAgent() {
		this.isPaused = true;
		this.pauseButton.innerHTML = `<ui-icon>play_arrow</ui-icon> Resume`;
		this.pauseButton.classList.replace("pause-btn", "resume-btn");
	}

	resumeAgent() {
		this.isPaused = false;
		this.pauseButton.innerHTML = `<ui-icon>pause</ui-icon> Pause`;
		this.pauseButton.classList.replace("resume-btn", "pause-btn");
	}

	_showHaltBar(modelMessageId, responseBlock, warnBlock) {
		if (this.haltBar) {
			this.haltBar.remove();
		}

		const haltBar = document.createElement("div");
		haltBar.className = "agent-halt-bar";
		if (this.autoContinue) {
			haltBar.classList.add("auto-continue-enabled");
		}

		haltBar.innerHTML = `
			<ui-icon style="vertical-align: middle; margin-right: 8px; font-size: 16px;">warning</ui-icon>
			<span class="halt-text">⚠️ Agent Loop Halted: No tool calls generated. There may be an issue.</span>
			<div class="halt-actions" style="display: flex; gap: 8px; align-items: center; margin-left: 12px;">
				<button class="halt-toggle theme-button secondary" style="padding: 4px 8px; font-size: 11px; min-width: 120px; background: rgba(255, 255, 255, 0.2); color: inherit; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: var(--borderRadius); cursor: pointer; font-weight: 600;">
					Auto-Continue: ${this.autoContinue ? 'ON' : 'OFF'}
				</button>
				<button class="halt-continue theme-button" style="padding: 4px 8px; font-size: 11px; min-width: 80px; border-radius: var(--borderRadius); cursor: pointer; font-weight: 600;">Continue &gt;</button>
			</div>
		`;

		const toggleBtn = haltBar.querySelector(".halt-toggle");
		const continueBtn = haltBar.querySelector(".halt-continue");

		const warnContinueBtn = warnBlock ? warnBlock.querySelector(".warn-continue-btn") : null;
		const warnAutoToggle = warnBlock ? warnBlock.querySelector(".warn-auto-toggle") : null;

		const syncUIState = () => {
			toggleBtn.innerText = `Auto-Continue: ${this.autoContinue ? 'ON' : 'OFF'}`;
			if (this.autoContinue) {
				haltBar.classList.add("auto-continue-enabled");
			} else {
				haltBar.classList.remove("auto-continue-enabled");
			}
			if (warnAutoToggle) {
				warnAutoToggle.checked = this.autoContinue;
			}
		};

		const handleToggle = () => {
			this.autoContinue = !this.autoContinue;
			localStorage.setItem("aiAutoContinue", this.autoContinue);
			syncUIState();
			if (this.autoContinue) {
				handleContinue();
			}
		};

		const handleContinue = async () => {
			if (this.haltBar) {
				this.haltBar.remove();
				this.haltBar = null;
			}
			if (warnBlock && warnBlock.parentNode) {
				warnBlock.remove();
			}
			if (responseBlock && responseBlock.parentNode) {
				responseBlock.remove();
			}

			// Strip last model message
			if (this.activeSession && this.activeSession.messages) {
				this.activeSession.messages = this.activeSession.messages.filter(m => m.id !== modelMessageId);
				this.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);
			}

			this.consecutiveHaltCount = 0; // Reset manual continue count
			this._isProcessing = true;
			this._setButtonsDisabledState(true);
			await this._runAgentLoop(null, null);
		};

		toggleBtn.onclick = handleToggle;
		continueBtn.onclick = handleContinue;

		if (warnContinueBtn) {
			warnContinueBtn.onclick = handleContinue;
		}
		if (warnAutoToggle) {
			warnAutoToggle.onchange = (e) => {
				this.autoContinue = e.target.checked;
				localStorage.setItem("aiAutoContinue", this.autoContinue);
				syncUIState();
				if (this.autoContinue) {
					handleContinue();
				}
			};
		}

		this.chatContainer.append(haltBar);
		this.haltBar = haltBar;
	}

	async generate() {
		if (this._isProcessing) {
			console.warn("AI is currently processing another request. Please wait.")
			return
		}

		this.consecutiveHaltCount = 0; // Reset on new user prompt submission
		this._abortAgent = false;
		if (!this.ai || !this.ai.isConfigured()) {
			console.warn("AI is not configured. Cannot generate response.");
			window.modal.notice("AI provider is not configured. Please open the Settings panel (gear icon) to set up your API keys and select a model.", "AI Not Configured");
			this._isProcessing = false;
			this._setButtonsDisabledState(false);
			return;
		}

		if (!this.activeSession) {
			console.log("No active session found. Automatically creating a new session...");
			const promptValue = this.promptEditor.getValue();
			await this.createNewSession();
			// Wait a brief moment for the tab switch and activeSession setup to complete
			await new Promise(resolve => setTimeout(resolve, 200));
			if (!this.activeSession) {
				window.modal.notice("No active chat session. Please click the '+' icon or select a tab to start chatting.", "No Active Session");
				this._isProcessing = false;
				this._setButtonsDisabledState(false);
				return;
			}
			this.promptEditor.setValue(promptValue, -1);
		}

		// Clear min-height from all previous response blocks to let them reflow naturally.
		this.conversationArea.querySelectorAll('.response-block').forEach(block => {
			block.style.minHeight = '';
		});
		// // NEW: Clear min-height from the previous response block if it exists
		// const lastResponseBlockInHistory = this.conversationArea.lastElementChild;
		// if (lastResponseBlockInHistory && lastResponseBlockInHistory.classList.contains("response-block")) {
		// 	lastResponseBlockInHistory.style.minHeight = '';
		// }


		this._unsentPromptBuffer = null; // Clear the unsent prompt buffer on submission.
		this._isProcessing = true
		this._setButtonsDisabledState(true)

		const userPrompt = this.promptEditor.getValue().trim()

		if (!userPrompt) {
			this._isProcessing = false
			this._setButtonsDisabledState(false)
			return
		}

		// if (lastPrompt && lastPrompt === userPrompt) {
		// 	console.log("Skipping adding duplicate contiguous prompt to history.");
		// 	this.promptIndex = activePromptHistory.length; // Keep index at end
		// } else {
		// 	activePromptHistory.push(userPrompt);
		// 	while (activePromptHistory.length > MAX_PROMPT_HISTORY) {
		// 		activePromptHistory.shift();
		// 		if (this.promptIndex > 0) {
		// 			this.promptIndex--;
		// 		}
		// 	}
		// 	this.promptIndex = activePromptHistory.length; // Set index to end after adding
		// }

		// No longer dispatch "new-prompt" globally, prompt history is per-session

		// Check for automatic summarization before processing the new prompt
		const estimatedTokensBeforeNewPrompt = this.ai.estimateTokens(this.activeSession.messages)
		const maxContextTokens = this.ai.MAX_CONTEXT_TOKENS
		if (
			maxContextTokens > 0 &&
			(estimatedTokensBeforeNewPrompt / maxContextTokens) * 100 >= this.config.summarizeThreshold
		) {
			console.log(
				`Context at ${Math.round(
					(estimatedTokensBeforeNewPrompt / maxContextTokens) * 100
				)}%, triggering summarization.`
			)
			await this.historyManager.performSummarization() // Await summarization before continuing
		}
		// NEW: Check for stale context files and handle user interaction
		const proceed = await this._checkForStaleContextFiles(userPrompt);
		if (!proceed) {
			// Abort was chosen. _checkForStaleContextFiles handles restoration.
			return;
		}
		// Now that checks are passed, add prompt to history and clear the editor
		const activePromptHistory = this.activeSession.promptHistory;
		const lastPrompt = activePromptHistory.length > 0 ? activePromptHistory[activePromptHistory.length - 1].trim() : null;
		if (lastPrompt && lastPrompt === userPrompt) {
			console.log("Skipping adding duplicate contiguous prompt to history.");
			this.promptIndex = activePromptHistory.length; // Keep index at end
		} else {
			activePromptHistory.push(userPrompt);
			while (activePromptHistory.length > MAX_PROMPT_HISTORY) {
				activePromptHistory.shift();
				if (this.promptIndex > 0) this.promptIndex--;
			}
			this.promptIndex = activePromptHistory.length; // Set index to end after adding
		}
		this.promptEditor.setValue("");
		this._resizePromptArea();
		// Process prompt for @ tags, always using "chat" logic now.
		const { processedPrompt, contextItems } = await this.ai._getContextualPrompt(
            userPrompt, 
            "chat", 
            this.activeSession.evergreenFiles,
            this.agentMode
        )

		// NEW: Remove any existing context items for the same files being added in this turn
		if (contextItems.length > 0) {
			const newFileIds = new Set(contextItems.map(item => item.id));
			this.activeSession.messages = this.activeSession.messages.filter(msg =>
				!(msg.type === "file_context" && newFileIds.has(msg.id))
			);
		}

		// Update active session's messages
		contextItems.forEach((item) => {
			const contextMessage = {
				type: "file_context",
				id: item.id, // This is the unique path
				filename: item.filename,
				language: item.language,
				content: item.content,
				timestamp: Date.now(),
				mode: this.agentMode ? 'outline' : 'full',
			};
			
			if (this.agentMode) {
				window.conduit.wsGetOutline(item.id).then(res => {
					contextMessage.outline = res.data;
					this.historyManager.render();
				}).catch(err => console.error("Failed to get outline", err));
			}

			this.activeSession.messages.push(contextMessage);
			// NEW: Add context files to the file bar instead of the main chat area
			this.fileBar.add(contextMessage);
		});

		let userMessage = null;
		let userMessageElement = null; // To hold the DOM element of the user's prompt
		if (processedPrompt) {
			userMessage = { role: "user", type: "user", content: processedPrompt, timestamp: Date.now(), id: crypto.randomUUID() };
			this.activeSession.messages.push(userMessage);
			userMessageElement = this.historyManager.appendMessageElement(userMessage);
		} else {
			// Scenario: Context items were added, but no user prompt was given.
			// In this case, we don't call the AI, acknowledge the context addition, and abort.
			if (contextItems.length > 0) {
				const fileNames = contextItems.map(item => `**${item.filename}**`).join(', ');
				this.historyManager.addMessage({
					type: "system_message",
					content: `Files added to context: ${fileNames}.`,
					timestamp: Date.now(),
				}, false);
				// We still need to save the session since context items were added.
				this.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);
				this._dispatchContextUpdate("context_files_updated");
			}
			this._isProcessing = false; // Release lock
			this._setButtonsDisabledState(false); // Re-enable buttons
			return; // Exit the function as there's no prompt to send to the AI.
		}

		// Save session and dispatch update now that we've confirmed there's a user prompt.
		// Update lastModified timestamp for the session
		this.activeSession.lastModified = Date.now();
		// Save the active session to IndexedDB immediately after adding user prompt and context
		await workspaceClient.setSession(this.activeSession.id, this.activeSession);

		// Render updated history in UI and dispatch event
		// this.historyManager.render(); // NO LONGER NEEDED, using dynamic appends
		this._dispatchContextUpdate("append_user"); // This will also save workspace metadata

		// Auto-rename if this is the first message and the name is default
		if (this.activeSession.messages.filter(m => m.type === 'user').length === 1 && this.activeSession.name.startsWith("Chat ")) {
			// Don't await it, let it run in the background
			this.sessionsManager.autoRenameSession(userMessage.content);
		}

		if (this.agentMode) {
			await this._runAgentLoop(userMessage, userMessageElement);
			return;
		}
		// NEW: Create and append the new ui-loader-bar *before* the response block
		// Ensure we calculate the space needed for the loader + response block, accounting for the file bar.
		const fileBarContainer = this.panel.querySelector('.ai-filebar-container');
		const fileBarHeight = fileBarContainer ? fileBarContainer.offsetHeight : 0;
		const availableHeightForResponse = this.conversationArea.clientHeight - (fileBarHeight + 16);

		// Prepare placeholder for AI response
		const modelMessageId = crypto.randomUUID(); // Pre-generate ID for the upcoming model response
		const responseBlock = this.historyManager.createStreamingBlock(modelMessageId);
		const spinner = this._createSpinner(); // Create the new spinner
		if (!this.rawViewMode) {
			responseBlock.append(spinner); // Add spinner to the response block only in standard mode
		}
		// NEW: Set a temporary min-height to ensure the scroll area is large enough
		this.conversationArea.append(responseBlock);
		responseBlock.style.minHeight = `${Math.max(50, availableHeightForResponse)}px`; // Ensure a minimum of 50px

		// NEW: Scroll the conversation area so the user's prompt is near the top.
		if (userMessageElement) {
			// We account for the sticky file bar's height, just like you remembered!
			const fileBarContainer = this.panel.querySelector('.ai-filebar-container');
			const fileBarOffset = fileBarContainer ? fileBarContainer.offsetHeight : 0;
			const PADDING_FROM_TOP = 8; // A little extra breathing room
			this.conversationArea.scrollTop = userMessageElement.offsetTop - fileBarOffset - PADDING_FROM_TOP;
		}

		const callbacks = {
			onUpdate: (fullResponse) => { // Update the responseBlock directly
				if (spinner.parentNode) spinner.remove(); // Remove spinner on first stream chunk
				const shouldScroll = this._shouldAutoScroll();
				responseBlock.updateContent(fullResponse);
				if (shouldScroll && this.conversationArea) {
					this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
				}
			},
			onDone: async (fullResponse, contextRatioPercent) => { // Mark async to await set
				// First, update the session data and add the delete button to the user's prompt.
				const modelMessage = { id: modelMessageId, role: "model", type: "model", content: fullResponse, diffStatuses: [], timestamp: Date.now() };
				if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
					modelMessage.toolCalls = callbacks.toolCalls;
				}
				if (callbacks.thoughtSignature) {
					modelMessage.thoughtSignature = callbacks.thoughtSignature;
				}
				this.activeSession.messages.push(modelMessage);
				this.historyManager.addInteractionToLastUserMessage(userMessage); // Add delete button to user prompt
				this.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);

				// Now, render the final response in the UI using finalize().
				responseBlock.finalize(fullResponse, modelMessage);

				// NEW: Chat-mode output checks for diff blocks
				if (!this.agentMode) {
					const diffBlocks = responseBlock.querySelectorAll("pre[data-original-diff-content]");
					if (diffBlocks.length > 0) {
						let anyFailed = false;
						let failedFilename = "";
						let failedPath = "";
						
						for (let index = 0; index < diffBlocks.length; index++) {
							const pre = diffBlocks[index];
							const rawDiff = pre.dataset.originalDiffContent;
							if (!rawDiff) continue;

							const targetPathMatch = rawDiff.match(/^\+\+\+ b\/(.+)$/m) || rawDiff.match(/^\+\+\+ (.+)$/m);
							if (!targetPathMatch || !targetPathMatch[1]) continue;

							const targetPath = targetPathMatch[1];
							let tab = await this.ai._getTabSessionByPath(targetPath);
							if (!tab) {
								const fileData = this.ai._findFileByPath(targetPath);
								if (fileData && window.ui && window.ui.fileList && window.ui.fileList.open) {
									await window.ui.fileList.open(fileData);
									tab = await this.ai._getTabSessionByPath(fileData.path);
								}
							}

							let currentContent = "";
							if (tab && tab.config && tab.config.session) {
								currentContent = tab.config.session.getValue();
							} else {
								// Fallback: try looking in file_context from history
								let contextContent = null;
								const normalizedTargetPath = targetPath.startsWith('/') ? targetPath.substring(1) : targetPath;
								for (let i = this.activeSession.messages.length - 1; i >= 0; i--) {
									const msg = this.activeSession.messages[i];
									if (msg.type === "file_context" && msg.id) {
										const normalizedMsgId = msg.id.startsWith('/') ? msg.id.substring(1) : msg.id;
										if (normalizedMsgId === normalizedTargetPath || normalizedMsgId.endsWith(normalizedTargetPath)) {
											contextContent = msg.content;
											break;
										}
									}
								}
								if (contextContent !== null) {
									currentContent = contextContent;
								}
							}

							const testMergedContent = DiffHandler.applyAIResponseDiff(currentContent, rawDiff);
							if (testMergedContent === null) {
								anyFailed = true;
								failedPath = targetPath;
								failedFilename = targetPath.split('/').pop();
								break;
							} else if (this.forgivenessMode) {
								// Chat+forgiveness mode: Successful merge commits directly to the current file buffer (Ace session)
								if (tab && tab.config && tab.config.session) {
									const filePathForBackup = tab.config.path;
									let backupId = "";
									const activeSession = this.activeSession;
									const hasExistingBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[filePathForBackup] && activeSession.modifiedFiles[filePathForBackup].length > 0;

									if (hasExistingBackup) {
										backupId = activeSession.modifiedFiles[filePathForBackup][0].backupId;
									} else {
										try {
											const actId = modelMessage.id || activeSession?.id || "default";
											backupId = await AgentBackup.create(filePathForBackup, currentContent, actId);
											
											if (activeSession) {
												activeSession.modifiedFiles = activeSession.modifiedFiles || {};
												if (!activeSession.modifiedFiles[filePathForBackup]) {
													activeSession.modifiedFiles[filePathForBackup] = [];
												}
												activeSession.modifiedFiles[filePathForBackup].push({
													backupId: backupId,
													timestamp: Date.now(),
													sourceId: actId
												});
											}
										} catch (e) {
											console.error("[ChatDiff] Failed to create backup:", e);
										}
									}

									// Commit merged content to current editor buffer (without saving)
									const session = tab.config.session;
									const doc = session.getDocument();
									const lastRow = doc.getLength() - 1;
									const lastCol = doc.getLine(lastRow).length;
									const Range = (window.ace.require ? window.ace.require("ace/range").Range : null) || window.ace.Range;
									const fullRange = new Range(0, 0, lastRow, lastCol);
									session.replace(fullRange, testMergedContent);
									
									// Enable diff review tracking vs current buffer
									tab.config.viewMode = "diff";
									tab.config.backupId = backupId;
									
									// Mark as applied in modelMessage and update apply button UI
									modelMessage.diffStatuses[index] = true;
									
									const applyBtn = pre.querySelector("ui-button:not(.expand-collapse-button)");
									if (applyBtn) {
										applyBtn.classList.remove("diff-apply-failed");
										applyBtn.classList.add("diff-apply-success");
										applyBtn.icon = "done";
										applyBtn.title = "Diff applied successfully!";
									}

									// Focus and Redraw (activates split diff view automatically)
									tab.click();

									this.historyManager.addMessage({
										type: "system_message",
										content: `Diff successfully applied to **${targetPath}** in Forgiveness Mode. Remember to save the file.`,
										timestamp: Date.now(),
									});
								}
							}
						}

						if (anyFailed) {
							// Notify user of failed merge and ask for choice
							const choice = await window.modal.confirm(
								`The generated diff for <strong>${failedFilename}</strong> could not be applied automatically. Would you like to review it manually or retry?`,
								"Diff Application Failed",
								["Manual Review", "Retry"]
							);
							if (choice === false) { // "Retry" is second button (resolves to false)
								this.promptEditor.setValue(`your diff for ${failedPath} could not be applied, please try again`);
								this.generate();
							}
						} else if (this.forgivenessMode) {
							// Update IndexedDB to persist the updated diffStatuses and backup references
							await workspaceClient.setSession(this.activeSession.id, this.activeSession);
						}
					}
				}

				this._dispatchContextUpdate("append_model") // Dispatch after model response

				this._isProcessing = false // Release lock
				this._setButtonsDisabledState(false) // Re-enable buttons
			},
			onError: async (error) => { // Mark async to await set
				// The spinner is also removed here when innerHTML is overwritten.
				responseBlock.style.minHeight = ''; // Reset min-height on error too
				if (typeof responseBlock.updateContent === 'function') {
					responseBlock.updateContent(`Error: ${error.message}`);
				} else {
					responseBlock.innerHTML = `Error: ${error.message}`;
				}
				console.error(`Error calling ${this.ai.config.model} API:`, error);

				const errorMessage = {
					id: modelMessageId, // Use the pre-generated ID for the block
					role: "error",
					type: "error",
					content: `Error: ${error.message}`,
					timestamp: Date.now(),
					diffStatuses: [], // Initialize even for errors, though no diffs expected here
				};
				this.activeSession.messages.push(errorMessage);
				// Update lastModified timestamp and save the active session
				// No interaction added for errors.
				this.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);

				this._dispatchContextUpdate("append_error")

				this._isProcessing = false
				this._setButtonsDisabledState(false)
			},
			onContextRatioUpdate: (ratio) => { /* ... */ },
		}

		// Since we now return early if `processedPrompt` is empty, we can unconditionally call the AI here.
		const messagesForAI = this.historyManager.prepareMessagesForAI()
		const systemPrompt = await this.getSystemPrompt();
		this.ai.chat(messagesForAI, callbacks, systemPrompt)
	}

	_parseToolCalls(content) {
		const parsed = this.messageRenderer.parseBlocks(content);
		const tc = parsed.toolCallBlocks.find(b => b.closed);
		if (!tc) return null;

		const toolName = tc.name;
		const toolArgsContent = content.substring(tc.contentStartIdx, tc.contentEndIdx);
		const args = {};

		// Extract any nested XML tags as args
		const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
		let tagMatch;
		while ((tagMatch = tagRegex.exec(toolArgsContent)) !== null) {
			const key = tagMatch[1];
			let val = tagMatch[2];
			if (key !== 'search' && key !== 'replace' && key !== 'content') {
				val = val.trim();
			}
			args[key] = val;
		}

		return {
			name: toolName,
			arguments: args,
			raw: content.substring(tc.startIdx, tc.endIdx)
		};
	}

	_parseAllToolCalls(content) {
		if (!content) return [];
		const parsed = this.messageRenderer.parseBlocks(content);
		const closedTcs = parsed.toolCallBlocks.filter(b => b.closed);
		if (closedTcs.length === 0) return [];

		return closedTcs.map(tc => {
			const toolName = tc.name;
			const toolArgsContent = content.substring(tc.contentStartIdx, tc.contentEndIdx);
			const args = {};

			const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
			let tagMatch;
			while ((tagMatch = tagRegex.exec(toolArgsContent)) !== null) {
				const key = tagMatch[1];
				let val = tagMatch[2];
				if (key !== 'search' && key !== 'replace' && key !== 'content') {
					val = val.trim();
				}
				args[key] = val;
			}

			return {
				name: toolName,
				arguments: args,
				raw: content.substring(tc.startIdx, tc.endIdx)
			};
		});
	}

	_validateToolArguments(toolCall) {
		if (!toolCall) return null;
		if (this.planningMode && (toolCall.name === "create_file" || toolCall.name === "edit_file")) {
			return `Tool Error: Tool "${toolCall.name}" is not allowed while in planning mode.`;
		}
		const toolDef = tools.find(t => t.name === toolCall.name);
		if (toolDef && toolDef.parameters && Array.isArray(toolDef.parameters.required)) {
			const args = toolCall.arguments || {};
			for (const reqParam of toolDef.parameters.required) {
				if (args[reqParam] === undefined || args[reqParam] === null || (args[reqParam] === "" && reqParam !== "replace" && reqParam !== "content")) {
					return `Tool Error: ${toolCall.name} requires "${reqParam}" parameter`;
				}
			}
		}
		return null;
	}

	_showAgentApprovalCard(toolCall) {
		return new Promise((resolve) => {
			const card = document.createElement("div");
			card.className = "agent-approval-card";

			let detailHtml = "";
			if (toolCall.name === "edit_file") {
				detailHtml = `
					<div class="approval-header">
						<ui-icon>edit</ui-icon>
						<span>Approve File Edit</span>
					</div>
					<div class="approval-path">File: <code>${toolCall.arguments.path}</code></div>
					<div class="approval-diff-preview">
						<div class="diff-section remove">
							<span class="diff-label">Remove:</span>
							<pre><code>${this._escapeHtml(toolCall.arguments.search)}</code></pre>
						</div>
						<div class="diff-section add">
							<span class="diff-label">Add:</span>
							<pre><code>${this._escapeHtml(toolCall.arguments.replace)}</code></pre>
						</div>
					</div>
				`;
			} else if (toolCall.name === "create_file") {
				detailHtml = `
					<div class="approval-header">
						<ui-icon>note_add</ui-icon>
						<span>Approve New File Creation</span>
					</div>
					<div class="approval-path">File: <code>${toolCall.arguments.path}</code></div>
					<div class="approval-diff-preview">
						<div class="diff-section add">
							<span class="diff-label">Content:</span>
							<pre><code>${this._escapeHtml(toolCall.arguments.content.slice(0, 500))}${toolCall.arguments.content.length > 500 ? '\n... (truncated)' : ''}</code></pre>
						</div>
					</div>
				`;
			}

			card.innerHTML = `
				<div class="card-summary-header" style="display: none;">
					<ui-icon>${toolCall.name === 'edit_file' ? 'edit' : 'note_add'}</ui-icon>
					<span class="summary-status"></span>
					<span class="summary-path">${toolCall.arguments.path}</span>
					<ui-icon class="expand-indicator">expand_more</ui-icon>
				</div>
				<div class="card-details-content">
					${detailHtml}
					<div class="approval-actions">
						<button class="approve-btn theme-button primary"><ui-icon>check</ui-icon> Approve</button>
						<button class="reject-btn theme-button secondary"><ui-icon>close</ui-icon> Reject</button>
					</div>
				</div>
			`;

			const approveBtn = card.querySelector('.approve-btn');
			const rejectBtn = card.querySelector('.reject-btn');
			const summaryHeader = card.querySelector('.card-summary-header');
			const summaryStatus = card.querySelector('.summary-status');
			const actionsDiv = card.querySelector('.approval-actions');

			const finalizeCard = (statusText, className) => {
				card.classList.add(className);
				card.classList.add('action-decided');

				// Hide approval buttons completely
				if (actionsDiv) actionsDiv.remove();

				// Set collapsed summary info
				if (summaryStatus) summaryStatus.textContent = statusText;
				if (summaryHeader) summaryHeader.style.display = 'flex';

				// Add click listener to toggle expanding
				summaryHeader.addEventListener('click', (e) => {
					e.stopPropagation();
					card.classList.toggle('expanded');
				});
			};

			approveBtn.addEventListener('click', () => {
				finalizeCard(toolCall.name === 'edit_file' ? 'Edited' : 'Created', 'approved');
				resolve(true);
			});

			rejectBtn.addEventListener('click', () => {
				finalizeCard(toolCall.name === 'edit_file' ? 'Rejected Edit' : 'Rejected Creation', 'rejected');
				resolve(false);
			});

			const shouldScroll = this._shouldAutoScroll();
			this.conversationArea.append(card);
			if (shouldScroll && this.conversationArea) {
				this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
			}
		});
	}



	_escapeHtml(text) {
		if (!text) return "";
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	async _runAgentLoop(userMessage, userMessageElement) {
		let loopCount = 0;
		const maxLoops = 15;
		this._abortAgent = false;
		let isThrottled = true;
		let throttleBar = null;

		while (this._isProcessing) {
			if (this._abortAgent) break;

			loopCount++;

			if (loopCount > maxLoops) {
				if (!throttleBar) {
					throttleBar = document.createElement("div");
					throttleBar.className = "agent-throttle-bar";
					throttleBar.innerHTML = `
						<ui-icon style="vertical-align: middle; margin-right: 4px; font-size: 16px;">speed</ui-icon>
						<span class="throttle-text"></span>
						<ui-button class="throttle-toggle theme-button" style="padding: 4px 8px; font-size: 11px; margin-left: 12px; min-width: 80px;">Continue &gt;</ui-button>
					`;
					const btn = throttleBar.querySelector('.throttle-toggle');
					btn.onclick = () => {
						isThrottled = !isThrottled;
						if (isThrottled) {
							btn.innerText = "Continue >";
							throttleBar.classList.remove('unthrottled');
						} else {
							btn.innerText = "Throttle";
							throttleBar.classList.add('unthrottled');
						}
					};
					this.chatContainer.append(throttleBar);
				}
				throttleBar.querySelector('.throttle-text').innerText = `Agent execution throttled due to long running task: ${loopCount} of ${maxLoops} iterations`;

				if (isThrottled) {
					await new Promise(r => setTimeout(r, 7000));
				}
			}

			const modelMessageId = crypto.randomUUID();
			const responseBlock = this.historyManager.createStreamingBlock(modelMessageId);
			const spinner = this._createSpinner();
			if (!this.rawViewMode) {
				responseBlock.append(spinner);
			}
			const shouldScrollAtStart = this._shouldAutoScroll();
			this.conversationArea.append(responseBlock);

			// Auto scroll
			if (shouldScrollAtStart && this.conversationArea) {
				this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
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
						if (spinner.parentNode) spinner.remove();
						const shouldScroll = this._shouldAutoScroll();
						responseBlock.updateContent(fullResponse);
						if (shouldScroll && this.conversationArea) {
							this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
						}

						// Scan streaming tokens for early truncation
						const check = this._checkStreamingResponse(fullResponse);
						if (check.shouldAbort) {
							streamForciblyEnded = true;
							forcedReason = check.reason;
							this.ai.stop(check.reason);
							
							// Save immediately since ai.stop throws AbortError which doesn't trigger onError
							this._finalizeModelMessage(currentFullResponse, forcedReason, callbacks, modelMessageId, responseBlock)
								.then(finalizedResponse => resolve(finalizedResponse))
								.catch(err => reject(err));
						}
					},
					onDone: async (fullResponse) => {
						if (streamForciblyEnded) return;
						currentFullResponse = fullResponse;
						const finalizedResponse = await this._finalizeModelMessage(fullResponse, null, callbacks, modelMessageId, responseBlock);
						resolve(finalizedResponse);
					},
					onError: async (err) => {
						// Stream forcibly ended logic is now handled in onUpdate directly.
						if (streamForciblyEnded) {
							// We shouldn't hit this, but just in case, resolve without saving twice.
							resolve(currentFullResponse);
							return;
						}
						reject(err);
					}
				};

				messagesForAI = this.historyManager.prepareMessagesForAI();
				this.getSystemPrompt().then(sysPrompt => {
					systemPrompt = sysPrompt;
					this.ai.chat(messagesForAI, callbacks, systemPrompt);
				}).catch(reject);
			});

			try {
				const responseContent = await runPromise;

				// Removed legacy XML plan parsing logic

				// Parse tool calls
				const toolCalls = this._parseAllToolCalls(responseContent);
				const regex = /<[^>]*>/g;
				
				if (toolCalls.length === 0) {
					if(responseContent.replace(regex, "").length > 50) {
						this._isProcessing = false;
						this._setButtonsDisabledState(false);
						return
					}
					// No more tool calls: agent is done!
					if (!responseContent.includes("<complete_task>")) {
						// Auto-continue logic
						if (this.autoContinue && this.consecutiveHaltCount < 3) {
							this.consecutiveHaltCount++;
							console.warn(`⚠️ [Agent Loop Halted] Auto-continuing (Attempt ${this.consecutiveHaltCount} of 3)...`);

							// Strip the last model turn
							if (this.activeSession && this.activeSession.messages) {
								this.activeSession.messages = this.activeSession.messages.filter(m => m.id !== modelMessageId);
								this.activeSession.lastModified = Date.now();
								await workspaceClient.setSession(this.activeSession.id, this.activeSession);
							}
							if (responseBlock && responseBlock.parentNode) {
								responseBlock.remove();
							}

							// Render temporary auto-continue indicator
							const autoMsg = document.createElement("div");
							autoMsg.className = "agent-tool-progress";
							autoMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> Agent loop halted. Auto-continuing (Attempt ${this.consecutiveHaltCount} of 3)...`;
							this.conversationArea.append(autoMsg);
							if (this._shouldAutoScroll() && this.conversationArea) {
								this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
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
									<input type="checkbox" class="warn-auto-toggle" ${this.autoContinue ? 'checked' : ''} style="cursor: pointer; width: 13px; height: 13px;">
									Auto-Continue
								</label>
							</div>
						`;
						this.conversationArea.append(warnBlock);

						// LOG the last request to console.warn() for troubleshooting
						console.warn("⚠️ [Agent Loop Halted] The model stopped generating without producing a tool call or completing a task. Last Request Details:", {
							systemPrompt,
							messages: messagesForAI,
							modelResponse: responseContent
						});

						const shouldScroll = this._shouldAutoScroll();
						if (shouldScroll && this.conversationArea) {
							this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
						}

						// Show the persistent bottom halt bar
						this._showHaltBar(modelMessageId, responseBlock, warnBlock);
					}

					this._isProcessing = false;
					this._setButtonsDisabledState(false);
					this._dispatchContextUpdate("append_model");
					break;
				}

				// Reset consecutive halt count since the agent generated valid tool calls
				this.consecutiveHaltCount = 0;

				// Execute all parsed tool calls sequentially
				let accumulatedResponses = [];
				let hasPlan = false;
				let hasDone = false;

				for (const toolCall of toolCalls) {
					let toolResult = "";
					let approved = true;

					// Validate required arguments before executing or showing approvals
					const validationError = this._validateToolArguments(toolCall);
					if (validationError) {
						accumulatedResponses.push(`[Tool Response: ${toolCall.name}]\n\n${validationError}`);

						// Render tool finished/failed block in the chat
						const toolConfBlock = document.createElement("div");
						toolConfBlock.className = "agent-tool-finished";
						toolConfBlock.innerHTML = `
							<ui-icon style="color: var(--color-error, #dc3545);">close</ui-icon>
							<span>Tool <code>${toolCall.name}</code> failed validation.</span>
						`;
						const shouldScroll = this._shouldAutoScroll();
						this.conversationArea.append(toolConfBlock);
						if (shouldScroll && this.conversationArea) {
							this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
						}
						continue;
					}

					// Identify if tool is destructive
					const isDestructive = ["create_file"].includes(toolCall.name);
					if (isDestructive) {
						approved = await this._showAgentApprovalCard(toolCall);
					}

					if (approved) {
						// Add temporary message block explaining what tool is running
						const progressMsg = document.createElement("div");
						progressMsg.className = "agent-tool-progress";
						progressMsg.innerHTML = `<ui-icon class="spin">cached</ui-icon> Running tool: <code>${toolCall.name}</code>...`;
						const shouldScroll = this._shouldAutoScroll();
						this.conversationArea.append(progressMsg);
						if (shouldScroll && this.conversationArea) {
							this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
						}

						try {
							toolResult = await agentTools.execute(toolCall.name, toolCall.arguments, this.activeSession.id);
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
						<ui-icon>${approved ? 'done' : 'close'}</ui-icon>
						<span>Tool <code>${toolCall.name}</code> finished.</span>
					`;
					const shouldScroll = this._shouldAutoScroll();
					this.conversationArea.append(toolConfBlock);
					if (shouldScroll && this.conversationArea) {
						this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
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
					this.activeSession.messages.push(toolResponseMessage);
					this.activeSession.lastModified = Date.now();
					await workspaceClient.setSession(this.activeSession.id, this.activeSession);
				}

				if (hasPlan || hasDone) {
					this._isProcessing = false;
				}

				// Update the model message block in the DOM to reflect the actual tool execution status (failed or invoked)
				const modelMessage = this.activeSession.messages.find(m => m.id === modelMessageId);
				if (modelMessage) {
					responseBlock.innerHTML = this.messageRenderer.renderResponseContent(responseContent, modelMessage, true);
					this.messageRenderer.addCodeBlockButtons(responseBlock, modelMessage);
				}

				// If the agent created a plan or finished, we stop the loop to wait for user feedback/actions.
				if (hasPlan || hasDone) {
					this._setButtonsDisabledState(false);
					this._dispatchContextUpdate("append_model");
					break;
				}

			} catch (e) {
				console.error("Agent Loop Error:", e);

				// Check if this is a temporary unavailable (503/UNAVAILABLE) error
				const isUnavailable = this.ai && typeof this.ai._isTemporaryUnavailableError === 'function' && this.ai._isTemporaryUnavailableError(e);
				if (isUnavailable) {
					this._showTryAgainBanner(e);
					this._isProcessing = false;
					this._setButtonsDisabledState(false);
					break;
				}

				const errBlock = document.createElement("div");
				errBlock.className = "response-block error-block";
				errBlock.innerHTML = `Agent Execution Error: ${e.message}`;
				this.conversationArea.append(errBlock);

				this._isProcessing = false;
				this._setButtonsDisabledState(false);
				break;
			}
		}

		if (throttleBar) {
			throttleBar.remove();
		}
	}

	_showTryAgainBanner(error) {
		if (this.haltBar) {
			this.haltBar.remove();
			this.haltBar = null;
		}

		const banner = document.createElement("div");
		banner.className = "agent-halt-bar try-again-banner";
		
		const providerName = this.aiProvider ? this.aiProvider.charAt(0).toUpperCase() + this.aiProvider.slice(1) : "AI Provider";
		const errorMessage = error.message || "Model currently experiencing high demand.";

		banner.innerHTML = `
			<ui-icon style="vertical-align: middle; margin-right: 8px; font-size: 16px;">history</ui-icon>
			<span class="halt-text"><b>${providerName}:</b> ${errorMessage}</span>
			<div class="halt-actions" style="display: flex; gap: 8px; align-items: center; margin-left: 12px;">
				<button class="try-again-btn theme-button primary" style="padding: 4px 10px; font-size: 11px; min-width: 80px; border-radius: var(--borderRadius); cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 4px;">
					<ui-icon style="font-size: 12px;">refresh</ui-icon> Try Again
				</button>
			</div>
		`;

		const tryAgainBtn = banner.querySelector(".try-again-btn");
		tryAgainBtn.onclick = () => {
			banner.remove();
			if (this.haltBar === banner) {
				this.haltBar = null;
			}
			this.promptEditor.setValue("please resume");
			this.generate();
		};

		this.chatContainer.append(banner);
		this.haltBar = banner;
	}

	async _finalizeModelMessage(fullResponse, forcedReason, callbacks, modelMessageId, responseBlock) {
		let finalizedResponse = fullResponse;
		if (forcedReason) {
			if (forcedReason === "tool_call_closed") {
				const closedIdx = finalizedResponse.indexOf("</tool_call>");
				if (closedIdx !== -1) {
					finalizedResponse = finalizedResponse.substring(0, closedIdx + 12);
				}
			} else if (forcedReason === "secondary_thought") {
				let lastIdx = -1;
				for (const tag of ["<thought>", "<think>", "<|channel>thought"]) {
					const idx = finalizedResponse.lastIndexOf(tag);
					if (idx > lastIdx) {
						lastIdx = idx;
					}
				}
				if (lastIdx !== -1) {
					finalizedResponse = finalizedResponse.substring(0, lastIdx).trim();
				}
			} else if (forcedReason === "secondary_tool_call") {
				const lastIdx = finalizedResponse.lastIndexOf("<tool_call");
				if (lastIdx !== -1) {
					finalizedResponse = finalizedResponse.substring(0, lastIdx).trim();
				}
			} else if (forcedReason === "repetition_loop") {
				// Detect the pattern again to find the exact length and count to truncate
				const rep = this._detectRepetition(finalizedResponse);
				if (rep.detected) {
					// Keep only the first occurrence of the repeating pattern
					const truncateLen = rep.pattern.length * (rep.count - 1);
					finalizedResponse = finalizedResponse.slice(0, finalizedResponse.length - truncateLen).trim();
				}
			}
		}

		// Check and prune duplicate raw toolCalls in callbacks
		if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
			const parsedToolCalls = this._parseAllToolCalls(finalizedResponse);
			if (parsedToolCalls.length > 0) {
				const parsedNames = new Set(parsedToolCalls.map(ptc => ptc.name));
				callbacks.toolCalls = callbacks.toolCalls.filter(call => {
					// Keep any raw calls whose names exist in our set of parsed parallel tool calls
					return call.functionCall && parsedNames.has(call.functionCall.name);
				});
			} else {
				// No parsed tool call remains in the finalized text, meaning it was fully truncated.
				callbacks.toolCalls = undefined;
			}
		}

		const modelMessage = {
			id: modelMessageId,
			role: "model",
			type: "model",
			content: finalizedResponse,
			diffStatuses: [],
			timestamp: Date.now()
		};
		if (callbacks.thoughtSignature) {
			modelMessage.thoughtSignature = callbacks.thoughtSignature;
		}
		if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
			modelMessage.toolCalls = callbacks.toolCalls;
		}

		const existingIndex = this.activeSession.messages.findIndex(m => m.id === modelMessage.id);
		if (existingIndex !== -1) {
			this.activeSession.messages[existingIndex] = modelMessage;
		} else {
			this.activeSession.messages.push(modelMessage);
		}
		this.activeSession.lastModified = Date.now();
		await workspaceClient.setSession(this.activeSession.id, this.activeSession);

		if (typeof responseBlock.finalize === 'function') {
			responseBlock.finalize(finalizedResponse, modelMessage);
		} else {
			responseBlock.innerHTML = this.messageRenderer.renderResponseContent(finalizedResponse, modelMessage, true);
			this.messageRenderer.addCodeBlockButtons(responseBlock, modelMessage);
		}

		if (forcedReason === "secondary_thought" || forcedReason === "secondary_tool_call" || forcedReason === "repetition_loop") {
			let alertContent = "";
			if (forcedReason === "repetition_loop") {
				alertContent = `⚠️ **Agent Loop Flag:** The model entered a repeating output loop. The stream was forcibly truncated to keep context clean.`;
			} else {
				const blockType = forcedReason === "secondary_thought" ? "thought" : "tool call";
				alertContent = `⚠️ **Agent Protocol Flag:** The model attempted to generate a secondary **${blockType}** block. The stream was forcibly truncated to enforce single-turn execution structure.`;
			}
			this.historyManager.addMessage({
				type: "system_message",
				content: alertContent,
				timestamp: Date.now()
			});
		}

		return finalizedResponse;
	}

	_checkStreamingResponse(fullResponse) {
		if (!fullResponse) return { shouldAbort: false, reason: "" };

		// 1. Check if the first tool_call block has successfully closed
		if (fullResponse.includes("</tool_call>")) {
			const supportsJSONTools = this.ai && this.ai.supportsJSONTools;
			if (!supportsJSONTools) {
				return { shouldAbort: true, reason: "tool_call_closed" };
			}
		}

		// 2. Count occurrences of thought-starts and tool-call-starts
		let thoughtCount = 0;
		// Count "<thought>"
		let idx = 0;
		while ((idx = fullResponse.indexOf("<thought>", idx)) !== -1) {
			thoughtCount++;
			idx += 9;
		}
		// Count "<think>"
		idx = 0;
		while ((idx = fullResponse.indexOf("<think>", idx)) !== -1) {
			thoughtCount++;
			idx += 7;
		}
		// Count "<|channel>thought"
		idx = 0;
		while ((idx = fullResponse.indexOf("<|channel>thought", idx)) !== -1) {
			thoughtCount++;
			idx += 17;
		}

		// Count "<tool_call"
		let toolCallCount = 0;
		idx = 0;
		while ((idx = fullResponse.indexOf("<tool_call", idx)) !== -1) {
			toolCallCount++;
			idx += 10;
		}

		if (thoughtCount > 1) {
			const supportsReasoning = this.ai && this.ai.supportsReasoning;
			if (!supportsReasoning) {
				return { shouldAbort: true, reason: "secondary_thought" };
			}
		}

		if (toolCallCount > 1) {
			const supportsParallelTools = this.ai && this.ai.supportsParallelTools;
			if (!supportsParallelTools) {
				return { shouldAbort: true, reason: "secondary_tool_call" };
			}
		}

		// 3. Check for repeating output loops
		const repCheck = this._detectRepetition(fullResponse);
		if (repCheck.detected) {
			return { shouldAbort: true, reason: "repetition_loop" };
		}

		return { shouldAbort: false, reason: "" };
	}

	_detectRepetition(text, minPatternLen = 15, minRepeats = 3) {
		if (!text || text.length < minPatternLen * minRepeats) return { detected: false };

		const maxPatternLen = Math.floor(text.length / minRepeats);

		for (let len = minPatternLen; len <= maxPatternLen; len++) {
			const pattern = text.slice(-len);
			let count = 1;

			while (count < minRepeats) {
				const startIdx = text.length - (len * (count + 1));
				const prevSegment = text.slice(startIdx, startIdx + len);
				if (prevSegment === pattern) {
					count++;
				} else {
					break;
				}
			}

			if (count >= minRepeats) {
				return { detected: true, pattern: pattern, count: count };
			}
		}

		return { detected: false };
	}



	/**
	 * NEW METHOD: Updates or removes stale file context messages in the active session.
	 * @param {Array<Object>} staleFileContexts - Array of objects containing { message, liveContent, tabInfo }.
	 */
	_updateStaleContextFiles(staleFileContexts) {
		if (!this.activeSession) return;

		// Create a new array for messages to avoid issues with splice while iterating
		let updatedMessages = [...this.activeSession.messages];
		let changesMade = false;

		for (const staleItem of staleFileContexts) {
			const messageIndex = updatedMessages.findIndex(msg =>
				msg.type === "file_context" && msg.id === staleItem.message.id
			);

			if (messageIndex !== -1) {
				if (staleItem.liveContent !== null) {
					updatedMessages[messageIndex].content = staleItem.liveContent;
				} else {
					updatedMessages.splice(messageIndex, 1); // Remove if file is no longer available
				}
				changesMade = true;
			}
		}
		if (changesMade) {
			this.activeSession.messages = updatedMessages;
			this.activeSession.lastModified = Date.now(); // Update last modified timestamp
			// Just update the file bar, which is the only visual representation of file context.
			this.historyManager.populateFileBar();
			this._dispatchContextUpdate("context_files_updated"); // Dispatch event
		}
	}

	/**
	 * NEW METHOD: Checks if any file context messages in the current session are stale
	 * (i.e., their content no longer matches the live file on disk).
	 * If stale files are found, it presents a confirmation dialog to the user.
	 * Returns a Promise that resolves when the user has made a choice.
	 */
	async _checkForStaleContextFiles(originalPrompt) {
		if (this.agentMode) return true;
		if (!this.activeSession) return true;

		const staleFileContexts = [];
		for (const message of this.activeSession.messages) {
			if (message.type === "file_context" && message.filename) {
				try {
					// Use message.id, which holds the full path, to find the tab.
					const tabInfo = await this.ai._getTabSessionByPath(message.id);
					if (tabInfo && tabInfo.config.session) {
						const liveContent = tabInfo.config.session.getValue();
						if (liveContent !== message.content) {
							staleFileContexts.push({
								message,
								liveContent,
								tabInfo,
							});
						}
					} else {
						// File is no longer open or available, mark as stale for removal/update
						staleFileContexts.push({
							message,
							liveContent: null, // Indicates file not found/open
							tabInfo: null,
						});
					}
				} catch (e) {
					console.warn(`Error checking currency for file ${message.filename}:`, e);
					// Consider it stale if an error occurs fetching live content
					staleFileContexts.push({
						message,
						liveContent: null,
						tabInfo: null,
					});
				}
			}
		}

		if (staleFileContexts.length > 0) {
			this._setButtonsDisabledState(true); // Disable main buttons during interaction
			this._isProcessing = true; // Keep processing flag true

			const modifiedFiles = staleFileContexts.filter(f => f.liveContent !== null);
			const removedFiles = staleFileContexts.filter(f => f.liveContent === null);

			let message = `**Context Update Needed**\n\n`;
			if (modifiedFiles.length > 0) {
				message += `The following file(s) have been modified:\n`;
				modifiedFiles.forEach(stale => {
					message += `* \`${stale.message.filename}\`\n`;
				});
			}
			if (removedFiles.length > 0) {
				if (modifiedFiles.length > 0) message += `\n`;
				message += `The following file(s) are no longer open and will be removed from context:\n`;
				removedFiles.forEach(stale => {
					message += `* \`${stale.message.filename}\`\n`;
				});
			}
			message += `\nDo you want to apply these updates before proceeding?`;
			this._showContextStaleNotice(message);

			const userChoice = await new Promise(resolve => {
				this._contextStaleResolve = resolve;
			});

			if (userChoice === 'cancel') {
				// this.promptEditor.setValue(originalPrompt, -1); // Restore prompt - no longer needed as editor is not cleared yet
				this._isProcessing = false;
				this._setButtonsDisabledState(false);
				return false; // Signal to abort
			}
			if (userChoice === true) { // User chose to update
				this._updateStaleContextFiles(staleFileContexts);
			}
			// If userChoice is false, do nothing; the old context will be used.
			return true; // Signal to proceed
		}
		return true; // No stale files, proceed
	}
	async replayMessage(messageId) {
		if (this._isProcessing) {
			console.warn("AI is currently processing another request. Please wait.")
			return;
		}

		if (!this.activeSession) return;

		const msgIndex = this.activeSession.messages.findIndex(m => m.id === messageId);
		if (msgIndex === -1) return;

		const userMessage = this.activeSession.messages[msgIndex];
		if (userMessage.type !== "user") return;

		// 1. Delete all turns AFTER the target turn
		this.activeSession.messages.splice(msgIndex + 1);
		this.activeSession.lastModified = Date.now();
		await workspaceClient.setSession(this.activeSession.id, this.activeSession);

		// 2. Re-render the history so all following messages disappear from the screen
		this.historyManager.render();

		// 3. Trigger the generation turn using the remaining history!
		this._unsentPromptBuffer = null;
		this._isProcessing = true;
		this._setButtonsDisabledState(true);

		if (this.agentMode) {
			const userMessageElement = this.conversationArea.querySelector(`[data-message-id="${messageId}"]`);
			await this._runAgentLoop(userMessage, userMessageElement);
			return;
		}

		// Standard Chat mode:
		const fileBarContainer = this.panel.querySelector('.ai-filebar-container');
		const fileBarHeight = fileBarContainer ? fileBarContainer.offsetHeight : 0;
		const availableHeightForResponse = this.conversationArea.clientHeight - (fileBarHeight + 16);

		const modelMessageId = crypto.randomUUID();
		const responseBlock = this.historyManager.createStreamingBlock(modelMessageId);
		const spinner = this._createSpinner();
		if (!this.rawViewMode) {
			responseBlock.append(spinner);
		}
		this.conversationArea.append(responseBlock);
		responseBlock.style.minHeight = `${Math.max(50, availableHeightForResponse)}px`;

		const userMessageElement = this.conversationArea.querySelector(`[data-message-id="${messageId}"]`);
		if (userMessageElement) {
			const PADDING_FROM_TOP = 8;
			this.conversationArea.scrollTop = userMessageElement.offsetTop - fileBarHeight - PADDING_FROM_TOP;
		}

		const callbacks = {
			onUpdate: (fullResponse) => {
				if (spinner.parentNode) spinner.remove();
				const shouldScroll = this._shouldAutoScroll();
				responseBlock.updateContent(fullResponse);
				if (shouldScroll && this.conversationArea) {
					this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
				}
			},
			onDone: async (fullResponse) => {
				const modelMessage = { id: modelMessageId, role: "model", type: "model", content: fullResponse, diffStatuses: [], timestamp: Date.now() };
				if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
					modelMessage.toolCalls = callbacks.toolCalls;
				}
				if (callbacks.thoughtSignature) {
					modelMessage.thoughtSignature = callbacks.thoughtSignature;
				}
				this.activeSession.messages.push(modelMessage);
				this.historyManager.addInteractionToLastUserMessage(userMessage);
				this.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);

				responseBlock.finalize(fullResponse, modelMessage);

				// NEW: Chat-mode output checks for diff blocks
				if (!this.agentMode) {
					const diffBlocks = responseBlock.querySelectorAll("pre[data-original-diff-content]");
					if (diffBlocks.length > 0) {
						let anyFailed = false;
						let failedFilename = "";
						let failedPath = "";
						
						for (let index = 0; index < diffBlocks.length; index++) {
							const pre = diffBlocks[index];
							const rawDiff = pre.dataset.originalDiffContent;
							if (!rawDiff) continue;

							const targetPathMatch = rawDiff.match(/^\+\+\+ b\/(.+)$/m) || rawDiff.match(/^\+\+\+ (.+)$/m);
							if (!targetPathMatch || !targetPathMatch[1]) continue;

							const targetPath = targetPathMatch[1];
							let tab = await this.ai._getTabSessionByPath(targetPath);
							if (!tab) {
								const fileData = this.ai._findFileByPath(targetPath);
								if (fileData && window.ui && window.ui.fileList && window.ui.fileList.open) {
									await window.ui.fileList.open(fileData);
									tab = await this.ai._getTabSessionByPath(fileData.path);
								}
							}

							let currentContent = "";
							if (tab && tab.config && tab.config.session) {
								currentContent = tab.config.session.getValue();
							} else {
								// Fallback: try looking in file_context from history
								let contextContent = null;
								const normalizedTargetPath = targetPath.startsWith('/') ? targetPath.substring(1) : targetPath;
								for (let i = this.activeSession.messages.length - 1; i >= 0; i--) {
									const msg = this.activeSession.messages[i];
									if (msg.type === "file_context" && msg.id) {
										const normalizedMsgId = msg.id.startsWith('/') ? msg.id.substring(1) : msg.id;
										if (normalizedMsgId === normalizedTargetPath || normalizedMsgId.endsWith(normalizedTargetPath)) {
											contextContent = msg.content;
											break;
										}
									}
								}
								if (contextContent !== null) {
									currentContent = contextContent;
								}
							}

							const testMergedContent = DiffHandler.applyAIResponseDiff(currentContent, rawDiff);
							if (testMergedContent === null) {
								anyFailed = true;
								failedPath = targetPath;
								failedFilename = targetPath.split('/').pop();
								break;
							} else if (this.forgivenessMode) {
								// Chat+forgiveness mode: Successful merge commits directly to the current file buffer (Ace session)
								if (tab && tab.config && tab.config.session) {
									const filePathForBackup = tab.config.path;
									let backupId = "";
									const activeSession = this.activeSession;
									const hasExistingBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[filePathForBackup] && activeSession.modifiedFiles[filePathForBackup].length > 0;

									if (hasExistingBackup) {
										backupId = activeSession.modifiedFiles[filePathForBackup][0].backupId;
									} else {
										try {
											const actId = modelMessage.id || activeSession?.id || "default";
											backupId = await AgentBackup.create(filePathForBackup, currentContent, actId);
											
											if (activeSession) {
												activeSession.modifiedFiles = activeSession.modifiedFiles || {};
												if (!activeSession.modifiedFiles[filePathForBackup]) {
													activeSession.modifiedFiles[filePathForBackup] = [];
												}
												activeSession.modifiedFiles[filePathForBackup].push({
													backupId: backupId,
													timestamp: Date.now(),
													sourceId: actId
												});
											}
										} catch (e) {
											console.error("[ChatDiff] Failed to create backup:", e);
										}
									}

									// Commit merged content to current editor buffer (without saving)
									const session = tab.config.session;
									const doc = session.getDocument();
									const lastRow = doc.getLength() - 1;
									const lastCol = doc.getLine(lastRow).length;
									const Range = (window.ace.require ? window.ace.require("ace/range").Range : null) || window.ace.Range;
									const fullRange = new Range(0, 0, lastRow, lastCol);
									session.replace(fullRange, testMergedContent);
									
									// Enable diff review tracking vs current buffer
									tab.config.viewMode = "diff";
									tab.config.backupId = backupId;
									
									// Mark as applied in modelMessage and update apply button UI
									modelMessage.diffStatuses[index] = true;
									
									const applyBtn = pre.querySelector("ui-button:not(.expand-collapse-button)");
									if (applyBtn) {
										applyBtn.classList.remove("diff-apply-failed");
										applyBtn.classList.add("diff-apply-success");
										applyBtn.icon = "done";
										applyBtn.title = "Diff applied successfully!";
									}

									// Focus and Redraw (activates split diff view automatically)
									tab.click();

									this.historyManager.addMessage({
										type: "system_message",
										content: `Diff successfully applied to **${targetPath}** in Forgiveness Mode. Remember to save the file.`,
										timestamp: Date.now(),
									});
								}
							}
						}

						if (anyFailed) {
							// Notify user of failed merge and ask for choice
							const choice = await window.modal.confirm(
								`The generated diff for <strong>${failedFilename}</strong> could not be applied automatically. Would you like to review it manually or retry?`,
								"Diff Application Failed",
								["Manual Review", "Retry"]
							);
							if (choice === false) { // "Retry" is second button (resolves to false)
								this.promptEditor.setValue(`your diff for ${failedPath} could not be applied, please try again`);
								this.generate();
							}
						} else if (this.forgivenessMode) {
							// Update IndexedDB to persist the updated diffStatuses and backup references
							await workspaceClient.setSession(this.activeSession.id, this.activeSession);
						}
					}
				}

				this._dispatchContextUpdate("append_model");

				this._isProcessing = false;
				this._setButtonsDisabledState(false);
			},
			onError: async (error) => {
				responseBlock.style.minHeight = '';
				if (typeof responseBlock.updateContent === 'function') {
					responseBlock.updateContent(`Error: ${error.message}`);
				} else {
					responseBlock.innerHTML = `Error: ${error.message}`;
				}
				console.error(`Error calling ${this.ai.config.model} API:`, error);

				const errorMessage = {
					id: modelMessageId,
					role: "error",
					type: "error",
					content: `Error: ${error.message}`,
					timestamp: Date.now(),
					diffStatuses: [],
				};
				this.activeSession.messages.push(errorMessage);
				this.activeSession.lastModified = Date.now();
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);

				this._dispatchContextUpdate("append_error");

				this._isProcessing = false;
				this._setButtonsDisabledState(false);
			},
			onContextRatioUpdate: (ratio) => {},
		};

		const messagesForAI = this.historyManager.prepareMessagesForAI();
		const systemPrompt = await this.getSystemPrompt();
		this.ai.chat(messagesForAI, callbacks, systemPrompt);
	}

	async loadSettings() {
		const storedProvider = localStorage.getItem("aiProvider")
		if (storedProvider && this.aiProviders[storedProvider]) {
			this.aiProvider = storedProvider
		}

		// NEW: System prompt config is now loaded in init via _loadSystemPromptConfig()
		// to ensure it happens after workspace data is available in main.js.
		// The values will be correctly picked up from app/workspace objects.

		// Load summarization settings
		const storedSummarizeThreshold = localStorage.getItem("summarizeThreshold")
		if (storedSummarizeThreshold !== null) {
			this.config.summarizeThreshold = parseInt(storedSummarizeThreshold)
		}
		const storedSummarizeTargetPercentage = localStorage.getItem("summarizeTargetPercentage")
		if (storedSummarizeTargetPercentage !== null) {
			this.config.summarizeTargetPercentage = parseInt(storedSummarizeTargetPercentage)
		}

		const storedDefaultAgentMode = localStorage.getItem("defaultAgentMode")
		if (storedDefaultAgentMode !== null) {
			this.config.defaultAgentMode = storedDefaultAgentMode === "true"
		}
		const storedDefaultPlanningMode = localStorage.getItem("defaultPlanningMode")
		if (storedDefaultPlanningMode !== null) {
			this.config.defaultPlanningMode = storedDefaultPlanningMode === "true"
		}

		const storedAgentMode = localStorage.getItem("aiAgentMode")
		if (storedAgentMode !== null) {
			this.agentMode = storedAgentMode === "true"
		}

		const storedForgivenessMode = localStorage.getItem("aiForgivenessMode")
		if (storedForgivenessMode !== null) {
			this.forgivenessMode = storedForgivenessMode === "true"
		}
	}
}

export default new AIManager()
