#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install-apparmor-profile.sh -- install the Cadence AppArmor profiles so the
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
# LAYOUT (one consolidated file, /etc/apparmor.d/cadence, four profiles)
#   The profile content is the VERBATIM source file scripts/cadence_aa_profile.txt
#   (constants only, no shell variables). This script just COPIES it into place,
#   creates the four site-local include files, loads it, and removes stale
#   profiles from older versions. Nothing is generated. The four profiles:
#   1. cadence -- PATH-GLOB attached (host spawner), the most permissive
#      profile in the set:
#         profile cadence /**/cadence{-dev,-latest,-linux-x64,-linux-arm64}
#      The brace-glob header matches every standard cadence binary location
#      (dist/cadence-dev, dist/cadence-linux-x64, dist/cadence-linux-arm64,
#      ~/cadence-latest, ...), so there is NO per-path re-install when you
#      build or move the binary. flags=(attach_disconnected, mediate_deleted)
#      = a genuine confining profile. Body grants essentially everything a
#      normal user has (userns, capability, network, mount/umount/pivot_root,
#      ptrace, dbus, io_uring, allow file rwlkmix /{**,}), because the
#      user's own PTY children (bash, git, ssh) inherit this label and must
#      keep working unrestricted -- the agent surface is no longer exposed
#      through the server label. change_profile rules let the server and the
#      keeper transition into the three sandbox profiles. The label is bound
#      purely by the glob path-attach at execve time (no launch-time
#      transition in the code -- a running server started before the install
#      keeps its old label, so restart the server after (re)installing).
#   2. cadence_sbx_keeper -- the sandbox keeper (a re-exec of the cadence
#      binary). Named profile (attach_disconnected); the child TRANSITIONS
#      into it at exec via /proc/self/attr/exec ("exec cadence_sbx_keeper"),
#      so confinement works even though the keeper is the SAME binary path
#      as the parent. Hardened: deny capability, no network, unix sockets
#      only, ptrace only toward the two shell profiles, full file access
#      inside its own mount namespace, and change_profile rules to land its
#      join-children in the two shell profiles.
#   3. cadence_sbx_shell -- the sandbox shell + its descendants (the
#      OFFLINE default). Named profile; the keeper's join-children transition
#      into it at exec, and the inherit-exec grant (allow file rwlkmix
#      /{**,}) keeps the shell's children in the same profile. Hardened:
#      deny network (air-gapped; tools must use managed fetch paths), deny
#      capability / dbus / io_uring / mount / umount / pivot_root / ptrace,
#      and deny rules for host credentials and shell config
#      (~/.ssh, ~/.gnupg, ~/.aws, gcloud, .bashrc/.profile/.zshrc, systemd
#      user units, XDG runtime dirs, docker.sock).
#   4. cadence_sbx_net -- the sandbox shell + its descendants with GOVERNED
#      outbound network (network inet/inet6 + netlink raw). Same hardening
#      as the offline shell (minus the network deny). INSTALLED FOR FUTURE
#      USE: the Go code currently always transitions join-children into the
#      offline profile; the net profile is pre-loaded so a future net-capable
#      spawn path can target it without a re-install.
#
#   NONE of the four profiles run unconfined: all are real confining
#   profiles (attach_disconnected) that lock down the highest-risk sandbox
#   escape vectors (capabilities, io_uring, dbus, host sockets, host
#   credentials). The mount namespace remains the PRIMARY isolation; the
#   AppArmor layer is the second, now-active one.
#
#   This makes NO system-level changes: the kernel sysctl stays at its
#   secure default (1). Only the cadence profiles are exempt.
#
# USAGE (run on the host, as root)
#   sudo ./install-apparmor-profile.sh            # install + load (no args needed)
#   sudo ./install-apparmor-profile.sh /path/to/cadence   # extra args ignored
#
#   The profile is a verbatim copy of scripts/cadence_aa_profile.txt, so the
#   binary path is NOT needed (the glob header covers the standard locations,
#   and the profile body is self-contained with constant paths). Any extra
#   positional arguments (e.g. a binary path from an older caller) are
#   accepted and ignored for backward compatibility.
#
# UNINSTALL
#   sudo aa-remove-allowed cadence cadence_sbx_keeper cadence_sbx_shell cadence_sbx_net
#
# VERIFICATION (on the host)
#   aa-status | grep cadence            # all four profiles loaded (enforce mode)
#   # then RESTART the Cadence server (the AppArmor label is bound at exec
#   # time, so a running server keeps its old label) and run a sandboxed
#   # command or "open sandbox terminal" -- the "sandbox unavailable ...
#   # ran UNSANDBOXED" warning should be gone. The server label should show
#   # 'cadence (enforce)' (a real confining profile, NOT unconfined).
#
# TIGHTENING / TROUBLESHOOTING LATER (optional)
#   All four profiles are already real confining profiles. If a legitimate
#   server operation starts being denied (e.g. a library load or a browser
#   helper that the profile body has not yet listed), audit the denials and
#   extend the profile:  sudo aa-logprof cadence  (then reload). The site-
#   If a legitimate operation starts being denied, audit the denials
#   (sudo aa-logprof cadence) and add the grant to the SOURCE file
#   (scripts/cadence_aa_profile.txt) so it survives the next install; the
#   installed file is a verbatim copy, so hand-edits there will be flagged
#   stale by --check.
#
# NOTE: if the sandbox STILL reports unavailable after this, the host may be
# using a different restriction (e.g. kernel.unprivileged_userns_clone=0)
# that no AppArmor profile can bypass; the sysctl is the only option there.
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Parse args ----------------------------------------------------------------
# Modes:
#   (default)        install: copy the source profile + self-heal the loaded copy
#                    (needs root)
#   --check          rootless: exit 0 if the on-disk profile already matches the
#                    source file exactly (no install needed), exit 1 if it is
#                    missing or stale. Safe to run as a normal user; reads the
#                    on-disk profile (world-readable) and writes nothing.
# The profile content is the VERBATIM source file (see below); there is nothing
# to parameterize, so the installer takes no binary argument. Any extra
# positional args (e.g. a binary path from an older caller) are accepted and
# ignored for backward compatibility.
CHECK_MODE=0
if [[ "${1:-}" == "--check" ]]; then
    CHECK_MODE=1
fi

# One consolidated profile file, FOUR profiles (see header):
#   cadence (path-GLOB attached, REAL confined profile)
#   cadence_sbx_keeper / cadence_sbx_shell / cadence_sbx_net
#   (named, attach_disconnected, all confined -- none run unconfined)
# The profile content is the VERBATIM source file checked into the repo
# (constants only, no shell variables), so the install is a byte-for-byte
# copy: nothing is generated, and the source file IS the staleness fingerprint
# (a file installed by an older version of this script will not byte-match).
# The file name is 'cadence' (the glob header matches the standard binary
# variants, so there is no per-path re-install).
NAME="cadence"
PROFILE_DIR="${APPARMOR_DIR:-/etc/apparmor.d}"
PROFILE="$PROFILE_DIR/cadence"
# The VERBATIM profile source file (this script lives in <root>/scripts/).
SRC_PROFILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cadence_aa_profile.txt"
SBX_KEEPER_PROFILE="cadence_sbx_keeper"
SBX_SHELL_PROFILE="cadence_sbx_shell"
SBX_NET_PROFILE="cadence_sbx_net"
# The four profile names in the source file.
PROFILE_NAMES=("$NAME" "$SBX_KEEPER_PROFILE" "$SBX_SHELL_PROFILE" "$SBX_NET_PROFILE")
# Stale profiles left behind by older versions of this script (per-path
# path-attached profiles, the old per-path main-profile name, and the old
# net-profile name).
STALE_PROFILES=(
    "cadence-dev"
    "cadence-latest"
    "cadence-server"
    "cadence_sbx_shell_net"
)
STALE_FILES=(
    "$PROFILE_DIR/cadence_sbx_children"
)
# APPARMOR_DIR overrides the profile dir (used for dry-runs / tests): when set,
# the root and AppArmor-active checks are skipped and nothing is loaded.
TEST_MODE=0
if [[ -n "${APPARMOR_DIR:-}" ]]; then
    TEST_MODE=1
    echo "(test mode: writing to $PROFILE_DIR, not loading)"
fi

# --- Sanity checks --------------------------------------------------------------------
# The source file must exist (both modes depend on it; --check needs it to
# compare, install needs it to copy).
if [[ ! -f "$SRC_PROFILE" ]]; then
    echo "ERROR: profile source file not found: $SRC_PROFILE" >&2
    echo "       (expected in scripts/ -- run this script from the repo, or fix the path)." >&2
    exit 1
fi
# Install mode only: needs root + an active AppArmor (unless in test mode).
if [[ $CHECK_MODE -eq 0 ]]; then
    if [[ $EUID -ne 0 && $TEST_MODE -eq 0 ]]; then
        echo "ERROR: must run as root.  (try:  sudo $0)" >&2
        exit 1
    fi
    if [[ $TEST_MODE -eq 0 && ! -d /sys/kernel/security/apparmor ]]; then
        echo "ERROR: AppArmor is not active on this system (no /sys/kernel/security/apparmor)." >&2
        echo "       Nothing to do here -- the sandbox works without a profile anyway." >&2
        exit 1
    fi
	mkdir -p "$PROFILE_DIR"
fi

# --- Profile file ---------------------------------------------------------------
# The profile content is the VERBATIM source file (scripts/cadence_aa_profile.txt):
# four self-contained profiles (cadence, cadence_sbx_keeper, cadence_sbx_shell,
# cadence_sbx_net), all flags=(attach_disconnected, mediate_deleted) -- NONE
# run unconfined. The file is installed byte-for-byte (constants only; nothing
# is generated), so it doubles as its own staleness fingerprint: a file
# installed by an older version of this script (or a hand-edited one) will not
# byte-match the source and is treated as stale. The on-disk file is NOT read
# here, so a stale profile never pollutes the content we install or compare.
#
# Design: the MAIN profile (cadence, glob-attached to the server binary) is
# deliberately near-allow-all (full user permissions + userns + change_profile
# to the sandbox profiles), because the user's own PTY children (bash, git,
# ssh) inherit its label and must keep working unrestricted -- the agent
# surface is no longer exposed through the server label. The three sandbox
# profiles are the hardened ones: the keeper (deny capability, no network,
# ptrace only toward the shells, change_profile to the shells) and the two
# shells (deny capability/dbus/io_uring/mount/umount/pivot_root/ptrace; the
# offline shell additionally denies network; both deny host credentials and
# shell config). The mount namespace remains the PRIMARY isolation; the
# AppArmor layer is the second, now-active one.
#
# INSTALLED FOR FUTURE USE: the Go code currently always transitions
# join-children into the OFFLINE shell profile; cadence_sbx_net is pre-loaded
# so a future net-capable spawn path can target it without a re-install.
#
# If the file is missing, the sandbox still works -- the transition writes
# just fail and the children run unconfined (graceful degradation).
install_profile() {
    # Copy the source file VERBATIM to the install location. No generation, no
    # normalization: the on-disk file is a byte-for-byte copy of the source.
    cp -f "$SRC_PROFILE" "$1"
}

# --- --check mode: is the on-disk file a byte-for-byte copy of the source? ----------
# Rootless and non-destructive: the source file is the staleness fingerprint, so
# a simple diff suffices (no normalization needed -- the install is verbatim).
if [[ $CHECK_MODE -eq 1 ]]; then
    if [[ -f "$PROFILE" ]] && diff -q "$SRC_PROFILE" "$PROFILE" >/dev/null 2>&1; then
        echo "Profile file is up to date in $PROFILE (matches $SRC_PROFILE; no install needed)."
    elif [[ -f "$PROFILE" ]]; then
        echo "Profile file in $PROFILE is STALE (differs from $SRC_PROFILE); update needed."
        exit 1
    else
        echo "Profile file not found in $PROFILE; install needed."
        exit 1
    fi
    exit 0
fi

# --- Install the consolidated profile file (verbatim copy of the source) ------------
install_profile "$PROFILE"
echo "Installed profile file (verbatim copy): $PROFILE ($NAME, $SBX_KEEPER_PROFILE, $SBX_SHELL_PROFILE, $SBX_NET_PROFILE)"

# --- Load it (real confining profiles; load into enforce mode) ---------------------
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
    echo "Loaded profile file (self-healing: removed stale copy, then loaded fresh)."
    # --- Remove stale profiles from OLDER versions of this script ----------------
    # Older installs wrote per-path path-attached profiles (cadence-dev,
    # cadence-latest), a per-path main profile named after the binary, the old
    # main profile (cadence-server), the old net-profile name (cadence_sbx_shell_net),
    # and a separate cadence_sbx_children file. The consolidated $PROFILE supersedes
    # all of them. Removal is best-effort (no-op if not loaded); the on-disk files
    # are removed so they cannot be reloaded by a later 'apparmor_parser -r'.
    for stale in "${STALE_PROFILES[@]}"; do
        if grep -q "^$stale " /sys/kernel/security/apparmor/profiles 2>/dev/null; then
            apparmor_parser -R "$PROFILE_DIR/$stale" 2>/dev/null || \
                aa-remove-allowed "$stale" 2>/dev/null || true
            rm -f "$PROFILE_DIR/$stale"
            echo "Removed stale profile '$stale' (superseded by $NAME)."
        fi
    done
    for stale_file in "${STALE_FILES[@]}"; do
        if [[ -f "$stale_file" ]]; then
            rm -f "$stale_file"
            echo "Removed stale profile file: $stale_file (superseded by $PROFILE)."
        fi
    done
    # All four profiles are REAL confining profiles (attach_disconnected), so the
    # load puts them into enforce mode (verify: /sys/kernel/security/apparmor/
    # profiles should show each name as "(enforce)"). No aa-enforce step needed.
fi

# --- Verify ------------------------------------------------------------------------
echo
echo "--- verification ---"
if [[ -d /sys/kernel/security/apparmor ]] && [[ -r /sys/kernel/security/apparmor/profiles ]]; then
    for p in "${PROFILE_NAMES[@]}"; do
        if grep -q "^$p " /sys/kernel/security/apparmor/profiles 2>/dev/null; then
            echo "Profile '$p' is loaded: $(grep "^$p " /sys/kernel/security/apparmor/profiles)"
        else
            echo "WARNING: '$p' is NOT listed in the loaded profiles. Check manually:" >&2
            echo "         grep $p /sys/kernel/security/apparmor/profiles" >&2
        fi
    done
else
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
fi

# --- Report ------------------------------------------------------------------------
echo
echo "DONE. No system-level changes were made (the sysctl stays at its"
echo "secure default of 1). The four cadence profiles are exempt from the"
echo "userns restriction; nothing else on the host is affected."
echo
echo "Uninstall (restores the previous behavior):"
echo "  sudo apparmor_parser -R /etc/apparmor.d/cadence*"
echo "  sudo rm -f /etc/apparmor.d/cadence"
