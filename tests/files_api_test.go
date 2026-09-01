package main

import (
	"io/ioutil"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAutoCreateDir(t *testing.T) {
	tempDir, err := ioutil.TempDir("", "cadence_write_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	fileAPIRoot = tempDir

	// Nested target path where subdirectories do not exist
	targetRelPath := "foo/bar/baz/test.txt"
	fullPath, err := securePath(targetRelPath)
	if err != nil {
		t.Fatalf("securePath failed: %v", err)
	}

	// Verify parent directory does not exist yet
	dir := filepath.Dir(fullPath)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("expected directory %s to not exist", dir)
	}

	// Automatically create paths to the folder if they don't exist
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("os.MkdirAll failed: %v", err)
	}

	// Write file
	content := []byte("hello world")
	if err := ioutil.WriteFile(fullPath, content, 0644); err != nil {
		t.Fatalf("ioutil.WriteFile failed: %v", err)
	}

	// Verify file was written successfully
	if _, err := os.Stat(fullPath); err != nil {
		t.Errorf("expected file %s to exist, but got error: %v", fullPath, err)
	}

	readContent, err := ioutil.ReadFile(fullPath)
	if err != nil {
		t.Fatalf("failed to read written file: %v", err)
	}

	if string(readContent) != string(content) {
		t.Errorf("expected content %q, got %q", string(content), string(readContent))
	}
}
