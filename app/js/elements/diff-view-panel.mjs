import { Block } from './element.mjs';
import conduitClient from '../conduit-client.mjs';
import workspaceClient from '../workspace-client.mjs';

export class DiffViewPanel extends Block {
    constructor() {
        super();
        this.style.cssText = "display: flex; flex-direction: column; position: absolute; top: var(--tabHeight); left: 0; right: 0; bottom: 0; overflow: hidden; background: var(--bg-primary); z-index: 2; pointer-events: auto !important;";

        // 0. Programmatically inject CSS styles for diff markers and gutter decorations
        if (!document.getElementById("diff-view-panel-styles")) {
            const style = document.createElement("style");
            style.id = "diff-view-panel-styles";
            style.textContent = `
                .diff-marker-addition {
                    position: absolute;
                    background-color: rgba(46, 160, 67, 0.18) !important;
                    z-index: 20;
                }
                .diff-marker-deletion {
                    position: absolute;
                    background-color: rgba(248, 81, 73, 0.18) !important;
                    z-index: 20;
                }
                .diff-marker-empty {
                    position: absolute;
                    background-color: rgba(128, 128, 128, 0.05) !important;
                    background-image: repeating-linear-gradient(45deg, rgba(0,0,0,0.03), rgba(0,0,0,0.03) 10px, transparent 10px, transparent 20px) !important;
                    z-index: 20;
                }
                .diff-gutter-addition {
                    background-color: rgba(46, 160, 67, 0.3) !important;
                    color: #2da44e !important;
                    font-weight: bold;
                }
                .diff-gutter-deletion {
                    background-color: rgba(248, 81, 73, 0.3) !important;
                    color: #cf222e !important;
                    font-weight: bold;
                }
                .diff-gutter-empty {
                    background-color: rgba(128, 128, 128, 0.1) !important;
                    opacity: 0.5;
                }
                .diff-scrollbar-marker-overlay {
                    position: absolute;
                    right: 0;
                    top: 0;
                    bottom: 0;
                    pointer-events: none;
                    z-index: 100;
                }
                .diff-scrollbar-marker {
                    position: absolute;
                    left: 0;
                    right: 0;
                    height: 3px;
                    border-radius: 1px;
                    z-index: 101;
                    box-shadow: 0 0.5px 1px rgba(0, 0, 0, 0.4);
                }
            `;
            document.head.appendChild(style);
        }

        // 1. Header Bar
        this.header = document.createElement("div");
        this.header.className = "diff-header";
        this.header.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-primary); height: var(--menuHeight); min-height: var(--menuHeight); box-sizing: border-box;";

        const headerLeft = document.createElement("div");
        headerLeft.style.cssText = "display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-primary); overflow: hidden;";

        const icon = document.createElement("ui-icon");
        icon.textContent = "difference";
        icon.style.color = "var(--theme)";

        this.titleSpan = document.createElement("span");
        this.titleSpan.style.cssText = "text-overflow: ellipsis; overflow: hidden; white-space: nowrap;";

        headerLeft.appendChild(icon);
        headerLeft.appendChild(this.titleSpan);
        this.header.appendChild(headerLeft);

        const headerRight = document.createElement("div");
        headerRight.style.cssText = "display: flex; align-items: center; gap: 12px;";

        this.rollbackBtn = document.createElement("button");
        this.rollbackBtn.className = "rollback-btn theme-button primary";
        this.rollbackBtn.style.cssText = "padding: 4px 12px; font-size: 11px; display: flex; align-items: center; gap: 4px; border-radius: 4px; cursor: pointer; font-weight: 600; background: var(--theme); color: #ffffff; border: none;";
        this.rollbackBtn.innerHTML = "<ui-icon style='font-size: 13px; color: #ffffff;'>undo</ui-icon><span>Rollback Changes</span>";

        headerRight.appendChild(this.rollbackBtn);
        this.header.appendChild(headerRight);
        this.appendChild(this.header);

        // 2. Split Body Container
        this.body = document.createElement("div");
        this.body.className = "diff-split-container";
        this.body.style.cssText = "display: flex; height: calc(100% - var(--menuHeight)); width: 100%; overflow: hidden; position: relative; pointer-events: auto !important;";

        // Left Panel (Original)
        this.leftPane = document.createElement("div");
        this.leftPane.className = "diff-pane left-pane";
        this.leftPane.style.cssText = "flex: 1; height: 100%; border-right: 1px solid var(--border-primary); display: flex; flex-direction: column; position: relative; pointer-events: auto !important;";

        const leftLabel = document.createElement("div");
        leftLabel.className = "pane-label";
        leftLabel.style.cssText = "padding: 6px 12px; font-size: 11px; font-weight: 600; background: var(--bg-secondary); color: var(--text-secondary); border-bottom: 1px solid var(--border-primary); text-transform: uppercase; letter-spacing: 0.5px;";
        leftLabel.textContent = "Original (Backup)";

        this.leftEditorDiv = document.createElement("div");
        this.leftEditorDiv.className = "diff-ace-editor-left";
        this.leftEditorDiv.style.cssText = "position: absolute !important; top: 28px !important; bottom: 0px !important; left: 0px !important; right: 4px !important; pointer-events: auto !important;";

        this.leftPane.appendChild(leftLabel);
        this.leftPane.appendChild(this.leftEditorDiv);

        // Right Panel (Current)
        this.rightPane = document.createElement("div");
        this.rightPane.className = "diff-pane right-pane";
        this.rightPane.style.cssText = "flex: 1; height: 100%; display: flex; flex-direction: column; position: relative; pointer-events: auto !important;";

        const rightLabel = document.createElement("div");
        rightLabel.className = "pane-label";
        rightLabel.style.cssText = "padding: 6px 12px; font-size: 11px; font-weight: 600; background: var(--bg-secondary); color: var(--text-secondary); border-bottom: 1px solid var(--border-primary); text-transform: uppercase; letter-spacing: 0.5px;";
        rightLabel.textContent = "Modified (Current)";

        this.rightEditorDiv = document.createElement("div");
        this.rightEditorDiv.className = "diff-ace-editor-right";
        this.rightEditorDiv.style.cssText = "position: absolute !important; top: 28px !important; bottom: 0px !important; left: 0px !important; right: 4px !important; pointer-events: auto !important;";

        this.rightPane.appendChild(rightLabel);
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

    async update(filePath, backupId) {
        this.activeBackupId = backupId;
        this.activeFilePath = filePath;

        const filename = filePath.split('/').pop();
        this.titleSpan.textContent = `Review Changes: ${filename}`;

        // Clear existing markers and scrollbar overlays immediately and synchronously when switching tabs
        if (this.leftEditor) {
            const overlay = this.leftEditor.container.querySelector(".diff-scrollbar-marker-overlay");
            if (overlay) overlay.remove();
            if (this.leftMarkers) {
                this.leftMarkers.forEach(id => this.leftEditor.getSession().removeMarker(id));
            }
        }
        this.leftMarkers = [];

        if (this.rightEditor) {
            const overlay = this.rightEditor.container.querySelector(".diff-scrollbar-marker-overlay");
            if (overlay) overlay.remove();
            if (this.rightMarkers) {
                this.rightMarkers.forEach(id => this.rightEditor.getSession().removeMarker(id));
            }
        }
        this.rightMarkers = [];

        try {
            // 1. Get original content
            const { default: AgentBackup } = await import('../agent/agent-backup.mjs');
            const originalContent = await AgentBackup.rollback(backupId);

            // 2. Get current content from disk via Conduit
            const fileData = await conduitClient.wsRead(filePath);
            if (fileData.error) throw new Error(fileData.error);
            const currentContent = decodeURIComponent(escape(atob(fileData.data)));

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
                this.leftEditor.setFontSize(12);
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
                this.rightEditor.setFontSize(12);
            }
            this.rightEditor.setTheme(theme);
            this.rightEditor.getSession().setMode(mode);
            this.rightEditor.setValue(rightContentText, -1);

            // Clear old markers
            if (this.leftMarkers) {
                this.leftMarkers.forEach(id => this.leftEditor.getSession().removeMarker(id));
            }
            this.leftMarkers = [];

            if (this.rightMarkers) {
                this.rightMarkers.forEach(id => this.rightEditor.getSession().removeMarker(id));
            }
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

            // Wire Rollback Button
            this.rollbackBtn.onclick = async () => {
                const confirmed = await window.modal.confirm(`Are you sure you want to rollback all changes to ${filename}?`, "Rollback Changes");
                if (!confirmed) return;

                try {
                    this.rollbackBtn.disabled = true;
                    this.rollbackBtn.innerHTML = "<ui-icon class='spinner' style='color:#ffffff;'>sync</ui-icon><span>Rolling back...</span>";

                    // Apply rollback
                    const content = await AgentBackup.rollback(backupId);
                    const base64Content = btoa(unescape(encodeURIComponent(content)));
                    const result = await conduitClient.wsWrite(filePath, base64Content);
                    if (result.error) throw new Error(result.error);

                    // Update active editor tab session if open
                    const clean = (p) => p ? p.replace(/\\/g, '/') : '';
                    const normPath = clean(filePath);
                    const allOpenTabs = [...(ui.leftTabs?.tabs || []), ...(ui.rightTabs?.tabs || [])];
                    const tab = allOpenTabs.find(t => clean(t.config?.path) === normPath);
                    if (tab && tab.config.session) {
                        tab.config.session.setValue(content);
                        tab.config.session.baseValue = content;
                        tab.changed = false;
                    }

                    // Mark as rolled back in the session modifiedFiles state
                    const session = ui.aiManager.activeSession;
                    if (session && session.modifiedFiles && session.modifiedFiles[filePath]) {
                        session.modifiedFiles[filePath] = session.modifiedFiles[filePath].filter(b => b.backupId !== backupId);
                        if (session.modifiedFiles[filePath].length === 0) {
                            delete session.modifiedFiles[filePath];
                        }
                        await workspaceClient.setSession(session.id, session);
                    }

                    window.modal.toast(`Successfully rolled back ${filename} to original state.`);

                    // Close current diff tab
                    const diffTab = allOpenTabs.find(t => t.config?.path === `diff_${backupId}`);
                    if (diffTab) {
                        diffTab.tabBar.remove(diffTab, true);
                    }

                    // Trigger a redraw of Settings and Artifacts view
                    if (window.ui?.renderPlanTasksView) {
                        const containers = document.querySelectorAll(".plan-tasks-view");
                        containers.forEach(c => window.ui.renderPlanTasksView(c));
                    }
                } catch (err) {
                    console.error("Rollback failed:", err);
                    window.modal.notice(`Rollback failed:<br><small>${err.message}</small>`, "Rollback Error");
                    this.rollbackBtn.disabled = false;
                    this.rollbackBtn.innerHTML = "<ui-icon style='font-size: 13px; color: #ffffff;'>undo</ui-icon><span>Rollback Changes</span>";
                }
            };
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
    overlay.style.cssText = `
        position: absolute;
        right: 8px;
        top: 0;
        bottom: 0;
        width: 3px;
        pointer-events: none;
        z-index: 100;
        display: ${scrollbarEl.style.display === 'none' ? 'none' : 'block'};
    `;

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
