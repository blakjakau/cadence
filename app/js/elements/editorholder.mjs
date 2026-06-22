import { Panel } from './panel.mjs';
import { MediaView } from './mediaview.mjs';
import { TabItem } from './tabitem.mjs';
import { TabBar } from './tabbar.mjs';
import { SessionArtifactsPanel } from './session-artifacts-panel.mjs';
import { AgentConfigPanel } from './agent-config-panel.mjs';
import { DiffViewPanel } from './diff-view-panel.mjs';
import { SettingsPanel } from './settings-panel.mjs';

export class EditorHolder extends Panel {
    constructor() {
        super();
        this.editorElement = document.createElement("div");
        this.editorElement.classList.add("loading");
        this.editorElement.style.display = "block";
        this.mediaView = new MediaView();
        this.mediaView.style.display = "block";
        this.planTasksView = new SessionArtifactsPanel();
        this.planTasksView.style.display = "none";
        this.agentConfigView = new AgentConfigPanel();
        this.agentConfigView.style.display = "none";
        this.diffView = new DiffViewPanel();
        this.diffView.style.display = "none";
        
        this.workspaceSettingsView = new SettingsPanel();
        this.workspaceSettingsView.style.display = "none";
        this.workspaceSettingsView.classList.add("workspace-settings-panel");
        
        this.terminalSettingsView = new SettingsPanel();
        this.terminalSettingsView.style.display = "none";
        this.terminalSettingsView.classList.add("terminal-settings-panel");

        this.editorSettingsView = new SettingsPanel();
        this.editorSettingsView.style.display = "none";
        this.editorSettingsView.classList.add("editor-settings-panel");

        this.appendChild(this.editorElement);
        this.appendChild(this.mediaView);
        this.appendChild(this.planTasksView);
        this.appendChild(this.agentConfigView);
        this.appendChild(this.diffView);
        this.appendChild(this.workspaceSettingsView);
        this.appendChild(this.terminalSettingsView);
        this.appendChild(this.editorSettingsView);

        this.dragCounter = 0;
        this.dragLogging = (event)=>{
			// console.log(this.id, event.type, this.dragCounter, event)
        }

		

        this.on("dragenter", (e) => {
            if (e.dataTransfer.types.includes("application/x-tab-item")) {
            	this.dragLogging(e)
                e.preventDefault();
                this.dragCounter++;
                this.classList.add("drag-over");
            }
        });

        this.on("dragleave", (e) => {
            if (e.dataTransfer.types.includes("application/x-tab-item")) {
        		this.dragLogging(e)
                e.preventDefault();
                this.dragCounter--;
                if (this.dragCounter === 0) {
                    this.classList.remove("drag-over");
                }
            }
        });

        this.on("dragover", (e) => {
            if (e.dataTransfer.types.includes("application/x-tab-item")) {
        		this.dragLogging(e)
                e.preventDefault();
                this.classList.add("drag-over");
            }
        });

        this.on("drop", async (e) => {
            e.preventDefault();
            
            
            this.dragCounter = 0;
            this.dragLogging(event)
            this.classList.remove("drag-over");

            if(this.exclusiveDropType != null && e.dataTransfer.getData("application/x-exclusive-drop-type") != null) {
				if(this.exclusiveDropType != e.dataTransfer.getData("application/x-exclusive-drop-type")) {
					console.debug("exclusive drop type not matched between ")
					return
				}
			}
			
            const tabId = e.dataTransfer.getData("application/x-tab-item");
            const tab = document.getElementById(tabId);

            if (tab && tab.parentElement !== this.tabs) {
                const sourceTabBar = tab.parentElement;

                if (sourceTabBar && sourceTabBar.tagName === 'UI-TABBAR') {
                    const index = sourceTabBar._tabs.indexOf(tab);
                    if (index > -1) {
                        const wasActive = tab.hasAttribute("active");
                        sourceTabBar._tabs.splice(index, 1);

                        if (wasActive && sourceTabBar._tabs.length > 0) {
                            const nextActiveTab = sourceTabBar._tabs[index] || sourceTabBar._tabs[index - 1];
                            if (nextActiveTab) {
                                nextActiveTab.click();
                            }
                        } else if (sourceTabBar._tabs.length === 0) {
                            if (typeof sourceTabBar.onEmpty === 'function') {
                                sourceTabBar.onEmpty();
                            }
                        }
                    }
                }

                this.tabs.append(tab);
                this.tabs._tabs.push(tab);
                tab.tabBar = this.tabs;
                tab.config.side = this.id === 'leftHolder' ? 'left' : 'right';
                tab.click();
            }
        });
    }

    set editor(aceEditorInstance) {
        this._editor = aceEditorInstance;
        this.editorElement.setAttribute("id", aceEditorInstance.container.id);
    }

    get editor() {
        return this._editor;
    }

    set tabs(tabBarInstance) {
        if (this._tabs) {
            this._tabs.off('tabs-updated', this._tabsUpdatedHandler);
        }
        this._tabs = tabBarInstance;
        this.appendChild(tabBarInstance);
        this._tabsUpdatedHandler = (e) => this._updateContentVisibility(e.detail.isEmpty);
        this._tabs.on('tabs-updated', this._tabsUpdatedHandler);
        this._updateContentVisibility(this._tabs.tabs.length === 0);
    }

    get tabs() {
        return this._tabs;
    }

    set media(mediaViewInstance) {
        this._media = mediaViewInstance;
        this.mediaView.setAttribute("id", mediaViewInstance.id);
    }

    get media() {
        return this._media;
    }

    set side(value) {
        this._side = value;
        this.setAttribute("side", value);
    }

    get side() {
        return this._side;
    }

    _adjustEditorTop() {
		const offset = this.tabs.offsetHeight + this.editorHeaderBar.offsetHeight
        this.editorElement.style.top = `${offset}px`;
        this.editorElement.style.height = `calc(100% - ${offset}px)`;
        if (this.editor && typeof this.editor.resize === "function") this.editor.resize();
    }

    _updateContentVisibility(isEmpty) {
        console.debug(`EditorHolder ${this.id}: _updateContentVisibility called with isEmpty: ${isEmpty}`);
    	this.classList.remove("drag-over")
    	this.dragCounter = 0
        if (isEmpty) {
        	this.dispatch('empty');
            this.editorElement.style.display = 'none';
            this.mediaView.style.display = 'none';
            if (this.planTasksView) this.planTasksView.style.display = 'none';
            if (this.agentConfigView) this.agentConfigView.style.display = 'none';
            if (this.diffView) this.diffView.style.display = 'none';
        } else {
            const activeTab = this._tabs.activeTab;
            // if (activeTab && activeTab.config && activeTab.config.mode === "media") {
            //     this.editorElement.style.display = 'none';
            //     this.mediaView.style.display = 'block';
            // } else {
            //     this.editorElement.style.display = 'block';
            //     this.mediaView.style.display = 'none';
            // }
        }
    }

    connectedCallback() {
        super.connectedCallback();
        // Add background element for empty state
        const backgroundElement = document.createElement("div");
        backgroundElement.classList.add("background-element");
        backgroundElement.innerHTML = `<ui-icon style="font-size: 48px; opacity: 0.5;">code</ui-icon>`;
        const caption = document.createElement("div");
        caption.classList.add("caption");
        caption.innerHTML = "CTRL+O to open a file <br/> CTRL+N to create a new file";
        backgroundElement.appendChild(caption);
        this.appendChild(backgroundElement);
        this._backgroundElement = backgroundElement; // Store reference

        // Add overlay for drag-over effect
        const overlay = this.holderOverlay = document.createElement("div");
        overlay.classList.add("holder-overlay");
        this.appendChild(overlay);

        // Add unified premium header notice bar
        const noticeBar = document.createElement("div");
        noticeBar.setAttribute("id", `${this.id}FileModifiedNotice`);
        noticeBar.className = "editor-header-bar";
        
        const leftSide = document.createElement("div");
        leftSide.className = "left-side";
        
        const statusIcon = document.createElement("ui-icon");
        
        const statusText = document.createElement("span");
        
        leftSide.appendChild(statusIcon);
        leftSide.appendChild(statusText);
        noticeBar.appendChild(leftSide);
        
        const rightSide = document.createElement("div");
        rightSide.className = "right-side";
        noticeBar.appendChild(rightSide);
        
        this.appendChild(noticeBar);
        
        this.editorHeaderBar = noticeBar;
        this.editorHeaderLeft = leftSide;
        this.editorHeaderRight = rightSide;
        this.editorHeaderIcon = statusIcon;
        this.editorHeaderText = statusText;

        // Add agent edits notice bar
        const agentEditsBar = document.createElement("div");
        agentEditsBar.setAttribute("id", `${this.id}AgentEditsNotice`);
        agentEditsBar.classList.add("notice-bar", "agent-edits-notice");
        agentEditsBar.style.display = "none";
        agentEditsBar.innerHTML = `
            <div class="notice-bar-row first-row" style="display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px;">
                <button rel="prev-edit" title="Previous Edit" style="padding: 4px 10px; margin: 0 2px;">&lt;</button>
                <span>Pending edits: <b class="edit-index">0</b> of <b class="edit-total">0</b></span>
                <button rel="accept-edit" class="themed" style="margin: 0 2px;">Accept</button>
                <button rel="reject-edit" class="cancel" style="margin: 0 2px;">Reject</button>
                <button rel="next-edit" title="Next Edit" style="padding: 4px 10px; margin: 0 2px;">&gt;</button>
            </div>
            <div class="notice-bar-row second-row" style="display: flex; width: 100%; justify-content: center; align-items: center; gap: 8px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--theme);">
                <button rel="accept-all" class="themed" style="margin: 0 2px; flex: 1;">Accept All</button>
                <button rel="reject-all" class="cancel" style="margin: 0 2px; flex: 1;">Reject All</button>
            </div>
        `;
        this.appendChild(agentEditsBar);
    }

    async updateNoticeBar(tab) {
        if (!tab || !tab.config || tab.config.viewMode === "diff" || 
            tab.config.path === "plan_tasks" || tab.config.path === "agent_config" || 
            tab.config.path === "workspace_settings" || tab.config.path === "terminal_settings" || tab.config.path === "editor_settings") {
            this.editorHeaderBar.style.display = "none";
            this.editorElement.style.top = "";
            this.editorElement.style.height = "";
            if (this.editor && typeof this.editor.resize === "function") this.editor.resize();
            return;
        }

        const path = tab.config.path;
        const side = tab.config.side || (this.id === 'leftHolder' ? 'left' : 'right');

        // Check 1: Reload Notification (File modified outside)
        if (tab.config.fileModified) {
            this.editorHeaderBar.style.display = "flex";
            this.editorHeaderBar.className = "editor-header-bar modified-external";
            this.editorHeaderIcon.style.display = "";
            this.editorHeaderIcon.textContent = "warning";
            this.editorHeaderIcon.style.color = "";
            this.editorHeaderText.textContent = "This file has been modified outside the editor.";
            
            // Rebuild buttons
            this.editorHeaderRight.innerHTML = "";
            
            const reloadBtn = document.createElement("button");
            reloadBtn.className = "primary";
            reloadBtn.textContent = "Reload";
            reloadBtn.setAttribute("rel", "reload");
            reloadBtn.onclick = async () => {
                if (window.ui && window.ui.reloadFile) {
                    await window.ui.reloadFile(tab);
                }
                if (window.ui && window.ui.hideFileModifiedNotice) {
                    window.ui.hideFileModifiedNotice(side);
                }
            };

            const diffBtn = document.createElement("button");
            diffBtn.className = "secondary";
            diffBtn.innerHTML = `<ui-icon style="font-size: 13px;">difference</ui-icon> Show Diff`;
            diffBtn.onclick = () => {
                tab.config.viewMode = "diff";
                tab.click();
            };
            
            const dismissBtn = document.createElement("button");
            dismissBtn.className = "cancel";
            dismissBtn.textContent = "Dismiss";
            dismissBtn.setAttribute("rel", "dismiss");
            dismissBtn.onclick = () => {
                tab.config.fileModified = false;
                const isDirty = tab.config.session.getValue() !== tab.config.session.baseValue;
                tab.changed = isDirty;
                if (window.ui && window.ui.fileList) {
                    const fileItem = window.ui.fileList.find(tab.config.handle);
                    if (fileItem && fileItem.length > 0) {
                        fileItem[0].changed = isDirty;
                    }
                }
                if (window.ui && window.ui.hideFileModifiedNotice) {
                    window.ui.hideFileModifiedNotice(side);
                }
                if (window.ui && window.ui.checkGlobalFileModifiedNotice) {
                    window.ui.checkGlobalFileModifiedNotice();
                }
            };
            
            this.editorHeaderRight.appendChild(reloadBtn);
            this.editorHeaderRight.appendChild(diffBtn);
            this.editorHeaderRight.appendChild(dismissBtn);

            this._adjustEditorTop()
            return;
        }

        const normalize = (p) => p ? p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '') : '';
        const pathsMatch = (p1, p2) => {
            const n1 = normalize(p1);
            const n2 = normalize(p2);
            if (!n1 || !n2) return false;
            return n1 === n2 || n1.endsWith('/' + n2) || n2.endsWith('/' + n1);
        };

        // Check 2: Active AI session states (purely state-driven based on active session backups and pending edits)
        let hasBackups = false;
        let latestBackup = null;
        const session = window.ui?.aiManager?.activeSession;
        
        let backups = [];
        if (session && session.modifiedFiles) {
            const matchedKey = Object.keys(session.modifiedFiles).find(k => pathsMatch(k, path));
            if (matchedKey) backups = session.modifiedFiles[matchedKey];
        }
        
        if (backups.length > 0) {
            hasBackups = true;
            latestBackup = backups[backups.length - 1];
        }

        // Check if there are dirty pending changes in memory from the AI session (Permission Mode)
        let hasPendingChanges = false;
        if (session && session.pendingEdits) {
            const matchedKey = Object.keys(session.pendingEdits).find(k => pathsMatch(k, path));
            hasPendingChanges = tab.changed && matchedKey && !!session.pendingEdits[matchedKey];
        }

        if (hasPendingChanges) {
            this.editorHeaderBar.style.display = "flex";
            this.editorHeaderBar.className = "editor-header-bar pending-changes";
            this.editorHeaderIcon.style.display = "";
            this.editorHeaderIcon.textContent = "edit";
            this.editorHeaderIcon.style.color = "";
            this.editorHeaderText.innerHTML = `Pending AI edits in memory. <span style="font-size: 11.5px; font-weight: normal; margin-left: 6px;">(Permission Mode)</span>`;
            
            this.editorHeaderRight.innerHTML = "";
            
            const diffBtn = document.createElement("button");
            diffBtn.className = "primary";
            diffBtn.innerHTML = `<ui-icon style="font-size: 13px;">difference</ui-icon> Show Diff`;
            diffBtn.onclick = () => {
                tab.config.viewMode = "diff";
                tab.click();
            };
            
            this.editorHeaderRight.appendChild(diffBtn);

            this._adjustEditorTop()
            return;
        }

        if (hasBackups && latestBackup) {
            this.editorHeaderBar.style.display = "flex";
            this.editorHeaderBar.className = "editor-header-bar rollback-protected";
            this.editorHeaderIcon.style.display = "";
            this.editorHeaderIcon.textContent = "check_circle";
            this.editorHeaderIcon.style.color = "";
            this.editorHeaderText.innerHTML = `File edited by AI. Rollback protected. <span style="font-size: 11.5px; font-weight: normal; margin-left: 6px;">(Forgiveness Mode)</span>`;
            
            this.editorHeaderRight.innerHTML = "";
            
            const diffBtn = document.createElement("button");
            diffBtn.className = "secondary";
            diffBtn.innerHTML = `<ui-icon style="font-size: 13px;">difference</ui-icon> Show Diff`;
            diffBtn.onclick = () => {
                tab.config.viewMode = "diff";
                tab.config.backupId = latestBackup.backupId;
                tab.click();
            };
            
            this.editorHeaderRight.appendChild(diffBtn);

            this._adjustEditorTop()
            return;
        }

        // Check if there are unsaved local user edits (since last save)
        const isDirty = tab.config.session && tab.config.session.getValue() !== tab.config.session.baseValue;
        if (!hasPendingChanges && isDirty) {
            this.editorHeaderBar.style.display = "flex";
            this.editorHeaderBar.className = "editor-header-bar user-changes";
            this.editorHeaderIcon.style.display = "";
            this.editorHeaderIcon.textContent = "edit";
            this.editorHeaderIcon.style.color = "";
            this.editorHeaderText.innerHTML = `Unsaved local changes. <span style="color: var(--text-secondary); font-size: 11.5px; font-weight: normal; margin-left: 6px;">(User Edits)</span>`;
            
            this.editorHeaderRight.innerHTML = "";
            
            const diffBtn = document.createElement("button");
            diffBtn.className = "primary";
            diffBtn.innerHTML = `<ui-icon style="font-size: 13px;">difference</ui-icon> Show Diff`;
            diffBtn.onclick = () => {
                tab.config.viewMode = "diff";
                tab.click();
            };
            
            this.editorHeaderRight.appendChild(diffBtn);

            this._adjustEditorTop()
            return;
        }

        // Check 3: Fallback to hiding if agent edits notice bar is shown
        const agentEditsBarId = (side === 'left') ? "leftHolderAgentEditsNotice" : "rightHolderAgentEditsNotice";
        const agentEditsBar = document.getElementById(agentEditsBarId);
        if (agentEditsBar && agentEditsBar.style.display === "flex") {
            this.editorHeaderBar.style.display = "none";
            this.editorElement.style.top = "";
            this.editorElement.style.height = "";
            if (this.editor && typeof this.editor.resize === "function") this.editor.resize();
            return;
        }

        // Show clean neutral state
        this.editorHeaderBar.style.display = "flex";
        this.editorHeaderBar.className = "editor-header-bar file-info";
        this.editorHeaderIcon.style.display = "none";
        
        const fullPath = tab.config.fullPath || tab.config.path || "";
        const standardizedPath = fullPath.replace(/\\/g, '/');
        
        let folderName = "";
        let relativePath = standardizedPath;
        
        const checkFolders = [];
        if (tab.config.folder) {
            checkFolders.push(tab.config.folder);
        }
        const wsFolders = window.workspace?.folders || [];
        for (const f of wsFolders) {
            if (!checkFolders.includes(f)) {
                checkFolders.push(f);
            }
        }
        
        for (const f of checkFolders) {
            const normFolder = f.replace(/\\/g, '/');
            if (normFolder === "." || normFolder === "") continue;
            
            const absPrefix = normFolder.endsWith('/') ? normFolder : normFolder + '/';
            if (standardizedPath.startsWith(absPrefix)) {
                const folderParts = normFolder.split('/');
                folderName = folderParts[folderParts.length - 1] || normFolder;
                relativePath = standardizedPath.slice(absPrefix.length);
                break;
            }
            
            const relMatch = '/' + normFolder + '/';
            const matchIndex = standardizedPath.indexOf(relMatch);
            if (matchIndex !== -1) {
                const folderParts = normFolder.split('/');
                folderName = folderParts[folderParts.length - 1] || normFolder;
                relativePath = standardizedPath.slice(matchIndex + relMatch.length);
                break;
            }
        }
        
        let pathDisplayHTML = standardizedPath;
        if (folderName) {
            pathDisplayHTML = `<span style="opacity: 0.7; font-weight: bold; margin-right: 6px;">[${folderName}]</span>${relativePath}`;
        }
        
        this.editorHeaderText.innerHTML = pathDisplayHTML;
        
        this.editorHeaderRight.innerHTML = "";
        const rightContainer = document.createElement("div");
        rightContainer.style.color = "var(--text-secondary)";
        rightContainer.style.fontSize = "11.5px";
        rightContainer.style.fontWeight = "normal";
        rightContainer.style.display = "flex";
        rightContainer.style.gap = "12px";
        rightContainer.style.alignItems = "center";
        
        if (tab.config.size !== undefined && tab.config.size !== null) {
            const sizeSpan = document.createElement("span");
            const sizeInKb = tab.config.size === 0 ? "0.0" : Math.max(0.1, tab.config.size / 1024).toFixed(1);
            sizeSpan.textContent = `${sizeInKb} KB`;
            rightContainer.appendChild(sizeSpan);
        }
        
        if (tab.config.modTime) {
            const timeSpan = document.createElement("span");
            const dateStr = new Date(tab.config.modTime * 1000).toLocaleString();
            timeSpan.textContent = `Last modified: ${dateStr}`;
            rightContainer.appendChild(timeSpan);
        }
        
        this.editorHeaderRight.appendChild(rightContainer);
        
        this._adjustEditorTop();
    }
}

customElements.define("ui-editor-holder", EditorHolder);