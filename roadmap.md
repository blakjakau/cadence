# Cadence Roadmap

This document outlines the planned and potential future features for Cadence.

## High Priority / Short Term

### [ ] Native UI Layer (Wails / Electron / WebView)
- **Goal**: Move beyond the "browser tab" and provide a dedicated application window.
- **Concept**: Use a framework like **Wails** (which uses the native system webview and integrates perfectly with Go) or **Electron** to package Cadence as a standalone desktop app.
- **Benefit**: Better keyboard shortcut handling (no browser conflicts), persistent window state, and deeper OS integration.

### [ ] AI Agent Harness
- **Goal**: Provide a native execution environment for AI agents (like Antigravity) to interact with the workspace.
- **Concept**: Create a specialized API or "sandbox" that allows an AI to securely run terminal commands, read/write files, and receive UI context directly through the Cadence backend.
- **Benefit**: Real-time, autonomous pair programming where the AI can "see" and "do" exactly what the user is doing.

### [ ] Overlay Filesystem & Incremental Patching
- **Goal**: Allow "in the wild" updates to the application frontend without requiring a full 15MB+ binary download.
- **Concept**: Implement a layered `fs.FS` in Go that checks a local data directory (e.g., `~/.local/share/cadence/overrides`) before falling back to the `embed.FS` compiled into the binary.
- **Benefit**: Faster iteration and smaller patch sizes for production users.
- **Technical Detail**: The Go backend can fetch a manifest of changed files and download only the diffs, storing them in the override layer.

### [ ] Improved Local AI Orchestration
- **Goal**: Move more of the AI provider logic from the frontend to the Go backend.
- **Concept**: Create a standard `AIProvider` interface in Go that can manage local Llama.cpp, Ollama, or Whisper instances.
- **Benefit**: Centralized management of models, better resource handling, and reduced frontend complexity.

## Medium Term

### [ ] Plugin System (WASM)
- **Goal**: Allow users to extend Cadence functionality without modifying the core Go code.
- **Concept**: Use a WASM runtime (like `wazero`) to execute plugins that can interact with the File API and Terminal.

### [ ] Deep System Integration
- **Goal**: Make Cadence feel like a native OS component.
- **Concept**: 
  - Proper tray icons and system menus.
  - Better desktop notifications.
  - Advanced protocol handling (e.g., `web+cadence://open?file=path/to/file`).

## Long Term / Exploration

### [ ] Multi-User / Collaboration
- **Goal**: Allow multiple users to connect to the same Cadence instance for pair programming.
- **Concept**: Implement a CRDT-based synchronization layer for the Ace editor.

### [ ] Mobile Companion App
- **Goal**: View and trigger tasks on a Cadence-managed workspace from a mobile device.
- **Concept**: A lightweight PWA or React Native app that connects to the Cadence API.
