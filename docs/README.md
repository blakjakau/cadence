# Development Docs

A living set of knowledge documents for Cadence. These are intentionally
**started and revised incrementally** as models and contributors learn how the
app actually works — they are not exhaustive reference manuals and should be
grown rather than treated as finished.

- [theme-system.md](theme-system.md) — how theme colours are sourced, mapped
  onto Cadence's CSS variables, and the universal readability enforcement.
- [command-execution.md](command-execution.md) — how UI commands, menu items,
  and editor commands are wired and dispatched.

## Rules for contributors
- Prefer adding a fact to the right document over leaving it unexplained in
  code. If you encounter something undocumented while building, append a short
  section rather than relying on conversation memory.
- Mark uncertain or unverified points explicitly with a "TBD / verify" note so
  the next contributor knows to confirm them.
- Keep code comments pointing at `docs/…` when they describe a flow that lives
  here.