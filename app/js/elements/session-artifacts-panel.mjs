import { Block } from './element.mjs';
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
            this.editBtn = document.createElement("button");
            this.editBtn.className = `${editBtnClass} theme-button secondary edit-btn`;

            const editIcon = document.createElement("ui-icon");
            editIcon.textContent = "edit";
            const editLabel = document.createElement("span");
            editLabel.textContent = "Edit";

            this.editBtn.appendChild(editIcon);
            this.editBtn.appendChild(editLabel);
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
                this.planBtn.innerHTML = "";
                const saveIcon = document.createElement("ui-icon");
                saveIcon.textContent = "save";
                const saveLabel = document.createElement("span");
                saveLabel.textContent = "Save";
                this.planBtn.appendChild(saveIcon);
                this.planBtn.appendChild(saveLabel);
                this.planBtn.style.color = "var(--theme)";
                this.planBtn.style.borderColor = "var(--theme)";

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

                this.planBtn.innerHTML = "";
                const editIcon = document.createElement("ui-icon");
                editIcon.textContent = "edit";
                const editLabel = document.createElement("span");
                editLabel.textContent = "Edit";
                this.planBtn.appendChild(editIcon);
                this.planBtn.appendChild(editLabel);
                this.planBtn.style.color = "";
                this.planBtn.style.borderColor = "";
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
                this.tasksBtn.innerHTML = "";
                const saveIcon = document.createElement("ui-icon");
                saveIcon.textContent = "save";
                const saveLabel = document.createElement("span");
                saveLabel.textContent = "Save";
                this.tasksBtn.appendChild(saveIcon);
                this.tasksBtn.appendChild(saveLabel);
                this.tasksBtn.style.color = "var(--theme)";
                this.tasksBtn.style.borderColor = "var(--theme)";

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

                this.tasksBtn.innerHTML = "";
                const editIcon = document.createElement("ui-icon");
                editIcon.textContent = "edit";
                const editLabel = document.createElement("span");
                editLabel.textContent = "Edit";
                this.tasksBtn.appendChild(editIcon);
                this.tasksBtn.appendChild(editLabel);
                this.tasksBtn.style.color = "";
                this.tasksBtn.style.borderColor = "";
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

    update() {
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

        // Render implementation plan content if not editing
        if (!this.planEditorInstance) {
            this.planContent.innerHTML = session.implementationPlan 
                ? ui.aiManager.md.render(session.implementationPlan)
                : `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`;

            this.planBtn.innerHTML = "";
            const editIcon = document.createElement("ui-icon");
            editIcon.textContent = "edit";
            const editLabel = document.createElement("span");
            editLabel.textContent = "Edit";
            this.planBtn.appendChild(editIcon);
            this.planBtn.appendChild(editLabel);
            this.planBtn.style.color = "";
            this.planBtn.style.borderColor = "";
        }

        // Render tasks content if not editing
        if (!this.tasksEditorInstance) {
            this.tasksContent.innerHTML = session.taskList
                ? ui.aiManager.md.render(session.taskList)
                : `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`;

            this.tasksBtn.innerHTML = "";
            const editIcon = document.createElement("ui-icon");
            editIcon.textContent = "edit";
            const editLabel = document.createElement("span");
            editLabel.textContent = "Edit";
            this.tasksBtn.appendChild(editIcon);
            this.tasksBtn.appendChild(editLabel);
            this.tasksBtn.style.color = "";
            this.tasksBtn.style.borderColor = "";
        }

        // Render modified file backups list using programmatic DOM manipulation
        this.backupsList.innerHTML = "";

        const modifiedFiles = session.modifiedFiles || {};
        const filePaths = Object.keys(modifiedFiles);

        if (filePaths.length === 0) {
            const emptyNotice = document.createElement("div");
            emptyNotice.className = "plan-tasks-empty";
            emptyNotice.textContent = "No file modifications recorded in this session yet.";
            this.backupsList.appendChild(emptyNotice);
        } else {
            filePaths.forEach(path => {
                const list = modifiedFiles[path];
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
                fileSpan.textContent = filename;

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

                const btn = document.createElement("button");
                btn.className = "rollback-btn theme-button secondary";

                const btnIcon = document.createElement("ui-icon");
                btnIcon.textContent = "undo";

                const btnLabel = document.createElement("span");
                btnLabel.textContent = "Rollback";

                btn.appendChild(btnIcon);
                btn.appendChild(btnLabel);

                const reviewBtn = document.createElement("button");
                reviewBtn.className = "review-btn theme-button secondary";

                const reviewBtnIcon = document.createElement("ui-icon");
                reviewBtnIcon.textContent = "visibility";

                const reviewBtnLabel = document.createElement("span");
                reviewBtnLabel.textContent = "Review";

                reviewBtn.appendChild(reviewBtnIcon);
                reviewBtn.appendChild(reviewBtnLabel);

                reviewBtn.onclick = async () => {
                    if (window.ui && window.ui.fileList && window.ui.fileList.open) {
                        await window.ui.fileList.open(path, path);
                        const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
                        const pathsMatch = (p1, p2) => {
                            const n1 = normalize(p1);
                            const n2 = normalize(p2);
                            if (!n1 || !n2) return false;
                            return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
                        };
                        const allOpenTabs = [...(window.ui.leftTabs?.tabs || []), ...(window.ui.rightTabs?.tabs || [])];
                        const tab = allOpenTabs.find(t => pathsMatch(t.config?.path, path));
                        if (tab) {
                            tab.config.viewMode = "diff";
                            tab.config.backupId = latestBackup.backupId;
                            tab.click();
                        }
                    } else {
                        console.error("window.ui.fileList.open is not defined");
                    }
                };

                btn.onclick = async () => {
                    try {
                        btn.disabled = true;
                        btnIcon.className = "spinner";
                        btnIcon.textContent = "sync";
                        btnLabel.textContent = "Rolling back...";

                        // 1. Revert content in AgentBackup
                        const { default: AgentBackup } = await import('./agent/agent-backup.mjs');
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
                        btnIcon.className = "";
                        btnIcon.textContent = "undo";
                        btnLabel.textContent = "Rollback";
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
