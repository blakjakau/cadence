import { Block, Button, Inline, Panel, SidebarPanel, TabBar, TabItem, FileBar } from "../elements.mjs";
import agenticManager from "./agent-manager.mjs";

/**
 * UI for the CodeAgent.
 */
class AgenticUI {
    constructor() {
        this.panel = null;
        this.chatArea = null;
        this.inputArea = null;
        this.promptEditor = null;
        this.planningToggle = null;
    }

    init(panel) {
        this.panel = panel;
        this.panel.classList.add('agentic-panel');
        
        this._createUI();
        this._initPromptEditor();
        
        // Connect to manager
        agenticManager.onUpdate = () => this.render();
        agenticManager.onConsentRequired = (count) => this.onConsentRequired(count);
        this.render();
    }

    _createUI() {
        // Toolbar
        const toolbar = new Block();
        toolbar.classList.add('agentic-toolbar');
        
        const clearBtn = new Button("Clear");
        clearBtn.icon = "delete_sweep";
        clearBtn.onclick = () => agenticManager.clearHistory();

        const stopBtn = new Button("Stop");
        stopBtn.icon = "stop_circle";
        stopBtn.onclick = () => agenticManager.stop();
        
        this.planningToggle = document.createElement('div');
        this.planningToggle.classList.add('agentic-toggle-container');
        this.planningToggle.innerHTML = `
            <label class="switch">
                <input type="checkbox" checked id="planning-switch">
                <span class="slider round"></span>
            </label>
            <span class="toggle-label">Plan Only</span>
        `;
        const switchInput = this.planningToggle.querySelector('input');
        switchInput.onchange = (e) => {
            agenticManager.planOnly = e.target.checked;
        };

        toolbar.append(clearBtn);
        toolbar.append(stopBtn);
        // toolbar.append(new Inline("&nbsp;&nbsp;"));
        // toolbar.append(this.planningToggle);

        // Chat History Area
        this.chatArea = new Block();
        this.chatArea.classList.add('agentic-chat-area');

        // Input Area
        const inputWrap = new Block();
        inputWrap.classList.add('agentic-input-wrap');
        
        this.promptArea = document.createElement('div');
        this.promptArea.classList.add('agentic-prompt-editor');
        this.promptArea.id = 'agentic-prompt-editor';
        
        const submitBtn = new Button("");
        submitBtn.icon = "send";
        submitBtn.classList.add('agentic-submit-btn');
        submitBtn.onclick = () => {
            const val = this.promptEditor ? this.promptEditor.getValue().trim() : "";
            if (val) {
                agenticManager.submit(val);
                if (this.promptEditor) this.promptEditor.setValue("");
            }
        };

        inputWrap.append(this.promptArea);
        inputWrap.append(submitBtn);

        this.panel.append(toolbar);
        this.panel.append(this.chatArea);
        const bottomWrap = new Block();
        bottomWrap.classList.add('agentic-bottom-wrap');
        bottomWrap.append(this.planningToggle);
        bottomWrap.append(inputWrap);
        this.panel.append(bottomWrap);
    }

    async onConsentRequired(count) {
        return await this.showConsentPrompt(count);
    }

    async showConsentPrompt(count) {
        return new Promise((resolve) => {
            const banner = new Block();
            banner.classList.add('agentic-consent-banner');
            
            const text = document.createElement('span');
            text.innerText = `Agent has performed ${count} actions. Continue?`;
            
            const continueBtn = new Button("Continue");
            continueBtn.onclick = () => {
                banner.remove();
                resolve(true);
            };

            const stopBtn = new Button("Stop");
            stopBtn.onclick = () => {
                banner.remove();
                resolve(false);
            };

            banner.append(text);
            banner.append(continueBtn);
            banner.append(stopBtn);
            
            // Insert at the top of the chat area
            this.chatArea.prepend(banner);
        });
    }

    _initPromptEditor() {
        if (!window.ace || !this.promptArea) return;

        this.promptEditor = ace.edit(this.promptArea);
        this.promptEditor.session.setMode("ace/mode/markdown");
        this.promptEditor.setOptions({
            useSoftTabs: false,
            tabSize: 4,
            fontSize: 12,
            fontFamily: "roboto mono",
            minLines: 3,
            maxLines: 15,
            wrap: true,
            showGutter: false,
            highlightActiveLine: false,
            showPrintMargin: false,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            placeholder: "Ask CodeAgent to do something... (use @ to tag files)"
        });

        // Sync theme with main editor if available
        if (window.editors && window.editors.length > 0) {
            this.promptEditor.setTheme(window.editors[0].getTheme());
        }

        this.promptEditor.commands.addCommand({
            name: "submitPrompt",
            bindKey: { win: "Enter", mac: "Enter" },
            exec: (editor) => {
                // If the autocompleter is active, let it handle the Enter key
                if (editor.completer && editor.completer.activated) {
                    return false; // Let ACE handle it
                }
                const val = editor.getValue().trim();
                if (val) {
                    agenticManager.submit(val);
                    editor.setValue("");
                }
            },
            readOnly: false
        });

        // Add Shift-Enter for new lines
        this.promptEditor.commands.addCommand({
            name: "newLine",
            bindKey: { win: "Shift-Enter", mac: "Shift-Enter" },
            exec: (editor) => editor.insert("\n"),
            readOnly: false
        });

        // Custom Autocompleter for @file context
        const fileContextCompleter = {
            identifierRegexps: [/@[\w.]*/],
            getCompletions: (editor, session, pos, prefix, callback) => {
                const line = session.getLine(pos.row).substring(0, pos.column);
                const match = line.match(/@(\S*)$/);
                if (!match) return callback(null, []);

                const searchTerm = prefix;
                const fileResults = window.ui.fileList.find(searchTerm, 20);
                const fileCompletions = fileResults.map(item => ({
                    caption: item.name,
                    value: item.path,
                    meta: "File Context"
                }));

                const defaultContextOptions = [
                    { value: 'open', caption: '@open', meta: 'All open files' },
                    { value: 'code', caption: '@code', meta: 'Current file/selection' }
                ];
                const filteredDefaults = defaultContextOptions.filter(opt =>
                    opt.caption.startsWith(`@${searchTerm}`)
                );

                callback(null, [...filteredDefaults, ...fileCompletions]);
            }
        };

        this.promptEditor.completers = [fileContextCompleter];
        this.promptEditor.resize();
    }

    render() {
        if (!this.chatArea) return;
        
        this.chatArea.innerHTML = "";
        
        if (agenticManager.history.length === 0) {
            const empty = new Block("Agentic coding is separate from chat. Use it for surgical changes, refactors, or exploration.");
            empty.classList.add('agentic-empty-state');
            this.chatArea.append(empty);
            return;
        }

        agenticManager.history.forEach((msg, idx) => {
            const msgBlock = new Block();
            msgBlock.classList.add('agentic-msg', `role-${msg.role || 'system'}`);
            
            if (msg.role === 'user') {
                msgBlock.innerHTML = `<div class="msg-header">USER</div><div class="msg-content">${this._escapeHTML(msg.content)}</div>`;
            } else if (msg.role === 'model') {
                msgBlock.innerHTML = `<div class="msg-header">CODEAGENT</div><div class="msg-content">${this._formatModelResponse(msg.content)}</div>`;
            } else {
                msgBlock.innerHTML = `<div class="msg-system">${msg.content}</div>`;
            }
            
            this.chatArea.append(msgBlock);
        });

        // Scroll to bottom
        setTimeout(() => {
            this.chatArea.scrollTop = this.chatArea.scrollHeight;
        }, 50);
    }

    _formatModelResponse(content) {
        if (!content) return "...";
        
        // 1. Escape everything first to prevent XSS and ensure we control the HTML
        let html = this._escapeHTML(content);
        
        // 2. Re-inject controlled HTML for special Agent blocks
        // Highlight thinking/thought blocks
        html = html.replace(/\[thought\]([\s\S]*?)\[\/thought\]/gi, '<div class="agent-thought">$1</div>');
        html = html.replace(/&lt;thought&gt;([\s\S]*?)&lt;\/thought&gt;/gi, '<div class="agent-thought">$1</div>');
        
        // Tool calls placeholders
        html = html.replace(/\[Tool Call: (.*?)\]/g, '<div class="agent-tool-call">Tool Call: <b>$1</b></div>');
        
        // 3. Handle our new Code Output Rules (The Structured Prompting)
        // Update Headers
        html = html.replace(/### UPDATE: (.*?)\n/g, '<div class="agent-file-header update">FILE: $1</div>');
        html = html.replace(/### CREATE: (.*?)\n/g, '<div class="agent-file-header create">NEW FILE: $1</div>');
        
        // Diff Blocks (Simplified: just wrap in a pre-tag for now)
        html = html.replace(/```diff([\s\S]*?)```/g, '<pre class="agent-diff-block"><code>$1</code></pre>');
        
        // Standard Code Blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="agent-code-block"><code>$2</code></pre>');

        return html.replace(/\n/g, '<br/>');
    }

    _escapeHTML(str) {
        return str.replace(/[&<>"']/g, function(m) {
            switch (m) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#039;';
                default: return m;
            }
        });
    }
}

const agenticUI = new AgenticUI();
export default agenticUI;
