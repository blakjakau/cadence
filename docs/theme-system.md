# Theme System

How Cadence picks and applies the colours the interface is drawn with.

## Layering

1. **Authored palettes** — `app/css/main.css` defines the default palettes on
   `:root` (`--bg-primary`, `--text-primary`, `--icon-color`, …) with a
   `body.darkmode` variant. These are the fallback when no system theme is in
   effect.
2. **OS theme** — when the user's dark-mode setting is `system`, the app
   asks the backend for the active desktop theme and copies its colours over
   the authored palette by writing inline custom properties on `<body>`
   (inline styles beat the stylesheet, so the OS palette always wins).

## Application flow

- Backend (`os_theme.go`): a **theme-provider registry** (`omarchy`, `kde`,
  `gnome`) resolves the desktop theme in priority order via `GET /api/theme`
  (served by `themeHandler`). Providers absent from the machine report
  unavailable and are skipped, so unknown platforms resolve undetected and
  the UI keeps its stylesheet palette.
- Backend (`startThemeWatcher`, 30s tick): re-resolves the theme and pushes
  `{"action": "theme_changed", "data": <palette>}` over the existing
  conduit-client websocket whenever it changes — the same broadcast channel
  as `indexer_status`. No polling, no per-change HTTP round-trip.
- `main.mjs` → `applySystemTheme()`: fetches once via `fetchOsTheme()` for
  the initial state, then relies on the push subscription
  (`subscribeOsThemePush()` listens for `theme_changed` on the conduit
  client; the listener survives reconnects, so there is nothing to restart).
  Both paths funnel into `applyOsUiTheme()`, which toggles
  `document.body.classList` `.darkmode` for the palette's mode.
- `app/js/os-theme.mjs` → `applyOsPalette()`:
  1. builds a "roll" (`name → value`) of every custom property the palette
     contributes, resolving two sources:
     - **`TARGET_MAP`** — flat key-to-key mappings
       (OS palette key → Cadence var), e.g. `background → --bg-primary`,
       `foreground → --text-primary` (see table below);
     - **`COMPOSITE_TARGETS`** — values derived from a single source with a
       `fn()`, e.g. borders, hovers, and the surface shadows built from
       `color-mix(...)`;
  2. writes every var to `document.body.style`, tracking names in
     `appliedVars` so `clearOsPalette()` removes them cleanly.
- Authored (light/dark) modes never run the system pipeline. The cached
  palette remains readable via `getCachedOsTheme()` (used for the dark-mode
  menu state).

### Mode-only palettes (KDE / GNOME shell themes)
Some desktop environments provide only `mode`, not colours. In that case the
palette applies no colour vars — the authored palette (plus `.darkmode`) is
kept and no enforcement runs.

## `TARGET_MAP` key relations

Cadence var(s) ← OS palette key
`--theme`, `--color-accent` ← `accent`
`--bg-primary` ← `background`
`--bg-secondary`, `--bg-card`, `--bg-modal` ← `lighter_background`
`--bg-tertiary`, `--bg-card-alt` ← `dark_background`
`--bg-code`, `--bg-terminal` ← `darker_background`
`--text-primary`, `--text`, `--text-color`, `--text-color-secondary` ← `foreground`
`--text-secondary` ← `light_foreground`
`--text-muted` ← `dark_foreground`

(Keep this table in sync with the `TARGET_MAP` object — it is the source of
truth.)

`COMPOSITE_TARGETS` derive: status colours, borders, input/tag backgrounds,
hover surfaces, and the translucent page surface — plus their `rgb()` triplet
companions where CSS needs a raw channel list.

## Universal readability enforcement (planned — not yet implemented)

> Status: design sketch. No `readable-theme.mjs` ships yet and
> `applyOsPalette()` writes the roll directly; nothing enforces contrast
> today. The review feedback on font sizes stands: we are not aiming for
> WCAG compliance in this project atm.

Purpose: whatever theme is active (even a hostile one, e.g. bright-green
menus), **all text and icons stay readable**, while **never touching surface
colours** — the theme's character is preserved.

Mechanism (`app/js/readable-theme.mjs`):

- A registry of **pair rules**: each rule names foreground variables, the
  surfaces they sit on, a WCAG threshold, and a mode (`color` = recolor the
  foreground; `shadow` = emit an effect variable).
- For each rule the module finds every hex surface value present in the roll,
  computes WCAG contrast, and if any surface fails, binary-searches the
  foreground toward black or white (choosing the direction with headroom) until
  it passes **on all surfaces at once** — important because one fg variable is
  shared across several background shades.
- Whites pass through untouched; strings that aren't `#rrggbb`/`#rgb` (e.g.
  `color-mix(...)`, `rgb(...)`) skip the rule for that surface.
- `mode:"shadow"` rules don't recolor — they emit an effect var the CSS
  hooks into, e.g. `--logo-version-shadow` (used by `#logo .logo-version`'s
  `text-shadow`) so dark text on a bright surface gets a legibility shadow
  instead of being rewritten.

Current rules: `text-on-bg`, `secondary-on-bg`, `muted-on-bg`,
`icons-on-bg` (≥ 3.0), `inverted-on-accent`, `version-text` (shadow).

### Override surface (future user themes)
`setReadabilityConfig({ ... })` / `getReadabilityConfig()` allow per-pair or
global `enabled:false`, plus overriding a rule's `mode`. This is the hook a
future "user themes" feature should use so theme authors can opt out where
their text obviously satisfies contrast.

Known limits (TBD to address): parsing supports hex only; `color-mix` surfaces
are skipped for enforcement (fine today, matters when a theme authors surfaces
with blends).