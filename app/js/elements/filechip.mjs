// elements/filechip.mjs
import { Button } from './button.mjs';
import { Icon } from './icon.mjs';

export class FileChip extends Button {
    constructor(config) {
        super();
        
        if (config) {
            this.config = config;
            this.id = `filechip-${config.id}`;
            const textContent = `${config.filename} (${(config.content.length / 1024).toFixed(1)} KB)`;
            this.setAttribute('title', textContent);
            
            const textElement = document.createElement('span');
            textElement.textContent = config.filename;
            this._textElement = textElement;
        } else {
            // Handle cases where it's created via HTML tag
            const filename = this.getAttribute('filename') || this.getAttribute('data-filename');
            const path = this.getAttribute('path') || this.getAttribute('data-path');
            this.id = `filechip-${path || 'unknown'}`;
            
            const textElement = document.createElement('span');
            textElement.textContent = filename || '';
            this._textElement = textElement;
            
            if (path) {
                this.setAttribute('data-path', path);
            }
        }
        
        this._close = new Icon();
        this._close.innerHTML = "close";
        this._close.setAttribute("close", "close");

        this.append(this._textElement, this._close);

        this.onclick = (e) => {
            if (e.target !== this._close) {
                const path = this.getAttribute('data-path') || (this.config && this.config.path);
                if (path) {
                    this.dispatchEvent(new CustomEvent('file-focus-request', {
                        bubbles: true,
                        composed: true,
                        detail: { path }
                    }));
                }
            }
        };

        this._close.onclick = (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('chip-close', {
                bubbles: true,
                composed: true
            }));
        };

        // On pointer down, prevent default browser actions like paste/auto-scroll.
        this.addEventListener('pointerdown', (e) => {
            if (e.button === 1) { // 1 is for the middle mouse button
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // On pointer up, trigger the close action. This separation is key to preventing the OS paste.
        this.addEventListener('pointerup', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                this._close.click(); // Trigger the close button's click handler
            }
        });
    }
}

customElements.define("ui-filechip", FileChip);
