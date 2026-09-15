# Theme System

How Cadence picks and applies the colours the interface is drawn with.

## Layering

1. **Authored palettes** — `app/css/main.css` defines the default palettes on
   `:root` (`--bg-primary`, `--text-primary`, `--icon-color`, …) with a
   `body.darkmode` variant. These are the fallback when no system theme is in
   effect.
2. **System theme** — when the user's dark-mode setting is `system`, the app
   asks the backend for the active desktop theme and copies its colours over
   the authored palette by writing inline custom properties on `<body>`
   (inline styles beat the stylesheet, so the system palette always wins).

## Application flow

- `main.mjs` → `applySystemTheme()` (polls in `omarchyPollTimer` while in
  `system` mode):
  - resolves the current palette key with `paletteKey()` — if unchanged, skips
    re-application (dedupe);
  - fetches via `fetchOmarchyTheme()` / `getCachedOmarchyTheme()`;
  - toggles `document.body.classList` `.darkmode` for the palette's mode;
  - calls `applyOmarchyPalette(palette)`.
- `app/js/omarchy-theme.mjs` → `applyOmarchyPalette()`:
  1. builds a "roll" (`name → value`) of every custom property the palette
     contributes, resolving two sources:
     - **`TARGET_MAP`** — flat key-to-key mappings
       (omarchy key → Cadence var), e.g. `background → --bg-primary`,
       `foreground → --text-primary` (see table below);
     - **`COMPOSITE_TARGETS`** — values derived from a single source with a
       `fn()`, e.g. borders, hovers, and the surface shadows built from
       `color-mix(...)`;
  2. runs the **universal readability pass**
     (`enforceReadability()` from `app/js/readable-theme.mjs`) over the roll
     *before* anything touches the document — see below;
  3. writes every var to `document.body.style`, tracking names in
     `appliedVars` so `clearOmarchyPalette()` removes them cleanly.
- Authored (light/dark) modes never run the system pipeline, so they are not
  subject to enforcement — the authored palette is assumed to be correct.

### Mode-only palettes (KDE / GNOME shell themes)
Some desktop environments provide only `mode`, not colours. In that case the
palette applies no colour vars — the authored palette (plus `.darkmode`) is
kept and no enforcement runs.

## `TARGET_MAP` key relations

Cadence var        ← omarchy key
`--bg-primary`       ← `background`
`--bg-secondary`     ← `lighter_background`
`--bg-tertiary`      ← `dark_background`
`--bg-tr-strong`     ← `darker_background`
`--text-primary`     ← `foreground`
`--text-secondary`   ← `light_foreground`
`--text-muted`       ← `dark_foreground`
`--accent-color`     ← `accent`
`--accent-foreground`← `background` (inverted text)

(Keep this table in sync with the `TARGET_MAP` object — it is the source of
truth.)

`COMPOSITE_TARGETS` derive: status colours, borders, input/tag backgrounds,
hover surfaces, and the translucent page surface — plus their `rgb()` triplet
companions where CSS needs a raw channel list.

## Universal readability enforcement

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