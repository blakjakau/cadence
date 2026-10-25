#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# dev.sh - build + run the Cadence dev server with a STABLE binary path,
# and install the dev AppArmor profile when the platform uses AppArmor.
#
# WHY THIS EXISTS
#   `go run .` builds the server into a CONTENT-HASHED Go build-cache path
#   (~/.cache/go-build/<hash>/conduit-server) that changes on every source
#   change. The sandbox profile (scripts/install-sandbox-profile.sh) is
#   path-attached, and AppArmor keys the label to a STABLE executable path,
#   a profile can never match a cache path that moves.
#
#   So dev mode uses a fixed output path instead:
#
#       go build -o dist/cadence-dev .
#       ./dist/cadence-dev --serve app/
#
#   Rebuilds overwrite the SAME path, so the profile (attached to
#   dist/cadence-dev) keeps applying across rebuilds with no re-install.
#   The sandbox keeper is a re-exec of this same binary at the same path
#   (sandbox_unix.go: os.Executable()), so it is covered too. The main
#   server itself also needs the profile: its native probe forks a child
#   that unshares CLONE_NEWUSER (sandbox_unix.go: nativeProbe).
#
# APPARMOR STEP (only when the platform uses AppArmor)
#   If /sys/kernel/security/apparmor is present, this script installs the
#   profile via scripts/install-sandbox-profile.sh (reusing sudo when not
#   root). The profile is only (re)installed when it is not already loaded
#   (checked via aa-status), so the normal dev loop needs no sudo at all.
#   On non-AppArmor systems (or when AA is inactive) the step is skipped -
#   the sandbox then depends on the host sysctl as before.
#
# USAGE
#   ./scripts/dev.sh                    # build, install profile if needed,
#                                       # serve app/ in the foreground
#   ./scripts/dev.sh --headless         # extra args are passed through
#   NO_PROFILE=1 ./scripts/dev.sh       # skip the profile step entirely
#   CADENCE_DEV_BIN=other ./scripts/dev.sh   # build to a different path
#
# The server runs in the FOREGROUND (exec, so Ctrl+C / signals reach it).
# Background it yourself if you want:  ./scripts/dev.sh --headless &
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Locate the repo root (this script lives in <root>/scripts/) --------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/scripts/install-sandbox-profile.sh"
BIN="${CADENCE_DEV_BIN:-$ROOT/dist/cadence-dev}"

echo "=== dev.sh: building $BIN ==="
cd "$ROOT"
go build -o "$BIN" .
echo "Built: $BIN"

# --- Dependency preflight --------------------------------------------------------
# The webview renderer links libwebkit2gtk-4.1 (cgo), so the binary fails at
# STARTUP with a cryptic loader error on hosts that lack the runtime lib.
# Detect that here and suggest the exact package.
if command -v ldd >/dev/null 2>&1; then
    MISSING="$(ldd "$BIN" 2>/dev/null | awk '/not found/ {print $1}')"
    if [[ -n "$MISSING" ]]; then
        echo "ERROR: $BIN is missing shared libraries:" >&2
        echo "$MISSING" | sed 's/^/         /' >&2
        echo
        echo "The webview renderer links webkit2gtk. On Ubuntu/Debian install:" >&2
        echo "         sudo apt install libwebkit2gtk-4.1-0" >&2
        echo "(then re-run; the binary itself does not need rebuilding)" >&2
        exit 1
    fi
fi

# --- AppArmor profile (only when this platform uses AppArmor) ------------------
# The profile is path-attached to $BIN, so it only needs installing ONCE per
# host; the check below skips the sudo dance when it is already loaded.
if [[ "${NO_PROFILE:-0}" -eq 1 ]]; then
    echo "Profile step skipped (NO_PROFILE=1)."
elif [[ ! -d /sys/kernel/security/apparmor ]]; then
    echo "AppArmor is not active on this system; skipping profile step."
else
    PROFILE_NAME="$(basename "$BIN")"
    PROFILE_DIR="${APPARMOR_DIR:-/etc/apparmor.d}"
    PROFILE_FILE="$PROFILE_DIR/$PROFILE_NAME"

    # Phase 1 (rootless): is the on-disk profile up to date? The installer's
    # --check mode compares what it WOULD generate against the file on disk.
    # This catches a MISSING file and a STALE file (old binary path, or an old
    # restrictive profile written by an earlier version of the script) without
    # needing any privilege.
    NEED_INSTALL=0
    if [[ $EUID -eq 0 || -r "$PROFILE_FILE" ]]; then
        if "$INSTALLER" --check "$BIN" >/dev/null 2>&1; then
            : # file present and matches what would be generated
        else
            NEED_INSTALL=1
        fi
    else
        # Can't even read the file (non-root, unreadable) -> treat as missing.
        NEED_INSTALL=1
    fi

    # Phase 2 (only if the file is fine): confirm the profile is ACTUALLY
    # loaded. apparmor_parser -r cannot replace a profile that is already
    # loaded, so a stale/restrictive profile may remain loaded even when the
    # on-disk file is correct (e.g. an earlier bad install was never removed).
    # aa-status reads the kernel's loaded set; this needs privilege, so as a
    # non-root user we only pay the sudo cost when we genuinely must.
    if [[ $NEED_INSTALL -eq 0 ]]; then
        if command -v aa-status >/dev/null 2>&1; then
            # Root can read the profile set directly; non-root needs sudo.
            if [[ $EUID -eq 0 ]]; then
                if aa-status 2>/dev/null | grep -q "$PROFILE_NAME"; then
                    LOADED=1
                fi
            elif command -v sudo >/dev/null 2>&1; then
                if sudo -n aa-status 2>/dev/null | grep -q "$PROFILE_NAME"; then
                    LOADED=1
                else
                    # -n (non-interactive) failed -> may need a password prompt.
                    echo "Profile '$PROFILE_NAME' file is up to date; confirming it is loaded (may prompt for sudo):"
                    if sudo aa-status 2>/dev/null | grep -q "$PROFILE_NAME"; then
                        LOADED=1
                    else
                        NEED_INSTALL=1
                    fi
                fi
            fi
            if [[ ${LOADED:-0} -eq 1 ]]; then
                echo "Profile '$PROFILE_NAME' is loaded and up to date; skipping install."
            fi
        fi
    fi

    if [[ ${NEED_INSTALL:-0} -eq 1 ]]; then
        # Self-healing install: the installer REMOVES any stale/restrictive
        # profile already loaded under this name, then loads the fresh one
        # (-R then -r -T), so a bad profile never persists.
        # NOTE: the installer only gets the binary path. Extra dev args like
        # --headless are NOT forwarded to it (they would be misparsed).
        if [[ $EUID -eq 0 ]]; then
            "$INSTALLER" "$BIN"
        else
            if command -v sudo >/dev/null 2>&1; then
                echo "Installing/updating profile '$PROFILE_NAME' (will prompt for sudo):"
                sudo "$INSTALLER" "$BIN"
            else
                echo "WARNING: profile '$PROFILE_NAME' needs updating but sudo is" >&2
                echo "         not available; the sandbox may be unavailable if" >&2
                echo "         the host restricts unprivileged userns (24.04+)." >&2
                echo "         Install manually:  sudo $INSTALLER $BIN" >&2
            fi
        fi
    fi
fi

# --- Run the dev server (foreground; profile is already loaded, so the new
# --- exec picks up the label) ----------------------------------------------------
echo
echo "=== dev.sh: starting dev server (Ctrl+C to stop) ==="
echo "    binary: $BIN"
echo "    args:   --serve app/ ${*:-}"
# shellcheck disable=SC2086
exec "$BIN" --serve app/ $*
