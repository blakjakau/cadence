// elements/skillchip.mjs
// elements/skillchip.mjs
import { Button } from './button.mjs';
import { Icon } from './icon.mjs';

export class SkillChip extends Button {
    constructor(config) {
        super();
        
        if (config) {
            this.config = config;
            this.id = `skillchip-${config.name}`;
            this.className = 'skill-chip';
            
            const textElement = document.createElement('span');
            textElement.textContent = config.name;
            this._textElement = textElement;
        }
        
        this._close = new Icon();
        this._close.innerHTML = "close";
        this._close.setAttribute("close", "close");

        this.append(this._textElement, this._close);

        this._close.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('skill-remove-request', {
                bubbles: true,
                composed: true,
                detail: { skillName: this.config.name }
            }));
        };
    }
}

customElements.define("ui-skillchip", SkillChip);

