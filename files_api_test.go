package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain ensures fileAPIRoot is initialized for tests that rely on the
// global file API root (mirrors runCadenceServer behavior when -root is set).
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "cadence_api_root_test")
	if err != nil {
		// Fall back to the user home dir, mirroring the default behavior.
		if home, herr := os.UserHomeDir(); herr == nil {
			fileAPIRoot = home
		} else {
			fileAPIRoot = "."
		}
	} else {
		fileAPIRoot = tmp
		defer os.RemoveAll(tmp)
	}
	os.Exit(m.Run())
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestResolvePathUnderRoot(t *testing.T) {
	root := "/home/user/project"

	// Absolute path under the root resolves to itself.
	got, ok := resolvePathUnderRoot(root, "/home/user/project/app/js/agent-tools.mjs")
	if !ok {
		t.Fatalf("expected absolute path under root to be accepted")
	}
	want := filepath.Join(root, "app/js/agent-tools.mjs")
	if got != want {
		t.Fatalf("resolved = %q, want %q", got, want)
	}

	// Relative path under the root is joined to the root.
	got, ok = resolvePathUnderRoot(root, "app/js/agent-tools.mjs")
	if !ok {
		t.Fatalf("expected relative path under root to be accepted")
	}
	want = filepath.Join(root, "app/js/agent-tools.mjs")
	if got != want {
		t.Fatalf("resolved = %q, want %q", got, want)
	}

	// Path that escapes the root via .. is rejected.
	if _, ok := resolvePathUnderRoot(root, "app/../../etc/passwd"); ok {
		t.Fatal("expected path escaping the root via .. to be rejected")
	}
	if _, ok := resolvePathUnderRoot(root, "/etc/passwd"); ok {
		t.Fatal("expected absolute path outside the root to be rejected")
	}

	// The root itself is accepted.
	got, ok = resolvePathUnderRoot(root, root)
	if !ok {
		t.Fatal("expected the root itself to be accepted")
	}
	if got != filepath.Clean(root) {
		t.Fatalf("resolved = %q, want %q", got, filepath.Clean(root))
	}
}

func TestResolvePathUnderRootLeadingSlash(t *testing.T) {
	// A leading-slash path is only accepted in its "workspace-relative with a
	// stray leading slash" interpretation if that form actually exists under
	// the root. Use a real temp dir because the check stats the candidate.
	root := t.TempDir()
	sub := filepath.Join(root, "app", "js")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	file := filepath.Join(sub, "agent-tools.mjs")
	if err := os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	rel := "app/js/agent-tools.mjs"

	// Bare relative and absolute forms both resolve identically.
	got, ok := resolvePathUnderRoot(root, rel)
	if !ok || got != file {
		t.Fatalf("relative: ok=%v got=%q want=%q", ok, got, file)
	}
	got, ok = resolvePathUnderRoot(root, filepath.Join("/", rel))
	if !ok || got != file {
		t.Fatalf("absolute under root: ok=%v got=%q want=%q", ok, got, file)
	}

	// Leading-slash form of a path that EXISTS under the root resolves too.
	got, ok = resolvePathUnderRoot(root, "/"+rel)
	if !ok || got != file {
		t.Fatalf("leading-slash existing under root: ok=%v got=%q want=%q", ok, got, file)
	}
	// Same for the directory itself.
	got, ok = resolvePathUnderRoot(root, "/app")
	if !ok || got != filepath.Join(root, "app") {
		t.Fatalf("leading-slash existing dir: ok=%v got=%q", ok, got)
	}

	// Leading-slash form of a path that does NOT exist under the root is
	// rejected — a true absolute path outside every root must not be silently
	// remapped into the root (the security guard).
	if _, ok := resolvePathUnderRoot(root, "/etc/passwd"); ok {
		t.Fatal("expected leading-slash path not under root to be rejected")
	}
	if _, ok := resolvePathUnderRoot(root, "/does-not-exist-anywhere.txt"); ok {
		t.Fatal("expected nonexistent leading-slash path to be rejected")
	}
}

func TestSecurePathAcceptsWorkspaceRoot(t *testing.T) {
	// A path under fileAPIRoot is accepted and resolved to an absolute path.
	under := filepath.Join(fileAPIRoot, "sub", "file.txt")
	got, err := securePath(under)
	if err != nil {
		t.Fatalf("securePath(under fileAPIRoot) failed: %v", err)
	}
	if !strings.HasPrefix(got, fileAPIRoot) {
		t.Fatalf("resolved = %q, not under fileAPIRoot %q", got, fileAPIRoot)
	}

	// A path outside the allowed roots is rejected.
	if _, err := securePath("/etc/passwd"); err == nil {
		t.Fatal("expected securePath(/etc/passwd) to fail")
	}

	// An active indexer (workspace) root outside fileAPIRoot must now be
	// accepted as a valid base (the fix for set_active_roots silent drops).
	im := getIndexManagerAPI()
	workspaceRoot := filepath.Join(os.TempDir(), "cadence_ws_root_test")
	if err := os.MkdirAll(workspaceRoot, 0755); err != nil {
		t.Fatalf("mkdir workspace root: %v", err)
	}
	defer os.RemoveAll(workspaceRoot)

	im.mu.Lock()
	im.Indexes[workspaceRoot] = &WorkspaceIndex{
		WorkspaceDir: workspaceRoot,
		Files:        make(map[string]*FileIndex),
	}
	im.mu.Unlock()

	target := filepath.Join(workspaceRoot, "deep", "dir", "file.txt")
	if _, err := securePath(target); err != nil {
		t.Fatalf("securePath under active workspace root should be accepted, got: %v", err)
	}
}

func TestWalkAndSearchContentRootRelative(t *testing.T) {
	// Build a tree under a nested sub-directory so the walked root is NOT
	// fileAPIRoot. Matches must be returned relative to the walked root.
	base := t.TempDir()
	walkRoot := filepath.Join(base, "repo", "dev.jakbox.cadence", "app", "js")
	writeTestFile(t, filepath.Join(walkRoot, "agent", "agent-tools.mjs"), "function searchFiles() {\nconst target = securePath;\n}\n")
	writeTestFile(t, filepath.Join(walkRoot, "conduit-client.mjs"), "function wsSearch() {\nreturn target;\n}\n")
	// A file OUTSIDE the walked root must never appear in results.
	writeTestFile(t, filepath.Join(base, "elsewhere", "other.mjs"), "target is here too\n")

	matches, err := walkAndSearchContent(walkRoot, "target", false)
	if err != nil {
		t.Fatalf("walkAndSearchContent failed: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("expected matches under the walked root")
	}

	seen := map[string]bool{}
	for _, m := range matches {
		// Paths must be relative to the walked root, not fileAPIRoot.
		if strings.Contains(m.Path, "\x00") {
			t.Fatalf("match path %q is not a clean relative path", m.Path)
		}
		if strings.HasPrefix(m.Path, "/") && !strings.HasPrefix(m.Path, walkRoot) {
			// Allow absolute fallback only when Rel failed; otherwise it must be relative.
			t.Fatalf("match path %q is absolute but not under the walked root", m.Path)
		}
		seen[m.Path] = true
	}

	if !seen["agent/agent-tools.mjs"] {
		t.Fatalf("expected a match with path 'agent/agent-tools.mjs', got: %v", seen)
	}
	if !seen["conduit-client.mjs"] {
		t.Fatalf("expected a match with path 'conduit-client.mjs', got: %v", seen)
	}
	if len(seen) > 2 {
		t.Fatalf("expected only matches under the walked root, got extra: %v", seen)
	}
}

func TestWalkAndSearchContentAgentLimits(t *testing.T) {
	base := t.TempDir()
	walkRoot := filepath.Join(base, "ws")

	// A single file with many matching lines (per-file cap of 10 applies in agent mode).
	const manyLines = 30
	var b strings.Builder
	for i := 0; i < manyLines; i++ {
		b.WriteString("CAPMARK line\n")
	}
	writeTestFile(t, filepath.Join(walkRoot, "big.mjs"), b.String())

	// Non-agent: all 30 lines returned.
	all, err := walkAndSearchContent(walkRoot, "CAPMARK", false)
	if err != nil {
		t.Fatalf("walkAndSearchContent (non-agent) failed: %v", err)
	}
	if len(all) != manyLines {
		t.Fatalf("non-agent expected %d lines, got %d", manyLines, len(all))
	}

	// Agent: per-file cap of 10 lines.
	agent, err := walkAndSearchContent(walkRoot, "CAPMARK", true)
	if err != nil {
		t.Fatalf("walkAndSearchContent (agent) failed: %v", err)
	}
	if len(agent) != 10 {
		t.Fatalf("agent mode expected per-file cap of 10 lines, got %d", len(agent))
	}
}

func TestWalkAndSearchContentAgentTotalCap(t *testing.T) {
	base := t.TempDir()
	walkRoot := filepath.Join(base, "ws")

	// 60 files, one matching line each. Agent total cap is 50.
	for i := 0; i < 60; i++ {
		writeTestFile(t, filepath.Join(walkRoot, fmt.Sprintf("file%02d.txt", i)), "TOTALCAP match\n")
	}

	agent, err := walkAndSearchContent(walkRoot, "TOTALCAP", true)
	if err != nil {
		t.Fatalf("walkAndSearchContent (agent) failed: %v", err)
	}
	if len(agent) != 50 {
		t.Fatalf("agent mode expected total cap of 50, got %d", len(agent))
	}
}

func TestIsAllRootsSearchPath(t *testing.T) {
	trueCases := []string{".", "", "/", " . ", " / ", "\t."}
	for _, p := range trueCases {
		if !isAllRootsSearchPath(p) {
			t.Errorf("isAllRootsSearchPath(%q) = false, want true", p)
		}
	}
	falseCases := []string{"sub", "a/b", "project", "./sub", "..", "/home/user"}
	for _, p := range falseCases {
		if isAllRootsSearchPath(p) {
			t.Errorf("isAllRootsSearchPath(%q) = true, want false", p)
		}
	}
}

func TestEffectiveSearchRoots(t *testing.T) {
	im := getIndexManagerAPI()

	// Save/restore global state so other tests are unaffected.
	origRoot := fileAPIRoot
	defer func() { fileAPIRoot = origRoot }()
	fileAPIRoot = t.TempDir()

	// No indexer roots: fall back to the file API root.
	im.mu.Lock()
	for r := range im.Indexes {
		delete(im.Indexes, r)
	}
	im.mu.Unlock()

	roots := effectiveSearchRoots()
	if len(roots) != 1 || roots[0] != fileAPIRoot {
		t.Fatalf("no indexer roots: got %v, want [%s]", roots, fileAPIRoot)
	}

	// With indexer roots: return them (not the file API root).
	r1 := t.TempDir()
	r2 := t.TempDir()
	im.mu.Lock()
	im.Indexes[r1] = &WorkspaceIndex{WorkspaceDir: r1, Files: make(map[string]*FileIndex)}
	im.Indexes[r2] = &WorkspaceIndex{WorkspaceDir: r2, Files: make(map[string]*FileIndex)}
	im.mu.Unlock()
	defer func() {
		im.mu.Lock()
		delete(im.Indexes, r1)
		delete(im.Indexes, r2)
		im.mu.Unlock()
	}()

	got := effectiveSearchRoots()
	gotSet := map[string]bool{}
	for _, g := range got {
		gotSet[g] = true
	}
	if len(got) != 2 || !gotSet[r1] || !gotSet[r2] {
		t.Fatalf("got %v, want %v and %v", got, r1, r2)
	}
	if gotSet[fileAPIRoot] {
		t.Fatalf("file API root %q should not appear when indexer roots exist", fileAPIRoot)
	}
}

func TestRebasePathToRoot(t *testing.T) {
	base := "/home/user"
	root := "/home/user/project"

	// A match relative to the root is rebased relative to the file API root.
	if got := rebasePathToRoot("app/js/main.mjs", root, base); got != "project/app/js/main.mjs" {
		t.Fatalf("rebasePathToRoot = %q, want project/app/js/main.mjs", got)
	}
	// A match at the root itself.
	if got := rebasePathToRoot(".", root, base); got != "project" {
		t.Fatalf("rebasePathToRoot(\".\") = %q, want project", got)
	}
	// Windows-style paths are normalized to forward slashes.
	if got := rebasePathToRoot(`sub\file.txt`, root, base); got != "project/sub/file.txt" {
		t.Fatalf("rebasePathToRoot(windows) = %q, want project/sub/file.txt", got)
	}
}

func TestResolveGrepSearchRootsAllRoots(t *testing.T) {
	im := getIndexManagerAPI()

	// fileAPIRoot must be the base that match paths are computed relative to.
	origRoot := fileAPIRoot
	defer func() { fileAPIRoot = origRoot }()
	fileAPIRoot = t.TempDir()

	// A single indexer (workspace) root nested under fileAPIRoot.
	wsRoot := filepath.Join(fileAPIRoot, "project")
	writeTestFile(t, filepath.Join(wsRoot, "src", "main.mjs"), "MARKER_ALLROOTS\n")
	// A file OUTSIDE the indexer root but under fileAPIRoot must not be walked.
	writeTestFile(t, filepath.Join(fileAPIRoot, "outside", "other.mjs"), "MARKER_ALLROOTS\n")

	// Clear any stale entries (e.g. from other tests) so the index holds only
	// the workspace root we just created.
	im.mu.Lock()
	for r := range im.Indexes {
		delete(im.Indexes, r)
	}
	im.Indexes[wsRoot] = &WorkspaceIndex{WorkspaceDir: wsRoot, Files: make(map[string]*FileIndex)}
	im.mu.Unlock()
	defer func() {
		im.mu.Lock()
		delete(im.Indexes, wsRoot)
		im.mu.Unlock()
	}()

	// Empty scope = "search all active workspace roots" (the "." sentinel).
	roots, walkBase, scopedFile := resolveGrepSearchRoots("")

	if len(roots) != 1 || roots[0].path != wsRoot {
		t.Fatalf("all-roots: got %v, want [%s]", roots, wsRoot)
	}
	// Match paths must stay relative to the file API root so the frontend can
	// re-open them (securePath resolves relative paths against it first).
	if walkBase != fileAPIRoot {
		t.Fatalf("all-roots walkBase = %q, want fileAPIRoot %q", walkBase, fileAPIRoot)
	}
	if scopedFile != "" {
		t.Fatalf("all-roots scopedFileFilter = %q, want empty", scopedFile)
	}
	// The file outside the indexer root is not among the walk roots.
	for _, r := range roots {
		if r.path == filepath.Join(fileAPIRoot, "outside") {
			t.Fatalf("walked a root outside the indexer roots: %q", r.path)
		}
	}
}

func TestResolveGrepSearchRootsScoped(t *testing.T) {
	origRoot := fileAPIRoot
	defer func() { fileAPIRoot = origRoot }()
	fileAPIRoot = t.TempDir()

	// Scoped to a directory: walk only that directory, walkBase = that dir.
	sub := filepath.Join(fileAPIRoot, "sub")
	writeTestFile(t, filepath.Join(sub, "a.txt"), "x")
	roots, walkBase, scopedFile := resolveGrepSearchRoots(sub)
	if len(roots) != 1 || roots[0].path != sub {
		t.Fatalf("dir scope: got %v, want [%s]", roots, sub)
	}
	if walkBase != sub {
		t.Fatalf("dir scope walkBase = %q, want %q", walkBase, sub)
	}
	if scopedFile != "" {
		t.Fatalf("dir scope scopedFileFilter = %q, want empty", scopedFile)
	}

	// Scoped to a single file: walk its parent dir, filter to that file.
	file := filepath.Join(sub, "a.txt")
	roots, walkBase, scopedFile = resolveGrepSearchRoots(file)
	if len(roots) != 1 || roots[0].path != sub {
		t.Fatalf("file scope: got %v, want [%s]", roots, sub)
	}
	if walkBase != sub {
		t.Fatalf("file scope walkBase = %q, want %q", walkBase, sub)
	}
	if scopedFile != file {
		t.Fatalf("file scope scopedFileFilter = %q, want %q", scopedFile, file)
	}
}

func TestResolveGrepSearchRootsNoIndexers(t *testing.T) {
	im := getIndexManagerAPI()

	origRoot := fileAPIRoot
	defer func() { fileAPIRoot = origRoot }()
	fileAPIRoot = t.TempDir()

	// No indexer roots: an empty scope must NOT fall back to the file API root
	// (home) — that would reintroduce the home-directory walk bug. It returns
	// no roots, so startGrepSearch emits search_done with zero matches.
	im.mu.Lock()
	for r := range im.Indexes {
		delete(im.Indexes, r)
	}
	im.mu.Unlock()

	roots, walkBase, _ := resolveGrepSearchRoots("")
	if len(roots) != 0 {
		t.Fatalf("no indexer roots: got %v, want empty (no home fallback)", roots)
	}
	if walkBase != fileAPIRoot {
		t.Fatalf("walkBase = %q, want fileAPIRoot %q", walkBase, fileAPIRoot)
	}
}

func TestWalkAndSearchFoldersRespectsFullpath(t *testing.T) {
	base := t.TempDir()
	// Create two sibling trees; the query dir must only be returned under the
	// walked root, proving fullPath is honored instead of a hardcoded root.
	rootA := filepath.Join(base, "A", "targetdir")
	rootB := filepath.Join(base, "B", "targetdir")
	writeTestFile(t, filepath.Join(rootA, "x.txt"), "a")
	writeTestFile(t, filepath.Join(rootB, "y.txt"), "b")

	// Walk only A: must find targetdir under A, not B.
	results, err := walkAndSearchFolders(filepath.Join(base, "A"), "targetdir")
	if err != nil {
		t.Fatalf("walkAndSearchFolders failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 matching folder under A, got %d", len(results))
	}
	if results[0].Name != "targetdir" {
		t.Fatalf("expected folder 'targetdir', got %q", results[0].Name)
	}
}
