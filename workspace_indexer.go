package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// FileIndex holds the outline and symbols for a single file
type FileIndex struct {
	Path         string       `json:"path"`
	LastModified time.Time    `json:"last_modified"`
	Outline      string       `json:"outline"`
	Symbols      []SymbolInfo `json:"symbols"`
}

type SearchResult struct {
	SymbolInfo
	FilePath string `json:"filePath"`
}

type WorkspaceIndex struct {
	mu             sync.RWMutex
	WorkspaceDir   string
	Files          map[string]*FileIndex `json:"files"`
	IgnorePaths    []string              `json:"ignore_paths"`
}

type IndexManager struct {
	mu             sync.RWMutex
	Indexes        map[string]*WorkspaceIndex
	OnStatusUpdate func() `json:"-"`
}

var globalIndexManager *IndexManager
var indexManagerInit sync.Once

func GetIndexManager() *IndexManager {
	indexManagerInit.Do(func() {
		globalIndexManager = &IndexManager{
			Indexes: make(map[string]*WorkspaceIndex),
		}
	})
	return globalIndexManager
}

// InitWorkspaceIndex initializes the global index manager with the given root directory and returns it.
func InitWorkspaceIndex(root string) *IndexManager {
	im := GetIndexManager()
	im.SetActiveRoots([]string{root}, nil)
	return im
}

// SetActiveRoots sets the active workspace folders, updates their ignore paths, and triggers a background rescan.
func (im *IndexManager) SetActiveRoots(roots []string, ignorePaths []string) {
	im.mu.Lock()
	
	// Create/load indexes
	for _, root := range roots {
		idx, exists := im.Indexes[root]
		if !exists {
			idx = &WorkspaceIndex{
				WorkspaceDir: root,
				Files:        make(map[string]*FileIndex),
			}
			idx.LoadFromDisk()
			im.Indexes[root] = idx
		}
		
		// Update ignore paths
		idx.mu.Lock()
		idx.IgnorePaths = ignorePaths
		idx.mu.Unlock()
		
		// Kick off a background scan to rescan and index
		go func(i *WorkspaceIndex) {
			i.ScanWorkspace()
			if im.OnStatusUpdate != nil {
				im.OnStatusUpdate()
			}
		}(idx)
	}
	
	// Clean up inactive roots
	for existingRoot := range im.Indexes {
		active := false
		for _, r := range roots {
			if r == existingRoot {
				active = true
				break
			}
		}
		if !active {
			delete(im.Indexes, existingRoot)
		}
	}
	im.mu.Unlock()
	
	if im.OnStatusUpdate != nil {
		im.OnStatusUpdate()
	}
}

// IsPathIgnored returns true if the given path matches any of the workspace's ignore patterns.
func (idx *WorkspaceIndex) IsPathIgnored(path string) bool {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	relPath, err := filepath.Rel(idx.WorkspaceDir, path)
	if err != nil {
		return false
	}
	
	relPath = filepath.ToSlash(relPath)
	parts := strings.Split(relPath, "/")

	for _, ignore := range idx.IgnorePaths {
		ignore = strings.TrimSpace(ignore)
		if ignore == "" {
			continue
		}
		ignore = filepath.ToSlash(ignore)
		
		// Skip directories/files that match exactly or whose parent matches exactly
		for _, part := range parts {
			if strings.EqualFold(part, ignore) {
				return true
			}
		}
		
		// Or check if the ignore pattern is a path prefix
		if strings.HasPrefix(strings.ToLower(relPath), strings.ToLower(ignore)) {
			return true
		}
	}
	
	return false
}

// GetTotalSizeFormatted returns the combined size of all active root indexes
func (im *IndexManager) GetTotalSizeFormatted() string {
	im.mu.RLock()
	defer im.mu.RUnlock()
	var totalSize int64
	for _, idx := range im.Indexes {
		info, err := os.Stat(idx.GetIndexFilePath())
		if err == nil {
			totalSize += info.Size()
		}
	}
	if totalSize > 1024*1024 {
		return fmt.Sprintf("%.2f MB", float64(totalSize)/(1024*1024))
	}
	return fmt.Sprintf("%.1f KB", float64(totalSize)/1024)
}

// GetRoots returns a slice of active root paths
func (im *IndexManager) GetRoots() []string {
	im.mu.RLock()
	defer im.mu.RUnlock()
	var roots []string
	for root := range im.Indexes {
		roots = append(roots, root)
	}
	return roots
}

// getBestIndexForPathRLocked finds the most specific workspace index for a path.
// The caller must hold at least a read lock on im.mu.
func (im *IndexManager) getBestIndexForPathRLocked(path string) *WorkspaceIndex {
	var bestRoot string
	var bestIdx *WorkspaceIndex
	for root, idx := range im.Indexes {
		if path == root || strings.HasPrefix(path, root+string(filepath.Separator)) {
			if bestRoot == "" || len(root) > len(bestRoot) {
				bestRoot = root
				bestIdx = idx
			}
		}
	}
	return bestIdx
}

// GetOutline returns the outline for a specific file by routing to the correct index
func (im *IndexManager) GetOutline(path string) string {
	im.mu.RLock()
	defer im.mu.RUnlock()
	
	idx := im.getBestIndexForPathRLocked(path)
	if idx != nil {
		idx.mu.RLock()
		defer idx.mu.RUnlock()
		if fi, ok := idx.Files[path]; ok {
			return fi.Outline
		}
	}
	return ""
}

// GetFileSymbols returns the symbols for a specific file by routing to the correct index
func (im *IndexManager) GetFileSymbols(path string) []SymbolInfo {
	im.mu.RLock()
	defer im.mu.RUnlock()
	
	idx := im.getBestIndexForPathRLocked(path)
	if idx != nil {
		idx.mu.RLock()
		defer idx.mu.RUnlock()
		if fi, ok := idx.Files[path]; ok {
			return fi.Symbols
		}
	}
	return nil
}


// SearchSymbols returns files containing a matching symbol name across all indexes
func (im *IndexManager) SearchSymbols(query string) []SearchResult {
	im.mu.RLock()
	defer im.mu.RUnlock()
	
	query = strings.ToLower(query)
	var results []SearchResult
	
	for _, idx := range im.Indexes {
		idx.mu.RLock()
		for path, fi := range idx.Files {
			for _, sym := range fi.Symbols {
				if strings.Contains(strings.ToLower(sym.Name), query) {
					results = append(results, SearchResult{
						SymbolInfo: sym,
						FilePath:   path,
					})
				}
			}
		}
		idx.mu.RUnlock()
	}
	return results
}

// UpdateFile routes a file update to the correct index
func (im *IndexManager) UpdateFile(path string, content string) {
	im.mu.RLock()
	defer im.mu.RUnlock()
	
	idx := im.getBestIndexForPathRLocked(path)
	if idx != nil {
		idx.UpdateFile(path, content)
	}
}



func (idx *WorkspaceIndex) GetIndexFilePath() string {
	return filepath.Join(idx.WorkspaceDir, ".cadence", "index.json")
}

func (idx *WorkspaceIndex) GetIndexSizeFormatted() string {
	info, err := os.Stat(idx.GetIndexFilePath())
	if err != nil {
		return "0 KB"
	}
	size := info.Size()
	if size > 1024*1024 {
		return fmt.Sprintf("%.2f MB", float64(size)/(1024*1024))
	}
	return fmt.Sprintf("%.1f KB", float64(size)/1024)
}

func (idx *WorkspaceIndex) LoadFromDisk() {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	indexPath := idx.GetIndexFilePath()
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return // File might not exist yet
	}

	var storedFiles map[string]*FileIndex
	if err := json.Unmarshal(data, &storedFiles); err == nil {
		normalizedFiles := make(map[string]*FileIndex)
		for path, fi := range storedFiles {
			absPath := path
			if !filepath.IsAbs(path) {
				absPath = filepath.Clean(filepath.Join(idx.WorkspaceDir, path))
			}
			fi.Path = absPath
			normalizedFiles[absPath] = fi
		}
		idx.Files = normalizedFiles
	}
}

func (idx *WorkspaceIndex) SaveToDisk() {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	indexPath := idx.GetIndexFilePath()
	os.MkdirAll(filepath.Dir(indexPath), 0755)

	data, err := json.Marshal(idx.Files)
	if err == nil {
		os.WriteFile(indexPath, data, 0644)
	}
}

// ScanWorkspace walks the workspace and indexes any updated/new files
func (idx *WorkspaceIndex) ScanWorkspace() {
	changed := false
	seenFiles := make(map[string]bool)

	filepath.Walk(idx.WorkspaceDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			// Skip hidden dirs, node_modules, and any ignored paths
			if info != nil && info.IsDir() {
				// If this directory is itself another active workspace root, skip walking it under this index!
				im := GetIndexManager()
				im.mu.RLock()
				isOtherRoot := false
				for r := range im.Indexes {
					if r != idx.WorkspaceDir && path == r {
						isOtherRoot = true
						break
					}
				}
				im.mu.RUnlock()
				if isOtherRoot {
					return filepath.SkipDir
				}

				if strings.HasPrefix(info.Name(), ".") || info.Name() == "node_modules" || info.Name() == "dist" || info.Name() == "build" || idx.IsPathIgnored(path) {
					return filepath.SkipDir
				}
			}
			return nil
		}

		// Skip hidden files or ignored files
		if strings.HasPrefix(filepath.Base(path), ".") || idx.IsPathIgnored(path) {
			return nil
		}

		// Check extensions
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".go" && ext != ".js" && ext != ".mjs" && ext != ".ts" && ext != ".jsx" && ext != ".tsx" && ext != ".py" {
			return nil
		}

		seenFiles[path] = true

		idx.mu.RLock()
		existing, ok := idx.Files[path]
		idx.mu.RUnlock()

		if !ok || info.ModTime().After(existing.LastModified) {
			content, err := os.ReadFile(path)
			if err == nil {
				outline, symbols, err := GenerateOutline(path, string(content))
				if err == nil {
					idx.mu.Lock()
					idx.Files[path] = &FileIndex{
						Path:         path,
						LastModified: info.ModTime(),
						Outline:      outline,
						Symbols:      symbols,
					}
					idx.mu.Unlock()
					changed = true
				}
			}
		}
		return nil
	})

	// Remove files from index that no longer exist on disk or are now ignored
	idx.mu.Lock()
	for path := range idx.Files {
		if !seenFiles[path] {
			delete(idx.Files, path)
			changed = true
		}
	}
	idx.mu.Unlock()

	if changed {
		idx.SaveToDisk()
	}
}

// UpdateFile updates the index for a single file (e.g. on file save via fsnotify or websocket)
func (idx *WorkspaceIndex) UpdateFile(path string, content string) {
	if idx.IsPathIgnored(path) {
		return
	}

	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".go" && ext != ".js" && ext != ".mjs" && ext != ".ts" && ext != ".jsx" && ext != ".tsx" && ext != ".py" {
		return
	}

	outline, symbols, err := GenerateOutline(path, content)
	if err == nil {
		info, _ := os.Stat(path)
		modTime := time.Now()
		if info != nil {
			modTime = info.ModTime()
		}

		idx.mu.Lock()
		idx.Files[path] = &FileIndex{
			Path:         path,
			LastModified: modTime,
			Outline:      outline,
			Symbols:      symbols,
		}
		idx.mu.Unlock()
		
		// In a real app we might debounce SaveToDisk
		idx.SaveToDisk()
	}
}
