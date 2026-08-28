// elements/rootchip.mjs
import { Button } from './button.mjs';
import { Icon } from './icon.mjs';

export class RootChip extends Button {
    constructor(config) {
        super();

        if (config) {
            this.config = config;
            this.id = config.id || `rootchip-${config.name}`;
            this.className = 'root-chip';
            if (config.path) {
                this.setAttribute('title', config.path);
            }

            const iconElement = new Icon();
            iconElement.innerHTML = "folder";
            iconElement.classList.add('root-chip-icon');

            const textElement = document.createElement('span');
            textElement.textContent = config.name;
            this._textElement = textElement;

            this.append(iconElement, this._textElement);
        }

        this._close = new Icon();
        this._close.innerHTML = "close";
        this._close.setAttribute("close", "close");

        this.append(this._close);

        this._close.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('root-remove-request', {
                bubbles: true,
                composed: true,
                detail: { rootPath: this.config.path || this.config.name }
            }));
        };
    }
}

customElements.define("ui-rootchip", RootChip);
