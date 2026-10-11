//go:build linux

package main

import (
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
		bin, err := os.MkdirTemp("", "cadence-sbx-srv-")
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

	// (b2) The /oldroot backdoor is CLOSED: the pivot-relocated old root and
	// all /oldroot/* submounts must be detached (a single umount2("/oldroot")
	// leaves them in place, so `ls /oldroot` = host / and the user could
	// navigate to the real host fs, e.g. cat /oldroot/etc/shadow). The
	// authoritative check is that /proc/self/mountinfo has ZERO entries whose
	// mountpoint is /oldroot or /oldroot/<...>. We also assert that the
	// relocated host fs is not reachable through /oldroot (no /oldroot/etc
	// directory) and that the rw root bind is still writable.
	// NOTE: runInSandboxShell wraps cmd in bash -c '<cmd>' (single quotes), so
	// the command must contain NO single quotes. The awk below counts
	// mountinfo entries whose field 5 (mount_point) is /oldroot or
	// /oldroot/<...> and writes the marker itself (no shell variable — the
	// inner bash would expand $n at parse time, before the assignment runs).
	// The \$5 is backslash-escaped so the inner bash passes a literal $5 to
	// awk (an unescaped $5 would be expanded to an empty positional param).
	runInSandboxShell(t, h, root,
		"awk \"\\$5==\\\"/oldroot\\\"||\\$5~/^\\/oldroot\\//{c++}END{if(c+0==0) print \\\"oldroot-ok\\\" > \\\"oldroot.txt\\\"; else print \\\"oldroot-FAIL:\\\" c > \\\"oldroot.txt\\\"}\" /proc/self/mountinfo; "+
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
	for _, f := range []string{"oretc.txt", "postfix.txt"} {
		got, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			t.Fatalf("marker %s not visible on host: %v", f, err)
		}
		if !strings.Contains(string(got), "-ok") {
			t.Fatalf("sandbox layout broken (%s=%q) — detach removed the wrong mounts", f, string(got))
		}
		t.Logf("sandbox layout intact: %s=%q", f, string(got))
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
	if !strings.HasPrefix(fingerprint(a), "sbx-") {
		t.Errorf("fingerprint should be prefixed sbx-, got %s", fingerprint(a))
	}
}
