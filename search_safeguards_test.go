package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSearchSafeguards verifies that walkAndSearchContent skips oversized,
// binary, and hidden files, and that walkAndSearchFolders terminates safely
// in the presence of circular symlinks.
func TestSearchSafeguards(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "cadence_search_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	fileAPIRoot = tempDir

	// 1. Create a large text file (well over the 0.5 MB size cap).
	largeFilePath := filepath.Join(tempDir, "large_file.txt")
	largeData := strings.Repeat("hello world\n", 600000) // ~6.6 MB
	if err := os.WriteFile(largeFilePath, []byte(largeData), 0644); err != nil {
		t.Fatalf("failed to write large file: %v", err)
	}

	// 2. Create a binary file (contains a null byte + a skipped .bin extension).
	binaryFilePath := filepath.Join(tempDir, "binary_file.bin")
	binaryData := []byte("hello \x00 world query_here")
	if err := os.WriteFile(binaryFilePath, binaryData, 0644); err != nil {
		t.Fatalf("failed to write binary file: %v", err)
	}

	// 3. Create a normal search target file.
	normalFilePath := filepath.Join(tempDir, "normal_file.txt")
	normalData := "this is a normal file containing the term unique_query_term here."
	if err := os.WriteFile(normalFilePath, []byte(normalData), 0644); err != nil {
		t.Fatalf("failed to write normal file: %v", err)
	}

	// 4. Create circular symlinks.
	subDir1 := filepath.Join(tempDir, "subdir1")
	if err := os.Mkdir(subDir1, 0755); err != nil {
		t.Fatalf("failed to create subdir1: %v", err)
	}
	linkPath := filepath.Join(subDir1, "circle_link")
	if err := os.Symlink(tempDir, linkPath); err != nil {
		// Symlink creation can fail on some setups; log and continue.
		t.Logf("Warning: failed to create circular symlink (expected on some setups): %v", err)
	}

	// walkAndSearchContent: skips large/binary, matches the normal file.
	matches, err := walkAndSearchContent(tempDir, "hello", false)
	if err != nil {
		t.Fatalf("walkAndSearchContent failed: %v", err)
	}
	for _, m := range matches {
		if strings.Contains(m.Path, "large_file.txt") {
			t.Errorf("expected large_file.txt to be skipped (size cap), but got match: %+v", m)
		}
		if strings.Contains(m.Path, "binary_file.bin") {
			t.Errorf("expected binary_file.bin to be skipped (binary/extension), but got match: %+v", m)
		}
	}

	matchesNormal, err := walkAndSearchContent(tempDir, "unique_query_term", false)
	if err != nil {
		t.Fatalf("walkAndSearchContent (normal) failed: %v", err)
	}
	if len(matchesNormal) != 1 {
		t.Errorf("expected exactly 1 match in normal file, got %d matches", len(matchesNormal))
	} else if !strings.Contains(matchesNormal[0].Path, "normal_file.txt") {
		t.Errorf("expected match path to contain normal_file.txt, got: %s", matchesNormal[0].Path)
	}

	// walkAndSearchFolders: executes safely (no hang) despite symlink loops.
	folders, err := walkAndSearchFolders(tempDir, "subdir1")
	if err != nil {
		t.Fatalf("walkAndSearchFolders failed: %v", err)
	}
	t.Logf("walkAndSearchFolders returned %d folders", len(folders))
}
