//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// ---------------------------------------------------------------------------
// Native user-namespace sandboxing for agent commands and the user terminal.
//
// A sandbox is a PERSISTENT, ADDRESSABLE instance (not a per-command bubble).
// It is a long-lived "keeper" coprocess that has unshared into a fresh
// user+mount namespace, applied the bind-mount layout once, and then idles.
// Owners (agent sessions, user terminal tabs) JOIN the instance by asking the
// keeper to fork a shell child into its namespace, attached to a pty the
// caller opened. Instances are refcounted by owner; the last owner to leave
// reaps the keeper.
//
// Sandboxes are keyed by a LAYOUT FINGERPRINT (sorted roots + flags), so two
// owners with the same layout share one instance; a layout change yields a
// different instance.
//
// Why the reexec+keeper model:
//   - An unprivileged process that wants a new user+mount namespace must
//     unshare(CLONE_NEWUSER) first. On a multi-threaded Go process this fails
//     with EINVAL, so the unshare is done in a single-threaded clone child
//     (raw syscalls only — x/sys/unix wrappers crash in a forked Go child).
//   - A mount-namespace layout cannot be mutated in place from outside, and
//     there is no unprivileged "enter namespace" syscall. So the ns is created
//     once and kept alive by the keeper; joiners fork into it.
//   - The keeper is a reexec of this same binary in --sandbox-keeper mode, so
//     no new binary or dependency is required (only golang.org/x/sys/unix).
//
// CRITICAL (empirically validated in scratch/sandbox_poc): the clone child
// must use ONLY syscall.RawSyscall/RawSyscall6 (stdlib, nosplit, "safe after
// fork"). It must NOT call x/sys/unix wrappers, allocate, or touch the
// runtime. All strings/pointers/lengths it needs are PRECOMPUTED in the
// parent and read from globals (COW-shared across the clone).
// ---------------------------------------------------------------------------

// SandboxInstance is a live sandbox: a keeper coprocess + refcounted owners.
type SandboxInstance struct {
	id          string
	fingerprint string
	cfg         *SandboxConfig
	keeperPid   int
	socketPath  string
	owners      map[string]bool
	lastUse     time.Time
	// bwrapPids tracks the per-shell bwrap child pids (bwrap has no persistent
	// keeper; each shell is its own bwrap process). Reaped with the instance.
	bwrapPids map[int]bool
}

// sandboxManager is the in-process registry keyed by layout fingerprint.
var sandboxManager = struct {
	mu        sync.Mutex
	instances map[string]*SandboxInstance
	probe     *probeResult
	probeOnce bool
}{instances: map[string]*SandboxInstance{}}

type probeResult struct {
	Available bool
	Reason    string // when unavailable
	Method    string // "native" | "bwrap"
}

// ---- raw-syscall child payload (precomputed in the PARENT; the clone child
// ---- must not allocate, so everything is a string / pointer / slice header) ----
var (
	rawUIDMapStr      string
	rawGIDMapStr      string
	rawDenyStr        string   = "deny\n"
	rawMountRoots     []string // rw roots
	rawMountRO        []string // ro roots
	rawNSMask         uintptr  // CLONE_* mask for unshare
	rawKargv0         *byte
	rawKargv          unsafe.Pointer
	rawKenvv          unsafe.Pointer
	rawStderrPath     string           // child redirects fd2 here so a failing keeper leaves a trace
	rawNewRoot        string           // newroot dir (inside the socket dir) for pivot_root
	rawOldRoot        string           // newroot/oldroot — host / is bind-mounted here
	rawSocketDir      string           // the socket dir, bind-mounted at its real path in the new root
	rawBinDir         string           // the keeper binary's dir, bind-mounted so the keeper can exec itself
	rawMkdirPathsList []string         // precomputed mkdir -p paths (newroot targets)
	rawTraceFd        int              // the child's stderr fd (trace file), for per-step markers
	rawStepPtrs       []unsafe.Pointer // precomputed pointers to single step-bytes (parent allocates)
)

// mk writes a single step-byte to the child's trace fd (fd 2). Used to
// pinpoint which raw-syscall step a failing keeper dies at. No allocation in
// the child (pointers are precomputed in the parent before fork).
func mk(step int) {
	if rawTraceFd > 0 && step >= 0 && step < len(rawStepPtrs) {
		syscall.RawSyscall(syscall.SYS_WRITE, uintptr(rawTraceFd), uintptr(rawStepPtrs[step]), 1)
	}
}

// traceInt writes a small integer (the /oldroot detach count) to the child's
// trace fd, bracketed by ':' and ';'. Allocation-free: it formats into a stack
// buffer. A negative value (read/open failure) is written as '-'.
func traceInt(v int) {
	if rawTraceFd <= 0 {
		return
	}
	var b [16]byte
	var n int
	if v < 0 {
		b[n] = ':'
		b[n+1] = '-'
		n = 2
	} else {
		b[n] = ':'
		n = 1
		if v == 0 {
			b[n] = '0'
			n = 2
		} else {
			var tmp [12]byte
			t := 0
			for v > 0 {
				tmp[t] = byte('0' + v%10)
				t++
				v /= 10
			}
			for i := 0; i < t; i++ {
				b[n] = tmp[t-1-i]
				n++
			}
		}
		b[n] = ';'
		n++
	}
	syscall.RawSyscall(syscall.SYS_WRITE, uintptr(rawTraceFd),
		uintptr(unsafe.Pointer(&b[0])), uintptr(n))
}

// Join-child payload (precomputed in the KEEPER; the join-child is
// single-threaded and must not allocate).
var (
	gJoinSlaveFd int
	gJoinCwd     string
	gJoinArgv0   *byte
	gJoinArgv    unsafe.Pointer
	gJoinEnvv    unsafe.Pointer
)

// cString allocates a NUL-terminated copy of s (parent-side only).
func cString(s string) *byte {
	b := append([]byte(s), 0)
	return &b[0]
}

// buildExecveStructures precomputes the **byte argv/envv arrays for a raw
// execve. All allocations happen here (parent); the child only takes addresses.
func buildExecveStructures(argv, envv []string) (argv0 *byte, argvPtr, envvPtr unsafe.Pointer) {
	argv0 = cString(argv[0])
	argvSlice := make([]*byte, len(argv)+1)
	for i, a := range argv {
		argvSlice[i] = cString(a)
	}
	argvSlice[len(argv)] = nil
	argvPtr = unsafe.Pointer(&argvSlice[0])

	envvSlice := make([]*byte, len(envv)+1)
	for i, e := range envv {
		envvSlice[i] = cString(e)
	}
	envvSlice[len(envv)] = nil
	envvPtr = unsafe.Pointer(&envvSlice[0])
	return
}

// strPtr returns a stable pointer to a NUL-terminated copy of s. Raw syscalls
// (mount, chdir, execve, ...) read the byte buffer until a NUL byte, so the
// string MUST be NUL-terminated — a raw pointer to Go string data is not. The
// copy is cached (leaked for process lifetime) so repeated calls with the same
// string return the same stable pointer. Safe to call from the single-threaded
// clone child (allocation there is the only "cost", but it is one-time and the
// child execs/exits immediately).
var strPtrCache = map[string]*byte{}

// strPtrPtr returns a stable *byte to a NUL-terminated copy of s.
func strPtrPtr(s string) *byte {
	if s == "" {
		return nil
	}
	if p, ok := strPtrCache[s]; ok {
		return p
	}
	b := append([]byte(s), 0)
	p := &b[0]
	strPtrCache[s] = p
	return p
}

// strPtr returns a stable uintptr to a NUL-terminated copy of s.
func strPtr(s string) uintptr {
	if s == "" {
		return 0
	}
	return uintptr(unsafe.Pointer(strPtrPtr(s)))
}

// rawFork does clone(SIGCHLD) — a real process fork (new address space via
// COW), yielding a single-threaded child. The child must only make
// allocation-free, non-blocking raw syscalls before exec/exit.
func rawFork() (pid int, err error) {
	r1, _, e1 := syscall.RawSyscall6(syscall.SYS_CLONE, uintptr(syscall.SIGCHLD), 0, 0, 0, 0, 0)
	if e1 != 0 {
		return 0, syscall.Errno(e1)
	}
	return int(r1), nil
}

// writeMapFile writes s to path using raw syscalls (child-side, no alloc).
// RawSyscall takes (number, a1, a2, a3) â 4 args total.
func writeMapFile(path, s string) {
	if fd, _, pe := syscall.RawSyscall(syscall.SYS_OPEN, strPtr(path), 0x41 /*O_WRONLY*/, 0); pe == 0 {
		syscall.RawSyscall(syscall.SYS_WRITE, fd, strPtr(s), uintptr(len(s)))
		syscall.RawSyscall(syscall.SYS_CLOSE, fd, 0, 0)
	}
}

// rawMkdirPaths creates each precomputed directory (parent-side mkdir -p
// expansion) using raw syscalls in the child. EEXIST is treated as success.
// The path list is PRECOMPUTED in the parent (the child must not allocate, so
// it cannot split/concatenate strings itself).
func rawMkdirPaths(paths []string) syscall.Errno {
	for _, p := range paths {
		if _, _, e := syscall.RawSyscall6(syscall.SYS_MKDIR, strPtr(p), 0755, 0, 0, 0, 0); e != 0 && e != syscall.EEXIST {
			return e
		}
	}
	return 0
}

// rawIsDetachTarget reports whether the mountpoint buf[start:end) is a host-fs
// leak that must be detached. Two classes:
//  1. /oldroot or /oldroot/<...> — the pivot-relocated host root (and its
//     submounts: dev, run, sys, proc, snap, lxcfs, ...).
//  2. the pre-pivot STAGING bind .../newroot/oldroot — the temp dir under
//     /tmp/cadence-sbx-*/newroot that pivot_root used as the old-root target.
//     It is ALSO a full host-/ bind (the staging dir itself was bind-mounted
//     from host / before the pivot), so it is a second host-fs backdoor that
//     survives the /oldroot detaches. Any mountpoint whose path contains the
//     "/newroot/oldroot" segment is a leak.
//
// Pure byte-compare (no allocation) so it is safe in the single-threaded child.
func rawIsDetachTarget(start, end int, buf []byte) bool {
	l := end - start
	// Class 1: exactly "/oldroot" or "/oldroot/...".
	if l >= 8 &&
		buf[start] == '/' && buf[start+1] == 'o' && buf[start+2] == 'l' &&
		buf[start+3] == 'd' && buf[start+4] == 'r' && buf[start+5] == 'o' &&
		buf[start+6] == 'o' && buf[start+7] == 't' &&
		(l == 8 || buf[start+8] == '/') {
		return true
	}
	// Class 2: contains the "/newroot/oldroot" segment (the staging bind).
	const seg = "/newroot/oldroot"
	if l < len(seg) {
		return false
	}
	for i := 0; i+len(seg) <= l; i++ {
		match := true
		for k := 0; k < len(seg); k++ {
			if buf[start+i+k] != seg[k] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// rawDetachOldRoot hides the host fs by detaching every host-fs-leak mount
// (see rawIsDetachTarget), deepest-first. It runs in the single-threaded clone child
// using ONLY raw syscalls (no allocation beyond stack arrays — the child must
// not touch the heap or the runtime).
//
// Why this is needed: after pivot_root(newroot, newroot/oldroot), the host /
// is relocated to /oldroot (the "old root" mount). We then stack an explicit
// bind (mount("/", /oldroot, MS_BIND|MS_REC)) on top of it, plus the new-root
// binds reference /oldroot/<dir>. A single umount2("/oldroot", MNT_DETACH)
// detaches ONLY the top of the stack — the relocated old root and all its
// /oldroot/* submounts (dev, run, sys, proc, snap, lxcfs, ...) REMAIN, so
// `ls /oldroot` = host / and the user can navigate to the real host fs (e.g.
// cat /oldroot/etc/shadow). We therefore parse /proc/self/mountinfo and detach
// every /oldroot* mountpoint, deepest (longest) first, with the CORRECT
// MNT_DETACH flag (0x2 — a wrong flag like 0x2000 makes umount2 fail with
// EINVAL and the detach silently no-ops).
//
// Returns the number of /oldroot* mounts detached (for the trace marker).
func rawDetachOldRoot() int {
	const maxMounts = 512
	// 64 KiB: a fully-loaded mountinfo (this host: ~18.5 KiB, 124 /oldroot*
	// submounts) must fit in ONE read or the last lines (the deepest /oldroot*
	// submounts) are silently truncated and never detached. 16 KiB was too small.
	var buf [65536]byte
	var pts [maxMounts]*byte // pointers into the buffer (no alloc)
	var lens [maxMounts]int
	var depth [maxMounts]int
	var n int

	// Open /proc/self/mountinfo and read it into a stack buffer (loop for
	// safety; the file is a few pages).
	fd, _, eOpen := syscall.RawSyscall6(syscall.SYS_OPEN, strPtr("/proc/self/mountinfo"), 0 /*O_RDONLY*/, 0, 0, 0, 0)
	if eOpen != 0 {
		return -1
	}
	off := 0
	for off < len(buf) {
		var r int
		for {
			rv, _, e := syscall.RawSyscall6(syscall.SYS_READ, fd,
				uintptr(unsafe.Pointer(&buf[off])), uintptr(len(buf)-off), 0, 0, 0)
			if e == 0 {
				r = int(rv)
				break
			}
			if e == syscall.EINTR {
				continue
			}
			r = 0
			break
		}
		if r == 0 {
			break
		}
		off += r
	}
	syscall.RawSyscall(syscall.SYS_CLOSE, fd, 0, 0)

	// Parse the buffer line by line. mountinfo format:
	//   mount_id parent_id device root mount_point options [- fs_type source super]
	//   (field 1     2         3      4       5         6       ...)
	// We need field 5 (the mount_point). All indices are ABSOLUTE into buf (the
	// buffer is never shifted, so the stored mountpoint pointers stay valid).
	lineStart := 0
	for lineStart < off {
		// Find the next newline.
		nl := -1
		for i := lineStart; i < off; i++ {
			if buf[i] == '\n' {
				nl = i
				break
			}
		}
		lineEnd := off
		if nl >= 0 {
			lineEnd = nl
		}
		// Extract field 5 (mountpoint) from buf[lineStart:lineEnd].
		pos := lineStart
		fields := 0
		f5Start, f5End := -1, -1
		for pos < lineEnd && fields < 5 {
			// skip whitespace
			for pos < lineEnd && (buf[pos] == ' ' || buf[pos] == '\t') {
				pos++
			}
			if pos >= lineEnd {
				break
			}
			start := pos
			for pos < lineEnd && buf[pos] != ' ' && buf[pos] != '\t' {
				pos++
			}
			fields++
			if fields == 5 {
				f5Start = start
				f5End = pos
			}
		}
		if fields >= 5 && f5Start >= 0 && f5End > f5Start && rawIsDetachTarget(f5Start, f5End, buf[:]) {
			if n < maxMounts {
				pts[n] = &buf[f5Start]
				lens[n] = f5End - f5Start
				d := 0
				for i := f5Start; i < f5End; i++ {
					if buf[i] == '/' {
						d++
					}
				}
				depth[n] = d
				n++
			}
		}
		if nl >= 0 {
			lineStart = nl + 1
		} else {
			break
		}
	}

	// Sort deepest-first (longest path first) so children detach before parents.
	// Simple insertion sort (n is small).
	for i := 1; i < n; i++ {
		pi, li, di := pts[i], lens[i], depth[i]
		j := i - 1
		for j >= 0 && depth[j] < di {
			pts[j+1], lens[j+1], depth[j+1] = pts[j], lens[j], depth[j]
			j--
		}
		pts[j+1], lens[j+1], depth[j+1] = pi, li, di
	}

	// Detach each, deepest first. MNT_DETACH = 0x2 (NOT 0x2000). Deepest-first
	// means each mountpoint path still resolves at the time we detach it (we
	// have not yet detached its parent), so each umount2 should succeed. Any
	// failure is exceptional — capture its errno into the trace so a failing
	// keeper is diagnosable instead of silently no-oping.
	detached := 0
	for i := 0; i < n; i++ {
		// Build a NUL-terminated copy of the mountpoint for the umount2 call.
		var path [512]byte
		l := lens[i]
		if l > 511 {
			l = 511
		}
		for k := 0; k < l; k++ {
			path[k] = *pts[i]
			pts[i] = (*byte)(unsafe.Pointer(uintptr(unsafe.Pointer(pts[i])) + 1))
		}
		path[l] = 0
		if _, _, e := syscall.RawSyscall6(syscall.SYS_UMOUNT2,
			uintptr(unsafe.Pointer(&path[0])), uintptr(syscall.MNT_DETACH), 0, 0, 0, 0); e == 0 {
			detached++
		} else {
			// Trace the failing errno (diagnostic only; the top-level /oldroot
			// detach is what actually hides the host fs, so a submount failure
			// here is non-fatal).
			traceInt(int(e))
		}
	}

	// Best-effort: rmdir the leftover /oldroot directory (it is now an empty
	// dir on the new-root fs). Ignore ENOTEMPTY (submounts may linger).
	syscall.RawSyscall6(syscall.SYS_RMDIR, strPtr("/oldroot"), 0, 0, 0, 0, 0)

	return detached
}

// expandMkdirAll returns the full set of absolute directory components that
// mkdir -p would create for each path (parent-side only).
func expandMkdirAll(paths []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, path := range paths {
		cur := ""
		for _, part := range strings.Split(path, "/") {
			if part == "" {
				continue
			}
			cur += "/" + part
			if !seen[cur] {
				seen[cur] = true
				out = append(out, cur)
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

// probeSandbox determines whether an unprivileged user-namespace sandbox can
// be created on this host, and how (native vs bwrap). The result is cached.
//
// The native probe forks a single-threaded child that attempts
// unshare(CLONE_NEWUSER) and writes its own uid_map. If the host blocks
// unprivileged userns (e.g. Ubuntu 24.04+ AppArmor restriction), this fails
// and we fall back to bwrap (if present) or report unavailable.
func probeSandbox() *probeResult {
	sandboxManager.mu.Lock()
	defer sandboxManager.mu.Unlock()
	if sandboxManager.probeOnce {
		return sandboxManager.probe
	}

	res := &probeResult{}

	// 1. Check kernel sysctls first (cheap, no fork).
	if b, err := os.ReadFile("/proc/sys/kernel/unprivileged_userns_clone"); err == nil {
		if strings.TrimSpace(string(b)) == "0" {
			res.Available = false
			res.Reason = "kernel.unprivileged_userns_clone=0 (unprivileged user namespaces disabled)"
			sandboxManager.probe = res
			sandboxManager.probeOnce = true
			return res
		}
	}
	if b, err := os.ReadFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"); err == nil {
		if strings.TrimSpace(string(b)) == "1" {
			res.Available = false
			res.Reason = "AppArmor restricts unprivileged user namespaces (install the bwrap-userns-restrict profile or set kernel.apparmor_restrict_unprivileged_userns=0)"
			sandboxManager.probe = res
			sandboxManager.probeOnce = true
			return res
		}
	}

	// 2. Live probe: fork a single-threaded child that unshares CLONE_NEWUSER
	//    and writes uid_map. Success => native is available.
	if nativeProbe() {
		res.Available = true
		res.Method = "native"
	} else if _, ok := lookPathBwrap(); ok {
		res.Available = true
		res.Method = "bwrap"
		res.Reason = "native userns unavailable; using bwrap fallback"
	} else {
		res.Available = false
		res.Reason = "unprivileged user namespaces blocked and bwrap not found on PATH"
	}

	sandboxManager.probe = res
	sandboxManager.probeOnce = true
	return res
}

// nativeProbe forks a single-threaded child that attempts unshare(CLONE_NEWUSER)
// + uid_map write. Returns true on success. The child uses raw syscalls only.
func nativeProbe() bool {
	uid := os.Getuid()
	gid := os.Getgid()
	rawUIDMapStr = fmt.Sprintf("0 %d 1\n", uid)
	rawGIDMapStr = fmt.Sprintf("0 %d 1\n", gid)

	pid, err := rawFork()
	if err != nil {
		return false
	}
	if pid == 0 {
		// CHILD (single-threaded, raw syscalls only):
		if _, _, e := syscall.RawSyscall(syscall.SYS_UNSHARE, uintptr(syscall.CLONE_NEWUSER), 0, 0); e != 0 {
			syscall.RawSyscall(syscall.SYS_EXIT, 1, 0, 0)
		}
		writeMapFile("/proc/self/uid_map", rawUIDMapStr)
		writeMapFile("/proc/self/setgroups", rawDenyStr)
		writeMapFile("/proc/self/gid_map", rawGIDMapStr)
		syscall.RawSyscall(syscall.SYS_EXIT, 0, 0, 0)
	}
	var ws syscall.WaitStatus
	for {
		wpid, err := syscall.Wait4(pid, &ws, 0, nil)
		if err == syscall.EINTR {
			continue
		}
		if wpid == pid {
			return ws.Exited()
		}
		return false
	}
}

func lookPathBwrap() (string, bool) {
	p, err := exec.LookPath("bwrap")
	if err != nil {
		return "", false
	}
	return p, true
}

// bwrapArgv builds the equivalent bubblewrap argv for a sandbox layout. It is a
// pure function (no bwrap required) so it can be unit-tested. The layout
// mirrors the native keeper: / is an EMPTY tmpfs (the host filesystem is
// hidden — `--ro-bind / /` would expose it), the ro system passthroughs + a
// minimal /dev are bound back on, each rw root is bind-mounted at its real
// path (writable), and the shell runs with a scrubbed env. bwrap uses the
// same unprivileged user-namespace mechanism as the native path, so it is an
// escape hatch for exotic-kernel issues only (it does NOT bypass the Ubuntu
// AppArmor userns restriction).
func bwrapArgv(cfg *SandboxConfig) []string {
	shell := cfg.Shell
	if shell == "" {
		shell = "/bin/bash"
	}
	argv := []string{
		"bwrap",
		"--tmpfs", "/",
		"--dev", "/dev",
		"--die-with-parent",
		"--new-session",
	}
	if cfg.Flags.PID {
		argv = append(argv, "--unshare-pid")
	}
	if cfg.Flags.NET {
		argv = append(argv, "--unshare-net")
	}
	for _, r := range cfg.ReadOnlyRoots {
		argv = append(argv, "--ro-bind", r, r)
	}
	for _, r := range cfg.Roots {
		argv = append(argv, "--bind", r, r)
	}
	argv = append(argv, shell)
	return argv
}

// ---------------------------------------------------------------------------
// Layout fingerprint + instance registry
// ---------------------------------------------------------------------------

// fingerprint computes a stable id for a sandbox layout (sorted roots + flags).
func fingerprint(cfg *SandboxConfig) string {
	h := sha256.New()
	roots := append([]string{}, cfg.Roots...)
	ro := append([]string{}, cfg.ReadOnlyRoots...)
	sort.Strings(roots)
	sort.Strings(ro)
	for _, r := range roots {
		fmt.Fprintf(h, "rw:%s\n", r)
	}
	for _, r := range ro {
		fmt.Fprintf(h, "ro:%s\n", r)
	}
	fmt.Fprintf(h, "pid:%v net:%v uts:%v ipc:%v\n", cfg.Flags.PID, cfg.Flags.NET, cfg.Flags.UTS, cfg.Flags.IPC)
	sum := h.Sum(nil)
	return fmt.Sprintf("sbx-%x", sum[:4])
}

// defaultRORoots returns the read-only system passthroughs used when the
// config does not specify any.
func defaultRORoots() []string {
	// /proc is a ro passthrough: after the pivot the new-root /proc is an empty
	// dir, so binding the host /proc back on (ro) gives the sandbox a
	// functional process view.
	return []string{"/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/var", "/proc"}
}

// scrubEnv strips environment variables that could be used to escape or
// interfere with the sandbox (preloads, ssh/proxy overrides). HOME is kept
// (the userns keeps the real uid — the sandbox is path-scoped, not
// user-scoped).
func scrubEnv(base []string, extra []string) []string {
	drop := map[string]bool{
		"LD_PRELOAD": true, "LD_LIBRARY_PATH": true,
		"DYLD_INSERT_LIBRARIES": true, "DYLD_LIBRARY_PATH": true,
		"GIT_SSH_COMMAND": true, "SSH_AUTH_SOCK": true,
		"PROXY": true, "HTTP_PROXY": true, "HTTPS_PROXY": true,
		"ALL_PROXY": true, "NO_PROXY": true,
	}
	var out []string
	for _, e := range base {
		key := e
		if i := strings.IndexByte(e, '='); i >= 0 {
			key = e[:i]
		}
		if drop[strings.ToUpper(key)] {
			continue
		}
		out = append(out, e)
	}
	out = append(out, "TERM=xterm-256color")
	out = append(out, extra...)
	return out
}

// ---------------------------------------------------------------------------
// startSandboxedShell — the production entry point (Phase 2 wires this into
// terminalServer). It resolves/creates the keeper for the config's layout,
// opens a pty pair, and asks the keeper to fork a shell child into its
// namespace attached to that pty.
// ---------------------------------------------------------------------------

// startSandboxedShell creates (or joins) a sandbox instance for cfg, opens a
// pty, and spawns a shell inside the instance's namespace attached to the pty.
// ownerLabel identifies this owner (e.g. "session:<id>" or "terminal:<tab>").
func startSandboxedShell(cfg *SandboxConfig, ownerLabel string) (*SandboxHandle, error) {
	probe := probeSandbox()
	if !probe.Available {
		return nil, &ErrSandboxUnavailable{Reason: probe.Reason}
	}

	if cfg.Shell == "" {
		cfg.Shell = "/bin/bash"
	}
	if len(cfg.ReadOnlyRoots) == 0 {
		cfg.ReadOnlyRoots = defaultRORoots()
	}
	if len(cfg.Roots) == 0 {
		return nil, &ErrSandboxUnavailable{Reason: "no roots specified"}
	}
	// Default flags: UTS + IPC on (isolation with no downside). PID + NET stay
	// off unless the caller opts in (host process view + working network/git).
	cfg.Flags.UTS = true
	cfg.Flags.IPC = true

	inst, err := getOrCreateInstance(cfg, probe.Method)
	if err != nil {
		return nil, err
	}
	addOwner(inst, ownerLabel)

	// Open a pty pair. The slave is CLOEXEC (creack/pty), so pass it BY NAME;
	// the keeper re-opens it in the join-child (native) or bwrap execs it
	// directly (bwrap fallback).
	h, err := spawnShellIn(inst, cfg.Cwd, cfg.Env, probe.Method)
	if err != nil {
		return nil, err
	}
	h.ID = inst.id
	h.Owners = instanceOwners(inst)
	h.Shared = len(h.Owners) > 1
	return h, nil
}

// spawnShellIn opens a fresh pty pair and asks the instance's keeper to fork a
// shell child into the instance's namespace attached to the slave. The returned
// handle carries the pty master (for read/write/resize) and the child pid (for
// kill). The caller sets the handle's ID/Owners/Shared/Method.
func spawnShellIn(inst *SandboxInstance, cwd string, extraEnv []string, method string) (*SandboxHandle, error) {
	master, slave, err := pty.Open()
	if err != nil {
		return nil, fmt.Errorf("open pty: %w", err)
	}
	defer slave.Close()

	var pid int
	if method == "bwrap" {
		// bwrap fallback: no keeper. Spawn a per-shell bwrap process that uses
		// the pty slave as its stdio and execs the shell inside the layout.
		var berr error
		pid, berr = spawnBwrapShell(inst, slave, cwd, scrubEnv(os.Environ(), extraEnv))
		if berr != nil {
			master.Close()
			return nil, berr
		}
	} else {
		// native: the slave is CLOEXEC (creack/pty), so pass it BY NAME; the
		// keeper re-opens it in the join-child.
		slaveName, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", int(slave.Fd())))
		if err != nil {
			master.Close()
			return nil, fmt.Errorf("readlink slave: %w", err)
		}
		// Ask the keeper to fork a shell child into its ns.
		var serr error
		pid, serr = requestSpawn(inst, slaveName, cwd, scrubEnv(os.Environ(), extraEnv))
		if serr != nil {
			master.Close()
			return nil, serr
		}
	}

	return &SandboxHandle{
		Master: master,
		Resize: func(cols, rows int) {
			pty.Setsize(master, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
		},
		Kill: func() {
			if pid > 0 {
				unix.Kill(pid, unix.SIGKILL)
			}
		},
		Pid:    pid,
		Method: method,
		Roots:  inst.cfg.Roots,
	}, nil
}

// findInstanceByOwner returns the live instance that has owner as a co-owner
// (e.g. an agent session's instance), or nil if none.
func findInstanceByOwner(owner string) *SandboxInstance {
	if owner == "" {
		return nil
	}
	sandboxManager.mu.Lock()
	defer sandboxManager.mu.Unlock()
	for _, inst := range sandboxManager.instances {
		if inst.owners[owner] {
			inst.lastUse = time.Now()
			return inst
		}
	}
	return nil
}

// attachToOwner is the "user terminal attaches to an agent session's sandbox"
// path. It locates the instance that targetOwner (the agent's label, e.g.
// "session:agent_123") is a co-owner of and spawns the user's shell INSIDE
// that instance's namespace — so the user sees exactly the agent's workspace
// (same file view, same in-ns processes). This tab's label (myOwner) is added
// as a co-owner. If the target owner has not yet created an instance, one is
// created from cfg's layout (roots/cwd) so the attach still succeeds and the
// user + agent share it once the agent's first command lands on the same
// layout. Returns nil when the sandbox is unavailable.
func attachToOwner(cfg *SandboxConfig, targetOwner, myOwner string) *SandboxHandle {
	probe := probeSandbox()
	if !probe.Available {
		return nil
	}

	// Prefer the target owner's live instance (exact shared layout).
	inst := findInstanceByOwner(targetOwner)
	if inst == nil {
		// Fall back to creating from the requested layout.
		if cfg.Shell == "" {
			cfg.Shell = "/bin/bash"
		}
		if len(cfg.ReadOnlyRoots) == 0 {
			cfg.ReadOnlyRoots = defaultRORoots()
		}
		if len(cfg.Roots) == 0 {
			return nil
		}
		cfg.Flags.UTS = true
		cfg.Flags.IPC = true
		var err error
		inst, err = getOrCreateInstance(cfg, probe.Method)
		if err != nil {
			return nil
		}
	}

	addOwner(inst, myOwner)
	if targetOwner != "" {
		addOwner(inst, targetOwner)
	}

	// Spawn the user's shell inside the instance's namespace.
	h, err := spawnShellIn(inst, inst.cfg.Cwd, nil, probe.Method)
	if err != nil {
		return nil
	}
	h.ID = inst.id
	h.Owners = instanceOwners(inst)
	h.Shared = len(h.Owners) > 1
	return h
}

// getOrCreateInstance returns the live instance for cfg's layout. For the
// native method it creates the persistent keeper; for the bwrap method there is
// no keeper (each shell is its own bwrap process) so the instance is a pure
// registry entry tracking owners.
func getOrCreateInstance(cfg *SandboxConfig, method string) (*SandboxInstance, error) {
	fp := fingerprint(cfg)
	sandboxManager.mu.Lock()
	defer sandboxManager.mu.Unlock()

	if inst, ok := sandboxManager.instances[fp]; ok {
		inst.lastUse = time.Now()
		return inst, nil
	}

	inst := &SandboxInstance{
		id:          fp,
		fingerprint: fp,
		cfg:         cfg,
		owners:      map[string]bool{},
		lastUse:     time.Now(),
		bwrapPids:   map[int]bool{},
	}
	if method != "bwrap" {
		keeper, socketPath, err := spawnKeeper(cfg, fp)
		if err != nil {
			return nil, err
		}
		inst.keeperPid = keeper
		inst.socketPath = socketPath
	}
	sandboxManager.instances[fp] = inst
	return inst, nil
}

// spawnKeeper forks a single-threaded child that unshares into a fresh
// user+mount namespace, applies the bind-mount layout, and execs the keeper
// (reexec of this binary in --sandbox-keeper mode). Returns the *exec.Cmd
// (for the parent to track) and the keeper's IPC socket path.
func spawnKeeper(cfg *SandboxConfig, id string) (int, string, error) {
	// Build a private socket dir for the keeper's IPC.
	dir, err := os.MkdirTemp("", "cadence-sbx-")
	if err != nil {
		return 0, "", err
	}
	socketPath := dir + "/keeper.sock"

	// The keeper is a reexec; pass the layout via env (JSON). Env survives
	// reexec; Go globals do not. In production the target is the running
	// executable (/proc/self/exe); tests may override via
	// CADENCE_SANDBOX_REEXEC to point at a real server binary (the test
	// harness binary cannot run the keeper — its main is the test framework).
	cfgJSON, _ := json.Marshal(cfg)
	exe := os.Getenv("CADENCE_SANDBOX_REEXEC")
	if exe == "" {
		if self, err := os.Executable(); err == nil {
			exe = self
		} else {
			exe = "/proc/self/exe"
		}
	}
	argv := []string{exe, "--sandbox-keeper", id, socketPath}
	env := []string{
		"TERM=xterm-256color",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"SBX_CONFIG=" + string(cfgJSON),
	}

	// Precompute the child's raw-syscall payload (parent allocates).
	uid := os.Getuid()
	gid := os.Getgid()
	rawUIDMapStr = fmt.Sprintf("0 %d 1\n", uid)
	rawGIDMapStr = fmt.Sprintf("0 %d 1\n", gid)
	rawMountRoots = cfg.Roots
	rawMountRO = cfg.ReadOnlyRoots
	mask := uintptr(syscall.CLONE_NEWUSER | syscall.CLONE_NEWNS)
	if cfg.Flags.UTS {
		mask |= syscall.CLONE_NEWUTS
	}
	if cfg.Flags.IPC {
		mask |= syscall.CLONE_NEWIPC
	}
	rawNSMask = mask
	rawKargv0, rawKargv, rawKenvv = buildExecveStructures(argv, env)
	rawStderrPath = dir + "/keeper.err"
	// Precompute step-marker bytes (the child must not allocate).
	stepBytes := make([]byte, 24)
	for i := range stepBytes {
		stepBytes[i] = byte('a' + i)
	}
	rawStepPtrs = make([]unsafe.Pointer, len(stepBytes))
	for i := range stepBytes {
		rawStepPtrs[i] = unsafe.Pointer(&stepBytes[i])
	}

	// Precompute the pivot_root layout (parent allocates; the child must not
	// allocate). newroot lives inside the socket dir; oldroot (newroot/oldroot)
	// is where the host / gets bind-mounted. The target dirs (ro passthroughs +
	// rw roots + the socket dir + the binary's dir) must exist in newroot
	// BEFORE the pivot (the new root is empty after pivot). The binary's dir
	// is bound so the keeper can exec itself after the pivot.
	rawNewRoot = dir + "/newroot"
	rawOldRoot = rawNewRoot + "/oldroot"
	rawSocketDir = dir
	// The keeper binary's dir (so it can exec itself after the pivot). If the
	// binary lives at / itself, we cannot bind / onto / (that would defeat
	// the hiding) â the keeper's exec would fail and the parent surfaces it.
	binDir := filepath.Dir(exe)
	if binDir == "/" {
		binDir = ""
	}
	rawBinDir = binDir
	// CRITICAL: the new root (newroot) is an EMPTY dir after the pivot, so
	// every bind DESTINATION must pre-exist INSIDE newroot. After the pivot,
	// the new-root path <P> (absolute) corresponds to newroot<P> on the host,
	// so we mkdir newroot<P> on the host BEFORE the pivot. Targets: the ro
	// passthroughs, the rw roots, the socket dir, the binary's dir, plus
	// /dev, /proc, /tmp. (mkdir -p of each newroot-relative path; EEXIST is
	// fine.) All targets are prefixed with newroot so the mkdirs happen on
	// the host side, inside newroot, NOT on the host's real paths.
	var mkdirTargets []string
	if binDir != "" {
		mkdirTargets = append(mkdirTargets, rawNewRoot+binDir)
	}
	mkdirTargets = append(mkdirTargets,
		rawOldRoot, rawNewRoot+"/dev", rawNewRoot+"/proc", rawNewRoot+"/tmp",
	)
	for _, p := range cfg.ReadOnlyRoots {
		mkdirTargets = append(mkdirTargets, rawNewRoot+p)
	}
	for _, p := range cfg.Roots {
		mkdirTargets = append(mkdirTargets, rawNewRoot+p)
	}
	mkdirTargets = append(mkdirTargets, rawNewRoot+dir)
	rawMkdirPathsList = expandMkdirAll(mkdirTargets)

	// Pre-warm the strPtr cache for the string literals rawDetachOldRoot uses
	// in the child (it parses /proc/self/mountinfo and detaches /oldroot*).
	// Warming here (parent) means the child gets cache HITS (no allocation),
	// matching the precompute-in-parent convention.
	strPtr("/proc/self/mountinfo")
	strPtr("/oldroot")

	pid, err := rawFork()
	if err != nil {
		return 0, "", fmt.Errorf("fork keeper: %w", err)
	}
	if pid == 0 {
		// CHILD (single-threaded, raw syscalls only):
		// 0. Redirect stderr to a trace file so a failing keeper leaves a trace.
		//    rawTraceFd is the OPEN fd used for per-step markers (mk/traceInt).
		//    We dup it onto fd 2 (so a runtime panic is ALSO captured in the
		//    trace) but do NOT close the source fd â
		//    rawTraceFd dangling and every trace write would silently no-op, so
		//    a failing keeper would leave a 0-byte trace (the very bug this
		//    fixes). The child inherits the parent's fd table (plain
		//    clone), so the newly-opened fd is the lowest available slot; its
		//    exact number is irrelevant because we write through rawTraceFd
		//    directly.
		if rawStderrPath != "" {
			if f2, _, pe := syscall.RawSyscall6(syscall.SYS_OPEN, strPtr(rawStderrPath), 0x441 /*O_WRONLY|O_CREAT|O_APPEND*/, 0644, 0, 0, 0); pe == 0 {
				rawTraceFd = int(f2)
				syscall.RawSyscall(syscall.SYS_DUP2, f2, 2, 0)
			}
		}
		mk(1)
		// 1. unshare the requested namespaces.
		if _, _, e := syscall.RawSyscall(syscall.SYS_UNSHARE, rawNSMask, 0, 0); e != 0 {
			syscall.RawSyscall(syscall.SYS_EXIT, 1, 0, 0)
		}
		// 2. Map uid/gid (0 -> self) and deny setgroups.
		writeMapFile("/proc/self/uid_map", rawUIDMapStr)
		writeMapFile("/proc/self/setgroups", rawDenyStr)
		writeMapFile("/proc/self/gid_map", rawGIDMapStr)
		mk(2)
		// 3. Make / private (so our mounts don't propagate to the host).
		//    src="" (NULL) + dir="/": a flag-only reconfigure of the root mount.
		syscall.RawSyscall6(syscall.SYS_MOUNT, 0, strPtr("/"), 0, uintptr(syscall.MS_REC|syscall.MS_PRIVATE), 0, 0)
		mk(3)
		// 4. Build the new root (inside the socket dir) and pivot_root to it.
		//    This HIDES the host filesystem: after the pivot, / is an empty
		//    dir and the host / is only reachable via /oldroot (which we
		//    unmount at the end). Without this, the user could navigate to the
		//    real / (e.g. ls /home, cat /etc/shadow). Sequence (empirically
		//    validated unprivileged in scratch/sandbox_poc/pivot5):
		//    a. mkdir newroot + newroot/oldroot + all target dirs (the new root
		//       is empty after the pivot, so targets must pre-exist).
		//    b. bind host / -> newroot/oldroot (the host fs, for re-binding).
		//    c. bind newroot -> newroot (pivot requires a mountpoint).
		//    d. pivot_root(newroot, newroot/oldroot); chdir /.
		//    e. bind /oldroot/<dir> back onto the new root: ro system
		//       passthroughs + rw project roots + the socket dir.
		//    f. umount /oldroot (MNT_DETACH) — the host fs is now hidden.
		rawMkdirPaths(rawMkdirPathsList)
		mk(7)
		syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr("/"), strPtr(rawOldRoot), 0, uintptr(syscall.MS_BIND|syscall.MS_REC), 0, 0)
		mk(8)
		syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr(rawNewRoot), strPtr(rawNewRoot), 0, uintptr(syscall.MS_BIND|syscall.MS_REC), 0, 0)
		mk(9)
		syscall.RawSyscall6(syscall.SYS_PIVOT_ROOT, strPtr(rawNewRoot), strPtr(rawOldRoot), 0, 0, 0, 0)
		mk(10)
		syscall.RawSyscall(syscall.SYS_CHDIR, strPtr("/"), 0, 0)
		mk(11)
		// 4b. Bind-mount rw roots at their real paths (writable).
		for _, r := range rawMountRoots {
			syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr("/oldroot"+r), strPtr(r), 0, uintptr(syscall.MS_BIND|syscall.MS_REC), 0, 0)
		}
		mk(12)
		// 5. Bind-mount ro passthroughs read-only.
		for _, r := range rawMountRO {
			syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr("/oldroot"+r), strPtr(r), 0, uintptr(syscall.MS_BIND|syscall.MS_REC|syscall.MS_RDONLY), 0, 0)
		}
		mk(13)
		// 5b. Bind the socket dir (keeper IPC + keeper.err trace) at its real
		//     path so the parent can reach the keeper's socket.
		syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr("/oldroot"+rawSocketDir), strPtr(rawSocketDir), 0, uintptr(syscall.MS_BIND|syscall.MS_REC), 0, 0)
		mk(14)
		// 5c. Bind /dev (rw â the pty needs /dev/pts + /dev/tty) and the
		//     binary's dir (so the keeper can exec itself after the pivot).
		syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr("/oldroot/dev"), strPtr("/dev"), 0, uintptr(syscall.MS_BIND|syscall.MS_REC), 0, 0)
		mk(15)
		if rawBinDir != "" && rawBinDir != "/" {
			syscall.RawSyscall6(syscall.SYS_MOUNT, strPtr("/oldroot"+rawBinDir), strPtr(rawBinDir), 0, uintptr(syscall.MS_BIND|syscall.MS_REC), 0, 0)
		}
		mk(16)
		// 5d. Hide the host fs: detach EVERY /oldroot* mount (deepest-first),
		//     not just the top of the stack. A single umount2("/oldroot") left
		//     the pivot-relocated old root + all /oldroot/* submounts in place
		//     (so `ls /oldroot` = host /). rawDetachOldRoot parses
		//     /proc/self/mountinfo and detaches them all with the correct
		//     MNT_DETACH flag (0x2), then rmdirs the leftover /oldroot dir.
		detached := rawDetachOldRoot()
		traceInt(detached)
		mk(17)
		// 6. Die if the parent (server) dies â no orphaned keeper.
		//    PR_SET_PDEATHSIG persists across exec.
		syscall.RawSyscall6(syscall.SYS_PRCTL, 1 /*PR_SET_PDEATHSIG*/, 9 /*SIGKILL*/, 0, 0, 0, 0)
		mk(18)
		// 7. Exec the keeper (ns inherited across exec). Raw execve, no alloc.
		syscall.RawSyscall6(syscall.SYS_EXECVE,
			uintptr(unsafe.Pointer(rawKargv0)),
			uintptr(rawKargv),
			uintptr(rawKenvv), 0, 0, 0)
		syscall.RawSyscall(syscall.SYS_EXIT, 1, 0, 0) // not reached
	}

	// PARENT: wait for the keeper to bind its socket (it is a reexec; needs a
	// moment to reach Listen). If the keeper process dies first, surface that
	// (it means unshare/mount/exec failed in the child).
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(socketPath); err == nil {
			break
		}
		// Detect a dead keeper so we fail fast with a real cause.
		var ws unix.WaitStatus
		n, werr := unix.Wait4(pid, &ws, unix.WNOHANG, nil)
		if n == pid {
			detail := keeperErrDetail(dir)
			os.RemoveAll(dir)
			return 0, "", fmt.Errorf("keeper exited before binding socket (status=%d) %s", ws.ExitStatus(), detail)
		}
		if werr != nil && werr != syscall.EINTR {
			return 0, "", fmt.Errorf("wait4 keeper: %w", werr)
		}
		if time.Now().After(deadline) {
			detail := keeperErrDetail(dir)
			os.RemoveAll(dir)
			return 0, "", fmt.Errorf("keeper socket %s never appeared (timed out) %s", socketPath, detail)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return pid, socketPath, nil
}

// keeperErrDetail reads the keeper's stderr trace (if any) for diagnostics.
func keeperErrDetail(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, "keeper.err"))
	if err != nil || len(b) == 0 {
		return ""
	}
	return "stderr: " + strings.TrimSpace(string(b))
}

// addOwner adds an owner to the instance (refcount).
func addOwner(inst *SandboxInstance, owner string) {
	sandboxManager.mu.Lock()
	defer sandboxManager.mu.Unlock()
	inst.owners[owner] = true
	inst.lastUse = time.Now()
}

// removeOwner removes an owner; reaps the instance when the last owner leaves.
func removeOwner(inst *SandboxInstance, owner string) {
	sandboxManager.mu.Lock()
	if !inst.owners[owner] {
		sandboxManager.mu.Unlock()
		return
	}
	delete(inst.owners, owner)
	empty := len(inst.owners) == 0
	sandboxManager.mu.Unlock()
	if empty {
		reapInstance(inst)
	}
}

// releaseOwner removes `owner` from its instance (if it has one).
func releaseOwner(owner string) {
	if inst := findInstanceByOwner(owner); inst != nil {
		removeOwner(inst, owner)
	}
}

// sandboxStatus builds the /api/sandbox payload: the capability probe result
// plus a snapshot of the live sandbox instances (for the UI to list attachable
// agent sandboxes and show a capability indicator).
func sandboxStatus() *SandboxStatusResponse {
	probe := probeSandbox()
	resp := &SandboxStatusResponse{
		Available: probe.Available,
		Method:    probe.Method,
		Reason:    probe.Reason,
		Instances: []SandboxInstanceInfo{},
	}

	sandboxManager.mu.Lock()
	for _, inst := range sandboxManager.instances {
		owners := make([]string, 0, len(inst.owners))
		for o := range inst.owners {
			owners = append(owners, o)
		}
		sort.Strings(owners)
		info := SandboxInstanceInfo{
			ID:     inst.id,
			Roots:  inst.cfg.Roots,
			Owners: owners,
			Shared: len(inst.owners) > 1,
		}
		resp.Instances = append(resp.Instances, info)
	}
	sandboxManager.mu.Unlock()
	return resp
}

func instanceOwners(inst *SandboxInstance) []string {
	sandboxManager.mu.Lock()
	defer sandboxManager.mu.Unlock()
	out := make([]string, 0, len(inst.owners))
	for o := range inst.owners {
		out = append(out, o)
	}
	sort.Strings(out)
	return out
}

// reapInstance kills the keeper and removes the instance from the registry.
func reapInstance(inst *SandboxInstance) {
	sandboxManager.mu.Lock()
	if _, ok := sandboxManager.instances[inst.id]; !ok {
		sandboxManager.mu.Unlock()
		return
	}
	delete(sandboxManager.instances, inst.id)
	sandboxManager.mu.Unlock()

	if inst.keeperPid > 0 {
		unix.Kill(inst.keeperPid, unix.SIGKILL)
	}
	// bwrap instances: kill any live per-shell bwrap children.
	sandboxManager.mu.Lock()
	for pid := range inst.bwrapPids {
		unix.Kill(pid, unix.SIGKILL)
	}
	sandboxManager.mu.Unlock()
	if inst.socketPath != "" {
		os.RemoveAll(filepath.Dir(inst.socketPath))
	}
}

// ---------------------------------------------------------------------------
// Keeper IPC: requestSpawn asks the keeper to fork a shell child into its
// namespace attached to a pty slave (by name). The keeper replies with the
// child's pid.
// ---------------------------------------------------------------------------

// requestSpawn connects to the keeper's socket, sends a spawn request, and
// returns the spawned shell's pid.
func requestSpawn(inst *SandboxInstance, slaveName, cwd string, env []string) (int, error) {
	req := map[string]interface{}{
		"slave": slaveName,
		"cwd":   cwd,
		"env":   env,
	}
	b, _ := json.Marshal(req)

	// The keeper is a reexec; it needs a moment to reach Listen. Retry the
	// connect for up to ~5s.
	var conn net.Conn
	var err error
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err = net.Dial("unix", inst.socketPath)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("connect keeper (timed out): %w", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer conn.Close()

	if _, err := conn.Write(b); err != nil {
		return 0, fmt.Errorf("write keeper: %w", err)
	}
	// Read the reply: a single int (pid) as a decimal string.
	buf := make([]byte, 32)
	n, err := conn.Read(buf)
	if err != nil {
		return 0, fmt.Errorf("read keeper reply: %w", err)
	}
	var pid int
	fmt.Sscanf(string(buf[:n]), "%d", &pid)
	return pid, nil
}

// spawnBwrapShell runs bwrap (per-shell, no persistent keeper) attached to the
// given pty slave. bwrap's --new-session makes the shell a new session leader
// so it can adopt the pty as its controlling terminal. Returns the bwrap pid.
func spawnBwrapShell(inst *SandboxInstance, slave *os.File, cwd string, env []string) (int, error) {
	bwrapPath, ok := lookPathBwrap()
	if !ok {
		return 0, &ErrSandboxUnavailable{Reason: "bwrap not found on PATH"}
	}
	argv := bwrapArgv(inst.cfg)
	// argv[0] is the bare "bwrap"; exec the resolved PATH entry instead.
	cmd := exec.Command(bwrapPath, argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start bwrap: %w", err)
	}
	// Track the pid so the instance reap can kill it.
	sandboxManager.mu.Lock()
	inst.bwrapPids[cmd.Process.Pid] = true
	sandboxManager.mu.Unlock()
	go func() {
		cmd.Wait()
		sandboxManager.mu.Lock()
		delete(inst.bwrapPids, cmd.Process.Pid)
		sandboxManager.mu.Unlock()
	}()
	return cmd.Process.Pid, nil
}

// sandboxKeeperEntry is called from main() before flag parsing. If this
// process was reexeced as a sandbox keeper (--sandbox-keeper <id> <socket>),
// it runs the keeper loop and never returns. Returns true in that case.
func sandboxKeeperEntry() bool {
	if len(os.Args) >= 4 && os.Args[1] == "--sandbox-keeper" {
		runSandboxKeeper(os.Args[2], os.Args[3])
		os.Exit(0) // runSandboxKeeper only returns on socket error
	}
	return false
}

// runSandboxKeeper runs in --sandbox-keeper mode (a reexec of this binary).
// It is already inside the sandboxed namespace (inherited from the child that
// unshared). It listens on the IPC socket and, for each spawn request, forks a
// shell child into its namespace attached to the requested pty slave.
func runSandboxKeeper(id, socketPath string) {
	cfgJSON := os.Getenv("SBX_CONFIG")
	var cfg SandboxConfig
	if err := json.Unmarshal([]byte(cfgJSON), &cfg); err != nil {
		fmt.Fprintf(os.Stderr, "keeper: bad SBX_CONFIG: %v\n", err)
		os.Exit(1)
	}
	if cfg.Shell == "" {
		cfg.Shell = "/bin/bash"
	}

	// Reaper: join-children are this keeper's children. Reap them so they don't
	// accumulate as zombies. (The keeper is a fresh Go process — x/sys/unix is
	// safe here; only the single-threaded clone children must avoid it.)
	// A child's death is signalled by wait4 returning its pid; we loop to catch
	// siblings. When there are NO live children wait4 returns ECHILD immediately
	// (wpid==0) instead of blocking â so we sleep to avoid a 100% busy-spin on an
	// idle keeper. The sleep only delays zombie reaping by the window (the pty
	// master's EOF, not this reaper, is what signals shell exit to the parent).
	go func() {
		for {
			var ws unix.WaitStatus
			wpid, err := unix.Wait4(-1, &ws, 0, nil)
			if wpid > 0 {
				continue // reaped a child; loop to catch siblings
			}
			if err == syscall.EINTR {
				continue // interrupted; retry immediately
			}
			// wpid == 0 (ECHILD: no children) or other error â back off so an
			// idle keeper doesn't spin the CPU. A newly spawned child is reaped
			// within the window.
			time.Sleep(200 * time.Millisecond)
		}
	}()

	// Listen for spawn requests.
	os.Remove(socketPath)
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "keeper: listen %s: %v\n", socketPath, err)
		os.Exit(1)
	}
	defer ln.Close()

	for {
		conn, err := ln.Accept()
		if err != nil {
			break
		}
		go handleSpawn(conn, cfg)
	}
}

// handleSpawn reads a spawn request, forks a shell child into the keeper's
// namespace attached to the requested pty slave, and replies with the child's
// pid.
func handleSpawn(conn net.Conn, cfg SandboxConfig) {
	defer conn.Close()
	buf := make([]byte, 65536)
	n, err := conn.Read(buf)
	if err != nil || n == 0 {
		return
	}
	var req struct {
		Slave string
		Cwd   string
		Env   []string
	}
	if err := json.Unmarshal(buf[:n], &req); err != nil {
		conn.Write([]byte("0"))
		return
	}

	// Re-open the pty slave by name (the caller's slave fd is CLOEXEC).
	slaveFd, err := unix.Open(req.Slave, os.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		conn.Write([]byte("0"))
		return
	}

	// Precompute the join-child's raw payload (parent-side alloc).
	argv := []string{cfg.Shell}
	gJoinArgv0, gJoinArgv, gJoinEnvv = buildExecveStructures(argv, req.Env)
	gJoinSlaveFd = slaveFd
	gJoinCwd = req.Cwd

	pid, err := rawFork()
	if err != nil {
		unix.Close(slaveFd)
		conn.Write([]byte("0"))
		return
	}
	if pid == 0 {
		// JOIN CHILD (single-threaded, raw syscalls only): attach to the pty
		// as controlling terminal, dup2 stdio, exec the shell.
		// Die if the keeper (our parent) dies — no orphaned shells.
		syscall.RawSyscall6(syscall.SYS_PRCTL, 1 /*PR_SET_PDEATHSIG*/, 9 /*SIGKILL*/, 0, 0, 0, 0)
		syscall.RawSyscall(syscall.SYS_SETSID, 0, 0, 0)
		syscall.RawSyscall6(syscall.SYS_IOCTL, uintptr(gJoinSlaveFd), 0x540E /*TIOCSCTTY*/, 0, 0, 0, 0)
		syscall.RawSyscall(syscall.SYS_DUP2, uintptr(gJoinSlaveFd), 0, 0)
		syscall.RawSyscall(syscall.SYS_DUP2, uintptr(gJoinSlaveFd), 1, 0)
		syscall.RawSyscall(syscall.SYS_DUP2, uintptr(gJoinSlaveFd), 2, 0)
		// chdir to cwd (best-effort).
		if gJoinCwd != "" {
			syscall.RawSyscall6(syscall.SYS_CHDIR, strPtr(gJoinCwd), 0, 0, 0, 0, 0)
		}
		syscall.RawSyscall6(syscall.SYS_EXECVE,
			uintptr(unsafe.Pointer(gJoinArgv0)),
			uintptr(gJoinArgv),
			uintptr(gJoinEnvv), 0, 0, 0)
		syscall.RawSyscall(syscall.SYS_EXIT, 127, 0, 0) // exec failed
	}

	// PARENT (keeper): close our copy of the slave fd. The child dup2'd it to
	// 0/1/2 (CLOEXEC), so the child keeps its own reference; dropping ours is
	// what lets the caller's pty master see EOF when the shell exits. Without
	// this close, the master never EOFs and the /terminal WS stays open
	// forever (run_command hangs after the command completes).
	unix.Close(slaveFd)
	// Reply with the child's pid.
	conn.Write([]byte(fmt.Sprintf("%d", pid)))
}
