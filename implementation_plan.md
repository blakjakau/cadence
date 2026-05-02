# Conduit as Host: Deep Integration Plan

This plan details the steps to rebuild the editor around Conduit by allowing the Go backend to natively serve the frontend's static assets. This eliminates the need for the Node.js/Express server and centralizes the application architecture.

## User Review Required

> [!IMPORTANT]
> **Embedded Assets vs. Directory Serving**
> For the ultimate "single binary" experience, Go can compile the entire `code-pwa` folder directly into the executable using the `embed` package. However, during development, it's easier to serve live files directly from disk. 
> *Proposed Solution*: We add a `--serve <path>` CLI flag to Conduit. If provided, it serves the live files from that directory (great for your current dev setup). If not provided, it serves a compiled-in version of the PWA using `embed`. 

> [!IMPORTANT]
> **Repository Strategy**
> As requested, we will create a brand new monorepo `dev.jakbox.cadence`. This repository will contain both the Conduit backend (Go) and the Code frontend (HTML/JS/CSS), unified into a single project structure. The existing `dev.jakbox.conduit` and `dev.jakbox.code` repos will remain untouched to preserve their legacy functionality.

## Proposed Changes

### Phase 1: Initialize `dev.jakbox.cadence` Monorepo
- Create the new directory `/home/jason/repo/dev.jakbox.cadence`.
- Copy the contents of `dev.jakbox.conduit` into the root or a `backend/` folder (let's keep Go in the root for ease of building, similar to conduit).
- Copy the `code-pwa` directory from `dev.jakbox.code` into an `app/` folder within the new monorepo.
- Initialize a new git repository in the cadence folder.

### Phase 2: Update Conduit (now Cadence backend)
- **`main_common.go`**: 
  - Add a new CLI flag: `--serve <directory_path>`.
  - Implement `http.FileServer` logic to serve static files.
  - Update the main HTTP multiplexer to route everything not matching `/terminal`, `/files`, `/up`, etc., to the static file server.
  - Automatically launch the user's default browser to `localhost:3022` upon startup when running in server mode.
- **`embed.go`**: 
  - Setup `//go:embed app/*` directives to package a production build of the PWA directly into the cadence binary.

### Phase 3: Update Frontend (now Cadence frontend)
- **`app/js/conduit-client.mjs` & `terminal-manager.mjs`**:
  - Change hardcoded backend URLs (e.g., `ws://localhost:3022/terminal`) to relative URLs (e.g., `ws://${window.location.host}/terminal`). Because the frontend will be served by the backend, they will share the exact same origin, eliminating all CORS and API key complexity.

## Verification Plan

### Manual Verification
1. Run `go run . --serve /home/jason/repo/dev.jakbox.code/code-pwa` in the Conduit repository.
2. The browser should automatically open to `http://localhost:3022`.
3. The editor should load fully.
4. The terminal should connect instantly via the relative WebSocket path.
5. The File System panel should successfully read from the Conduit `/files` API instead of the browser's File System Access API.
