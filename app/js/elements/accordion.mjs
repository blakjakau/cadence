import { Block } from './element.mjs';
import { Button } from './button.mjs';

export class UIAccordion extends Block {
    constructor(sectionKey, titleText, iconText, iconColor = null, actions = [], requireSession = true) {
        super();
        this.sectionKey = sectionKey;
        this.classList.add("accordion-item");
        this.classList.add(`${sectionKey}-section`);

        this.header = document.createElement("div");
        this.header.className = "accordion-header";

        const headerLeft = document.createElement("div");
        headerLeft.className = "header-left";

        const icon = document.createElement("ui-icon");
        icon.textContent = iconText;
        if (iconColor) icon.style.color = iconColor;

        const titleSpan = document.createElement("span");
        titleSpan.textContent = titleText;

        headerLeft.appendChild(icon);
        headerLeft.appendChild(titleSpan);
        this.header.appendChild(headerLeft);

        this.rightContainer = document.createElement("div");
        this.rightContainer.className = "header-right";

        this.headerActions = document.createElement("div");
        this.headerActions.className = "header-actions";

        this.actions = [];
        for (const a of actions) {
            const btn = new Button("");
            btn.icon = a.icon || "more_vert";
            btn.className = a.className || "icon-button";
            if (a.title) {
                btn.title = a.title;
                btn.setAttribute("aria-label", a.title);
            }
            if (a.onClick) btn.onclick = a.onClick;
            this.headerActions.appendChild(btn);
            this.actions.push(btn);
        }
        this.editBtn = this.actions[0] || null;
        this.rightContainer.appendChild(this.headerActions);

        this.arrow = document.createElement("ui-icon");
        this.arrow.className = "expand-arrow";
        this.arrow.textContent = "expand_less";
        this.rightContainer.appendChild(this.arrow);
        this.header.appendChild(this.rightContainer);

        this.content = document.createElement("div");
        this.content.className = "accordion-content";

        this.appendChild(this.header);
        this.appendChild(this.content);

        // Click handler to expand/collapse
        this.header.onclick = (e) => {
            if (e.target.closest("button") || e.target.closest(".header-actions")) return;
            if (requireSession) {
                const session = (typeof this.getTargetSession === "function") ? this.getTargetSession() : ui.aiManager.activeSession;
                if (!session) return;
                session._accordionStates = session._accordionStates || { settings: false, plan: true, tasks: true, backups: true, scratchpad: true, workspaces: true };
                session._accordionStates[this.sectionKey] = this.classList.toggle("expanded");
            } else {
                this.classList.toggle("expanded");
            }
            this.applyState(this.classList.contains("expanded"));
        };
    }

    applyState(isExpanded) {
        if (isExpanded) {
            this.classList.add("expanded");
            this.content.style.display = "";
            this.arrow.style.transform = "rotate(0deg)";
            this.arrow.textContent = "expand_less";
        } else {
            this.classList.remove("expanded");
            this.content.style.display = "none";
            this.arrow.style.transform = "rotate(180deg)";
            this.arrow.textContent = "expand_more";
        }
    }
}
customElements.define("ui-accordion", UIAccordion);