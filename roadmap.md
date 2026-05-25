# Cadence Roadmap

This document outlines the planned and potential future features for Cadence.

## High Priority / Short Term

### [x] Native UI Layer (Wails, webview_go, and --browser)

### [x] AI Agent Harness

### [x] Development UI Serving (`--serve` flag)
- **Goal**: Allow easy development of the frontend by serving files from a local directory.
- **Concept**: Added a `--serve <path>` CLI flag to trigger the use of a development directory for the UI instead of the embedded assets.
- **Benefit**: Faster iteration during development.

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
