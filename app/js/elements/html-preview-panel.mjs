import { Block } from "./element.mjs"
import { Button } from "./button.mjs"

/**
 * Renders the active tab's HTML file in a sandboxed iframe.
 *
 * Mirrors the MarkdownPreviewPanel / DiffViewPanel pattern: a full-height
 * overlay panel inside the EditorHolder that is shown/hidden via
 * `style.display` by `updateEditorUI`. The page is rendered in a single
 * `<iframe>` whose `srcdoc` is set from the live session value.
 *
 * The iframe uses `sandbox="allow-scripts"` so inline page scripts run for a
 * live preview, while the sandbox blocks same-origin access to the host app
 * (no cookies, no parent DOM access, no form submission to the parent).
 */
export class HtmlPreviewPanel extends Block {
	constructor() {
		super()

		this.classList.add("html-preview-panel")

		// Header bar: icon + title + an "Edit" button to jump back to the editor.
		this.header = document.createElement("div")
		this.header.className = "html-preview-header"

		const headerLeft = document.createElement("div")
		headerLeft.className = "html-preview-header-left"

		const icon = document.createElement("ui-icon")
		icon.textContent = "code"

		this.titleSpan = document.createElement("span")
		this.titleSpan.className = "html-preview-header-title"
		this.titleSpan.textContent = "HTML Preview"

		headerLeft.appendChild(icon)
		headerLeft.appendChild(this.titleSpan)

		this.editBtn = new Button("Edit")
		this.editBtn.className = "nav-btn"
		this.editBtn.icon = "edit"
		this.editBtn.title = "Back to editor (Alt+P)"
		this.editBtn.onclick = (e) => {
			e.stopPropagation()
			if (typeof this.onEdit === "function") this.onEdit()
		}

		this.header.appendChild(headerLeft)
		this.header.appendChild(this.editBtn)

		// The rendered page lives in a single sandboxed iframe.
		this.frame = document.createElement("iframe")
		this.frame.className = "html-preview-frame"
		this.frame.setAttribute("sandbox", "allow-scripts")

		this.append(this.header)
		this.append(this.frame)

		this.activeTab = null

		// The sandboxed iframe (opaque origin) cannot reach the parent DOM, but
		// it can still `postMessage` up. The injected nav guard sends relative
		// link hrefs here so we can open them in the editor.
		window.addEventListener("message", (e) => this._onFrameMessage(e))
	}

	connectedCallback() {
		super.connectedCallback()
		this.style.display = "none"
	}

	/**
	 * A tiny navigation guard injected into the rendered document.
	 *
	 * A `srcdoc` iframe's fallback base URL is the *parent* page's URL, so a
	 * relative link (e.g. `#anchor` or `./other.html`) would otherwise navigate
	 * the whole iframe to the host app, loading a broken copy of Cadence inside
	 * it. Since the iframe is sandboxed without `allow-same-origin`, the parent
	 * cannot reach into its DOM to attach a handler, so the guard is injected
	 * into the document itself. It stops in-frame navigation for relative and
	 * same-origin links (letting in-page `#anchor` scrolling happen natively)
	 * while still opening cross-origin links in a new tab.
	 */
	static _navGuardScript() {
		const navHandler = `
			document.addEventListener(
				"click",
				function (e) {
					var a = e.target && e.target.closest ? e.target.closest("a[href]") : null
					if (!a) return
					var href = a.getAttribute("href")
					if (!href) {
						return
					}
					// In-page fragment: scroll to the element instead of navigating.
					if (href.charAt(0) === "#") {
						e.preventDefault()
						e.stopPropagation()
						var id = href.slice(1)
						if (id) {
							var el = document.getElementById(id)
							if (el && el.scrollIntoView) {
								el.scrollIntoView()
							}
						}
						return
					}
					// Relative / same-origin: hand off to the parent so it can open the
					// project file in the editor (we can't navigate the iframe to it).
					if (href.charAt(0) === "/" || href.charAt(0) === ".") {
						e.preventDefault()
						e.stopPropagation()
						if (window.parent && window.parent !== window) {
							window.parent.postMessage({ type: "html-preview-link", href: href }, "*")
						}
						return
					}
					
					if(!href.startsWith("http")) {
						e.preventDefault()
						e.stopPropagation()
						if (window.parent && window.parent !== window) {
							window.parent.postMessage({ type: "html-preview-link", href: href }, "*")
						}
						return
					}
					
					try {
						var u = new URL(href, location.href)
						if (u.origin === location.origin) {
							e.preventDefault()
							e.stopPropagation()
							if (window.parent && window.parent !== window) {
								window.parent.postMessage({ type: "html-preview-link", href: href }, "*")
							}
							return
						}
						if (!a.target || a.target === "_self") {
							a.target = "_blank"
						}
					} catch (x) {
					}
				},
				true
			)`
		return "<script>" + navHandler.toString() + "<" + "/script>"
	}

	/**
	 * Inject the navigation guard into `doc` as early as possible so it is in
	 * place before the document's own links can be clicked.
	 */
	_injectNavGuard(doc) {
		const guard = HtmlPreviewPanel._navGuardScript()
		const headClose = doc.indexOf("</head>")
		if (headClose !== -1) {
			return doc.slice(0, headClose) + guard + doc.slice(headClose)
		}
		const bodyOpen = doc.search(/<body[\s>]/i)
		if (bodyOpen !== -1) {
			return doc.slice(0, bodyOpen) + guard + doc.slice(bodyOpen)
		}
		return guard + doc
	}

	/**
	 * Build a fresh sandboxed iframe rendering `doc` (with the navigation guard
	 * injected) and swap it into the panel in place of the current frame.
	 *
	 * We replace the node rather than re-assigning `srcdoc` on the existing
	 * iframe: re-setting `srcdoc` on an already-loaded sandboxed iframe is
	 * unreliable in Chromium (the frame can go blank white even though the
	 * attribute holds the new content). A brand-new iframe guarantees a clean
	 * navigation to the new document.
	 */
	_setDoc(doc) {
		const next = document.createElement("iframe")
		next.className = "html-preview-frame"
		next.setAttribute("sandbox", "allow-scripts")
		next.setAttribute("srcdoc", this._injectNavGuard(doc))
		if (this.frame) {
			this.frame.replaceWith(next)
		} else {
			this.append(next)
		}
		this.frame = next
	}

	/**
	 * Render `tab`'s HTML content into the iframe.
	 * `tab` carries the ace session (live, unsaved content) and its config.
	 */
	update(tab) {
		this.activeTab = tab
		const session = tab?.config?.session
		const text = session ? session.getValue() : tab?.config?.rawData || ""

		this.titleSpan.textContent = tab?.config?.name || "HTML Preview"

		if (!text) {
			// Show a simple placeholder document in the iframe.
			this._setDoc(
				'<!doctype html><html><head><meta charset="utf-8"><style>' +
					"body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
					"font-family:system-ui,sans-serif;color:#888;font-style:italic;background:#fff;}" +
					"</style></head><body>Nothing to preview yet.</body></html>"
			)
			return
		}
		this._setDoc(text)
	}

	/**
	 * Handle a relative-link hand-off from the sandboxed iframe. The guard
	 * script posts `{type:"html-preview-link", href}` up to the parent. A
	 * sandboxed iframe has no usable origin, so we can't trust `event.origin`
	 * and instead validate the message shape.
	 */
	_onFrameMessage(e) {
		const data = e.data
		if (!data || typeof data !== "object" || data.type !== "html-preview-link") return
		if (typeof data.href !== "string" || !data.href) return

		const basePath = this.activeTab?.config?.path
		const resolved = this._resolvePath(basePath, data.href)
		if (!resolved) return

		if (window.ui?.openFileHandle) {
			// opts.preview: the target tab should open in its preview view
			// (HTML/Markdown) to match how this panel is being shown.
			window.ui.openFileHandle(resolved, resolved, window.ui.currentEditor, { preview: true })
		}
	}

	/**
	 * Resolve a relative `href` against the directory of `basePath` into a
	 * normalized workspace-relative path, or `null` if it cannot be resolved.
	 */
	_resolvePath(basePath, href) {
		if (!basePath) return null
		const base = basePath.replace(/\\/g, "/")
		const hrefNorm = href.replace(/\\/g, "/")

		// Absolute workspace path (leading /) -> use as-is (strip the leading /).
		let parts
		if (hrefNorm.startsWith("/")) {
			parts = hrefNorm.slice(1).split("/")
		} else {
			const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : ""
			const baseParts = dir ? dir.split("/") : []
			parts = baseParts.concat(hrefNorm.split("/"))
		}

		// Normalize ./ and ../ segments.
		const out = []
		for (const seg of parts) {
			if (!seg || seg === ".") continue
			if (seg === "..") {
				if (out.length) out.pop()
				continue
			}
			out.push(seg)
		}
		return out.join("/")
	}
}

customElements.define("ui-html-preview-panel", HtmlPreviewPanel)
