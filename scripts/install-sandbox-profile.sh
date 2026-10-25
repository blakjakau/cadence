#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install-sandbox-profile.sh -- install an AppArmor profile so the Cadence
# server can spawn its unprivileged user-namespace sandbox on hosts where
# AppArmor restricts unprivileged user namespaces (Ubuntu 24.04+:
# kernel.apparmor_restrict_unprivileged_userns=1 is the default).
#
# WHY THIS EXISTS
#   The Cadence sandbox spawns a single-threaded child that unshares a
#   user+mount namespace and execve()s the "keeper" (a re-exec of this same
#   binary in --sandbox-keeper mode). On 24.04+, an UNCONFINED process
#   cannot create user namespaces at all, while a CONFINED process can --
#   provided its AppArmor profile grants the `userns` rule.
#
#   So the fix is to attach a profile to the cadence binary that grants
#   userns, WITHOUT restricting any other behavior. This mirrors exactly how
#   Ubuntu ships profiles for chrome / chromium / firefox / msedge / code /
#   brave: a path-attached profile with flags=(unconfined) (allow-all, so
#   nothing else about the server's behavior changes) that ADDS the rules:
#
#       profile cadence /path/to/cadence flags=(unconfined) {
#         userns,
#         mount, umount, pivot_root,
#         /path/to/cadence mr,
#         /usr/bin/unshare mr, /bin/unshare mr,
#         /usr/bin/nsenter   mr, /bin/nsenter mr,
#         /usr/bin/bwrap     mr, /bin/bwrap mr,
#       }
#
#   The profile is attached to the binary's ACTUAL install PATH (like the
#   stock browser profiles). The sandbox keeper is a re-exec of that SAME
#   binary at the same path, so it is covered by the same profile. If you
#   move the binary later, just re-run this script with the new path.
#
#   This makes NO system-level changes: the kernel sysctl stays at its
#   secure default (1). Only the cadence binary itself is exempt.
#
# USAGE (run on the host, as root)
#   sudo ./install-sandbox-profile.sh                    # auto-detect the binary
#   sudo ./install-sandbox-profile.sh /path/to/cadence   # explicit path
#   sudo ./install-sandbox-profile.sh /path/to/cadence --name myname
#
#   The binary is auto-detected from: $CADENCE_BIN, ~/.local/bin/cadence,
#   /usr/local/bin/cadence, /usr/bin/cadence, `command -v cadence`, or
#   ./dist/cadence-*/cadence.
#
# UNINSTALL
#   sudo aa-remove-allowed <name>      # name defaults to the binary's basename
#
# VERIFICATION (on the host)
#   aa-status | grep <name>           # profile loaded
#   # then RESTART the Cadence server (the AppArmor label is bound at exec
#   # time, so a running server keeps its old label) and run a sandboxed
#   # command or "open sandbox terminal" -- the "sandbox unavailable ...
#   # ran UNSANDBOXED" warning should be gone.
#
# TIGHTENING LATER (optional)
#   The profile is flags=(unconfined) = allow-all. If you later want a real
#   confining profile, start from /etc/apparmor.d/<name> and use
#   `sudo aa-logprof <name>`.
#
# NOTE: if the sandbox STILL reports unavailable after this, the host may be
# using a different restriction (e.g. kernel.unprivileged_userns_clone=0)
# that no AppArmor profile can bypass; the sysctl is the only option there.
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Parse args ----------------------------------------------------------------
# Modes:
#   (default)        install: write profile + self-heal the loaded copy (needs root)
#   --check [BIN]    rootless: print what WOULD be installed; exit 0 if the on-disk
#                    profile already matches exactly (no install needed), exit 1 if
#                    it is missing or stale. Safe to run as a normal user; reads the
#                    on-disk profile (world-readable) and writes only a temp file.
BIN="${1:-}"
EXPLICIT_NAME=""
CHECK_MODE=0
if [[ "${1:-}" == "--check" ]]; then
    CHECK_MODE=1
    BIN="${2:-}"
elif [[ "${1:-}" == "--name" ]]; then
    EXPLICIT_NAME="${2:-}"
    BIN="${3:-}"
elif [[ $# -ge 3 && "${2:-}" == "--name" ]]; then
    EXPLICIT_NAME="$3"
fi

# --- Resolve the binary ----------------------------------------------------------
# Map the current arch to the dist/ naming convention (x86_64 -> x64, aarch64 -> arm64).
case "$(uname -m)" in
    x86_64)  DIST_ARCH="x64" ;;
    aarch64) DIST_ARCH="arm64" ;;
    *)       DIST_ARCH="" ;;
esac
if [[ -z "$BIN" ]]; then
    if [[ -n "${CADENCE_BIN:-}" ]]; then
        BIN="$CADENCE_BIN"
    else
        # Candidates in priority order: explicit env, then common install
        # locations, then PATH, then dist/ builds (current-arch first).
        CANDIDATES=(
            "$HOME/.local/bin/cadence"
            "/usr/local/bin/cadence"
            "/usr/bin/cadence"
            "$(command -v cadence 2>/dev/null || true)"
            "./dist/cadence-${DIST_ARCH}"
            "./dist/cadence-${DIST_ARCH}/cadence"
            "./dist/cadence-*"
            "./dist/cadence-*/cadence"
            "./dist/cadence"
        )
        for cand in "${CANDIDATES[@]}"; do
            # shellcheck disable=SC2086
            for c in $cand; do
                if [[ -x "$c" ]]; then BIN="$c"; break; fi
            done
            [[ -n "$BIN" ]] && break
        done
    fi
fi
if [[ -z "$BIN" ]]; then
    echo "ERROR: could not auto-detect the cadence binary." >&2
    echo "       Pass it explicitly:  sudo $0 /path/to/cadence" >&2
    echo "       or set:              export CADENCE_BIN=/path/to/cadence" >&2
    exit 1
fi
BIN="$(readlink -f "$BIN")"
if [[ ! -x "$BIN" ]]; then
    echo "ERROR: $BIN is not an executable file." >&2
    exit 1
fi
BNAME="$(basename "$BIN")"

# Profile name: the binary's basename (or --name override).
NAME="${EXPLICIT_NAME:-$BNAME}"
NAME="$(echo "$NAME" | tr -cd 'A-Za-z0-9._-')"
if [[ -z "$NAME" ]]; then NAME="$BNAME"; fi
PROFILE_DIR="${APPARMOR_DIR:-/etc/apparmor.d}"
PROFILE="$PROFILE_DIR/$NAME"
LOCAL_DIR="$PROFILE_DIR/local"
# APPARMOR_DIR overrides the profile dir (used for dry-runs / tests): when set,
# the root and AppArmor-active checks are skipped and nothing is loaded.
TEST_MODE=0
if [[ -n "${APPARMOR_DIR:-}" ]]; then
    TEST_MODE=1
    echo "(test mode: writing to $PROFILE_DIR, not loading)"
fi

# --- Sanity checks (install mode only; --check works rootless) -----------------------
if [[ $CHECK_MODE -eq 0 ]]; then
    if [[ $EUID -ne 0 && $TEST_MODE -eq 0 ]]; then
        echo "ERROR: must run as root.  (try:  sudo $0 $BIN)" >&2
        exit 1
    fi
    if [[ $TEST_MODE -eq 0 && ! -d /sys/kernel/security/apparmor ]]; then
        echo "ERROR: AppArmor is not active on this system (no /sys/kernel/security/apparmor)." >&2
        echo "       Nothing to do here -- the sandbox works without a profile anyway." >&2
        exit 1
    fi
    mkdir -p "$PROFILE_DIR" "$LOCAL_DIR"
fi

# --- Profile body -------------------------------------------------------------
# Written to the file named in $1. The body embeds $BIN and $NAME, so it doubles
# as a staleness fingerprint: a profile installed for an OLDER binary path, or by
# an OLDER version of this script, will not byte-match and is treated as stale.
# Note: the on-disk profile (if any) is NOT read here, so a stale/restrictive
# profile never pollutes the content we generate or compare.
generate_profile() {
cat > "$1" <<EOF
# AppArmor profile for the Cadence server: grants unprivileged user-namespace
# access so the sandbox (userns unshare + keeper re-exec) works on hosts with
# kernel.apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04+ default).
#
# Generated by scripts/install-sandbox-profile.sh
#   binary: $BIN
#
# PATH-ATTACHED profile (like the stock chrome/code/msedge profiles): it
# auto-applies to the cadence binary at this path. The sandbox keeper is a
# re-exec of the SAME binary at the SAME path, so it is covered too.
#
# flags=(unconfined) = allow-all: nothing else about the app's behavior is
# restricted, so this only ADDS capability (userns + mount + exec grants)
# and cannot break the server's normal browser/file access.
#
# Uninstall:  sudo aa-remove-allowed $NAME
# Tighten (optional):  sudo aa-logprof $NAME

abi <abi/5.0>,

include <tunables/global>

profile $NAME $BIN flags=(unconfined) {
  # The core grant: allow unprivileged user namespaces. On 24.04+ the
  # AppArmor userns restriction exempts confined profiles that grant this,
  # while unconfined processes remain blocked.
  userns,

  # The sandbox unshares a mount namespace and sets up a private mount
  # layout (bind mounts, pivot_root).
  mount,
  umount,
  pivot_root,

  # The keeper is a re-exec of this same binary; allow read/mmap of it
  # (needed for the exec from within the sandboxed namespace).
  $BIN mr,

  # bwrap fallback: the probe falls back to bwrap (which creates its own
  # userns) when native is unavailable; allow exec'ing those tools.
  /usr/bin/unshare mr,
  /bin/unshare    mr,
  /usr/bin/nsenter   mr,
  /bin/nsenter    mr,
  /usr/bin/bwrap     mr,
  /bin/bwrap     mr,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/$NAME>
}
EOF
}

# --- --check mode: report what would be installed (rootless, non-destructive) -------
if [[ $CHECK_MODE -eq 1 ]]; then
    TMP_PROFILE="$(mktemp)"
    generate_profile "$TMP_PROFILE"
    if [[ -f "$PROFILE" ]]; then
        if diff -q "$TMP_PROFILE" "$PROFILE" >/dev/null 2>&1; then
            echo "Profile '$NAME' is up to date (no install needed)."
            rm -f "$TMP_PROFILE"
            exit 0
        else
            echo "Profile '$NAME' is STALE (differs from what would be installed); update needed."
            rm -f "$TMP_PROFILE"
            exit 1
        fi
    else
        echo "Profile '$NAME' not found; install needed."
        rm -f "$TMP_PROFILE"
        exit 1
    fi
fi

# --- Write the profile -------------------------------------------------------------
generate_profile "$PROFILE"
echo "Wrote profile: $PROFILE"

# --- Ensure the site-local include file (referenced by the profile) ---------------
if [[ ! -f "$LOCAL_DIR/$NAME" ]]; then
    touch "$LOCAL_DIR/$NAME"
    echo "Wrote site-local include: $LOCAL_DIR/$NAME (empty; add overrides here)"
fi

# --- Load it (enforce mode; allow-all so nothing is actually blocked) --------------
if [[ $TEST_MODE -eq 0 ]]; then
    if ! command -v apparmor_parser >/dev/null 2>&1; then
        echo "ERROR: apparmor_parser not found (install the 'apparmor' package)." >&2
        exit 1
    fi
    # Self-healing load: always REMOVE then REPLACE so a stale/restrictive profile
    # already loaded under the same name is reliably swapped out. (apparmor_parser
    # -r alone only ADDS; it cannot replace a profile that is already loaded.)
    #   -R <file>  removes the profile(s) defined in <file> (no-op if not loaded)
    #   -r -T <file> loads it fresh, skipping any stale compiled cache entry (-T)
    apparmor_parser -R "$PROFILE" 2>/dev/null || true
    apparmor_parser -r -T "$PROFILE"
    echo "Loaded profile (self-healing: removed stale copy, then loaded fresh)."
    if command -v aa-enforce >/dev/null 2>&1; then
        aa-enforce "$NAME" 2>/dev/null || true
    fi
fi

# --- Verify ------------------------------------------------------------------------
echo
echo "--- verification ---"
if command -v aa-status >/dev/null 2>&1; then
    if aa-status 2>/dev/null | grep -q "$NAME"; then
        echo "Profile '$NAME' is loaded."
    else
        echo "WARNING: '$NAME' not yet listed in aa-status. Check manually:" >&2
        echo "         aa-status | grep $NAME" >&2
    fi
else
    echo "(aa-status not available -- verify manually with 'aa-status | grep $NAME')"
fi

# --- Report ------------------------------------------------------------------------
echo
echo "DONE. No system-level changes were made (the sysctl stays at its"
echo "secure default of 1). Only the $NAME binary is exempt from the"
echo "userns restriction."
echo
echo "Next steps:"
echo "  1. Restart the Cadence server (the AppArmor label is bound at exec"
echo "     time, so a running server keeps its old label)."
echo "  2. Run a sandboxed command or 'open sandbox terminal' -- the"
echo "     'sandbox unavailable ... ran UNSANDBOXED' warning should be gone."
echo
echo "Uninstall (restores the previous behavior):"
echo "  sudo aa-remove-allowed $NAME"
echo
echo "If the sandbox STILL reports unavailable, the host may use a different"
echo "restriction (e.g. kernel.unprivileged_userns_clone=0) that no profile"
echo "can bypass; in that case the sysctl is the only option."
