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
            const line = this.getAttribute('line') || this.getAttribute('data-line');
            this.id = `filechip-${path || 'unknown'}${line ? `-${line}` : ''}`;
            
            const textElement = document.createElement('span');
            textElement.textContent = filename || '';
            this._textElement = textElement;
            
            if (path) {
                this.setAttribute('data-path', path);
            }
            if (line) {
                this.setAttribute('data-line', line);
            }
        }
        
        this._close = new Icon();
        this._close.innerHTML = "close";
        this._close.setAttribute("close", "close");

        this._modeToggle = document.createElement('span');
        this._modeToggle.classList.add('chip-mode-toggle');
        // Default to Full. If config passed with mode outline, use that.
        this._modeToggle.textContent = (config && config.mode === 'outline') ? '[Outline]' : '[Full]';
        this._modeToggle.style.marginRight = '5px';
        this._modeToggle.style.cursor = 'pointer';
        this._modeToggle.style.fontSize = '10px';
        this._modeToggle.style.color = 'var(--text-secondary)';
        
        this._modeToggle.onclick = (e) => {
            e.stopPropagation();
            const newMode = this._modeToggle.textContent === '[Full]' ? 'outline' : 'full';
            this._modeToggle.textContent = newMode === 'outline' ? '[Outline]' : '[Full]';
            this.dispatchEvent(new CustomEvent('chip-mode-toggle', {
                bubbles: true,
                composed: true,
                detail: { mode: newMode }
            }));
        };

        // Idempotency: the constructor always (re)builds its own toggle/text/close children.
        // When the element is created from an HTML string that already carries children
        // (e.g. a pre-built chip embedded in markdown), those would otherwise survive the
        // parse and this append would duplicate the whole set. Clear them first.
        this.innerHTML = "";
        this.append(this._modeToggle, this._textElement, this._close);

        this.onclick = (e) => {
            if (e.target !== this._close) {
                e.stopPropagation();
                const path = this.getAttribute('data-path') || this.getAttribute('path') || (this.config && this.config.path);
                const lineAttr = this.getAttribute('data-line') || this.getAttribute('line') || (this.config && this.config.line);
                const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
                if (path) {
                    this.dispatchEvent(new CustomEvent('file-focus-request', {
                        bubbles: true,
                        composed: true,
                        detail: { 
                            path,
                            line: (!isNaN(line) && line > 0) ? line : undefined
                        }
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

    connectedCallback() {
        // Idempotency guard: ensure exactly one set of toggle/text/close children.
        // The constructor already clears + appends its own set; if this element is
        // (re)created from an HTML string that carries pre-built children, or is ever
        // re-connected after a partial re-render, strip any extras so the content is
        // never rendered twice.
        const canonical = [this._modeToggle, this._textElement, this._close];
        for (const child of [...this.children]) {
            if (!canonical.includes(child)) child.remove();
        }
        // Re-adopt the canonical set in order (no-op if already present and ordered).
        for (const el of canonical) this.append(el);

        if (!this.config) {
            const filename = this.getAttribute('filename') || this.getAttribute('data-filename');
            const path = this.getAttribute('path') || this.getAttribute('data-path');
            const line = this.getAttribute('line') || this.getAttribute('data-line');
            if (filename && this._textElement && !this._textElement.textContent) {
                this._textElement.textContent = filename;
            }
            if (path && !this.getAttribute('data-path')) {
                this.setAttribute('data-path', path);
            }
            if (line && !this.getAttribute('data-line')) {
                this.setAttribute('data-line', line);
            }
            if (path && (!this.id || this.id.includes('unknown'))) {
                this.id = `filechip-${path}${line ? `-${line}` : ''}`;
            }
        }
    }
}

customElements.define("ui-filechip", FileChip);
