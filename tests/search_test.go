package main

import (
	"io/ioutil"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchSafeguards(t *testing.T) {
	// Set the global fileAPIRoot for testing
	tempDir, err := ioutil.TempDir("", "cadence_search_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	fileAPIRoot = tempDir

	// 1. Create a large text file (> 5 MB)
	largeFilePath := filepath.Join(tempDir, "large_file.txt")
	largeData := strings.Repeat("hello world\n", 600000) // ~6.6 MB
	err = ioutil.WriteFile(largeFilePath, []byte(largeData), 0644)
	if err != nil {
		t.Fatalf("failed to write large file: %v", err)
	}

	// 2. Create a binary file (contains null byte)
	binaryFilePath := filepath.Join(tempDir, "binary_file.bin")
	binaryData := []byte("hello \x00 world query_here")
	err = ioutil.WriteFile(binaryFilePath, binaryData, 0644)
	if err != nil {
		t.Fatalf("failed to write binary file: %v", err)
	}

	// 3. Create a normal search target file
	normalFilePath := filepath.Join(tempDir, "normal_file.txt")
	normalData := "this is a normal file containing the term unique_query_term here."
	err = ioutil.WriteFile(normalFilePath, []byte(normalData), 0644)
	if err != nil {
		t.Fatalf("failed to write normal file: %v", err)
	}

	// 4. Create circular symlinks
	subDir1 := filepath.Join(tempDir, "subdir1")
	err = os.Mkdir(subDir1, 0755)
	if err != nil {
		t.Fatalf("failed to create subdir1: %v", err)
	}

	// Create symlink pointing back to the parent tempDir inside subdir1
	linkPath := filepath.Join(subDir1, "circle_link")
	err = os.Symlink(tempDir, linkPath)
	if err != nil {
		// On some systems (e.g. Windows without admin privileges), symlink creation might fail.
		// If so, we log a warning but don't fail the entire test suite.
		t.Logf("Warning: failed to create circular symlink (expected on some setups): %v", err)
	}

	// Test 1: walkAndSearchContent
	t.Run("walkAndSearchContent", func(t *testing.T) {
		// Search for "hello" (which is in the large file and binary file)
		matches, err := walkAndSearchContent(tempDir, "hello")
		if err != nil {
			t.Fatalf("walkAndSearchContent failed: %v", err)
		}

		// It should NOT match the large file (>5MB) or the binary file (has null byte)
		for _, m := range matches {
			if strings.Contains(m.Path, "large_file.txt") {
				t.Errorf("expected large_file.txt to be skipped, but got match: %+v", m)
			}
			if strings.Contains(m.Path, "binary_file.bin") {
				t.Errorf("expected binary_file.bin to be skipped, but got match: %+v", m)
			}
		}

		// Search for the unique query term in the normal file
		matchesNormal, err := walkAndSearchContent(tempDir, "unique_query_term")
		if err != nil {
			t.Fatalf("walkAndSearchContent normal failed: %v", err)
		}
		if len(matchesNormal) != 1 {
			t.Errorf("expected exactly 1 match in normal file, got %d matches", len(matchesNormal))
		} else if !strings.Contains(matchesNormal[0].Path, "normal_file.txt") {
			t.Errorf("expected match path to contain normal_file.txt, got: %s", matchesNormal[0].Path)
		}
	})

	// Test 2: walkAndSearchFolders
	t.Run("walkAndSearchFolders", func(t *testing.T) {
		// walkAndSearchFolders should execute safely without hanging or throwing errors
		// even in the presence of circular symlink loops.
		folders, err := walkAndSearchFolders(tempDir, "subdir1")
		if err != nil {
			t.Fatalf("walkAndSearchFolders failed: %v", err)
		}
		t.Logf("walkAndSearchFolders returned %d folders", len(folders))
	})
}
