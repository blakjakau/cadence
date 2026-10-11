package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"github.com/gorilla/websocket"
)

// --- Server State ---
var activeConnections int32
var sessionIdCounter int32
var startTime time.Time

// A simple struct to handle JSON messages from the client
type wsMessage struct {
	Type    string `json:"type"`
	Content string `json:"content,omitempty"`  // Used by client for "data"
	Cols    int    `json:"cols,omitempty"`     // Used by client for "resize"
	Rows    int    `json:"rows,omitempty"`     // Used by client for "resize"
	Hostname string `json:"hostname,omitempty"` // Used by server for "terminalInfo"
	Cwd      string `json:"cwd,omitempty"`      // Used by server for "terminalInfo"

	// Sandbox fields (server → client, "terminalInfo").
	Sandbox       string   `json:"sandbox,omitempty"`       // "native"|"bwrap"|"off"|"unavailable"|"unsupported"
	SandboxReason string   `json:"sandboxReason,omitempty"` // why unavailable (AppArmor, etc.)
	SandboxID     string   `json:"sandboxID,omitempty"`     // shared instance id (sbx-xxxx)
	SandboxOwners []string `json:"sandboxOwners,omitempty"` // other owners inside the same instance
	SandboxShared bool     `json:"sandboxShared,omitempty"` // true when >1 owner shares the instance
	SandboxRoots  []string `json:"sandboxRoots,omitempty"`  // the instance's rw root layout (for attach)
}

// Struct for the /up status response
type statusResponse struct {
	Status            string  `json:"status"`
	Version           string  `json:"version"`
	Mode              string  `json:"mode"`
	UptimeSeconds     float64 `json:"uptime_seconds"`
	ActiveConnections int32   `json:"active_connections"`
	IsInstalled       bool    `json:"is_installed"`
}

// Gorilla WebSocket upgrader with origin check
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if allowedOrigins[origin] {
			return true
		}
		log.Printf("[SECURITY] Denied connection from invalid origin: %s", origin)
		return false
	},
}

// checkRequestAuthorization checks the origin or API key for a request.
// It returns true if the request is authorized, false otherwise.
func checkRequestAuthorization(r *http.Request) bool {
	origin := r.Header.Get("Origin")

	if debugLogging {
		log.Printf("[DEBUG] Auth check: method=%s, path=%s, origin='%s'", r.Method, r.URL.Path, origin)
	}

	if origin != "" {
		// If an Origin header is present, enforce CORS based on allowedOrigins.
		if allowedOrigins[origin] {
			return true
		}
		log.Printf("[SECURITY] Denied: Invalid Origin '%s' from %s", origin, r.RemoteAddr)
		return false
	}

	// If no Origin header, check if it's a loopback address.
	// We split RemoteAddr to get just the IP, ignoring the port.
	remoteIP := r.RemoteAddr
	if colon := strings.LastIndex(remoteIP, ":"); colon != -1 {
		remoteIP = remoteIP[:colon]
	}
	if remoteIP == "127.0.0.1" || remoteIP == "[::1]" { // Check for IPv4 and IPv6 loopback
		return true // Allow loopback without Origin or API key
	}

	// No Origin header: check for required API key.
	if requiredAPIKey != "" {
		providedKey := r.Header.Get("X-Cadence-Key") // Check header first
		if providedKey == "" {
			providedKey = r.URL.Query().Get("key") // Then check query parameter
		}

		if providedKey == "" {
			log.Printf("[SECURITY] Denied: Missing API key for no-origin request from %s", r.RemoteAddr)
			return false
		}
		if providedKey != requiredAPIKey {
			log.Printf("[SECURITY] Denied: Invalid API key from %s", r.RemoteAddr)
			return false
		}
		if debugLogging {
			log.Printf("[DEBUG] Authorized: API key matched for no-origin request from %s", r.RemoteAddr)
		}
		return true
	}

	// If we reach here: no Origin header, AND no API key is required/configured.
	// Deny by default in this scenario to prevent unintended access.
	if debugLogging {
		log.Printf("[DEBUG] Denied: No Origin and no API key configured/provided for %s", r.RemoteAddr)
	}
	return false
}

// writePump pumps messages from the PTY to the websocket connection.
func writePump(ws *websocket.Conn, ptmx io.ReadCloser, sessionID int32) {
	defer ws.Close()
	buffer := make([]byte, 4096)
	for {
		n, err := ptmx.Read(buffer)
		if err != nil {
			// If the PTY process has exited, this read will eventually return an error like EOF.
			// We close the websocket when that happens.
			// This usually means the PTY process has exited.
			return
		}
		// Use BinaryMessage to safely transmit raw PTY output, which may contain
		// non-UTF-8 bytes (e.g. from vim, specialized escape sequences, etc).
		// TextMessage requires strictly valid UTF-8, which the browser enforces,
		// causing connection drops on invalid sequences.
		if err := ws.WriteMessage(websocket.BinaryMessage, buffer[:n]); err != nil {
			return
		}
	}
}

// readPump pumps messages from the websocket connection to the PTY.
// resize is this session's own resize closure (per-session, no global race).
func readPump(ws *websocket.Conn, ptmx io.Writer, proc *ptyProcess, sessionID int32, resize func(cols, rows int)) {

	defer func() {
		ws.Close()
		if proc != nil && proc.Kill != nil {
			proc.Kill()
		}
	}()

	for {
		messageType, p, err := ws.ReadMessage()
		if err != nil {
			if !websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WS read error for session #%d: %v", sessionID, err)
			}
			break
		}

		if messageType == websocket.TextMessage || messageType == websocket.BinaryMessage {
			// Try parsing as JSON control message first
			var msg wsMessage
			if err := json.Unmarshal(p, &msg); err == nil && msg.Type != "" {
				switch msg.Type {
				case "resize":
					if resize != nil {
						resize(msg.Cols, msg.Rows)
					}
				case "data":
					ptmx.Write([]byte(msg.Content))
				}
				continue
			}

			// Direct raw stream data sent from terminal clients or agent tools
			ptmx.Write(p)
		}
	}
}

// terminalServer handles websocket requests from the peer.
func terminalServer(w http.ResponseWriter, r *http.Request) {
	// Override the upgrader's CheckOrigin to use our shared authorization logic.
	// This ensures consistency between /terminal and /files WS origins.
	upgrader.CheckOrigin = func(req *http.Request) bool {
		return checkRequestAuthorization(req)
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ERROR: Failed to upgrade connection: %v", err)
		return
	}
	defer ws.Close()

	atomic.AddInt32(&activeConnections, 1)
	sessionID := atomic.AddInt32(&sessionIdCounter, 1)
	defer atomic.AddInt32(&activeConnections, -1)

	// Get settings from query parameters
	query := r.URL.Query()
	customDir := query.Get("dir")
	customPrompt := query.Get("prompt")

	shell := "bash"
	if os.Getenv("OS") == "Windows_NT" {
		shell = "powershell.exe"
	}

	// Determine starting directory
	startDir := customDir
	homeDir, homeErr := os.UserHomeDir()

	if startDir == "" {
		if homeErr != nil {
			log.Printf("ERROR: Could not get user home directory: %v, using current directory.", homeErr)
			startDir = "."
		} else {
			startDir = homeDir
		}
	} else {
		// 1. Expand leading ~/
		if strings.HasPrefix(startDir, "~/") && homeErr == nil {
			startDir = filepath.Join(homeDir, startDir[2:])
		} else if homeErr == nil {
			// 2. If startDir doesn't exist as an absolute path, test if it is relative to homeDir
			// (handles cases where frontend passes paths like "/repo/..." or "repo/..." meant relative to home)
			if _, err := os.Stat(startDir); os.IsNotExist(err) {
				cleanRel := strings.TrimPrefix(startDir, "/")
				candidate := filepath.Join(homeDir, cleanRel)
				if _, cErr := os.Stat(candidate); cErr == nil {
					startDir = candidate
				}
			}
		}
		if absPath, err := filepath.Abs(startDir); err == nil {
			startDir = absPath
		}
	}
	
	// Check if startDir exists, fallback to home if not
	if _, err := os.Stat(startDir); os.IsNotExist(err) {
		log.Printf("WARNING: Directory %s does not exist, falling back to home.", startDir)
		if homeErr == nil {
			startDir = homeDir
		}
	}

	// --- Sandbox wiring (Linux-only; no-op elsewhere) ---
	// Query params:
	//   sandbox=1            → run this shell inside a sandbox (agent run_command)
	//   sandbox=attach       → join the sandbox of another owner (user terminal)
	//   roots=<a,b,c>        → rw roots (securePath-validated server-side)
	//   session=<id>         → owner label (agent) / attach target owner (user)
	//   sandbox_ro=<paths>   → extra ro passthroughs
	//   sandbox_pid/net/uts/ipc=1 → namespace flags
	sandboxParam := query.Get("sandbox")
	agentSession := query.Get("session")
	ownerLabel := ""
	if agentSession != "" {
		ownerLabel = "session:" + agentSession
	}

	// Explicit owner release: the frontend sends `sandbox_release=1&session=<id>`
	// when an agent session is destroyed, so its sticky sandbox owner is dropped
	// and the instance reaps if it was the last owner. This is a no-op handshake
	// (no shell is started); the client disconnects immediately.
	if query.Get("sandbox_release") == "1" && ownerLabel != "" {
		releaseOwner(ownerLabel)
		log.Printf("session #%d: released sandbox owner %q", sessionID, ownerLabel)
		return
	}

	// Validate roots server-side (never trust the query param). `sandbox_roots`
	// is the explicit root set (used by the user terminal to exactly match an
	// agent session's layout so it joins the SAME instance); `roots` is a
	// convenience alias.
	var sandboxRoots []string
	rootsParam := query.Get("sandbox_roots")
	if rootsParam == "" {
		rootsParam = query.Get("roots")
	}
	if rootsParam != "" {
		for _, r := range strings.Split(rootsParam, ",") {
			r = strings.TrimSpace(r)
			if r == "" {
				continue
			}
			if abs, err := securePath(r); err == nil {
				sandboxRoots = append(sandboxRoots, abs)
			} else {
				log.Printf("session #%d: rejecting sandbox root %q: %v", sessionID, r, err)
			}
		}
	}

	var sbxHandle *SandboxHandle
	var sbxStatus, sbxReason string
	if sandboxParam == "1" || sandboxParam == "attach" {
		if !sandboxSupported() {
			// Non-Linux: the sandbox feature is unavailable by design.
			sbxStatus = "unsupported"
			sbxReason = "sandboxing is Linux-only"
		} else {
			if len(sandboxRoots) == 0 {
				// Fall back to the start dir as the single root.
				if abs, err := securePath(startDir); err == nil {
					sandboxRoots = []string{abs}
				}
			}
			if len(sandboxRoots) == 0 {
				sbxStatus = "unavailable"
				sbxReason = "no valid roots"
			} else {
				cfg := &SandboxConfig{
					Roots: sandboxRoots,
					Cwd:   startDir,
					Flags: SandboxFlags{
						PID: query.Get("sandbox_pid") == "1",
						NET: query.Get("sandbox_net") == "1",
						UTS: true,
						IPC: true,
					},
				}
				if roParam := query.Get("sandbox_ro"); roParam != "" {
					for _, r := range strings.Split(roParam, ",") {
						r = strings.TrimSpace(r)
						if r != "" {
							cfg.ReadOnlyRoots = append(cfg.ReadOnlyRoots, r)
						}
					}
				}
				if sandboxParam == "attach" {
					// Join the target owner's instance and spawn THIS shell inside
					// the same namespace — the user sees exactly the agent's
					// workspace (same file view, same in-ns processes). This tab's
					// label is added as a co-owner (shared badge).
					myLabel := "terminal:" + query.Get("tab")
					if myLabel == "terminal:" {
						myLabel = "terminal:" + fmt.Sprintf("%d", sessionID)
					}
					sbxHandle = attachToOwner(cfg, ownerLabel, myLabel)
					if sbxHandle != nil {
						sbxStatus = sbxHandle.Method
					} else {
						sbxStatus = "unavailable"
						sbxReason = "attach failed"
					}
				} else {
					// Sandboxed shell: spawn an in-ns shell attached to a fresh pty.
					label := ownerLabel
					if label == "" {
						label = "terminal:" + fmt.Sprintf("%d", sessionID)
					}
					h, err := startSandboxedShell(cfg, label)
					if err != nil {
						var unavail *ErrSandboxUnavailable
						if errors.As(err, &unavail) {
							sbxReason = unavail.Reason
						} else {
							sbxReason = err.Error()
						}
						log.Printf("session #%d: sandbox failed, falling back unsandboxed: %v", sessionID, err)
					} else {
						sbxHandle = h
						sbxStatus = h.Method
					}
				}
				if sbxStatus == "" {
					sbxStatus = "unavailable"
				}
			}
		}
	}
	if sbxStatus == "" {
		sbxStatus = "off"
	}

	// Determine the sandbox owner label for this connection and whether it is
	// sticky. A `session:<id>` owner (agent) is STICKY: run_command opens a fresh
	// WS per command, so the owner must survive each WS close and persist for the
	// session's lifetime (released only via an explicit `sandbox_release=1`). A
	// `terminal:<tab>` owner (user terminal) is TRANSIENT: released when the tab's
	// WS closes. On the `attach` path the co-owner added is the transient terminal
	// label, so only that is released on close (the target agent owner stays).
	sandboxOwner := ""
	sandboxOwnerSticky := false
	if sbxHandle != nil {
		sandboxOwnerSticky = ownerLabel != "" // agent session owner
		sandboxOwner = ownerLabel
		if sandboxParam == "attach" {
			sandboxOwner = "terminal:" + query.Get("tab")
			if sandboxOwner == "terminal:" {
				sandboxOwner = "terminal:" + fmt.Sprintf("%d", sessionID)
			}
		}
	}

	// Use our new platform-agnostic function to start the PTY.
	var resizeFunc func(cols, rows int)
	var ptmx io.ReadWriteCloser
	var ptyCmd *ptyProcess
	if sbxHandle != nil && sbxHandle.Master != nil {
		// Sandboxed: the handle carries the pty master + in-ns process.
		ptmx = sbxHandle.Master
		ptyCmd = &ptyProcess{Pid: sbxHandle.Pid, Kill: sbxHandle.Kill}
		resizeFunc = sbxHandle.Resize
	} else {
		var startErr error
		ptmx, ptyCmd, resizeFunc, startErr = startPty(shell, startDir, customPrompt, nil)
		if startErr != nil {
			log.Printf("ERROR: Failed to start PTY for session #%d: %v", sessionID, startErr)
			return
		}
	}
	defer ptmx.Close()

	timestamp := time.Now().UTC().Format(time.RFC3339)

	// Get hostname
	hostname, err := os.Hostname()
	if err != nil {
		log.Printf("Error getting hostname: %v", err)
		hostname = "unknown"
	}

	// The initial working directory of the PTY process (which was set to startDir)
	initialCwd := startDir

	// Send initial terminal info to the client
	infoMsg := wsMessage{
		Type:    "terminalInfo",
		Hostname: hostname,
		Cwd:     initialCwd,
		Sandbox: sbxStatus,
		SandboxReason: sbxReason,
	}
	if sbxHandle != nil {
		infoMsg.SandboxID = sbxHandle.ID
		infoMsg.SandboxOwners = sbxHandle.Owners
		infoMsg.SandboxShared = sbxHandle.Shared
		infoMsg.SandboxRoots = sbxHandle.Roots
	}
	ws.WriteJSON(infoMsg) // Ignore error, best effort to send initial info

	pid := -1 // Default to -1 if process info is not available (e.g., on Windows)
	if ptyCmd != nil {
		pid = ptyCmd.Pid
	}
	log.Printf("[%s] Client #%d (PID: %d, sandbox: %s) connected (active: %d)", timestamp, sessionID, pid, sbxStatus, activeConnections)
	defer log.Printf("[%s] Client #%d (PID: %d) disconnected (active: %d)", time.Now().UTC().Format(time.RFC3339), sessionID, pid, activeConnections)
	// Start a goroutine to wait for the PTY process to exit. When it exits,
	// we close the WebSocket connection. This is crucial for reliably
	// handling the "exit" command from within the shell, especially on Windows.
	if ptyCmd != nil && ptyCmd.Wait != nil {
		go func() {
			ptyCmd.Wait()
			ws.Close()
		}()
	}
	go writePump(ws, ptmx, sessionID)
	readPump(ws, ptmx, ptyCmd, sessionID, resizeFunc)

	// Release the transient (terminal) sandbox owner now that this connection
	// has closed. Sticky (agent session) owners are released only via an
	// explicit `sandbox_release=1` handshake when the session is destroyed.
	if sandboxOwner != "" && !sandboxOwnerSticky {
		releaseOwner(sandboxOwner)
	}
}

// upcheckHandler provides a simple health check endpoint.
func upcheckHandler(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(startTime).Seconds()
	connections := atomic.LoadInt32(&activeConnections)

	resp := statusResponse{
		Status:            "running",
		Version:           version,
		Mode:              RendererMode,
		UptimeSeconds:     uptime,
		ActiveConnections: connections,
		IsInstalled:       checkIfInstalled(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}


