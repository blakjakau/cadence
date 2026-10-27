#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# dev.sh - build + run the Cadence dev server with a STABLE binary path,
# and install the dev AppArmor profile when the platform uses AppArmor.
#
# WHY THIS EXISTS
#   `go run .` builds the server into a CONTENT-HASHED Go build-cache path
#   (~/.cache/go-build/<hash>/conduit-server) that changes on every source
#   change. The profile (scripts/install-apparmor-profile.sh) is GLOB-attached
#   to every standard cadence binary path (the /**/cadence{-dev,-latest,
#   -linux-x64,-linux-arm64} brace-glob), so AppArmor keys the label to a
#   STABLE set of executable paths, and a profile can never match a cache
#   path that moves.
#
#   So dev mode uses a fixed output path instead (the glob attaches the
#   profile to dist/cadence-dev at execve; a launch-time transition is NOT
#   needed -- the label is bound purely by the path):
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
#   profile via scripts/install-apparmor-profile.sh (reusing sudo when not
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
INSTALLER="$ROOT/scripts/install-apparmor-profile.sh"
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
# The profile is GLOB-attached (one consolidated file, four profiles:
# cadence, cadence_sbx_keeper, cadence_sbx_shell, cadence_sbx_net), so it
# only needs installing ONCE per host; the checks below skip the sudo dance
# when the file is up to date AND the profiles are already loaded.
if [[ "${NO_PROFILE:-0}" -eq 1 ]]; then
    echo "Profile step skipped (NO_PROFILE=1)."
elif [[ ! -d /sys/kernel/security/apparmor ]]; then
    echo "AppArmor is not active on this system; skipping profile step."
else
    PROFILE_FILE="${APPARMOR_DIR:-/etc/apparmor.d}/cadence"
    # The main profile name (the glob-attached one); the sandbox profiles
    # (cadence_sbx_keeper, cadence_sbx_shell, cadence_sbx_net) are loaded
    # from the same file.
    PROFILE_NAME="cadence"

    # Phase 1 (rootless): is the on-disk profile up to date? The installer's
    # --check mode diffs the on-disk file against the verbatim source file
    # (scripts/cadence_aa_profile.txt) -- no generation, just a byte compare.
    # This catches a MISSING file and a STALE file (an old per-path profile
    # written by an earlier version of the script, or an old restrictive
    # profile) without needing any privilege.
    NEED_INSTALL=0
    if [[ $EUID -eq 0 || -r "$PROFILE_FILE" ]]; then
        if "$INSTALLER" --check >/dev/null 2>&1; then
            : # file present and matches the source file
        else
            NEED_INSTALL=1
        fi
    else
        # Can't even read the file (non-root, unreadable) -> treat as missing.
        NEED_INSTALL=1
    fi

    # Phase 2 (only if the file is fine): confirm ALL FOUR profiles are
    # ACTUALLY loaded. apparmor_parser -r cannot replace a profile that is
    # already loaded, so a stale/restrictive profile may remain loaded even
    # when the on-disk file is correct (e.g. an earlier bad install was never
    # removed). Reading the kernel's loaded set needs privilege (the profiles
    # file is root-only and aa-status refuses unprivileged), so a non-root
    # user only pays the sudo cost when we genuinely must.
    if [[ $NEED_INSTALL -eq 0 ]]; then
        PROFILE_NAMES=("$PROFILE_NAME" "cadence_sbx_keeper" "cadence_sbx_shell" "cadence_sbx_net")
        # Fast path: if a running cadence server process is already under the
        # cadence profile, the install clearly succeeded and the glob attach
        # worked -- no privilege needed to trust the load.
        # /proc/<pid>/attr/current is world-readable, so we can
        # check a running server's label without sudo. ANCHORED match: a bare
        # substring grep would also match the cadence_sbx_* sandbox profiles,
        # which are not the main profile.
        CUR="$(cat /proc/self/attr/current 2>/dev/null || true)"
        if [[ "$CUR" =~ ^cadence\ \(enforce\)$ ]]; then
            : # this dev.sh process itself is running under the profile
        else
            # Check for a running cadence server (a sibling from another pane,
            # or a prior run) and read its label.
            CUR=""
            for srv in $(pgrep -f 'cadence .*--serve' 2>/dev/null || true); do
                CUR="$(cat "/proc/$srv/attr/current" 2>/dev/null || true)"
                if [[ "$CUR" =~ ^cadence\ \(enforce\)$ ]]; then
                    break
                fi
            done
        fi
        if [[ "$CUR" =~ ^cadence\ \(enforce\)$ ]]; then
            echo "Already running under profile $CUR; profiles are loaded. Skipping install."
            NEED_INSTALL=0
        else
            # Confirm all four profiles are loaded. Reading the loaded set needs
            # privilege, so as a non-root user we only pay the sudo cost when
            # we genuinely must.
            # aa-status lists each profile as "name (mode)" (possibly indented),
            # so grep for "<name> (" (name, space, open-paren) to match it
            # regardless of indentation. The trailing space-paren anchors the
            # name so 'cadence' does NOT false-match the 'cadence_sbx_*' lines.
            if [[ $EUID -eq 0 ]]; then
                for p in "${PROFILE_NAMES[@]}"; do
                    if aa-status 2>/dev/null | grep -qE "^[[:space:]]*${p} \("; then
                        LOADED=1
                    else
                        echo "Profile '$p' is NOT loaded (will install/refresh)."
                    fi
                done
            elif command -v sudo >/dev/null 2>&1; then
                # -n (non-interactive) only -- a failed check falls through to
                # the install step (which uses an interactive sudo), so the
                # normal dev loop needs no password at all.
                if sudo -n true 2>/dev/null; then
                    for p in "${PROFILE_NAMES[@]}"; do
                        if sudo -n aa-status 2>/dev/null | grep -qE "^[[:space:]]*${p} \("; then
                            LOADED=1
                        else
                            echo "Profile '$p' is NOT loaded (will install/refresh)."
                        fi
                    done
                else
                    # Can't confirm the load without a password; assume loaded
                    # (the install step below will re-run with an interactive
                    # sudo if the file genuinely needs updating).
                    echo "Could not confirm the profiles are loaded without sudo; assuming loaded."
                    LOADED=1
                fi
            fi
            if [[ ${LOADED:-0} -eq 1 ]]; then
                echo "Profile '$PROFILE_NAME' is loaded and up to date; skipping install."
            fi
        fi
    fi

    if [[ ${NEED_INSTALL:-0} -eq 1 ]]; then
        # Self-healing install: the installer COPIES the verbatim source file
        # (scripts/cadence_aa_profile.txt) into place, REMOVES any stale
        # profiles already loaded under the old names, then loads the fresh
        # file (-R then -r -T), so a bad profile never persists. No binary
        # path is needed (the glob header covers all standard locations).
        # NOTE: no dev args are forwarded to it (they would be misparsed).
        if [[ $EUID -eq 0 ]]; then
            "$INSTALLER"
        else
            if command -v sudo >/dev/null 2>&1; then
                echo "Installing/updating profile '$PROFILE_NAME' (will prompt for sudo):"
                sudo "$INSTALLER"
            else
                echo "WARNING: profile '$PROFILE_NAME' needs updating but sudo is" >&2
                echo "         not available; the sandbox may be unavailable if" >&2
                echo "         the host restricts unprivileged userns (24.04+)." >&2
                echo "         Install manually:  sudo $INSTALLER" >&2
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
