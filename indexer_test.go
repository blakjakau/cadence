package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWorkspaceIndex(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "cadence_indexer_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	// Create a dummy go file
	goFile := filepath.Join(tmpDir, "test.go")
	content := `package main
	
func hello() {
	println("world")
}
`
	os.WriteFile(goFile, []byte(content), 0644)

	// Init index
	idx := InitWorkspaceIndex(tmpDir)
	
	// Wait briefly for background scan
	time.Sleep(200 * time.Millisecond)

	outline := idx.GetOutline(goFile)
	if outline == "" {
		t.Errorf("Expected outline to be generated, got empty string")
	}

	results := idx.SearchSymbols("hello")
	if len(results) == 0 {
		t.Errorf("Expected to find 'hello' symbol")
	} else if results[0].Name != "hello" {
		t.Errorf("Expected symbol name 'hello', got %s", results[0].Name)
	}
}
