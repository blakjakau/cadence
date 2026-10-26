// Bridges Cadence's CSS palette to the active OS theme.
//
// The backend (GET /api/theme) resolves the running desktop's theme through
// its theme-provider registry: Omarchy exposes the active theme under its
// colors.toml with a stable set of semantic names (accent, background,
// foreground, selection, muted, red... bright_*, plus a mode =
// dark|light), while KDE and GNOME only provide a light/dark mode.
// OS palettes are mapped onto Cadence's own theme variables (--bg-primary,
// --text-primary, --color-accent, --green...); mode-only palettes leave
// Cadence's own light/dark palette in charge.
//
// Live updates arrive as "theme_changed" websocket pushes on the existing
// conduit-client connection (see main.mjs); this module never polls.

const API = "/api/theme"

// Cache of the active OS palette so callers can compare against it
// without churning the network.
let cachedPalette = null

// Tracks which custom properties we've written so they can be reverted.
let appliedVars = []

// Direct passthroughs: an OS palette key feeds one or more Cadence CSS
// custom properties verbatim.
const TARGET_MAP = {
	accent: ["--theme", "--color-accent"],
	background: "--bg-primary",
	lighter_background: ["--bg-secondary", "--bg-card", "--bg-modal"],
	dark_background: ["--bg-tertiary", "--bg-card-alt"],
	darker_background: ["--bg-code", "--bg-terminal"],
	foreground: ["--text-primary", "--text", "--text-color", "--text-color-secondary"],
	light_foreground: "--text-secondary",
	dark_foreground: "--text-muted",
}

// Computed targets: each produces a derived color from one palette source.
// `--text-color-rgb` must be an "r, g, b" triplet (that's how rgba(var())
// consumes it), while everything else stays a real CSS color.
const COMPOSITE_TARGETS = [
	{ source: "accent", target: "--theme-dark", fn: (hex) => colorMix(hex, "black", 35) },
	{ source: "accent", target: "--theme-light", fn: (hex) => colorMix(hex, "white", 20) },
	{ source: "foreground", target: "--text-color-rgb", fn: (hex) => hexToRgbTriplet(hex) },
	// Text sitting on an accent/theme-colored surface is "inverted": the
	// theme's inverse scheme, matching how Omarchy's own app skins invert it.
	{ source: "background", target: "--text-inverted", fn: (hex) => hex },
	{ source: "background", target: "--theme-text-color", fn: (hex) => hex },
	{ source: "background", target: "--theme-text-color-light", fn: (hex) => colorMix(hex, "white", 15) },
	// Inputs/tags are translucent tints of the theme's selection surface.
	{ source: "selection", target: "--bg-input", fn: (hex) => colorMix(hex, "transparent", 60) },
	{ source: "selection", target: "--bg-tag", fn: (hex) => colorMix(hex, "transparent", 35) },
	// Hover + borders take the muted fill.
	{ source: "muted", target: "--bg-hover", fn: (hex) => hex },
	{ source: "muted", target: "--border-primary", fn: (hex) => hex },
	{ source: "muted", target: "--border-secondary", fn: (hex) => hex },
	// Semantic status colors.
	{ source: "green", target: "--green", fn: (hex) => hex },
	{ source: "green", target: "--color-success", fn: (hex) => hex },
	{ source: "red", target: "--red", fn: (hex) => hex },
	{ source: "red", target: "--color-error", fn: (hex) => hex },
	{ source: "red", target: "--high", fn: (hex) => hex },
	{ source: "yellow", target: "--color-warning", fn: (hex) => hex },
	// Diff-insert/delete fills tinted from the theme's bg + status colors.
	{ source: "green", target: "--diff-green", fn: (hex) => colorMix(hex, "black", 30) },
	{ source: "red", target: "--diff-red", fn: (hex) => colorMix(hex, "black", 30) },
	// highlight.js tokens.
	{ source: "magenta", target: "--hljs-keyword", fn: (hex) => hex },
	{ source: "green", target: "--hljs-selector", fn: (hex) => hex },
	{ source: "cyan", target: "--hljs-attribute", fn: (hex) => hex },
	{ source: "yellow", target: "--hljs-number", fn: (hex) => hex },
	{ source: "green", target: "--hljs-string", fn: (hex) => hex },
	{ source: "blue", target: "--hljs-function", fn: (hex) => hex },
	{ source: "cyan", target: "--hljs-variable", fn: (hex) => hex },
	{ source: "green", target: "--hljs-tag", fn: (hex) => hex },
	{ source: "dark_foreground", target: "--hljs-comment", fn: (hex) => hex },
	{ source: "bright_foreground", target: "--hljs-class", fn: (hex) => hex },
]

// `color-mix()` is used rather than client-side mixing math because it is
// supported by the runtime we ship in (verified in Chromium) and keeps the
// arithmetic readable.
const colorMix = (mixInto, mix, t) => `color-mix(in srgb, ${mixInto} ${100 - t}%, ${mix} ${t}%)`

// Converts "#rrggbb" to "r, g, b" for variables that are consumed as rgb
// triplets (e.g. rgba(var(--text-color-rgb), 0.4)).
const hexToRgbTriplet = (hex) => {
	if (!hex || !hex.startsWith("#")) return hex
	const value = parseInt(hex.slice(1), 16)
	if (Number.isNaN(value) || hex.slice(1).length !== 6) return hex
	return `${value >> 16 & 255}, ${value >> 8 & 255}, ${value & 255}`
}

// Fetches the current OS theme. Returns null on an unreachable
// backend; resolves to {detected:false} when no supported desktop theme
// is installed.
const fetchOsTheme = async () => {
	try {
		const res = await fetch(API)
		if (!res.ok) return null
		return await res.json()
	} catch (err) {
		console.warn("[os-theme] theme fetch failed:", err)
		return null
	}
}

// Reads the backend's cached view without touching the network. Useful when
// callers only need to know the active system mode.
const getCachedOsTheme = () => cachedPalette

// Applies an OS theme palette to the document by writing the mapped Cadence
// CSS custom properties onto the body element (inline styles there beat both
// the :root and .darkmode stylesheet rules for every descendant). Mode-only
// palettes (KDE/GNOME — no colors) are cached but leave the stylesheet's own
// light/dark palette in charge. Returns the palette that was applied, or null
// when nothing was applied.
const applyOsPalette = (palette) => {
	clearOsPalette()
	if (!palette || palette.detected !== true) {
		return null
	}
	cachedPalette = palette
	if (!palette.colors) {
		return palette
	}

	const setVar = (name, value) => {
		if (value === undefined || value === null || value === "") return
		document.body.style.setProperty(name, String(value))
		appliedVars.push(name)
	}

	const colors = palette.colors
	for (const [source, targets] of Object.entries(TARGET_MAP)) {
		const value = colors[source]
		if (!value) continue
		for (const target of Array.isArray(targets) ? targets : [targets]) {
			setVar(target, value)
		}
	}

	for (const { source, target, fn } of COMPOSITE_TARGETS) {
		const value = colors[source]
		if (!value) continue
		setVar(target, fn(value))
	}

	return palette
}

// Reverts every custom property this module has written, restoring the
// stylesheet's light/dark palette.
const clearOsPalette = () => {
	for (const name of appliedVars) {
		document.body.style.removeProperty(name)
	}
	appliedVars = []
	cachedPalette = null
}

export {
	fetchOsTheme,
	getCachedOsTheme,
	applyOsPalette,
	clearOsPalette,
}