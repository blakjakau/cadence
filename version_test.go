//go:build !plan9
// +build !plan9

package main

import (
	"encoding/json"
	"io/fs"
	"testing"
)

// app/version.json is the single source of truth for the Cadence version; the
// server binary must report the same number (see the version var in
// main_common.go).
func TestVersionMatchesVersionJson(t *testing.T) {
	var meta struct {
		Version string `json:"version"`
	}
	data, err := fs.ReadFile(getAppFS(), "version.json")
	if err != nil {
		t.Fatalf("read version.json: %v", err)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatalf("parse version.json: %v", err)
	}
	if meta.Version == "" {
		t.Fatal("version.json has no version field")
	}
	if meta.Version != version {
		t.Fatalf("server version %q != version.json %q — bump app/version.json only", version, meta.Version)
	}
}