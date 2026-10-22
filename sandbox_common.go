package main

import "io"

// SandboxFlags controls which additional namespaces the instance joins.
// NET and PID are OFF by default so git/network and the host process view keep
// working; they are explicit opt-ins. UTS and IPC default ON.
type SandboxFlags struct {
	PID bool // CLONE_NEWPID (default false)
	NET bool // CLONE_NEWNET (default false)
	UTS bool // CLONE_NEWUTS (default true)
	IPC bool // CLONE_NEWIPC (default true)
}

// SandboxConfig describes the layout of a sandbox instance.
type SandboxConfig struct {
	Roots         []string // rw project roots (bind-mounted at their real path)
	ReadOnlyRoots []string // ro passthroughs (e.g. /usr, /etc) â default set if nil
	Cwd           string   // initial working directory (must be under a root)
	Env           []string // extra env (scrubbed; see scrubEnv)
	Flags         SandboxFlags
	Shell         string // shell to exec (default /bin/bash)
	Owner         string // owner label for refcounting (e.g. "session:42", "terminal:tab3")
	// UserBashRC is the host path of the user's shell config (e.g.
	// <home>/.config/cadence/.bashrc). The sandbox does NOT mount the user's
	// home dir, so an interactive non-login bash finds no ~/.bashrc in-ns and
	// sources nothing. To give the user a working shell config, this file is
	// ro-bound onto $HOME/.bashrc INSIDE the sandbox (a sourceâ"dest remap), so
	// bash auto-sources it exactly like a real home. Empty = no remap. Kept out
	// of the layout fingerprint (it is a per-instance shell nicety, not a layout
	// axis that should churn the instance id).
	UserBashRC string
}

// ErrSandboxUnavailable is returned when the sandbox cannot be created; the
// Reason lets the UI explain why (and the caller fall back to unsandboxed).
type ErrSandboxUnavailable struct {
	Reason string
}

func (e *ErrSandboxUnavailable) Error() string {
	return "sandbox unavailable: " + e.Reason
}

// SandboxInstanceInfo describes a live sandbox instance (for the UI to list
// attachable agent sandboxes).
type SandboxInstanceInfo struct {
	ID     string   `json:"id"`
	Roots  []string `json:"roots"`
	Owners []string `json:"owners"`
	Shared bool     `json:"shared"`
}

// SandboxStatusResponse is the JSON payload for GET /api/sandbox: the sandbox
// capability probe result plus the list of live sandbox instances.
type SandboxStatusResponse struct {
	Available bool                  `json:"available"`
	Method    string                `json:"method,omitempty"` // "native" | "bwrap"
	Reason    string                `json:"reason,omitempty"` // why unavailable
	Instances []SandboxInstanceInfo `json:"instances"`
}

// SandboxHandle is the caller-facing handle for a sandboxed shell.
type SandboxHandle struct {
	Master io.ReadWriteCloser // pty master: read shell output, write input
	Resize func(cols, rows int)
	Kill   func()
	Pid    int // the in-ns shell (join-child) pid
	// Instance metadata (for terminalInfo)
	ID     string
	Owners []string
	Shared bool
	Method string // "native" | "bwrap"
	// Roots is the instance's rw root layout, so the frontend can echo it back
	// as `sandbox_roots` for an exact-fingerprint attach.
	Roots []string
}
