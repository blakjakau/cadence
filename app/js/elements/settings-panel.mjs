import { ContentFill, Block } from "./element.mjs";
import { Button } from "./button.mjs";

export class SettingsPanel extends ContentFill {
    constructor() {
        super();
        this.classList.add('settings-panel-content'); // Add a class for styling
        this._schema = null;
    }

    render(schema, values = {}, accordionTitle = "Settings", accordionIcon = "settings", accordionColor = "var(--theme)", liveUpdates = false) {
        this._schema = schema;
        this.innerHTML = '';

        const container = document.createElement("div");
        container.className = "artifacts-accordion-container";
        this.append(container);

        const accordionItem = document.createElement("div");
        accordionItem.className = "accordion-item expanded";

        const header = document.createElement("div");
        header.className = "accordion-header";

        const headerLeft = document.createElement("div");
        headerLeft.className = "header-left";

        const icon = document.createElement("ui-icon");
        icon.textContent = accordionIcon;
        if (accordionColor) icon.style.color = accordionColor;

        const titleSpan = document.createElement("span");
        titleSpan.textContent = accordionTitle;

        headerLeft.append(icon, titleSpan);
        header.append(headerLeft);

        const arrow = document.createElement("ui-icon");
        arrow.className = "expand-arrow";
        arrow.textContent = "expand_less";
        header.append(arrow);

        const content = document.createElement("div");
        content.className = "accordion-content";
        content.style.padding = "20px";

        accordionItem.append(header, content);
        container.append(accordionItem);

        header.onclick = () => {
            const isExpanded = accordionItem.classList.toggle("expanded");
            if (isExpanded) {
                content.style.display = "";
                arrow.style.transform = "rotate(0deg)";
                arrow.textContent = "expand_less";
            } else {
                content.style.display = "none";
                arrow.style.transform = "rotate(180deg)";
                arrow.textContent = "expand_more";
            }
        };

        this._form = document.createElement('form');
        this._form.className = "settings-grid";
        this._form.addEventListener('submit', (e) => e.preventDefault());
        content.append(this._form);

        for (const item of schema) {
            const itemContainer = new Block();
            itemContainer.classList.add('setting-item', `setting-type-${item.type}`);
            
            let label, input;

            if (item.label && item.type !== 'heading') {
                label = document.createElement('label');
                label.textContent = item.label;
                label.setAttribute('for', item.id);
            }

            switch (item.type) {
                case 'heading':
                    const heading = document.createElement('h3');
                    heading.textContent = item.label;
                    itemContainer.append(heading);
                    break;
                case 'text':
                case 'number':
                case 'password':
                    input = document.createElement('input');
                    input.type = item.type;
                    input.id = item.id;
                    input.name = item.id;
                    input.value = values[item.id] || '';
                    if (item.placeholder) input.placeholder = item.placeholder;
                    if (item.readonly) input.disabled = true;
                    if(label) itemContainer.append(label);
                    itemContainer.append(input);
                    break;
                case 'textarea':
                    input = document.createElement('textarea');
                    input.id = item.id;
                    input.name = item.id;
                    input.value = values[item.id] || '';
                    if (item.rows) input.rows = item.rows;
                    if (item.readonly) input.disabled = true;
                    if(label) itemContainer.append(label);
                    itemContainer.append(input);
                    break;
                case 'boolean':
                case 'checkbox':
                    if (label) itemContainer.append(label);
                    const checkboxDedicatedWrapper = new Block();
                    const checkboxDedicatedInnerLabel = document.createElement('label');
                    input = document.createElement('input');
                    input.type = 'checkbox';
                    input.id = item.id;
                    input.name = item.id;
                    input.checked = !!values[item.id];
                    checkboxDedicatedInnerLabel.append(input, ` ${item.text || ''}`);
                    checkboxDedicatedWrapper.append(checkboxDedicatedInnerLabel);
                    itemContainer.append(checkboxDedicatedWrapper);
                    break;
                case 'select':
                    input = document.createElement('select');
                    input.id = item.id;
                    input.name = item.id;
                    if (item.options) {
                        for (const opt of item.options) {
                            const option = document.createElement('option');
                            option.value = opt.value;
                            option.textContent = opt.text;
                            if (values[item.id] === opt.value) {
                                option.selected = true;
                            }
                            input.append(option);
                        }
                    }
                    if (item.onChangeEvent) {
                        input.addEventListener('change', (e) => this.dispatch(item.onChangeEvent, { id: item.id, value: e.target.value }));
                    }
                    if(label) itemContainer.append(label);
                    itemContainer.append(input);
                    break;
                case 'button':
                    if (label) itemContainer.append(label);
                    const button = new Button(item.text || item.label);
                    if (item.icon) button.icon = item.icon;
                    if (item.className) button.classList.add(...item.className.split(' '));
                    if (item.onClickEvent) {
                        button.on('click', () => this.dispatch(item.onClickEvent, { id: item.id, element: button }));
                    }
                    itemContainer.append(button);
                    break;
                case 'info':
                    const info = new Block();
                    info.innerHTML = item.content;
                    itemContainer.append(info);
                    break;
            }

            if (input) {
                const eventName = (item.type === 'checkbox' || item.type === 'boolean' || item.type === 'select') ? 'change' : 'input';
                input.addEventListener(eventName, () => {
                    if (liveUpdates) this._save();
                });
            }

            if (item.help) {
                const helpText = document.createElement('p');
                helpText.className = 'help-text';
                helpText.textContent = item.help;
                itemContainer.append(helpText);
            }
            this._form.append(itemContainer);
        }

        const hasInputs = schema.some(item => ['textarea', 'checkbox', 'select', 'text', 'number', 'password'].includes(item.type));
        if (hasInputs && !liveUpdates) {
            const saveButton = new Button("Save Settings");
            saveButton.icon = "save";
            saveButton.classList.add("theme-button");
            saveButton.on('click', () => this._save());
            this._form.append(saveButton);
        }
    }

    _save() {
        const values = {};
        for (const item of this._schema) {
            if (['textarea', 'checkbox', 'boolean', 'select', 'text', 'number', 'password'].includes(item.type)) {
                const input = this._form.querySelector(`[name="${item.id}"]`);
                if (input) {
                    if (item.type === 'checkbox' || item.type === 'boolean') {
                        values[item.id] = input.checked;
                    } else {
                        values[item.id] = input.value;
                    }
                }
            }
        }
        this.dispatch('settings-saved', values);
    }
}

customElements.define('ui-settings-panel', SettingsPanel);
