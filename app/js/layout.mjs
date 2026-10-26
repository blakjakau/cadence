// layout.mjs — Central layout geometry for the Cadence chrome.
//
// Single source of truth for the bar heights, radii, and panel sizing
// numbers that used to be scattered through ui-main.mjs and main.css.
// Override `layout` (or call applyLayout) to retune the whole shell from
// one place; syncCSSVars() pushes the values to CSS custom properties so
// stylesheets stay in lockstep.

let cssVarsSynced = false

const layout = {
	// Top bars (px)
	menuHeight: 34,
	tabHeight: 37,
	statusHeight: 34,

	// Corner radii (px)
	tabRadius: 4,
	borderRadius: 8,
	buttonBorder: 8,
	radius: 6,

	// Font sizes (px)
	fontSizeXs: 11,
	fontSizeSm: 12,

	// Bottom drawer
	drawerCollapsedHeight: 34, // px when closed
	drawerOpenThreshold: 40, // px above which the drawer counts as open
	drawerMaxFraction: 0.8, // of viewport height when constrained
	drawerSnapMinFraction: 0.2, // open drawer is snapped to >= this
	drawerSnapMaxFraction: 0.9, // open drawer is snapped to <= this
	drawerInitialHeightFraction: 0.3, // first-open height before resize

	// Sidebar
	sidebarMinSize: 40,
	sidebarMaxSize: 2440,
	sidebarConstrainMin: 350, // px floor when holding sidebar width
	sidebarConstrainPad: 300, // window.innerWidth - pad => max constrained width
	sidebarDefaultWidth: 350, // px used when first visible
	sidebarMaxWindowFraction: 0.8, // resize listener caps width at window * this

	// Split view
	splitMinFraction: 0.25,
	splitMaxFraction: 0.75,
}

const GLOBAL = { menuHeight: "--menuHeight", tabHeight: "--tabHeight", statusHeight: "--statusHeight" }
const RADII = { tabRadius: "--tabRadius", borderRadius: "--borderRadius", buttonBorder: "--buttonBorder", radius: "--radius" }
const FONTS = { fontSizeXs: "--font-size-xs", fontSizeSm: "--font-size-sm" }

// Write the numeric layout values onto CSS custom properties of the given
// root element (defaults to documentElement). Only sets a variable when
// nothing already set it inline on that root, so a theme or earlier
// caller can still deviate. Call once after the CSS has loaded, then tweak
// individual custom properties as needed.
const syncCSSVars = (root = document.documentElement) => {
	const sets = [GLOBAL, RADII, FONTS]
	for (const map of sets) {
		for (const [key, cssVar] of Object.entries(map)) {
			const value = layout[key]
			const computed = root.style.getPropertyValue(cssVar)
			const expected = cssVar.startsWith("--tabRadius") ? `${value}px ${value}px 0 0` : `${value}px`
			if (!computed) {
				root.style.setProperty(cssVar, expected)
			}
		}
	}
	cssVarsSynced = true
	return layout
}

// Re-apply the full set on a new root (e.g. a shadow root or after the
// documentElement is replaced).
const applyLayout = (root) => {
	if (!root) root = document.documentElement
	for (const map of [GLOBAL, RADII, FONTS]) {
		for (const [key, cssVar] of Object.entries(map)) {
			const value = layout[key]
			root.style.setProperty(cssVar, cssVar.startsWith("--tabRadius") ? `${value}px ${value}px 0 0` : `${value}px`)
		}
	}
	cssVarsSynced = true
	return root
}

export { layout, syncCSSVars, applyLayout }