import { Block } from './element.mjs';
import conduitClient from '../conduit-client.mjs';
import workspaceClient from '../workspace-client.mjs';

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
        this.container.style.cssText = "display: flex; flex-direction: column; width: 100%; overflow-y: auto; padding: 8px; gap: 12px; box-sizing: border-box; background: var(--bg-primary);";
        this.appendChild(this.container);

        // 1. Session Settings Accordion
        this._buildSettingsAccordion();

        // 4. Edit History & Rollbacks Accordion
        this._buildBackupsAccordion();

        // 3. Task Checklist Accordion
        this._buildTasksAccordion();

        // 2. Implementation Plan Accordion
        this._buildPlanAccordion();


    }

    _createAccordionShell(sectionKey, titleText, iconText, iconColor, hasEditButton = false, editBtnClass = "") {
        const item = document.createElement("div");
        item.className = `accordion-item ${sectionKey}-section`;
        item.style.cssText = "display: flex; flex-direction: column; border: 1px solid var(--border-primary); border-radius: var(--borderRadius); overflow: hidden; background: var(--bg-primary);";

        const header = document.createElement("div");
        header.className = "accordion-header";
        header.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-secondary); cursor: pointer; user-select: none;";

        const headerLeft = document.createElement("div");
        headerLeft.className = "header-left";
        headerLeft.style.cssText = "display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--text-primary);";

        const icon = document.createElement("ui-icon");
        icon.textContent = iconText;
        if (iconColor) icon.style.color = iconColor;

        const titleSpan = document.createElement("span");
        titleSpan.textContent = titleText;

        headerLeft.appendChild(icon);
        headerLeft.appendChild(titleSpan);
        header.appendChild(headerLeft);

        const rightContainer = document.createElement("div");
        rightContainer.style.cssText = "display: flex; align-items: center; gap: 8px;";

        let editBtn = null;
        if (hasEditButton) {
            editBtn = document.createElement("button");
            editBtn.className = `${editBtnClass} theme-button secondary`;
            editBtn.style.cssText = "display: flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-weight: 600; border-radius: var(--borderRadius); border: 1px solid var(--border-primary); background: var(--bg-primary); color: var(--text-secondary);";

            const editIcon = document.createElement("ui-icon");
            editIcon.textContent = "edit";
            editIcon.style.fontSize = "14px";
            const editLabel = document.createElement("span");
            editLabel.textContent = "Edit";

            editBtn.appendChild(editIcon);
            editBtn.appendChild(editLabel);
            rightContainer.appendChild(editBtn);
        }

        const arrow = document.createElement("ui-icon");
        arrow.className = "expand-arrow";
        arrow.style.cssText = "font-size: 16px; transition: transform 0.2s ease;";
        arrow.textContent = "expand_less";
        rightContainer.appendChild(arrow);
        header.appendChild(rightContainer);

        const content = document.createElement("div");
        content.className = "accordion-content";
        content.style.cssText = "border-top: 1px solid var(--border-primary); background: var(--bg-primary);";

        item.appendChild(header);
        item.appendChild(content);
        this.container.appendChild(item);

        // Click handler to expand/collapse
        header.onclick = (e) => {
            if (e.target.closest("button") || e.target.closest(".header-actions")) return;
            const session = ui.aiManager.activeSession;
            if (!session) return;
            session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true };

            const isExpanded = item.classList.toggle("expanded");
            session._accordionStates[sectionKey] = isExpanded;

            if (isExpanded) {
                content.style.display = "";
                arrow.style.transform = "rotate(0deg)";
                arrow.textContent = "expand_less";
            } else {
                content.style.display = "none";
                arrow.style.transform = "rotate(180deg)";
                arrow.textContent = "expand_more";
            }
        };

        return { item, header, content, arrow, editBtn };
    }

    _buildSettingsAccordion() {
        const shell = this._createAccordionShell("settings", "Session Settings", "settings", "var(--theme)");
        this.settingsContent = shell.content;
        this.settingsItem = shell.item;
        this.settingsArrow = shell.arrow;

        this.settingsContent.style.padding = "16px";

        const grid = document.createElement("div");
        grid.className = "settings-grid";
        grid.style.cssText = "display: flex; flex-direction: column; gap: 16px;";
        this.settingsContent.appendChild(grid);

        // Helper to construct a single toggle row programmatically
        const createToggleRow = (id, title, desc, wrapperClass) => {
            const wrapper = document.createElement("div");
            wrapper.className = wrapperClass;
            wrapper.style.cssText = "display: flex; align-items: flex-start; gap: 12px; margin-right: 0;";

            const label = document.createElement("label");
            label.className = "switch";
            label.title = `${title}: ${desc}`;
            label.style.cssText = "flex-shrink: 0;";

            const input = document.createElement("input");
            input.type = "checkbox";
            input.id = id;

            const slider = document.createElement("span");
            slider.className = "slider round";

            label.appendChild(input);
            label.appendChild(slider);

            const meta = document.createElement("div");
            meta.className = "setting-meta";
            meta.style.cssText = "display: flex; flex-direction: column; gap: 2px;";

            const titleSpan = document.createElement("span");
            titleSpan.className = "toggle-label";
            titleSpan.style.cssText = "font-size: 12.5px; font-weight: 600; color: var(--text-primary); cursor: pointer; user-select: none;";
            titleSpan.textContent = title;
            titleSpan.onclick = () => input.click();

            const descSpan = document.createElement("span");
            descSpan.className = "setting-desc";
            descSpan.style.cssText = "font-size: 11px; color: var(--text-secondary);";
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

        // Listeners
        this.agentModeCheckbox.addEventListener("change", (e) => {
            const checked = e.target.checked;
            ui.aiManager.agentMode = checked;
            localStorage.setItem("aiAgentMode", checked);
            const mainCheck = document.querySelector("#agent-mode-checkbox");
            if (mainCheck) mainCheck.checked = checked;
            ui.aiManager._updatePromptAreaPlaceholder();
        });

        this.planningModeCheckbox.addEventListener("change", (e) => {
            const checked = e.target.checked;
            ui.aiManager.planningMode = checked;
            localStorage.setItem("aiPlanningMode", checked);
            const mainCheck = document.querySelector("#planning-mode-checkbox");
            if (mainCheck) mainCheck.checked = checked;
            ui.aiManager._updatePromptAreaPlaceholder();
        });

        this.forgivenessModeCheckbox.addEventListener("change", (e) => {
            const checked = e.target.checked;
            ui.aiManager.forgivenessMode = checked;
            localStorage.setItem("aiForgivenessMode", checked);
        });
    }

    _buildPlanAccordion() {
        const shell = this._createAccordionShell("plan", "Implementation Plan", "assignment", "#d19a66", true, "edit-plan-btn");
        this.planItem = shell.item;
        this.planContentWrapper = shell.content;
        this.planArrow = shell.arrow;
        this.planBtn = shell.editBtn;

        this.planContentWrapper.style.cssText += "position: relative; min-height: 100px;";

        this.planContent = document.createElement("div");
        this.planContent.className = "pane-content markdown-body";
        this.planContent.style.cssText = "padding: 16px 20px; line-height: 1.6; font-size: 13px; color: var(--text-secondary);";
        this.planContentWrapper.appendChild(this.planContent);

        this.planBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = ui.aiManager.activeSession;
            if (!session) return;

            if (!this.planEditorInstance) {
                this.planBtn.innerHTML = `<ui-icon>save</ui-icon><span>Save</span>`;
                this.planBtn.style.color = "var(--theme)";
                this.planBtn.style.borderColor = "var(--theme)";

                const currentHeight = this.planContent.offsetHeight;
                const rawMarkdown = session.implementationPlan || "";
                const editorHeight = Math.max(currentHeight, 150);

                this.planContent.style.padding = "0";
                this.planContent.innerHTML = `<div class="plan-ace-editor" style="height: ${editorHeight}px; width: 100%; position: relative;"></div>`;
                const editorDiv = this.planContent.querySelector(".plan-ace-editor");

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

                this.planContent.style.padding = "16px 20px";
                this.planContent.innerHTML = newValue 
                    ? ui.aiManager.md.render(newValue)
                    : `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`;

                this.planBtn.innerHTML = `<ui-icon style="font-size: 14px;">edit</ui-icon><span>Edit</span>`;
                this.planBtn.style.color = "var(--text-secondary)";
                this.planBtn.style.borderColor = "var(--border-primary)";
            }
        };
    }

    _buildTasksAccordion() {
        const shell = this._createAccordionShell("tasks", "Task Checklist", "playlist_add_check", "#2da44e", true, "edit-tasks-btn");
        this.tasksItem = shell.item;
        this.tasksContentWrapper = shell.content;
        this.tasksArrow = shell.arrow;
        this.tasksBtn = shell.editBtn;

        this.tasksContentWrapper.style.cssText += "position: relative; min-height: 100px;";

        this.tasksContent = document.createElement("div");
        this.tasksContent.className = "pane-content markdown-body tasks-content";
        this.tasksContent.style.cssText = "padding: 16px 20px; line-height: 1.6; font-size: 13px; color: var(--text-secondary);";
        this.tasksContentWrapper.appendChild(this.tasksContent);

        this.tasksBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = ui.aiManager.activeSession;
            if (!session) return;

            if (!this.tasksEditorInstance) {
                this.tasksBtn.innerHTML = `<ui-icon>save</ui-icon><span>Save</span>`;
                this.tasksBtn.style.color = "var(--theme)";
                this.tasksBtn.style.borderColor = "var(--theme)";

                const currentHeight = this.tasksContent.offsetHeight;
                const rawMarkdown = session.taskList || "";
                const editorHeight = Math.max(currentHeight, 150);

                this.tasksContent.style.padding = "0";
                this.tasksContent.innerHTML = `<div class="tasks-ace-editor" style="height: ${editorHeight}px; width: 100%; position: relative;"></div>`;
                const editorDiv = this.tasksContent.querySelector(".tasks-ace-editor");

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

                this.tasksContent.style.padding = "16px 20px";
                this.tasksContent.innerHTML = newValue 
                    ? ui.aiManager.md.render(newValue)
                    : `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`;

                this.tasksBtn.innerHTML = `<ui-icon style="font-size: 14px;">edit</ui-icon><span>Edit</span>`;
                this.tasksBtn.style.color = "var(--text-secondary)";
                this.tasksBtn.style.borderColor = "var(--border-primary)";
            }
        };
    }

    _buildBackupsAccordion() {
        const shell = this._createAccordionShell("backups", "Edit History & Rollbacks", "history", "var(--color-error, #ea4335)");
        this.backupsItem = shell.item;
        this.backupsContent = shell.content;
        this.backupsArrow = shell.arrow;

        this.backupsContent.style.padding = "16px";

        this.backupsList = document.createElement("div");
        this.backupsList.className = "backups-list";
        this.backupsList.style.cssText = "display: flex; flex-direction: column; gap: 8px;";
        this.backupsContent.appendChild(this.backupsList);
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
        const applyState = (sectionKey, item, content, arrow) => {
            const expanded = session._accordionStates[sectionKey] !== false;
            if (expanded) {
                item.classList.add("expanded");
                content.style.display = "";
                arrow.style.transform = "rotate(0deg)";
                arrow.textContent = "expand_less";
            } else {
                item.classList.remove("expanded");
                content.style.display = "none";
                arrow.style.transform = "rotate(180deg)";
                arrow.textContent = "expand_more";
            }
        };

        applyState("settings", this.settingsItem, this.settingsContent, this.settingsArrow);
        applyState("plan", this.planItem, this.planContentWrapper, this.planArrow);
        applyState("tasks", this.tasksItem, this.tasksContentWrapper, this.tasksArrow);
        applyState("backups", this.backupsItem, this.backupsContent, this.backupsArrow);

        // Update checkbox toggles
        this.agentModeCheckbox.checked = ui.aiManager.agentMode || false;
        this.planningModeCheckbox.checked = ui.aiManager.planningMode || false;
        this.forgivenessModeCheckbox.checked = ui.aiManager.forgivenessMode || false;

        // Render implementation plan content if not editing
        if (!this.planEditorInstance) {
            this.planContent.style.padding = "16px 20px";
            this.planContent.innerHTML = session.implementationPlan 
                ? ui.aiManager.md.render(session.implementationPlan)
                : `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`;

            this.planBtn.innerHTML = `<ui-icon style="font-size: 14px;">edit</ui-icon><span>Edit</span>`;
            this.planBtn.style.color = "var(--text-secondary)";
            this.planBtn.style.borderColor = "var(--border-primary)";
        }

        // Render tasks content if not editing
        if (!this.tasksEditorInstance) {
            this.tasksContent.style.padding = "16px 20px";
            this.tasksContent.innerHTML = session.taskList
                ? ui.aiManager.md.render(session.taskList)
                : `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`;

            this.tasksBtn.innerHTML = `<ui-icon style="font-size: 14px;">edit</ui-icon><span>Edit</span>`;
            this.tasksBtn.style.color = "var(--text-secondary)";
            this.tasksBtn.style.borderColor = "var(--border-primary)";
        }

        // Render modified file backups list using programmatic DOM manipulation
        this.backupsList.innerHTML = "";

        const modifiedFiles = session.modifiedFiles || {};
        const filePaths = Object.keys(modifiedFiles);

        if (filePaths.length === 0) {
            const emptyNotice = document.createElement("div");
            emptyNotice.className = "plan-tasks-empty";
            emptyNotice.style.padding = "16px 0";
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
                row.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--borderRadius); gap: 16px;";

                const info = document.createElement("div");
                info.className = "backup-info";
                info.style.cssText = "display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1;";

                const fileSpan = document.createElement("span");
                fileSpan.className = "backup-file";
                fileSpan.style.cssText = "font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--text-primary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;";
                fileSpan.textContent = filename;

                const pathSpan = document.createElement("span");
                pathSpan.className = "backup-path";
                pathSpan.style.cssText = "font-size: 10.5px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;";
                pathSpan.textContent = relativePath;

                info.appendChild(fileSpan);
                info.appendChild(pathSpan);

                const actions = document.createElement("div");
                actions.className = "backup-actions";
                actions.style.cssText = "display: flex; align-items: center; gap: 8px;";

                const timeSpan = document.createElement("span");
                timeSpan.style.cssText = "font-size: 11px; color: var(--text-secondary);";
                timeSpan.textContent = formatTime(latestBackup.timestamp);

                const btn = document.createElement("button");
                btn.className = "rollback-btn theme-button secondary";
                btn.style.cssText = "padding: 4px 10px; font-size: 11.5px; display: flex; align-items: center; gap: 4px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border-primary); color: var(--text-primary); background: var(--bg-primary);";

                const btnIcon = document.createElement("ui-icon");
                btnIcon.textContent = "undo";
                btnIcon.style.fontSize = "14px";

                const btnLabel = document.createElement("span");
                btnLabel.textContent = "Rollback";

                btn.appendChild(btnIcon);
                btn.appendChild(btnLabel);

                const reviewBtn = document.createElement("button");
                reviewBtn.className = "review-btn theme-button secondary";
                reviewBtn.style.cssText = "padding: 4px 10px; font-size: 11.5px; display: flex; align-items: center; gap: 4px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border-primary); color: var(--text-primary); background: var(--bg-primary);";

                const reviewBtnIcon = document.createElement("ui-icon");
                reviewBtnIcon.textContent = "visibility";
                reviewBtnIcon.style.fontSize = "14px";

                const reviewBtnLabel = document.createElement("span");
                reviewBtnLabel.textContent = "Review";

                reviewBtn.appendChild(reviewBtnIcon);
                reviewBtn.appendChild(reviewBtnLabel);

                reviewBtn.onclick = () => {
                    if (window.ui && window.ui.openDiffTab) {
                        window.ui.openDiffTab(path, latestBackup.backupId);
                    } else {
                        console.error("window.ui.openDiffTab is not defined");
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
                        const clean = (p) => p ? p.replace(/\\/g, '/') : '';
                        const normPath = clean(path);
                        const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                        const tab = allOpenTabs.find(t => clean(t.config?.path) === normPath);
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
