//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// buildServerOnce builds the real server binary (the test harness binary cannot
// run the keeper — its main is the Go test framework). The keeper is a reexec
// of this binary in --sandbox-keeper mode.
var (
	buildServerOnce sync.Once
	serverBin       string
)

func buildServer(t *testing.T) string {
	t.Helper()
	buildServerOnce.Do(func() {
		// Build the keeper re-exec binary under the user's home, NOT /tmp:
		// the sandbox AppArmor profile grants exec (ix) on tool dirs +
		// @{HOME} (=/home/*), so a keeper binary in /tmp would be exec-denied
		// under the hardened profile and startSandboxedShell would fail.
		base := os.TempDir()
		if home, err := os.UserHomeDir(); err == nil {
			base = home
		}
		bin, err := os.MkdirTemp(base, "cadence-sbx-srv-")
		if err != nil {
			t.Fatalf("mkdtemp: %v", err)
		}
		bin = filepath.Join(bin, "cadence-server")
		cmd := exec.Command("go", "build", "-o", bin, ".")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("go build server for keeper reexec: %v\n%s", err, out)
		}
		serverBin = bin
		os.Setenv("CADENCE_SANDBOX_REEXEC", bin)
	})
	return serverBin
}

// TestProbe verifies the capability probe returns a well-formed result.
func TestProbe(t *testing.T) {
	p := probeSandbox()
	if p.Method == "" {
		t.Fatalf("probe returned empty method")
	}
	t.Logf("probe: available=%v method=%s reason=%s", p.Available, p.Method, p.Reason)
}

// runInSandboxShell runs a command in the sandbox shell and verifies the marker
// file it writes appears on the HOST with the expected content (proving the
// bind-mount is real + writable). The command runs in a subshell (bash -c), so
// any `exit` inside it only terminates the subshell — the interactive shell
// persists for further commands.
func runInSandboxShell(t *testing.T, h *SandboxHandle, root, cmd, markerPath, want string) {
	t.Helper()
	h.Master.Write([]byte("bash -c '" + cmd + "'\n"))
	time.Sleep(2 * time.Second)
	got, err := os.ReadFile(filepath.Join(root, markerPath))
	if err != nil {
		t.Fatalf("marker %s not visible on host (bind-mount rw failed): %v", markerPath, err)
	}
	if !strings.Contains(string(got), want) {
		t.Fatalf("marker %s content wrong: %q", markerPath, string(got))
	}
	t.Logf("in-ns write visible on host: %s=%q", markerPath, string(got))
}

// TestNativeSandboxEndToEnd spawns a sandboxed shell with a temp root, runs
// commands in-namespace, and verifies: (a) an in-ns write appears on the host
// (bind-mount is real + writable), (b) the host filesystem is HIDDEN (the
// user cannot navigate to the real /), and (c) the shell exits cleanly (pty
// master EOFs — the WS would close on exit).
func TestNativeSandboxEndToEnd(t *testing.T) {
	p := probeSandbox()
	if !p.Available || p.Method != "native" {
		t.Skipf("native sandbox unavailable: %s", p.Reason)
	}
	buildServer(t)

	// Temp root that will be bind-mounted rw into the namespace.
	root, err := os.MkdirTemp("", "sbxtest-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	defer os.RemoveAll(root)
	if err := os.WriteFile(filepath.Join(root, "seed.txt"), []byte("seed"), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// A marker on the HOST (under the real home dir) that must be invisible
	// from inside the namespace: /home is NOT in the ro passthroughs and NOT
	// in the roots, so it is hidden after the pivot. (Note: /etc IS an
	// intentional ro passthrough, so a marker there would be visible.)
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}
	if _, err := os.Stat("/home"); err != nil {
		t.Skipf("host has no /home dir; cannot assert it is hidden: %v", err)
	}
	hiddenMarker := filepath.Join(homeDir, "sbxhostmarker")
	if err := os.WriteFile(hiddenMarker, []byte("host-secret"), 0644); err != nil {
		t.Skipf("cannot write host marker: %v", err)
	}
	defer os.Remove(hiddenMarker)

	cfg := &SandboxConfig{
		Roots: []string{root},
		Cwd:   root,
		Env:   []string{"HOME=" + root},
	}
	h, err := startSandboxedShell(cfg, "test:probe")
	if err != nil {
		t.Fatalf("startSandboxedShell: %v", err)
	}
	defer h.Kill()
	t.Logf("sandbox id=%s method=%s pid=%d", h.ID, h.Method, h.Pid)

	// Give the shell a moment to attach to the pty.
	time.Sleep(500 * time.Millisecond)

	// (a) The bind-mount is real and writable.
	runInSandboxShell(t, h, root, "echo hello-from-ns > marker.txt && cat seed.txt > seedout.txt", "marker.txt", "hello-from-ns")

	// (b) The host filesystem is hidden: the host marker is absent, /home is
	// not reachable, and /dev/pts exists (needed for the pty).
	runInSandboxShell(t, h, root,
		"(test ! -e "+hiddenMarker+" && echo hidden-ok > hidden.txt || echo hidden-FAIL > hidden.txt); "+
			"(test ! -e /home && echo nohome-ok > nohome.txt || echo nohome-FAIL > nohome.txt); "+
			"(test -d /dev/pts && echo devpts-ok > devpts.txt || echo devpts-FAIL > devpts.txt)",
		"hidden.txt", "hidden-ok")
	for _, f := range []string{"nohome.txt", "devpts.txt"} {
		got, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			t.Fatalf("marker %s not visible on host: %v", f, err)
		}
		if !strings.Contains(string(got), "-ok") {
			t.Fatalf("host fs NOT hidden (%s=%q) — the user could reach the real /", f, string(got))
		}
		t.Logf("host fs hidden: %s=%q", f, string(got))
	}

	// (b2) The host-fs backdoors are CLOSED. Two leaks must be detached:
	//   1. the pivot-relocated old root (/oldroot) and all /oldroot/* submounts
	//      (a single umount2("/oldroot") leaves them in place, so `ls /oldroot`
	//      = host / and the user could navigate to the real host fs, e.g.
	//      cat /oldroot/etc/shadow).
	//   2. the pre-pivot STAGING bind .../newroot/oldroot — the temp dir under
	//      /tmp/cadence-sbx-*/newroot used as pivot_root's oldroot target. It
	//      is ALSO a full host-/ bind, so it is a second host-fs backdoor that
	//      survives the /oldroot detaches.
	// The authoritative check is that /proc/self/mountinfo has ZERO entries
	// whose mountpoint is /oldroot or /oldroot/<...> OR contains the
	// /newroot/oldroot segment (the staging bind). We also assert the
	// relocated host fs is not reachable through /oldroot (no /oldroot/etc)
	// and that the rw root bind is still writable.
	// NOTE: runInSandboxShell wraps cmd in bash -c '<cmd>' (single quotes), so
	// the command must contain NO single quotes. The awk below counts
	// mountinfo entries whose field 5 (mount_point) is /oldroot, /oldroot/<...>,
	// or contains /newroot/oldroot, and writes the marker itself (no shell
	// variable â the inner bash would expand $n at parse time, before the
	// assignment runs). The \$5 is backslash-escaped so the inner bash passes
	// a literal $5 to awk (an unescaped $5 would be an empty positional param).
	runInSandboxShell(t, h, root,
		"awk \"\\$5==\\\"/oldroot\\\"||\\$5~/^\\/oldroot\\//||\\$5~/\\/newroot\\/oldroot/{c++}END{if(c+0==0) print \\\"oldroot-ok\\\" > \\\"oldroot.txt\\\"; else print \\\"oldroot-FAIL:\\\" c > \\\"oldroot.txt\\\"}\" /proc/self/mountinfo; "+
			"(test ! -d /oldroot/etc && echo oretc-ok > oretc.txt || echo oretc-FAIL > oretc.txt); "+
			"echo post-fix > postfix.txt",
		"oldroot.txt", "oldroot-ok")
	got, err := os.ReadFile(filepath.Join(root, "oldroot.txt"))
	if err != nil {
		t.Fatalf("oldroot marker not visible on host: %v", err)
	}
	if !strings.Contains(string(got), "oldroot-ok") {
		t.Fatalf("/oldroot backdoor NOT closed (%s=%q) — host fs reachable via /oldroot", "oldroot.txt", string(got))
	}
	t.Logf("/oldroot backdoor closed: %s=%q", "oldroot.txt", string(got))
	// oretc.txt carries -ok (the /oldroot/etc check passed); postfix.txt is a
	// bare completion sentinel (written unconditionally as "post-fix"), so it
	// only needs to exist and be non-empty.
	got, err = os.ReadFile(filepath.Join(root, "oretc.txt"))
	if err != nil {
		t.Fatalf("oretc marker not visible on host: %v", err)
	}
	if !strings.Contains(string(got), "oretc-ok") {
		t.Fatalf("/oldroot/etc still reachable (%s=%q) — detach removed the wrong mounts", "oretc.txt", string(got))
	}
	t.Logf("sandbox layout intact: oretc.txt=%q", string(got))
	got, err = os.ReadFile(filepath.Join(root, "postfix.txt"))
	if err != nil {
		t.Fatalf("postfix marker not visible on host: %v", err)
	}
	if strings.TrimSpace(string(got)) == "" {
		t.Fatalf("postfix marker empty — command sequence did not complete (postfix.txt)")
	}
	t.Logf("command sequence completed: postfix.txt=%q", string(got))

	// (b3) The keeper binary's PARENT dir is NOT leaked: the setup binds the
	// binary FILE (not its dir) so the keeper can re-exec itself after the
	// pivot. A host marker in that dir must be invisible in-ns (only the binary
	// file is present; the rest of the dir stays hidden). The bound binary is
	// the one the sandbox re-execs (CADENCE_SANDBOX_REEXEC, set by buildServer).
	if sbxExe := os.Getenv("CADENCE_SANDBOX_REEXEC"); sbxExe != "" {
		spvBinDir := filepath.Dir(sbxExe)
		if spvBinDir != "/" {
			binDirMarker := filepath.Join(spvBinDir, "sbxbindirmarker")
			if err := os.WriteFile(binDirMarker, []byte("bin-dir-secret"), 0644); err == nil {
				defer os.Remove(binDirMarker)
				runInSandboxShell(t, h, root,
					"(test ! -e "+binDirMarker+" && echo bindir-ok > bindir.txt || echo bindir-FAIL > bindir.txt)",
					"bindir.txt", "bindir-ok")
				got, err := os.ReadFile(filepath.Join(root, "bindir.txt"))
				if err != nil {
					t.Fatalf("bindir marker not visible on host: %v", err)
				}
				if !strings.Contains(string(got), "bindir-ok") {
					t.Fatalf("binary's dir LEAKED (%s=%q) — the whole dir (e.g. the user's home) is visible in-ns", "bindir.txt", string(got))
				}
				t.Logf("binary's dir not leaked: %s=%q", "bindir.txt", string(got))
			}
		}
	}

	// (c) The shell exits cleanly: `exit` (in the parent shell, not a subshell)
	// must EOF the pty master so the /terminal WS closes. Without the keeper
	// closing its slave-fd copy, the master never EOFs and run_command hangs.
	h.Master.Write([]byte("exit\n"))
	// Read the master in a goroutine (Read blocks; a zero-byte read is not an
	// error so polling in the main loop would spin). EOF (or any error) means
	// the shell exited and the master closed — the /terminal WS would close.
	eofCh := make(chan struct{}, 1)
	go func() {
		buf := make([]byte, 256)
		for {
			if _, rerr := h.Master.Read(buf); rerr != nil {
				eofCh <- struct{}{}
				return
			}
		}
	}()
	select {
	case <-eofCh:
		t.Log("pty master EOFed after shell exit")
	case <-time.After(5 * time.Second):
		t.Fatalf("pty master never EOFed after `exit` — the /terminal WS would hang (keeper slave-fd leak?)")
	}
}

// TestSharedInstance verifies two owners with the same layout share one keeper
// (shared=true) and the instance is reaped when the last owner leaves.
func TestSharedInstance(t *testing.T) {
	p := probeSandbox()
	if !p.Available || p.Method != "native" {
		t.Skipf("native sandbox unavailable: %s", p.Reason)
	}
	buildServer(t)
	root, err := os.MkdirTemp("", "sbxshared-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	defer os.RemoveAll(root)

	cfg := &SandboxConfig{Roots: []string{root}, Cwd: root}
	h1, err := startSandboxedShell(cfg, "test:owner1")
	if err != nil {
		t.Fatalf("first owner: %v", err)
	}
	defer h1.Kill()

	h2, err := startSandboxedShell(cfg, "test:owner2")
	if err != nil {
		t.Fatalf("second owner: %v", err)
	}
	defer h2.Kill()

	// Same layout => same instance ID.
	if h1.ID != h2.ID {
		t.Fatalf("expected shared instance, got %s vs %s", h1.ID, h2.ID)
	}
	if !h2.Shared {
		t.Fatalf("expected h2.Shared=true with two owners")
	}
	t.Logf("shared instance id=%s owners=%v", h2.ID, h2.Owners)

	// Reap both owners; the instance should be removed from the registry.
	removeOwner(instanceByID(h2.ID), "test:owner1")
	removeOwner(instanceByID(h2.ID), "test:owner2")
	if instanceByID(h2.ID) != nil {
		t.Fatalf("instance should be reaped after last owner leaves")
	}
}

func instanceByID(id string) *SandboxInstance {
	sandboxManager.mu.Lock()
	defer sandboxManager.mu.Unlock()
	return sandboxManager.instances[id]
}

// TestBwrapArgv verifies the pure bwrap argv construction (no bwrap required).
func TestBwrapArgv(t *testing.T) {
	cfg := &SandboxConfig{
		Roots:         []string{"/home/user/proj"},
		ReadOnlyRoots: []string{"/usr", "/etc"},
		Cwd:           "/home/user/proj",
		Shell:         "/bin/bash",
		Flags:         SandboxFlags{PID: true, NET: false, UTS: true, IPC: true},
	}
	argv := bwrapArgv(cfg)
	joined := strings.Join(argv, " ")
	// / must be an empty tmpfs — `--ro-bind / /` would expose the host
	// filesystem (the user could navigate to the real /).
	if !strings.Contains(joined, "--tmpfs /") {
		t.Errorf("expected empty tmpfs at /, got: %s", joined)
	}
	if strings.Contains(joined, "--ro-bind / /") {
		t.Errorf("must not ro-bind host / (exposes the real root), got: %s", joined)
	}
	if !strings.Contains(joined, "--dev /dev") {
		t.Errorf("expected minimal /dev, got: %s", joined)
	}
	if !strings.Contains(joined, "--bind /home/user/proj /home/user/proj") {
		t.Errorf("expected rw bind of root, got: %s", joined)
	}
	if !strings.Contains(joined, "--ro-bind /usr /usr") || !strings.Contains(joined, "--ro-bind /etc /etc") {
		t.Errorf("expected ro passthroughs, got: %s", joined)
	}
	if !strings.Contains(joined, "--unshare-pid") {
		t.Errorf("expected --unshare-pid when PID flag set, got: %s", joined)
	}
	if strings.Contains(joined, "--unshare-net") {
		t.Errorf("did not expect --unshare-net when NET flag unset, got: %s", joined)
	}
	if !strings.Contains(joined, "--die-with-parent") {
		t.Errorf("expected --die-with-parent, got: %s", joined)
	}
	if argv[len(argv)-1] != "/bin/bash" {
		t.Errorf("expected shell last, got: %s", argv[len(argv)-1])
	}
}

// TestScrubEnv verifies dangerous env vars are stripped and TERM is set.
func TestScrubEnv(t *testing.T) {
	base := []string{
		"PATH=/usr/bin",
		"HOME=/home/user",
		"LD_PRELOAD=/evil.so",
		"LD_LIBRARY_PATH=/evil",
		"GIT_SSH_COMMAND=ssh -i /evil",
		"SSH_AUTH_SOCK=/tmp/ssh",
		"HTTPS_PROXY=http://evil",
		"NO_COLOR=1",
	}
	out := scrubEnv(base, []string{"EXTRA=1"})
	joined := strings.Join(out, "\n")
	for _, bad := range []string{"LD_PRELOAD", "LD_LIBRARY_PATH", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK", "HTTPS_PROXY"} {
		if strings.Contains(joined, bad+"=") {
			t.Errorf("expected %s to be stripped, got: %s", bad, joined)
		}
	}
	for _, keep := range []string{"PATH=/usr/bin", "HOME=/home/user", "NO_COLOR=1", "EXTRA=1", "TERM=xterm-256color"} {
		if !strings.Contains(joined, keep) {
			t.Errorf("expected %q present, got: %s", keep, joined)
		}
	}
}

// TestFingerprint verifies the layout fingerprint is stable and order-insensitive
// for roots, and changes when the layout or flags change.
func TestFingerprint(t *testing.T) {
	a := &SandboxConfig{Roots: []string{"/a", "/b"}, Cwd: "/a"}
	b := &SandboxConfig{Roots: []string{"/b", "/a"}, Cwd: "/a"}
	if fingerprint(a) != fingerprint(b) {
		t.Errorf("fingerprint should be order-insensitive for roots")
	}
	c := &SandboxConfig{Roots: []string{"/a", "/b"}, Cwd: "/a", Flags: SandboxFlags{PID: true}}
	if fingerprint(a) == fingerprint(c) {
		t.Errorf("fingerprint should change when flags change")
	}
	// Net vs offline separation: a networked layout must yield a distinct
	// instance id from an otherwise-identical offline layout, so a net
	// terminal never attaches to an air-gapped instance (and vice versa).
	netCfg := &SandboxConfig{Roots: []string{"/a", "/b"}, Cwd: "/a", Flags: SandboxFlags{NET: true}}
	if fingerprint(a) == fingerprint(netCfg) {
		t.Errorf("fingerprint should separate net from offline layouts")
	}
	if !strings.HasPrefix(fingerprint(a), "sbx-") {
		t.Errorf("fingerprint should be prefixed sbx-, got %s", fingerprint(a))
	}
}

// TestAuditRing verifies the parent-side audit ring: newest-first ordering,
// the bounded cap (oldest dropped), and the copy-out semantics (a caller's
// mutation of the returned slice does not corrupt the ring).
func TestAuditRing(t *testing.T) {
	inst := &SandboxInstance{id: "sbx-test"}

	if got := inst.audits(); len(got) != 0 {
		t.Fatalf("expected empty ring, got %d entries", len(got))
	}

	// Record N entries (N > cap) and assert the ring holds at most the cap,
	// newest first.
	n := sandboxAuditCap + 5
	for i := 0; i < n; i++ {
		inst.recordAudit(SandboxAuditEntry{Command: fmt.Sprintf("cmd-%d", i), Tool: "bash", Pid: i, Net: i%2 == 0})
	}
	got := inst.audits()
	if len(got) != sandboxAuditCap {
		t.Fatalf("expected ring capped at %d, got %d", sandboxAuditCap, len(got))
	}
	// Newest first: the most-recently-recorded command (cmd-<n-1>) is at the
	// head; the oldest surviving command is cmd-<n-cap>.
	if got[0].Command != fmt.Sprintf("cmd-%d", n-1) {
		t.Errorf("expected head to be newest cmd-%d, got %s", n-1, got[0].Command)
	}
	if got[sandboxAuditCap-1].Command != fmt.Sprintf("cmd-%d", n-sandboxAuditCap) {
		t.Errorf("expected tail to be cmd-%d (oldest surviving), got %s", n-sandboxAuditCap, got[sandboxAuditCap-1].Command)
	}

	// Copy-out: mutating the returned slice must not corrupt the ring.
	got[0].Command = "MUTATED"
	if inst.audits()[0].Command == "MUTATED" {
		t.Errorf("audits() must return a copy; caller mutation corrupted the ring")
	}
}

// TestAuditExposure verifies the audit ring is plumbed into the status payload:
// a freshly-recorded spawn appears under the instance in sandboxStatus(), with
// the correct tool, pid, and net tag. The net tag is what lets the UI show
// "networked" vs "air-gapped" per spawn.
func TestAuditExposure(t *testing.T) {
	p := probeSandbox()
	if !p.Available {
		t.Skipf("sandbox unavailable: %s", p.Reason)
	}
	buildServer(t)
	root, err := os.MkdirTemp("", "sbxaudit-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	defer os.RemoveAll(root)

	cfg := &SandboxConfig{Roots: []string{root}, Cwd: root, Flags: SandboxFlags{NET: true}}
	h, err := startSandboxedShell(cfg, "test:auditer")
	if err != nil {
		t.Fatalf("startSandboxedShell: %v", err)
	}
	defer h.Kill()
	t.Logf("audit-test sandbox id=%s shell=%s net=%v pid=%d", h.ID, cfg.Shell, h.ShellProfile == "cadence_sbx_net", h.Pid)

	// The spawn itself is recorded at the join-child exec (parent-side). The
	// handle carries the audit entry the keeper recorded for this spawn.
	if h.Audit == nil {
		t.Fatalf("expected handle to carry an audit entry")
	}
	if h.Audit.Tool != "bash" {
		t.Errorf("expected tool basename bash, got %q", h.Audit.Tool)
	}
	if h.Audit.Pid != h.Pid {
		t.Errorf("expected audit pid %d to match handle pid %d", h.Pid, h.Audit.Pid)
	}
	if !h.Audit.Net {
		t.Errorf("expected Net=true (NET flag set), got false")
	}

	// The status payload exposes the ring newest-first.
	resp := sandboxStatus()
	var found *SandboxInstanceInfo
	for i := range resp.Instances {
		if resp.Instances[i].ID == h.ID {
			found = &resp.Instances[i]
		}
	}
	if found == nil {
		t.Fatalf("instance %s not present in status payload", h.ID)
	}
	if len(found.Audits) == 0 {
		t.Fatalf("expected instance to expose audits, got none")
	}
	head := found.Audits[0]
	if head.Command != h.Audit.Command || head.Tool != h.Audit.Tool || head.Pid != h.Audit.Pid || head.Net != h.Audit.Net {
		t.Errorf("status audit head does not match handle audit: %+v vs %+v", head, *h.Audit)
	}
}

// TestShellProfileForFlags is the net-exec-target unit test: the AppArmor shell
// profile is a pure function of the NET flag. A networked spawn transitions to
// cadence_sbx_net; an air-gapped spawn transitions to cadence_sbx_shell. This is
// the parent-side selection that the join-child writes to /proc/self/attr/exec
// (see shellProfileForFlags and gJoinProfilePtr), so asserting the pure function
// is asserting the exec target without needing an installed AppArmor profile.
func TestShellProfileForFlags(t *testing.T) {
	if shellProfileForFlags(SandboxFlags{NET: true}) != netProfileName {
		t.Errorf("NET=true should select the net profile %q", netProfileName)
	}
	if shellProfileForFlags(SandboxFlags{NET: false}) != shellProfileName {
		t.Errorf("NET=false should select the offline shell profile %q", shellProfileName)
	}
	// Other flags must not influence the shell profile choice.
	if got := shellProfileForFlags(SandboxFlags{NET: true, UTS: true, IPC: true}); got != netProfileName {
		t.Errorf("UTS/IPC flags must not change the net selection, got %q", got)
	}
	if got := shellProfileForFlags(SandboxFlags{UTS: true, IPC: true}); got != shellProfileName {
		t.Errorf("UTS/IPC flags must not change the offline selection, got %q", got)
	}
}

// TestAllowlistProfileParses validates (via apparmor_parser --check, when
// available) that the air-gapped shell profile's allowlist block parses as
// well-formed AppArmor: the blanket baseline is now "rwlkm" (no ix) plus
// explicit "ix" grants on the tool dirs only, and the sensitive-path denies
// remain. This is a PARSE check, not an enforcement check — it catches
// malformed rule syntax (the allowlist rewrite) that would otherwise fail at
// install time. Skips cleanly when apparmor_parser is absent.
// sectionBetween returns the substring of `text` starting at `start` and ending
// at `end` (exclusive). An empty `end` means "to end of text". This lets the
// test scope its assertions to a single profile block instead of the whole
// source file, so a blanket grant in the cadence (host spawner) or
// cadence_sbx_keeper profiles doesn't produce a false positive.
func sectionBetween(text, start, end string) string {
	i := strings.Index(text, start)
	if i < 0 {
		return ""
	}
	if end == "" {
		return text[i:]
	}
	j := strings.Index(text[i:], end)
	if j < 0 {
		return text[i:]
	}
	return text[i : i+j]
}

// ruleLines returns only the AppArmor rule lines of `sec`, dropping comments
// and blank lines so assertions match rules, not the prose that explains them.
func ruleLines(sec string) string {
	var sb strings.Builder
	for _, line := range strings.Split(sec, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	return sb.String()
}

func TestAllowlistProfileParses(t *testing.T) {
	parser, err := exec.LookPath("apparmor_parser")
	if err != nil {
		t.Skipf("apparmor_parser not available; skipping allowlist parse check: %v", err)
	}
	// The profile source lives in the module tree (relative to the test's
	// working directory, which is the package dir = module root here).
	rel := "scripts/cadence_aa_profile.txt"
	src, err := os.ReadFile(rel)
	if err != nil {
		t.Skipf("profile source %s not found; skipping: %v", rel, err)
	}
	// Both shell profiles (offline + net) carry the allowlist rewrite.
	// Confirm the rewrite is present in each before parsing (guards against a
	// stale/regressed profile slipping past). The two shell blocks are the
	// only profiles that must NOT retain the blanket "rwlkmix" exec-inheriting
	// grant: that grant was the original hole (curl/python from /usr ran even
	// when air-gapped, and anything exec'd anywhere inherited the profile).
	text := string(src)
	offline := sectionBetween(text, "profile cadence_sbx_shell", "profile cadence_sbx_net")
	net := sectionBetween(text, "profile cadence_sbx_net", "")
	for name, sec := range map[string]string{
		"cadence_sbx_shell (offline)": offline,
		"cadence_sbx_net (networked)": net,
	} {
		// Check only file *rules* (not comments): the offline block's comment
		// explains the old grant in words, so a naive substring match on the
		// whole section would false-positive on that explanation.
		rules := ruleLines(sec)
		if !strings.Contains(rules, "allow file rwlkm /{**,},") {
			t.Fatalf("%s: missing the allowlist baseline 'allow file rwlkm /{**,},' (got blanket grant or no baseline)", name)
		}
		if !strings.Contains(rules, "allow file ix /usr/{**,},") {
			t.Fatalf("%s: missing the tool-dir exec grant 'allow file ix /usr/{**,},' (blanket grant may still be in effect)", name)
		}
		if strings.Contains(rules, "rwlkmix") {
			t.Fatalf("%s: still carries a blanket 'rwlkmix' exec-inheriting grant -- the allowlist rewrite was not applied", name)
		}
	}
	// Parse-only, no kernel load, no cache: -Q = skip kernel load, -K = skip
	// cache (a non-root user cannot write /var/cache/apparmor), -q = quiet.
	// A well-formed profile compiles to exit 0 with no output; a malformed
	// rule syntax (the allowlist rewrite) yields a parser error + exit 1.
	out, err := exec.Command(parser, "-Q", "-K", "-q", rel).CombinedOutput()
	if err != nil {
		t.Fatalf("apparmor_parser parse failed for %s: %v\n%s", rel, err, out)
	}
	t.Logf("allowlist profile parses OK (%s)", rel)
}
