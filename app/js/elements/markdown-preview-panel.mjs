import { Block } from './element.mjs';
import { Button } from './button.mjs';

/**
 * Renders the active tab's markdown file as a formatted HTML preview.
 *
 * Mirrors the DiffViewPanel pattern: a full-height overlay panel inside the
 * EditorHolder that is shown/hidden via `style.display` by `updateEditorUI`.
 * The content is rendered with the app-wide markdown-it instance (same one the
 * AI chat uses, configured with highlight.js), so code blocks get the same
 * syntax highlighting as chat responses.
 *
 * markdown-it escapes raw HTML in the source by default, so previewing an
 * arbitrary file cannot inject live markup or scripts into the document.
 */
export class MarkdownPreviewPanel extends Block {
    constructor() {
        super();

        this.classList.add("markdown-preview-panel");

        // Header bar: icon + title + an "Edit" button to jump back to the editor.
        this.header = document.createElement("div");
        this.header.className = "md-preview-header";

        const headerLeft = document.createElement("div");
        headerLeft.className = "md-preview-header-left";

        const icon = document.createElement("ui-icon");
        icon.textContent = "article";

        this.titleSpan = document.createElement("span");
        this.titleSpan.className = "md-preview-header-title";
        this.titleSpan.textContent = "Markdown Preview";

        headerLeft.appendChild(icon);
        headerLeft.appendChild(this.titleSpan);

        this.editBtn = new Button("Edit");
        this.editBtn.className = "nav-btn";
        this.editBtn.icon = "edit";
        this.editBtn.title = "Back to editor (Alt+P)";
        this.editBtn.onclick = (e) => {
            e.stopPropagation();
            if (typeof this.onEdit === "function") this.onEdit();
        };

        this.header.appendChild(headerLeft);
        this.header.appendChild(this.editBtn);

        // Scrollable rendered body.
        this.body = document.createElement("div");
        this.body.className = "md-preview-body markdown-body";

        this.append(this.header);
        this.append(this.body);

        this.activeTab = null;
        this._md = null;
    }

        connectedCallback() {
            super.connectedCallback();
            // The root panel clips its own overflow (see the `overflow: hidden`
            // rule in diff-view.css); the `.md-preview-body` child handles
            // scrolling, so no inline overflow override is needed here.
            this.style.display = "none";
        }

    _getRenderer() {
        // Reuse the AI manager's markdown-it instance (configured with hljs).
        // Fall back to a locally-built instance if the AI manager is not up yet.
        if (!this._md) {
            const managerMd = window.ui?.aiManager?.md;
            if (managerMd) {
                this._md = managerMd;
            } else if (typeof window.markdownit === "function") {
                this._md = window.markdownit({
                    highlight: function (str, lang) {
                        if (lang && window.hljs && window.hljs.getLanguage(lang)) {
                            return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
                        }
                        return '';
                    }
                });
            }
        }
        return this._md;
    }

    /**
     * Render `tab`'s markdown content into the preview body.
     * `tab` carries the ace session (live, unsaved content) and its config.
     */
    update(tab) {
        this.activeTab = tab;
        const session = tab?.config?.session;
        const text = session ? session.getValue() : (tab?.config?.rawData || "");

        this.titleSpan.textContent = tab?.config?.name || "Markdown Preview";

        // The in-memory "History preview" tab (ALT+H) is read-only and always
        // presented as rendered markdown, so hide the "Edit" button there.
        const isReadOnly = tab?.config?.path === "history_preview";
        this.header.classList.toggle("readonly", isReadOnly);

        const md = this._getRenderer();
        if (!md || !text) {
            this.body.innerHTML = `<div class="md-preview-empty">Nothing to preview yet.</div>`;
            return;
        }
        this.body.innerHTML = md.render(text);
    }
}

customElements.define("ui-markdown-preview-panel", MarkdownPreviewPanel);
