//go:build !linux

package main

import "os"

// sandboxKeeperEntry is a no-op on non-Linux platforms (sandboxing is
// Linux-only). It exists so main() can call it unconditionally.
func sandboxKeeperEntry() bool {
	if len(os.Args) >= 4 && os.Args[1] == "--sandbox-keeper" {
		// Should never happen on non-Linux; bail out.
		os.Exit(1)
	}
	return false
}

// startSandboxedShell is unavailable on non-Linux; callers must check the
// probe result (which reports "unsupported") and fall back to unsandboxed.
func startSandboxedShell(cfg *SandboxConfig, ownerLabel string) (*SandboxHandle, error) {
	return nil, &ErrSandboxUnavailable{Reason: "sandboxing is Linux-only"}
}

// attachToOwner is unavailable on non-Linux.
func attachToOwner(cfg *SandboxConfig, targetOwner, myOwner string) *SandboxHandle {
	return nil
}

// sandboxSupported reports whether the sandbox feature can run on this platform.
// The native namespace implementation is Linux-only.
func sandboxSupported() bool {
	return false
}

// findInstanceByOwner is a no-op on non-Linux.
func findInstanceByOwner(owner string) *SandboxInstance {
	return nil
}

// releaseOwner is a no-op on non-Linux.
func releaseOwner(owner string) {}

// sandboxStatus reports the sandbox as unsupported on non-Linux platforms.
func sandboxStatus() *SandboxStatusResponse {
	return &SandboxStatusResponse{
		Available: false,
		Reason:    "sandboxing is Linux-only",
		Instances: []SandboxInstanceInfo{},
	}
}
