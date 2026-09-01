// elements/skill-editor.mjs
import { Block, Inline } from './element.mjs';
import { Input } from './input.mjs';
import { Button } from './button.mjs';

export class SkillEditor extends Block {
    constructor(skill = null, aiManager, onSave) {
        super();
        this.aiManager = aiManager;
        this.onSave = onSave;
        this.className = 'skill-editor';
        this.existingSkill = skill;

        // Header
        // Header
        const header = new Block();
        header.classList.add('skill-editor-header');

        const backBtn = new Button('Back');
        backBtn.icon = 'arrow_back';
        backBtn.className = 'theme-button secondary skill-editor-back';
        backBtn.onclick = () => this.dispatchEvent(new CustomEvent('editor-close', { bubbles: true, composed: true }));
        header.append(backBtn);

        const title = new Inline();
        title.textContent = skill ? `Edit Skill: ${skill.name}` : 'Create New Skill';
        title.classList.add('skill-editor-title');
        header.append(title);
        this.append(header);

        // Name field
        this.nameInput = new Input();
        this.nameInput.label = 'Skill Name';
        this.nameInput.placeholder = 'my-skill';
        this.nameInput.value = skill?.name || '';
        if (skill) this.nameInput.disabled = true; // Can't rename existing skills
        this.append(this.nameInput);

        // Description field
        this.descInput = new Input();
        this.descInput.label = 'Description';
        this.descInput.placeholder = 'A brief description of what this skill does...';
        this.descInput.value = skill?.metadata?.description || '';
        this.append(this.descInput);

        // Body textarea
        this.bodyContainer = new Block();
        this.bodyContainer.classList.add('skill-editor-body-container');
        this.bodyTextarea = document.createElement('textarea');
        this.bodyTextarea.className = 'skill-editor-body';
        this.bodyTextarea.placeholder = 'Skill body content...';
        this.bodyTextarea.value = skill?.body || '';
        this.bodyContainer.append(this.bodyTextarea);
        this.append(this.bodyContainer);

        // Action buttons
        const actions = new Block();
        actions.classList.add('skill-editor-actions');

        this.aiAssistButton = new Button("AI Assist");
        this.aiAssistButton.icon = "auto_awesome";
        this.aiAssistButton.className = 'theme-button secondary';
        this.aiAssistButton.onclick = () => this._generateSkillFromPrompt();
        actions.append(this.aiAssistButton);

        this.saveButton = new Button(skill ? 'Update' : 'Create');
        this.saveButton.icon = skill ? 'update' : 'save';
        this.saveButton.className = 'theme-button';
        this.saveButton.onclick = () => this._save();
        actions.append(this.saveButton);

        this.append(actions);
    }

    async _generateSkillFromPrompt() {
        const description = await window.modal.prompt(
            "Describe what this skill should do:",
            "AI Assist - New Skill",
            ""
        );
        if (!description) return;

        this.aiAssistButton.disabled = true;
        this.aiAssistButton.icon = "sync";
        this.aiAssistButton.textContent = "Generating...";

        try {
            const connection = await this._getAvailableConnection();
            if (!connection) {
                await window.modal.notice("No AI connection is configured. Please set up an AI provider in Settings.", "AI Not Available");
                return;
            }

            const systemPrompt = `You are a skill definition generator. Generate a skill definition with YAML frontmatter and body content.

Output format must be:
---
name: <skill-name>
description: "<one-line description>"
---
<Skill body content with instructions, guidelines, or context>

The skill should: ${description}

Only output the SKILL.md content, nothing else. Do NOT wrap the output in markdown code blocks.`;

            const messages = [{ role: "user", content: description }];

            let llmResponse = "";
            await new Promise((resolve, reject) => {
                connection.chat(messages, {
                    onUpdate: (response) => { llmResponse = response; },
                    onDone: () => resolve(),
                    onError: (err) => reject(err),
                }, systemPrompt);
            });

            // Parse the LLM response
            const parsed = this._parseSkillContent(llmResponse);
            if (parsed) {
                this.nameInput.value = parsed.name;
                this.descInput.value = parsed.description;
                this.bodyTextarea.value = parsed.body;
                window.modal.toast("Skill content generated!");
            } else {
                await window.modal.notice("Failed to parse LLM output. Please edit manually.", "Parse Error");
            }
        } catch (err) {
            console.error("AI Assist error:", err);
            await window.modal.notice(`Error generating skill: ${err.message}`, "Generation Error");
        } finally {
            this.aiAssistButton.disabled = false;
            this.aiAssistButton.icon = "auto_awesome";
            this.aiAssistButton.textContent = "AI Assist";
        }
    }

    _parseSkillContent(text) {
        // Try to parse YAML frontmatter
        const match = text.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n?([\s\S]*)$/);
        if (match) {
            const yamlText = match[1];
            const body = match[2].trim();
            const metadata = {};
            const lines = yamlText.split("\n");
            for (const line of lines) {
                const colonIdx = line.indexOf(":");
                if (colonIdx !== -1) {
                    const key = line.substring(0, colonIdx).trim().toLowerCase();
                    let val = line.substring(colonIdx + 1).trim();
                    // Remove surrounding quotes if present
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    metadata[key] = val;
                }
            }
            return {
                name: metadata.name || '',
                description: metadata.description || '',
                body: body
            };
        }

        // Fallback: if no frontmatter, use the whole text as body
        return {
            name: this.nameInput.value || 'new-skill',
            description: this.descInput.value || '',
            body: text.trim()
        };
    }

    async _getAvailableConnection() {
        const AIConnections = (await import('../ai-connections.mjs')).AIConnections;
        const connections = AIConnections.getConnections().filter(c => {
            const inst = AIConnections.getInstance(c.id);
            return inst && inst.isConfigured();
        });
        if (connections.length > 0) {
            return AIConnections.getInstance(connections[0].id);
        }
        return null;
    }

    async _save() {
        const name = this.nameInput.value.trim();
        if (!name) {
            await window.modal.notice("Skill name is required.", "Validation Error");
            return;
        }

        const description = this.descInput.value.trim();
        const body = this.bodyTextarea.value.trim();

        // Build the SKILL.md content
        let content = '---\n';
        content += `name: ${name}\n`;
        if (description) content += `description: "${description.replace(/"/g, '\\"')}"\n`;
        content += '---\n';
        if (body) content += body + '\n';

        // Determine save path
        const folders = window.workspace?.folders || [];
        const saveRoot = folders.length > 0 ? `${folders[0]}/.agents/skills` : null;

        if (!saveRoot) {
            await window.modal.notice("No workspace folder open. Please open a folder first.", "No Workspace");
            return;
        }

        const skillDir = `${saveRoot}/${name}`;
        const skillPath = `${skillDir}/SKILL.md`;

        try {
            // Check for duplicate name (if creating new)
            if (!this.existingSkill) {
                const allSkills = await this.aiManager._loadAllParsedSkills();
                const duplicate = allSkills.find(s => s.name.toLowerCase() === name.toLowerCase());
                if (duplicate) {
                    await window.modal.notice(`A skill named "${duplicate.name}" already exists.`, "Duplicate Skill");
                    return;
                }
            }

            // Base64 encode content
            const base64Content = btoa(unescape(encodeURIComponent(content)));

            // Save the file
            const result = await window.conduit.wsWrite(skillPath, base64Content);
            if (result && result.error) {
                throw new Error(result.error);
            }

            await window.modal.toast(this.existingSkill ? `"${name}" updated!` : `"${name}" created!`);

            // Notify parent to refresh
            if (this.onSave) {
                this.onSave();
            }
        } catch (err) {
            console.error("Skill save error:", err);
            await window.modal.notice(`Failed to save skill: ${err.message}`, "Save Error");
        }
    }
}

customElements.define("ui-skill-editor", SkillEditor);