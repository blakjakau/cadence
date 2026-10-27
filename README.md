# Cadence

Cadence is a passion project where I'm messing around with a few different ideas:

Forked from [Code](https://github.com/blakjakau/dev.jakbox.code) - a bit of an old experiment in building a web-based code editor that doesn't suck - and [Conduit](https://github.com/blakjakau/dev.jakbox.conduit) my attempts at building a file access service binary as an optional plugin for Code.

- Building a code editor that lives in the browser but feels like it belongs on the desktop.
- Deeply integrating with **Conduit** to handle the file system over WebSockets (because the File System Access API is a bit of a headache).
- Giving the editor a **self-driving agent** — a real pair programmer that can read, search, edit, run commands, research, and even spawn sub-agents — and watching how it changes the way I code.

It's essentially a custom UI system wrapped around the Ace editor, backed by a Go server. I'm using it as a playground to explore how web-based dev tools can be faster, more resilient, and more friendly to AI-driven workflows.

## What's in here?

- **The Conduit Bridge**: Instead of constant permission popups, it uses a solid WebSocket connection to my Conduit backend to handle all the heavy lifting for files.
- **Persistent Workspace**: It remembers your open folders, active tabs, and UI layout so you don't have to set it up every time you reload.
- **Dual-Pane Layout**: Side-by-side editors for when you're refactoring or comparing stuff.
- **AI Manager**: A dedicated spot to plug in LLMs (Gemini, Claude, Ollama, and Llama.cpp) and experiment with agentic coding patterns.
- **The Agent**: The headline feature. More below, because it's the reason this repo has a `feature/agent` branch that's 89 commits long.
- **Custom UI**: No heavy frameworks here — just some vanilla JS and a lot of experiments with a custom web-component system (`Block`, `Button`, `Input`, etc.).
- **Go Backend**: A single Go server doing file handling over WebSockets, multi-root project indexing, and graceful self-restart.

## The Agent

The agent is the part I actually care about. It's not a chat box that *talks* about code — it's a loop that *does* code, with a real tool belt:

- **Read & explore**: `read_file` (with line ranges), `read_file_outline`, `read_symbol`, `list_files`, `search_files`, `search_in_file`, `find_file`.
- **Edit**: `edit_file` with exact-substring matching (and a "forgiveness" mode that auto-backups so you can roll back with one click), plus `create_file` for new files.
- **Execute**: `run_command` for terminal work — gated behind your approval unless you whitelist it.
- **Validate**: `validate_syntax` runs Prettier / `node -c` *before* anything hits disk, so the agent doesn't ship broken code.
- **Plan & track**: `create_implementation_plan` and `update_task_list` so bigger changes get a roadmap and a checklist instead of a prayer.
- **Delegate**: `create_sub_agent` spawns linked sub-agents with a clean context and a smaller toolset, and can query them back (`query_sub_agent`, `query_parent`).
- **Research**: `research` (Tavily-backed, with a web-search fallback) and `web_fetch` for when the model's memory is stale.
- **Ask you**: `query` pauses the loop and asks a human when it can't tell from the codebase alone.

It's got **modes** too: a **planning mode** that refuses to touch files until a plan is agreed, a **forgiveness edit mode** with auto-backups and rollback checkpoints, and **per-session** settings so one chaotic session doesn't bleed into the next. The UI streams the agent's work live — tool cards, token counts, and cycle summaries — so you're watching it think rather than staring at a spinner.

## Sandboxed Execution (Linux Only)

`run_command` and the user terminal can run inside an **optional user-namespace sandbox** (Linux-only; no-op on macOS/Windows). The sandbox is *path-scoped*, not user-scoped: it bind-mounts your project roots (writable) plus read-only system passthroughs into a fresh mount namespace, so a command sees only the roots it's given and can't read `/etc/shadow` or wander into other directories.

A sandbox is a **persistent, addressable instance** (not a per-command bubble), keyed by a layout fingerprint (sorted roots + flags). Agent sessions hold a **sticky** owner for the session's lifetime, and user terminal tabs can **attach** to an agent session's instance by ID — so the user sees exactly the agent's workspace (same file view, and the same in-namespace processes when the PID namespace is enabled). A `🔒 sbx-<id>` badge on a terminal tab and on the `run_command` output block shows the shared instance and who else is inside.

### Ubuntu 24.04+ user-namespace restriction

Ubuntu 23.10+/24.04 set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks unprivileged `unshare(CLONE_NEWUSER)` by default. On such a host the sandbox probe reports *unavailable* and the feature degrades to the unsandboxed fallback - unless the **Cadence AppArmor profiles** are installed. They ship in one consolidated file (`scripts/cadence_aa_profile.txt`, installed verbatim to `/etc/apparmor.d/cadence`) with four profiles: `cadence` (glob-attached to every standard cadence binary path, permissive host-spawner profile with the `userns` grant that exempts it from the restriction), `cadence_sbx_keeper` (the hardened keeper), `cadence_sbx_shell` (the hardened, air-gapped agent shell), and `cadence_sbx_net` (the same shell with governed network - preloaded for future use).

```bash
# Install the profiles (no arguments needed) and restart the server:
sudo scripts/install-apparmor-profile.sh
# scripts/dev.sh runs this automatically when AppArmor is active.
```

No system-level changes: the kernel sysctl stays at its secure default and only the cadence profiles are exempt. As an alternative, disabling the sysctl globally requires root (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`). The server detects this at startup and surfaces the reason in the settings panel so you know why the sandbox badge is absent.

## Poking around

If you want to run it yourself, you'll need Go installed:

```bash
# Just run it (opens a native window)
go run .

# Open in your browser instead of a native window
go run . -browser

# Frontend code? Serve it live so your edits show up without a rebuild
go run . -serve ./app
```

Once it's running, the backend listens on `3022` (`3023` in dev mode).

## Extra Documentation

Beyond the sandbox write-up above, the `docs/` folder holds two deeper dives worth reading:

- **[Sandbox Execution](docs/sandbox.md)** - full implementation details — the reexec keeper model, mount layout, API surface, hardening, tests and reference to external projects that informed the implementation.
- **[The Cadence Harness Standard (Oct 2026)](docs/harness-sota-oct26.md)** — a researched "state-of-the-art" reference for how a modern agentic-coding *harness* should be built, paired with a self-evaluation of how Cadence itself measures up. Each theme (tool design, agentic loops, error recovery, safety & sandboxing, memory, multi-agent, evaluation, human-in-the-loop, self-improvement, concurrency) gets a frontier reference, a "the standard" rubric, and a 1–5 maturity score for Cadence's implementation with concrete gaps to close. It's the living spec for where the agent is heading — the August 2026 edition ([`harness-sota-aug26.md`](docs/harness-sota-aug26.md)) is kept for the historical record.
- **[AI Context Management in Cadence](docs/context-management.md)** — a source-level assessment of how the agent keeps long sessions from exhausting the model's prefill window: a token-driven sliding window, automated multi-cycle compaction with archive separation, the evergreen scratchpad and its ephemeral pressure nudge, model-led culling (`cull_history`), and sub-agent context isolation.

## Status

This is very much a "work in progress" and a bit of a mess in places. I'm mostly building it for myself to see what sticks. Feel free to use it, break it, or take bits of it.

---
*Built for the fun of it by blakjakau*
