//go:build linux

package main

// sandboxSupported reports whether the sandbox feature can run on this platform.
// The native namespace implementation is Linux-only; on other platforms the
// terminal reports sandbox: "unsupported".
func sandboxSupported() bool {
	return true
}
