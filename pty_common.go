package main

// ptyProcess is the platform-agnostic process handle returned by startPty.
// Pid is the host shell (unsandboxed) or the in-namespace shell (sandboxed);
// -1 when the platform cannot expose a pid (Windows ConPTY).
// Kill terminates the shell; Wait blocks until it exits (nil when the platform
// cannot wait directly — callers then rely on the pty master reaching EOF).
type ptyProcess struct {
	Pid  int
	Kill func()
	Wait func()
}
