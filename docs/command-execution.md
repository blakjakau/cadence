# Command Execution

How UI commands, menu items, and editor commands reach their handlers.

## Dispatcher: `window.ui.execCommand(c, args)`

Defined around `app/js/main.mjs:3871`.

`c` is a command key of the form `target:command:ext` (segments optional). It
is split and routed:

```text
"editor:command:ext"  →  currentEditor.execCommand(command, ext)   (ACE)
"app:command:…"       →  window.ui.commands.exec(command, ext)      (registry)
"*:command:…"         →  app registry
```

- `editor` targets are handed straight to the active Ace editor instance.
- Everything else goes through the `window.ui.commands` registry.

## Registry: `window.ui.commands`

Defined around `app/js/main.mjs:211`. Holds:

- `byName` / `byKeys` — lookups by name or bound keyboard key;
- `add(command)` — registers a command object; if its `bind` specifies `editor`
  it is bound into every ACE editor, otherwise it's registered by name so
  `exec()` can dispatch to it;
- `exec(command, ext)` — runs the named handler.

Editor commands with a bind key are installed once at startup
(`window.ui.commands.add(bind)` at `main.mjs:3868`), usually inside the loop
that wires per-editor command support.

## Handlers

Large named handlers live in `main.mjs`: `execCommandAbout`,
`execCommandSetDarkMode`, `execCommandAddFolder`, `execCommandSplitView`, and
friends handle the `app:*` commands.

## Menu wiring

App menu entries are declared declaratively in `app/index.html`:

```html
<ui-menu id="theme_menu" attachTo="#theme_select" slim
         onclick="(e)=>{ window.ui.execCommand(e) }">
```

Each `<ui-menu-item>` carries the command string in its `command="…"`
attribute (e.g. `command="app:setTheme:…"`). The ui-menu component reports the
selected item through the callback; the argument the callback receives is the
item's `command` value.

(TBD — verify: confirm the exact shape ui-menu passes to `onclick` and confirm
whether the currently-focused editor is always `window.aceEditor` / the target
of `currentEditor`, or whether multiple editor panes select it per-pane.)