// ai-manager.mjs
// Styles for this module are located in css/ai-manager.css
import { Block, Button, Icon, TabBar, TabItem, FileBar, SkillPicker, RootPicker } from "./elements.mjs"
import AIManagerHistory, { MAX_RECENT_MESSAGES_TO_PRESERVE } from "./ai-manager-history.mjs"
import AIManagerMessageRenderer from "./ai-manager-message-renderer.mjs" // NEW: Settings manager
import AIManagerSessions from "./ai-manager-sessions.mjs" // NEW: Sessions manager
import workspaceClient from "./workspace-client.mjs"
import agentTools from "./agent/agent-tools.mjs"
import AIConnections from "./ai-connections.mjs"
import { Agent } from "./agent/agent.mjs"

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
		this.connectionsManager = AIConnections;
		this.activeAgent = null;
		this.messageRenderer = new AIManagerMessageRenderer(this);
		this.sessionsManager = new AIManagerSessions(this);

		// NEW: Default system prompt config
		this.systemPromptConfig = {
			specialization: "JavaScript (ECMAScript), HTML, CSS, and Node.js", technologies: [], avoidedTechnologies: [], tone: ["warm", "playful", "cheeky"],
		};

		this.panel = null;
		this.promptEditor = null; // Will hold the ACE editor instance
		this.conversationArea = null;
		this.chatContainer = null;
		this.fileBar = null; // NEW: for file context chips
		this.submitButton = null;
		// Initialize markdown-it with highlight.js for code highlighting
		this.md = window.markdownit({ // hljs is available globally via <script> tag
			highlight: function (str, lang) {
				if (lang && hljs.getLanguage(lang)) {
					return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
				}
				return '';
			}
		});

		this.historyManager = new AIManagerHistory(this);

		this.contextStaleNotice = null; // New element for context currency check
		this._emptyStateElement = null; // NEW: For empty state background
		this._contextStaleResolve = null; // To resolve/reject the context stale promise		
		this.useWorkspaceSettings = false;
		this.runningSessions = new Map(); // sessionId -> { type: 'chat'|'agent', controller: Agent|AI, responseBlock }
		this.glowingSessions = new Set(); // Set of sessionIds currently triggering the glow animation
		
		// Reference to the AI info display element
		this.aiInfoDisplay = null;
		this.thinkingBudgetSelect = null;
		this.editBufferDisplay = null; // NEW: Edit buffer display

		// Load summarization and mode settings defaults
		this.config = {
			summarizeThreshold: parseInt(localStorage.getItem("summarizeThreshold") || "85"),
			summarizeTargetPercentage: parseInt(localStorage.getItem("summarizeTargetPercentage") || "50"),
			defaultAgentMode: localStorage.getItem("defaultAgentMode") === "true",
			defaultPlanningMode: localStorage.getItem("defaultPlanningMode") !== "false",
			defaultForgivenessMode: localStorage.getItem("aiForgivenessMode") === "true",
			maxSubAgents: parseInt(localStorage.getItem("maxSubAgents") || "3"),
			defaultAllowSubAgents: localStorage.getItem("defaultAllowSubAgents") !== "false",
			defaultAllowRunCommand: localStorage.getItem("defaultAllowRunCommand") !== "false",
		};
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
		this.allowRunCommand = localStorage.getItem("aiAllowRunCommand") === "true"; // Toggle command tool availability
		this.rawViewMode = false; // NEW: Tracks alternate expander raw view
		this.rawViewButton = null;
		this.autoContinue = localStorage.getItem("aiAutoContinue") === "true"; // NEW: Auto-continue on agent loop halt
		this.consecutiveHaltCount = 0; // NEW: Track consecutive loop halts
		this.haltBar = null; // NEW: Persistent halt notification bar
	}

	get ai() {
		if (!this.activeSession) return null;
		const connId = this.activeSession.connectionId || AIConnections.defaultConnectionId;
		return AIConnections.getInstance(connId);
	}

	async init(panel) {
		this.panel = panel;
		AIConnections.init();
		
		// Listen for connection updates to redraw the Connection Selector
		window.addEventListener('connections-changed', () => {
			this._updateAIInfoDisplay();
			this._updatePromptAreaPlaceholder();
			this.historyManager.render();
		});

		await this.loadSettings();
		this._loadSystemPromptConfig(); // NEW: Load prompt settings

		// Try initializing the active connection
		try {
			const activeConn = this.ai;
			if (activeConn) {
				await activeConn.init();
			}
		} catch (error) {
			console.error("AIManager: Error initializing AI connection:", error);
			this.historyManager.addMessage({
				type: "system_message",
				content: `Error initializing AI connection. Please check your config. Details: ${error.message}`,
				timestamp: Date.now(),
			}, false);
			this._isProcessing = false;
			this._setButtonsDisabledState(false);
		}

		// Load summarization settings from storage, overriding defaults
		const storedSummarizeThreshold = localStorage.getItem("summarizeThreshold");
		if (storedSummarizeThreshold !== null) {
			this.config.summarizeThreshold = parseInt(storedSummarizeThreshold);
		}
		const storedSummarizeTargetPercentage = localStorage.getItem("summarizeTargetPercentage");
		if (storedSummarizeTargetPercentage !== null) {
			this.config.summarizeTargetPercentage = parseInt(storedSummarizeTargetPercentage);
		}

		this._createUI();
		this._initPromptEditor();
		this._setupPanel();

		this._updateAIInfoDisplay();
		this._updatePromptAreaPlaceholder(); // Ensure placeholder is correct after init
		this._updateAgentProgressPanel();
		window.addEventListener('setting-changed', this._handleSettingChangedExternally.bind(this));
	}

	async getSystemPrompt(session = null) {
		const targetSession = session || this.activeSession;
		if (targetSession && targetSession.systemPromptOverride) {
			return targetSession.systemPromptOverride;
		}
		let basePrompt = "";
		const targetAgentMode = targetSession ? (targetSession.agentMode ?? this.agentMode) : this.agentMode;
		const targetPlanningMode = targetSession ? (targetSession.planningMode ?? this.planningMode) : this.planningMode;
		if (targetAgentMode) {
			const activeAi = targetSession?.connectionId ? AIConnections.getInstance(targetSession.connectionId) : this.ai;
			const modelName = (activeAi && activeAi.config && activeAi.config.model) ? activeAi.config.model.toLowerCase() : '';
			const supportsJSONTools = !!(activeAi && activeAi.supportsJSONTools);
			
			const hasPlan = !!targetSession?.implementationPlan;
			const hasTasks = !!targetSession?.taskList;
			const hasAcceptedPlan = targetSession?.messages?.some(m => m.planStatus === "accepted") || false;
			
			let hasCompletedAllTasks = false;
			if (hasTasks && targetSession?.taskList) {
				hasCompletedAllTasks = !targetSession.taskList.includes("- [ ]") && !targetSession.taskList.includes("* [ ]");
			}

			const sessionThinking = targetSession?.thinkingLevel;
			const effectiveThinkingLevel = (sessionThinking && sessionThinking !== "auto")
				? sessionThinking
				: (activeAi?.config?.thinkingLevel || "medium");
			const isNativeReasoning = !!(activeAi && activeAi.supportsReasoning && effectiveThinkingLevel !== "off" && !targetSession?.disableReasoning);

			const allFolders = window.workspace?.folders || [];
			const pinnedRoots = targetSession?.pinnedRoots || [];
			const effectiveFolders = pinnedRoots.length > 0
				? allFolders.filter(f => pinnedRoots.some(p => f === p || f.endsWith('/' + p) || f.split(/[\\/]/).filter(Boolean).pop() === p))
				: allFolders;

			basePrompt = getAgentSystemPrompt(modelName, {
				supportsJSONTools,
				hasPlan,
				hasTasks,
				hasAcceptedPlan,
				hasCompletedAllTasks,
				planningMode: targetPlanningMode,
				isNativeReasoning,
				workspaceFolders: effectiveFolders
			});
		} else {
			basePrompt = systemPromptBuilder(this.getSystemPromptConfig());
		}

		// Persistent memory scratch-pad: read .agents/AGENTS.md from active workspace roots
		const allFolders = window.workspace?.folders || [];
		const pinnedRoots = targetSession?.pinnedRoots || [];
		const folders = pinnedRoots.length > 0
			? allFolders.filter(f => pinnedRoots.some(p => f === p || f.endsWith('/' + p) || f.split(/[\\/]/).filter(Boolean).pop() === p))
			: allFolders;
		const hints = [];
		for (const folder of folders) {
			try {
				const filePath = `${folder}/.agents/AGENTS.md`;
				const fileData = await window.conduit.wsRead(filePath);
				if (fileData && !fileData.error) {
					let content = "";
					if (fileData.data) {
						try {
							content = decodeURIComponent(escape(atob(fileData.data)));
						} catch (e) {
							try {
								content = atob(fileData.data);
							} catch (e2) {
								content = fileData.data;
							}
						}
					} else if (fileData.content) {
						content = fileData.content;
					}
					if (content) {
						hints.push(content.trim());
					}
				}
			} catch (e) {
				// Ignore if file doesn't exist or is unreachable
			}
		}

		if (hints.length > 0) {
			const compiledHints = hints.join("\n\n---\n\n");
			basePrompt += `\n\n=== PROJECT SPECIFIC HINTS FROM THE USER ===\n\n${compiledHints}\n=================================================`;
		}

		// Skills interpreter: load and match active skills based on user's query
		// Skills interpreter: load and match active skills based on user's query and pinned status
		try {
			const lastUserMsg = targetSession?.messages?.filter(m => m.role === "user" || m.type === "user")?.pop();
			const userPromptText = lastUserMsg ? lastUserMsg.content : "";
			
			const allParsedSkills = await this._loadAllParsedSkills();
			const pinnedSkillNames = targetSession?.pinnedSkills || [];
			
			// 1. Get ephemeral skills (matched via relevance)
			const ephemeralSkills = await this._loadAndMatchSkills(userPromptText, allParsedSkills);
			
			// 2. Get persistent skills (pinned)
			const pinnedSkills = allParsedSkills.filter(s => pinnedSkillNames.includes(s.name));
			
			// 3. Combine and de-duplicate
			const activeSkills = new Map();
			
			// Add pinned first
			for (const skill of pinnedSkills) {
				activeSkills.set(skill.name, { name: skill.name, body: skill.body });
			}
			
			// Add ephemeral (if not already in pinned)
			for (const skill of ephemeralSkills) {
				if (!activeSkills.has(skill.name)) {
					activeSkills.set(skill.name, skill);
				}
			}

			for (const skill of activeSkills.values()) {
				basePrompt += `\n\n=== ACTIVE SKILL: ${skill.name} ===\n\n${skill.body}\n===================================`;
				if (this.fileBar) {
					this.fileBar.addSkill({ name: skill.name, id: `skillchip-${skill.name}` });
				}
			}
		} catch (err) {
			console.warn("[AIManager] Failed to load/match skills:", err);
		}

		return basePrompt;
	}

	async _loadAllParsedSkills() {
		const folders = window.workspace?.folders || [];
		const roots = [...folders.map(f => `${f}/.agents/skills`), "/home/jason/.gemini/config/skills"];
		const parsedSkills = [];

		for (const root of roots) {
			try {
				const listResp = await window.conduit.wsList(root);
				if (listResp && listResp.data) {
					const dirs = listResp.data.filter(item => item.isDir);
					for (const dir of dirs) {
						const skillPath = `${root}/${dir.name}/SKILL.md`;
						try {
							const fileResp = await window.conduit.wsRead(skillPath);
							let content = "";
							if (fileResp && !fileResp.error) {
								if (fileResp.data) {
									try {
										content = decodeURIComponent(escape(atob(fileResp.data)));
									} catch (e) {
										content = atob(fileResp.data);
									}
								} else if (fileResp.content) {
									content = fileResp.content;
								}
							}
							if (content) {
								// Helper to clean/parse frontmatter
								const parseFrontmatter = (text) => {
									const match = text.match(/^---\r?\n([\s\S]+?)\r?\n---/);
									if (!match) return { metadata: {}, body: text };
									const yamlText = match[1];
									const body = text.substring(match[0].length).trim();
									
									const metadata = {};
									const lines = yamlText.split("\n");
									for (const line of lines) {
										const colonIdx = line.indexOf(":");
										if (colonIdx !== -1) {
											const key = line.substring(0, colonIdx).trim().toLowerCase();
											const val = line.substring(colonIdx + 1).trim();
											metadata[key] = val;
										}
									}
									return { metadata, body };
								};

								const { metadata, body } = parseFrontmatter(content);
								parsedSkills.push({
									name: metadata.name || dir.name,
									path: skillPath,
									content,
									metadata,
									body
								});
							}
						} catch (e) {
							// SKILL.md not found or error reading it
						}
					}
				}
			} catch (e) {
				// Root directory doesn't exist or is unreachable
			}
		}
		return parsedSkills;
	}

	async _loadAndMatchSkills(userPrompt, allParsedSkills) {
		if (!userPrompt) return [];

		// Relevance matcher
		const isSkillRelevant = (prompt, name, description) => {
			if (!prompt) return false;
			const cleanPrompt = prompt.toLowerCase();
			const cleanName = name.toLowerCase();
			const cleanDesc = (description || "").toLowerCase();
			
			if (cleanPrompt.includes(cleanName)) return true;
			
			const stopwords = new Set(["about", "these", "those", "their", "there", "would", "could", "should", "using", "under", "after", "before"]);
			const keywords = cleanDesc
				.split(/[^a-z0-9]+/)
				.filter(w => w.length > 4 && !stopwords.has(w));
				
			let matchCount = 0;
			for (const keyword of keywords) {
				if (cleanPrompt.includes(keyword)) {
					matchCount++;
					if (keyword.length > 7) return true;
				}
			}
			return matchCount >= 2;
		};

		const matchedSkills = [];
		const addedSkills = new Set();

		for (const skill of allParsedSkills) {
			const skillName = skill.name;
			const skillDesc = skill.metadata.description || "";
			
			if (addedSkills.has(skillName)) continue;
			
			if (isSkillRelevant(userPrompt, skillName, skillDesc)) {
				addedSkills.add(skillName);
				matchedSkills.push({
					name: skillName,
					body: skill.body
				});
			}
		}
		
		return matchedSkills;
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
		if (this.ai) {
			this.ai.editor = editor
		}
	}

	get editor() {
		return this.ai?.editor
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
		this.fileBar.addRootsButton(async () => {
			const picker = new RootPicker(this);
			window.modal.inner.innerHTML = '';
			window.modal.inner.append(picker);
			window.modal.actionBar.empty();

			const closeBtn = new Button('Close');
			closeBtn.icon = 'close';
			closeBtn.className = 'theme-button';
			closeBtn.onclick = () => window.modal.hide(false);
			window.modal.actionBar.append(closeBtn);
			await window.modal.show();
		});
		this.fileBar.addLibraryButton(async () => {
			const picker = new SkillPicker(this);
			window.modal.inner.innerHTML = '';
			window.modal.inner.append(picker);
			window.modal.actionBar.empty();

			const createBtn = new Button('New Skill');
			createBtn.icon = 'add';
			createBtn.className = 'theme-button secondary';
			createBtn.onclick = () => picker.showEditor(null);
			window.modal.actionBar.append(createBtn);

			const closeBtn = new Button('Close');
			closeBtn.icon = 'close';
			closeBtn.className = 'theme-button';
			closeBtn.onclick = () => window.modal.hide(false);
			window.modal.actionBar.append(closeBtn);
			await window.modal.show();
		});
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
		
		this.fileBar.on('skill-remove-request', async (e) => {
			const skillName = e.detail.skillName;
			if (this.activeSession) {
				// If it's a pinned skill, remove it from the session's pinnedSkills
				if (this.activeSession.pinnedSkills && this.activeSession.pinnedSkills.includes(skillName)) {
					this.activeSession.pinnedSkills = this.activeSession.pinnedSkills.filter(s => s !== skillName);
					await workspaceClient.setSession(this.activeSession.id, this.activeSession);
				}
				// Always remove the chip from the bar
				this.fileBar.remove(`skillchip-${skillName}`);

				// Provide feedback
				this.historyManager.addMessage({
					type: 'system_message',
					content: `**${skillName}** skill removed from context.`,
					timestamp: Date.now()
				}, false);
			}
		});

		this.fileBar.on('root-remove-request', async (e) => {
			const rootPath = e.detail.rootPath;
			if (this.activeSession) {
				const matchingFolder = (window.workspace?.folders || []).find(f => f === rootPath) || rootPath;
				const norm = matchingFolder.replace(/\\/g, '/').replace(/\/+$/, '');
				const rootName = norm.split('/').filter(Boolean).pop() || matchingFolder;

				if (this.activeSession.pinnedRoots) {
					this.activeSession.pinnedRoots = this.activeSession.pinnedRoots.filter(r => r !== rootPath && r !== rootName);
					await workspaceClient.setSession(this.activeSession.id, this.activeSession);
				}
				// Always remove the chip from the bar
				this.fileBar.remove(`rootchip-${rootPath}`);

				// Provide feedback
				this.historyManager.addMessage({
					type: 'system_message',
					content: `**${rootName}** root unpinned from context.`,
					timestamp: Date.now()
				}, false);
			}
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
		this._autoscrollEnabled = true;
		this._isProgrammaticScroll = false;
		this._lastScrollTop = 0;
		this._lastScrollHeight = 0;
		this._lastClientHeight = 0;

		this.conversationArea = this._createConversationArea();
		
		const self = this;
		let desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
		if (!desc) {
			desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
		}
		if (desc) {
			Object.defineProperty(this.conversationArea, 'scrollTop', {
				get() {
					return desc.get.call(this);
				},
				set(val) {
					if (val === this.scrollHeight) {
						self.scrollToBottom(true);
					} else {
						desc.set.call(this, val);
					}
				},
				configurable: true
			});
		}

		this.conversationArea.addEventListener("scroll", () => {
			const activeSubAgentSessionId = this.activeSession?.activeSubAgentSessionId;
			const currentScrollTop = this.conversationArea.scrollTop;
			const currentScrollHeight = this.conversationArea.scrollHeight;
			const currentClientHeight = this.conversationArea.clientHeight;

			if (activeSubAgentSessionId && this.activeSubAgentSession) {
				this.activeSubAgentSession.scrollTop = currentScrollTop;
				this.activeSubAgentSession.autoscrollEnabled = this._autoscrollEnabled;
			} else if (this.activeSession) {
				this.activeSession.scrollTop = currentScrollTop;
				this.activeSession.autoscrollEnabled = this._autoscrollEnabled;
			}

			// If the scrollHeight or clientHeight changed, the scroll event is likely triggered by
			// a height change/layout shift rather than manual user interaction.
			if (currentScrollHeight !== this._lastScrollHeight || currentClientHeight !== this._lastClientHeight) {
				this._lastScrollTop = currentScrollTop;
				this._lastScrollHeight = currentScrollHeight;
				this._lastClientHeight = currentClientHeight;
				return;
			}

			if (this._isProgrammaticScroll) {
				this._lastScrollTop = currentScrollTop;
				return;
			}

			if (currentScrollTop < this._lastScrollTop) {
				// User scrolled upwards!
				this._autoscrollEnabled = false;
				this._showAutoscrollChip();
			} else {
				// User scrolled downwards (or stayed same)
				const distanceToBottom = Math.max(0, currentScrollHeight - currentClientHeight) - Math.ceil(currentScrollTop);
				if (distanceToBottom <= 10) {
					this._autoscrollEnabled = true;
					this._hideAutoscrollChip();
				}
			}

			if (activeSubAgentSessionId && this.activeSubAgentSession) {
				this.activeSubAgentSession.autoscrollEnabled = this._autoscrollEnabled;
			} else if (this.activeSession) {
				this.activeSession.autoscrollEnabled = this._autoscrollEnabled;
			}

			this._lastScrollTop = currentScrollTop;
			this._lastScrollHeight = currentScrollHeight;
			this._lastClientHeight = currentClientHeight;
		});
		this.submitButton = this._createSubmitButton();
		const promptContainer = this._createPromptContainer();

		this.chatContainer = new Block();
		this.chatContainer.classList.add('ai-chat-container');
		this.undulatingGlow = this._createUndulatingGlow();
		this.editBufferDisplay = this._createEditBufferDisplay();
		this._emptyStateElement = this._createEmptyStateElement();
		this.chatContainer.append(fileBarContainer, this.editBufferDisplay, this.conversationArea, this._emptyStateElement, this.undulatingGlow);

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

		this.panel.append(this.chatContainer, this.sessionTabBar, promptContainer);
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
		if (!this._autoscrollEnabled) return false;
		// Use Math.ceil to handle fractional scroll positions from high-DPI screens or browser zoom
		// We use Math.max to avoid negative distances if scrollHeight < clientHeight
		const distanceToBottom = Math.max(0, this.conversationArea.scrollHeight - this.conversationArea.clientHeight) - Math.ceil(this.conversationArea.scrollTop);
		return distanceToBottom <= 50;
	}

	scrollToBottom(force = false) {
		if (!this.conversationArea) return;
		if (!force && !this._shouldAutoScroll()) return;

		this._isProgrammaticScroll = true;
		const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
		if (desc && desc.set) {
			desc.set.call(this.conversationArea, this.conversationArea.scrollHeight);
		} else {
			this.conversationArea.scrollTop = this.conversationArea.scrollHeight;
		}
		this._lastScrollTop = this.conversationArea.scrollTop;
		this._lastScrollHeight = this.conversationArea.scrollHeight;
		this._lastClientHeight = this.conversationArea.clientHeight;
		setTimeout(() => {
			this._isProgrammaticScroll = false;
		}, 0);
	}

	_showAutoscrollChip() {
		if (!this._autoscrollChip) {
			this._autoscrollChip = new Button("autoscroll");
			this._autoscrollChip.setIcon("arrow_downward");
			this._autoscrollChip.classList.add("autoscroll-chip");
			this._autoscrollChip.onclick = () => {
				this._autoscrollEnabled = true;
				this.scrollToBottom(true);
				this._hideAutoscrollChip();
			};
			this.chatContainer.appendChild(this._autoscrollChip);
		}
		this._autoscrollChip.classList.add("visible");
	}

	_hideAutoscrollChip() {
		if (this._autoscrollChip) {
			this._autoscrollChip.classList.remove("visible");
		}
	}

	_createProgressBar() {
		const progressBar = document.createElement("div")
		progressBar.classList.add("progress-bar")
		progressBar.setAttribute("title", "Context window utilization")
		progressBar.style.display = "block" // Now always visible

		// Full thread/history bar (background layer)
		const progressBarFullHistory = document.createElement("div")
		progressBarFullHistory.classList.add("progress-bar-full-history")
		progressBar.appendChild(progressBarFullHistory)

		// Active window/message bar (foreground layer)
		const progressBarInner = document.createElement("div")
		progressBarInner.classList.add("progress-bar-inner")
		progressBar.appendChild(progressBarInner)
		return progressBar;
	}

	_showPrefillProgress(responseBlock, pct, progressData) {
		let container = responseBlock.querySelector('.prefill-progress-container');
		if (!container) {
			container = document.createElement('div');
			container.className = 'prefill-progress-container';
			container.innerHTML = `
				<div class="prefill-progress-header">
					<ui-icon class="prefill-progress-icon">sync</ui-icon>
					<span class="prefill-progress-title">Context prefill processing...</span>
					<span class="prefill-progress-percent">0%</span>
				</div>
				<div class="prefill-progress-bar">
					<div class="prefill-progress-fill" style="width: 0%;"></div>
				</div>
				<div class="prefill-progress-details">0 / 0 tokens</div>
			`;
			responseBlock.appendChild(container);
		}

		const fill = container.querySelector('.prefill-progress-fill');
		const percent = container.querySelector('.prefill-progress-percent');
		const details = container.querySelector('.prefill-progress-details');

		if (fill) fill.style.width = `${pct}%`;
		if (percent) percent.textContent = `${pct}%`;
		if (details) {
			const processed = progressData.processed || 0;
			const total = progressData.total || 0;
			const cache = progressData.cache || 0;
			if (cache > 0) {
				details.textContent = `${processed} / ${total} tokens (cached: ${cache})`;
			} else {
				details.textContent = `${processed} / ${total} tokens`;
			}
		}

		// Ensure we auto-scroll if autoscroll is enabled
		if (this._autoscrollEnabled && this.conversationArea) {
			this.scrollToBottom(true);
		}
	}

	_createUndulatingGlow() {
		const container = document.createElement('div');
		container.classList.add('undulating-glow-container');

		const canvas = document.createElement('div');
		canvas.classList.add('undulating-glow-canvas');

		const blobs = [];
		for (let i = 1; i <= 8; i++) {
			const blob = document.createElement('div');
			blob.classList.add('glow-blob', `glow-blob-${i}`);
			blobs.push(blob);
		}

		container.append(canvas, ...blobs);
		return container;
	}

	_startGlow(sessionId) {
		const targetId = sessionId || this.activeSession?.activeSubAgentSessionId || this.activeSessionId;
		if (targetId) {
			this.glowingSessions.add(targetId);
		}

		if (this.isSessionViewed(targetId)) {
			if (this.undulatingGlow) {
				this.undulatingGlow.classList.add('active');
			}
			if (this.conversationArea) {
				const shouldScroll = this._shouldAutoScroll();
				this.conversationArea.classList.add('glow-active');
				if (shouldScroll) {
					this.scrollToBottom(true);
				}
			}
		}
	}

	_stopGlow(sessionId) {
		const targetId = sessionId || this.activeSession?.activeSubAgentSessionId || this.activeSessionId;
		if (targetId) {
			this.glowingSessions.delete(targetId);
		}

		const viewedSessionId = this.activeSession?.activeSubAgentSessionId || this.activeSessionId;
		if (!viewedSessionId || !this.glowingSessions.has(viewedSessionId)) {
			if (this.undulatingGlow) {
				this.undulatingGlow.classList.remove('active');
			}
			if (this.conversationArea) {
				this.conversationArea.classList.remove('glow-active');
			}
		}
	}

	_updateGlowForViewedSession() {
		const viewedSessionId = this.activeSession?.activeSubAgentSessionId || this.activeSessionId;
		if (viewedSessionId && this.glowingSessions.has(viewedSessionId)) {
			if (this.undulatingGlow) {
				this.undulatingGlow.classList.add('active');
			}
			if (this.conversationArea) {
				this.conversationArea.classList.add('glow-active');
			}
		} else {
			if (this.undulatingGlow) {
				this.undulatingGlow.classList.remove('active');
			}
			if (this.conversationArea) {
				this.conversationArea.classList.remove('glow-active');
			}
		}
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
		
		this.artifactsButton = new Button("Settings & Artifacts");
		this.artifactsButton.setIcon("playlist_add_check");
		this.artifactsButton.className = "artifacts-tab-btn theme-button secondary";
		this.artifactsButton.title = "Open Session Settings & Artifacts";
		this.artifactsButton.onclick = () => {
			if (window.ui?.openPlanAndTaskList) {
				window.ui.openPlanAndTaskList();
			}
		};

		this.aiInfoDisplay = document.createElement("select");
		this.aiInfoDisplay.classList.add("ai-info-display", "ai-provider-select");
		this.aiInfoDisplay.addEventListener('change', (e) => {
			this.switchConnection(e.target.value);
		});

		this.thinkingBudgetSelect = document.createElement("select");
		this.thinkingBudgetSelect.classList.add("ai-thinking-select", "ai-provider-select");
		this.thinkingBudgetSelect.setAttribute("title", "Session Thinking Budget Override");
		const thinkingOptions = [
			{ value: "auto", label: "Think: Auto" },
			{ value: "off", label: "Think: Off" },
			{ value: "low", label: "Think: Low" },
			{ value: "medium", label: "Think: Med" },
			{ value: "high", label: "Think: High" },
			{ value: "unlimited", label: "Think: Max" }
		];
		thinkingOptions.forEach(opt => {
			const optionEl = document.createElement("option");
			optionEl.value = opt.value;
			optionEl.textContent = opt.label;
			this.thinkingBudgetSelect.appendChild(optionEl);
		});
		this.thinkingBudgetSelect.addEventListener('change', async (e) => {
			if (!this.activeSession) return;
			const val = e.target.value;
			this.activeSession.thinkingLevel = val;
			await workspaceClient.setSession(this.activeSession.id, this.activeSession);
			this._updateAIInfoDisplay();
		});

		buttonContainer.append(this.artifactsButton);
		buttonContainer.append(this.aiInfoDisplay); // Element is created, but content will be set by _updateAIInfoDisplay()
		buttonContainer.append(this.thinkingBudgetSelect);
		buttonContainer.append(this.rawViewButton); // Add raw view button
		buttonContainer.append(this.settingsButton);
		this.stopButton = new Button("Stop");
		this.stopButton.setIcon("stop");
		this.stopButton.className = "agentic-stop-btn theme-button error";
		this.stopButton.onclick = () => this.stopAgent();

		const spacer = document.createElement("div");
		buttonContainer.append(spacer)
		buttonContainer.append(this.stopButton)
		
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
			bindKey: { win: "Ctrl+Enter", mac: "Ctrl+Enter|Command+Enter" },
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
				getCompletions: async (editor, session, pos, prefix, callback) => {
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
					// 1. Handle Skill Lookup (@skill...)
					if (searchTerm.startsWith('skill')) {
						const skillQuery = searchTerm.substring(5);
						const allSkills = await this._loadAllParsedSkills();
						const skillCompletions = allSkills
							.filter(s => s.name.toLowerCase().includes(skillQuery.toLowerCase()))
							.map(s => ({
								caption: s.name,
								value: `@skill ${s.name}`,
								meta: "Skill"
							}));
						callback(null, skillCompletions);
						return;
					}

					// 2. Handle Symbol Lookup (@file.js#symbol)
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
		this.submitButton = new Button("Send");
		this.submitButton.setIcon("send");
		this.submitButton.classList.add("submit-button", "theme-button");
		this.submitButton.on("click", () => this.generate());
		this._setButtonsDisabledState(this._isProcessing); // Initial state
		return this.submitButton;
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

	get _isProcessing() {
		return this.activeSessionId ? this.runningSessions.has(this.activeSessionId) : false;
	}

	set _isProcessing(value) {
		if (this.activeSessionId) {
			this.setSessionProcessing(this.activeSessionId, value);
		}
	}

	setSessionProcessing(sessionId, processing, type = 'chat', controller = null) {
		if (!sessionId) return;
		if (processing) {
			if (!this.runningSessions.has(sessionId)) {
				this.runningSessions.set(sessionId, { type, controller });
			}
			this._updateTabStatus(sessionId, "running");
		} else {
			this.runningSessions.delete(sessionId);
			this._updateTabStatus(sessionId, "completed");
		}
		this._setButtonsDisabledState(this._isProcessing);
	}

	_updateTabStatus(sessionId, status) {
		if (!this.sessionTabBar) return;
		const tab = this.sessionTabBar.tabs.find(t => t.config.id === sessionId);
		if (!tab) return;

		tab.classList.remove("tab-status-running", "tab-status-halted", "tab-status-completed", "tab-status-pending-query");

		if (status === "running") {
			tab.classList.add("tab-status-running");
			tab._statusIcon.innerHTML = tab._defaultStatusIcon || "developer_board";
			tab._statusIcon.style.animation = "";
		} else if (status === "pending-query") {
			tab.classList.add("tab-status-pending-query");
			tab._statusIcon.innerHTML = "help";
			tab._statusIcon.style.animation = "";
		} else if (status === "halted") {
			tab.classList.add("tab-status-halted");
			tab._statusIcon.innerHTML = "warning";
			tab._statusIcon.style.animation = "";
		} else if (status === "completed") {
			tab.classList.add("tab-status-completed");
			tab._statusIcon.innerHTML = "check_circle";
			tab._statusIcon.style.animation = "";
		} else {
			tab._statusIcon.innerHTML = tab._defaultStatusIcon || "developer_board";
			tab._statusIcon.style.animation = "";
		}
	}

	async editQueuedPrompt(sessionId, promptId) {
		const session = await workspaceClient.getSession(sessionId);
		if (session && session.promptQueue) {
			const index = session.promptQueue.findIndex(p => p.id === promptId);
			if (index !== -1) {
				const [item] = session.promptQueue.splice(index, 1);
				this.promptEditor.setValue(item.content, -1);
				this._resizePromptArea();
				
				session.lastModified = Date.now();
				await workspaceClient.setSession(sessionId, session);
				if (this.activeSessionId === sessionId) {
					this.activeSession.promptQueue = session.promptQueue;
					this.historyManager.render();
				}
			}
		}
	}

	async deleteQueuedPrompt(sessionId, promptId) {
		const session = await workspaceClient.getSession(sessionId);
		if (session && session.promptQueue) {
			session.promptQueue = session.promptQueue.filter(p => p.id !== promptId);
			session.lastModified = Date.now();
			await workspaceClient.setSession(sessionId, session);
			if (this.activeSessionId === sessionId) {
				this.activeSession.promptQueue = session.promptQueue;
				this.historyManager.render();
			}
		}
	}

	async processNextQueuedPrompt(sessionId) {
		const session = await workspaceClient.getSession(sessionId);
		if (session && session.promptQueue && session.promptQueue.length > 0) {
			const nextPrompt = session.promptQueue.shift();
			session.lastModified = Date.now();
			await workspaceClient.setSession(sessionId, session);
			if (this.activeSessionId === sessionId) {
				this.activeSession.promptQueue = session.promptQueue;
				this.promptEditor.setValue(nextPrompt.content, -1);
				this.generate();
			} else {
				this.generateBackground(sessionId, nextPrompt.content);
			}
		}
	}

	async generateBackground(sessionId, promptText) {
		const session = await workspaceClient.getSession(sessionId);
		if (!session) return;
		
		const connId = session.connectionId || AIConnections.defaultConnectionId;
		const connection = AIConnections.getInstance(connId);
		if (!connection || !connection.isConfigured()) return;

		const { processedPrompt, contextItems } = await connection._getContextualPrompt(
			promptText,
			"chat",
			session.evergreenFiles,
			session.agentMode
		);

		contextItems.forEach(item => {
			const contextMessage = {
				type: "file_context",
				id: item.id,
				filename: item.filename,
				language: item.language,
				content: item.content,
				timestamp: Date.now(),
				mode: session.agentMode ? 'outline' : 'full',
			};
			session.messages.push(contextMessage);
		});

		if (!processedPrompt) return;
		const userMessage = { role: "user", type: "user", content: processedPrompt, timestamp: Date.now(), id: crypto.randomUUID() };
		session.messages.push(userMessage);
		session.lastModified = Date.now();
		await workspaceClient.setSession(sessionId, session);

		// Asynchronously tokenize the user prompt
		this.historyManager.tokenizeMessage(userMessage, session).catch(err => {
			console.warn("[AIManager] Async userMessage tokenization error:", err);
		});

		if (session.agentMode) {
			const agent = new Agent(this, session, connection);
			this.runningSessions.set(sessionId, { type: 'agent', instance: agent });
			this._updateTabStatus(sessionId, "running");
			try {
				await agent.run(userMessage, null);
				this._updateTabStatus(sessionId, "completed");
			} catch (e) {
				this._updateTabStatus(sessionId, "halted");
				console.error("Background Agent Error:", e);
			} finally {
				this.runningSessions.delete(sessionId);
				this._setButtonsDisabledState(this._isProcessing);
				this.processNextQueuedPrompt(sessionId);
			}
		} else {
			const modelMessageId = crypto.randomUUID();
			const responseBlock = this.historyManager.createStreamingBlock(modelMessageId, "model", sessionId);
			this.setSessionProcessing(sessionId, true, 'chat', connection);
			
			const callbacks = {
				onUpdate: (fullResponse) => {
					responseBlock.updateContent(fullResponse);
				},
				onDone: async (fullResponse) => {
					const modelMessage = { id: modelMessageId, role: "model", type: "model", content: fullResponse, diffStatuses: [], timestamp: Date.now() };
					session.messages.push(modelMessage);
					session.lastModified = Date.now();
					await workspaceClient.setSession(sessionId, session);
					
					responseBlock.finalize(fullResponse, modelMessage);
					this.setSessionProcessing(sessionId, false);
					this.processNextQueuedPrompt(sessionId);
				},
				onError: async (err) => {
					const errMessage = { id: modelMessageId, role: "model", type: "error", content: err.message, timestamp: Date.now() };
					session.messages.push(errMessage);
					session.lastModified = Date.now();
					await workspaceClient.setSession(sessionId, session);
					
					responseBlock.finalize(err.message, errMessage);
					this.setSessionProcessing(sessionId, false);
					this.processNextQueuedPrompt(sessionId);
				}
			};

			try {
				const messagesForAI = session.messages.filter(m => m.role === 'user' || m.role === 'model');
				const systemPrompt = await this.getSystemPrompt(session);
				connection.chat(messagesForAI, callbacks, systemPrompt);
			} catch (e) {
				console.error("Background Chat generation failed:", e);
				this.setSessionProcessing(sessionId, false);
			}
		}
	}

	// Helper to disable/enable relevant buttons
	_setButtonsDisabledState(disabled) {
		const isAIConfigured = this.ai && this.ai.isConfigured();

		if (this.submitButton) {
			this.submitButton.disabled = !isAIConfigured;
			// Keep submit button visible at all times so they can queue new prompts
			this.submitButton.style.display = 'flex';
		}

		if (this.stopButton) {
			// Stop button is visible if the current active session is processing
			this.stopButton.style.display = this._isProcessing ? 'flex' : 'none';
		}

		// Also disable all history delete, replay, and edit buttons while processing
		if (this.conversationArea) {
			this.conversationArea.querySelectorAll('.delete-history-button, .replay-history-button, .edit-history-button').forEach(btn => btn.disabled = disabled);
		}

		// Never disable tabs/pointer-events! Keep them interactive.
		if (this.newSessionButton) this.newSessionButton.disabled = false;
		if (this.sessionTabBar) {
			this.sessionTabBar.querySelectorAll('ui-tab-item').forEach(tab => {
				tab.close.style.pointerEvents = '';
				tab.style.pointerEvents = 'auto';
			});
		}

		this._updatePromptAreaPlaceholder(); // Update prompt area disabled state
	}

	/**
	 * Selects the most appropriate connection for a sub-agent based on hint size and parent connection.
	 * Available connections are tested first before matching.
	 * @param {string} hintSize - 'tiny', 'small', or 'medium'.
	 * @param {string} parentConnectionId - The connection ID of the parent session.
	 * @returns {Promise<string>} The selected connection ID.
	 */
	async selectConnectionForSubAgent(hintSize, parentConnectionId) {
		const allConfiguredConnections = AIConnections.getConnections().filter(c => {
			const inst = AIConnections.getInstance(c.id);
			return inst && inst.isConfigured();
		});

		// Test configured connections for availability in parallel
		const testedResults = await Promise.all(
			allConfiguredConnections.map(async (conn) => {
				try {
					await AIConnections.testConnection(conn);
					return { conn, available: true };
				} catch (e) {
					console.warn(`[Connection Selector] Skipping connection '${conn.id}' because availability test failed:`, e.message);
					return { conn, available: false };
				}
			})
		);

		const connections = testedResults
			.filter(r => r.available)
			.map(r => r.conn);

		const isBusy = (connId) => {
			for (const [sessionId, running] of this.runningSessions) {
				let conn = null;
				if (running.type === 'agent' && running.instance) {
					conn = running.instance.connection;
				} else if (running.type === 'chat' && running.controller) {
					conn = running.controller;
				}
				if (conn && conn.connectionId === connId) {
					return true;
				}
			}
			return false;
		};

		let nearOrder = [];
		if (hintSize === 'tiny') {
			nearOrder = ['tiny', 'small'];
		} else if (hintSize === 'small') {
			nearOrder = ['small', 'medium', 'tiny'];
		} else if (hintSize === 'medium') {
			nearOrder = ['medium', 'small', 'tiny'];
		} else {
			nearOrder = [hintSize];
		}

		// Step 1: Exact size match, not busy.
		for (const conn of connections) {
			if (conn.size === hintSize && !isBusy(conn.id)) {
				return conn.id;
			}
		}

		// Step 2: Near size match, not busy (in nearOrder, excluding exact).
		const nearCandidatesOnly = nearOrder.filter(size => size !== hintSize);
		for (const size of nearCandidatesOnly) {
			for (const conn of connections) {
				if (conn.size === size && !isBusy(conn.id)) {
					return conn.id;
				}
			}
		}

		// Step 3: Exact size match, busy.
		for (const conn of connections) {
			if (conn.size === hintSize) {
				return conn.id;
			}
		}

		// Step 4: Near size match, busy.
		for (const size of nearCandidatesOnly) {
			for (const conn of connections) {
				if (conn.size === size) {
					return conn.id;
				}
			}
		}

		// Step 5: Reuse the same connection as parent session (regardless of size).
		if (parentConnectionId) {
			const parentConn = AIConnections.getConnection(parentConnectionId);
			if (parentConn) {
				return parentConn.id;
			}
		}

		// Fallback to default connection
		return parentConnectionId || AIConnections.defaultConnectionId;
	}

	/**
	 * Switches the AI connection, re-initializes it, and updates the UI.
	 * @param {string} connId - The connection config ID.
	 */
	async switchConnection(connId) {
		if (!this.activeSession) return;
		this.activeSession.connectionId = connId;
		await workspaceClient.setSession(this.activeSession.id, this.activeSession);

		const conn = AIConnections.getInstance(connId);
		if (conn) {
			try {
				await conn.init();
				this.historyManager.addMessage({
					type: "system_message",
					content: `Connection switched to **${conn.config.model || conn.providerId}** (${conn.connectionId}).`,
					timestamp: Date.now()
				}, false);
			} catch (error) {
				console.error("AIManager: Error initializing connection during switch:", error);
				this.historyManager.addMessage({
					type: "system_message",
					content: `Error switching connection. Check settings. Details: ${error.message}`,
					timestamp: Date.now()
				}, false);
			}
		}

		this._updateAIInfoDisplay();
		this._dispatchContextUpdate("ai_connection_switched");
		this.historyManager.render();
		this._setButtonsDisabledState(this._isProcessing);
		this._updatePromptAreaPlaceholder();
	}

	toggleSettingsPanel() {
		if (window.ui?.openAgentConfig) {
			window.ui.openAgentConfig();
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
	 * Centralized update calls this.
	 * @param {object} detail - The event detail object from _dispatchContextUpdate.
	 */
	_updateContextUI(detail) {
		// Update Progress Bar
		if (this.progressBar && this.ai) {
			const { estimatedWindow, estimatedTokensFullHistory, maxContextTokens } = detail
			const progressBarInner = this.progressBar.querySelector(".progress-bar-inner")
			const progressBarFullHistory = this.progressBar.querySelector(".progress-bar-full-history")

			// Only show progress bar if AI is configured, otherwise hide or set to 0
			if (this.ai.isConfigured() && maxContextTokens > 0) {
				this.progressBar.style.display = "block";
				
				// Calculate active window (active message tokens) percentage
				const percentageWindow = Math.min(100, (estimatedWindow / maxContextTokens) * 100)
				progressBarInner.style.width = `${percentageWindow}%`
				this._updateProgressBarColor(progressBarInner, percentageWindow)

				// Calculate full history (whole thread tokens) percentage
				const percentageFull = Math.min(100, (estimatedTokensFullHistory / maxContextTokens) * 100)
				if (progressBarFullHistory) {
					progressBarFullHistory.style.width = `${percentageFull}%`
					this._updateProgressBarColor(progressBarFullHistory, percentageFull)
				}

				this.progressBar.setAttribute(
					"title",
					`Context: Active ${estimatedWindow} t (${Math.round(percentageWindow)}%) | Total ${estimatedTokensFullHistory} t (${Math.round(percentageFull)}%) / Max ${maxContextTokens} t`
				)
			} else {
				this.progressBar.style.display = "none"; // Hide progress bar if not configured
				progressBarInner.style.width = "0%";
				if (progressBarFullHistory) progressBarFullHistory.style.width = "0%";
				this.progressBar.setAttribute("title", `AI not configured or max tokens unknown.`);
				this._updateProgressBarColor(progressBarInner, 0); // Reset color
				if (progressBarFullHistory) this._updateProgressBarColor(progressBarFullHistory, 0);
			}
		}
	}

	// Method to update the AI info display element
	_updateAIInfoDisplay() {
		if (this.aiInfoDisplay) {
			this.aiInfoDisplay.innerHTML = "";
			const currentConnId = this.activeSession?.connectionId || AIConnections.defaultConnectionId;
			const connections = AIConnections.getConnections();
			
			connections.forEach(conn => {
				const option = document.createElement("option");
				option.value = conn.id;
				let prefix = "";
				const size = conn.size || "medium";
				if (size === "tiny") prefix = "[T] ";
				else if (size === "small") prefix = "[S] ";
				else if (size === "medium") prefix = "[M] ";
				else if (size === "large") prefix = "[L] ";
				else if (size === "ultra") prefix = "[U] ";

				let label = prefix + conn.name;
				if (conn.config?.model) {
					label += ` (${conn.config.model})`;
				}
				option.textContent = label;
				if (conn.id === currentConnId) {
					option.selected = true;
				}
				this.aiInfoDisplay.appendChild(option);
			});

			const activeAi = this.ai;
			if (activeAi && activeAi.isConfigured()) {
				const modelName = activeAi.config?.model || "No Model";
				this.aiInfoDisplay.setAttribute("title", `Connection: ${activeAi.connectionId}, Model: ${modelName}`);
			} else {
				this.aiInfoDisplay.setAttribute("title", `Connection Status: Not Configured`);
			}
		}

		if (this.thinkingBudgetSelect) {
			const sessionThinking = this.activeSession?.thinkingLevel || "auto";
			this.thinkingBudgetSelect.value = sessionThinking;
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

	isSessionViewed(sessionId) {
		if (this.activeSession?.activeSubAgentSessionId) {
			return this.activeSession.activeSubAgentSessionId === sessionId;
		}
		return this.activeSessionId === sessionId;
	}

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

		if (this.activeSession && type !== "session_deleted" && type !== "session_closed" && type !== "tokens_updated") {
			this.historyManager.updateMessageTokenCounts(this.activeSession).catch(err => {
				console.warn("[AIManager] Failed to update background token counts:", err);
			});
		}
	}

	async stopAgent(sessionId = null) {
		const targetSessionId = sessionId || this.activeSessionId;
		if (!targetSessionId) return;

		// Count active sub-agents
		let activeSubAgentsCount = 0;
		for (const [id, run] of this.runningSessions) {
			if (run.type === 'agent' && run.instance?.session?.parentId === targetSessionId) {
				activeSubAgentsCount++;
			}
		}

		if (activeSubAgentsCount > 0) {
			const confirmed = await window.modal.confirm(`This session has ${activeSubAgentsCount} active sub-agents, are you sure?`, "Stop Execution");
			if (!confirmed) {
				return;
			}
		}

		// Abort agent if it's running
		const running = this.runningSessions.get(targetSessionId);
		if (running) {
			if (running.type === 'agent' && running.instance) {
				running.instance.stop("User requested stop");
			}
			if (running.controller && typeof running.controller.stop === 'function') {
				running.controller.stop();
			}
		}

		if (targetSessionId === this.activeSessionId) {
			this._abortAgent = true;
			if (this.ai && typeof this.ai.stop === 'function') {
				this.ai.stop();
			}
			this._stopGlow(targetSessionId);
			this.consecutiveHaltCount = 0;
			if (this.haltBar) {
				this.haltBar.remove();
				this.haltBar = null;
			}
			if (this.throttleBar) {
				this.throttleBar.remove();
				this.throttleBar = null;
			}
			if (this.conversationArea) {
				const containers = this.conversationArea.querySelectorAll('.prefill-progress-container');
				containers.forEach(container => container.remove());
			}
		}

		this.setSessionProcessing(targetSessionId, false);
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
			this.activeAgent = new Agent(this, this.activeSession, this.ai);
			await this.activeAgent.run(null, null);
			this.activeAgent = null;
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
			const promptText = this.promptEditor.getValue().trim();
			if (!promptText) return;

			if (!this.activeSession.promptQueue) {
				this.activeSession.promptQueue = [];
			}
			this.activeSession.promptQueue.push({
				id: crypto.randomUUID(),
				content: promptText,
				timestamp: Date.now()
			});
			this.activeSession.lastModified = Date.now();
			await workspaceClient.setSession(this.activeSession.id, this.activeSession);
			this.promptEditor.setValue("");
			this._resizePromptArea();
			
			// Re-render history to show the queued prompts at the bottom
			this.historyManager.render();
			return;
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

		const targetSession = this.activeSession;
		const targetSessionId = this.activeSessionId;
		const targetAI = this.ai;
		const targetAgentMode = this.agentMode;
		const targetForgivenessMode = this.forgivenessMode;

		// Clear min-height from all previous response blocks to let them reflow naturally.
		this.conversationArea.querySelectorAll('.response-block').forEach(block => {
			block.style.minHeight = '';
		});

		this._unsentPromptBuffer = null; // Clear the unsent prompt buffer on submission.
		this.setSessionProcessing(targetSessionId, true, targetAgentMode ? 'agent' : 'chat', targetAgentMode ? null : targetAI);

		const userPrompt = this.promptEditor.getValue().trim();

		if (!userPrompt) {
			this.setSessionProcessing(targetSessionId, false);
			return;
		}

		// Force re-enable autoscroll upon user prompt submission
		this._autoscrollEnabled = true;
		this._hideAutoscrollChip();
		if (this.activeSession) {
			this.activeSession.autoscrollEnabled = true;
		}
		this.scrollToBottom(true);

		// Check for automatic summarization before processing the new prompt
		const estimatedTokensBeforeNewPrompt = targetAI.estimateTokens(targetSession.messages);
		const maxContextTokens = targetAI.MAX_CONTEXT_TOKENS;
		if (
			maxContextTokens > 0 &&
			(estimatedTokensBeforeNewPrompt / maxContextTokens) * 100 >= this.config.summarizeThreshold
		) {
			console.log(
				`Context at ${Math.round(
					(estimatedTokensBeforeNewPrompt / maxContextTokens) * 100
				)}%, triggering summarization.`
			);

			if (targetAgentMode) {
				// Agent mode: standard performSummarization() is gated OFF here, so condense the latest completed-but-unsummarized task cycle into one cycle_summary instead — same boundary logic & idempotency guard as the manual "Summarize Cycle" path. No-op (no AI call) when there's no such cycle yet; sliding-window pruning in prepareMessagesForAI remains the hard cap either way, this just trades lost turns for a durable summary before they'd be pruned away forever.
				const compacted = await this.historyManager.autoCompactAgentCycle(targetSession);
			} else {
				await this.historyManager.performSummarization(); // Await summarization before continuing (standard mode only).
			}
		}

		// NEW: Check for stale context files and handle user interaction
		const proceed = await this._checkForStaleContextFiles(userPrompt);
		if (!proceed) {
			// Abort was chosen. _checkForStaleContextFiles handles restoration.
			this.setSessionProcessing(targetSessionId, false);
			return;
		}
		// Now that checks are passed, add prompt to history and clear the editor
		const activePromptHistory = targetSession.promptHistory;
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
		const { processedPrompt, contextItems } = await targetAI._getContextualPrompt(
            userPrompt, 
            "chat", 
            targetSession.evergreenFiles,
            targetAgentMode
        );

		// NEW: Remove any existing context items for the same files being added in this turn
		if (contextItems.length > 0) {
			const newFileIds = new Set(contextItems.map(item => item.id));
			targetSession.messages = targetSession.messages.filter(msg =>
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
				mode: targetAgentMode ? 'outline' : 'full',
			};
			
			if (targetAgentMode) {
				window.conduit.wsGetOutline(item.id).then(res => {
					contextMessage.outline = res.data;
					if (this.activeSessionId === targetSessionId) {
						this.historyManager.render();
					}
				}).catch(err => console.error("Failed to get outline", err));
			}

			targetSession.messages.push(contextMessage);
			// NEW: Add context files to the file bar instead of the main chat area
			if (this.activeSessionId === targetSessionId) {
				this.fileBar.add(contextMessage);
			}
		});

		let userMessage = null;
		let userMessageElement = null; // To hold the DOM element of the user's prompt
		if (processedPrompt) {
			userMessage = { role: "user", type: "user", content: processedPrompt, timestamp: Date.now(), id: crypto.randomUUID() };
			targetSession.messages.push(userMessage);
			if (this.activeSessionId === targetSessionId) {
				userMessageElement = this.historyManager.appendMessageElement(userMessage);
			}
		} else {
			// Scenario: Context items were added, but no user prompt was given.
			// In this case, we don't call the AI, acknowledge the context addition, and abort.
			if (contextItems.length > 0) {
				const fileNames = contextItems.map(item => `**${item.filename}**`).join(', ');
				if (this.activeSessionId === targetSessionId) {
					this.historyManager.addMessage({
						type: "system_message",
						content: `Files added to context: ${fileNames}.`,
						timestamp: Date.now(),
					}, false);
				}
				// We still need to save the session since context items were added.
				targetSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSession.id, targetSession);
				if (this.activeSessionId === targetSessionId) {
					this._dispatchContextUpdate("context_files_updated");
				}
			}
			this.setSessionProcessing(targetSessionId, false);
			return; // Exit the function as there's no prompt to send to the AI.
		}

		// Save session and dispatch update now that we've confirmed there's a user prompt.
		// Update lastModified timestamp for the session
		targetSession.lastModified = Date.now();
		// Save the active session to IndexedDB immediately after adding user prompt and context
		await workspaceClient.setSession(targetSession.id, targetSession);

		// Render updated history in UI and dispatch event
		if (this.activeSessionId === targetSessionId) {
			this._dispatchContextUpdate("append_user"); // This will also save workspace metadata
		}

		// Asynchronously tokenize the user prompt
		if (userMessage) {
			this.historyManager.tokenizeMessage(userMessage, targetSession).catch(err => {
				console.warn("[AIManager] Async userMessage tokenization error:", err);
			});
		}

		// Auto-rename if this is the first message and the name is default
		if (targetSession.messages.filter(m => m.type === 'user').length === 1 && targetSession.name.startsWith("Chat ")) {
			// Don't await it, let it run in the background
			this.sessionsManager.autoRenameSession(userMessage.content);
		}

		if (targetAgentMode) {
			const agent = new Agent(this, targetSession, targetAI);
			const runningSession = this.runningSessions.get(targetSessionId);
			if (runningSession) {
				runningSession.instance = agent;
			}
			try {
				await agent.run(userMessage, userMessageElement);
				this.setSessionProcessing(targetSessionId, false);
			} catch (e) {
				console.error(e);
				this._updateTabStatus(targetSessionId, "halted");
				this.runningSessions.delete(targetSessionId);
				this._setButtonsDisabledState(this._isProcessing);
			} finally {
				this.processNextQueuedPrompt(targetSessionId);
			}
			return;
		}
		// NEW: Create and append the new ui-loader-bar *before* the response block
		// Ensure we calculate the space needed for the loader + response block, accounting for the file bar.
		const fileBarContainer = this.panel.querySelector('.ai-filebar-container');
		const fileBarHeight = fileBarContainer ? fileBarContainer.offsetHeight : 0;
		const availableHeightForResponse = this.conversationArea.clientHeight - (fileBarHeight + 16);

		// Prepare placeholder for AI response
		const modelMessageId = crypto.randomUUID(); // Pre-generate ID for the upcoming model response
		const responseBlock = this.historyManager.createStreamingBlock(modelMessageId, "model", targetSessionId);
		
		if (this.isSessionViewed(targetSessionId)) {
			this._startGlow(targetSessionId);
			this.conversationArea.append(responseBlock);

			// NEW: Scroll the conversation area so the user's prompt is near the top.
			if (userMessageElement) {
				// We account for the sticky file bar's height, just like you remembered!
				const fileBarContainer = this.panel.querySelector('.ai-filebar-container');
				const fileBarOffset = fileBarContainer ? fileBarContainer.offsetHeight : 0;
				const PADDING_FROM_TOP = 8; // A little extra breathing room
				this.conversationArea.scrollTop = userMessageElement.offsetTop - fileBarOffset - PADDING_FROM_TOP;
			}
		}

		const callbacks = {
			onUpdate: (fullResponse) => { // Update the responseBlock directly
				if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
					this._startGlow(targetSessionId);
				} else {
					this._stopGlow(targetSessionId);
				}
				const shouldScroll = this._shouldAutoScroll();
				responseBlock.updateContent(fullResponse);
				if (this.isSessionViewed(targetSessionId) && shouldScroll && this.conversationArea) {
					this.scrollToBottom(true);
				}
			},
			onDone: async (fullResponse, contextRatioPercent) => { // Mark async to await set
				this._stopGlow(targetSessionId);
				// First, update the session data and add the delete button to the user's prompt.
				const modelMessage = { id: modelMessageId, role: "model", type: "model", content: fullResponse, diffStatuses: [], timestamp: Date.now() };
				if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
					modelMessage.toolCalls = callbacks.toolCalls;
				}
				if (callbacks.thoughtSignature) {
					modelMessage.thoughtSignature = callbacks.thoughtSignature;
				}
				targetSession.messages.push(modelMessage);
				if (this.isSessionViewed(targetSessionId)) {
					this.historyManager.addInteractionToLastUserMessage(userMessage); // Add delete button to user prompt
				}
				targetSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSession.id, targetSession);

				// Now, render the final response in the UI using finalize().
				responseBlock.finalize(fullResponse, modelMessage);

				// NEW: Chat-mode output checks for diff blocks
				if (!targetAgentMode) {
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
							let tab = await targetAI._getTabSessionByPath(targetPath);
							if (!tab) {
								const fileData = targetAI._findFileByPath(targetPath);
								if (fileData && window.ui && window.ui.fileList && window.ui.fileList.open) {
									await window.ui.fileList.open(fileData);
									tab = await targetAI._getTabSessionByPath(fileData.path);
								}
							}

							let currentContent = "";
							if (tab && tab.config && tab.config.session) {
								currentContent = tab.config.session.getValue();
							} else {
								// Fallback: try looking in file_context from history
								let contextContent = null;
								const normalizedTargetPath = targetPath.startsWith('/') ? targetPath.substring(1) : targetPath;
								for (let i = targetSession.messages.length - 1; i >= 0; i--) {
									const msg = targetSession.messages[i];
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
							} else if (targetForgivenessMode) {
								// Chat+forgiveness mode: Successful merge commits directly to the current file buffer (Ace session)
								if (tab && tab.config && tab.config.session) {
									const filePathForBackup = tab.config.path;
									let backupId = "";
									const activeSession = targetSession;
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
									if (this.activeSessionId === targetSessionId) {
										tab.click();
									}

									if (this.activeSessionId === targetSessionId) {
										this.historyManager.addMessage({
											type: "system_message",
											content: `Diff successfully applied to **${targetPath}** in Forgiveness Mode. Remember to save the file.`,
											timestamp: Date.now(),
										});
									}
								}
							}
						}

						if (anyFailed && this.isSessionViewed(targetSessionId)) {
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
						} else if (targetForgivenessMode) {
							// Update IndexedDB to persist the updated diffStatuses and backup references
							await workspaceClient.setSession(targetSession.id, targetSession);
						}
					}
				}

				if (this.isSessionViewed(targetSessionId)) {
					this._dispatchContextUpdate("append_model"); // Dispatch after model response
				}

				this.setSessionProcessing(targetSessionId, false);
				this.processNextQueuedPrompt(targetSessionId);
			},
			onError: async (error) => { // Mark async to await set
				this._stopGlow(targetSessionId);
				// The spinner is also removed here when innerHTML is overwritten.
				responseBlock.style.minHeight = ''; // Reset min-height on error too
				if (typeof responseBlock.updateContent === 'function') {
					responseBlock.updateContent(`Error: ${error.message}`);
				} else {
					responseBlock.innerHTML = `Error: ${error.message}`;
				}
				console.error(`Error calling ${targetAI.config?.model || "AI"} API:`, error);

				const errorMessage = {
					id: modelMessageId, // Use the pre-generated ID for the block
					role: "error",
					type: "error",
					content: `Error: ${error.message}`,
					timestamp: Date.now(),
					diffStatuses: [], // Initialize even for errors, though no diffs expected here
				};
				targetSession.messages.push(errorMessage);
				// Update lastModified timestamp and save the active session
				// No interaction added for errors.
				targetSession.lastModified = Date.now();
				await workspaceClient.setSession(targetSession.id, targetSession);

				if (this.isSessionViewed(targetSessionId)) {
					this._dispatchContextUpdate("append_error");
				}

				this.setSessionProcessing(targetSessionId, false);
				this.processNextQueuedPrompt(targetSessionId);
			},
			onContextRatioUpdate: (ratio) => { /* ... */ },
			onPrefillProgress: (progressData) => {
				if (this.activeSessionId === targetSessionId) {
					const total = progressData.total;
					const cache = progressData.cache || 0;
					const processed = progressData.processed;
					const pct = (total - cache > 0) ? Math.round(((processed - cache) / (total - cache)) * 100) : (total > 0 ? Math.round((processed / total) * 100) : 0);
					this._showPrefillProgress(responseBlock, pct, progressData);
				}
			},
		};

		// Since we now return early if `processedPrompt` is empty, we can unconditionally call the AI here.
		const messagesForAI = this.historyManager.prepareMessagesForAI();
		const systemPrompt = await this.getSystemPrompt();
		targetAI.chat(messagesForAI, callbacks, systemPrompt, targetSession); // Pass session so per-session thinkingLevel override applies.
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
			const args = this.messageRenderer.parseToolArgs(toolArgsContent);

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
		if (toolCall.name === "edit_file") {
			const args = toolCall.arguments || {};
			if (!args.path) {
				return `Tool Error: edit_file requires "path" parameter.`;
			}
			const hasSingleEdit = args.search !== undefined && args.replace !== undefined;
			const hasEditsArray = Array.isArray(args.edits) && args.edits.length > 0;
			if (!hasSingleEdit && !hasEditsArray) {
				return `Tool Error: edit_file requires either (search, replace) parameters or an "edits" array of [{ search, replace }].`;
			}
			return null;
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
				this.scrollToBottom(true);
			}
		});
	}

	async generateCycleSummary(cycleMessages) {
		if (!this.ai || !this.ai.isConfigured()) return "";

		const eligibleMessages = cycleMessages.filter(
			(msg) => msg.type === "user" || msg.type === "model" || msg.type === "tool_response"
		);

		// Distill messages to capture essential intent and action without bloating context
		const distillMessage = (msg) => {
			let content = msg.content || "";
			
			// 1. Strip raw thinking blocks from summarization prompt
			content = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
			content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
			content = content.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '');

			if (msg.type === "tool_response") {
				// Truncate massive tool response outputs (e.g. huge file reads or directory listings)
				if (content.length > 800) {
					content = content.substring(0, 500) + "\n...[output truncated for summarization]...\n" + content.substring(content.length - 200);
				}
				return `[Tool Response]\n${content.trim()}`;
			}

			if (msg.role === "model") {
				// If model did a tool call, summarize the tool call parameters concisely
				if (msg.toolCalls && msg.toolCalls.length > 0) {
					const toolDetails = msg.toolCalls.map(tc => {
						const call = tc.functionCall || tc;
						const name = call.name;
						const args = typeof call.args === 'string' ? JSON.parse(call.args || '{}') : (call.args || {});
						let argSummary = "";
						if (args.path) argSummary = `path: ${args.path}`;
						else if (args.command) argSummary = `cmd: ${args.command}`;
						else if (args.query) argSummary = `query: ${args.query}`;
						return `[Action: ${name} (${argSummary})]`;
					}).join(" ");
					
					// Combine tool details with any accompanying text
					const cleanText = content.replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '').trim();
					return `[Assistant]\n${toolDetails}${cleanText ? `\n${cleanText}` : ''}`;
				}
				return `[Assistant]\n${content.trim()}`;
			}

			return `[User]\n${content.trim()}`;
		};

		// Distill all messages in the cycle
		const distilledTurns = eligibleMessages.map(distillMessage).filter(Boolean);

		// Determine target AI connection for summarization: prefer small/medium background connection
		let summarizationAI = this.ai;
		try {
			const parentConnId = this.activeSession?.connectionId || "default-gemini";
			const smallConnId = await this.selectConnectionForSubAgent("small", parentConnId);
			if (smallConnId) {
				const candidateAI = AIConnections.getInstance(smallConnId);
				if (candidateAI && candidateAI.isConfigured()) {
					summarizationAI = candidateAI;
				}
			}
		} catch (e) {
			console.warn("[Cycle Summary] Could not select smaller sub-agent connection, using current AI:", e);
		}

		// Determine safe token budget for summarization (use 60% of model context window or fallback to 8000 tokens)
		const maxTokens = (summarizationAI.MAX_CONTEXT_TOKENS || 8192);
		const budgetTokens = Math.max(2000, Math.floor(maxTokens * 0.6));

		// Function to perform a single AI summarization call without reasoning overhead
		const runSummaryCall = async (contextText) => {
			const prompt = `Please summarize the following agent task cycle.
You must output your response in the following XML format:
<title>A very concise, single-line, active-voice title summarizing the main outcome of the cycle (max 10 words)</title>
<summary>
Outline what the user requested, what implementation actions (file edits, creations, commands) the agent performed, and the final outcome/results. Keep the summary concise but descriptive of all changes.
</summary>

Here is the task cycle to summarize:
${contextText}`;

			let summaryResponse = "";
			await new Promise((resolve, reject) => {
				summarizationAI.chat(
					[{ role: "user", content: prompt }],
					{
						onUpdate: (response) => {
							summaryResponse = response;
						},
						onDone: () => resolve(),
						onError: (error) => reject(error),
					},
					null,
					{ disableReasoning: true } // Disable reasoning overhead
				);
			});
			return summaryResponse;
		};

		let finalSummaryResponse = "";

		try {
			const fullContent = distilledTurns.join("\n\n");
			const estimated = this.ai.estimateTokens(fullContent);

			if (estimated <= budgetTokens) {
				// Fits easily in single context call
				finalSummaryResponse = await runSummaryCall(fullContent);
			} else {
				// Large cycle: split turns into sequential chunks, summarize each chunk, then summarize the condensed chunks
				console.info(`[Cycle Summary] Large cycle (${estimated} est. tokens). Summarizing in chunks within ${budgetTokens} token budget.`);
				
				const chunks = [];
				let currentChunk = [];
				let currentTokens = 0;

				for (const turn of distilledTurns) {
					const turnTokens = this.ai.estimateTokens(turn);
					if (currentTokens + turnTokens > budgetTokens && currentChunk.length > 0) {
						chunks.push(currentChunk.join("\n\n"));
						currentChunk = [turn];
						currentTokens = turnTokens;
					} else {
						currentChunk.push(turn);
						currentTokens += turnTokens;
					}
				}
				if (currentChunk.length > 0) {
					chunks.push(currentChunk.join("\n\n"));
				}

				// Summarize each chunk
				const intermediateSummaries = [];
				for (let i = 0; i < chunks.length; i++) {
					const chunkResp = await runSummaryCall(chunks[i]);
					const cleanChunk = chunkResp.trim();
					const sMatch = cleanChunk.match(/<summary>([\s\S]*?)<\/summary>/i);
					intermediateSummaries.push(`--- Phase ${i + 1} Summary ---\n${sMatch ? sMatch[1].trim() : cleanChunk}`);
				}

				// Final recursive consolidation
				finalSummaryResponse = await runSummaryCall(intermediateSummaries.join("\n\n"));
			}
		} catch (error) {
			console.error("Error during cycle summarization AI call:", error);
			return null;
		}

		let cleanResponse = (finalSummaryResponse || "").trim();
		// Explicitly strip any thought blocks emitted by thinking models
		cleanResponse = cleanResponse.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
		cleanResponse = cleanResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
		cleanResponse = cleanResponse.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '').trim();

		let title = "";
		let summary = "";
		const titleMatch = cleanResponse.match(/<title>([\s\S]*?)<\/title>/i);
		const summaryMatch = cleanResponse.match(/<summary>([\s\S]*?)<\/summary>/i);
		
		if (titleMatch) title = titleMatch[1].trim();
		if (summaryMatch) summary = summaryMatch[1].trim();
		
		if (!title && !summary) {
			summary = cleanResponse;
			title = summary.split(/[.\n]/)[0].trim();
		} else if (!title) {
			title = summary.split(/[.\n]/)[0].trim();
		} else if (!summary) {
			// If summary tag was missing or unclosed but title was extracted, strip title from text to get summary
			summary = cleanResponse.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<\/?summary>/gi, '').trim();
			if (!summary) summary = cleanResponse;
		}

		// Clean up any remaining residual XML tags in extracted summary
		summary = summary.replace(/<\/?summary>/gi, '').trim();

		// Hard-limit title: strip extraneous tags/quotes and cap at max 10 words
		if (title) {
			title = title.replace(/^["'«“]+|["'»”]+$/g, '').trim();
			const words = title.split(/\s+/).filter(Boolean);
			if (words.length > 10) {
				title = words.slice(0, 10).join(" ") + "...";
			}
		}

		return { title, summary };
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
		throw new Error("_runAgentLoop is retired and moved to Agent class");
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

	async _finalizeModelMessage(fullResponse, forcedReason, callbacks, modelMessageId, responseBlock, sessionObj = null) {
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

		// Extract thought if present in finalizedResponse
		let thoughtText = "";
		const thoughtMatch = finalizedResponse.match(/<(?:thought|think)>([\s\S]*?)<\/(?:thought|think)>/i)
			|| finalizedResponse.match(/<\|channel\>thought\n([\s\S]*?)(?:<\|channel\>|$)/i);
		if (thoughtMatch) {
			thoughtText = thoughtMatch[1].trim();
		}

		// Clean up XML tags from finalized text content
		let cleanText = finalizedResponse
			.replace(/<(?:thought|think)>[\s\S]*?<\/(?:thought|think)>/gi, '')
			.replace(/<\|channel\>thought\n[\s\S]*?(?:<\|channel\>|$)/gi, '')
			.replace(/<tool_call\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/tool_call>/gi, '')
			.replace(/<tool_call[\s\S]*?>/gi, '')
			.replace(/<\/tool_call>/gi, '')
			.trim();

		const modelMessage = {
			id: modelMessageId,
			role: "model",
			type: "model",
			content: cleanText,
			diffStatuses: [],
			timestamp: Date.now()
		};
		if (thoughtText) {
			modelMessage.thought = thoughtText;
		}
		if (callbacks.totalThinkingMs !== undefined) {
			modelMessage.thoughtDurationMs = callbacks.totalThinkingMs;
		}
		if (callbacks.thoughtSignature) {
			modelMessage.thoughtSignature = callbacks.thoughtSignature;
		}
		if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
			modelMessage.toolCalls = callbacks.toolCalls;
		}

		const targetSession = sessionObj || this.activeSession;
		const existingIndex = targetSession.messages.findIndex(m => m.id === modelMessage.id);
		if (existingIndex !== -1) {
			targetSession.messages[existingIndex] = modelMessage;
		} else {
			targetSession.messages.push(modelMessage);
		}
		targetSession.lastModified = Date.now();
		await workspaceClient.setSession(targetSession.id, targetSession);

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
			const alertMsg = {
				type: "system_message",
				content: alertContent,
				timestamp: Date.now()
			};
			targetSession.messages.push(alertMsg);
			if (this.activeSessionId === targetSession.id) {
				this.historyManager.appendMessageElement(alertMsg);
			}
			targetSession.lastModified = Date.now();
			await workspaceClient.setSession(targetSession.id, targetSession);
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
	/**
	 * Scans messages for sub-agent session IDs and permanently deletes their data.
	 * @param {Array} messages - The list of message objects.
	 */
	async deleteSubAgentsInMessages(messages) {
		if (!messages || !Array.isArray(messages)) return;
		for (const msg of messages) {
			if (msg.type === "user" && msg.content && msg.content.startsWith("[sub-agent:")) {
				const subId = msg.content.substring(11, msg.content.length - 1);
				try {
					// Stop the sub-agent if it is currently running
					const running = this.runningSessions?.get(subId);
					if (running && running.type === 'agent' && running.instance) {
						running.instance.stop("Sub-agent deleted from history");
					}
					// Cascade delete session files
					await this.sessionsManager._deleteSessionDataWithCascade(subId);
				} catch (e) {
					console.error("Failed to delete sub-agent session:", subId, e);
				}
			}
		}
	}

	async editMessage(messageId) {
		if (this._isProcessing) {
			console.warn("AI is currently processing another request. Please wait.");
			return;
		}

		if (!this.activeSession) return;

		const msgIndex = this.activeSession.messages.findIndex(m => m.id === messageId);
		if (msgIndex === -1) return;

		const userMessage = this.activeSession.messages[msgIndex];
		if (userMessage.type !== "user") return;

		const promptText = userMessage.content || "";

		// 1. Delete target turn and all subsequent turns and their sub-agents
		const deletedMessages = this.activeSession.messages.slice(msgIndex);
		await this.deleteSubAgentsInMessages(deletedMessages);

		this.activeSession.messages.splice(msgIndex);
		this.activeSession.lastModified = Date.now();
		await workspaceClient.setSession(this.activeSession.id, this.activeSession);

		// 2. Re-render the history so all following messages disappear from the screen
		this.historyManager.render();

		// 3. Update buttons and dispatch update
		this._setButtonsDisabledState(this._isProcessing);
		this._dispatchContextUpdate("edit_prompt");

		// 4. Copy prompt text into editor and focus
		if (this.promptEditor) {
			this.promptEditor.setValue(promptText, -1);
			this.promptEditor.focus();
		}
	}

	async replayMessage(messageId) {
		if (this._isProcessing) {
			console.warn("AI is currently processing another request. Please wait.")
			return;
		}

		if (!this.activeSession) return;

		const msgIndex = this.activeSession.messages.findIndex(m => m.id === messageId);
		if (msgIndex === -1) return;

		const targetMsg = this.activeSession.messages[msgIndex];
		let promptIndex = msgIndex;
		let promptUserMessage = null;

		if (targetMsg.type === "user") {
			promptIndex = msgIndex;
			promptUserMessage = targetMsg;
		} else if (targetMsg.type === "model" || targetMsg.type === "error") {
			// Locate the preceding user prompt or tool_response that triggered this model turn
			for (let i = msgIndex - 1; i >= 0; i--) {
				const m = this.activeSession.messages[i];
				if (m.type === "user" || m.type === "tool_response") {
					promptIndex = i;
					if (m.type === "user") {
						promptUserMessage = m;
					}
					break;
				}
			}
		}

		// 1. Delete all turns AFTER the triggering prompt (including the target model response if replaying from a model turn)
		const deletedMessages = this.activeSession.messages.slice(promptIndex + 1);
		await this.deleteSubAgentsInMessages(deletedMessages);

		this.activeSession.messages.splice(promptIndex + 1);
		this.activeSession.lastModified = Date.now();
		await workspaceClient.setSession(this.activeSession.id, this.activeSession);

		// 2. Re-render the history so all following messages disappear from the screen
		this.historyManager.render();

		// 3. Trigger the generation turn using the remaining history!
		this._unsentPromptBuffer = null;
		this._isProcessing = true;
		this._setButtonsDisabledState(true);

		if (this.agentMode) {
			const promptElement = promptUserMessage ? this.conversationArea.querySelector(`[data-message-id="${promptUserMessage.id}"]`) : null;
			this.activeAgent = new Agent(this, this.activeSession, this.ai);
			await this.activeAgent.run(promptUserMessage, promptElement);
			this.activeAgent = null;
			return;
		}

		// Standard Chat mode:
		const fileBarContainer = this.panel.querySelector('.ai-filebar-container');
		const fileBarHeight = fileBarContainer ? fileBarContainer.offsetHeight : 0;
		const availableHeightForResponse = this.conversationArea.clientHeight - (fileBarHeight + 16);

		const modelMessageId = crypto.randomUUID();
		const responseBlock = this.historyManager.createStreamingBlock(modelMessageId, "model", this.activeSessionId);
		this._startGlow(this.activeSessionId);
		this.conversationArea.append(responseBlock);
		responseBlock.style.minHeight = `${Math.max(50, availableHeightForResponse)}px`;

		const userMessageElement = this.conversationArea.querySelector(`[data-message-id="${messageId}"]`);
		if (userMessageElement) {
			const PADDING_FROM_TOP = 8;
			this.conversationArea.scrollTop = userMessageElement.offsetTop - fileBarHeight - PADDING_FROM_TOP;
		}

		const callbacks = {
			onUpdate: (fullResponse) => {
				if (callbacks.toolCalls && callbacks.toolCalls.length > 0) {
					this._startGlow(this.activeSessionId);
				} else {
					this._stopGlow(this.activeSessionId);
				}
				const shouldScroll = this._shouldAutoScroll();
				responseBlock.updateContent(fullResponse);
				if (shouldScroll && this.conversationArea) {
					this.scrollToBottom(true);
				}
			},
			onDone: async (fullResponse) => {
				this._stopGlow(this.activeSessionId);
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
				this._stopGlow(this.activeSessionId);
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
		this.ai.chat(messagesForAI, callbacks, systemPrompt, this.activeSession); // Pass session so per-session thinkingLevel override applies.
	}

	async loadSettings() {
		const storedProvider = localStorage.getItem("aiProvider")
		const supportedProviders = ["gemini", "llamacpp", "ollama", "claude"];
		if (storedProvider && supportedProviders.includes(storedProvider)) {
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

		const storedDefaultAgentMode = localStorage.getItem("defaultAgentMode");
		if (storedDefaultAgentMode !== null) {
			this.config.defaultAgentMode = storedDefaultAgentMode === "true";
		} else {
			this.config.defaultAgentMode = false;
		}

		const storedDefaultPlanningMode = localStorage.getItem("defaultPlanningMode");
		if (storedDefaultPlanningMode !== null) {
			this.config.defaultPlanningMode = storedDefaultPlanningMode === "true";
		} else {
			this.config.defaultPlanningMode = true;
		}

		const storedAgentMode = localStorage.getItem("aiAgentMode");
		if (storedAgentMode !== null) {
			this.agentMode = storedAgentMode === "true";
		}

		const storedForgivenessMode = localStorage.getItem("aiForgivenessMode");
		if (storedForgivenessMode !== null) {
			this.config.defaultForgivenessMode = storedForgivenessMode === "true";
			this.forgivenessMode = storedForgivenessMode === "true";
		} else {
			this.config.defaultForgivenessMode = false;
			this.forgivenessMode = false;
		}

		const storedMaxSubAgents = localStorage.getItem("maxSubAgents");
		if (storedMaxSubAgents !== null) {
			this.config.maxSubAgents = parseInt(storedMaxSubAgents);
		}

		const storedDefaultAllowSubAgents = localStorage.getItem("defaultAllowSubAgents");
		if (storedDefaultAllowSubAgents !== null) {
			this.config.defaultAllowSubAgents = storedDefaultAllowSubAgents === "true";
		} else {
			this.config.defaultAllowSubAgents = true;
		}

		const storedDefaultAllowRunCommand = localStorage.getItem("defaultAllowRunCommand");
		if (storedDefaultAllowRunCommand !== null) {
			this.config.defaultAllowRunCommand = storedDefaultAllowRunCommand === "true";
		} else {
			this.config.defaultAllowRunCommand = true;
		}
	}
}

export default new AIManager()
