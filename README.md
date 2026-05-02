# Cadence

*A bit of an experiment in building a web editor that doesn't suck.*

Cadence is a passion project where I'm messing around with a few different ideas: 
- Building a code editor that lives in the browser but feels like it belongs on the desktop.
- Deeply integrating with **Conduit** to handle the file system over WebSockets (because the File System Access API is a bit of a headache).
- Throwing in some AI agent "toys" to see how they change the way I code.

It's essentially a custom UI system wrapped around the Ace editor, backed by a Go server. I'm using it as a playground to explore how web-based dev tools can be faster, more resilient, and more friendly to AI-driven workflows.

## What's in here?

- **The Conduit Bridge**: Instead of constant permission popups, it uses a solid WebSocket connection to my Conduit backend to handle all the heavy lifting for files.
- **Persistent Workspace**: It tries its best to remember your open folders, active tabs, and UI layout so you don't have to set it up every time you reload.
- **Dual-Pane Layout**: Side-by-side editors for when you're refactoring or comparing stuff.
- **AI Manager**: A dedicated spot to plug in LLMs (Gemini, Ollama, etc.) and experiment with agentic coding patterns.
- **Custom UI**: No heavy frameworks here—just some vanilla JS and a lot of experiments with a custom component system (`Block`, `Button`, `Element`, etc.).

## Poking around

If you want to run it yourself, you'll need Go installed:

```bash
# Just run it
go run .

# If you're messing with the frontend code and want it to serve live:
go run . -serve ./app
```

## Status

This is very much a "work in progress" and a bit of a mess in places. I'm mostly building it for myself to see what sticks. Feel free to use it, break it, or take bits of it.

---
*Built for the fun of it by blakjakau*
