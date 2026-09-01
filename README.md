# Cadence

*A bit of an experiment in building a web editor that doesn't suck.*

Cadence is a passion project where I'm messing around with a few different ideas:

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

## Status

This is very much a "work in progress" and a bit of a mess in places. I'm mostly building it for myself to see what sticks. Feel free to use it, break it, or take bits of it.

---
*Built for the fun of it by blakjakau*
