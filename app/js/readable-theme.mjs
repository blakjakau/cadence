// Universal readability enforcement for applied theme palettes.
//
// Theme palettes are mapped onto Cadence CSS custom properties before they are
// written to the document (see omarchy-theme.mjs). This module looks at that
// roll of colours for pairs that are rendered TOGETHER (text on a surface,
// icons on a surface, inverted text on an accent colour) and, when a pair
// fails WCAG contrast, nudges only the FOREGROUND just far enough to pass
// ("minimal intervention"). The theme's surfaces are never touched, so the
// theme keeps its identity while the app stays readable on any bright or dark
// scheme.
//
// The knowledge doc for the whole theme flow lives in docs/theme-system.md.
//
// Overrides (for future user themes): setReadabilityConfig() lets a theme
// disable or retune individual pairs, or switch the whole pass off.

const DEFAULT_CONFIG = {
	enabled: true,
	pairs: {}, // name -> { enabled?: false, threshold?: number, mode?: "color" | "shadow" }
}

let config = { ...DEFAULT_CONFIG, pairs: {} }

const setReadabilityConfig = (next) => {
	const input = next || {}
	config = {
		enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
		pairs: { ...(input.pairs || {}) },
	}
}

const getReadabilityConfig = () => ({ enabled: config.enabled, pairs: { ...config.pairs } })

// Pairs the palette feeds that are used together. fgTargets lists every
// custom property that carries the same value and must stay in sync when the
// foreground moves; the first resolvable hex surface from `bg` is used.
const PAIR_RULES = [
	{
		name: "text-on-bg",
		fgTargets: ["--text-primary", "--text", "--text-color", "--text-color-secondary"],
		bg: ["--bg-primary"],
		threshold: 4.5,
		mode: "color",
	},
	{
		name: "secondary-on-bg",
		fgTargets: ["--text-secondary"],
		bg: ["--bg-primary", "--bg-secondary"],
		threshold: 4.5,
		mode: "color",
	},
	{
		name: "muted-on-bg",
		fgTargets: ["--text-muted"],
		bg: ["--bg-primary", "--bg-secondary", "--bg-tertiary"],
		threshold: 4.5,
		mode: "color",
	},
	{
		name: "icons-on-bg",
		fgTargets: ["--icon-color"],
		bg: ["--bg-primary", "--bg-secondary"],
		threshold: 3.0,
		mode: "color",
	},
	{
		name: "inverted-on-accent",
		fgTargets: ["--text-inverted", "--theme-text-color"],
		bg: ["--theme"],
		threshold: 4.5,
		mode: "color",
	},
	{
		name: "version-text",
		fgTargets: ["--text-primary"],
		bg: ["--bg-primary"],
		threshold: 4.5,
		mode: "shadow",
		effectVar: "--logo-version-shadow",
	},
]

// --- colour math (hex only; non-hex values are left alone) -------------------

const hexToRgb = (hex) => {
	if (typeof hex !== "string") return null
	const h = hex.trim()
	if (!/^#([0-9a-f]{3}){1,2}$/i.test(h)) return null
	const short = h.slice(1)
	const full = short.length === 3 ? short.split("").map((c) => c + c).join("") : short
	const n = parseInt(full, 16)
	return [n >> 16 & 255, n >> 8 & 255, n & 255]
}
const rgbToHex = ([r, g, b]) => "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")

const linear = (c) => {
	const s = c / 255
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
const contrastRatio = (a, b) => {
	const [hi, lo] = a >= b ? [a, b] : [b, a]
	return (hi + 0.05) / (lo + 0.05)
}

const mixChannels = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t)

// Splits the pair by dragging the foreground toward the extreme (black or
// white) that gives the most headroom on the lightest surface (surfaces within
// one rule belong to the same family, so one direction serves them all).
const fixDirection = (surfaces) => {
	const lightest = surfaces.reduce((a, b) => (luminance(a) >= luminance(b) ? a : b), surfaces[0])
	return contrastRatio(0, luminance(lightest)) >= contrastRatio(1, luminance(lightest)) ? [0, 0, 0] : [255, 255, 255]
}

// Returns the colour of `fgHex` mixed just far enough toward black/white to
// pass the WCAG threshold on EVERY surface it is used against (a foreground
// variable shared by several surfaces only stays consistent if it works on all
// of them). Surfaces that already pass are returned as-is.
const contrastFix = (fgHex, surfaces, threshold) => {
	const fg = hexToRgb(fgHex)
	if (!fg || surfaces.length === 0) return fgHex
	const surfaceRgb = surfaces.map(hexToRgb).filter(Boolean)
	if (surfaceRgb.length === 0) return fgHex

	const Ls = surfaceRgb.map(luminance)
	if (Ls.every((L) => contrastRatio(luminance(fg), L) >= threshold)) return fgHex

	const target = fixDirection(surfaceRgb)
	const ratioAt = (t) => {
		const mixed = rgbToHex(mixChannels(fg, target, t))
		return Math.min(...Ls.map((L) => contrastRatio(luminance(hexToRgb(mixed)), L)))
	}
	if (ratioAt(1) < threshold) return rgbToHex(mixChannels(fg, target, 1))
	let lo = 0
	let hi = 1
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2
		if (ratioAt(mid) >= threshold) hi = mid
		else lo = mid
	}
	return rgbToHex(mixChannels(fg, target, hi))
}

// Effect (text-shadow) value chosen for a surface: a heavier drop on dark
// surfaces, a lighter crispening halo on bright ones.
const shadowFor = (bgHex) => {
	const rgb = hexToRgb(bgHex)
	if (!rgb) return "none"
	return luminance(rgb) >= 0.4 ? "0 1px 2px rgba(0, 0, 0, 0.28)" : "0 1px 2px rgba(0, 0, 0, 0.6)"
}

// Pure: given the roll of custom properties a palette is about to write,
// returns a corrected roll (only the fixed foregrounds / effects differ).
const enforceReadability = (roll, rules = PAIR_RULES, cfg = config) => {
	const out = { ...roll }
	if (!cfg.enabled) return out
	for (const rule of rules) {
		const override = cfg.pairs[rule.name] || {}
		if (override.enabled === false) continue
		const threshold = override.threshold ?? rule.threshold
		const surfaces = (rule.bg || []).map((k) => out[k]).filter((v) => v && hexToRgb(v))
		const fgValue = rule.fgTargets?.map((k) => out[k]).find((v) => v)
		if (!surfaces.length || !fgValue) continue
		const mode = override.mode ?? rule.mode
		if (mode === "shadow" && rule.effectVar) {
			out[rule.effectVar] = shadowFor(surfaces[0])
		} else if (mode === "color") {
			const fixed = contrastFix(fgValue, surfaces, threshold)
			for (const key of rule.fgTargets) {
				if (out[key]) out[key] = fixed
			}
		}
	}
	return out
}

export { PAIR_RULES, contrastFix, enforceReadability, getReadabilityConfig, setReadabilityConfig }