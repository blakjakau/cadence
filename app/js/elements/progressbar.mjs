import { Block } from './element.mjs';

/**
 * A custom progress bar element that extends Block.
 * It manages an inner element to display progress and updates its color based on value.
 */
export class ProgressBar extends Block {
    constructor() {
        super();
        this.classList.add('progress-bar');
        
        // The inner element that visually represents the progress
        this._inner = document.createElement('div');
        this._inner.classList.add('progress-bar-inner');
        this.append(this._inner);

        this._value = 0;
    }

    /**
     * Sets the progress value (0-100).
     * @param {number} v - The progress percentage.
     */
    set value(v) {
        const clampedValue = Math.max(0, Math.min(100, v));
        this._value = clampedValue;
        this._inner.style.width = `${clampedValue}%`;
        this._updateColor(clampedValue);
    }

    /**
     * Gets the current progress value.
     * @returns {number} The progress percentage.
     */
    get value() {
        return this._value;
    }

    /**
     * Updates the progress bar's color based on the value.
     * This logic is now nicely contained within the component!
     * @param {number} percentage - The progress percentage.
     * @private
     */
    _updateColor(percentage) {
        // Remove all color classes first
        this._inner.classList.remove('threshold-yellow', 'threshold-orange', 'threshold-red');

        if (percentage >= 90) {
            this._inner.classList.add('threshold-red');
        } else if (percentage >= 80) {
            this._inner.classList.add('threshold-orange');
        } else if (percentage >= 66) {
            this._inner.classList.add('threshold-yellow');
        }
        // Below 66%, it defaults to the theme color from CSS.
    }
}

// Register the custom element for fun and profit (and potential direct use in HTML)
if (!customElements.get('ui-progress-bar')) {
    customElements.define('ui-progress-bar', ProgressBar);
}
