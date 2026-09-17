# Branch Structure & Merge History

Handover note for the `patched` and `tempo` branches (2026-09-17).

## Purpose

Two working branches were assembled so the full set of pending changes can be
used without touching `main`:

- **`patched`** — `main` + every merged PR from `blakjakau/cadence` **and** the
  `StuartRP/cadence` fork (the accidental fork's `main` was merged wholesale).
- **`tempo`** — `patched` + the `origin/tempo` branch work (UI system CSS,
  probe/OpenAI provider integration, accordion extraction, tooltips, fields).

Neither branch is merged into `main`; they are standalone, fully working
branches.

## Branch topology

```
main      a6cd7f4  (blakjakau/cadence main, PR #16 + #23 merged)
patched   1bfcc0f  (main + merge of stuart/main — all fork PRs)
tempo     0e10051  (patched + merge of origin/tempo + .gitignore merge)
```

## What was merged

### patched (1bfcc0f)
- `stuart/main` (StuartRP/cadence fork) merged into `patched` — brings in all
  PRs from the accidental fork: OpenAI/OpenRouter provider, model capability
  probe, omarchy/KDE/GNOME system theme bridge, logo reveal, menu keyboard
  navigation, workspace scoping/pinning, optional webview renderer, and the
  theme foundations (readable-theme, layout constants, theme vars).
- Clean merge, no conflicts.

### tempo (a288de5 + 0e10051)
- Rebuilt on top of the new `patched` (was previously based on old `main`).
- `origin/tempo` merged in (tempo-2/tempo-3 were identical to tempo, nothing
  extra). Conflicts resolved:
  - `ai-openai.mjs`, `ai-connections.mjs` — took tempo's version (probe
    integration is a superset of the fork's OpenAI provider work).
  - `agent-config-panel.mjs` — took tempo's version (canonical `.field` CSS
    classes, probe capability panel, investigate/verify flows).
  - `filebar.mjs` — merged: patched's title ("Workspace Roots (all chats)")
    + tempo's aria-label.
  - `session-artifacts-panel.mjs` — tempo's extracted `UIAccordion` import
    kept; patched's workspace accordion feature preserved; `workspaces: true`
    added to `accordion.mjs` default state.
  - `main.mjs` — kept patched's full omarchy `execCommandSetDarkMode`
    switch/case; tempo's `applyDarkModeClasses` helper retained for the
    initial-load path.
- `.gitignore` — merged the stashed agent-workspace entries (AGENTS.md,
  opencode.jsonc, .opencode/, tools/) with the Python/RAG/LSP entries.

## Verification (both branches)

- `go build ./...` — PASS
- `go test ./...` (conduit-server package) — PASS
- `node --check` on every `.mjs` — PASS
- All relative JS imports resolve (the `conduit-client.mjs?v=` query-string
  import is a pre-existing cache-buster pattern).
- `conduit-server/tests` package fails to build with `undefined: fileAPIRoot`
  etc. — **pre-existing on `main`**, not introduced by these branches.

## Remotes

- `origin` → `https://github.com/blakjakau/cadence.git`
- `stuart` → `https://github.com/StuartRP/cadence.git` (added to fetch the
  fork's PR branches; `stuart/main` was merged into `patched`)

## Status

- `patched` and `tempo` pushed to `origin` (blakjakau/cadence).
- `main` untouched.