import { Panel, Block, Inline, Button, Input } from '../elements.mjs';

/**
 * Example Custom Component demonstrating clean, programmatic DOM assembly
 * and avoidance of inline styles / innerHTML.
 */
export class ExampleArtifactPanel extends Panel {
    constructor() {
        super();
        this.classList.add("example-artifact-panel"); // Style defined in style_example.css

        // 1. Create a Header section using Block and Inline
        const header = new Block();
        header.classList.add("panel-header");

        const title = new Inline("Artifact Manager");
        title.classList.add("panel-title");
        header.appendChild(title);
        this.appendChild(header);

        // 2. Form container and Input element
        const formContainer = new Block();
        formContainer.classList.add("panel-form-container");

        this.artifactInput = new Input();
        this.artifactInput.label = "Artifact Name";
        this.artifactInput.placeholder = "Enter name...";
        formContainer.appendChild(this.artifactInput);
        this.appendChild(formContainer);

        // 3. Actions Row with a Button
        const actionsRow = new Block();
        actionsRow.classList.add("panel-actions-row");

        this.submitBtn = new Button("Create Artifact");
        this.submitBtn.icon = "add"; // Material icon tag
        this.submitBtn.classList.add("theme-button");
        this.submitBtn.onclick = () => this.handleCreateArtifact();

        actionsRow.appendChild(this.submitBtn);
        this.appendChild(actionsRow);
    }

    async handleCreateArtifact() {
        const name = this.artifactInput.value.trim();
        if (!name) {
            window.modal.toast("Artifact name cannot be empty.");
            return;
        }

        const confirmCreate = await window.modal.confirm(
            `Are you sure you want to create artifact "${name}"?`,
            "Confirm Action"
        );

        if (confirmCreate) {
            window.modal.toast(`Successfully created artifact: ${name}`);
            this.artifactInput.value = ""; // Clear input
        }
    }
}

customElements.define("ui-example-artifact-panel", ExampleArtifactPanel);
