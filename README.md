# Cadence
**The High-Performance, Agent-First Web Editor**

Cadence is a modern, lightweight, and extensible web-based code editor designed for seamless integration with AI agents and remote environments. Built on top of the Ace editor and powered by a high-performance Go backend, Cadence provides a premium development experience directly in your browser.

Cadence has been completely re-architected to use the **Conduit WebSocket API**, providing a robust, real-time bridge between the web interface and the host file system.

## ✨ Key Features

- **🚀 Conduit Integration**: Low-latency file system operations via WebSockets, bypassing the limitations and permission hurdles of the legacy File System Access API.
- **🤖 Agent-First Design**: Native integration with AI-driven development workflows, featuring dedicated panels for AI session management and context-aware prompting.
- **📁 Smart Workspace**: Automatically restores your folders, open tabs, and UI state across sessions, ensuring you can pick up exactly where you left off.
- **🔀 Multi-Pane Productivity**: Flexible dual-pane editor layout for efficient cross-file editing and complex refactoring tasks.
- **🎨 Premium UI System**: A custom-built, lightweight UI component library that provides a sleek, responsive, and high-performance interface.
- **🌓 Dark Mode**: Built-in support for light and dark themes with automatic system detection.

## 🛠️ Architecture

Cadence consists of two main components:
1. **Frontend**: A custom vanilla JavaScript application using a bespoke component system and the Ace editor.
2. **Backend (Conduit)**: A robust Go server that handles file system operations, terminal PTY sessions, and secure communication via WebSockets.

## 🚀 Getting Started

### Prerequisites
- [Go](https://golang.org/doc/install) (1.20 or later)

### Installation & Running

1. **Clone the repository**:
   ```bash
   git clone git@github.com:blakjakau/cadence.git
   cd cadence
   ```

2. **Run the server**:
   ```bash
   go run .
   ```
   By default, Cadence will start a local server and open your default browser.

3. **Development Mode**:
   To serve the frontend files directly (instead of using the embedded versions), use the `-serve` flag:
   ```bash
   go run . -serve ./app
   ```

## 📜 Commands & Options

Cadence supports several command-line flags for advanced configuration:
- `-debug`: Enable detailed debug logging.
- `-root <path>`: Set the root directory for the file API (defaults to the user's home directory).
- `-key`: Manage and print the API key for secure no-origin requests.
- `-install-user`: Install Cadence as a user-level application and protocol handler.
- `-no-idle-shutdown`: Disable automatic shutdown during inactivity.

## 🤝 Contributing

Cadence is under active development. Contributions, issues, and feature requests are welcome!

---
*Created with ❤️ by blakjakau*
