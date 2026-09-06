// ai-manager-sessions.mjs
// Handles AI session database interaction, switching, creation, and tab rendering.
import workspaceClient from "./workspace-client.mjs"
import AIConnections from "./ai-connections.mjs";
import { SessionMigrator, CURRENT_SESSION_VERSION } from "./sessions/session-migrator.mjs";

class AIManagerSessions {
	constructor(aiManager) {
		this.manager = aiManager;

		// Session state fields moved from AIManager
		this.allSessionMetadata = []; // Array of {id, name, createdAt, lastModified}
		this.activeSessionId = null; // ID of the currently active session
		this.activeSession = null; // The full active session object
		this.promptIndex = -1; // Index for prompt history (Ctrl+Up/Down)
		this._unsentPromptBuffer = null; // Stores unsubmitted prompt during history navigation

		// Cross-tab synchronization via BroadcastChannel
		this.instanceId = crypto.randomUUID();
		this.broadcastChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cadence_ai_sessions') : null;
		if (this.broadcastChannel) {
			this.broadcastChannel.onmessage = (e) => this._handleBroadcast(e.data);
		}
	}

	_broadcast(action, data = {}) {
		if (this.broadcastChannel) {
			try {
				this.broadcastChannel.postMessage({ action, senderId: this.instanceId, ...data, timestamp: Date.now() });
			} catch (err) {
				console.warn("[AIManagerSessions] Failed to post broadcast message:", err);
			}
		}
	}

	async _handleBroadcast(msg) {
		if (!msg || !msg.action || msg.senderId === this.instanceId) return;

		switch (msg.action) {
			case 'session_updated':
				if (msg.sessionId) {
					const meta = this.allSessionMetadata.find(s => s.id === msg.sessionId);
					if (meta) {
						if (msg.lastModified) meta.lastModified = msg.lastModified;
						if (msg.name) meta.name = msg.name;
					}
					// If this session is currently active and this tab is not actively processing, reload so it stays in sync
					if (this.activeSessionId === msg.sessionId && !this.manager._isProcessing) {
						try {
							const updatedSession = await workspaceClient.getSession(msg.sessionId);
							if (updatedSession) {
								const { session: migratedSession } = SessionMigrator.migrate(updatedSession);
								this.activeSession = migratedSession;
								this.manager.historyManager.loadSessionMessages(migratedSession.messages, false);
								this.manager._updateAIInfoDisplay();
							}
						} catch (e) {
							console.warn("[AIManagerSessions] Cross-tab sync fetch failed:", e);
						}
					}
				}
				break;

			case 'session_renamed':
				if (msg.sessionId && msg.name) {
					const meta = this.allSessionMetadata.find(s => s.id === msg.sessionId);
					if (meta) meta.name = msg.name;
					const tab = this.manager.sessionTabBar.tabs.find(t => t.config.id === msg.sessionId);
					if (tab) tab.name = msg.name;
					if (this.activeSessionId === msg.sessionId && this.activeSession) {
						this.activeSession.name = msg.name;
					}
				}
				break;

			case 'session_deleted':
				if (msg.sessionId) {
					this.allSessionMetadata = this.allSessionMetadata.filter(s => s.id !== msg.sessionId);
					const tab = this.manager.sessionTabBar.tabs.find(t => t.config.id === msg.sessionId);
					if (tab) this.manager.sessionTabBar.remove(tab);
					if (this.activeSessionId === msg.sessionId) {
						this.activeSession = null;
						this.activeSessionId = null;
						if (this.allSessionMetadata.length > 0) {
							const nextTab = this.manager.sessionTabBar.tabs.find(t => t.config.id === this.allSessionMetadata[0].id);
							if (nextTab) nextTab.click();
						}
					}
				}
				break;

			case 'session_created':
				if (msg.meta && !this.allSessionMetadata.some(s => s.id === msg.meta.id)) {
					this.allSessionMetadata.push(msg.meta);
					const tab = this.manager.sessionTabBar.add({ name: msg.meta.name, id: msg.meta.id, defaultStatusIcon: 'developer_board' });
					tab.on('dblclick', () => this.renameCurrentSession());
				}
				break;
		}
	}

	/**
	 * Manages initial session loading, populates the UI, and activates the correct session.
	 */
	async loadSessions(aiSessionsMetadata = [], activeSessionId = null) {
		this.allSessionMetadata = aiSessionsMetadata;

		// 1. Create the tab UI elements from the metadata.
		this._populateInitialTabs();

		let idToActivate = activeSessionId;

		// 2. Determine which session to activate.
		// If the intended active session doesn't exist in the metadata, fall back to the most recent (last modified).
		if (!this.allSessionMetadata.some(s => s.id === idToActivate)) {
			const sortedSessions = [...this.allSessionMetadata].sort((a, b) => b.lastModified - a.lastModified);
			idToActivate = sortedSessions.length > 0 ? sortedSessions[0].id : null;
		}

		// 3. Activate the chosen session or create a new one.
		if (idToActivate) {
			const tabToActivate = this.manager.sessionTabBar.tabs.find(t => t.config.id === idToActivate);
			if (tabToActivate) {
				// Clicking the tab programmatically triggers the switchSession cascade.
				tabToActivate.click();
			}
		} else {
			// If no sessions exist at all, create one.
			await this.createNewSession();
		}
	}

	/**
	 * Populates the TabBar with tabs from the metadata, preserving the order.
	 * This is only for the initial setup.
	 */
	_populateInitialTabs() {
		const tabBar = this.manager.sessionTabBar;
		if (!tabBar._tabs) return;

		// Only remove tabs that are session tabs. 
		// Sessions have IDs that start with 'ai-session-'.
		const sessionTabs = tabBar._tabs.filter(t => t.config && t.config.id && t.config.id.startsWith('ai-session-'));
		
		sessionTabs.forEach(tab => {
			tabBar.remove(tab);
		});

		// Add them back in the order of metadata
		this.allSessionMetadata.forEach(meta => {
			const tab = tabBar.add({ name: meta.name, id: meta.id, defaultStatusIcon: 'developer_board' });
			tab.on('dblclick', () => this.renameCurrentSession());
		});
	}

	/**
	 * Creates a new session, adds its tab to the UI, and activates it by simulating a click.
	 */
	async createNewSession() {
		const newId = `ai-session-${crypto.randomUUID()}`;
		const newName = `Chat ${this.allSessionMetadata.length + 1}`;
		
		const defaultAgent = (this.manager.config.defaultAgentMode !== undefined)
			? this.manager.config.defaultAgentMode
			: (localStorage.getItem("defaultAgentMode") === "true");

		const defaultPlanning = (this.manager.config.defaultPlanningMode !== undefined)
			? this.manager.config.defaultPlanningMode
			: (localStorage.getItem("defaultPlanningMode") !== "false");

		const defaultForgiveness = (this.manager.config.defaultForgivenessMode !== undefined)
			? this.manager.config.defaultForgivenessMode
			: (localStorage.getItem("aiForgivenessMode") === "true");

		const defaultSubAgents = (this.manager.config.defaultAllowSubAgents !== undefined)
			? this.manager.config.defaultAllowSubAgents
			: (localStorage.getItem("defaultAllowSubAgents") !== "false");

		const defaultRunCommand = (this.manager.config.defaultAllowRunCommand !== undefined)
			? this.manager.config.defaultAllowRunCommand
			: (localStorage.getItem("defaultAllowRunCommand") !== "false");

		let defaultConnectionId = this.activeSession?.connectionId || this.manager?.aiInfoDisplay?.value || localStorage.getItem("cadence_default_connection_id") || AIConnections.defaultConnectionId || "default-gemini";

		const now = Date.now();
		const newSessionData = {
			id: newId, name: newName, createdAt: now, lastModified: now,
			version: CURRENT_SESSION_VERSION,
			messages: [], promptInput: "", promptHistory: [], scrollTop: 0,
			evergreenFiles: [], modifiedFiles: {}, pendingEdits: {},
			lastMilestoneTimestamp: now,
			checkpoints: [{ name: "session_start", timestamp: now }],
			currentCycleStartTimestamp: now,
			agentMode: defaultAgent,
			planningMode: defaultPlanning,
			forgivenessMode: defaultForgiveness,
			connectionId: defaultConnectionId,
			thinkingLevel: "auto",
			allowSubAgents: defaultSubAgents,
			allowRunCommand: defaultRunCommand,
			pinnedSkills: [],
			pinnedRoots: [],
		};

		await workspaceClient.setSession(newId, newSessionData);
		const newMeta = { id: newId, name: newName, createdAt: newSessionData.createdAt, lastModified: newSessionData.lastModified };
		this.allSessionMetadata.push(newMeta);
		this._broadcast('session_created', { meta: newMeta });

		// Add the tab to the UI.
		const newTab = this.manager.sessionTabBar.add({ name: newName, id: newId, defaultStatusIcon: 'developer_board' });
		newTab.on('dblclick', () => this.renameCurrentSession());

		// Activate it using the component's own mechanism.
		newTab.click();
	}

	async proceedWithImplementationPlan(comment = "", isAccepted = true) {
		if (!this.activeSession) return;
		const sourceSession = this.activeSession;
		const plan = sourceSession.implementationPlan || "";

		if (!plan) {
			window.modal.notice("No active implementation plan found in this session.", "Cannot Proceed");
			return;
		}

		// Find the model message that contains this plan and tag it
		const planMessage = [...sourceSession.messages].reverse().find(m => {
			if (m.type !== "model" && m.role !== "model") return false;
			if (m.planStatus && m.planStatus !== "pending") return false;
			const hasStructuredPlanCall = Array.isArray(m.toolCalls) && m.toolCalls.some(tc => {
				const callObj = tc.functionCall || tc;
				return (callObj.name || tc.name) === "create_implementation_plan";
			});
			const hasLegacyPlanContent = m.content && m.content.includes("create_implementation_plan");
			return hasStructuredPlanCall || hasLegacyPlanContent;
		});
		if (planMessage) {
			planMessage.planStatus = isAccepted ? "accepted" : "rejected";
		}

		let promptText = "";
		if (isAccepted) {
			promptText = "[system] Implementation plan accepted. Execute the checklist step-by-step.";
			if (comment) promptText += `\n\nAdditional Instructions:\n${comment}`;

			// Disable planning mode so the model can actually implement its plan
			this.manager.planningMode = false;
			localStorage.setItem("aiPlanningMode", "false");
			sourceSession.planningMode = false;
			this.manager._updatePromptAreaPlaceholder();
			this.manager._updateAgentProgressPanel();
		} else {
			if (comment) {
				promptText = `[system] The proposed implementation plan has been rejected. Review the feedback and formulate a new plan.\n\nFeedback:\n${comment}`;
			} else {
				promptText = "[system] The proposed implementation plan has been rejected. Await further instruction from the user.";
			}
		}

		await workspaceClient.setSession(sourceSession.id, sourceSession);

		// Set the prompt in the editor
		this.manager.promptEditor.setValue(promptText, -1);
		
		// Immediately update the latest plan card UI in the DOM (no wait for redraw)
		const cards = this.manager.conversationArea.querySelectorAll('.inline-implementation-plan-card, .ai-implementation-plan-banner');
		if (cards.length > 0) {
			const latestCard = cards[cards.length - 1];
			
			// Dynamic colors based on decision
			if (isAccepted) {
				latestCard.style.background = "rgba(45, 164, 78, 0.1)";
				latestCard.style.borderColor = "rgba(45, 164, 78, 0.25)";
				const left = latestCard.querySelector('.banner-left');
				if (left) {
					left.style.color = "#2da44e";
					const icon = left.querySelector('ui-icon');
					if (icon) {
						icon.innerText = "check_circle";
						icon.style.color = "#2da44e";
					}
					const title = left.querySelector('span');
					if (title) title.innerText = "Implementation Plan Accepted";
				}
				const btn = latestCard.querySelector('.open-plan-btn');
				if (btn) {
					btn.style.color = "#2da44e";
					btn.style.borderColor = "#2da44e";
				}
			} else {
				latestCard.style.background = "rgba(244, 67, 54, 0.08)";
				latestCard.style.borderColor = "rgba(244, 67, 54, 0.25)";
				const left = latestCard.querySelector('.banner-left');
				if (left) {
					left.style.color = "var(--error-color, #f44336)";
					const icon = left.querySelector('ui-icon');
					if (icon) {
						icon.innerText = "cancel";
						icon.style.color = "var(--error-color, #f44336)";
					}
					const title = left.querySelector('span');
					if (title) title.innerText = "Implementation Plan Refined / Rejected";
				}
				const btn = latestCard.querySelector('.open-plan-btn');
				if (btn) {
					btn.style.color = "var(--error-color, #f44336)";
					btn.style.borderColor = "var(--error-color, #f44336)";
				}
			}

			// Hide controls immediately to prevent double clicks and clutter
			const actions = latestCard.querySelector('.banner-actions');
			if (actions) actions.style.display = 'none';
			const input = latestCard.querySelector('textarea');
			if (input) input.style.display = 'none';
		}

		// Automatically compact the preceding planning cycle on plan acceptance
		if (isAccepted) {
			await this.manager.historyManager.autoCompactAgentCycle(sourceSession);
		}

		// Submit the prompt immediately in the same session
		this.manager.generate();
	}

	/**
	 * Switches session DATA. The UI state is already handled by the TabBar component.
	 */
	async switchSession(sessionId) {
		// If we are already on this session, do nothing.
		if (this.activeSessionId === sessionId && this.activeSession) return;

		// Clear any currently active halt bar
		if (this.manager.haltBar) {
			this.manager.haltBar.remove();
			this.manager.haltBar = null;
		}

		// Save the state of the *current* active session (if any)
		if (this.activeSession && this.activeSession.id) {
			this.activeSession.promptInput = this.manager.promptEditor.getValue();
			this.activeSession.scrollTop = this.manager.conversationArea.scrollTop; // Save current scroll position
			this.activeSession.agentMode = this.manager.agentMode;
			this.activeSession.planningMode = this.manager.planningMode;
			this.activeSession.forgivenessMode = this.manager.forgivenessMode;
			if (this.manager.aiInfoDisplay && this.manager.aiInfoDisplay.value) {
				this.activeSession.connectionId = this.manager.aiInfoDisplay.value;
			}
			const currentSessionMeta = this.allSessionMetadata.find(s => s.id === this.activeSession.id);
			if (currentSessionMeta) currentSessionMeta.lastModified = Date.now();
			await workspaceClient.setSession(this.activeSession.id, this.activeSession);
			this._broadcast('session_updated', {
				sessionId: this.activeSession.id,
				lastModified: this.activeSession.lastModified,
				name: this.activeSession.name,
				connectionId: this.activeSession.connectionId
			});
		}

		// Load the new session's data: reuse running session object if it exists to maintain reference identity
		const running = this.manager.runningSessions.get(sessionId);
		let newSessionData = (running && running.instance && running.instance.session)
			? running.instance.session
			: await workspaceClient.getSession(sessionId);
		if (!newSessionData) {
			// This is a recovery case. The tab exists but data is gone.
			console.error(`Data for session ID ${sessionId} not found!`);
			const staleTab = this.manager.sessionTabBar.tabs.find(t => t.config.id === sessionId);
			if (staleTab) this.deleteSession(sessionId, staleTab); // Trigger a proper delete.
			return; // Abort this switch.
		}

		// JIT Migration: Upgrade legacy sessions to latest structured JSON schema
		const { session: migratedSession, modified } = SessionMigrator.migrate(newSessionData);
		newSessionData = migratedSession;
		if (modified) {
			workspaceClient.setSession(sessionId, newSessionData).catch(err => {
				console.warn("[AIManagerSessions] Failed to persist migrated session:", err);
			});
		}

		// Self-healing: Automatically scan and re-link any disconnected sub-agents for this session
		await this.repairDisconnectedSubAgents(newSessionData);

		// Update manager's state
		if (!newSessionData.connectionId) {
			newSessionData.connectionId = localStorage.getItem("cadence_default_connection_id") || AIConnections.defaultConnectionId || "default-gemini";
		}
		this.activeSession = newSessionData;
		this.activeSessionId = sessionId;
		this.manager.agentMode = newSessionData.agentMode ?? (this.manager.config.defaultAgentMode ?? false);
		this.manager.planningMode = newSessionData.planningMode ?? (this.manager.config.defaultPlanningMode ?? true);
		this.manager.forgivenessMode = newSessionData.forgivenessMode ?? (this.manager.config.defaultForgivenessMode ?? false);
		this.manager.allowRunCommand = newSessionData.allowRunCommand ?? (this.manager.config.defaultAllowRunCommand ?? true);
		this._unsentPromptBuffer = null; // Clear any pending unsent prompt from the previous session

		// Update the rest of the UI based on the new data
		this.manager.historyManager.loadSessionMessages(this.activeSession.messages, false);

		this.manager.promptEditor.setValue(this.activeSession.promptInput || "", -1);
		this.promptIndex = (this.activeSession.promptHistory?.length || 0);
		this.manager._resizePromptArea();
		this.manager._setButtonsDisabledState(this.manager._isProcessing);
		this.manager._updateGlowForViewedSession();
		this.manager._updateAIInfoDisplay();
		this.manager._updatePromptAreaPlaceholder(); // Update placeholder after session switch
		this.manager._updateAgentProgressPanel();
		// Force redraw the Plan/Tasks view to align checkboxes
		if (window.ui?.renderPlanTasksView) {
			const containers = document.querySelectorAll(".plan-tasks-view");
			containers.forEach(c => window.ui.renderPlanTasksView(c));
		}

		// Trigger notice bar updates on active editor tabs when active AI session changes
		if (window.ui) {
			const leftActive = window.ui.leftTabs?.activeTab;
			if (leftActive && window.ui.leftHolder?.updateNoticeBar) {
				window.ui.leftHolder.updateNoticeBar(leftActive);
			}
			const rightActive = window.ui.rightTabs?.activeTab;
			if (rightActive && window.ui.rightHolder?.updateNoticeBar) {
				window.ui.rightHolder.updateNoticeBar(rightActive);
			}
		}

		this.manager._dispatchContextUpdate("session_switched");
		this.manager.promptEditor.focus(); // Ensure focus returns to the prompt editor after a switch
	}

	async repairDisconnectedSubAgents(session) {
		if (!session || !session.messages) return;

		try {
			const allSessions = await workspaceClient.getSessions();
			const subSessions = allSessions.filter(s => s && s.parentId === session.id);
			if (subSessions.length === 0) return;

			const linkedSubAgentIds = new Set();
			for (const msg of session.messages) {
				if (msg.type === "user" && msg.content && msg.content.startsWith("[sub-agent:")) {
					const match = msg.content.match(/^\[sub-agent:(ai-session-[a-f0-9-]+)\]$/);
					if (match) {
						linkedSubAgentIds.add(match[1]);
					}
				}
			}

			let modified = false;
			for (const subSession of subSessions) {
				if (!linkedSubAgentIds.has(subSession.id)) {
					console.log(`[Self-Healing] Found disconnected sub-agent: ${subSession.id}. Re-linking to parent session.`);

					// Find the model message that contains the tool call to create this sub-agent
					let insertIndex = -1;
					for (let i = session.messages.length - 1; i >= 0; i--) {
						const msg = session.messages[i];
						if (msg.role === "model" && msg.toolCalls) {
							const hasCreateCall = msg.toolCalls.some(tc => {
								const name = tc.name || tc.functionCall?.name;
								return name === "create_sub_agent";
							});
							if (hasCreateCall) {
								insertIndex = i + 1;
								break;
							}
						}
					}

					const triggerMessage = {
						role: "user",
						type: "user",
						content: `[sub-agent:${subSession.id}]`,
						timestamp: subSession.createdAt || Date.now(),
						id: crypto.randomUUID()
					};

					if (insertIndex !== -1 && insertIndex <= session.messages.length) {
						session.messages.splice(insertIndex, 0, triggerMessage);
					} else {
						session.messages.push(triggerMessage);
					}
					modified = true;
				}
			}

			if (modified) {
				session.lastModified = Date.now();
				await workspaceClient.setSession(session.id, session);
			}
		} catch (err) {
			console.error("[Self-Healing] Failed to repair disconnected sub-agents:", err);
		}
	}

	async _deleteSessionDataWithCascade(sessionId) {
		try {
			const allSessions = await workspaceClient.getSessions();
			for (const sub of allSessions) {
				if (sub.parentId === sessionId) {
					await workspaceClient.deleteSession(sub.id);
				}
			}
		} catch (e) {
			console.error("Failed to cascade delete sub-agent sessions:", e);
		}
		await workspaceClient.deleteSession(sessionId);
	}

	async closeSessionTab(sessionId, tab) {
		const fullSessionData = await workspaceClient.getSession(sessionId);
		const hasModelResponse = fullSessionData?.messages?.some(m => m.role === 'model');

		if (!hasModelResponse) {
			await this._deleteSessionDataWithCascade(sessionId);
			this._broadcast('session_deleted', { sessionId });
			window.modal.toast("Empty session deleted.");
		} else {
			window.modal.toast("Chat session archived to history.");
		}

		this.allSessionMetadata = this.allSessionMetadata.filter(s => s.id !== sessionId);

		if (!hasModelResponse && this.activeSessionId === sessionId) {
			// Clear it so switchSession doesn't resurrect the empty session
			this.activeSession = null;
			this.activeSessionId = null;
		}

		if (this.allSessionMetadata.length === 0) {
			this.activeSession = null;
			this.activeSessionId = null;
			this.manager.historyManager.clear(true);
		}

		this.manager.sessionTabBar.remove(tab);
		this.manager._dispatchContextUpdate(hasModelResponse ? "session_closed" : "session_deleted", { closedSessionId: sessionId });
	}

	async deleteSession(sessionId, tab, sessionName = null) {
		const sessionMeta = this.allSessionMetadata.find(s => s.id === sessionId);
		const name = sessionMeta ? sessionMeta.name : (sessionName || "this session");
		
		const confirmed = await window.modal.confirm(`Are you sure you want to permanently delete the chat "<strong>${name}</strong>"? This action cannot be undone.`, "Delete Chat Session");
		if (!confirmed) {
			return false;
		}

		// Delete data
		await this._deleteSessionDataWithCascade(sessionId);
		this._broadcast('session_deleted', { sessionId });
		window.modal.toast("Chat session permanently deleted.");
		
		if (sessionMeta) {
			this.allSessionMetadata = this.allSessionMetadata.filter(s => s.id !== sessionId);

			if (this.activeSessionId === sessionId) {
				// Clear it so switchSession doesn't resurrect the deleted session
				this.activeSession = null;
				this.activeSessionId = null;
			}

			if (this.allSessionMetadata.length === 0) {
				this.activeSession = null;
				this.activeSessionId = null;
				this.manager.historyManager.clear(true);
			}

			if (tab) this.manager.sessionTabBar.remove(tab);
			this.manager._dispatchContextUpdate("session_deleted");
		}
		
		return true;
	}

	/**
	 * Shows the chat history modal.
	 */
	async showHistoryModal() {
		const allSessions = await workspaceClient.getSessions();
		
		allSessions.sort((a, b) => b.lastModified - a.lastModified);
		
		const activeIds = new Set(this.allSessionMetadata.map(s => s.id));
		const allSessionIds = new Set(allSessions.map(s => s.id));
		const historySessions = allSessions.filter(s => {
			if (activeIds.has(s.id)) return false;
			// Suppress sub-agent sessions if their parent still exists in the database
			if (s.parentId && allSessionIds.has(s.parentId)) {
				return false;
			}
			return true;
		});

		let isMultiSelectMode = false;
		let selectedSessions = new Set();

		const contentContainer = document.createElement('div');
		contentContainer.innerHTML = `
			<div class="history-header-row">
				<div class="history-header-titles">
					<h1>Chat History</h1>
					<p>Select a previous chat to reopen it.</p>
				</div>
				<div class="history-db-stats-badge" id="history_db_stats" title="Embedded session database size on disk">
					<ui-icon>storage</ui-icon>
					<span>DB: <span class="db-stat-highlight db-size-val">--</span></span>
					<span class="db-free-info" style="display:none; opacity: 0.7;">(<span class="db-free-val">--</span> free)</span>
				</div>
			</div>
		`;

		const updateHistoryDBStats = async () => {
			try {
				const stats = await workspaceClient.getDBStats();
				const badge = contentContainer.querySelector('#history_db_stats');
				if (badge && stats) {
					const sizeEl = badge.querySelector('.db-size-val');
					if (sizeEl) sizeEl.textContent = stats.sizeFormatted || "--";
					const freeInfo = badge.querySelector('.db-free-info');
					const freeEl = badge.querySelector('.db-free-val');
					if (stats.freePageBytes > 0 && freeInfo && freeEl) {
						freeEl.textContent = stats.freePageFormatted;
						freeInfo.style.display = 'inline';
					}
					badge.title = `Database: ${stats.path}\nSize: ${stats.sizeFormatted} (${stats.sizeBytes.toLocaleString()} bytes)\nAvailable for reuse: ${stats.freePageFormatted} in freelist\nSessions: ${stats.sessionCount}`;
				}
			} catch (e) {
				// Silently ignore if DB stats endpoint is unavailable
			}
		};
		updateHistoryDBStats();
		
		const listContainer = document.createElement('div');
		listContainer.style.height = '400px';
		listContainer.style.overflow = 'auto';
		listContainer.style.border = '1px solid var(--border-color)';
		listContainer.style.borderRadius = 'var(--radius)';
		listContainer.style.marginTop = '10px';
		listContainer.style.padding = '10px';
		listContainer.style.userSelect = 'none'; // Prevent text selection on long press
		
		const renderList = () => {
			listContainer.innerHTML = '';
			if (historySessions.length === 0) {
				listContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center; margin-top: 20px;">No chat history available.</p>';
				return;
			}
			historySessions.forEach(session => {
				const item = document.createElement('div');
				item.style.display = 'flex';
				item.style.justifyContent = 'space-between';
				item.style.alignItems = 'center';
				item.style.padding = '8px';
				item.style.borderBottom = '1px solid var(--border-color)';
				item.style.transition = 'background-color 0.2s';
				item.style.minHeight = '40px'; // Maintain height even if contents shift
				
				item.onmouseenter = () => item.style.backgroundColor = 'color-mix(in srgb, var(--theme, #303f9f) 25%, transparent)';
				item.onmouseleave = () => item.style.backgroundColor = 'transparent';
				
				let pressTimer;
				let longPressed = false;
				item.onpointerdown = (e) => {
					if (e.button !== 0 && e.pointerType === 'mouse') return;
					longPressed = false;
					pressTimer = setTimeout(() => {
						if (!isMultiSelectMode) {
							longPressed = true;
							isMultiSelectMode = true;
							selectedSessions.add(session.id);
							renderList();
							renderActionBar();
						}
					}, 500);
				};
				item.onpointerup = () => clearTimeout(pressTimer);
				item.onpointerleave = () => clearTimeout(pressTimer);
				item.onpointercancel = () => clearTimeout(pressTimer);

				let checkbox;
				if (isMultiSelectMode) {
					checkbox = document.createElement('input');
					checkbox.type = 'checkbox';
					checkbox.style.marginRight = '10px';
					checkbox.checked = selectedSessions.has(session.id);
					checkbox.style.pointerEvents = 'none'; // Let the item click handle the toggle
					item.append(checkbox);
				}
				
				const nameSpan = document.createElement('span');
				const shortDate = new Date(session.lastModified).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
				nameSpan.textContent = `${shortDate}: ${session.name}`;
				nameSpan.style.flex = '1';
				nameSpan.style.cursor = 'pointer';
				item.onclick = (e) => {
					if (longPressed) {
						longPressed = false;
						return; // ignore the click that follows a long press
					}
					if (isMultiSelectMode) {
						if (selectedSessions.has(session.id)) {
							selectedSessions.delete(session.id);
						} else {
							selectedSessions.add(session.id);
						}
						if (checkbox) checkbox.checked = selectedSessions.has(session.id);
					} else {
						window.modal.hide();
						this.reopenSession(session);
					}
				};
				
				item.append(nameSpan);

				const copyBtn = document.createElement('button');
				copyBtn.innerHTML = '<ui-icon>content_copy</ui-icon>';
				copyBtn.className = 'icon-button';
				copyBtn.style.background = 'transparent';
				copyBtn.style.color = 'var(--text-secondary)';
				copyBtn.style.border = 'none';
				copyBtn.style.marginRight = '8px';
				copyBtn.style.visibility = isMultiSelectMode ? 'hidden' : 'visible';
				copyBtn.title = "Duplicate Chat";
				copyBtn.onclick = async (e) => {
					e.stopPropagation();
					if (isMultiSelectMode) return;
					window.modal.hide();
					await this.copySession(session.id, true);
				};
				item.append(copyBtn);

				const delBtn = document.createElement('button');
				delBtn.innerHTML = '<ui-icon>delete</ui-icon>';
				delBtn.className = 'icon-button'; // Removed 'theme-button' to remove the border
				delBtn.style.background = 'transparent';
				delBtn.style.color = 'var(--text-secondary)';
				delBtn.style.border = 'none';
				delBtn.style.visibility = isMultiSelectMode ? 'hidden' : 'visible'; // Maintain layout width/height
				delBtn.onclick = async (e) => {
					e.stopPropagation(); // prevent item.onclick
					if (isMultiSelectMode) return;
					const deleted = await this.deleteSession(session.id, null, session.name);
					if (deleted) {
						const idx = historySessions.indexOf(session);
						if (idx > -1) historySessions.splice(idx, 1);
						renderList();
						updateHistoryDBStats();
					}
				};
				item.append(delBtn);

				
				listContainer.append(item);
			});
		};
		renderList();
		
		contentContainer.append(listContainer);

		window.modal.inner.innerHTML = '';
		window.modal.inner.append(contentContainer);

		const renderActionBar = () => {
			window.modal.actionBar.innerHTML = '';
			
			if (isMultiSelectMode) {
				const deleteBtn = document.createElement('ui-button');
				deleteBtn.textContent = 'Delete Selected';
				deleteBtn.classList.add('danger'); // We'll add custom style below to ensure visibility
				deleteBtn.style.backgroundColor = 'var(--error-color, #d32f2f)';
				deleteBtn.style.color = 'white';
				deleteBtn.onclick = async () => {
					if (selectedSessions.size === 0) {
						isMultiSelectMode = false;
						renderList();
						renderActionBar();
						return;
					}

					const confirmed = await window.modal.confirm(`Are you sure you want to permanently delete these ${selectedSessions.size} items? This action cannot be undone.`, "Batch Delete Sessions");
					if (confirmed) {
						const deletedCount = selectedSessions.size;
						for (const id of selectedSessions) {
							await this._deleteSessionDataWithCascade(id);
							const idx = historySessions.findIndex(s => s.id === id);
							if (idx > -1) historySessions.splice(idx, 1);
						}
						window.modal.toast(`${deletedCount} chat sessions permanently deleted.`);
						selectedSessions.clear();
						isMultiSelectMode = false;
						renderList();
						renderActionBar();
						updateHistoryDBStats();
					}
				};

				const cancelBtn = document.createElement('ui-button');
				cancelBtn.textContent = 'Cancel';
				cancelBtn.classList.add('cancel');
				cancelBtn.onclick = () => {
					isMultiSelectMode = false;
					selectedSessions.clear();
					renderList();
					renderActionBar();
				};
				window.modal.actionBar.append(cancelBtn, deleteBtn);
			} else {
				const closeButton = document.createElement('ui-button');
				closeButton.textContent = 'Close';
				closeButton.classList.add('cancel');
				closeButton.onclick = () => window.modal.hide();
				window.modal.actionBar.append(closeButton);
			}
		};
		renderActionBar();
		
		window.modal.show();
	}

	async reopenSession(sessionMeta) {
		this.allSessionMetadata.push({
			id: sessionMeta.id,
			name: sessionMeta.name,
			createdAt: sessionMeta.createdAt,
			lastModified: sessionMeta.lastModified
		});
		
		const tab = this.manager.sessionTabBar.add({ name: sessionMeta.name, id: sessionMeta.id, defaultStatusIcon: 'developer_board' });
		tab.on('dblclick', () => this.renameCurrentSession());
		tab.click();
	}

	async copySession(sessionId, makeActive = true) {
		const sourceSession = await workspaceClient.getSession(sessionId);
		if (!sourceSession) {
			window.modal.notice("Source session not found.", "Error Copying Session");
			return;
		}

		const newId = `ai-session-${crypto.randomUUID()}`;
		const newName = `${sourceSession.name} - copy`;

		// Deep clone session data
		const newSessionData = JSON.parse(JSON.stringify(sourceSession));
		newSessionData.id = newId;
		newSessionData.name = newName;
		newSessionData.createdAt = Date.now();
		newSessionData.lastModified = Date.now();

		await workspaceClient.setSession(newId, newSessionData);

		this.allSessionMetadata.push({
			id: newId,
			name: newName,
			createdAt: newSessionData.createdAt,
			lastModified: newSessionData.lastModified
		});

		if (makeActive) {
			const newTab = this.manager.sessionTabBar.add({ name: newName, id: newId, defaultStatusIcon: 'developer_board' });
			newTab.on('dblclick', () => this.renameCurrentSession());
			newTab.click();
			window.modal.toast(`Chat duplicated as "${newName}"`);
		} else {
			window.modal.toast(`Chat duplicated as "${newName}"`);
		}
	}

	/**
	 * Automatically renames the session based on the first prompt.
	 */
	async autoRenameSession(firstPromptContent) {
		// Yield immediately to let the initial prompt generation and UI rendering proceed async
		await new Promise(resolve => setTimeout(resolve, 500));

		const sizeRank = {
			tiny: 1,
			small: 2,
			medium: 3,
			large: 4,
			ultra: 5
		};
		const connections = AIConnections.getConnections();
		let smallestConn = null;
		let smallestRank = Infinity;
		
		for (const conn of connections) {
			const inst = AIConnections.getInstance(conn.id);
			if (inst && inst.isConfigured()) {
				const size = conn.size || "medium";
				const rank = sizeRank[size] || 3;
				if (rank < smallestRank) {
					smallestRank = rank;
					smallestConn = inst;
				}
			}
		}

		const aiInstance = smallestConn || this.manager.ai;
		if (!aiInstance || !aiInstance.isConfigured()) return;
		try {
			const prompt = `Based on this initial prompt, generate a very short title (max 5 words) summarizing the topic. Do not use quotes or any prefix. Prompt: "${firstPromptContent}"`;
			
			let fullResponse = "";
			await new Promise((resolve, reject) => {
				aiInstance.generate(prompt, {
					onUpdate: () => {},
					onDone: (res) => { fullResponse = res; resolve(); },
					onError: (err) => { reject(err); }
				});
			});
			
			if (fullResponse) {
				let cleanResponse = fullResponse.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
				cleanResponse = cleanResponse.replace(/<think>[\s\S]*?<\/think>/gi, '');
				cleanResponse = cleanResponse.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '');
				
				const newName = cleanResponse.replace(/["']/g, '').trim();
				
				this.activeSession.name = newName;
				const meta = this.allSessionMetadata.find(s => s.id === this.activeSession.id);
				if (meta) {
					meta.name = newName;
					meta.lastModified = Date.now();
				}
				await workspaceClient.setSession(this.activeSession.id, this.activeSession);

				const tabToRename = this.manager.sessionTabBar.tabs.find(t => t.config.id === this.activeSessionId);
				if (tabToRename) {
					tabToRename.name = newName; 
				}

				this.manager._dispatchContextUpdate("session_renamed");
				this._broadcast('session_renamed', { sessionId: this.activeSession.id, name: newName });
			}
		} catch (e) {
			console.error("Auto rename failed:", e);
		}
	}

	/**
	 * Renames the current session and updates the specific tab's text via its property.
	 */
	async renameCurrentSession() {
		if (!this.activeSession) return;
		const newName = await window.modal.prompt("Enter new chat name:", "Rename Chat", this.activeSession.name);

		if (newName && newName.trim() !== "") {
			const trimmedName = newName.trim();

			// Update data
			this.activeSession.name = trimmedName;
			const meta = this.allSessionMetadata.find(s => s.id === this.activeSession.id);
			if (meta) {
				meta.name = trimmedName;
				meta.lastModified = Date.now();
			}
			await workspaceClient.setSession(this.activeSession.id, this.activeSession);

			// Update the UI via the component's API
			const tabToRename = this.manager.sessionTabBar.tabs.find(t => t.config.id === this.activeSessionId);
			if (tabToRename) {
				tabToRename.name = trimmedName; // This uses the TabItem's setter
			}

			this.manager._dispatchContextUpdate("session_renamed");
			this._broadcast('session_renamed', { sessionId: this.activeSession.id, name: trimmedName });
		}
	}
}

export default AIManagerSessions;
