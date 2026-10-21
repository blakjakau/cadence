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

        // Delegated link handling: the body is re-rendered wholesale on every
        // `update()`, so a single listener on the (stable) body element is the
        // only way to intercept clicks without re-wiring after each render.
        //
        // Both the primary (`click`) and middle (`auxclick`) buttons route to the
        // same handler: a click on a RELATIVE link opens the target in a new tab
        // (or focuses the existing tab if it's already open). We also
        // preventDefault on `mousedown` for middle-clicks to stop the browser's
        // native "open in new tab" default (which would otherwise open a broken
        // relative URL in a new browser tab).
        this.body.addEventListener("click", (e) => this._onBodyClick(e));
        this.body.addEventListener("auxclick", (e) => this._onBodyClick(e));
        this.body.addEventListener("mousedown", (e) => {
            if (e.button === 1 && e.target.closest("a")) e.preventDefault();
        });
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

    /**
     * Delegated click handler for rendered markdown links. Both the primary
     * (`click`) and middle (`auxclick`) buttons route here.
     *
     * - A RELATIVE link opens the target in a new editor tab (or focuses the
     *   existing tab if one is already open for that path).
     * - `http(s)://` / protocol-relative `//` opens in a new browser tab.
     * - `mailto:` / `tel:` hands off to the OS handler.
     * - `javascript:` / `data:` are ignored (unsafe, do nothing).
     * - `#anchor` smooth-scrolls the preview body to the heading.
     *
     * The default action is always prevented so the SPA never navigates.
     */
    _onBodyClick(e) {
        const a = e.target.closest("a");
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();

        const href = a.getAttribute("href");
        if (!href) return;

        // Pure in-page anchor: smooth-scroll the preview body.
        if (href.startsWith("#")) {
            this._scrollToAnchor(href.slice(1));
            return;
        }

        // External web links: open in a new browser tab.
        if (/^(https?:)?\/\//i.test(href)) {
            window.open(href, "_blank", "noopener");
            return;
        }

        // mailto: / tel: → hand off to the OS handler.
        if (/^(mailto|tel):/i.test(href)) {
            window.location.href = href;
            return;
        }

        // javascript: / data: → unsafe, ignore entirely.
        if (/^(javascript|data):/i.test(href)) return;

        // Relative file link.
        // Strip any trailing #anchor / ?query before resolving the path.
        const hashIdx = href.indexOf("#");
        const queryIdx = href.indexOf("?");
        let pathPart = href;
        const cut = [hashIdx, queryIdx].filter((i) => i >= 0);
        if (cut.length) {
            pathPart = href.slice(0, Math.min(...cut));
        }
        if (!pathPart) return; // e.g. href was only a query with no path

        const basePath = this.activeTab?.config?.path;
        const resolved = this._resolvePath(basePath, pathPart);
        if (resolved === null) return;

        // Open the target in a new tab (or focus the existing tab if one is
        // already open for this path). `openFileHandle` handles both cases.
        if (window.ui?.openFileHandle) {
            window.ui.openFileHandle(resolved, resolved, window.ui.currentEditor);
        }
    }

    /**
     * Resolve a relative `href` against the directory of `basePath`.
     * Returns a normalized workspace-relative path, or `null` if it cannot be
     * resolved (e.g. the active tab is an in-memory tab with no real path).
     */
    _resolvePath(basePath, href) {
        if (!basePath) return null;
        const base = basePath.replace(/\\/g, "/");
        const hrefNorm = href.replace(/\\/g, "/");

        // Absolute workspace path (leading /) → use as-is (strip the leading /).
        let parts;
        if (hrefNorm.startsWith("/")) {
            parts = hrefNorm.slice(1).split("/");
        } else {
            const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
            const baseParts = dir ? dir.split("/") : [];
            parts = baseParts.concat(hrefNorm.split("/"));
        }

        // Normalize ./ and ../ segments.
        const out = [];
        for (const seg of parts) {
            if (!seg || seg === ".") continue;
            if (seg === "..") {
                if (out.length) out.pop();
                continue;
            }
            out.push(seg);
        }
        return out.join("/");
    }

    /**
     * Smooth-scroll the preview body to the element with the given id.
     */
    _scrollToAnchor(id) {
        if (!id) return;
        const el = this.body.querySelector("#" + CSS.escape(id));
        if (el) el.scrollIntoView({ behavior: "smooth" });
    }
}

customElements.define("ui-markdown-preview-panel", MarkdownPreviewPanel);
