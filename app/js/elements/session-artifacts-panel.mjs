import { Block } from './element.mjs';
import { Button } from './button.mjs';
import conduitClient from '../conduit-client.mjs';
import workspaceClient from '../workspace-client.mjs';

export class UIAccordion extends Block {
    constructor(sectionKey, titleText, iconText, iconColor = null, hasEditButton = false, editBtnClass = "") {
        super();
        this.sectionKey = sectionKey;
        this.classList.add("accordion-item");
        this.classList.add(`${sectionKey}-section`);

        this.header = document.createElement("div");
        this.header.className = "accordion-header";

        const headerLeft = document.createElement("div");
        headerLeft.className = "header-left";

        const icon = document.createElement("ui-icon");
        icon.textContent = iconText;
        if (iconColor) icon.style.color = iconColor;

        const titleSpan = document.createElement("span");
        titleSpan.textContent = titleText;

        headerLeft.appendChild(icon);
        headerLeft.appendChild(titleSpan);
        this.header.appendChild(headerLeft);

        this.rightContainer = document.createElement("div");
        this.rightContainer.className = "header-right";

        this.editBtn = null;
        if (hasEditButton) {
            this.editBtn = new Button("Edit");
            this.editBtn.className = `${editBtnClass} edit-btn`;
            this.editBtn.icon = "edit";

            this.rightContainer.appendChild(this.editBtn);
        }

        this.arrow = document.createElement("ui-icon");
        this.arrow.className = "expand-arrow";
        this.arrow.textContent = "expand_less";
        this.rightContainer.appendChild(this.arrow);
        this.header.appendChild(this.rightContainer);

        this.content = document.createElement("div");
        this.content.className = "accordion-content";

        this.appendChild(this.header);
        this.appendChild(this.content);

        // Click handler to expand/collapse
        this.header.onclick = (e) => {
            if (e.target.closest("button") || e.target.closest(".header-actions")) return;
            const session = ui.aiManager.activeSession;
            if (!session) return;
            session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true };

            const isExpanded = this.classList.toggle("expanded");
            session._accordionStates[this.sectionKey] = isExpanded;

            this.applyState(isExpanded);
        };
    }

    applyState(isExpanded) {
        if (isExpanded) {
            this.classList.add("expanded");
            this.content.style.display = "";
            this.arrow.style.transform = "rotate(0deg)";
            this.arrow.textContent = "expand_less";
        } else {
            this.classList.remove("expanded");
            this.content.style.display = "none";
            this.arrow.style.transform = "rotate(180deg)";
            this.arrow.textContent = "expand_more";
        }
    }
}
customElements.define("ui-accordion", UIAccordion);

export class SessionArtifactsPanel extends Block {
    constructor() {
        super();
        this.classList.add("plan-tasks-view");

        // Active Ace Editor instances
        this.planEditorInstance = null;
        this.tasksEditorInstance = null;

        // Build the outer scroll container programmatically
        this.container = document.createElement("div");
        this.container.className = "artifacts-accordion-container";
        this.appendChild(this.container);

        // 1. Session Settings Accordion
        this._buildSettingsAccordion();

        // 2. Edit History & Rollbacks Accordion
        this._buildBackupsAccordion();

        // 3. Task Checklist Accordion
        this._buildTasksAccordion();

        // 4. Implementation Plan Accordion
        this._buildPlanAccordion();
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
        this.allowSubAgentsCheckbox = createToggleRow("accordion-allow-sub-agents", "Allow Sub-Agents", "Allow Cadence to spawn sub-agents to solve smaller tasks.", "sub-agents-toggle-wrapper");

        this.container.appendChild(this.settingsAccordion);

        // Listeners
        this.agentModeCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            ui.aiManager.agentMode = checked;
            localStorage.setItem("aiAgentMode", checked);
            if (ui.aiManager.activeSession) {
                ui.aiManager.activeSession.agentMode = checked;
                await workspaceClient.setSession(ui.aiManager.activeSession.id, ui.aiManager.activeSession);
            }
            const mainCheck = document.querySelector("#agent-mode-checkbox");
            if (mainCheck) mainCheck.checked = checked;
            ui.aiManager._updatePromptAreaPlaceholder();
        });

        this.planningModeCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            ui.aiManager.planningMode = checked;
            localStorage.setItem("aiPlanningMode", checked);
            if (ui.aiManager.activeSession) {
                ui.aiManager.activeSession.planningMode = checked;
                await workspaceClient.setSession(ui.aiManager.activeSession.id, ui.aiManager.activeSession);
            }
            const mainCheck = document.querySelector("#planning-mode-checkbox");
            if (mainCheck) mainCheck.checked = checked;
            ui.aiManager._updatePromptAreaPlaceholder();
        });

        this.forgivenessModeCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            window.ui.aiManager.forgivenessMode = checked;
            localStorage.setItem("aiForgivenessMode", checked);
            if (window.ui.aiManager.activeSession) {
                window.ui.aiManager.activeSession.forgivenessMode = checked;
                await workspaceClient.setSession(window.ui.aiManager.activeSession.id, window.ui.aiManager.activeSession);
            }
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

        this.allowSubAgentsCheckbox.addEventListener("change", async (e) => {
            const checked = e.target.checked;
            if (ui.aiManager.activeSession) {
                ui.aiManager.activeSession.allowSubAgents = checked;
                await workspaceClient.setSession(ui.aiManager.activeSession.id, ui.aiManager.activeSession);
            }
        });
    }

    _buildPlanAccordion() {
        this.planAccordion = new UIAccordion("plan", "Implementation Plan", "assignment", "#d19a66", true, "edit-plan-btn");
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
            const session = ui.aiManager.activeSession;
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
        this.tasksAccordion = new UIAccordion("tasks", "Task Checklist", "playlist_add_check", "#2da44e", true, "edit-tasks-btn");
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
            const session = ui.aiManager.activeSession;
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

    async update() {
        const session = ui.aiManager.activeSession;
        if (!session) {
            this.container.innerHTML = `<div class="plan-tasks-empty">No active session found. Open the Agent panel to begin.</div>`;
            return;
        }

        // Restore container if empty state was rendered previously
        if (this.container.querySelector(".plan-tasks-empty")) {
            this.container.innerHTML = "";
            this.container.appendChild(this.settingsItem);
            this.container.appendChild(this.backupsItem);
            this.container.appendChild(this.tasksItem);
            this.container.appendChild(this.planItem);
        }

        // Restore accordion expanded states
        session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true };
        
        this.settingsAccordion.applyState(session._accordionStates.settings !== false);
        this.planAccordion.applyState(session._accordionStates.plan !== false);
        this.tasksAccordion.applyState(session._accordionStates.tasks !== false);
        this.backupsAccordion.applyState(session._accordionStates.backups !== false);

        // Update checkbox toggles
        this.agentModeCheckbox.checked = ui.aiManager.agentMode || false;
        this.planningModeCheckbox.checked = ui.aiManager.planningMode || false;
        this.forgivenessModeCheckbox.checked = ui.aiManager.forgivenessMode || false;
        this.allowSubAgentsCheckbox.checked = session.allowSubAgents !== false;

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
            undoAllContainer.style.justifyContent = "flex-end";
            undoAllContainer.style.padding = "4px 8px 8px 8px";
            undoAllContainer.style.borderBottom = "1px solid var(--border)";
            undoAllContainer.style.marginBottom = "8px";

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
                this.update();
            };

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
                            this.update();
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
                            this.update();
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
    }
}

customElements.define("ui-session-artifacts-panel", SessionArtifactsPanel);
