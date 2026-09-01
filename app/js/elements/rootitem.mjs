// elements/rootitem.mjs
import { Block, Inline } from './element.mjs';
import { Button } from './button.mjs';
import { Icon } from './icon.mjs';

export class RootItem extends Block {
    constructor(config, isPinned = false) {
        super();
        this.config = config; // { name, path }
        this.isPinned = isPinned;
        this.className = 'root-item';

        // --- Pin button (left side, icon-only) ---
        this.pinButton = new Button("");
        this.pinButton.className = 'root-pin-button';
        this.pinButton.setIcon(isPinned ? 'keep' : 'keep_off');
        if (isPinned) this.pinButton.classList.add('pinned');
        this.pinButton.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('root-pin-toggle', {
                bubbles: true,
                composed: true,
                detail: { path: config.path, name: config.name, pinned: !this.isPinned }
            }));
        };

        // --- Folder icon ---
        const folderIcon = new Icon();
        folderIcon.innerHTML = "folder";
        folderIcon.classList.add('root-item-folder-icon');

        // --- Info block (name + full path) ---
        const info = new Block();
        info.classList.add('root-item-info');

        const name = new Inline();
        name.textContent = config.name;
        name.classList.add('root-item-name');

        const path = new Inline();
        path.textContent = config.path || '';
        path.classList.add('root-item-desc');

        info.append(name, path);

        // --- Row container ---
        this.row = new Block();
        this.row.classList.add('root-item-container');
        this.row.append(this.pinButton, folderIcon, info);
        this.append(this.row);

        this.row.onclick = (e) => {
            if (e.target === this.pinButton || this.pinButton.contains(e.target)) {
                return;
            }
            // Clicking the row toggles the pin state
            this.dispatchEvent(new CustomEvent('root-pin-toggle', {
                bubbles: true,
                composed: true,
                detail: { path: config.path, name: config.name, pinned: !this.isPinned }
            }));
        };

        if (isPinned) {
            this.classList.add('pinned');
        }
    }

    updatePinState(isPinned) {
        this.isPinned = isPinned;
        this.pinButton.setIcon(isPinned ? 'keep' : 'keep_off');
        this.pinButton.classList.toggle('pinned', isPinned);
        this.classList.toggle('pinned', isPinned);
    }
}

customElements.define("ui-root-item", RootItem);
