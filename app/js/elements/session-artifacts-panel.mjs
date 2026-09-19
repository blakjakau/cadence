import { Block, Inline } from './element.mjs';
import { Button } from './button.mjs';
import conduitClient from '../conduit-client.mjs';
import workspaceClient from '../workspace-client.mjs';
import { openCommandPolicyReviewModal } from '../util/command-policy-review.mjs';

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
            this.editBtn = new Button("");
            this.editBtn.className = `${editBtnClass} edit-btn`;
            this.editBtn.icon = "edit";
            this.editBtn.title = "Edit contents";

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
            const session = (typeof this.getTargetSession === "function") ? this.getTargetSession() : ui.aiManager.activeSession;
            if (!session) return;
            session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true, scratchpad: true };

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
        this.isUpdating = false;
        this.sourceSession = null;

        // Active Ace Editor instances
        this.planEditorInstance = null;
        this.tasksEditorInstance = null;
        this.scratchpadEditorInstance = null;

        // Scratchpad version-history viewing state.
        //   null  = live / "Newest" (the current, uncommitted scratchpad content)
        //   0..n-1 = index into session.scratchpadVersions (0 = oldest recorded)
        this.scratchpadViewingIndex = null;
        this._scratchpadViewSessionId = null;

        // Build the outer scroll container programmatically
        this.container = document.createElement("div");
        this.container.className = "artifacts-accordion-container";
        this.appendChild(this.container);

        // 1. Session Settings Accordion
        this._buildSettingsAccordion();

        // 2. Edit History & Rollbacks Accordion
        this._buildBackupsAccordion();

        // 3. Scratchpad Accordion
        this._buildScratchpadAccordion();

        // 4. Task Checklist Accordion
        this._buildTasksAccordion();

        // 5. Implementation Plan Accordion
        this._buildPlanAccordion();

        // Point every accordion's expand/collapse state at the source (not active) session.
        const accTarget = () => this._getTargetSession();
        this.settingsAccordion.getTargetSession = accTarget;
        this.backupsAccordion.getTargetSession = accTarget;
        this.scratchpadAccordion.getTargetSession = accTarget;
        this.tasksAccordion.getTargetSession = accTarget;
        this.planAccordion.getTargetSession = accTarget;
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

        // Cancel button (hidden unless the plan is being edited).
        // Hides the editor and restores the current plan without
        // persisting any changes.
        this.cancelPlanBtn = new Button("");
        this.cancelPlanBtn.className = "clear-btn cancel-plan-btn";
        this.cancelPlanBtn.icon = "close";
        this.cancelPlanBtn.title = "Cancel edit and restore the current plan";
        this.cancelPlanBtn.hidden = true;
        this.planAccordion.rightContainer.insertBefore(this.cancelPlanBtn, this.planAccordion.arrow);

        this.cancelPlanBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session || !this.planEditorInstance) return;

            this.planEditorInstance.destroy();
            this.planEditorInstance = null;

            this.planContent.innerHTML = session.implementationPlan
                ? ui.aiManager.md.render(session.implementationPlan)
                : `<span class="empty-state">No implementation plan defined. Cadence will outline one once active.</span>`;

            this.planBtn.text = "Edit";
            this.planBtn.icon = "edit";
            this.planBtn.className = "edit-plan-btn";
            this.cancelPlanBtn.hidden = true;
        };

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
                this.cancelPlanBtn.hidden = false;
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
                this.cancelPlanBtn.hidden = true;
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

        // Cancel button (hidden unless the task checklist is being edited).
        // Hides the editor and restores the current task list without
        // persisting any changes.
        this.cancelTasksBtn = new Button("");
        this.cancelTasksBtn.className = "clear-btn cancel-tasks-btn";
        this.cancelTasksBtn.icon = "close";
        this.cancelTasksBtn.title = "Cancel edit and restore the current task list";
        this.cancelTasksBtn.hidden = true;
        this.tasksAccordion.rightContainer.insertBefore(this.cancelTasksBtn, this.tasksAccordion.arrow);

        this.cancelTasksBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session || !this.tasksEditorInstance) return;

            this.tasksEditorInstance.destroy();
            this.tasksEditorInstance = null;

            this.tasksContent.innerHTML = session.taskList
                ? ui.aiManager.md.render(session.taskList)
                : `<span class="empty-state">No task list defined. Cadence will build one once active.</span>`;

            this.tasksBtn.text = "Edit";
            this.tasksBtn.icon = "edit";
            this.tasksBtn.className = "edit-tasks-btn";
            this.cancelTasksBtn.hidden = true;
        };

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
                this.cancelTasksBtn.hidden = false;
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
                this.cancelTasksBtn.hidden = true;
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
        this.scratchpadAccordion = new UIAccordion("scratchpad", "Scratchpad", "sticky_note_2", "#e5a50a", true, "edit-scratchpad-btn");
        this.scratchpadItem = this.scratchpadAccordion;
        this.scratchpadContentWrapper = this.scratchpadAccordion.content;
        this.scratchpadArrow = this.scratchpadAccordion.arrow;
        this.scratchpadBtn = this.scratchpadAccordion.editBtn;

        // History toggle button (next to Edit/Clear in the accordion header).
        // Toggles the `history-open` class on the content wrapper, which reveals
        // the collapsible version-history section (see CSS .scratchpad-history).
            this.historyScratchpadBtn = new Button("");
        this.historyScratchpadBtn.className = "clear-btn history-scratchpad-btn";
        this.historyScratchpadBtn.icon = "history";
        this.historyScratchpadBtn.title = "Show / hide scratchpad version history";
        this.historyScratchpadBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            this.scratchpadContentWrapper.classList.toggle("history-open");
            this._renderScratchpadHistory();
        };
        this.scratchpadAccordion.rightContainer.insertBefore(this.historyScratchpadBtn, this.scratchpadArrow);

        this.clearScratchpadBtn = new Button("");
        this.clearScratchpadBtn.className = "clear-btn clear-scratchpad-btn";
        this.clearScratchpadBtn.icon = "delete_sweep";
        this.clearScratchpadBtn.title = "Clear scratchpad";
        this.scratchpadAccordion.rightContainer.insertBefore(this.clearScratchpadBtn, this.scratchpadArrow);

        this.clearScratchpadBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session || !session.scratchpad) return;

            const confirmed = await window.modal.confirm("Are you sure you want to clear the scratchpad notes?", "Clear Scratchpad");
            if (!confirmed) return;

            // Snapshot the current content before the destructive clear.
            this._recordScratchpadVersion(session, "clear");
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

            this.scratchpadViewingIndex = null;
            this._scratchpadViewSessionId = null;
            this._setScratchpadEditUI(false);
            this._renderScratchpadHistory();
        };

        // Cancel button (hidden unless the scratchpad is being edited).
        // Hides the editor and restores the existing "live" scratchpad for the
        // session without persisting any changes.
        this.cancelScratchpadBtn = new Button("");
        this.cancelScratchpadBtn.className = "clear-btn cancel-scratchpad-btn";
        this.cancelScratchpadBtn.icon = "close";
        this.cancelScratchpadBtn.title = "Cancel edit and restore the live scratchpad";
        this.cancelScratchpadBtn.hidden = true;
        this.scratchpadAccordion.rightContainer.insertBefore(this.cancelScratchpadBtn, this.scratchpadArrow);

        this.cancelScratchpadBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            const session = this._getTargetSession();
            if (!session || !this.scratchpadEditorInstance) return;

            this.scratchpadEditorInstance.destroy();
            this.scratchpadEditorInstance = null;
            this.scratchpadBtn.text = "Edit";
            this.scratchpadBtn.icon = "edit";
            this.scratchpadBtn.className = "edit-scratchpad-btn";

            this.scratchpadViewingIndex = null;
            this._scratchpadViewSessionId = null;
            this.scratchpadContent.innerHTML = session.scratchpad
                ? ui.aiManager.md.render(session.scratchpad)
                : `<span class="empty-state">No scratchpad notes recorded. Cadence will keep notes here.</span>`;
            this._setScratchpadEditUI(false);
            this._renderScratchpadHistory();
        };

        this.scratchpadContentWrapper.classList.add("scratchpad-content-wrapper");

        // Collapsible version-history section (hidden unless .history-open on the wrapper).
        // Placed before the content pane so history sits above the live notes.
        this.scratchpadHistory = document.createElement("div");
        this.scratchpadHistory.className = "scratchpad-history";
        this.scratchpadContentWrapper.appendChild(this.scratchpadHistory);

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
                this._setScratchpadEditUI(true);

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

                // Snapshot the previous content before overwriting (replace is destructive).
                this._recordScratchpadVersion(session, "replace");
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
                this._setScratchpadEditUI(false);
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
            this.container.appendChild(this.backupsItem);
            this.container.appendChild(this.scratchpadItem);
            this.container.appendChild(this.tasksItem);
            this.container.appendChild(this.planItem);
        }

        // Restore accordion expanded states
        session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true, scratchpad: true };
        
        this.settingsAccordion.applyState(session._accordionStates.settings !== false);
        this.planAccordion.applyState(session._accordionStates.plan !== false);
        this.tasksAccordion.applyState(session._accordionStates.tasks !== false);
        this.backupsAccordion.applyState(session._accordionStates.backups !== false);
        this.scratchpadAccordion.applyState(session._accordionStates.scratchpad !== false);

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

        // Keep the cancel button hidden whenever we are NOT in scratchpad edit mode
        // (i.e. when the editor instance is not open), regardless of prior state.
        if (this.cancelScratchpadBtn) {
            this.cancelScratchpadBtn.hidden = !this.scratchpadEditorInstance;
        }
        // Keep the plan and tasks cancel buttons in sync with their editor states.
        if (this.cancelPlanBtn) {
            this.cancelPlanBtn.hidden = !this.planEditorInstance;
        }
        if (this.cancelTasksBtn) {
            this.cancelTasksBtn.hidden = !this.tasksEditorInstance;
        }

        // Render the scratchpad version-history section (pager + version rows).
        this._renderScratchpadHistory(session);

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

    /**
     * Toggles the scratchpad edit-mode UI. Entering edit mode hides the version
     * history and the clear button (to give the editor room) and reveals the
     * cancel button; exiting edit mode shows history/clear and hides cancel.
     * @param {boolean} isEditing - True when entering edit mode.
     */
    _setScratchpadEditUI(isEditing) {
        if (this.historyScratchpadBtn) this.historyScratchpadBtn.hidden = isEditing;
        if (this.clearScratchpadBtn) this.clearScratchpadBtn.hidden = isEditing;
        if (this.cancelScratchpadBtn) this.cancelScratchpadBtn.hidden = !isEditing;
        if (isEditing && this.scratchpadContentWrapper) {
            this.scratchpadContentWrapper.classList.remove("history-open");
        }
    }

    /**
     * Records a snapshot of the session's current scratchpad content into its
     * version history before a destructive overwrite (replace/clear). Mirrors the
     * agent-tool helper: deduplicates identical content and caps the history at 25.
     * @param {Object} session - The session object.
     * @param {string} mode - The operation that triggered the snapshot ('replace' | 'clear').
     */
    _recordScratchpadVersion(session, mode) {
        if (!session.scratchpad) return; // nothing to preserve
        if (!Array.isArray(session.scratchpadVersions)) {
            session.scratchpadVersions = [];
        }
        const last = session.scratchpadVersions[session.scratchpadVersions.length - 1];
        if (last && last.content === session.scratchpad) return; // dedup
        session.scratchpadVersions.push({
            version: (last?.version || 0) + 1,
            timestamp: Date.now(),
            mode: mode,
            content: session.scratchpad
        });
        if (session.scratchpadVersions.length > 25) {
            session.scratchpadVersions.splice(0, session.scratchpadVersions.length - 25);
        }
    }

    /**
     * Renders the collapsible scratchpad version-history section: a sticky header
     * with a Prev/Next pager, the live ("Newest") tile, and one row per recorded
     * version (newest-first). Also drives the read-only viewing banner in the
     * main content area.
     * @param {Object} [session] - Session to render; defaults to the target session.
     */
    _renderScratchpadHistory(session = null) {
        const target = session || this._getTargetSession();
        if (!target) return;

        // Reset viewing state if it points at a version from a different session.
        if (this._scratchpadViewSessionId && this._scratchpadViewSessionId !== target.id) {
            this.scratchpadViewingIndex = null;
            this._scratchpadViewSessionId = null;
        }

        const versions = Array.isArray(target.scratchpadVersions) ? target.scratchpadVersions : [];

        // --- Main content area: read-only viewing banner vs. live content. ---
        if (this.scratchpadViewingIndex !== null && versions[this.scratchpadViewingIndex]) {
            const v = versions[this.scratchpadViewingIndex];
            this.scratchpadContent.innerHTML =
                `<div class="scratchpad-viewing-banner"><ui-icon>history</ui-icon> Viewing version ${v.version} (read-only)</div>` +
                (v.content ? ui.aiManager.md.render(v.content) : `<span class="empty-state">Empty version.</span>`);
        } else if (this.scratchpadViewingIndex === null && !this.scratchpadEditorInstance) {
            // Keep the "Viewing..." indicator visible when the history panel is open
            // even while the live (current) scratchpad is active, for consistency with
            // the "Viewing version N (read-only)" banner shown for recorded versions.
            const liveBanner = this.scratchpadContentWrapper?.classList.contains("history-open")
                ? `<div class="scratchpad-viewing-banner"><ui-icon>history</ui-icon> Viewing live</div>`
                : "";
            this.scratchpadContent.innerHTML =
                liveBanner +
                (target.scratchpad
                    ? ui.aiManager.md.render(target.scratchpad)
                    : `<span class="empty-state">No scratchpad notes recorded. Cadence will keep notes here.</span>`);
        }

        // --- Build the history list. ---
        const section = this.scratchpadHistory;
        section.innerHTML = "";

        const header = document.createElement("div");
        header.className = "scratchpad-history-header";

        const title = new Inline();
        title.className = "scratchpad-history-title";
        title.textContent = `Version History (${versions.length})`;
        header.appendChild(title);

        // Prev / Next pager. Position 0 = "Newest" (live), position i+1 = versions[i].
        // The list renders top-to-bottom as: live (Newest) -> versions[n-1] (newest
        // recorded) -> ... -> versions[0] (oldest).
        //   chevron_left  (prev)  steps UP the list toward live; wraps to the oldest
        //   entry when at live.
        //   chevron_right (next)  steps DOWN the list toward oldest; wraps to live
        //   when at the oldest entry.
        // Navigation wraps around the full list (no hard stops at either end).
        const pager = document.createElement("div");
        pager.className = "scratchpad-history-pager";

        const atNewest = this.scratchpadViewingIndex === null;

        const prevBtn = new Button();
        prevBtn.icon = "chevron_left";
        prevBtn.className = "scratchpad-pager-btn";
        prevBtn.title = "Previous (toward live, wraps to oldest)";
        if (versions.length === 0) prevBtn.setAttribute("disabled", "");
        prevBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            if (prevBtn.hasAttribute("disabled")) return;
            this._navigateScratchpadHistory(-1);
        };

        const nextBtn = new Button();
        nextBtn.icon = "chevron_right";
        nextBtn.className = "scratchpad-pager-btn";
        nextBtn.title = "Next (toward oldest, wraps to live)";
        if (versions.length === 0) nextBtn.setAttribute("disabled", "");
        nextBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            if (nextBtn.hasAttribute("disabled")) return;
            this._navigateScratchpadHistory(1);
        };

        const posLabel = new Inline();
        posLabel.className = "scratchpad-history-pos";
        if (atNewest) {
            posLabel.textContent = "Viewing live";
        } else {
            posLabel.textContent = `Viewing v${versions[this.scratchpadViewingIndex].version}`;
        }

        pager.appendChild(prevBtn);
        pager.appendChild(posLabel);
        pager.appendChild(nextBtn);
        header.appendChild(pager);

        section.appendChild(header);

        const formatTime = (ts) => {
            const diff = Date.now() - ts;
            if (diff < 60000) return "Just now";
            const mins = Math.floor(diff / 60000);
            if (mins < 60) return `${mins}m ago`;
            const hours = Math.floor(mins / 60);
            if (hours < 24) return `${hours}h ago`;
            return new Date(ts).toLocaleDateString();
        };

        // Hover-reveal action buttons (vertical ellipsis + icon buttons), mirroring the
        // turn-actions layout in ai-manager-history.mjs.
        const createVersionActions = (viewBtn, restoreBtn = null, deleteBtn = null) => {
            const actions = document.createElement("div");
            actions.className = "scratchpad-version-actions";

            const ellipsis = document.createElement("ui-icon");
            ellipsis.className = "version-actions-ellipsis";
            ellipsis.textContent = "more_vert";

            const buttons = document.createElement("div");
            buttons.className = "version-actions-buttons";
            buttons.appendChild(viewBtn);
            if (restoreBtn) buttons.appendChild(restoreBtn);
            if (deleteBtn) buttons.appendChild(deleteBtn);

            actions.append(ellipsis, buttons);
            return actions;
        };

        // "Newest" tile: represents the live scratchpad content (viewingIndex null).
        const newestViewBtn = new Button();
        newestViewBtn.icon = "visibility";
        newestViewBtn.className = "scratchpad-version-view";
        newestViewBtn.title = "View live scratchpad";
        newestViewBtn.onclick = (e) => {
            if (e) e.stopPropagation();
            this.scratchpadViewingIndex = null;
            this._scratchpadViewSessionId = null;
            this._renderScratchpadHistory();
        };

        const newestRow = document.createElement("div");
        newestRow.className = "scratchpad-version-row scratchpad-version-row-newest";
        if (atNewest) newestRow.classList.add("viewing");
        newestRow.title = "View the live (current) scratchpad content";
        newestRow.onclick = (e) => {
            if (e) e.stopPropagation();
            this.scratchpadViewingIndex = null;
            this._scratchpadViewSessionId = null;
            this._renderScratchpadHistory();
        };

        const newestMeta = document.createElement("div");
        newestMeta.className = "scratchpad-version-meta";

        const newestNum = new Inline();
        newestNum.className = "scratchpad-version-num";
        newestNum.textContent = "Newest";
        newestMeta.appendChild(newestNum);

        const newestTime = new Inline();
        newestTime.className = "scratchpad-version-time";
        newestTime.textContent = "live";
        newestMeta.appendChild(newestTime);

        const newestSnippet = new Inline();
        newestSnippet.className = "scratchpad-version-snippet";
        newestSnippet.textContent = (target.scratchpad || "").trim().slice(0, 120) || "(empty)";
        newestMeta.appendChild(newestSnippet);

        newestRow.appendChild(newestMeta);
        newestRow.appendChild(createVersionActions(newestViewBtn));
        section.appendChild(newestRow);

        if (versions.length === 0) {
            const empty = document.createElement("div");
            empty.className = "scratchpad-history-empty";
            empty.textContent = "No previous versions recorded yet.";
            section.appendChild(empty);
            return;
        }

        // Render newest-first: the newest recorded version sits at the top (right
        // after the live item) and the oldest at the bottom.
        for (let idx = versions.length - 1; idx >= 0; idx--) {
            const v = versions[idx];
            const viewBtn = new Button();
            viewBtn.icon = "visibility";
            viewBtn.className = "scratchpad-version-view";
            viewBtn.title = `View version ${v.version}`;
            viewBtn.onclick = (e) => {
                if (e) e.stopPropagation();
                this.scratchpadViewingIndex = idx;
                this._scratchpadViewSessionId = target.id;
                this._renderScratchpadHistory();
            };

            const restoreBtn = new Button();
            restoreBtn.icon = "restore_page";
            restoreBtn.className = "scratchpad-version-restore";
            restoreBtn.title = `Restore version ${v.version}`;
            restoreBtn.onclick = (e) => {
                if (e) e.stopPropagation();
                this._restoreScratchpadVersion(idx);
            };

            const deleteBtn = new Button();
            deleteBtn.icon = "delete";
            deleteBtn.className = "scratchpad-version-delete";
            deleteBtn.title = `Delete version ${v.version}`;
            deleteBtn.onclick = (e) => {
                if (e) e.stopPropagation();
                this._deleteScratchpadVersion(idx);
            };

            const row = document.createElement("div");
            row.className = "scratchpad-version-row";
            if (this.scratchpadViewingIndex === idx) row.classList.add("viewing");
            row.title = `View version ${v.version}`;
            row.onclick = (e) => {
                if (e) e.stopPropagation();
                this.scratchpadViewingIndex = idx;
                this._scratchpadViewSessionId = target.id;
                this._renderScratchpadHistory();
            };

            const meta = document.createElement("div");
            meta.className = "scratchpad-version-meta";

            const vNum = new Inline();
            vNum.className = "scratchpad-version-num";
            vNum.textContent = `v${v.version}`;
            meta.appendChild(vNum);

            const ts = new Inline();
            ts.className = "scratchpad-version-time";
            ts.textContent = formatTime(v.timestamp);
            meta.appendChild(ts);

            const snippet = new Inline();
            snippet.className = "scratchpad-version-snippet";
            snippet.textContent = (v.content || "").trim().slice(0, 120) || "(empty)";
            meta.appendChild(snippet);

            row.appendChild(meta);
            row.appendChild(createVersionActions(viewBtn, restoreBtn, deleteBtn));
            section.appendChild(row);
        }
    }

    /**
     * Moves the viewed version by `delta` (positive = older / toward the oldest
     * entry, negative = newer / toward "Newest"). "Newest" (live) is represented
     * by `null` and sits at position 0; versions[i] sits at position i+1. The
     * position wraps around the full list so the ends are never dead ends:
     * stepping past live lands on the oldest entry, and stepping past the oldest
     * entry lands back on live. Re-renders the read-only view and history list.
     * @param {number} delta - -1 (prev, toward live) or +1 (next, toward oldest).
     */
    _navigateScratchpadHistory(delta) {
        const session = this._getTargetSession();
        const versions = Array.isArray(session?.scratchpadVersions) ? session.scratchpadVersions : [];
        if (versions.length === 0) return;

        // Map current viewing state to a 1-based position (Newest = 0).
        const pos = this.scratchpadViewingIndex === null ? 0 : this.scratchpadViewingIndex + 1;
        const total = versions.length + 1; // live + all recorded versions
        let nextPos = (pos + delta) % total;
        if (nextPos < 0) nextPos += total;

        if (nextPos === 0) {
            this.scratchpadViewingIndex = null;
            this._scratchpadViewSessionId = null;
        } else {
            this.scratchpadViewingIndex = nextPos - 1;
            this._scratchpadViewSessionId = session.id;
        }
        this._renderScratchpadHistory();
    }

    /**
     * Restores the chosen version to the live scratchpad. The current content is
     * first pushed onto the version stack (so nothing is lost), then the chosen
     * content becomes the active scratchpad and is persisted.
     * @param {number} idx - Index into session.scratchpadVersions.
     */
    async _restoreScratchpadVersion(idx) {
        const session = this._getTargetSession();
        const versions = Array.isArray(session?.scratchpadVersions) ? session.scratchpadVersions : [];
        if (idx < 0 || idx >= versions.length) return;
        const chosen = versions[idx];

        // Push the current live content onto the stack so the restore itself is
        // reversible (keeps prior history intact).
        this._recordScratchpadVersion(session, "replace");

        session.scratchpad = chosen.content;
        delete session.scratchpadTokenCount;
        session.lastModified = Date.now();
        await workspaceClient.setSession(session.id, session);

        // Return to the live view and refresh.
        this.scratchpadViewingIndex = null;
        this._scratchpadViewSessionId = null;
        if (window.modal?.toast) {
            window.modal.toast(`Restored scratchpad to version ${chosen.version}.`);
        }
        await this.update(session);
    }

    /**
     * Permanently deletes a recorded scratchpad version. Confirms with the user
     * first (deletion is irreversible). If the deleted version is the one
     * currently being viewed, the view resets to the live scratchpad.
     * @param {number} idx - Index into session.scratchpadVersions.
     */
    async _deleteScratchpadVersion(idx) {
        const session = this._getTargetSession();
        const versions = Array.isArray(session?.scratchpadVersions) ? session.scratchpadVersions : [];
        if (idx < 0 || idx >= versions.length) return;
        const chosen = versions[idx];

        const confirmed = await window.modal.confirm(
            `Delete version ${chosen.version}? This cannot be undone.`,
            "Delete Version"
        );
        if (!confirmed) return;

        // Remove the entry and renumber the remaining versions so the "vN"
        // labels stay contiguous and stable after deletion.
        session.scratchpadVersions = versions
            .filter((_, i) => i !== idx)
            .map((v, i) => ({ ...v, version: i + 1 }));

        // Reconcile the viewing index against the renumbered list. The delete
        // shifted every entry after `idx` up by one, so an index that was valid
        // before may now point at the wrong (newer) version.
        if (this.scratchpadViewingIndex !== null) {
            const newLength = session.scratchpadVersions.length;
            if (this.scratchpadViewingIndex === idx) {
                // Viewing the deleted version — fall back to the nearest surviving
                // item (the one just before it, or the first one if none exists).
                this.scratchpadViewingIndex = idx > 0 ? idx - 1 : 0;
            } else if (this.scratchpadViewingIndex > idx) {
                // Shifted up by one: the same logical version is now one slot lower.
                this.scratchpadViewingIndex -= 1;
            }
            // viewingIndex < idx is unchanged and stays valid.

            // Guard against an out-of-range index (e.g. deleting the only version
            // while viewing it) so the render never dereferences a missing entry.
            if (this.scratchpadViewingIndex >= newLength) {
                this.scratchpadViewingIndex = newLength > 0 ? newLength - 1 : null;
            }
        }

        // If we ended up viewing a recorded version, make sure it's pinned to
        // this session (already set when the index was assigned, but keep it in
        // sync in case the session changed).
        if (this.scratchpadViewingIndex !== null) {
            this._scratchpadViewSessionId = session.id;
        }

        session.lastModified = Date.now();
        await workspaceClient.setSession(session.id, session);

        if (window.modal?.toast) {
            window.modal.toast(`Deleted scratchpad version ${chosen.version}.`);
        }
        await this.update(session);
    }
}

customElements.define("ui-session-artifacts-panel", SessionArtifactsPanel);
