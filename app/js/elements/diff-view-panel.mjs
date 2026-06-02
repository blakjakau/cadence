import { Block } from './element.mjs';
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

        // Jump to nearest edits navigation buttons
        this.navContainer = document.createElement("div");
        this.navContainer.className = "diff-header-nav";
        this.navContainer.style.display = "none";

        this.prevBtn = document.createElement("button");
        this.prevBtn.className = "nav-btn";
        this.prevBtn.innerHTML = "<ui-icon>chevron_left</ui-icon>";
        this.prevBtn.title = "Previous Edit";

        this.nextBtn = document.createElement("button");
        this.nextBtn.className = "nav-btn";
        this.nextBtn.innerHTML = "<ui-icon>chevron_right</ui-icon>";
        this.nextBtn.title = "Next Edit";

        this.navContainer.appendChild(this.prevBtn);
        this.navContainer.appendChild(this.nextBtn);
        headerLeft.appendChild(this.navContainer);

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
        this.activeBackupId = backupId;
        this.activeFilePath = filePath;

        const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
        const pathsMatch = (p1, p2) => {
            const n1 = normalize(p1);
            const n2 = normalize(p2);
            if (!n1 || !n2) return false;
            return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
        };

        const filename = filePath.split('/').pop();
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
            let originalContent = "";
            let currentContent = "";
            
            const { default: AgentBackup } = await import('../agent/agent-backup.mjs');

            if (isReloadDiff) {
                // Reload Diff Mode: Original is current editor content, Current is new content from disk
                if (tab && tab.config?.session) {
                    originalContent = tab.config.session.getValue();
                } else {
                    originalContent = "";
                }

                const fileData = await conduitClient.wsRead(filePath);
                if (fileData.error) throw new Error(fileData.error);
                currentContent = decodeURIComponent(escape(atob(fileData.data)));
            } else if (isForgivenessMode) {
                // Forgiveness Mode: Original is from backup, Current is in-memory/on-disk
                originalContent = await AgentBackup.rollback(backupId);

                if (tab && tab.config?.session) {
                    currentContent = tab.config.session.getValue();
                } else {
                    const fileData = await conduitClient.wsRead(filePath);
                    if (fileData.error) throw new Error(fileData.error);
                    currentContent = decodeURIComponent(escape(atob(fileData.data)));
                }
            } else {
                // Permission Mode / User Edits: Original is on-disk, Current is dirty/in-memory
                const fileData = await conduitClient.wsRead(filePath);
                if (fileData.error) throw new Error(fileData.error);
                originalContent = decodeURIComponent(escape(atob(fileData.data)));

                if (tab && tab.config?.session) {
                    currentContent = tab.config.session.getValue();
                } else {
                    currentContent = originalContent; // Fallback
                }
            }

            // Determine Ace mode based on filename extension
            let mode = "ace/mode/text";
            for (let n in window.ace_modes) {
                const m = window.ace_modes[n];
                if (filename.match(m.extRe)) {
                    mode = m.mode;
                    break;
                }
            }

            const theme = window.leftEdit?.renderer?.getTheme() || "ace/theme/tomorrow_night";

            // Split contents into lines
            const origLines = originalContent.split(/\r?\n/);
            const currLines = currentContent.split(/\r?\n/);

            // Run LCS line diffing algorithm
            const diff = diffLines(origLines, currLines);

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

            let leftLabelText = "";
            let rightLabelText = "";

            if (isReloadDiff) {
                leftLabelText = "Current Editor Content";
                rightLabelText = "New Content on Disk";
            } else if (isForgivenessMode) {
                leftLabelText = "Original (Backup)";
                rightLabelText = "Modified (Current)";
            } else {
                leftLabelText = "Original (On Disk)";
                rightLabelText = "Modified (Current)";
            }

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

            // Build aligned padded text contents
            const leftContentLines = [];
            const rightContentLines = [];

            diff.forEach(item => {
                if (item.type === 'keep') {
                    leftContentLines.push(item.leftLine);
                    rightContentLines.push(item.rightLine);
                } else if (item.type === 'delete') {
                    leftContentLines.push(item.leftLine);
                    rightContentLines.push(""); // Pad right with empty line
                } else if (item.type === 'add') {
                    leftContentLines.push(""); // Pad left with empty line
                    rightContentLines.push(item.rightLine);
                }
            });

            const leftContentText = leftContentLines.join("\n");
            const rightContentText = rightContentLines.join("\n");

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
            this.leftEditor.getSession().setMode(mode);
            this.leftEditor.setValue(leftContentText, -1);

            // 4. Initialize/Refresh Ace Editor Right
            if (!this.rightEditor) {
                this.rightEditor = window.ace.edit(this.rightEditorDiv);
                this.rightEditor.setReadOnly(true);
                this.rightEditor.setShowPrintMargin(false);
                this.rightEditor.renderer.setShowGutter(true);
                
                if (window.editors && !window.editors.includes(this.rightEditor)) {
                    window.editors.push(this.rightEditor);
                }
            }
            this.rightEditor.setTheme(theme);
            this.rightEditor.getSession().setMode(mode);
            this.rightEditor.setValue(rightContentText, -1);

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

            // 5. Setup One-time Selection Syncing
            if (!this._selectionSyncSetup && this.leftEditor && this.rightEditor) {
                let isSyncingSelection = false;
                
                const syncSelection = (source, target) => {
                    if (isSyncingSelection) return;
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

            const deletedRows = [];
            const addedRows = [];

            diff.forEach((item, row) => {
                if (item.type === 'delete') {
                    deletedRows.push(row);
                    // Left editor: highlight line red
                    if (Range) {
                        const range = new Range(row, 0, row, Number.MAX_VALUE);
                        const markerId = sessionLeft.addMarker(range, "diff-marker-deletion", "fullLine");
                        this.leftMarkers.push(markerId);
                    }
                    sessionLeft.addGutterDecoration(row, "diff-gutter-deletion");
                    
                    // Right editor: highlight padded blank line as empty
                    if (Range) {
                        const rangeEmpty = new Range(row, 0, row, Number.MAX_VALUE);
                        const markerEmptyId = sessionRight.addMarker(rangeEmpty, "diff-marker-empty", "fullLine");
                        this.rightMarkers.push(markerEmptyId);
                    }
                    sessionRight.addGutterDecoration(row, "diff-gutter-empty");
                } else if (item.type === 'add') {
                    addedRows.push(row);
                    // Left editor: highlight padded blank line as empty
                    if (Range) {
                        const rangeEmpty = new Range(row, 0, row, Number.MAX_VALUE);
                        const markerEmptyId = sessionLeft.addMarker(rangeEmpty, "diff-marker-empty", "fullLine");
                        this.leftMarkers.push(markerEmptyId);
                    }
                    sessionLeft.addGutterDecoration(row, "diff-gutter-empty");
                    
                    // Right editor: highlight line green
                    if (Range) {
                        const range = new Range(row, 0, row, Number.MAX_VALUE);
                        const markerId = sessionRight.addMarker(range, "diff-marker-addition", "fullLine");
                        this.rightMarkers.push(markerId);
                    }
                    sessionRight.addGutterDecoration(row, "diff-gutter-addition");
                }
            });

            // Synchronize scrolling with value-based delta thresholds to prevent asynchronous feedback loops
            // this.leftEditor.getSession().removeAllListeners('changeScrollTop');
            // this.rightEditor.getSession().removeAllListeners('changeScrollTop');
            // this.leftEditor.getSession().removeAllListeners('changeScrollLeft');
            // this.rightEditor.getSession().removeAllListeners('changeScrollLeft');

            this.leftEditor.getSession().on('changeScrollTop', (scrollTop) => {
                const currentRightScroll = this.rightEditor.getSession().getScrollTop();
                if (Math.abs(currentRightScroll - scrollTop) < 1) return;
                this.rightEditor.getSession().setScrollTop(scrollTop);
            });

            this.rightEditor.getSession().on('changeScrollTop', (scrollTop) => {
                const currentLeftScroll = this.leftEditor.getSession().getScrollTop();
                if (Math.abs(currentLeftScroll - scrollTop) < 1) return;
                this.leftEditor.getSession().setScrollTop(scrollTop);
            });

            this.leftEditor.getSession().on('changeScrollLeft', (scrollLeft) => {
                const currentRightScroll = this.rightEditor.getSession().getScrollLeft();
                if (Math.abs(currentRightScroll - scrollLeft) < 1) return;
                this.rightEditor.getSession().setScrollLeft(scrollLeft);
            });

            this.rightEditor.getSession().on('changeScrollLeft', (scrollLeft) => {
                const currentLeftScroll = this.leftEditor.getSession().getScrollLeft();
                if (Math.abs(currentLeftScroll - scrollLeft) < 1) return;
                this.leftEditor.getSession().setScrollLeft(scrollLeft);
            });

            // Calculate contiguous modified blocks for prev/next jump navigation
            const changeBlocks = [];
            let currentBlock = null;

            diff.forEach((item, row) => {
                const isChange = (item.type === 'delete' || item.type === 'add');
                if (isChange) {
                    if (!currentBlock) {
                        currentBlock = { start: row, end: row };
                    } else {
                        currentBlock.end = row;
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

            if (changeBlocks.length > 0) {
                this.navContainer.style.display = "flex";

                const getNearestBlockIndex = (direction) => {
                    if (changeBlocks.length === 0) return -1;
                    const topRow = this.leftEditor.getFirstVisibleRow();
                    const targetRow = topRow + 5;
                    
                    if (direction === 'next') {
                        for (let i = 0; i < changeBlocks.length; i++) {
                            if (changeBlocks[i].start > targetRow + 1) {
                                return i;
                            }
                        }
                        return 0; // Wrap around to first
                    } else {
                        for (let i = changeBlocks.length - 1; i >= 0; i--) {
                            if (changeBlocks[i].start < targetRow - 1) {
                                return i;
                            }
                        }
                        return changeBlocks.length - 1; // Wrap around to last
                    }
                };

                const jumpToBlock = (index) => {
                    if (changeBlocks.length === 0 || index < 0 || index >= changeBlocks.length) return;
                    const block = changeBlocks[index];
                    const targetRow = Math.max(0, block.start - 5);
                    this.leftEditor.scrollToRow(targetRow);
                    this.rightEditor.scrollToRow(targetRow);
                };

                this.prevBtn.onclick = (e) => {
                    e.stopPropagation();
                    const idx = getNearestBlockIndex('prev');
                    if (idx !== -1) {
                        jumpToBlock(idx);
                    }
                };

                this.nextBtn.onclick = (e) => {
                    e.stopPropagation();
                    const idx = getNearestBlockIndex('next');
                    if (idx !== -1) {
                        jumpToBlock(idx);
                    }
                };
            } else {
                this.navContainer.style.display = "none";
            }

            // Trigger a deferred resize to ensure correct rendering and scroll behavior
            setTimeout(() => {
                if (this.leftEditor) {
                    this.leftEditor.resize();
                    drawScrollbarMarkers(this.leftEditor, deletedRows, "rgba(248, 81, 73, 0.85)");
                }
                if (this.rightEditor) {
                    this.rightEditor.resize();
                    drawScrollbarMarkers(this.rightEditor, addedRows, "rgba(46, 160, 67, 0.85)");
                }
            }, 50);

            // Clear previous header buttons dynamically
            this.headerRight.innerHTML = "";

            if (isReloadDiff) {
                // Reload Diff Mode: Render Reload & Dismiss buttons
                const dismissBtn = document.createElement("button");
                dismissBtn.className = "cancel";
                dismissBtn.innerHTML = "<ui-icon>close</ui-icon><span>Dismiss</span>";
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

                const reloadBtn = document.createElement("button");
                reloadBtn.className = "apply";
                reloadBtn.innerHTML = "<ui-icon>sync</ui-icon><span>Reload File</span>";
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
                const rollbackBtn = document.createElement("button");
                rollbackBtn.className = "rollback";
                rollbackBtn.innerHTML = "<ui-icon>undo</ui-icon><span>Rollback Changes</span>";
                
                rollbackBtn.onclick = async () => {
                    const confirmed = await window.modal.confirm(`Are you sure you want to rollback all changes to ${filename}?`, "Rollback Changes");
                    if (!confirmed) return;

                    try {
                        rollbackBtn.disabled = true;
                        rollbackBtn.innerHTML = "<ui-icon class='spinner'>sync</ui-icon><span>Rolling back...</span>";

                        // Apply rollback
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

                        if (tab) {
                            tab.config.viewMode = "edit";
                            tab.click();
                        } else {
                            // Close standalone diff tab if any
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
                        rollbackBtn.innerHTML = "<ui-icon>undo</ui-icon><span>Rollback Changes</span>";
                    }
                };
                const cancelBtn = document.createElement("button");
                cancelBtn.className = "cancel";
                cancelBtn.innerHTML = "<ui-icon>close</ui-icon><span>Cancel</span>";
                cancelBtn.onclick = () => {
                    if (tab) {
                        tab.config.viewMode = "edit";
                        tab.click();
                    }
                };
                this.headerRight.appendChild(rollbackBtn);
                this.headerRight.appendChild(cancelBtn);
            } else {
                // Determine if this is an AI-driven pending edit (Permission Mode) or a standard User manual edit
                const isAIPendingEdits = (() => {
                    const activeSession = window.ui?.aiManager?.activeSession;
                    if (activeSession && activeSession.pendingEdits) {
                        return !!Object.keys(activeSession.pendingEdits).find(k => pathsMatch(k, filePath));
                    }
                    return false;
                })();

                if (isAIPendingEdits) {
                    // AI Permission Mode: Render Discard & Apply buttons
                    const discardBtn = document.createElement("button");
                    discardBtn.className = "discard";
                    discardBtn.innerHTML = "<ui-icon>close</ui-icon><span>Discard</span>";
                    
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

                    const applyBtn = document.createElement("button");
                    applyBtn.className = "apply";
                    applyBtn.innerHTML = "<ui-icon>check</ui-icon><span>Apply Changes</span>";
                    
                    applyBtn.onclick = async () => {
                        try {
                            applyBtn.disabled = true;
                            applyBtn.innerHTML = "<ui-icon class='spinner'>sync</ui-icon><span>Applying...</span>";

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
                            applyBtn.innerHTML = "<ui-icon>check</ui-icon><span>Apply Changes</span>";
                        }
                    };

                    this.headerRight.appendChild(discardBtn);
                    this.headerRight.appendChild(applyBtn);
                } else {
                    // User Local Edits Mode: Render Save, Keep Editing, and Revert buttons
                    const revertBtn = document.createElement("button");
                    revertBtn.className = "cancel";
                    revertBtn.innerHTML = "<ui-icon>undo</ui-icon><span>Revert</span>";
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

                    const keepEditingBtn = document.createElement("button");
                    keepEditingBtn.className = "cancel";
                    keepEditingBtn.innerHTML = "<ui-icon>edit</ui-icon><span>Keep Editing</span>";
                    keepEditingBtn.onclick = () => {
                        if (tab) {
                            tab.config.viewMode = "edit";
                            tab.click();
                        }
                    };

                    const saveBtn = document.createElement("button");
                    saveBtn.className = "apply";
                    saveBtn.innerHTML = "<ui-icon>save</ui-icon><span>Save</span>";
                    saveBtn.onclick = async () => {
                        try {
                            saveBtn.disabled = true;
                            saveBtn.innerHTML = "<ui-icon class='spinner'>sync</ui-icon><span>Saving...</span>";

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
                            saveBtn.innerHTML = "<ui-icon>save</ui-icon><span>Save</span>";
                        }
                    };

                    this.headerRight.appendChild(saveBtn);
                    this.headerRight.appendChild(keepEditingBtn);
                    this.headerRight.appendChild(revertBtn);
                }
            }
        } catch (err) {
            console.error("Error loading diff view:", err);
            window.modal.notice(`Error loading diff view:<br><small>${err.message}</small>`, "Diff Loading Error");
        }
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