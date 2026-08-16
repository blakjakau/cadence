// elements/filebar.mjs
import { Block } from './element.mjs';
import { FileChip } from './filechip.mjs';
import { SkillChip } from './skillchip.mjs';
import { Button } from './button.mjs';

export class FileBar extends Block {
    constructor() {
        super();
        this._chips = new Map();
        this._hasLibraryButton = false;
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
        const chipId = (chipOrId instanceof FileChip || chipOrId instanceof SkillChip) 
            ? (chipOrId.config.id || chipOrId.config.name) 
            : chipOrId;
        
        if (this._chips.has(chipId)) {
            const chip = this._chips.get(chipId);
            chip.remove();
            this._chips.delete(chipId);
        }

        if (this._chips.size === 0 && !this._hasLibraryButton) {
            this.style.display = 'none'; // Hide if no chips are left and no library button
        }
    }

    clear() {
        this.innerHTML = '';
        this._chips.clear();
        this._hasLibraryButton = false;
        //this.style.display = 'none'; // Hide after clearing
        this.addLibraryButton()
    }
}

customElements.define("ui-filebar", FileBar);
