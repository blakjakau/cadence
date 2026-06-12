import { Block } from './element.mjs';
import { Button } from './button.mjs';
import conduitClient from '../conduit-client.mjs';
import workspaceClient from '../workspace-client.mjs';

export class DiffViewPanel extends Block {
    constructor() {
        super();

        // 1. Header Bar
        this.header = document.createElement("div");
        this.header.className = "diff-header";

        const headerLeft = document.createElement("div");
        headerLeft.className = "diff-header-left";

        const icon = document.createElement("ui-icon");
        icon.textContent = "difference";

        this.titleSpan = document.createElement("span");
        this.titleSpan.className = "diff-header-title";

        headerLeft.appendChild(icon);
        headerLeft.appendChild(this.titleSpan);

        // View Mode Preference
        this.diffViewMode = localStorage.getItem("diffViewMode") || "split";

        // View toggle buttons (Split / Unified)
        this.toggleContainer = document.createElement("div");
        this.toggleContainer.className = "diff-header-nav toggle-container";

        this.splitBtn = new Button("Split");
        this.splitBtn.className = "nav-btn";
        this.splitBtn.icon = "vertical_split";
        this.splitBtn.title = "Side-by-side Diff View";

        this.unifiedBtn = new Button("Unified");
        this.unifiedBtn.className = "nav-btn";
        this.unifiedBtn.icon = "format_align_justify";
        this.unifiedBtn.title = "Unified Diff View";

        this.toggleContainer.appendChild(this.splitBtn);
        this.toggleContainer.appendChild(this.unifiedBtn);

        const updateActiveToggleState = () => {
            if (this.diffViewMode === "split") {
                this.splitBtn.setAttribute('active', '');
                this.unifiedBtn.removeAttribute('active');
            } else {
                this.splitBtn.removeAttribute('active');
                this.unifiedBtn.setAttribute('active', '');
            }
        };


        this.splitBtn.onclick = (e) => {
            e.stopPropagation();
            if (this.diffViewMode === "split") return;
            this.diffViewMode = "split";
            localStorage.setItem("diffViewMode", "split");
            updateActiveToggleState();
            if (this.activeFilePath) {
                this.update(this.activeFilePath, this.activeBackupId, this.activeTab);
            }
        };

        this.unifiedBtn.onclick = (e) => {
            e.stopPropagation();
            if (this.diffViewMode === "unified") return;
            this.diffViewMode = "unified";
            localStorage.setItem("diffViewMode", "unified");
            updateActiveToggleState();
            if (this.activeFilePath) {
                this.update(this.activeFilePath, this.activeBackupId, this.activeTab);
            }
        };

        updateActiveToggleState();
        this.updateActiveToggleState = updateActiveToggleState;

        // Jump to nearest edits navigation buttons
        this.navContainer = document.createElement("div");
        this.navContainer.className = "diff-header-nav nav-container";

        this.prevBtn = new Button("");
        this.prevBtn.className = "nav-btn";
        this.prevBtn.icon = "chevron_left";
        this.prevBtn.title = "Previous Edit";

        this.editCountSpan = document.createElement("span");
        this.editCountSpan.className = "diff-edit-count";
        this.editCountSpan.textContent = "0/0";

        this.nextBtn = new Button("");
        this.nextBtn.className = "nav-btn";
        this.nextBtn.icon = "chevron_right";
        this.nextBtn.title = "Next Edit";

        this.navContainer.appendChild(this.prevBtn);
        this.navContainer.appendChild(this.editCountSpan);
        this.navContainer.appendChild(this.nextBtn);

        const scrollToBlock = (block) => {
            if (!block || !this.leftEditor) return;
            this.leftEditor.scrollToLine(block.start, true, true, () => {});
            setTimeout(() => {
                this.updateEditCount();
            }, 50);
        };

        const getActiveBlockIndex = () => {
            if (!this.changeBlocks || this.changeBlocks.length === 0 || !this.leftEditor) return -1;
            const firstRow = this.leftEditor.getFirstVisibleRow();
            const lastRow = this.leftEditor.getLastVisibleRow();
            const centerRow = firstRow + Math.floor((lastRow - firstRow) / 2);
            
            let minDiff = Infinity;
            let activeIdx = 0;
            for (let i = 0; i < this.changeBlocks.length; i++) {
                const block = this.changeBlocks[i];
                let diff = 0;
                if (centerRow < block.start) {
                    diff = block.start - centerRow;
                } else if (centerRow > block.end) {
                    diff = centerRow - block.end;
                } else {
                    diff = 0;
                }
                if (diff < minDiff) {
                    minDiff = diff;
                    activeIdx = i;
                }
            }
            return activeIdx;
        };

        this.prevBtn.onclick = (e) => {
            e.stopPropagation();
            if (!this.changeBlocks || this.changeBlocks.length === 0) return;
            const activeIdx = getActiveBlockIndex();
            if (activeIdx > 0) {
                scrollToBlock(this.changeBlocks[activeIdx - 1]);
            } else {
                scrollToBlock(this.changeBlocks[this.changeBlocks.length - 1]);
            }
        };

        this.nextBtn.onclick = (e) => {
            e.stopPropagation();
            if (!this.changeBlocks || this.changeBlocks.length === 0) return;
            const activeIdx = getActiveBlockIndex();
            if (activeIdx < this.changeBlocks.length - 1) {
                scrollToBlock(this.changeBlocks[activeIdx + 1]);
            } else {
                scrollToBlock(this.changeBlocks[0]);
            }
        };

        headerLeft.appendChild(this.navContainer);
        headerLeft.appendChild(this.toggleContainer);

        this.header.appendChild(headerLeft);

        this.headerRight = document.createElement("div");
        this.headerRight.className = "diff-header-right";
        this.header.appendChild(this.headerRight);
        this.appendChild(this.header);

        // 2. Split Body Container
        this.body = document.createElement("div");
        this.body.className = "diff-split-container";

        // Left Panel (Original)
        this.leftPane = document.createElement("div");
        this.leftPane.className = "diff-pane left-pane";

        this.leftLabel = document.createElement("div");
        this.leftLabel.className = "diff-pane-label";
        this.leftLabel.textContent = "Original (Backup)";

        this.leftEditorDiv = document.createElement("div");
        this.leftEditorDiv.className = "diff-ace-editor-left";

        this.leftPane.appendChild(this.leftLabel);
        this.leftPane.appendChild(this.leftEditorDiv);

        // Right Panel (Current)
        this.rightPane = document.createElement("div");
        this.rightPane.className = "diff-pane right-pane";

        this.rightLabel = document.createElement("div");
        this.rightLabel.className = "diff-pane-label";
        this.rightLabel.textContent = "Modified (Current)";

        this.rightEditorDiv = document.createElement("div");
        this.rightEditorDiv.className = "diff-ace-editor-right";

        this.rightPane.appendChild(this.rightLabel);
        this.rightPane.appendChild(this.rightEditorDiv);

        this.body.appendChild(this.leftPane);
        this.body.appendChild(this.rightPane);

        // Split Ratio Toggle FAB
        this.diffSplitRatio = localStorage.getItem("diffSplitRatio") || "50%";
        this.body.style.setProperty("--left-width", this.diffSplitRatio);

        this.ratioFab = document.createElement("button");
        this.ratioFab.className = "diff-ratio-fab";
        
        const fabIcon = document.createElement("ui-icon");
        let initialIcon = "splitscreen";
        let initialTitle = "Toggle Split Ratio (50/50)";
        if (this.diffSplitRatio === "33%") {
            initialIcon = "view_sidebar";
            initialTitle = "Toggle Split Ratio (33/67)";
        } else if (this.diffSplitRatio === "15%") {
            initialIcon = "vertical_split";
            initialTitle = "Toggle Split Ratio (15/85)";
        }
        fabIcon.textContent = initialIcon;
        this.ratioFab.title = initialTitle;
        this.ratioFab.appendChild(fabIcon);

        this.ratioFab.onclick = (e) => {
            e.stopPropagation();
            let nextRatio = "50%";
            let nextIcon = "splitscreen";
            let nextTitle = "Toggle Split Ratio (50/50)";

            if (this.diffSplitRatio === "50%") {
                nextRatio = "33%";
                nextIcon = "view_sidebar";
                nextTitle = "Toggle Split Ratio (33/67)";
            } else if (this.diffSplitRatio === "33%") {
                nextRatio = "15%";
                nextIcon = "vertical_split";
                nextTitle = "Toggle Split Ratio (15/85)";
            } else {
                nextRatio = "50%";
                nextIcon = "splitscreen";
                nextTitle = "Toggle Split Ratio (50/50)";
            }

            this.diffSplitRatio = nextRatio;
            localStorage.setItem("diffSplitRatio", nextRatio);
            this.body.style.setProperty("--left-width", nextRatio);
            
            fabIcon.textContent = nextIcon;
            this.ratioFab.title = nextTitle;

            if (this.leftEditor) this.leftEditor.resize();
            if (this.rightEditor) this.rightEditor.resize();
            this.refreshDiff();
        };

        this.body.appendChild(this.ratioFab);
        this.appendChild(this.body);

        // Ace editor instances
        this.leftEditor = null;
        this.rightEditor = null;

        this.leftMarkers = [];
        this.rightMarkers = [];

        this.activeBackupId = null;
        this.activeFilePath = null;
    }

    async update(filePath, backupId, tab = null) {
        this._isupdating = true;

        this.activeBackupId = backupId;
        this.activeFilePath = filePath || tab?.config?.path || "";
        this.activeTab = tab;

        const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
        const pathsMatch = (p1, p2) => {
            const n1 = normalize(p1);
            const n2 = normalize(p2);
            if (!n1 || !n2) return false;
            return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
        };

        const filename = this.activeFilePath ? this.activeFilePath.split('/').pop() : (tab?.config?.name || 'Unknown');
        this.titleSpan.textContent = `Review Changes: ${filename}`;

        // Clear existing markers and scrollbar overlays immediately and synchronously when switching tabs
        if (this.leftEditor) {
            const overlay = this.leftEditor.container.querySelector(".diff-scrollbar-marker-overlay");
            if (overlay) overlay.remove();
            if (this.leftMarkers) {
                this.leftMarkers.forEach(id => this.leftEditor.getSession().removeMarker(id));
            }
            clearGutterDecorations(this.leftEditor.getSession());
        }
        this.leftMarkers = [];
 
        if (this.rightEditor) {
            const overlay = this.rightEditor.container.querySelector(".diff-scrollbar-marker-overlay");
            if (overlay) overlay.remove();
            if (this.rightMarkers) {
                this.rightMarkers.forEach(id => this.rightEditor.getSession().removeMarker(id));
            }
            clearGutterDecorations(this.rightEditor.getSession());
        }
        this.rightMarkers = [];

        try {
            const isReloadDiff = tab && tab.config?.fileModified === true;
            const isForgivenessMode = !isReloadDiff && !!backupId;
            const isAIPendingEdits = (() => {
                const activeSession = window.ui?.aiManager?.activeSession;
                if (activeSession && activeSession.pendingEdits && this.activeFilePath) {
                    return !!Object.keys(activeSession.pendingEdits).find(k => pathsMatch(k, this.activeFilePath));
                }
                return false;
            })();
            const isEditable = !isReloadDiff && !isForgivenessMode && !isAIPendingEdits;

            let originalContent = "";
            let currentContent = "";
            
            const { default: AgentBackup } = await import('../agent/agent-backup.mjs');

            let backupMissing = false;
            if (isReloadDiff) {
                // Reload Diff Mode: Original is current editor content, Current is new content from disk
                if (tab && tab.config?.session) {
                    originalContent = tab.config.session.getValue();
                } else {
                    originalContent = "";
                }

                if (this.activeFilePath) {
                    const fileData = await conduitClient.wsRead(this.activeFilePath);
                    if (fileData.error) throw new Error(fileData.error);
                    currentContent = decodeURIComponent(escape(atob(fileData.data)));
                } else {
                    currentContent = originalContent;
                }
            } else if (isForgivenessMode) {
                // Forgiveness Mode: Original is from backup, Current is in-memory/on-disk
                try {
                    if (backupId === "new_file") {
                        originalContent = "";
                    } else {
                        originalContent = await AgentBackup.rollback(backupId);
                    }
                } catch (e) {
                    console.warn("[DiffViewPanel] Failed to retrieve backup:", e);
                    if (window.modal && window.modal.toast) {
                        window.modal.toast("Backup not found or expired. Reverting to edit view.");
                    }
                    if (tab) {
                        tab.config.viewMode = "edit";
                        setTimeout(() => {
                            tab.click();
                        }, 50);
                    }
                    return;
                }
 
                if (tab && tab.config?.session) {
                    currentContent = tab.config.session.getValue();
                } else if (this.activeFilePath) {
                    const fileData = await conduitClient.wsRead(this.activeFilePath);
                    if (fileData.error) throw new Error(fileData.error);
                    currentContent = decodeURIComponent(escape(atob(fileData.data)));
                } else {
                    currentContent = originalContent;
                }
            } else {
                // Permission Mode / User Edits: Original is on-disk, Current is dirty/in-memory
                if (this.activeFilePath) {
                    const fileData = await conduitClient.wsRead(this.activeFilePath);
                    if (fileData.error) throw new Error(fileData.error);
                    originalContent = decodeURIComponent(escape(atob(fileData.data)));
                } else {
                    originalContent = "";
                }

                if (tab && tab.config?.session) {
                    currentContent = tab.config.session.getValue();
                } else {
                    currentContent = originalContent; // Fallback
                }
            }

            // Determine Ace mode based on active session's mode, or fallback to filename extension
            let mode = "ace/mode/text";
            if (tab && tab.config?.session) {
                const sessionMode = tab.config.session.getMode();
                if (sessionMode && sessionMode.$id) {
                    mode = sessionMode.$id;
                }
            } else {
                for (let n in window.ace_modes) {
                    const m = window.ace_modes[n];
                    if (filename.match(m.extRe)) {
                        mode = m.mode;
                        break;
                    }
                }
            }

            const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night";

            // Save variables for refreshDiff
            this.originalContent = originalContent;
            this.currentTheme = theme;
            this.currentMode = mode;

            let leftLabelText = "";
            let rightLabelText = "";

            if (isReloadDiff) {
                leftLabelText = "Current Editor Content";
                rightLabelText = "New Content on Disk";
            } else if (isForgivenessMode) {
                leftLabelText = backupMissing ? "Original (Backup Missing)" : "Original (Backup)";
                rightLabelText = "Modified (Current)";
            } else {
                leftLabelText = "Original (On Disk)";
                rightLabelText = "Modified (Current)";
            }
            this.leftLabelText = leftLabelText;
            this.rightLabelText = rightLabelText;

            // Split contents into lines for initial calculations
            const origLines = originalContent.split(/\r?\n/);
            const currLines = currentContent.split(/\r?\n/);
            const diff = diffLines(origLines, currLines);
            this.activeDiff = diff;
            this.deletedRowsUnified = [];
            this.addedRowsUnified = [];

            const unifiedContentLines = [];
            diff.forEach(item => {
                if (item.type === 'keep') {
                    unifiedContentLines.push(item.leftLine);
                } else if (item.type === 'delete') {
                    this.deletedRowsUnified.push(unifiedContentLines.length);
                    unifiedContentLines.push(item.leftLine);
                } else if (item.type === 'add') {
                    this.addedRowsUnified.push(unifiedContentLines.length);
                    unifiedContentLines.push(item.rightLine);
                }
            });
            this.unifiedContentText = unifiedContentLines.join("\n");

            this.updateActiveToggleState();

            if (this.diffViewMode === "split") {
                this.rightPane.style.display = "";
                this.leftPane.style.borderRight = "";
                this.leftPane.style.width = "";
                this.rightLabel.style.display = "";
                if (this.ratioFab) this.ratioFab.style.display = "";
            } else {
                this.rightPane.style.display = "none";
                this.leftPane.style.borderRight = "none";
                this.leftPane.style.width = "100%";
                this.rightLabel.style.display = "none";
                if (this.ratioFab) this.ratioFab.style.display = "none";
            }

            // 3. Initialize/Refresh Ace Editor Left
            if (!this.leftEditor) {
                this.leftEditor = window.ace.edit(this.leftEditorDiv);
                this.leftEditor.setReadOnly(true);
                this.leftEditor.setShowPrintMargin(false);
                this.leftEditor.renderer.setShowGutter(true);
                
                if (window.editors && !window.editors.includes(this.leftEditor)) {
                    window.editors.push(this.leftEditor);
                }
            }
            this.leftEditor.setTheme(theme);

            const leftContentText = this.diffViewMode === "split" ? originalContent : this.unifiedContentText;
            let leftSession = tab?.config?.leftSession;
            if (!leftSession) {
                leftSession = window.ace.createEditSession(leftContentText);
                if (tab) {
                    tab.config.leftSession = leftSession;
                    if (tab.config.session) {
                        leftSession.setScrollTop(tab.config.session.getScrollTop());
                        leftSession.setScrollLeft(tab.config.session.getScrollLeft());
                    }
                }
            } else {
                if (leftSession.getValue() !== leftContentText) {
                    leftSession.setValue(leftContentText);
                }
            }
            leftSession.setMode(mode);
            this.leftEditor.setSession(leftSession);

            // 4. Initialize/Refresh Ace Editor Right
            if (!this.rightEditor) {
                this.rightEditor = window.ace.edit(this.rightEditorDiv);
                this.rightEditor.setShowPrintMargin(false);
                this.rightEditor.renderer.setShowGutter(true);
                
                if (window.editors && !window.editors.includes(this.rightEditor)) {
                    window.editors.push(this.rightEditor);
                }
            }
            this.rightEditor.setTheme(theme);

            // Remove any old change listeners from the right editor session
            if (this._rightEditorChangeListener && this._attachedSession) {
                this._attachedSession.off("change", this._rightEditorChangeListener);
                this._rightEditorChangeListener = null;
                this._attachedSession = null;
            }

            // Set up sessions & read-only modes based on editing capability
            if (this.diffViewMode === "split") {
                if (isEditable && tab && tab.config?.session) {
                    this.rightEditor.setSession(tab.config.session);
                    this.rightEditor.setReadOnly(false);
                } else {
                    let rightSession = tab?.config?.rightSession;
                    if (!rightSession) {
                        rightSession = window.ace.createEditSession(currentContent);
                        if (tab) tab.config.rightSession = rightSession;
                    } else {
                        if (rightSession.getValue() !== currentContent) {
                            rightSession.setValue(currentContent);
                        }
                    }
                    rightSession.setMode(mode);
                    this.rightEditor.setSession(rightSession);
                    this.rightEditor.setReadOnly(true);
                }
            } else {
                this.rightEditor.setReadOnly(true);
            }

            // Configure diff editors using global options to ensure matched font size, theme, styling, etc.
            const appConfig = window.app || {};
            if (appConfig.sessionOptions) {
                this.leftEditor.session.setOptions(appConfig.sessionOptions);
                this.rightEditor.session.setOptions(appConfig.sessionOptions);
            }
            if (appConfig.rendererOptions) {
                this.leftEditor.renderer.setOptions(appConfig.rendererOptions);
                this.rightEditor.renderer.setOptions(appConfig.rendererOptions);
            }

            // Explicitly sync the modes on both editor sessions
            if (this.leftEditor) {
                this.leftEditor.getSession().setMode(mode);
            }
            if (this.rightEditor) {
                this.rightEditor.getSession().setMode(mode);
            }

            // Sync keymap configuration with the main editor
            const keyboardHandler = window.leftEdit?.getKeyboardHandler() || "ace/keyboard/sublime";
            this.leftEditor.setKeyboardHandler(keyboardHandler);
            this.rightEditor.setKeyboardHandler(keyboardHandler);

            if (!this._keyboardListenersSetup) {
                if (window.leftEdit) {
                    this._leftEditKeyboardListener = (e) => {
                        const handler = e.handler || window.leftEdit.getKeyboardHandler();
                        if (this.leftEditor) this.leftEditor.setKeyboardHandler(handler);
                        if (this.rightEditor) this.rightEditor.setKeyboardHandler(handler);
                    };
                    window.leftEdit.on("changeKeyboardHandler", this._leftEditKeyboardListener);
                }
                if (window.rightEdit) {
                    this._rightEditKeyboardListener = (e) => {
                        const handler = e.handler || window.rightEdit.getKeyboardHandler();
                        if (this.leftEditor) this.leftEditor.setKeyboardHandler(handler);
                        if (this.rightEditor) this.rightEditor.setKeyboardHandler(handler);
                    };
                    window.rightEdit.on("changeKeyboardHandler", this._rightEditKeyboardListener);
                }
                this._keyboardListenersSetup = true;
            }

            // 5. Setup One-time Selection Syncing
            if (!this._selectionSyncSetup && this.leftEditor && this.rightEditor) {
                let isSyncingSelection = false;
                
                const syncSelection = (source, target) => {
                    if (isSyncingSelection) return;
                    if (this.diffViewMode !== "split") return;
                    isSyncingSelection = true;
                    const range = source.selection.getRange();
                    target.selection.setRange(range);
                    isSyncingSelection = false;
                };

                this.leftEditor.selection.on("changeSelection", () => {
                    syncSelection(this.leftEditor, this.rightEditor);
                });

                this.rightEditor.selection.on("changeSelection", () => {
                    syncSelection(this.rightEditor, this.leftEditor);
                });

                this._selectionSyncSetup = true;
            }

            // Bind scroll listeners dynamically to the active sessions
            const activeLeftSession = this.leftEditor.getSession();
            const activeRightSession = this.rightEditor.getSession();

            if (this._leftScrollSession !== activeLeftSession) {
                if (this._leftScrollSession && this._leftScrollTopListener) {
                    this._leftScrollSession.off("changeScrollTop", this._leftScrollTopListener);
                    this._leftScrollSession.off("changeScrollLeft", this._leftScrollLeftListener);
                }
                this._leftScrollTopListener = (scrollTop) => {
                    this.updateEditCount();
                    if (this._isupdating) return;
                    if (this.diffViewMode !== "split") return;
                    const leftMarginTop = this.leftEditor.renderer.scrollMargin.top || 0;
                    const rightMarginTop = this.rightEditor.renderer.scrollMargin.top || 0;
                    const targetScrollTop = scrollTop + leftMarginTop - rightMarginTop;

                    const currentRightScroll = this.rightEditor.getSession().getScrollTop();
                    if (Math.abs(currentRightScroll - targetScrollTop) < 1) return;
                    this.rightEditor.getSession().setScrollTop(targetScrollTop);
                };
                this._leftScrollLeftListener = (scrollLeft) => {
                    if (this._isupdating) return;
                    if (this.diffViewMode !== "split") return;
                    const currentRightScroll = this.rightEditor.getSession().getScrollLeft();
                    if (Math.abs(currentRightScroll - scrollLeft) < 1) return;
                    this.rightEditor.getSession().setScrollLeft(scrollLeft);
                };
                activeLeftSession.on("changeScrollTop", this._leftScrollTopListener);
                activeLeftSession.on("changeScrollLeft", this._leftScrollLeftListener);
                this._leftScrollSession = activeLeftSession;
            }

            if (this._rightScrollSession !== activeRightSession) {
                if (this._rightScrollSession && this._rightScrollTopListener) {
                    this._rightScrollSession.off("changeScrollTop", this._rightScrollTopListener);
                    this._rightScrollSession.off("changeScrollLeft", this._rightScrollLeftListener);
                }
                this._rightScrollTopListener = (scrollTop) => {
                    if (this._isupdating) return;
                    if (this.diffViewMode !== "split") return;
                    const leftMarginTop = this.leftEditor.renderer.scrollMargin.top || 0;
                    const rightMarginTop = this.rightEditor.renderer.scrollMargin.top || 0;
                    const targetScrollTop = scrollTop + rightMarginTop - leftMarginTop;

                    const currentLeftScroll = this.leftEditor.getSession().getScrollTop();
                    if (Math.abs(currentLeftScroll - targetScrollTop) < 1) return;
                    this.leftEditor.getSession().setScrollTop(targetScrollTop);
                };
                this._rightScrollLeftListener = (scrollLeft) => {
                    if (this._isupdating) return;
                    if (this.diffViewMode !== "split") return;
                    const currentLeftScroll = this.leftEditor.getSession().getScrollLeft();
                    if (Math.abs(currentLeftScroll - scrollLeft) < 1) return;
                    this.leftEditor.getSession().setScrollLeft(scrollLeft);
                };
                activeRightSession.on("changeScrollTop", this._rightScrollTopListener);
                activeRightSession.on("changeScrollLeft", this._rightScrollLeftListener);
                this._rightScrollSession = activeRightSession;
            }

            // Register real-time change listener if editable
            if (this.diffViewMode === "split" && isEditable && tab && tab.config?.session) {
                this._attachedSession = tab.config.session;
                let debounceTimeout = null;
                this._rightEditorChangeListener = () => {
                    tab.changed = true;
                    if (debounceTimeout) clearTimeout(debounceTimeout);
                    debounceTimeout = setTimeout(() => {
                        this.refreshDiff();
                    }, 150);
                };
                this._attachedSession.on("change", this._rightEditorChangeListener);
            }

            // Run initial rendering
            this.refreshDiff();

            // Clear previous header buttons dynamically
            this.headerRight.innerHTML = "";

            if (isReloadDiff) {
                // Reload Diff Mode: Render Reload & Dismiss buttons
                const dismissBtn = new Button("Dismiss");
                dismissBtn.className = "cancel";
                dismissBtn.icon = "close";
                dismissBtn.onclick = () => {
                    tab.config.fileModified = false;
                    const isDirty = tab.config.session.getValue() !== tab.config.session.baseValue;
                    tab.changed = isDirty;
                    
                    const side = tab.config.side || 'left';
                    if (window.ui && window.ui.hideFileModifiedNotice) {
                        window.ui.hideFileModifiedNotice(side);
                    }
                    tab.config.viewMode = "edit";
                    tab.click();
                };

                const reloadBtn = new Button("Reload File");
                reloadBtn.className = "apply";
                reloadBtn.icon = "sync";
                reloadBtn.onclick = async () => {
                    if (window.ui && window.ui.reloadFile) {
                        await window.ui.reloadFile(tab);
                    }
                    const side = tab.config.side || 'left';
                    if (window.ui && window.ui.hideFileModifiedNotice) {
                        window.ui.hideFileModifiedNotice(side);
                    }
                    tab.config.viewMode = "edit";
                    tab.click();
                };

                this.headerRight.appendChild(reloadBtn);
                this.headerRight.appendChild(dismissBtn);
            } else if (isForgivenessMode) {
                // Forgiveness Mode: Render Rollback button
                const rollbackBtn = new Button("Rollback Changes");
                rollbackBtn.className = "rollback";
                rollbackBtn.icon = "undo";
                if (backupMissing) {
                    rollbackBtn.disabled = true;
                    rollbackBtn.title = "Backup has expired or is no longer available.";
                }
                
                rollbackBtn.onclick = async () => {
                    const confirmed = await window.modal.confirm(`Are you sure you want to rollback all changes to ${filename}?`, "Rollback Changes");
                    if (!confirmed) return;

                    if (window.ui && window.ui.suppressFileChangeNotice) {
                        window.ui.suppressFileChangeNotice(filePath, 5000);
                    }
                    try {
                        rollbackBtn.disabled = true;
                        rollbackBtn.icon = "<ui-icon class='spinner'>sync</ui-icon>";
                        rollbackBtn.text = "Rolling back...";

                        // Apply rollback
                        if (backupId === "new_file") {
                            const result = await conduitClient.wsDelete(filePath);
                            if (result.error) throw new Error(result.error);

                            // Close target tab if open
                            const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                            const targetTab = allOpenTabs.find(t => pathsMatch(t.config?.path, filePath));
                            if (targetTab) {
                                if (window.closeTab) {
                                    await window.closeTab(targetTab.tabBar, { tab: targetTab }, true);
                                } else {
                                    targetTab.tabBar.remove(targetTab, true);
                                }
                            }
                        } else {
                            const content = await AgentBackup.rollback(backupId);
                            const base64Content = btoa(unescape(encodeURIComponent(content)));
                            const result = await conduitClient.wsWrite(filePath, base64Content);
                            if (result.error) throw new Error(result.error);

                            // Update active editor tab session if open
                            const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                            const targetTab = allOpenTabs.find(t => pathsMatch(t.config?.path, filePath));
                            if (targetTab && targetTab.config.session) {
                                targetTab.config.session.setValue(content);
                                targetTab.config.session.baseValue = content;
                                targetTab.changed = false;
                            }
                        }

                        // Mark as rolled back in the session modifiedFiles state
                        const session = ui.aiManager.activeSession;
                        if (session && session.modifiedFiles) {
                            const matchedKey = Object.keys(session.modifiedFiles).find(k => pathsMatch(k, filePath));
                            if (matchedKey) {
                                session.modifiedFiles[matchedKey] = session.modifiedFiles[matchedKey].filter(b => b.backupId !== backupId);
                                if (session.modifiedFiles[matchedKey].length === 0) {
                                    delete session.modifiedFiles[matchedKey];
                                }
                                await workspaceClient.setSession(session.id, session);
                            }
                        }

                        window.modal.toast(`Successfully rolled back ${filename} to original state.`);

                        if (tab && backupId !== "new_file") {
                            tab.config.viewMode = "edit";
                            tab.click();
                        } else {
                            // Close standalone diff tab if any
                            const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                            const diffTab = allOpenTabs.find(t => t.config?.path === `diff_${backupId}`);
                            if (diffTab) {
                                diffTab.tabBar.remove(diffTab, true);
                            }
                        }

                        // Trigger a redraw of Settings and Artifacts view
                        if (window.ui?.renderPlanTasksView) {
                            const containers = document.querySelectorAll(".plan-tasks-view");
                            containers.forEach(c => window.ui.renderPlanTasksView(c));
                        }
                    } catch (err) {
                        console.error("Rollback failed:", err);
                        window.modal.notice(`Rollback failed:<br><small>${err.message}</small>`, "Rollback Error");
                        rollbackBtn.disabled = false;
                        rollbackBtn.icon = "undo";
                        rollbackBtn.text = "Rollback Changes";
                    } finally {
                        if (window.ui && window.ui.resumeFileChangeNotice) {
                            window.ui.resumeFileChangeNotice(filePath);
                        }
                    }
                };
                const cancelBtn = new Button("Cancel");
                cancelBtn.className = "cancel";
                cancelBtn.icon = "close";
                cancelBtn.onclick = () => {
                    if (tab) {
                        tab.config.viewMode = "edit";
                        tab.click();
                    }
                };
                this.headerRight.appendChild(rollbackBtn);
                this.headerRight.appendChild(cancelBtn);
            } else {
                if (isAIPendingEdits) {
                    // AI Permission Mode: Render Discard & Apply buttons
                    const discardBtn = new Button("Discard");
                    discardBtn.className = "discard";
                    discardBtn.icon = "close";
                    
                    discardBtn.onclick = async () => {
                        const confirmed = await window.modal.confirm(`Are you sure you want to discard all pending changes to ${filename}?`, "Discard Changes");
                        if (!confirmed) return;

                        const activeSession = window.ui?.aiManager?.activeSession;
                        if (activeSession && activeSession.pendingEdits) {
                            const matchedKey = Object.keys(activeSession.pendingEdits).find(k => pathsMatch(k, filePath));
                            if (matchedKey) {
                                delete activeSession.pendingEdits[matchedKey];
                                await workspaceClient.setSession(activeSession.id, activeSession);
                            }
                        }

                        if (tab && tab.config?.session) {
                            tab.config.session.setValue(originalContent);
                            tab.changed = false;
                            tab.config.viewMode = "edit";
                            tab.click();
                        }
                    };

                    const applyBtn = new Button("Apply Changes");
                    applyBtn.className = "apply";
                    applyBtn.icon = "check";
                    
                    applyBtn.onclick = async () => {
                        try {
                            applyBtn.disabled = true;
                            applyBtn.icon = "<ui-icon class='spinner'>sync</ui-icon>";
                            applyBtn.text = "Applying...";

                            if (tab && window.saveFileTab) {
                                await window.saveFileTab(tab);
                                tab.config.session.baseValue = tab.config.session.getValue();
                                tab.changed = false;

                                const activeSession = window.ui?.aiManager?.activeSession;
                                if (activeSession && activeSession.pendingEdits) {
                                    const matchedKey = Object.keys(activeSession.pendingEdits).find(k => pathsMatch(k, filePath));
                                    if (matchedKey) {
                                        delete activeSession.pendingEdits[matchedKey];
                                        await workspaceClient.setSession(activeSession.id, activeSession);
                                    }
                                }

                                tab.config.viewMode = "edit";
                                tab.click();
                                window.modal.toast(`Successfully applied and saved changes to ${filename}.`);
                            }
                        } catch (err) {
                            console.error("Apply changes failed:", err);
                            window.modal.notice(`Apply changes failed:<br><small>${err.message}</small>`, "Apply Error");
                            applyBtn.disabled = false;
                            applyBtn.icon = "check";
                            applyBtn.text = "Apply Changes";
                        }
                    };

                    this.headerRight.appendChild(discardBtn);
                    this.headerRight.appendChild(applyBtn);
                } else {
                    // User Local Edits Mode: Render Save, Keep Editing, and Revert buttons
                    const revertBtn = new Button("Revert");
                    revertBtn.className = "rollback";
                    revertBtn.icon = "undo";
                    revertBtn.onclick = async () => {
                        const confirmed = await window.modal.confirm(`Are you sure you want to revert all unsaved local changes to ${filename}?`, "Revert Changes");
                        if (!confirmed) return;

                        if (tab && tab.config?.session) {
                            tab.config.session.setValue(originalContent);
                            tab.changed = false;
                            tab.config.viewMode = "edit";
                            tab.click();
                        }
                    };

                    const keepEditingBtn = new Button("Cancel");
                    keepEditingBtn.className = "cancel";
                    keepEditingBtn.icon = "close";
                    keepEditingBtn.onclick = () => {
                        if (tab) {
                            tab.config.viewMode = "edit";
                            tab.click();
                        }
                    };

                    const saveBtn = new Button("Save");
                    saveBtn.className = "apply";
                    saveBtn.icon = "save";
                    saveBtn.onclick = async () => {
                        try {
                            saveBtn.disabled = true;
                            saveBtn.icon = "<ui-icon class='spinner'>sync</ui-icon>";
                            saveBtn.text = "Saving...";

                            if (tab && window.saveFileTab) {
                                await window.saveFileTab(tab);
                                tab.config.session.baseValue = tab.config.session.getValue();
                                tab.changed = false;

                                tab.config.viewMode = "edit";
                                tab.click();
                                window.modal.toast(`Successfully saved changes to ${filename}.`);
                            }
                        } catch (err) {
                            console.error("Save changes failed:", err);
                            window.modal.notice(`Save changes failed:<br><small>${err.message}</small>`, "Save Error");
                            saveBtn.disabled = false;
                            saveBtn.icon = "save";
                            saveBtn.text = "Save";
                        }
                    };

                    this.headerRight.appendChild(revertBtn);
                    // this.headerRight.appendChild(saveBtn);
                    this.headerRight.appendChild(keepEditingBtn);
                }
            }
        } catch (err) {
            this._isupdating = false;
            console.error("Error loading diff view:", err);
            window.modal.notice(`Error loading diff view:<br><small>${err.message}</small>`, "Diff Loading Error");
        }
    }

    disconnectedCallback() {
        if (this._rightEditorChangeListener && this._attachedSession) {
            this._attachedSession.off("change", this._rightEditorChangeListener);
            this._rightEditorChangeListener = null;
            this._attachedSession = null;
        }
        if (this._leftEditKeyboardListener && window.leftEdit) {
            window.leftEdit.off("changeKeyboardHandler", this._leftEditKeyboardListener);
            this._leftEditKeyboardListener = null;
        }
        if (this._rightEditKeyboardListener && window.rightEdit) {
            window.rightEdit.off("changeKeyboardHandler", this._rightEditKeyboardListener);
            this._rightEditKeyboardListener = null;
        }
        this._keyboardListenersSetup = false;

        if (this._leftScrollSession) {
            if (this._leftScrollTopListener) this._leftScrollSession.off("changeScrollTop", this._leftScrollTopListener);
            if (this._leftScrollLeftListener) this._leftScrollSession.off("changeScrollLeft", this._leftScrollLeftListener);
            this._leftScrollSession = null;
        }
        if (this._rightScrollSession) {
            if (this._rightScrollTopListener) this._rightScrollSession.off("changeScrollTop", this._rightScrollTopListener);
            if (this._rightScrollLeftListener) this._rightScrollSession.off("changeScrollLeft", this._rightScrollLeftListener);
            this._rightScrollSession = null;
        }

        const cleanWidgets = (editor) => {
            if (editor) {
                if (editor.session.widgetManager) {
                    editor.session.widgetManager.detach();
                    editor.session.widgetManager = null;
                }
                editor.session.lineWidgets = [];
            }
        };
        cleanWidgets(this.leftEditor);
        cleanWidgets(this.rightEditor);
    }

    refreshDiff() {
        if (!this.leftEditor || !this.rightEditor) return;

        const wasUpdating = this._isupdating;
        this._isupdating = true;

        const originalContent = this.originalContent || "";
        let currentContent = "";
        if (this.diffViewMode === "split") {
            currentContent = this.rightEditor.getValue();
        } else {
            currentContent = "";
        }

        const origLines = originalContent.split(/\r?\n/);
        const currLines = currentContent.split(/\r?\n/);
        
        // Run LCS line diffing algorithm
        const diff = this.diffViewMode === "split" 
            ? diffLines(origLines, currLines)
            : this.activeDiff;

        // Calculate line counters for additions/deletions
        let addedCount = 0;
        let deletedCount = 0;
        diff.forEach(item => {
            if (item.type === 'delete') {
                deletedCount++;
            } else if (item.type === 'add') {
                addedCount++;
            }
        });

        // Update labels
        const leftLabelText = this.leftLabelText || "";
        const rightLabelText = this.rightLabelText || "";

        if (this.diffViewMode === "split") {
            if (deletedCount > 0) {
                this.leftLabel.innerHTML = `<span>${leftLabelText}</span><span class="diff-counter diff-counter-delete">-${deletedCount}</span>`;
            } else {
                this.leftLabel.innerHTML = `<span>${leftLabelText}</span>`;
            }

            if (addedCount > 0) {
                this.rightLabel.innerHTML = `<span>${rightLabelText}</span><span class="diff-counter diff-counter-add">+${addedCount}</span>`;
            } else {
                this.rightLabel.innerHTML = `<span>${rightLabelText}</span>`;
            }
        } else {
            let labelHtml = `<span>Unified Diff</span>`;
            if (deletedCount > 0 || addedCount > 0) {
                labelHtml += ` <span style="display:inline-flex; gap: 4px; margin-left: 8px;">`;
                if (deletedCount > 0) {
                    labelHtml += `<span class="diff-counter diff-counter-delete">-${deletedCount}</span>`;
                }
                if (addedCount > 0) {
                    labelHtml += `<span class="diff-counter diff-counter-add">+${addedCount}</span>`;
                }
                labelHtml += `</span>`;
            }
            this.leftLabel.innerHTML = labelHtml;
        }

        const deletedRows = [];
        const addedRows = [];

        if (this.diffViewMode === "split") {
            diff.forEach((item) => {
                if (item.type === 'delete') {
                    deletedRows.push(item.leftIndex);
                } else if (item.type === 'add') {
                    addedRows.push(item.rightIndex);
                }
            });
        } else {
            (this.deletedRowsUnified || []).forEach(r => deletedRows.push(r));
            (this.addedRowsUnified || []).forEach(r => addedRows.push(r));
        }

        // Clean up existing widgets without detaching the widget manager
        const cleanWidgets = (editor) => {
            if (editor && editor.session.widgetManager) {
                const session = editor.getSession();
                const widgets = session.lineWidgets;
                if (widgets) {
                    const toRemove = [];
                    widgets.forEach(w => {
                        if (w) toRemove.push(w);
                    });
                    toRemove.forEach(w => {
                        editor.session.widgetManager.removeLineWidget(w);
                    });
                }
            }
        };
        cleanWidgets(this.leftEditor);
        cleanWidgets(this.rightEditor);

        // Reset scroll margins
        if (this.leftEditor) {
            this.leftEditor.renderer.scrollMargin.top = 0;
        }
        if (this.rightEditor) {
            this.rightEditor.renderer.scrollMargin.top = 0;
        }

        // Set up LineWidgets for split view
        if (this.diffViewMode === "split") {
            const LineWidgets = window.ace.require("ace/line_widgets").LineWidgets;
            
            if (!this.leftEditor.session.widgetManager) {
                const session = this.leftEditor.getSession();
                session.widgetManager = new LineWidgets(session);
                session.widgetManager.attach(this.leftEditor);
            }
            if (!this.rightEditor.session.widgetManager) {
                const session = this.rightEditor.getSession();
                session.widgetManager = new LineWidgets(session);
                session.widgetManager.attach(this.rightEditor);
            }

            // Group consecutive edits into alignment blocks
            const alignmentBlocks = [];
            let currentAlignmentBlock = null;
            let lastKeepLeftIndex = -1;
            let lastKeepRightIndex = -1;

            diff.forEach((item) => {
                if (item.type === 'keep') {
                    lastKeepLeftIndex = item.leftIndex;
                    lastKeepRightIndex = item.rightIndex;
                    if (currentAlignmentBlock) {
                        alignmentBlocks.push(currentAlignmentBlock);
                        currentAlignmentBlock = null;
                    }
                } else {
                    if (!currentAlignmentBlock) {
                        currentAlignmentBlock = {
                            deletes: 0,
                            adds: 0,
                            lastKeepLeftIndex: lastKeepLeftIndex,
                            lastKeepRightIndex: lastKeepRightIndex,
                        };
                    }
                    if (item.type === 'delete') {
                        currentAlignmentBlock.deletes++;
                    } else if (item.type === 'add') {
                        currentAlignmentBlock.adds++;
                    }
                }
            });
            if (currentAlignmentBlock) {
                alignmentBlocks.push(currentAlignmentBlock);
            }

            // Add visual line widgets / scrollMargin spacers
            const lineHeight = (this.leftEditor.renderer.layerConfig && this.leftEditor.renderer.layerConfig.lineHeight) || this.leftEditor.renderer.lineHeight || 18;

            alignmentBlocks.forEach((block) => {
                if (block.deletes > block.adds) {
                    const diffCount = block.deletes - block.adds;
                    if (block.lastKeepRightIndex === -1) {
                        this.rightEditor.renderer.scrollMargin.top = diffCount * lineHeight;
                    } else {
                        const spacerEl = document.createElement("div");
                        spacerEl.className = "diff-line-spacer";
                        spacerEl.style.height = `${diffCount * lineHeight}px`;
                        
                        this.rightEditor.session.widgetManager.addLineWidget({
                            row: block.lastKeepRightIndex,
                            rowCount: diffCount,
                            el: spacerEl,
                            coverLine: false
                        });
                    }
                } else if (block.adds > block.deletes) {
                    const diffCount = block.adds - block.deletes;
                    if (block.lastKeepLeftIndex === -1) {
                        this.leftEditor.renderer.scrollMargin.top = diffCount * lineHeight;
                    } else {
                        const spacerEl = document.createElement("div");
                        spacerEl.className = "diff-line-spacer";
                        spacerEl.style.height = `${diffCount * lineHeight}px`;
                        
                        this.leftEditor.session.widgetManager.addLineWidget({
                            row: block.lastKeepLeftIndex,
                            rowCount: diffCount,
                            el: spacerEl,
                            coverLine: false
                        });
                    }
                }
            });
        }

        // Clear old markers
        if (this.leftMarkers) {
            this.leftMarkers.forEach(id => this.leftEditor.getSession().removeMarker(id));
        }
        clearGutterDecorations(this.leftEditor.getSession());
        this.leftMarkers = [];

        if (this.rightMarkers) {
            this.rightMarkers.forEach(id => this.rightEditor.getSession().removeMarker(id));
        }
        clearGutterDecorations(this.rightEditor.getSession());
        this.rightMarkers = [];

        // Add new markers and gutter decorations
        const Range = (window.ace.require ? window.ace.require("ace/range").Range : null) || window.ace.Range;
        const sessionLeft = this.leftEditor.getSession();
        const sessionRight = this.rightEditor.getSession();

        if (this.diffViewMode === "split") {
            deletedRows.forEach(row => {
                if (Range) {
                    const range = new Range(row, 0, row, Number.MAX_VALUE);
                    const markerId = sessionLeft.addMarker(range, "diff-marker-deletion", "fullLine");
                    this.leftMarkers.push(markerId);
                }
                sessionLeft.addGutterDecoration(row, "diff-gutter-deletion");
            });

            addedRows.forEach(row => {
                if (Range) {
                    const range = new Range(row, 0, row, Number.MAX_VALUE);
                    const markerId = sessionRight.addMarker(range, "diff-marker-addition", "fullLine");
                    this.rightMarkers.push(markerId);
                }
                sessionRight.addGutterDecoration(row, "diff-gutter-addition");
            });
        } else {
            deletedRows.forEach(row => {
                if (Range) {
                    const range = new Range(row, 0, row, Number.MAX_VALUE);
                    const markerId = sessionLeft.addMarker(range, "diff-marker-deletion", "fullLine");
                    this.leftMarkers.push(markerId);
                }
                sessionLeft.addGutterDecoration(row, "diff-gutter-deletion");
            });

            addedRows.forEach(row => {
                if (Range) {
                    const range = new Range(row, 0, row, Number.MAX_VALUE);
                    const markerId = sessionLeft.addMarker(range, "diff-marker-addition", "fullLine");
                    this.leftMarkers.push(markerId);
                }
                sessionLeft.addGutterDecoration(row, "diff-gutter-addition");
            });
        }

        // Calculate contiguous modified blocks for prev/next jump navigation
        const changeBlocks = [];
        let currentBlock = null;
        let lastLeftIndex = 0;

        diff.forEach((item) => {
            if (item.leftIndex !== null) {
                lastLeftIndex = item.leftIndex;
            }
            const isChange = (item.type === 'delete' || item.type === 'add');
            if (isChange) {
                const rowVal = item.leftIndex !== null ? item.leftIndex : lastLeftIndex;
                if (!currentBlock) {
                    currentBlock = { start: rowVal, end: rowVal };
                } else {
                    currentBlock.end = rowVal;
                }
            } else {
                if (currentBlock) {
                    changeBlocks.push(currentBlock);
                    currentBlock = null;
                }
            }
        });
        if (currentBlock) {
            changeBlocks.push(currentBlock);
        }

        this.changeBlocks = changeBlocks;
        this.updateEditCount();

        if (changeBlocks.length > 0) {
            this.navContainer.classList.add("visible");
        } else {
            this.navContainer.classList.remove("visible");
        }

        // Trigger a deferred resize to ensure correct rendering and scroll behavior
        // Align right editor's scroll to left editor's scroll immediately to avoid alignment flicker
        if (this.diffViewMode === "split" && this.leftEditor && this.rightEditor) {
            const leftMarginTop = this.leftEditor.renderer.scrollMargin.top || 0;
            const rightMarginTop = this.rightEditor.renderer.scrollMargin.top || 0;
            this.rightEditor.getSession().setScrollTop(this.leftEditor.getSession().getScrollTop() + leftMarginTop - rightMarginTop);
            this.rightEditor.getSession().setScrollLeft(this.leftEditor.getSession().getScrollLeft());
        }

        // Trigger a deferred resize to ensure correct rendering and scroll behavior
        setTimeout(() => {
            if (this.leftEditor) {
                this.leftEditor.resize();
                this.leftEditor.renderer.updateFull(true);
                if (this.diffViewMode === "split") {
                    drawScrollbarMarkers(this.leftEditor, deletedRows, "rgba(248, 81, 73, 0.85)");
                } else {
                    drawUnifiedScrollbarMarkers(this.leftEditor, deletedRows, addedRows);
                }
            }
            if (this.rightEditor) {
                this.rightEditor.resize();
                this.rightEditor.renderer.updateFull(true);
                if (this.diffViewMode === "split") {
                    drawScrollbarMarkers(this.rightEditor, addedRows, "rgba(46, 160, 67, 0.85)");
                } else {
                    const overlay = this.rightEditor.container.querySelector(".diff-scrollbar-marker-overlay");
                    if (overlay) overlay.remove();
                }
            }

            // Restore updating flag
            this._isupdating = wasUpdating;

            if (this.diffViewMode === "split" && this.leftEditor && this.rightEditor) {
                const leftMarginTop = this.leftEditor.renderer.scrollMargin.top || 0;
                const rightMarginTop = this.rightEditor.renderer.scrollMargin.top || 0;
                this.rightEditor.getSession().setScrollTop(this.leftEditor.getSession().getScrollTop() + leftMarginTop - rightMarginTop);
                this.rightEditor.getSession().setScrollLeft(this.leftEditor.getSession().getScrollLeft());
            }

            // Safety check to ensure we are not locked in updating state
            this._isupdating = false;
        }, 50);
    }

    updateEditCount() {
        if (!this.editCountSpan || !this.changeBlocks || this.changeBlocks.length === 0) {
            if (this.editCountSpan) this.editCountSpan.textContent = "0/0";
            return;
        }
        if (!this.leftEditor) return;
        
        const firstRow = this.leftEditor.getFirstVisibleRow();
        const lastRow = this.leftEditor.getLastVisibleRow();
        const centerRow = firstRow + Math.floor((lastRow - firstRow) / 2);
        
        let minDiff = Infinity;
        let activeIdx = 0;
        for (let i = 0; i < this.changeBlocks.length; i++) {
            const block = this.changeBlocks[i];
            let diff = 0;
            if (centerRow < block.start) {
                diff = block.start - centerRow;
            } else if (centerRow > block.end) {
                diff = centerRow - block.end;
            } else {
                diff = 0;
            }
            if (diff < minDiff) {
                minDiff = diff;
                activeIdx = i;
            }
        }
        this.editCountSpan.textContent = `${activeIdx + 1}/${this.changeBlocks.length}`;
    }
}

customElements.define("ui-diff-view-panel", DiffViewPanel);

/**
 * An optimized Longest Common Subsequence (LCS) based line diffing algorithm.
 * Trims common prefix/suffix first to run in microsecond timescales for most files.
 */
function diffLines(orig, curr) {
    let start = 0;
    while (start < orig.length && start < curr.length && orig[start] === curr[start]) {
        start++;
    }
    
    let endOrig = orig.length - 1;
    let endCurr = curr.length - 1;
    while (endOrig >= start && endCurr >= start && orig[endOrig] === curr[endCurr]) {
        endOrig--;
        endCurr--;
    }
    
    const diff = [];
    // Prefix kept lines
    for (let i = 0; i < start; i++) {
        diff.push({ type: 'keep', leftLine: orig[i], rightLine: curr[i], leftIndex: i, rightIndex: i });
    }
    
    // Sub-segment to diff
    const subOrig = orig.slice(start, endOrig + 1);
    const subCurr = curr.slice(start, endCurr + 1);
    
    if (subOrig.length > 0 || subCurr.length > 0) {
        const N = subOrig.length;
        const M = subCurr.length;
        const dp = Array.from({ length: N + 1 }, () => new Int32Array(M + 1));
        
        for (let i = 1; i <= N; i++) {
            for (let j = 1; j <= M; j++) {
                if (subOrig[i - 1] === subCurr[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        
        let i = N;
        let j = M;
        const subDiff = [];
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && subOrig[i - 1] === subCurr[j - 1]) {
                subDiff.push({
                    type: 'keep',
                    leftLine: subOrig[i - 1],
                    rightLine: subCurr[j - 1],
                    leftIndex: start + i - 1,
                    rightIndex: start + j - 1
                });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                subDiff.push({
                    type: 'add',
                    leftLine: null,
                    rightLine: subCurr[j - 1],
                    leftIndex: null,
                    rightIndex: start + j - 1
                });
                j--;
            } else {
                subDiff.push({
                    type: 'delete',
                    leftLine: subOrig[i - 1],
                    rightLine: null,
                    leftIndex: start + i - 1,
                    rightIndex: null
                });
                i--;
            }
        }
        diff.push(...subDiff.reverse());
    }
    
    // Suffix kept lines
    for (let i = endOrig + 1; i < orig.length; i++) {
        const j = endCurr + 1 + (i - (endOrig + 1));
        diff.push({ type: 'keep', leftLine: orig[i], rightLine: curr[j], leftIndex: i, rightIndex: j });
    }
    
    return diff;
}

/**
 * Draws visual diff markers on top of the Ace editor's vertical scrollbar.
 */
function drawScrollbarMarkers(editor, rows, color) {
    const scrollbarEl = editor.container.querySelector(".ace_scrollbar-v");
    if (!scrollbarEl) return;

    let overlay = editor.container.querySelector(".diff-scrollbar-marker-overlay");
    if (overlay) {
        overlay.remove();
    }

    if (rows.length === 0) return;

    overlay = document.createElement("div");
    overlay.className = "diff-scrollbar-marker-overlay";
    overlay.style.display = scrollbarEl.style.display === 'none' ? 'none' : 'block';

    const totalRows = editor.getSession().getLength();
    if (totalRows <= 0) return;

    rows.forEach(row => {
        const marker = document.createElement("div");
        marker.className = "diff-scrollbar-marker";
        marker.style.top = `${(row / totalRows) * 100}%`;
        marker.style.backgroundColor = color;
        overlay.appendChild(marker);
    });

    editor.container.appendChild(overlay);
}

/**
 * Draws visual diff markers for both additions and deletions on top of the Ace editor's vertical scrollbar.
 */
function drawUnifiedScrollbarMarkers(editor, deletedRows, addedRows) {
    const scrollbarEl = editor.container.querySelector(".ace_scrollbar-v");
    if (!scrollbarEl) return;

    let overlay = editor.container.querySelector(".diff-scrollbar-marker-overlay");
    if (overlay) {
        overlay.remove();
    }

    if (deletedRows.length === 0 && addedRows.length === 0) return;

    overlay = document.createElement("div");
    overlay.className = "diff-scrollbar-marker-overlay";
    overlay.style.display = scrollbarEl.style.display === 'none' ? 'none' : 'block';

    const totalRows = editor.getSession().getLength();
    if (totalRows <= 0) return;

    deletedRows.forEach(row => {
        const marker = document.createElement("div");
        marker.className = "diff-scrollbar-marker";
        marker.style.top = `${(row / totalRows) * 100}%`;
        marker.style.backgroundColor = "rgba(248, 81, 73, 0.85)";
        overlay.appendChild(marker);
    });

    addedRows.forEach(row => {
        const marker = document.createElement("div");
        marker.className = "diff-scrollbar-marker";
        marker.style.top = `${(row / totalRows) * 100}%`;
        marker.style.backgroundColor = "rgba(46, 160, 67, 0.85)";
        overlay.appendChild(marker);
    });

    editor.container.appendChild(overlay);
}

/**
 * Clears old diff gutter decorations from an Ace editor session.
 */
function clearGutterDecorations(session) {
    if (!session) return;
    const len = session.getLength();
    for (let i = 0; i < len; i++) {
        session.removeGutterDecoration(i, "diff-gutter-deletion");
        session.removeGutterDecoration(i, "diff-gutter-addition");
        session.removeGutterDecoration(i, "diff-gutter-empty");
    }
}