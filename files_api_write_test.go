package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io/ioutil"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestWriteAutoCreateDir exercises the real REST write path
// (handleFileRest -> securePath -> handleRestPost) and verifies that nested
// parent directories are created automatically when writing a file, and that
// a subsequent GET round-trips the content.
func TestWriteAutoCreateDir(t *testing.T) {
	root := t.TempDir()
	oldRoot := fileAPIRoot
	fileAPIRoot = root
	defer func() { fileAPIRoot = oldRoot }()

	relPath := "foo/bar/baz/test.txt"
	absPath := filepath.Join(root, filepath.FromSlash(relPath))

	// Parent directory should not exist yet.
	if _, err := os.Stat(filepath.Dir(absPath)); !os.IsNotExist(err) {
		t.Errorf("expected parent dir %q to not exist yet", filepath.Dir(absPath))
	}

	// POST raw binary body to the REST endpoint.
	body := []byte("hello world")
	req := httptest.NewRequest(http.MethodPost, "/files?path="+relPath, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	handleFileRest(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(absPath); err != nil {
		t.Fatalf("expected file %q to exist after write: %v", absPath, err)
	}
	got, err := ioutil.ReadFile(absPath)
	if err != nil {
		t.Fatalf("failed to read written file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("expected content %q, got %q", body, got)
	}

	// A GET on the same path should round-trip the content (base64-encoded).
	getReq := httptest.NewRequest(http.MethodGet, "/files?path="+relPath, nil)
	getRec := httptest.NewRecorder()
	handleFileRest(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on read-back, got %d", getRec.Code)
	}
	var resp fileResponse
	if err := json.Unmarshal([]byte(getRec.Body.String()), &resp); err != nil {
		t.Fatalf("failed to parse read-back response: %v (body: %s)", err, getRec.Body.String())
	}
	if decoded, err := base64.StdEncoding.DecodeString(resp.Data.(string)); err != nil || !bytes.Equal(decoded, body) {
		t.Errorf("read-back content mismatch: %q", decoded)
	}

	// A path escaping the root via .. must be rejected by securePath.
	escReq := httptest.NewRequest(http.MethodPost, "/files?path=../../etc/evil.txt", bytes.NewReader(body))
	escRec := httptest.NewRecorder()
	handleFileRest(escRec, escReq)
	if escRec.Code != http.StatusForbidden {
		t.Errorf("expected 403 for path escaping the root, got %d", escRec.Code)
	}
}
