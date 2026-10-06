package smoke

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// repoRoot returns the repository root (two levels above tests/smoke).
func repoRoot(t *testing.T) string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file location")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..")
}

type searchRequest struct {
	Action    string `json:"action"`
	Path      string `json:"path"`
	Type      string `json:"type,omitempty"`
	Query     string `json:"query,omitempty"`
	RequestId int    `json:"requestId"`
	Agent     bool   `json:"agent,omitempty"`
}

type searchResponse struct {
	RequestId int         `json:"requestId"`
	Action    string      `json:"action"`
	Path      string      `json:"path"`
	Error     string      `json:"error"`
	Data      interface{} `json:"data"`
}

type searchMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Content string `json:"content"`
}

// freePort returns a currently-free localhost TCP port.
func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// writeTree creates the sandbox tree used to verify dot-folder skipping:
//
//	sandbox/
//	  top.txt            marker  (included)
//	  .hiddenfile.txt    marker  (included: hidden FILE is allowed)
//	  app/js/agent-tools.mjs marker (included)
//	  .git/secret.txt    marker  (EXCLUDED: dot dir)
//	  .agents/secret.txt marker  (EXCLUDED: dot dir)
//	  node_modules/m.txt marker  (EXCLUDED: named dir)
func writeTree(t *testing.T, sandbox string) {
	mk := func(rel string) {
		full := filepath.Join(sandbox, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte("dotmarker\n"), 0644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
	mk("top.txt")
	mk(".hiddenfile.txt")
	mk(filepath.Join("app", "js", "agent-tools.mjs"))
	mk(filepath.Join(".git", "secret.txt"))
	mk(filepath.Join(".agents", "secret.txt"))
	mk(filepath.Join("node_modules", "m.txt"))
}

// spawnServer builds the server binary and runs it against the sandbox root on
// the given port. It returns the cleanup func and blocks until the server is
// reachable.
func spawnServer(t *testing.T, repoRootStr, sandbox string, port int) func() {
	bin := filepath.Join(t.TempDir(), "cadence-smoke-server")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Dir = repoRootStr
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	logFile, err := os.Create(filepath.Join(t.TempDir(), "server.log"))
	if err != nil {
		t.Fatalf("create log: %v", err)
	}
	cmd := exec.Command(bin, "--root", sandbox, "--port", fmt.Sprint(port), "--headless")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}

	cleanup := func() {
		cmd.Process.Kill()
		cmd.Wait()
		logFile.Close()
	}

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(base + "/up")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return cleanup
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	cleanup()
	t.Fatalf("server did not become reachable at %s/up within 30s", base)
	return nil
}

// grepSearch runs a streaming grep search and returns the set of matched
// relative paths (plus the terminal search_done signal).
func grepSearch(t *testing.T, port int, reqPath, query string) (map[string]bool, bool) {
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/files", port)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial WS: %v", err)
	}
	defer conn.Close()

	r := searchRequest{Action: "search", Path: reqPath, Type: "grep", Query: query, RequestId: 1}
	if err := conn.WriteJSON(r); err != nil {
		t.Fatalf("write search: %v", err)
	}

	seen := map[string]bool{}
	gotDone := false
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m searchResponse
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.Error != "" {
			t.Fatalf("search error: %s", m.Error)
		}
		switch m.Action {
		case "search_match":
			// Data is a JSON array: [relPath, lineNum, snippet]
			arr, ok := m.Data.([]interface{})
			if !ok || len(arr) < 1 {
				t.Fatalf("search_match data unexpected shape: %T", m.Data)
			}
			if pathStr, ok := arr[0].(string); ok {
				seen[pathStr] = true
			}
		case "search_done":
			gotDone = true
		}
		if gotDone {
			break
		}
	}
	return seen, gotDone
}

// contentSearch runs a batch content search and returns the set of matched
// relative paths.
func contentSearch(t *testing.T, port int, reqPath, query string) map[string]bool {
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/files", port)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial WS: %v", err)
	}
	defer conn.Close()

	r := searchRequest{Action: "search", Path: reqPath, Type: "content", Query: query, RequestId: 2}
	if err := conn.WriteJSON(r); err != nil {
		t.Fatalf("write search: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read content result: %v", err)
	}
	var m searchResponse
	if json.Unmarshal(data, &m) != nil {
		t.Fatalf("unmarshal content result: %v", err)
	}
	if m.Error != "" {
		t.Fatalf("content search error: %s", m.Error)
	}
	rawJSON, _ := json.Marshal(m.Data)
	var raw []interface{}
	if err := json.Unmarshal(rawJSON, &raw); err != nil {
		t.Fatalf("content data not a list: %v (raw=%s)", err, string(rawJSON))
	}
	seen := map[string]bool{}
	for _, e := range raw {
		var mm searchMatch
		eJSON, _ := json.Marshal(e)
		if err := json.Unmarshal(eJSON, &mm); err != nil {
			continue
		}
		seen[mm.Path] = true
	}
	return seen
}

// assertFileSet verifies the returned relative-path set matches expectations:
// dot-dirs and node_modules excluded; top.txt, app/js/agent-tools.mjs and the
// hidden FILE .hiddenfile.txt included.
func assertFileSet(t *testing.T, label string, got map[string]bool) {
	t.Helper()
	for _, p := range []string{"top.txt", "app/js/agent-tools.mjs", ".hiddenfile.txt"} {
		if !got[p] {
			t.Errorf("%s: expected %q to be included; got set=%v", label, p, got)
		}
	}
	for _, p := range []string{".git/secret.txt", ".agents/secret.txt", "node_modules/m.txt"} {
		if got[p] {
			t.Errorf("%s: expected %q to be EXCLUDED (dot-dir/named-dir skip); got set=%v", label, p, got)
		}
	}
	if len(got) != 3 {
		t.Errorf("%s: expected exactly 3 matched files {top.txt, app/js/agent-tools.mjs, .hiddenfile.txt}; got %d: %v", label, len(got), got)
	}
}

func TestSearchDotFolderSkipping(t *testing.T) {
	repo := repoRoot(t)
	sandbox := t.TempDir()
	writeTree(t, sandbox)
	port := freePort(t)
	cleanup := spawnServer(t, repo, sandbox, port)
	defer cleanup()

	// Grep streaming, scoped to the sandbox root (path "" resolves to root).
	grepSet, gotDone := grepSearch(t, port, "", "dotmarker")
	if !gotDone {
		t.Error("grep: did not receive terminal search_done")
	}
	assertFileSet(t, "grep", grepSet)

	// Batch content, scoped to the sandbox root.
	contentSet := contentSearch(t, port, "", "dotmarker")
	assertFileSet(t, "content", contentSet)
}

// TestSearchScopedSubdir verifies a search scoped to a subdirectory returns
// only matches under that dir, with paths relative to that dir.
func TestSearchScopedSubdir(t *testing.T) {
	repo := repoRoot(t)
	sandbox := t.TempDir()
	writeTree(t, sandbox)
	port := freePort(t)
	cleanup := spawnServer(t, repo, sandbox, port)
	defer cleanup()

	// Scope to app/js: only agent-tools.mjs should match, relative to app/js.
	set := contentSearch(t, port, "app/js", "dotmarker")
	if !set["agent-tools.mjs"] {
		t.Errorf("scoped content: expected agent-tools.mjs (relative to app/js); got %v", set)
	}
	if len(set) != 1 {
		t.Errorf("scoped content: expected exactly 1 match; got %v", set)
	}

	// Scoped grep should agree.
	grepSet, _ := grepSearch(t, port, "app/js", "dotmarker")
	if !grepSet["agent-tools.mjs"] || len(grepSet) != 1 {
		t.Errorf("scoped grep: expected only agent-tools.mjs; got %v", grepSet)
	}
}

// TestAgentLimits verifies the agent-mode caps: total ≤ 50 and per-file ≤ 10.
func TestAgentLimits(t *testing.T) {
	repo := repoRoot(t)
	sandbox := t.TempDir()
	// A single file with many matching lines to exercise the per-file cap.
	dir := filepath.Join(sandbox, "big")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString("dotmarker line\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "many.txt"), []byte(b.String()), 0644); err != nil {
		t.Fatalf("write many.txt: %v", err)
	}

	port := freePort(t)
	cleanup := spawnServer(t, repo, sandbox, port)
	defer cleanup()

	// Agent mode: per-file cap of 10 lines must limit big/many.txt to 10.
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/files", port)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	r := searchRequest{Action: "search", Path: "", Type: "content", Query: "dotmarker", RequestId: 3, Agent: true}
	if err := conn.WriteJSON(r); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m searchResponse
	json.Unmarshal(data, &m)
	raw, ok := m.Data.([]interface{})
	if !ok {
		t.Fatalf("data not list: %T", m.Data)
	}
	perFile := map[string]int{}
	total := 0
	for _, e := range raw {
		var mm searchMatch
		eJSON, _ := json.Marshal(e)
		json.Unmarshal(eJSON, &mm)
		total++
		perFile[mm.Path]++
	}
	if total > 50 {
		t.Errorf("agent total cap: got %d matches, want at most 50", total)
	}
	if perFile["big/many.txt"] > 10 {
		t.Errorf("agent per-file cap: got %d lines for big/many.txt, want at most 10", perFile["big/many.txt"])
	}
}
