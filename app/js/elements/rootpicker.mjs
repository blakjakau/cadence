// elements/rootpicker.mjs
import { Block } from './element.mjs';
import { Input } from './input.mjs';
import { RootItem } from './rootitem.mjs';
import workspaceClient from '../workspace-client.mjs';

export class RootPicker extends Block {
    constructor(aiManager) {
        super();
        this.aiManager = aiManager;
        this.className = 'root-picker';

        this.searchContainer = new Block();
        this.searchContainer.classList.add('root-picker-search-container');
        this.searchInput = new Input();
        this.searchInput.placeholder = "Search workspace roots...";
        this.searchContainer.append(this.searchInput);

        this.mainContainer = new Block();
        this.mainContainer.classList.add('root-picker-main');

        this.listContainer = new Block();
        this.listContainer.classList.add('root-picker-list');

        this.mainContainer.append(this.listContainer);
        this.append(this.searchContainer, this.mainContainer);

        this.searchInput.on('input', () => this.filterRoots());

        // Initial load
        this.filterRoots();
    }

    async filterRoots() {
        const query = this.searchInput.value.toLowerCase();
        const workspaceFolders = window.workspace?.folders || [];
        const roots = workspaceFolders.map(folderPath => {
            const norm = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
            const name = norm.split('/').filter(Boolean).pop() || norm;
            return {
                name: name,
                path: folderPath
            };
        });

        const filtered = roots.filter(r => r.name.toLowerCase().includes(query) || r.path.toLowerCase().includes(query));

        this.listContainer.innerHTML = '';
        if (filtered.length === 0) {
            const emptyBlock = new Block();
            emptyBlock.classList.add('root-picker-empty');
            emptyBlock.textContent = workspaceFolders.length === 0 ? "No workspace roots open." : "No matching roots found.";
            this.listContainer.append(emptyBlock);
            return;
        }

        const pinnedRoots = window.workspace?.pinnedRoots || [];

        for (const root of filtered) {
            const isPinned = pinnedRoots.some(p => p === root.path || p === root.name);
            const item = new RootItem(root, isPinned);
            item.on('root-pin-toggle', (e) => this.handlePinToggle(e.detail));
            this.listContainer.append(item);
        }
    }

    async handlePinToggle({ path, name, pinned }) {
        const workspace = window.workspace;
        if (!workspace.pinnedRoots) workspace.pinnedRoots = [];

        if (pinned) {
            if (!workspace.pinnedRoots.includes(path)) {
                workspace.pinnedRoots.push(path);
            }
        } else {
            workspace.pinnedRoots = workspace.pinnedRoots.filter(p => p !== path && p !== name);
        }

        await workspaceClient.setWorkspace(workspace);
        this.filterRoots(); // Refresh list to show new pin state

        // Update the FileBar to show/hide the root chip
        if (this.aiManager.historyManager) {
            this.aiManager.historyManager.populateFileBar();
        }

        // Refresh any Settings & Artifacts panels so the Workspaces accordion reflects the change
        if (window.ui?.renderPlanTasksView) {
            const containers = document.querySelectorAll(".plan-tasks-view");
            containers.forEach(c => window.ui.renderPlanTasksView(c));
        }
    }
}

customElements.define("ui-root-picker", RootPicker);
