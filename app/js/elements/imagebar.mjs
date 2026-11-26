// elements/imagebar.mjs
import { Block } from './element.mjs';
import { Icon } from './icon.mjs';

export class ImageBar extends Block {
    constructor() {
        super();
        this._thumbs = new Map();
        this.style.display = 'none';
    }

    add(image) {
        if (this._thumbs.has(image.id)) {
            return;
        }

        const thumb = new Block();
        thumb.classList.add('image-thumb');
        thumb.setAttribute('data-image-id', image.id);

        const img = document.createElement('img');
        img.src = image.dataUrl;
        img.alt = image.name || 'image';

        const closeBtn = new Icon();
        closeBtn.classList.add('image-thumb-close');
        closeBtn.innerHTML = 'close';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.dispatch('image-remove-request', { imageId: image.id });
        };

        thumb.append(img, closeBtn);
        this._thumbs.set(image.id, thumb);
        this.append(thumb);
        this.style.display = 'flex';
        return thumb;
    }

    remove(imageId) {
        if (this._thumbs.has(imageId)) {
            const thumb = this._thumbs.get(imageId);
            thumb.remove();
            this._thumbs.delete(imageId);
        }

        if (this._thumbs.size === 0) {
            this.style.display = 'none';
        }
    }

    clear() {
        for (const [, thumb] of this._thumbs) {
            thumb.remove();
        }
        this._thumbs.clear();
        this.style.display = 'none';
    }

    get images() {
        return [...this._thumbs.keys()];
    }
}

customElements.define("ui-imagebar", ImageBar);
