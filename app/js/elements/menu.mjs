import { Panel } from './panel.mjs';
import { isFunction } from './utils.mjs';

let MenuOpen = false
let CurrentMenu = null

// Last pointer position (tracked so we can detect a cursor already resting over
// the menu when it opens).
let PointerX = -1
let PointerY = -1

const getMenuItems = (menu) =>
	[...menu.querySelectorAll("ui-menu-item")]
		.filter((item) => !item.hasAttribute("disabled"))
		// A pop-out sub-menu hosts its own items (its closest ui-menu is the
		// sub-menu itself); they must not show up in the parent's list.
		.filter((item) => item.closest("ui-menu") === menu)

export class Menu extends Panel {
	constructor(content) {
		super(content)
		this.on("contextmenu", (e) => {
			e.preventDefault()
		})
		// Pointer-driven mode: when the cursor moves over the menu it takes
		// over selection (mouse selection), and keyboard resumes from there.
		this._pointerItem = null
		this._pointerActive = false
		// Set when this menu was popped out from a parent item (a sub-menu).
		this._isSubmenu = false
		this._parent = null
		this._parentItem = null
	}

	connectedCallback() {
		super.connectedCallback.apply(this)
		const origin = this.getAttribute("showAt")
		if (origin) {
			const el = document.querySelector(origin)
			this.showAt(el)
		}
		const attach = this.getAttribute("attachTo")
		if (attach) {
			const el = document.querySelector(attach)
			if (el) {
				el.on("click", () => {
					if (MenuOpen && CurrentMenu == this) return
					setTimeout(() => {
						MenuOpen = false
						this.showAt(el)
					})
				})
			}
			if (el) {
				el.on("pointerover", () => {
					if (MenuOpen && CurrentMenu == this) return
					if (MenuOpen) {
						el.focus()
						el.click()
					}
				})
			}
		}

		const click = this.getAttribute("onclick")
		if (click) {
			this._click = eval(click)
		}

		// Mouse hover takes over selection while the cursor is over the menu.
		this.addEventListener("pointerover", (e) => {
			if (!this.hasAttribute("active")) return
			const item = e.target instanceof Element ? e.target.closest("ui-menu-item") : null
			if (item && item.hasAttribute("disabled")) {
				this._enterPointerMode(null)
				return
			}
			this._enterPointerMode(item)
		})
	}

	/**
	 * Enter pointer-driven selection. Drops the keyboard highlight so a hovered
	 * item is the only highlighted one; the pointer position is remembered so an
	 * arrow key can convert it into the keyboard selection.
	 */
	_enterPointerMode(item) {
		this._pointerActive = true
		this._pointerItem = item instanceof HTMLElement ? item : null
		const parts = getMenuItems(this)
		const active = document.activeElement
		if (active instanceof HTMLElement && parts.includes(active) && active !== item) {
			active.blur()
		}
	}

	set click(v) {
		if (!isFunction(v)) throw new Error("click must be a function")
		this._click = v
	}

	click(command) {
		if ("function" == typeof this._click) {
			this._click(command)
		}
	}

	showAt(origin) {
		if (!this.parentElement) {
			document.body.appendChild(this);
		}
		// const self = this
		let p

		// Reset pointer mode for a fresh menu.
		this._pointerItem = null
		this._pointerActive = false

		// Remember who opened this menu so we can restore focus when it closes.
		this._opener = origin instanceof PointerEvent ? origin.target : origin
		if (!(this._opener instanceof HTMLElement)) this._opener = null


		// clear styling for left/up combos
		this.removeAttribute("left")
		this.removeAttribute("up")

		if (origin instanceof PointerEvent) {
			p = {
				x: origin.clientX + 2,
				y: origin.clientY + 2,
				w: 0,
				h: 0,
			}
			this.style.left = `${p.x}px`
			this.style.top = `${p.y + p.h}px`
			this.style.bottom = ""
			// this.style.maxHeight = `calc(100vh - ${p.y + p.h + 8}px)`
		} else if (origin instanceof HTMLElement) {
			p = getPosition(origin)
			this.style.left = `${p.x}px`
			this.style.top = `${p.y + p.h}px`
			this.style.bottom = ""
		} else {
			throw new Error("showAt requires an HTMLElement in the current DOM or a PointerEvent")
		}

		setTimeout(() => {
			if (p.x + this.offsetWidth > window.innerWidth) {
				this.setAttribute("left", "")
				this.style.left = p.x + p.w - this.offsetWidth
			}
			if (p.y + p.h + this.offsetHeight > window.innerHeight) {
				if (p.y + p.h > window.innerHeight / 2) {
					// displat ABOVE the orgin
					this.setAttribute("up", "")
					this.style.top = "auto" //p.y - (this.offsetHeight-32)
					this.style.bottom = `${window.innerHeight - p.y}px`
					this.style.maxHeight = `calc(100vh - ${window.innerHeight - p.y + 16}px)`
				} else {
					this.style.maxHeight = `calc(100vh - ${p.y + p.h + 16}px)`
				}
			} else {
				this.style.maxHeight = `calc(100vh - ${p.y + p.h + 16}px)`
			}
		})

		const event = new CustomEvent("show")
		this.dispatchEvent(event)

		setTimeout(() => {
			if (CurrentMenu === this) {
				CurrentMenu.removeAttribute("active")
				CurrentMenu = null
				return
			}

			let clicked = false
			MenuOpen = true
			CurrentMenu = this
			this.on("click",
				() => {
					clicked = true
					MenuOpen = false
					CurrentMenu = null
					this._closeNested()
					setTimeout(() => {
						this.removeAttribute("active")
					}, 333)
				},
				{ once: true }
			)
			document.addEventListener("click",
				() => {
					if (!clicked && MenuOpen) {
						setTimeout(() => {
							this._closeNested()
							this.removeAttribute("active")
							MenuOpen = false
							CurrentMenu = null
							this._restoreFocus()
						})
					}
				},
				{ once: true }
			)
			document.addEventListener("contextmenu",
				() => {
					if (CurrentMenu == this) {
						this._closeNested()
						CurrentMenu.removeAttribute("active")
						return
					}
					if (!clicked && MenuOpen) {
						setTimeout(() => {
							this._closeNested()
							this.removeAttribute("active")
							MenuOpen = false
							CurrentMenu = null
							this._restoreFocus()
						})
					}
				},
				{ once: true }
			)
		})
		this.setAttribute("active", "true")

		// Focus the first enabled menu item so arrow keys drive navigation
		// immediately. If the cursor already rests on one of our items (menu
		// opened under the mouse), leave pointer mode in charge instead.
		setTimeout(() => {
			const items = getMenuItems(this)
			if (items.length > 0 && this.hasAttribute("active")) {
				const el = PointerX >= 0 ? document.elementFromPoint(PointerX, PointerY) : null
				const hovered = el && el.closest ? el.closest("ui-menu-item") : null
				if (hovered && items.includes(hovered) && !hovered.hasAttribute("disabled")) {
					this._pointerActive = true
					this._pointerItem = hovered
				} else {
					items[0].focus({ preventScroll: true })
				}
			}
		}, 16)
	}

	_restoreFocus() {
		if (this._opener && this._opener.isConnected) {
			this._opener.focus({ preventScroll: true })
		}
	}

	// --- Sub-menu (pop-out) support ---------------------------------------
	// A menu item hosts its pop-out sub-menu as a direct <ui-menu> child; the
	// left/right keys open it on the focused item (Right) and pop it back
	// into the item (Left / Escape).

	_childSubmenu(item) {
		return item instanceof HTMLElement ? item.querySelector(":scope > ui-menu") : null
	}

	_openSubmenu(item, sub) {
		document.body.appendChild(sub)
		sub.removeAttribute("left")
		sub.removeAttribute("up")
		sub.style.maxHeight = ""
		sub._isSubmenu = true
		sub._parent = this
		sub._parentItem = item
		sub._opener = item
		sub._pointerItem = null
		sub._pointerActive = false
		if (isFunction(this._click)) sub._click = this._click

		const r = item.getBoundingClientRect()
		sub.style.left = `${r.right + 4}px`
		sub.style.top = `${r.top}px`
		sub.style.bottom = ""
		sub.setAttribute("active", "true")
		item.setAttribute("open", "")
		MenuOpen = true
		CurrentMenu = sub

		setTimeout(() => {
			const w = sub.offsetWidth || 0
			const h = sub.offsetHeight || 0
			if (r.right + 4 + w > window.innerWidth && r.left - w - 4 >= 0) {
				sub.setAttribute("left", "")
				sub.style.left = `${r.left - w - 4}px`
			} else {
				sub.removeAttribute("left")
				sub.style.left = `${r.right + 4}px`
			}
			if (r.top + h > window.innerHeight) {
				sub.setAttribute("up", "")
				sub.style.maxHeight = `${Math.max(120, window.innerHeight - r.top - 8)}px`
			} else {
				sub.removeAttribute("up")
			}
		})

		const items = getMenuItems(sub)
		if (items.length > 0) items[0].focus({ preventScroll: true })
	}

	_closeSubmenu() {
		if (!this._isSubmenu) return
		const parent = this._parent
		const item = this._parentItem
		this._isSubmenu = false
		this._parent = null
		this._parentItem = null
		this._opener = null
		this.removeAttribute("active")
		if (item instanceof HTMLElement) {
			item.removeAttribute("open")
			item.appendChild(this)
		}
		if (parent instanceof Menu) {
			MenuOpen = true
			CurrentMenu = parent
			parent.setAttribute("active", "")
			if (item instanceof HTMLElement) {
				item.focus({ preventScroll: true })
				item.scrollIntoView({ block: "nearest" })
			}
		} else {
			MenuOpen = false
			CurrentMenu = null
		}
	}

	// Deactivates any open sub-menu this menu owns without restoring focus.
	// Called when the menu goes away through a click or context-dismiss.
	_closeNested() {
		for (const m of document.querySelectorAll("ui-menu")) {
			if (m._parent === this && m.hasAttribute("active")) {
				m._isSubmenu = false
				m._parent = null
				m.removeAttribute("active")
			}
		}
	}

	// --- Top-bar navigation ------------------------------------------------
	// A top-bar menu is one anchored to one of the buttons in the <ui-actionbar
	// id="menu">. Left/right without a sub-menu on the focused item walks the
	// bar, and does not wrap at the ends.

	_isTopBarMenu() {
		return this._opener instanceof HTMLElement &&
			this._opener.parentElement instanceof HTMLElement &&
			this._opener.parentElement.id === "menu"
	}

	_topBarButtons() {
		const bar = this._opener instanceof HTMLElement ? this._opener.parentElement : null
		if (!bar) return []
		return [...bar.querySelectorAll("ui-button")].filter((btn) =>
			this._menuForButton(btn) instanceof HTMLElement)
	}

	_menuForButton(btn) {
		// Buttons shadow the native id accessor with a setter, so read the
		// attribute directly.
		const id = btn instanceof HTMLElement ? btn.getAttribute("id") : null
		return id ? document.querySelector(`ui-menu[attachTo="#${id}"]`) : null
	}

	// Moves the open top-bar menu to the neighbouring button (delta ±1) when
	// one exists; at the ends of the bar nothing happens.
	_moveToTopMenu(delta) {
		if (!this._isTopBarMenu()) return
		const buttons = this._topBarButtons()
		const idx = buttons.indexOf(this._opener)
		if (idx < 0) return
		const next = buttons[idx + delta]
		if (!(next instanceof HTMLElement)) return
		const menu = this._menuForButton(next)
		if (!(menu instanceof Menu)) return
		this.removeAttribute("active")
		MenuOpen = false
		CurrentMenu = null
		menu.showAt(next)
	}

	// Orchestrates left/right key behaviour for the current menu:
	//  - a sub-menu closes itself on ArrowLeft;
	//  - a focused item with a child sub-menu opens it on ArrowRight;
	//  - top-bar menus otherwise walk to the neighbouring menu button.
	_handleHorizontal(e) {
		const key = e.key
		const items = getMenuItems(this)
		const active = document.activeElement
		const currentIsItem = active instanceof HTMLElement && items.includes(active)
		const pointerCurrent = (!currentIsItem && this._pointerActive && this._pointerItem && items.includes(this._pointerItem))
			? this._pointerItem
			: null
		const current = currentIsItem ? active : pointerCurrent

		if (this._isSubmenu && key === "ArrowLeft") {
			this._closeSubmenu()
			return
		}

		if (current && key === "ArrowRight") {
			const sub = this._childSubmenu(current)
			if (sub) {
				this._openSubmenu(current, sub)
				return
			}
		}

		if (!this._isSubmenu && this._isTopBarMenu()) {
			this._moveToTopMenu(key === "ArrowRight" ? 1 : -1)
		}
	}

	/**
	 * Keyboard navigation for an open menu. Registered at capture time on
	 * document (see module scope below) so it runs before window.ui.commands'
	 * global keydown handler. Returns true when the event was handled.
	 */
	_handleKeydown(e) {
		if (!MenuOpen || CurrentMenu !== this || !this.hasAttribute("active")) return false
		const items = getMenuItems(this)
		if (items.length === 0) return false

		const active = document.activeElement
		const currentIsItem = active instanceof HTMLElement && items.includes(active)
		const activeIndex = currentIsItem ? items.indexOf(active) : -1
		// When pointer mode is active, an arrow key converts the hovered item
		// into the keyboard selection and continues from there.
		const pointerIndex = (!currentIsItem && this._pointerActive && this._pointerItem && items.includes(this._pointerItem))
			? items.indexOf(this._pointerItem)
			: -1

		let index = -1

		switch (e.key) {
			case "ArrowDown":
				index = currentIsItem ? (activeIndex + 1) % items.length
					: pointerIndex >= 0 ? (pointerIndex + 1) % items.length
					: 0
				break
			case "ArrowUp":
				index = currentIsItem ? (activeIndex - 1 + items.length) % items.length
					: pointerIndex >= 0 ? (pointerIndex - 1 + items.length) % items.length
					: items.length - 1
				break
			case "Home":
				index = 0
				break
			case "End":
				index = items.length - 1
				break
			case "ArrowRight":
			case "ArrowLeft":
				this._handleHorizontal(e)
				e.preventDefault()
				e.stopImmediatePropagation()
				return true
			case "Enter":
			case " ": {
				const victim = currentIsItem
					? active
					: (this._pointerActive && this._pointerItem && items.includes(this._pointerItem) ? this._pointerItem : null)
				if (victim && !victim.hasAttribute("disabled")) {
					e.preventDefault()
					e.stopImmediatePropagation()
					victim.click()
					return true
				}
				return false
			}
			case "Escape":
				e.preventDefault()
				e.stopImmediatePropagation()
				if (this._isSubmenu) {
					// Escaping a sub-menu pops it back into its parent item
					// and leaves the parent menu open on that item.
					this._closeSubmenu()
					return true
				}
				this.removeAttribute("active")
				MenuOpen = false
				CurrentMenu = null
				this._restoreFocus()
				return true
			default:
				return false
		}

		e.preventDefault()
		e.stopImmediatePropagation()
		// An arrow key means keyboard navigation takes over from the pointer.
		this._pointerActive = false
		// Skip over disabled items in the chosen direction.
		for (let i = 0; i < items.length; i++) {
			const target = items[index % items.length]
			if (!target.hasAttribute("disabled")) {
				target.focus({ preventScroll: true })
				target.scrollIntoView({ block: "nearest" })
				return true
			}
			index += (e.key === "ArrowDown") ? 1 : -1
		}
		return true
	}
}

const getWindowY = (e) => {
	let y = e.offsetTop
	return e.parentNode instanceof HTMLElement ? y + getWindowY(e.parentNode) : y
}
const getWindowX = (e) => {
	let x = e.offsetLeft
	return e.parentNode instanceof HTMLElement ? x + getWindowX(e.parentNode) : x
}

const getPosition = (el) => {
	let x = getWindowX(el)
	let y = getWindowY(el)
	return {
		x: x,
		y: y,
		w: el.offsetWidth,
		h: el.offsetHeight,
	}
}

// Capture-phase keyboard controller for menus. Registered here (menu.mjs is imported
// before main.mjs), so it runs before window.ui.commands' own capture listener and can
// stopImmediatePropagation() for menu-only keys (arrows, Home/End, Enter, Escape) while
// a menu is open — without eating keys when no menu is open.
document.addEventListener(
	"keydown",
	(e) => {
		if (!MenuOpen || !CurrentMenu) return
		CurrentMenu._handleKeydown(e)
	},
	{ capture: true }
)

// Track the cursor so a menu that opens under the mouse starts in pointer mode.
document.addEventListener(
	"pointermove",
	(e) => {
		PointerX = e.clientX
		PointerY = e.clientY
	},
	{ capture: true, passive: true }
)

customElements.define("ui-menu", Menu);