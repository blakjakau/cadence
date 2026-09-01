// elements/skillpicker.mjs
import { Block } from './element.mjs';
import { Input } from './input.mjs';
import { Button } from './button.mjs';
import { SkillItem } from './skillitem.mjs';
import { SkillEditor } from './skill-editor.mjs';
import workspaceClient from '../workspace-client.mjs';

export class SkillPicker extends Block {
    constructor(aiManager) {
        super();
        this.aiManager = aiManager;
        this.className = 'skill-picker';

        this.searchContainer = new Block();
        this.searchContainer.classList.add('skill-picker-search-container');
        this.searchInput = new Input();
        this.searchInput.placeholder = "Search skills...";
        this.searchContainer.append(this.searchInput);

        this.mainContainer = new Block();
        this.mainContainer.classList.add('skill-picker-main');

        this.listContainer = new Block();
        this.listContainer.classList.add('skill-picker-list');

        // Editor container (hidden initially)
        this.editorContainer = new Block();
        this.editorContainer.classList.add('skill-picker-editor');
        this.editorContainer.style.display = 'none';

        this.mainContainer.append(this.listContainer, this.editorContainer);
        this.append(this.searchContainer, this.mainContainer);

        this.searchInput.on('input', () => this.filterSkills());

        // Initial load
        this.filterSkills();
    }

    showEditor(skill = null) {
        this.listContainer.style.display = 'none';
        this.searchContainer.style.display = 'none';
        this.editorContainer.style.display = 'block';
        this.editorContainer.innerHTML = '';

        const editor = new SkillEditor(skill, this.aiManager, () => this.closeEditor());
        editor.on('editor-close', () => this.closeEditor());
        this.editorContainer.append(editor);
    }

    closeEditor() {
        this.editorContainer.innerHTML = '';
        this.editorContainer.style.display = 'none';
        this.listContainer.style.display = 'block';
        this.searchContainer.style.display = 'block';
        this.filterSkills(); // Refresh the list
    }

    async filterSkills() {
        const query = this.searchInput.value.toLowerCase();
        const allSkills = await this.aiManager._loadAllParsedSkills();
        const filtered = allSkills.filter(s => s.name.toLowerCase().includes(query));

        this.listContainer.innerHTML = '';
        for (const skill of filtered) {
            const isPinned = this.aiManager.activeSession?.pinnedSkills?.includes(skill.name) || false;
            const item = new SkillItem(skill, isPinned);
            item.on('skill-add-context', (e) => this.handleAddContext(e.detail.skill));
            item.on('skill-pin-toggle', (e) => this.handlePinToggle(e.detail));
            item.on('skill-edit', (e) => this.showEditor(e.detail.skill));
            this.listContainer.append(item);
        }
    }

    async handleAddContext(skill) {
        if (!this.aiManager.activeSession) {
            window.modal.notice("No active session to add skills to.", "Error");
            return;
        }

        const session = this.aiManager.activeSession;
        const message = {
            role: "system",
            type: "skill_context",
            content: `[SKILL ACTIVATED: ${skill.name}]\n${skill.body}`,
            timestamp: Date.now(),
            id: crypto.randomUUID()
        };

        session.messages.push(message);
        await workspaceClient.setSession(session.id, session);
        
        // Trigger UI update in AIManager
        this.aiManager._dispatchContextUpdate("append_user");
        window.modal.toast(`Skill "${skill.name}" added to context.`);
    }

    async handlePinToggle({ name, pinned }) {

        if (!this.aiManager.activeSession) return;

        const session = this.aiManager.activeSession;
        if (!session.pinnedSkills) session.pinnedSkills = [];

        if (pinned) {
            if (!session.pinnedSkills.includes(name)) {
                session.pinnedSkills.push(name);
            }
        } else {
            session.pinnedSkills = session.pinnedSkills.filter(s => s !== name);
        }

        await workspaceClient.setSession(session.id, session);
        this.filterSkills(); // Refresh list to show new pin state
        // Update the FileBar to show/hide the skill chip
        if (this.aiManager.historyManager) {
            this.aiManager.historyManager.populateFileBar();
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

customElements.define("ui-skill-picker", SkillPicker);
