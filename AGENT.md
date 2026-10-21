# Agent Notes

## Builds

- **Linux is the only platform that is kept current.** `go build ./...` on the dev box (Linux) is the source of truth.
- **Windows and macOS builds are intentionally out of date** — they will be picked up in a separate project. Do NOT attempt to fix or verify `GOOS=windows` / `GOOS=darwin` builds in this repo.
  - The `github.com/webview/webview_go` dependency has no files for non-Linux GOOS values, so cross-compiling here fails by design (pre-existing, unrelated to any recent change).
- Build command: `export PATH=$PATH:/usr/local/go/bin; go build ./...` (commands always run from the project root; no `cd` needed).
- Restart the running dev server with `curl -X POST http://localhost:3022/api/restart` after a backend change.

## Sandbox (Linux-only feature)

- Native user-namespace sandboxing lives in `sandbox_unix.go` (linux build tag) with a no-op stub in `sandbox_other.go` (`!linux`). `sandbox_common.go` holds the shared types.
- Tests: `sandbox_unix_test.go` (linux). Pure tests (`TestBwrapArgv`, `TestScrubEnv`, `TestFingerprint`, `TestProbe`) always run; the end-to-end native tests skip when unprivileged userns is blocked (e.g. Ubuntu 24.04+ AppArmor restriction).
- bwrap fallback: `bwrapArgv()` is a pure function (tested without bwrap installed); `spawnBwrapShell` runs per-shell bwrap (no persistent keeper) when the probe method is `bwrap`.
