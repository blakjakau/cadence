import { Block } from './element.mjs';
import { Button } from './button.mjs';
import conduitClient from '../conduit-client.mjs';
import workspaceClient from '../workspace-client.mjs';
import { openCommandPolicyReviewModal } from '../util/command-policy-review.mjs';
import { promptAddFolder } from './file-dialogs.mjs';
import { UIAccordion } from './accordion.mjs';

export class SessionArtifactsPanel extends Block {
    constructor() {
        super();
        this.classList.add("plan-tasks-view");
        this.isUpdating = false;
        this.sourceSession = null;

        // Active Ace Editor instances
        this.planEditorInstance = null;
        this.tasksEditorInstance = null;
        this.scratchpadEditorInstance = null;

        // Build the outer scroll container programmatically
        this.container = document.createElement("div");
        this.container.className = "artifacts-accordion-container";
        this.appendChild(this.container);

        // 1. Session Settings Accordion
        this._buildSettingsAccordion();

        // 2. Workspaces Accordion
        this._buildWorkspacesAccordion();

        // 3. Edit History & Rollbacks Accordion
        this._buildBackupsAccordion();

        // 4. Scratchpad Accordion
        this._buildScratchpadAccordion();

        // 5. Task Checklist Accordion
        this._buildTasksAccordion();

        // 6. Implementation Plan Accordion
        this._buildPlanAccordion();

        // Point every accordion's expand/collapse state at the source (not active) session.
        const accTarget = () => this._getTargetSession();
        this.settingsAccordion.getTargetSession = accTarget;
        this.backupsAccordion.getTargetSession = accTarget;
        this.scratchpadAccordion.getTargetSession = accTarget;
        this.tasksAccordion.getTargetSession = accTarget;
        this.planAccordion.getTargetSession = accTarget;
        this.workspacesAccordion.getTargetSession = accTarget;
    }

    // Returns the session this panel is currently targeting (the source session of the
    // most recent update), falling back to the active session when none is set.
    _getTargetSession() {
        return this.sourceSession || ui.aiManager.activeSession;
    }

    _buildSettingsAccordion() {
        this.settingsAccordion = new UIAccordion("settings", "Session Settings", "settings", "var(--theme)");
        this.settingsContent = this.settingsAccordion.content;
        this.settingsItem = this.settingsAccordion;
        this.settingsArrow = this.settingsAccordion.arrow;

        this.settingsContent.className = "accordion-content settings-content-wrapper";

        const grid = document.createElement("div");
        grid.className = "settings-grid";
        this.settingsContent.appendChild(grid);

        // Helper to construct a single toggle row programmatically
        const createToggleRow = (id, title, desc, wrapperClass) => {
            const wrapper = document.createElement("div");
            wrapper.className = `toggle-row ${wrapperClass}`;

            const label = document.createElement("label");
            label.className = "switch";
            label.title = `${title}: ${desc}`;

            const input = document.createElement("input");
            input.type = "checkbox";
            input.id = id;

            const slider = document.createElement("span");
            slider.className = "slider round";

            label.appendChild(input);
            label.appendChild(slider);

            const meta = document.createElement("div");
            meta.className = "setting-meta";

            const titleSpan = document.createElement("span");
            titleSpan.className = "toggle-label";
            titleSpan.textContent = title;
            titleSpan.onclick = () => input.click();

            const descSpan = document.createElement("span");
            descSpan.className = "setting-desc";
            descSpan.textContent = desc;

            meta.appendChild(titleSpan);
            meta.appendChild(descSpan);

            wrapper.appendChild(label);
            wrapper.appendChild(meta);
            grid.appendChild(wrapper);

            return input;
        };

        this.agentModeCheckbox = createToggleRow("accordion-agent-mode", "Agent Mode", "Allow Cadence to automatically read, write, and manage workspace files.", "agent-toggle-wrapper");
        this.planningModeCheckbox = createToggleRow("accordion-planning-mode", "Planning Mode", "Focus Cadence on generating structured implementation plans before applying edits.", "planning-toggle-wrapper");
        this.forgivenessModeCheckbox = createToggleRow("accordion-forgiveness-mode", "Forgiveness Mode", "Commit edits immediately to disk with robust single-click rollback safety.", "agent-toggle-wrapper");
        this.openEditsForReviewCheckbox = createToggleRow("accordion-open-edits-for-review", "Open Edits for Review", "Open files in editor for diff review (optional in Forgiveness Mode).", "agent-toggle-wrapper");
        this.allowSubAgentsCheckbox = createToggleRow("accordion-allow-sub-agents", "Allow Sub-Agents", "Allow Cadence to spawn sub-agents to solve smaller tasks.", "sub-agents-toggle-wrapper");
        this.allowRunCommandCheckbox = createToggleRow("accordion-allow-run-command", "Allow Terminal Commands", "Allow Cadence to execute terminal shell commands via the run_command tool.", "run-command-toggle-wrapper");
        {
            const runCommandWrapper = this.allowRunCommandCheckbox.closest(".toggle-row");
            const cog = new Button();
            cog.className = "setting-cog-btn";
            cog.icon = "settings";
            cog.title = "Review command policies (this session)";
            cog.onclick = async (e) => {
                e.stopPropagation();
                const mgr = window.ui?.aiManager;
                const session = mgr?.activeSession;
                if (!session) return;
                // Ensure the session has a normalized commandPolicy in memory.
                const p = session.commandPolicy || {};
                const allow = Array.isArray(p.allow) ? p.allow : (Array.isArray(p.whitelist) ? p.whitelist : []);
                const block = Array.isArray(p.block) ? p.block : (Array.isArray(p.blacklist) ? p.blacklist : []);
                session.commandPolicy = { allow, block };
                openCommandPolicyReviewModal({
                    title: "Command Policies",
                    scope: "session",
                    getPolicy: () => session.commandPolicy,
                    onPersist: async () => {
                        try {
                            await workspaceClient.setSession(session.id, session);
                        } catch (err) {
                            console.error("Failed to persist session command policy", err);
                        }
                    },
                    getGlobalPolicy: () => {
                        const m = window.ui?.aiManager;
                        if (m?.config?.commandPolicy) return m.config.commandPolicy;
                        m.config.commandPolicy = { allow: [], block: [] };
                        return m.config.commandPolicy;
                    },
                    onPersistGlobal: () => {
                        const m = window.ui?.aiManager;
                        if (m?.saveCommandPolicy) m.saveCommandPolicy(m.config.commandPolicy);
                    }
                });
            };
            runCommandWrapper.classList.add("has-cog");
            runCommandWrapper.appendChild(cog);
        }
        this.autoMilestonesCheckbox = createToggleRow("accordion-auto-milestones", "Auto-Milestones on 'done'", "Automatically freeze a checkpoint milestone when the agent finishes a cycle.", "auto-milestones-toggle-wrapper");
        this.autoRollbackCheckbox = createToggleRow("accordion-auto-rollback", "Auto-Rollback on Edit Failures", "Automatically rollback a file if consecutive edit attempts fail.", "auto-rollback-toggle-wrapper");

        // Helper to construct a number input row
        const createNumberRow = (id, title, desc, defaultVal, min = 10, max = 95) => {
            const wrapper = document.createElement("div");
            wrapper.className = "toggle-row number-input-row";

            const input = document.createElement("input");
            input.type = "number";
            input.id = id;
            input.min = min;
            input.max = max;
            input.value = defaultVal;
            input.className = "setting-number-input";

            const meta = document.createElement("div");
            meta.className = "setting-meta";

            const titleSpan = document.createElement("span");
            titleSpan.className = "toggle-label";
            titleSpan.textContent = title;

            const descSpan = document.createElement("span");
            descSpan.className = "setting-desc";
            descSpan.textContent = desc;

            meta.appendChild(titleSpan);
            meta.appendChild(descSpan);

            wrapper.appendChild(input);
            wrapper.appendChild(meta);
            grid.appendChild(wrapper);

            return input;
        };

        this.autoRollbackThresholdInput = createNumberRow("accordion-auto-rollback-threshold", "Auto-Rollback Failure Count", "Consecutive failed edits before auto-rollback is triggered.", 3, 1, 10);
        this.maxContextPrefillInput = createNumberRow("accordion-max-prefill", "Max Context Pre-fill (%)", "Sliding window upper threshold before culling triggers.", 80, 20, 98);
        this.minContextPrefillInput = createNumberRow("accordion-min-prefill", "Min Context Pre-fill (%)", "Sliding window cull target when max pre-fill is triggered.", 40, 10, 90);

        this.container.appendChild(this.settingsAccordion);

        // Listeners
        this.agentModeCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            ui.aiManager.agentMode = checked;
            localStorage.setItem("aiAgentMode", checked);
            if (session) {
                session.agentMode = checked;
                await workspaceClient.setSession(session.id, session);
            }
            const mainCheck = document.querySelector("#agent-mode-checkbox");
            if (mainCheck) mainCheck.checked = checked;
            ui.aiManager._updatePromptAreaPlaceholder();
        });

        this.planningModeCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            ui.aiManager.planningMode = checked;
            localStorage.setItem("aiPlanningMode", checked);
            if (session) {
                session.planningMode = checked;
                await workspaceClient.setSession(session.id, session);
            }
            const mainCheck = document.querySelector("#planning-mode-checkbox");
            if (mainCheck) mainCheck.checked = checked;
            ui.aiManager._updatePromptAreaPlaceholder();
        });

        this.forgivenessModeCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            window.ui.aiManager.forgivenessMode = checked;
            localStorage.setItem("aiForgivenessMode", checked);
            if (session) {
                session.forgivenessMode = checked;
                await workspaceClient.setSession(session.id, session);
            }
            this._updateOpenEditsReviewState(checked, session?.openEditsForReview);
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
        });

        this.openEditsForReviewCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            window.ui.aiManager.openEditsForReview = checked;
            if (session) {
                session.openEditsForReview = checked;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.allowSubAgentsCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            if (session) {
                session.allowSubAgents = checked;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.allowRunCommandCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            ui.aiManager.allowRunCommand = checked;
            localStorage.setItem("aiAllowRunCommand", checked);
            if (session) {
                session.allowRunCommand = checked;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.autoMilestonesCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            if (session) {
                session.autoMilestones = checked;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.autoRollbackCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            const session = this._getTargetSession();
            if (session) {
                session.autoRollbackOnFailures = checked;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.autoRollbackThresholdInput.addEventListener("change", async (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 10) val = 10;
            e.target.value = val;
            const session = this._getTargetSession();
            if (session) {
                session.autoRollbackFailureThreshold = val;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.minContextPrefillInput.addEventListener("change", async (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 10) val = 10;
            if (val > 90) val = 90;
            e.target.value = val;
            const session = this._getTargetSession();
            if (session) {
                session.contextPrefillMinPercentage = val;
                await workspaceClient.setSession(session.id, session);
            }
        });

        this.maxContextPrefillInput.addEventListener("change", async (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 20) val = 20;
            if (val > 98) val = 98;
            e.target.value = val;
            const session = this._getTargetSession();
            if (session) {
                session.contextPrefillMaxPercentage = val;
                await workspaceClient.setSession(session.id, session);
            }
        });
    }

    _updateOpenEditsReviewState(isForgiveness, sessionOpenEdits) {
        if (!this.openEditsForReviewCheckbox) return;
        const row = this.openEditsForReviewCheckbox.closest(".toggle-row");
        if (!isForgiveness) {
            this.openEditsForReviewCheckbox.disabled = true;
            this.openEditsForReviewCheckbox.checked = true;
            if (row) row.classList.add("disabled-row");
            this.openEditsForReviewCheckbox.title = "Required in Permission Mode: Edits must be opened in editor for review and saving.";
        } else {
            this.openEditsForReviewCheckbox.disabled = false;
            this.openEditsForReviewCheckbox.checked = sessionOpenEdits ?? (window.ui?.aiManager?.config?.defaultOpenEditsForReview ?? true);
            if (row) row.classList.remove("disabled-row");
            this.openEditsForReviewCheckbox.title = "Open Edits for Review: Open modified and newly created files in editor tabs for diff review.";
        }
    }

    _buildWorkspacesAccordion() {
        this.workspacesAccordion = new UIAccordion("workspaces", "Workspaces", "folder_copy", "var(--theme)");
        this.workspacesItem = this.workspacesAccordion;
        this.workspacesContentWrapper = this.workspacesAccordion.content;
        this.workspacesArrow = this.workspacesAccordion.arrow;

        this.workspacesContentWrapper.classList.add("accordion-content", "workspaces-content-wrapper");

        const intro = document.createElement("p");
        intro.className = "workspaces-intro";
        intro.innerHTML = "Workspaces scoped to this chat are available to this agent. Roots pinned at the top of the app are available to every chat.";
        this.workspacesContentWrapper.appendChild(intro);

        // Global pinned roots (workspace-level) - read-only reference
        const globalHeading = document.createElement("div");
        globalHeading.className = "workspaces-group-heading";
        globalHeading.textContent = "Pinned globally (all chats)";
        this.workspacesContentWrapper.appendChild(globalHeading);

        this.globalWorkspacesList = document.createElement("div");
        this.globalWorkspacesList.className = "workspaces-list global-workspaces-list";
        this.workspacesContentWrapper.appendChild(this.globalWorkspacesList);

        // This chat's own workspaces
        const chatHeading = document.createElement("div");
        chatHeading.className = "workspaces-group-heading";
        chatHeading.textContent = "This chat";
        this.workspacesContentWrapper.appendChild(chatHeading);

        this.chatWorkspacesList = document.createElement("div");
        this.chatWorkspacesList.className = "workspaces-list chat-workspaces-list";
        this.workspacesContentWrapper.appendChild(this.chatWorkspacesList);

        const addRow = document.createElement("div");
        addRow.className = "workspaces-add-row";
        this.addWorkspaceBtn = new Button("Add Workspace");
        this.addWorkspaceBtn.icon = "create_new_folder";
        this.addWorkspaceBtn.className = "themed";
        addRow.appendChild(this.addWorkspaceBtn);
        this.workspacesContentWrapper.appendChild(addRow);

        this.addWorkspaceBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session) return;
            const path = await promptAddFolder();
            if (!path) return;
            if (!session.workspaces) session.workspaces = [];
            if (!session.workspaces.includes(path)) {
                session.workspaces.push(path);
                session.lastModified = Date.now();
                await workspaceClient.setSession(session.id, session);
                // Make sure this folder is also open in the workspace so the agent can reach it.
                const ws = window.workspace;
                const normPath = (p) => (p || "").replace(/\\/g, '/').replace(/\/+$/, '');
                if (ws && Array.isArray(ws.folders) && !ws.folders.some(f => normPath(f) === normPath(path))) {
                    ws.folders.push(path);
                    await workspaceClient.setWorkspace(ws);
                    if (window.conduit) window.conduit.wsSetActiveRoots(ws.folders).catch(err => console.warn(err));
                    if (window.ui?.fileList?.refreshFolders) window.ui.fileList.refreshFolders();
                }
                this.renderWorkspaces();
            } else {
                window.modal.toast("That workspace is already scoped to this chat.");
            }
        };

        this.container.appendChild(this.workspacesAccordion);
    }

    renderWorkspaces() {
        const session = this._getTargetSession();
        if (!session) return;

        const availableFolders = window.workspace?.folders || [];

        // --- Global pinned roots (read-only) ---
        const globalPins = window.workspace?.pinnedRoots || [];
        this.globalWorkspacesList.innerHTML = "";
        if (globalPins.length === 0) {
            const empty = document.createElement("span");
            empty.className = "workspaces-empty";
            empty.textContent = "No roots pinned globally. Use the Roots Filter in the top bar to pin workspaces for all chats.";
            this.globalWorkspacesList.appendChild(empty);
        } else {
            for (const rootPath of globalPins) {
                const norm = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
                const rootName = norm.split('/').filter(Boolean).pop() || rootPath;
                const available = availableFolders.some(f => {
                    const nf = f.replace(/\\/g, '/').replace(/\/+$/, '');
                    return nf === norm || nf.endsWith('/' + norm) || nf.split('/').filter(Boolean).pop() === rootName;
                });
                const row = document.createElement("div");
                row.className = "workspace-row" + (available ? "" : " unavailable");
                const icon = document.createElement("ui-icon");
                icon.textContent = "lock";
                icon.title = "Pinned globally - available to all chats";
                const nameSpan = document.createElement("span");
                nameSpan.className = "workspace-name";
                nameSpan.textContent = rootName;
                nameSpan.title = rootPath;
                const statusSpan = document.createElement("span");
                statusSpan.className = "workspace-status";
                statusSpan.textContent = available ? "global" : "unavailable";
                row.append(icon, nameSpan, statusSpan);
                this.globalWorkspacesList.appendChild(row);
            }
        }

        // --- This chat's workspaces ---
        const legacyChatPins = Array.isArray(session.pinnedRoots) ? session.pinnedRoots : [];
        const chatWorkspacesRaw = session.workspaces || [];
        const chatWorkspaces = [...new Set([...chatWorkspacesRaw, ...legacyChatPins.filter(p => !chatWorkspacesRaw.includes(p))])];
        this.chatWorkspacesList.innerHTML = "";
        if (chatWorkspaces.length === 0) {
            const empty = document.createElement("span");
            empty.className = "workspaces-empty";
            empty.textContent = "No chat-specific workspaces. Click 'Add Workspace' to scope one to this chat.";
            this.chatWorkspacesList.appendChild(empty);
        } else {
            for (const rootPath of chatWorkspaces) {
                const norm = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
                const rootName = norm.split('/').filter(Boolean).pop() || rootPath;
                const available = availableFolders.some(f => {
                    const nf = f.replace(/\\/g, '/').replace(/\/+$/, '');
                    return nf === norm || nf.endsWith('/' + norm) || nf.split('/').filter(Boolean).pop() === rootName;
                });
                const row = document.createElement("div");
                row.className = "workspace-row" + (available ? "" : " unavailable");
                const icon = document.createElement("ui-icon");
                icon.textContent = available ? "folder" : "warning";
                const nameSpan = document.createElement("span");
                nameSpan.className = "workspace-name";
                nameSpan.textContent = rootName;
                nameSpan.title = rootPath;
                const removeBtn = new Button("Remove");
                removeBtn.icon = "close";
                removeBtn.className = "secondary workspace-remove-btn";
                removeBtn.onclick = async (e) => {
                    e.stopPropagation();
                    if (Array.isArray(session.workspaces)) {
                        session.workspaces = session.workspaces.filter(w => w !== rootPath);
                    }
                    if (Array.isArray(session.pinnedRoots)) {
                        const normRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
                        session.pinnedRoots = session.pinnedRoots.filter(p => {
                            const np = (p || "").replace(/\\/g, '/').replace(/\/+$/, '');
                            return np !== normRoot && np !== rootPath && p !== rootPath && np.split('/').filter(Boolean).pop() !== rootPath.split('/').filter(Boolean).pop();
                        });
                    }
                    session.lastModified = Date.now();
                    await workspaceClient.setSession(session.id, session);
                    this.renderWorkspaces();
                };
                row.append(icon, nameSpan, removeBtn);
                this.chatWorkspacesList.appendChild(row);
            }
        }
    }

    _buildPlanAccordion() {
        this.planAccordion = new UIAccordion("plan", "Implementation Plan", "assignment", "#d19a66", [{ className: "edit-plan-btn edit-btn", icon: "edit", title: "Edit plan" }]);
        this.planItem = this.planAccordion;
        this.planContentWrapper = this.planAccordion.content;
        this.planArrow = this.planAccordion.arrow;
        this.planBtn = this.planAccordion.editBtn;

        this.planContentWrapper.classList.add("plan-content-wrapper");

        this.planContent = document.createElement("div");
        this.planContent.className = "pane-content markdown-body";
        this.planContentWrapper.appendChild(this.planContent);

        this.container.appendChild(this.planAccordion);

        this.planBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session) return;

            if (!this.planEditorInstance) {
                this.planBtn.text = "Save";
                this.planBtn.icon = "save";
                this.planBtn.className = "apply";

                const currentHeight = this.planContent.offsetHeight;
                const rawMarkdown = session.implementationPlan || "";
                const editorHeight = Math.max(currentHeight, 150);

                this.planContent.innerHTML = "";
                
                const editorDiv = document.createElement("div");
                editorDiv.className = "plan-ace-editor";
                editorDiv.style.height = `${editorHeight}px`;
                editorDiv.style.width = "100%";
                editorDiv.style.position = "relative";
                this.planContent.appendChild(editorDiv);

                this.planEditorInstance = window.ace.edit(editorDiv);
                const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night";
                this.planEditorInstance.setTheme(theme);
                this.planEditorInstance.session.setMode("ace/mode/markdown");
                this.planEditorInstance.setValue(rawMarkdown, -1);
                this.planEditorInstance.setFontSize(12);
                this.planEditorInstance.setShowPrintMargin(false);
                this.planEditorInstance.renderer.setShowGutter(true);
                this.planEditorInstance.focus();
            } else {
                const newValue = this.planEditorInstance.getValue();
                session.implementationPlan = newValue;

                this.planEditorInstance.destroy();
                this.planEditorInstance = null;

                try {
                    await workspaceClient.setSession(session.id, session);
                } catch (err) {
                    console.error("[PlanTasksView] Error saving plan:", err);
                }

                this.planContent.innerHTML = newValue 
                    ? ui.aiManager.md.render(newValue)
                    : `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`;

                this.planBtn.text = "Edit";
                this.planBtn.icon = "edit";
                this.planBtn.className = "edit-plan-btn";
            }
        };
    }

    _buildTasksAccordion() {
        this.tasksAccordion = new UIAccordion("tasks", "Task Checklist", "playlist_add_check", "#2da44e", [{ className: "edit-tasks-btn edit-btn", icon: "edit", title: "Edit tasks" }]);
        this.tasksItem = this.tasksAccordion;
        this.tasksContentWrapper = this.tasksAccordion.content;
        this.tasksArrow = this.tasksAccordion.arrow;
        this.tasksBtn = this.tasksAccordion.editBtn;

        this.tasksContentWrapper.classList.add("tasks-content-wrapper");

        this.tasksContent = document.createElement("div");
        this.tasksContent.className = "pane-content markdown-body tasks-content";
        this.tasksContentWrapper.appendChild(this.tasksContent);

        this.container.appendChild(this.tasksAccordion);

        this.tasksBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session) return;

            if (!this.tasksEditorInstance) {
                this.tasksBtn.text = "Save";
                this.tasksBtn.icon = "save";
                this.tasksBtn.className = "apply";

                const currentHeight = this.tasksContent.offsetHeight;
                const rawMarkdown = session.taskList || "";
                const editorHeight = Math.max(currentHeight, 150);

                this.tasksContent.innerHTML = "";
                const editorDiv = document.createElement("div");
                editorDiv.className = "tasks-ace-editor";
                editorDiv.style.height = `${editorHeight}px`;
                editorDiv.style.width = "100%";
                editorDiv.style.position = "relative";
                this.tasksContent.appendChild(editorDiv);

                this.tasksEditorInstance = window.ace.edit(editorDiv);
                const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night";
                this.tasksEditorInstance.setTheme(theme);
                this.tasksEditorInstance.session.setMode("ace/mode/markdown");
                this.tasksEditorInstance.setValue(rawMarkdown, -1);
                this.tasksEditorInstance.setFontSize(12);
                this.tasksEditorInstance.setShowPrintMargin(false);
                this.tasksEditorInstance.renderer.setShowGutter(true);
                this.tasksEditorInstance.focus();
            } else {
                const newValue = this.tasksEditorInstance.getValue();
                session.taskList = newValue;

                this.tasksEditorInstance.destroy();
                this.tasksEditorInstance = null;

                try {
                    await workspaceClient.setSession(session.id, session);
                } catch (err) {
                    console.error("[PlanTasksView] Error saving task checklist:", err);
                }

                this.tasksContent.innerHTML = newValue 
                    ? ui.aiManager.md.render(newValue)
                    : `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`;

                this.tasksBtn.text = "Edit";
                this.tasksBtn.icon = "edit";
                this.tasksBtn.className = "edit-tasks-btn";
            }
        };
    }

    _buildBackupsAccordion() {
        this.backupsAccordion = new UIAccordion("backups", "Edit History & Rollbacks", "history", "var(--color-error, #ea4335)");
        this.backupsItem = this.backupsAccordion;
        this.backupsContent = this.backupsAccordion.content;
        this.backupsArrow = this.backupsAccordion.arrow;

        this.backupsContent.className = "accordion-content backups-content-wrapper";

        this.backupsList = document.createElement("div");
        this.backupsList.className = "backups-list";
        this.backupsContent.appendChild(this.backupsList);

        this.container.appendChild(this.backupsAccordion);
    }

    _buildScratchpadAccordion() {
        this.scratchpadAccordion = new UIAccordion("scratchpad", "Scratchpad", "sticky_note_2", "#e5a50a", [{ className: "edit-scratchpad-btn edit-btn", icon: "edit", title: "Edit scratchpad" }]);
        this.scratchpadItem = this.scratchpadAccordion;
        this.scratchpadContentWrapper = this.scratchpadAccordion.content;
        this.scratchpadArrow = this.scratchpadAccordion.arrow;
        this.scratchpadBtn = this.scratchpadAccordion.editBtn;

        this.clearScratchpadBtn = new Button("Clear");
        this.clearScratchpadBtn.className = "clear-btn clear-scratchpad-btn";
        this.clearScratchpadBtn.icon = "delete_sweep";
        this.scratchpadAccordion.rightContainer.insertBefore(this.clearScratchpadBtn, this.scratchpadArrow);

        this.clearScratchpadBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session || !session.scratchpad) return;

            const confirmed = await window.modal.confirm("Are you sure you want to clear the scratchpad notes?", "Clear Scratchpad");
            if (!confirmed) return;

            delete session.scratchpad;
            delete session.scratchpadTokenCount;
            session.lastModified = Date.now();
            await workspaceClient.setSession(session.id, session);

            if (this.scratchpadEditorInstance) {
                this.scratchpadEditorInstance.destroy();
                this.scratchpadEditorInstance = null;
                this.scratchpadBtn.text = "Edit";
                this.scratchpadBtn.icon = "edit";
                this.scratchpadBtn.className = "edit-scratchpad-btn";
            }

            this.scratchpadContent.innerHTML = `<span class="empty-state">No scratchpad notes recorded. Cadence will keep notes here.</span>`;
            if (window.modal?.toast) {
                window.modal.toast("Scratchpad cleared.");
            }
        };

        this.scratchpadContentWrapper.classList.add("scratchpad-content-wrapper");

        this.scratchpadContent = document.createElement("div");
        this.scratchpadContent.className = "pane-content markdown-body scratchpad-content";
        this.scratchpadContentWrapper.appendChild(this.scratchpadContent);

        this.container.appendChild(this.scratchpadAccordion);

        this.scratchpadBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session) return;

            if (!this.scratchpadEditorInstance) {
                this.scratchpadBtn.text = "Save";
                this.scratchpadBtn.icon = "save";
                this.scratchpadBtn.className = "apply";

                const currentHeight = this.scratchpadContent.offsetHeight;
                const rawMarkdown = session.scratchpad || "";
                const editorHeight = Math.max(currentHeight, 150);

                this.scratchpadContent.innerHTML = "";
                const editorDiv = document.createElement("div");
                editorDiv.className = "scratchpad-ace-editor";
                editorDiv.style.height = `${editorHeight}px`;
                editorDiv.style.width = "100%";
                editorDiv.style.position = "relative";
                this.scratchpadContent.appendChild(editorDiv);

                this.scratchpadEditorInstance = window.ace.edit(editorDiv);
                const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night";
                this.scratchpadEditorInstance.setTheme(theme);
                this.scratchpadEditorInstance.session.setMode("ace/mode/markdown");
                this.scratchpadEditorInstance.setValue(rawMarkdown, -1);
                this.scratchpadEditorInstance.setFontSize(12);
                this.scratchpadEditorInstance.setShowPrintMargin(false);
                this.scratchpadEditorInstance.renderer.setShowGutter(true);
                this.scratchpadEditorInstance.focus();
            } else {
                const newValue = this.scratchpadEditorInstance.getValue();
                const byteSize = new TextEncoder().encode(newValue).length;
                if (byteSize > 4096) {
                    if (window.modal?.notice) {
                        await window.modal.notice(`Scratchpad content exceeds 4KB limit (${byteSize} bytes / 4096 bytes max). Please keep your notes concise.`, "Limit Exceeded");
                    }
                    return;
                }

                if (newValue.trim()) {
                    session.scratchpad = newValue.trim();
                } else {
                    delete session.scratchpad;
                }
                delete session.scratchpadTokenCount;

                this.scratchpadEditorInstance.destroy();
                this.scratchpadEditorInstance = null;

                try {
                    await workspaceClient.setSession(session.id, session);
                } catch (err) {
                    console.error("[SessionArtifactsPanel] Error saving scratchpad:", err);
                }

                this.scratchpadContent.innerHTML = session.scratchpad 
                    ? ui.aiManager.md.render(session.scratchpad)
                    : `<span class="empty-state">No scratchpad notes recorded. Cadence will keep notes here.</span>`;

                this.scratchpadBtn.text = "Edit";
                this.scratchpadBtn.icon = "edit";
                this.scratchpadBtn.className = "edit-scratchpad-btn";
            }
        };
    }

    async update(sourceSession = null) {
        if (this.isUpdating) return;
        this.isUpdating = true;

        try {
            this.sourceSession = sourceSession || ui.aiManager.activeSession;
            const session = this.sourceSession;
            if (!session) {
                this.container.innerHTML = `<div class="plan-tasks-empty">No active session found. Open the Agent panel to begin.</div>`;
                return;
            }


        // Restore container if empty state was rendered previously
        if (this.container.querySelector(".plan-tasks-empty")) {
            this.container.innerHTML = "";
            this.container.appendChild(this.settingsItem);
            this.container.appendChild(this.workspacesItem);
            this.container.appendChild(this.backupsItem);
            this.container.appendChild(this.scratchpadItem);
            this.container.appendChild(this.tasksItem);
            this.container.appendChild(this.planItem);
        }

        // Restore accordion expanded states
        session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true, scratchpad: true, workspaces: true };

        this.settingsAccordion.applyState(session._accordionStates.settings !== false);
        this.planAccordion.applyState(session._accordionStates.plan !== false);
        this.tasksAccordion.applyState(session._accordionStates.tasks !== false);
        this.backupsAccordion.applyState(session._accordionStates.backups !== false);
        this.scratchpadAccordion.applyState(session._accordionStates.scratchpad !== false);
        this.workspacesAccordion.applyState(session._accordionStates.workspaces !== false);

        this.renderWorkspaces();

        // Update checkbox toggles and numeric inputs
        this.agentModeCheckbox.checked = session.agentMode ?? (ui.aiManager.config?.defaultAgentMode ?? false);
        this.planningModeCheckbox.checked = session.planningMode ?? (ui.aiManager.config?.defaultPlanningMode ?? true);
        const isForgiveness = session.forgivenessMode ?? (ui.aiManager.config?.defaultForgivenessMode ?? false);
        this.forgivenessModeCheckbox.checked = isForgiveness;
        this._updateOpenEditsReviewState(isForgiveness, session.openEditsForReview);
        this.allowSubAgentsCheckbox.checked = session.allowSubAgents !== false;
        this.allowRunCommandCheckbox.checked = session.allowRunCommand !== false;
        this.autoMilestonesCheckbox.checked = session.autoMilestones ?? (ui.aiManager.config?.defaultAutoMilestones !== false);
        this.autoRollbackCheckbox.checked = session.autoRollbackOnFailures ?? (ui.aiManager.config?.defaultAutoRollbackOnFailures === true);
        this.autoRollbackThresholdInput.value = session.autoRollbackFailureThreshold ?? (ui.aiManager.config?.defaultAutoRollbackThreshold || 3);
        this.minContextPrefillInput.value = session.contextPrefillMinPercentage ?? (ui.aiManager.config?.contextPrefillMinPercentage || 40);
        this.maxContextPrefillInput.value = session.contextPrefillMaxPercentage ?? (ui.aiManager.config?.contextPrefillMaxPercentage || 80);

        // Render implementation plan content if not editing
        if (!this.planEditorInstance) {
            this.planContent.innerHTML = session.implementationPlan 
                ? ui.aiManager.md.render(session.implementationPlan)
                : `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`;

            this.planBtn.text = "Edit";
            this.planBtn.icon = "edit";
            this.planBtn.className = "edit-plan-btn";
        }

        // Render tasks content if not editing
        if (!this.tasksEditorInstance) {
            this.tasksContent.innerHTML = session.taskList
                ? ui.aiManager.md.render(session.taskList)
                : `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`;

            this.tasksBtn.text = "Edit";
            this.tasksBtn.icon = "edit";
            this.tasksBtn.className = "edit-tasks-btn";
        }

        // Render scratchpad content if not editing
        if (!this.scratchpadEditorInstance) {
            this.scratchpadContent.innerHTML = session.scratchpad 
                ? ui.aiManager.md.render(session.scratchpad)
                : `<span class="empty-state">No scratchpad notes recorded. Cadence will keep notes here.</span>`;

            this.scratchpadBtn.text = "Edit";
            this.scratchpadBtn.icon = "edit";
            this.scratchpadBtn.className = "edit-scratchpad-btn";
        }

        // Render modified file backups list using programmatic DOM manipulation
        this.backupsList.innerHTML = "";

        const modifiedFiles = session.modifiedFiles || {};
        const filePaths = Object.keys(modifiedFiles);

        // Validate that backups actually exist in IndexedDB before listing them
        const { default: AgentBackup } = await import('../agent/agent-backup.mjs');
        const validatedModifiedFiles = {};
        let sessionNeedsSave = false;

        console.debug("[SessionArtifactsPanel] Starting validation of modified files:", filePaths);

        for (const path of filePaths) {
            const list = modifiedFiles[path] || [];
            const validList = [];
            console.debug(`[SessionArtifactsPanel] Validating backups for ${path}. Total items: ${list.length}`);
            for (const backup of list) {
                if (backup.isNewFile) {
                    console.debug(`[SessionArtifactsPanel] Backup is new file: ${backup.backupId || 'no-id'}`);
                    validList.push(backup);
                } else {
                    const exists = await AgentBackup.getBackup(backup.backupId);
                    console.debug(`[SessionArtifactsPanel] Checked backup ${backup.backupId}. Exists in IndexedDB:`, !!exists);
                    if (exists) {
                        validList.push(backup);
                    }
                }
            }
            if (validList.length > 0) {
                validatedModifiedFiles[path] = validList;
            }
            if (list.length !== validList.length) {
                sessionNeedsSave = true;
                console.debug(`[SessionArtifactsPanel] Backup list size mismatch for ${path}. Old: ${list.length}, New valid: ${validList.length}`);
                if (validList.length === 0) {
                    delete session.modifiedFiles[path];
                } else {
                    session.modifiedFiles[path] = validList;
                }
            }
        }

        if (sessionNeedsSave) {
            console.debug("[SessionArtifactsPanel] Saving updated session state due to invalid/expired backups");
            await workspaceClient.setSession(session.id, session);
        }

        const validFilePaths = Object.keys(validatedModifiedFiles);
        console.debug("[SessionArtifactsPanel] Completed validation. Valid file paths:", validFilePaths);

        if (validFilePaths.length === 0) {
            const emptyNotice = document.createElement("div");
            emptyNotice.className = "plan-tasks-empty";
            emptyNotice.textContent = "No file modifications recorded in this session yet.";
            this.backupsList.appendChild(emptyNotice);
        } else {
            const undoAllContainer = document.createElement("div");
            undoAllContainer.className = "undo-all-container";
            undoAllContainer.style.display = "flex";
            undoAllContainer.style.justifyContent = "space-between";
            undoAllContainer.style.alignItems = "center";
            undoAllContainer.style.padding = "4px 8px 8px 8px";
            undoAllContainer.style.borderBottom = "1px solid var(--border)";
            undoAllContainer.style.marginBottom = "8px";

            const setMilestoneBtn = new Button("Set Milestone");
            setMilestoneBtn.icon = "flag";
            setMilestoneBtn.className = "secondary";
            setMilestoneBtn.title = "Mark a new checkpoint milestone. Future edits will create new rollback versions without overwriting previous checkpoints.";
            setMilestoneBtn.onclick = async () => {
                session.lastMilestoneTimestamp = Date.now();
                session.lastModified = Date.now();
                await workspaceClient.setSession(session.id, session);
                window.modal.toast("Checkpoint milestone created.");
                this.update(session);
            };

            const undoAllBtn = new Button("Undo All");
            undoAllBtn.icon = "undo";
            undoAllBtn.className = "rollback secondary";
            undoAllBtn.onclick = async () => {
                const confirmed = await window.modal.confirm(
                    "Are you sure you want to undo/delete all modified files in this session? This action cannot be undone.",
                    "Undo All Changes"
                );
                if (!confirmed) return;

                undoAllBtn.disabled = true;
                undoAllBtn.text = "Undoing all...";
                undoAllBtn.icon = "sync";

                for (const path of validFilePaths) {
                    const list = validatedModifiedFiles[path];
                    const latestBackup = list[list.length - 1];
                    if (window.ui && window.ui.suppressFileChangeNotice) {
                        window.ui.suppressFileChangeNotice(path, 5000);
                    }
                    try {
                        if (latestBackup.isNewFile) {
                            await conduitClient.wsDelete(path);

                            const normalizePath = (p) => {
                                if (!p) return "";
                                return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
                            };
                            const checkAndAddTab = (tab, targetPath) => {
                                const tabPath = tab.config?.path;
                                if (!tabPath) return false;
                                const normTab = normalizePath(tabPath);
                                const normPath = normalizePath(targetPath);
                                return normTab === normPath || normTab.endsWith('/' + normPath) || normPath.endsWith('/' + normTab);
                            };

                            const tabsToCloseLeft = [];
                            const tabsToCloseRight = [];

                            if (ui.leftTabs?.tabs) {
                                for (const tab of ui.leftTabs.tabs) {
                                    if (checkAndAddTab(tab, path)) {
                                        tabsToCloseLeft.push(tab);
                                    }
                                }
                            }
                            if (ui.rightTabs?.tabs) {
                                for (const tab of ui.rightTabs.tabs) {
                                    if (checkAndAddTab(tab, path)) {
                                        tabsToCloseRight.push(tab);
                                    }
                                }
                            }

                            if (window.closeTab) {
                                for (const tab of tabsToCloseLeft) {
                                    await window.closeTab(ui.leftTabs, { tab }, true);
                                }
                                for (const tab of tabsToCloseRight) {
                                    await window.closeTab(ui.rightTabs, { tab }, true);
                                }
                            } else {
                                for (const tab of tabsToCloseLeft) {
                                    tab.tabBar.remove(tab, true);
                                }
                                for (const tab of tabsToCloseRight) {
                                    tab.tabBar.remove(tab, true);
                                }
                            }
                        } else {
                            const { default: AgentBackup } = await import('../agent/agent-backup.mjs');
                            const content = await AgentBackup.rollback(latestBackup.backupId);

                            const base64Content = btoa(unescape(encodeURIComponent(content)));
                            const result = await conduitClient.wsWrite(path, base64Content);
                            if (result.error) throw new Error(result.error);

                            const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
                            const pathsMatch = (p1, p2) => {
                                const n1 = normalize(p1);
                                const n2 = normalize(p2);
                                if (!n1 || !n2) return false;
                                return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
                            };
                            const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                            const tab = allOpenTabs.find(t => pathsMatch(t.config?.path, path));
                            if (tab && tab.config.session) {
                                tab.config.session.setValue(content);
                                tab.config.session.baseValue = content;
                                tab.changed = false;
                            }

                            const diffTab = allOpenTabs.find(t => t.config?.path === `diff_${latestBackup.backupId}`);
                            if (diffTab) {
                                diffTab.tabBar.remove(diffTab, true);
                            }
                        }
                    } catch (e) {
                        console.error(`Failed to undo changes for ${path}:`, e);
                    } finally {
                        if (window.ui && window.ui.resumeFileChangeNotice) {
                            window.ui.resumeFileChangeNotice(path);
                        }
                    }
                }

                session.modifiedFiles = {};
                await workspaceClient.setSession(session.id, session);

                if (window.ui?.fileList?.refreshFolders) {
                    window.ui.fileList.refreshFolders();
                }

                window.modal.toast("Successfully undid all session changes.");
                this.update(session);
            };

            undoAllContainer.appendChild(setMilestoneBtn);
            undoAllContainer.appendChild(undoAllBtn);
            this.backupsList.appendChild(undoAllContainer);

            validFilePaths.forEach(path => {
                const list = validatedModifiedFiles[path];
                const versionCount = list.length;
                const filename = path.split('/').pop();
                const relativePath = path; 
                const latestBackup = list[list.length - 1];

                const formatTime = (ts) => {
                    const diff = Date.now() - ts;
                    if (diff < 60000) return "Just now";
                    const mins = Math.floor(diff / 60000);
                    if (mins < 60) return `${mins}m ago`;
                    const hours = Math.floor(mins / 60);
                    if (hours < 24) return `${hours}h ago`;
                    return new Date(ts).toLocaleDateString();
                };

                const row = document.createElement("div");
                row.className = "backup-row";

                const info = document.createElement("div");
                info.className = "backup-info";

                const fileSpan = document.createElement("span");
                fileSpan.className = "backup-file";
                fileSpan.innerHTML = `${filename} <small class="backup-version-tag" style="background: rgba(255, 255, 255, 0.05); color: var(--text-muted, #888); padding: 2px 6px; border-radius: 10px; font-size: 10px; margin-left: 6px; font-weight: normal; border: 1px solid var(--border);">${versionCount} version${versionCount > 1 ? 's' : ''}</small>`;

                const pathSpan = document.createElement("span");
                pathSpan.className = "backup-path";
                pathSpan.textContent = relativePath;

                info.appendChild(fileSpan);
                info.appendChild(pathSpan);

                const actions = document.createElement("div");
                actions.className = "backup-actions";

                const timeSpan = document.createElement("span");
                timeSpan.className = "backup-time";
                timeSpan.textContent = formatTime(latestBackup.timestamp);

                const isNewFile = latestBackup.isNewFile === true;
                const btn = new Button(isNewFile ? "Delete" : "Rollback");
                btn.icon = isNewFile ? "delete" : "undo";
                btn.className = isNewFile ? "delete secondary" : "rollback secondary";

                const reviewBtn = new Button("Review");
                reviewBtn.icon = "visibility";
                reviewBtn.className = "secondary";

                reviewBtn.onclick = async () => {
                    console.debug("[SessionArtifactsPanel] Review clicked for path:", path);
                    console.debug("[SessionArtifactsPanel] Latest backup details:", latestBackup);
                    if (window.ui && window.ui.fileList && window.ui.fileList.open) {
                        console.debug("[SessionArtifactsPanel] Opening file tab via fileList.open");
                        await window.ui.fileList.open(path, path);
                        const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
                        const pathsMatch = (p1, p2) => {
                            const n1 = normalize(p1);
                            const n2 = normalize(p2);
                            if (!n1 || !n2) return false;
                            return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
                        };
                        const allOpenTabs = [...(window.ui.leftTabs?.tabs || []), ...(window.ui.rightTabs?.tabs || [])];
                        console.debug("[SessionArtifactsPanel] All open tabs config paths:", allOpenTabs.map(t => t.config?.path));
                        const tab = allOpenTabs.find(t => pathsMatch(t.config?.path, path));
                        if (tab) {
                            console.debug("[SessionArtifactsPanel] Found matching tab, setting viewMode to diff and backupId:", latestBackup.backupId);
                            tab.config.viewMode = "diff";
                            tab.config.backupId = latestBackup.backupId;
                            tab.config.sourceSession = session;
                            tab.click();
                        } else {
                            console.warn("[SessionArtifactsPanel] No matching tab found for path after opening:", path);
                        }
                    } else {
                        console.error("[SessionArtifactsPanel] window.ui.fileList.open is not defined");
                    }
                };

                btn.onclick = async () => {
                    if (isNewFile) {
                        const confirmed = await window.modal.confirm(`Are you sure you want to delete file <strong>${filename}</strong>?`, "Confirm Deletion");
                        if (!confirmed) return;

                        if (window.ui && window.ui.suppressFileChangeNotice) {
                            window.ui.suppressFileChangeNotice(path, 5000);
                        }
                        try {
                            btn.disabled = true;
                            btn.text = "Deleting...";
                            btn.icon = "sync";

                            // 1. Delete from disk via Conduit
                            const result = await conduitClient.wsDelete(path);
                            if (result.error) throw new Error(result.error);

                            // 2. Find and close any matching open tab
                            const normalizePath = (p) => {
                                if (!p) return "";
                                return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
                            };
                            const checkAndAddTab = (tab, targetPath) => {
                                const tabPath = tab.config?.path;
                                if (!tabPath) return false;
                                const normTab = normalizePath(tabPath);
                                const normPath = normalizePath(targetPath);
                                return normTab === normPath || normTab.endsWith('/' + normPath) || normPath.endsWith('/' + normTab);
                            };

                            const tabsToCloseLeft = [];
                            const tabsToCloseRight = [];

                            if (ui.leftTabs?.tabs) {
                                for (const tab of ui.leftTabs.tabs) {
                                    if (checkAndAddTab(tab, path)) {
                                        tabsToCloseLeft.push(tab);
                                    }
                                }
                            }
                            if (ui.rightTabs?.tabs) {
                                for (const tab of ui.rightTabs.tabs) {
                                    if (checkAndAddTab(tab, path)) {
                                        tabsToCloseRight.push(tab);
                                    }
                                }
                            }

                            if (window.closeTab) {
                                for (const tab of tabsToCloseLeft) {
                                    await window.closeTab(ui.leftTabs, { tab }, true);
                                }
                                for (const tab of tabsToCloseRight) {
                                    await window.closeTab(ui.rightTabs, { tab }, true);
                                }
                            } else {
                                for (const tab of tabsToCloseLeft) {
                                    tab.tabBar.remove(tab, true);
                                }
                                for (const tab of tabsToCloseRight) {
                                    tab.tabBar.remove(tab, true);
                                }
                            }

                            // 3. Mark file as deleted/removed in session modifiedFiles state
                            if (session.modifiedFiles && session.modifiedFiles[path]) {
                                delete session.modifiedFiles[path];
                                await workspaceClient.setSession(session.id, session);
                            }

                            // 4. Refresh folders
                            if (window.ui?.fileList?.refreshFolders) {
                                window.ui.fileList.refreshFolders();
                            } else {
                                const parentPathDelete = path.substring(0, path.lastIndexOf('/'));
                                if (window.ui?.fileList?.refreshFolder) {
                                    await window.ui.fileList.refreshFolder(parentPathDelete || ".");
                                }
                            }

                            window.modal.toast(`Successfully deleted ${filename}.`);
                            this.update(session);
                        } catch (err) {
                            console.error("Delete failed:", err);
                            window.modal.notice(`Delete failed:<br><small>${err.message}</small>`, "Delete Error");
                            btn.disabled = false;
                            btn.text = "Delete";
                            btn.icon = "delete";
                        } finally {
                            if (window.ui && window.ui.resumeFileChangeNotice) {
                                window.ui.resumeFileChangeNotice(path);
                            }
                        }
                    } else {
                        if (window.ui && window.ui.suppressFileChangeNotice) {
                            window.ui.suppressFileChangeNotice(path, 5000);
                        }
                        try {
                            btn.disabled = true;
                            btn.text = "Rolling back...";
                            btn.icon = "sync";

                            // 1. Revert content in AgentBackup
                            const { default: AgentBackup } = await import('../agent/agent-backup.mjs');
                            const content = await AgentBackup.rollback(latestBackup.backupId);

                            // 2. Write content directly to disk via Conduit
                            const base64Content = btoa(unescape(encodeURIComponent(content)));
                            const result = await conduitClient.wsWrite(path, base64Content);
                            if (result.error) throw new Error(result.error);

                            // 3. Update active editor session if currently open in tabs
                            const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
                            const pathsMatch = (p1, p2) => {
                                const n1 = normalize(p1);
                                const n2 = normalize(p2);
                                if (!n1 || !n2) return false;
                                return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
                            };
                            const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                            const tab = allOpenTabs.find(t => pathsMatch(t.config?.path, path));
                            if (tab && tab.config.session) {
                                tab.config.session.setValue(content);
                                tab.config.session.baseValue = content;
                                tab.changed = false;
                            }

                            // 4. Close open diff tab for this backup if present
                            const diffTab = allOpenTabs.find(t => t.config?.path === `diff_${latestBackup.backupId}`);
                            if (diffTab) {
                                diffTab.tabBar.remove(diffTab, true);
                            }

                            // 5. Mark backup as rolled back in the session state
                            if (session.modifiedFiles && session.modifiedFiles[path]) {
                                session.modifiedFiles[path] = session.modifiedFiles[path].filter(b => b.backupId !== latestBackup.backupId);
                                if (session.modifiedFiles[path].length === 0) {
                                    delete session.modifiedFiles[path];
                                }
                                await workspaceClient.setSession(session.id, session);
                            }

                             window.modal.toast(`Successfully rolled back ${filename} to original state.`);
                             this.update(session);
                         } catch (err) {
                            console.error("Rollback failed:", err);
                            window.modal.notice(`Rollback failed:<br><small>${err.message}</small>`, "Rollback Error");
                            btn.disabled = false;
                            btn.text = "Rollback";
                            btn.icon = "undo";
                        } finally {
                            if (window.ui && window.ui.resumeFileChangeNotice) {
                                window.ui.resumeFileChangeNotice(path);
                            }
                        }
                    }
                };

                actions.appendChild(timeSpan);
                actions.appendChild(reviewBtn);
                actions.appendChild(btn);

                row.appendChild(info);
                row.appendChild(actions);

                this.backupsList.appendChild(row);
            });
        }
    } catch (err) {
        console.error("Failed to update SessionArtifactsPanel:", err);
    } finally {
        this.isUpdating = false;
    }
}
}

customElements.define("ui-session-artifacts-panel", SessionArtifactsPanel);
