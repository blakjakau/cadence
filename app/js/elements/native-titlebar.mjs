import { Block, Inline } from './element.mjs';
import { Button } from './button.mjs';

export class NativeTitleBar extends Block {
    constructor() {
        super();
        this.setAttribute("id", "native-titlebar");
        
        const title = new Inline("Cadence");
        title.classList.add("window-title");
        
        const controls = new Block();
        controls.classList.add("window-controls");

        const minBtn = new Button();
        minBtn.icon = "remove";
        minBtn.on("click", () => window.runtime?.WindowMinimise());
        
        const maxBtn = new Button();
        maxBtn.icon = "check_box_outline_blank";
        maxBtn.on("click", () => window.runtime?.WindowToggleMaximise());
        
        const closeBtn = new Button();
        closeBtn.icon = "close";
        closeBtn.classList.add("close-btn");
        closeBtn.on("click", () => window.runtime?.Quit());
        
        controls.append(minBtn, maxBtn, closeBtn);
        this.controls = controls;
        this.append(title, controls);
    }
    
    getControls() {
        return this.controls;
    }
}

customElements.define("native-titlebar", NativeTitleBar);
