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

// SetActiveRoots sets the active workspace folders and triggers indexing for any new ones
func (im *IndexManager) SetActiveRoots(roots []string) {
	im.mu.Lock()
	
	// Create/load any new indexes
	for _, root := range roots {
		if _, exists := im.Indexes[root]; !exists {
			idx := &WorkspaceIndex{
				WorkspaceDir: root,
				Files:        make(map[string]*FileIndex),
			}
			idx.LoadFromDisk()
			im.Indexes[root] = idx
			// Kick off a background scan to update anything missed/changed
			go func(i *WorkspaceIndex) {
				i.ScanWorkspace()
				if im.OnStatusUpdate != nil {
					im.OnStatusUpdate()
				}
			}(idx)
		}
	}
	im.mu.Unlock()
	
	if im.OnStatusUpdate != nil {
		im.OnStatusUpdate()
	}
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

// GetOutline returns the outline for a specific file by routing to the correct index
func (im *IndexManager) GetOutline(path string) string {
	im.mu.RLock()
	defer im.mu.RUnlock()
	
	for root, idx := range im.Indexes {
		if strings.HasPrefix(path, root) {
			idx.mu.RLock()
			if fi, ok := idx.Files[path]; ok {
				idx.mu.RUnlock()
				return fi.Outline
			}
			idx.mu.RUnlock()
		}
	}
	return ""
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
	for root, idx := range im.Indexes {
		if strings.HasPrefix(path, root) {
			idx.UpdateFile(path, content)
			break
		}
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
		idx.Files = storedFiles
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

	filepath.Walk(idx.WorkspaceDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			// Skip hidden dirs and node_modules
			if info != nil && info.IsDir() && (strings.HasPrefix(info.Name(), ".") || info.Name() == "node_modules" || info.Name() == "dist" || info.Name() == "build") {
				return filepath.SkipDir
			}
			return nil
		}

		// Skip hidden files
		if strings.HasPrefix(filepath.Base(path), ".") {
			return nil
		}

		// Check extensions
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".go" && ext != ".js" && ext != ".ts" && ext != ".jsx" && ext != ".tsx" && ext != ".py" {
			return nil
		}

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

	if changed {
		idx.SaveToDisk()
	}
}

// UpdateFile updates the index for a single file (e.g. on file save via fsnotify or websocket)
func (idx *WorkspaceIndex) UpdateFile(path string, content string) {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".go" && ext != ".js" && ext != ".ts" && ext != ".jsx" && ext != ".tsx" && ext != ".py" {
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
