# Sandboxed Execution

Cadence can run agent `run_command` shells — and optionally user terminal tabs —
inside a **shared Linux user-namespace sandbox**. The sandbox is *path-scoped*:
the shell sees only the project roots (writable) plus a read-only system
passthrough set; the rest of the host filesystem is hidden. Sandboxes are
**persistent, addressable, shared workspaces** — not per-command security
bubbles — so an agent session's sandbox persists for the session's lifetime and
a user terminal can *attach* to it and see exactly the same workspace.

- **Linux-only** (user namespaces). macOS/Windows report
  `sandbox: "unsupported"` and run unsandboxed.
- **Never silently pretends**: if the sandbox is unavailable (AppArmor
  restriction, no bwrap, …) the shell still starts *unsandboxed* and the client
  is told why (`sandbox: "unavailable"` + `sandboxReason`).
- **Zero new dependencies**: the native path uses only the stdlib plus
  `golang.org/x/sys` (already in `go.mod`).

---

## Files

| File | Role |
|---|---|
| `sandbox_common.go` | Cross-platform types: `SandboxConfig`, `SandboxFlags`, `SandboxHandle`, `SandboxInstanceInfo`, `SandboxStatusResponse`, `ErrSandboxUnavailable`. |
| `sandbox_unix.go` | The native implementation (build tag `linux`): capability probe, reexec keeper, mount layout, keeper IPC, refcounted registry, bwrap fallback. |
| `sandbox_platform_linux.go` | `sandboxSupported() == true` on Linux. |
| `sandbox_other.go` | Non-Linux stubs: everything is a no-op / "Linux-only". |
| `sandbox_unix_test.go` | Linux tests: probe, end-to-end (bind-mount rw, host-fs hidden, `/oldroot` backdoor closed, pty EOF), shared-instance semantics, bwrap argv, env scrub, fingerprint. |
| `pty_unix.go` | `startPty` — routes to `startSandboxedShell` when a `*SandboxConfig` is passed. |
| `handlers.go` | `terminalServer` — parses the sandbox query params, validates roots, wires the handle into the WS, sends `terminalInfo` sandbox fields, releases owners on close. |
| `main_common.go` | `GET /api/sandbox` (`sandboxStatusHandler`). |
| `scratch/sandbox_poc/` | Throwaway Phase-0 spike that validated the technique unprivileged on Ubuntu 24.04 (see its `README.md`). |

Frontend: `app/js/agent/agent-tools.mjs` (agent `run_command`),
`app/js/terminal-manager.mjs` (user terminal modes + attach),
`app/js/ai-manager-history.mjs` (sandbox badge), `app/js/conduit-client.mjs`
(`wsGetSandboxStatus`), `app/js/ai-manager-sessions.mjs` (release handshake),
plus the settings toggles in `ai-manager-settings.mjs`,
`agent-config-panel.mjs`, `session-artifacts-panel.mjs`.

---

## Core design: the reexec keeper model

A sandbox **instance** is a long-lived **keeper coprocess** that has
unshared into a fresh `user+mount+uts+ipc` namespace, applied the bind-mount
layout once, and then idles. Owners (agent sessions, user terminal tabs)
**join** the instance by asking the keeper to fork a shell child into its
namespace, attached to a pty the caller opened. Instances are **refcounted by
owner**; the last owner to leave reaps the keeper.

Instances are keyed by a **layout fingerprint** (`fingerprint()`, `sandbox_unix.go`):
a `sbx-xxxx` id (first 4 bytes of a SHA-256 over sorted rw roots + sorted ro
roots + the four namespace flags). Two owners with the same layout share one
instance; a layout change yields a different instance.

```
        server process (sandboxManager registry, keyed by fingerprint)
        │
        │ spawnKeeper: rawFork() → child unshares ns, applies layout,
        │ reexecs this binary as `--sandbox-keeper <id> <socket>`
        ▼
   keeper coprocess (inside the ns, idling)
        │  unix socket: {slave, cwd, env} → fork join-child → reply pid
        ├── join-child 1: agent session's shell (pty A)   owner "session:<id>"
        └── join-child 2: user terminal's shell (pty B)   owner "terminal:<tab>"
```

### Why this shape (all empirically validated in `scratch/sandbox_poc/`)

1. **The unshare must happen in a single-threaded child.** An unprivileged
   process that wants a new user+mount namespace must `unshare(CLONE_NEWUSER)`
   first. On a multi-threaded Go process that fails with `EINVAL`, so the
   unshare runs in a `clone(SIGCHLD)` child that is single-threaded.
2. **The clone child may only use `syscall.RawSyscall`/`RawSyscall6`.**
   In a forked Go child, `x/sys/unix` wrappers, heap allocation, and any
   runtime touch are unsafe. Everything the child needs (string pointers,
   argv/envv arrays, the ns mask, step-marker bytes) is **precomputed in the
   parent** and read from globals (COW-shared across the clone). See the
   `raw*` globals at the top of `sandbox_unix.go`.
3. **A mount-namespace layout cannot be mutated from outside**, and there is no
   unprivileged "enter namespace" syscall. (External `setns` into a user-ns-
   owned mount namespace is *not* permitted — the POC confirmed the join
   mechanism is **keeper-fork**, not external setns.) So the namespace is
   created once and kept alive by the keeper; joiners are forked into it.
4. **The keeper is a reexec of the same binary** (`--sandbox-keeper <id>
   <socket>`), so no new binary or dependency is required. The layout is
   passed via the `SBX_CONFIG` env var (JSON), because env survives reexec but
   Go globals do not.
5. **The pty is opened outside the ns** (the bwrap trick): the caller opens
   the pty pair, and the join-child `dup2`s the slave (re-opened by name,
   since creack/pty marks the slave CLOEXEC) to 0/1/2, `setsid` + `TIOCSCTTY`,
   then execs the shell. This sidesteps the read-only `/dev/pts` problem.

### The raw-syscall discipline

The clone child (keeper setup) and the join-child (shell) follow a strict
rule: **no allocation, no `x/sys/unix`, no runtime.** Consequences:

- Strings passed to raw syscalls must be **NUL-terminated** (raw `mount`/
  `chdir`/`execve` read until NUL). `strPtr()`/`strPtrPtr()` return stable
  pointers to cached NUL-terminated copies — the cache is **pre-warmed in the
  parent** (e.g. `strPtr("/proc/self/mountinfo")`, `strPtr("/oldroot")` in
  `spawnKeeper`) so the child gets cache hits, not allocations.
- `argv`/`envv` for a raw `execve` are built by `buildExecveStructures()`
  (parent-side); the child only takes their addresses.
- Diagnostic markers: `mk(step)` writes a single precomputed step-byte to the
  child's stderr trace fd; `traceInt(v)` formats a small int into a stack
  buffer (no allocation). A failing keeper therefore leaves a trace in
  `<socketdir>/keeper.err` identifying the last step it reached.

---

## The mount layout (native path)

After `unshare` and the uid/gid mapping (`uid_map`/`gid_map` = `0 → self`,
`setgroups` = `deny`), the child makes `/` private
(`mount("", "/", MS_REC|MS_PRIVATE)`) and then **hides the host filesystem**
with a `pivot_root` sequence (all raw syscalls, all paths precomputed):

1. `mkdir` the new-root tree inside a private temp dir
   (`/tmp/cadence-sbx-*/newroot`): `newroot/oldroot`, `newroot/dev`,
   `newroot/proc`, `newroot/tmp`, the binary's **parent** dir (mkdir'd
   *empty*), and every ro/rw root
   target. (The new root is *empty* after the pivot, so every bind
   **destination** must pre-exist inside it — hence the host-side
   `newroot<P>` mkdirs, computed by `expandMkdirAll`.)
2. Bind host `/` → `newroot/oldroot` (so the host fs can be re-bound).
3. Bind `newroot` → `newroot` (pivot requires a mountpoint).
4. `pivot_root(newroot, newroot/oldroot)`; `chdir /`.
5. Bind back onto the new root:
   - **rw roots** at their real paths (`MS_BIND|MS_REC`, writable);
   - **ro passthroughs** read-only (`MS_BIND|MS_REC|MS_RDONLY`) — the default
     set is `/usr /etc /lib /lib64 /bin /sbin /opt /var /proc`
     (`defaultRORoots()`; `/proc` gives a functional process view);
   - the **socket dir** (keeper IPC + `keeper.err` trace), so the parent can
     reach the keeper's socket;
   - `/dev` (rw — the pty needs `/dev/pts` + `/dev/tty`);
   - the **binary file** (not its dir), so the keeper can exec itself after
     the pivot. Binding the whole dir would leak its entire contents (e.g. the
     user's home, if the binary lives there). A file bind needs a destination
     file, so the child creates an empty placeholder at the binary's path
     post-pivot, then bind-mounts the real binary over it (same path,
     different inode; the placeholder's zero content is shadowed). Only the
     binary file is present in-ns — the rest of the dir stays hidden.
6. **Hide the host fs** — see below.
7. `prctl(PR_SET_PDEATHSIG, SIGKILL)` so a crashed server can't leak the
   keeper (persists across the exec).
8. Raw `execve` the keeper (the namespaces inherit across exec).

### The `/oldroot` backdoor (and its two fixes)

`pivot_root` relocates the host `/` to `/oldroot`. Naively, a single
`umount2("/oldroot", MNT_DETACH)` only detaches the *top* of the mount stack —
the relocated old root and all its `/oldroot/*` submounts (dev, run, sys,
proc, snap, …) remain, so `ls /oldroot` = host `/` and the user could
`cat /oldroot/etc/shadow`. Two host-fs leaks must be closed:

1. **`/oldroot` and every `/oldroot/<...>` submount** — `rawDetachOldRoot()`
   parses `/proc/self/mountinfo` (into a 64 KiB stack buffer; the real file
   was ~18.5 KiB / 124 submounts, so a 16 KiB buffer silently truncated the
   deepest entries) and detaches every `/oldroot*` mountpoint, **deepest
   first**, with the correct `MNT_DETACH` flag (`0x2` — a wrong flag like
   `0x2000` makes `umount2` fail with `EINVAL` and the detach silently
   no-ops). It then best-effort `rmdir`s the leftover `/oldroot` dir.
2. **The pre-pivot staging bind `.../newroot/oldroot`** — the temp dir under
   `/tmp/cadence-sbx-*/newroot` used as pivot_root's oldroot target is *also*
   a full host-`/` bind, a second backdoor that survives the `/oldroot`
   detaches. `rawIsDetachTarget()` matches any mountpoint containing the
   `/newroot/oldroot` segment.

`rawDetachOldRoot` is pure byte-compare (no allocation) so it is safe in the
single-threaded child; each failing `umount2` errno is captured into the trace
(`traceInt`) so a failure is diagnosable rather than a silent no-op.

**Verified by test**: `TestNativeSandboxEndToEnd` asserts that
`/proc/self/mountinfo` inside the sandbox has **zero** entries whose
mountpoint is `/oldroot`, `/oldroot/<...>`, or contains `/newroot/oldroot`,
that `/oldroot/etc` is unreachable, and that the host fs is otherwise hidden
while the rw root bind remains writable.

### pty EOF / the slave-fd close (why `exit` used to hang)

When the keeper forks a join-child, it holds its own copy of the pty slave fd.
If the keeper does not `close()` that copy after the fork, the pty **master
never sees EOF** when the shell exits, so the `/terminal` WS stays open forever
and agent `run_command` hangs after the command completes. `handleSpawn`
therefore closes the keeper's slave fd after the child `dup2`s it to 0/1/2
(the child keeps its own reference). `TestNativeSandboxEndToEnd` asserts the
master EOFs after `exit`.

### Keeper reaper (why keepers used to spin at 100% CPU)

Join-children are the keeper's children, so the keeper runs a `wait4(-1)`
reaper goroutine to prevent zombie accumulation. A keeper with **no** live
children gets `ECHILD` (`wpid == 0`) from `wait4` *immediately* instead of
blocking — without a backoff the idle keeper busy-spins at 100% CPU. The
reaper now sleeps 200 ms on `ECHILD`/error (a newly spawned child is reaped
within that window; the pty master's EOF — not the reaper — is what signals
shell exit to the parent).

---

## Capability probe

`probeSandbox()` (cached, `sandbox_unix.go`) determines whether an
unprivileged user-namespace sandbox can be created, and how:

1. **Cheap sysctl checks** (no fork):
   - `/proc/sys/kernel/unprivileged_userns_clone == 0` → unavailable.
   - `/proc/sys/kernel/apparmor_restrict_unprivileged_userns == 1` →
     unavailable (Ubuntu 23.10+/24.04+ AppArmor restriction).
2. **Live native probe**: `nativeProbe()` forks a single-threaded child that
   attempts `unshare(CLONE_NEWUSER)` + writes its own `uid_map`/`gid_map`.
   Success → `Method: "native"`.
3. **bwrap fallback**: if native fails and `bwrap` is on PATH →
   `Method: "bwrap"`.
4. Otherwise → unavailable with a reason.

> **Ubuntu AppArmor userns restriction.** The biggest deployment risk. Two
> remediations (see `scratch/sandbox_poc/README.md`):
> - **Scoped profile** (preferred): install the `bwrap-userns-restrict`
>   profile from the AppArmor `extras/` tree so only our binary may create
>   user namespaces. This is the production path.
> - **Global sysctl** (diagnostic only): `sudo sysctl -w
>   kernel.apparmor_restrict_unprivileged_userns=0`. Do **not** ship this as a
>   default — it disables the restriction for every process.
>
> Note: bwrap uses the *same* unprivileged user-namespace mechanism, so it does
> **not** bypass the AppArmor restriction — it is an escape hatch for
> exotic-kernel issues only.

---

## The bwrap fallback

When the native path is unavailable but `bwrap` exists, each shell runs as its
own `bwrap` process (there is **no persistent keeper** — the "instance" is a
pure registry entry tracking owners). `bwrapArgv()` (a pure function, unit-
tested without bwrap) builds the equivalent layout:

```
bwrap --tmpfs / --dev /dev --die-with-parent --new-session
      [--unshare-pid] [--unshare-net]
      --ro-bind <ro> <ro> ... --bind <root> <root> ...
      <shell>
```

`/` is an **empty tmpfs** (the host fs is hidden — `--ro-bind / /` would
expose it), a minimal `/dev` is bound back, ro passthroughs + rw roots are
bound at their real paths, and the shell runs with a scrubbed env.

---

## Registry, owners, and lifecycle

`sandboxManager` (in-process, mutex-guarded) maps fingerprint →
`SandboxInstance`. Each instance tracks its keeper pid, socket path, and an
`owners` set.

**Owner labels** (refcount keys):
- `session:<id>` — an **agent session**. *Sticky*: `run_command` opens a fresh
  WS per command, so the owner must survive each WS close and persist for the
  session's lifetime. It is released only by an explicit
  `sandbox_release=1&session=<id>` handshake when the session is destroyed
  (frontend: `ai-manager-sessions.mjs → _releaseSessionSandbox`).
- `terminal:<tab>` — a **user terminal tab**. *Transient*: released when the
  tab's WS closes.

Lifecycle:
- `getOrCreateInstance(cfg, method)` — join the instance for the layout, or
  spawn the keeper (native) / register (bwrap).
- `addOwner` / `removeOwner` — refcount; `removeOwner` reaps the instance when
  the last owner leaves (`reapInstance` kills the keeper + any bwrap children
  and removes the socket dir).
- `findInstanceByOwner` / `attachToOwner` — the "user terminal attaches to an
  agent session's sandbox" path. It locates the instance the target owner
  (`session:<id>`) co-owns and spawns the user's shell **inside that same
  namespace** (the user sees exactly the agent's workspace: same file view,
  same in-ns processes). The target's instance is preferred; if the target has
  not yet created one, one is created from the requested layout so the attach
  still succeeds and the two share it once the agent's first command lands on
  the same layout.
- `releaseOwner` — drop an owner by label.

---

## Backend API

### `GET /api/sandbox` (`sandboxStatusHandler`, `main_common.go`)

Returns `SandboxStatusResponse`: the capability probe result
(`available`, `method`, `reason`) plus a snapshot of live instances
(`instances: [{ id, roots, owners, shared }]`). Used by the frontend for a
capability indicator and to list attachable agent sandboxes.

### `WS /terminal` sandbox query params (`terminalServer`, `handlers.go`)

| Param | Meaning |
|---|---|
| `sandbox=1` | Run this shell inside a sandbox (agent `run_command`). |
| `sandbox=attach` | Join another owner's sandbox (user terminal). |
| `session=<id>` | Owner label (`session:<id>`) / attach target owner. |
| `sandbox_roots=<a,b,c>` | rw roots, **securePath-validated server-side** (never trust the query). `roots=` is an alias. |
| `sandbox_ro=<paths>` | Extra ro passthroughs. |
| `sandbox_pid/net/uts/ipc=1` | Namespace flags (UTS/IPC default on; PID/NET off). |
| `tab=<id>` | Owner label for the attaching terminal (`terminal:<tab>`). |
| `sandbox_release=1&session=<id>` | No-op handshake that drops the `session:<id>` owner and reaps if last. |

Roots are always re-validated through `securePath()`; invalid roots are
rejected (logged) and the remaining valid ones are used. If no valid roots
remain, the shell starts unsandboxed with `sandbox: "unavailable"`.

### `terminalInfo` sandbox fields (server → client)

| Field | Values / meaning |
|---|---|
| `sandbox` | `"native"` \| `"bwrap"` \| `"off"` \| `"unavailable"` \| `"unsupported"` |
| `sandboxReason` | Why unavailable (AppArmor, no roots, attach failed, …). |
| `sandboxID` | The shared instance id (`sbx-xxxx`). |
| `sandboxOwners` | All owners inside the same instance. |
| `sandboxShared` | `true` when >1 owner shares the instance. |
| `sandboxRoots` | The instance's rw root layout (so the frontend can echo it back for an exact-fingerprint attach). |

---

## Frontend

### Agent `run_command` (`agent-tools.mjs`)

`runCommand` appends `&session=<id>` (sticky owner) and, when sandboxing is
enabled, `&sandbox_roots=<effective workspace folders>&sandbox=1`. The session
is a sticky owner from its first sandboxed command, so the sandbox **persists
for the session's lifetime** (one instance, not per-command). The
`terminalInfo` sandbox metadata is captured onto the session
(`session.sandboxId`) and the command output card shows a **sandbox badge**
(`ai-manager-history.mjs`) with the id + co-owners.

**Enabling/disabling**:
- Global default: Agent Config → "Default Sandbox Terminal Commands"
  (`defaultSandboxCommands`, default **on**).
- Per-session: Session panel → "Sandbox Terminal Commands"
  (`session.sandboxCommands`, inherits the global default when unset).

**Graceful degradation**: if the sandbox was requested but the server fell
back to unsandboxed (or no sandbox metadata arrived on a non-Linux host), the
command output is prefixed with a one-line notice
(`[sandbox unavailable: <reason> — command ran UNSANDBOXED]`).

### User terminal (`terminal-manager.mjs`)

Per-tab **sandbox mode selector** (default `unsandboxed`):
- `unsandboxed` — today's behavior.
- `sandboxed` — own layout from the workspace folders
  (`sandbox=1&tab=<tabId>&sandbox_roots=<folders>`; since no `session=` is
  sent, the owner label is `terminal:<WS-session-id>`).
- `attach` — join an agent session's sandbox
  (`sandbox=attach&session=<agentSessionId>&tab=<tabId>`). The attach
  dropdown is populated from `listAttachableSandboxes()`, which merges (a)
  live instances from `GET /api/sandbox` (owners with a `session:` prefix →
  attachable by session id) with (b) in-memory running sessions that captured
  a `sandboxId`. The tab header shows a badge with the instance id and a
  shared indicator.

`openTerminalInAgentSandbox(agentSessionId)` is the "open a terminal in this
sandbox" entry point (used by the sandbox badge on command output cards): it
reveals the terminal drawer (`ui.toggleDrawer(true)`, matching the other
"open terminal here" triggers) and creates an attach-mode session. It toasts
if Conduit is not running.

### Session release (`ai-manager-sessions.mjs`)

When an agent session is destroyed, `_releaseSessionSandbox(sessionId)` opens
a short-lived `WS /terminal?sandbox_release=1&session=<id>`, which drops the
`session:<id>` owner and reaps the instance if it was the last owner. Never
throws.

---

## Hardening

- **Roots**: always re-validated server-side via `securePath()`; the query
  param is never trusted.
- **Env scrub** (`scrubEnv`): strips `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `GIT_SSH_COMMAND`,
  `SSH_AUTH_SOCK`, `PROXY`, `HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`. `HOME`
  is kept (the userns keeps the real uid — the sandbox is *path-scoped*, not
  user-scoped). `TERM=xterm-256color` is set.
- **`PR_SET_PDEATHSIG`**: both the keeper and the join-children set
  `PR_SET_PDEATHSIG=SIGKILL` so a crashed server can't leak sandboxes (it
  persists across exec).
- **Timeout enforcement** (agent commands only; user tabs have no timeout):
  enforced **client-side** in `agent-tools.mjs` — after `timeoutMs` the
  frontend sends `^C` + `exit` over the WS and closes the connection
  (the shell's exit EOFs the pty master and closes the WS).
- **Trust note**: attaching the user terminal to the agent sandbox is safe by
  construction — the view is a bind of the same real paths the unsandboxed
  shell already sees. Sharing adds co-visibility (same in-ns processes when
  the PID ns is on), which is the intended feature.

---

## Tests (`sandbox_unix_test.go`, linux build tag)

| Test | Verifies |
|---|---|
| `TestProbe` | The capability probe returns a well-formed result. |
| `TestNativeSandboxEndToEnd` | (a) an in-ns write appears on the host (bind-mount is real + writable); (b) the host fs is hidden (host marker absent, `/home` unreachable, `/dev/pts` present); (b2) the `/oldroot` backdoor is closed (zero `/oldroot*` / `/newroot/oldroot` entries in `mountinfo`, `/oldroot/etc` unreachable, rw root still writable); (c) `exit` EOFs the pty master (no slave-fd leak). |
| `TestSharedInstance` | Two owners with the same layout share one keeper (`shared=true`); the instance is reaped when the last owner leaves. |
| `TestBwrapArgv` | The pure bwrap argv construction (empty tmpfs at `/`, no `--ro-bind / /`, minimal `/dev`, rw binds, ro passthroughs, `--unshare-pid`/`--unshare-net` per flags, `--die-with-parent`, shell last). |
| `TestScrubEnv` | Dangerous env vars are stripped; `PATH`/`HOME`/`NO_COLOR`/`TERM` kept. |
| `TestFingerprint` | The layout fingerprint is stable, order-insensitive for roots, changes when flags change, and is `sbx-`-prefixed. |

The native tests build the real server binary (the test harness binary cannot
run the keeper — its `main` is the Go test framework) and point
`CADENCE_SANDBOX_REEXEC` at it. They skip cleanly when the native sandbox is
unavailable (e.g. the AppArmor restriction).

---

## Known limitations

- **Linux-only** by design; macOS/Windows run unsandboxed.
- **Ubuntu AppArmor userns restriction** is the biggest deployment risk —
  mitigated by detection + graceful degradation + the documented
  `bwrap-userns-restrict` profile.
- **Shared-ns surprises**: when the PID namespace is shared (opt-in), a user
  can see/kill an agent's background processes. The PID ns is **off by
  default** (host process view either way); when on, it's explicit opt-in and
  the shared badge shows co-owners.
- **bwrap is per-shell** (no persistent keeper), so the bwrap "instance" is a
  registry entry, not a shared namespace — attach semantics are approximate
  under the bwrap method.
