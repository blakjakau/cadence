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

	// Create a dummy mjs file
	mjsFile := filepath.Join(tmpDir, "test.mjs")
	mjsContent := `
export function greet(name) {
	return "hello " + name;
}
`
	os.WriteFile(mjsFile, []byte(mjsContent), 0644)

	// Init index
	idx := InitWorkspaceIndex(tmpDir)
	
	// Wait briefly for background scan
	time.Sleep(200 * time.Millisecond)

	outline := idx.GetOutline(goFile)
	if outline == "" {
		t.Errorf("Expected outline to be generated for go file, got empty string")
	}

	mjsOutline := idx.GetOutline(mjsFile)
	if mjsOutline == "" {
		t.Errorf("Expected outline to be generated for mjs file, got empty string")
	}

	results := idx.SearchSymbols("hello")
	if len(results) == 0 {
		t.Errorf("Expected to find 'hello' symbol")
	} else if results[0].Name != "hello" {
		t.Errorf("Expected symbol name 'hello', got %s", results[0].Name)
	}

	mjsResults := idx.SearchSymbols("greet")
	if len(mjsResults) == 0 {
		t.Errorf("Expected to find 'greet' symbol")
	} else if mjsResults[0].Name != "greet" {
		t.Errorf("Expected symbol name 'greet', got %s", mjsResults[0].Name)
	}
}
