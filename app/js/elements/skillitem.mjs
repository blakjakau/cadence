// elements/skillitem.mjs
// elements/skillitem.mjs
import { Block, Inline } from './element.mjs';
import { Button } from './button.mjs';

export class SkillItem extends Block {
    constructor(config, isPinned = false) {
        super();
        this.config = config;
        this.isPinned = isPinned;
        this.isExpanded = false;
        this.className = 'skill-item';

        // --- Pin button (left side, icon-only) ---
        this.pinButton = new Button("");
        this.pinButton.className = 'skill-pin-button';
this.pinButton.setIcon(isPinned ? 'keep' : 'keep_off');
        if (isPinned) this.pinButton.classList.add('pinned');
        this.pinButton.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('skill-pin-toggle', {
                bubbles: true,
                composed: true,
                detail: { name: config.name, pinned: !this.isPinned }
            }));
        };

        // --- Info block (name + desc) ---
        const info = new Block();
        info.classList.add('skill-item-info');

        const name = new Inline();
        name.textContent = config.name;
        name.classList.add('skill-item-name');

        const desc = new Inline();
        desc.textContent = config.description || '';
        desc.classList.add('skill-item-desc');

        info.append(name, desc);

        // --- Expand chevron (right side) ---
        this.expandIcon = new Inline();
        this.expandIcon.textContent = '▶';
        this.expandIcon.className = 'skill-expand-icon';

        // --- Header row ---
        this.headerRow = new Block();
        this.headerRow.classList.add('skill-item-container');
        this.headerRow.append(this.pinButton, info, this.expandIcon);
        this.append(this.headerRow);

        // --- Expand/collapse toggle ---
        this.headerRow.onclick = (e) => {
            if (e.target === this.pinButton || this.pinButton.contains(e.target)) {
                return; // Let pin button handle its own click
            }
            this.toggleExpanded();
        };

        // --- Detail container (hidden initially) ---
        this.detailContainer = new Block();
        this.detailContainer.className = 'skill-item-detail';
        this.detailContainer.style.display = 'none';
    }

    toggleExpanded() {
        this.isExpanded = !this.isExpanded;
        this.classList.toggle('expanded', this.isExpanded);
        this.detailContainer.style.display = this.isExpanded ? 'block' : 'none';

        if (this.isExpanded && !this._detailRendered) {
            this._renderDetail();
            this._detailRendered = true;
        }

        // Also fire skill-select for backward compatibility
        this.dispatchEvent(new CustomEvent('skill-select', {
            bubbles: true,
            composed: true,
            detail: { skill: this.config }
        }));
    }

    _renderDetail() {
        this.detailContainer.innerHTML = '';

        const descBlock = new Block();
        descBlock.className = 'skill-item-detail-desc';
        descBlock.textContent = this.config.metadata?.description || this.config.description || '';
        this.detailContainer.append(descBlock);

        const body = document.createElement('pre');
        body.className = 'skill-item-detail-body';
        body.textContent = this.config.body || '';
        this.detailContainer.append(body);

        const actions = new Block();
        actions.className = 'skill-item-detail-actions';

        const addBtn = new Button("Add to Context");
        addBtn.className = 'theme-button';
        addBtn.icon = 'add_circle';
        addBtn.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('skill-add-context', {
                bubbles: true,
                composed: true,
                detail: { skill: this.config }
            }));
        };

        const editBtn = new Button("Edit");
        editBtn.className = 'theme-button secondary';
        editBtn.icon = 'edit';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('skill-edit', {
                bubbles: true,
                composed: true,
                detail: { skill: this.config }
            }));
        };

        actions.append(addBtn, editBtn);
        this.detailContainer.append(actions);

        this.append(this.detailContainer);
    }

    updatePinState(isPinned) {
        this.isPinned = isPinned;
this.pinButton.setIcon(isPinned ? 'keep' : 'keep_off');
        this.pinButton.classList.toggle('pinned', isPinned);
    }
}

customElements.define("ui-skill-item", SkillItem);
