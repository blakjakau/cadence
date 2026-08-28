// elements/filebar.mjs
import { Block } from './element.mjs';
import { FileChip } from './filechip.mjs';
import { SkillChip } from './skillchip.mjs';
import { RootChip } from './rootchip.mjs';
import { Button } from './button.mjs';

export class FileBar extends Block {
    constructor() {
        super();
        this._chips = new Map();
        this._hasLibraryButton = false;
        this._hasRootsButton = false;
        this.style.display = 'none'; // Initially hidden
    }

    add(config) {
        if (this._chips.has(config.id)) {
            // Chip for this file already exists
            return this._chips.get(config.id);
        }

        const chip = new FileChip(config);
        chip.on('chip-close', () => {
            // Let the parent (ai-manager) handle removal from history first
            this.dispatch('file-remove-request', { fileId: config.id });
        });
        
        this._chips.set(config.id, chip);
        this.append(chip);
        
        this.style.display = 'flex';
        return chip;
    }

    addSkill(config) {
        if (this._chips.has(config.id)) {
            // Skill chip already exists
            return this._chips.get(config.id);
        }

        const chip = new SkillChip(config);
        chip.on('skill-remove-request', (e) => {
            this.dispatch('skill-remove-request', { skillName: e.detail.skillName });
        });

        this._chips.set(config.id, chip);
        this.append(chip);

        this.style.display = 'flex';
        return chip;
    }

    addRoot(config) {
        if (this._chips.has(config.id)) {
            // Root chip already exists
            return this._chips.get(config.id);
        }

        const chip = new RootChip(config);
        chip.on('root-remove-request', (e) => {
            this.dispatch('root-remove-request', { rootPath: e.detail.rootPath });
        });

        this._chips.set(config.id, chip);
        this.append(chip);

        this.style.display = 'flex';
        return chip;
    }

    addRootsButton(onRootsClick="") {
        if(onRootsClick) {
            this._onRootsClick = onRootsClick;
        } else {
            if(this._onRootsClick) {
                onRootsClick = this._onRootsClick;
            }
        }
        const btn = new Button("");
        btn.icon = "folder_special";
        btn.title = "Workspace Roots Filter";
        btn.className = "library-button";
        btn.onclick = onRootsClick;
        this.append(btn);
        this._hasRootsButton = true;
        this.style.display = 'flex';
    }

    addLibraryButton(onLibraryClick="") {
    	if(onLibraryClick) {
    		this._onLibraryClick = onLibraryClick
    	} else {
    		if(this._onLibraryClick) {
    			onLibraryClick = this._onLibraryClick
    		}
    	}
        const btn = new Button("");
        btn.icon = "library_books";
        btn.title = "Skill Library";
        btn.className = "library-button";
        btn.onclick = onLibraryClick;
        this.append(btn);
        this._hasLibraryButton = true;
        this.style.display = 'flex';
    }

    remove(chipOrId) {
        const chipId = (chipOrId instanceof FileChip || chipOrId instanceof SkillChip || chipOrId instanceof RootChip) 
            ? (chipOrId.config.id || chipOrId.config.name) 
            : chipOrId;
        
        if (this._chips.has(chipId)) {
            const chip = this._chips.get(chipId);
            chip.remove();
            this._chips.delete(chipId);
        }

        if (this._chips.size === 0 && !this._hasLibraryButton && !this._hasRootsButton) {
            this.style.display = 'none'; // Hide if no chips are left and no buttons
        }
    }

    clear() {
        this.innerHTML = '';
        this._chips.clear();
        this._hasLibraryButton = false;
        this._hasRootsButton = false;
        this.addRootsButton();
        this.addLibraryButton();
    }
}

customElements.define("ui-filebar", FileBar);
