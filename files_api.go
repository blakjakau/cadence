package main

import (
	"encoding/base64"
	"encoding/json"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"
)


var indexManagerInit2 sync.Once

func getIndexManagerAPI() *IndexManager {
	im := GetIndexManager()
	indexManagerInit2.Do(func() {
		im.OnStatusUpdate = func() {
			if fileWatcher != nil {
				status := map[string]interface{}{
					"roots": im.GetRoots(),
					"size":  im.GetTotalSizeFormatted(),
				}
				fileWatcher.broadcastIndexerStatus(status)
			}
		}
	})
	return im
}

// --- File API message structs ---

type fileRequest struct {
	Action    string `json:"action"` // "list", "read", "write", "watch", "search"
	Path      string `json:"path"`
	RequestId int    `json:"requestId,omitempty"` // Added to track specific requests
	Content   string `json:"content,omitempty"`   // Base64 encoded content for "write"
	Type      string `json:"type,omitempty"`      // For "search"
	Query     string `json:"query,omitempty"`     // For "search"
	StartLine int    `json:"startLine,omitempty"` // For "read" partial (1-indexed)
	LineCount int    `json:"lineCount,omitempty"` // For "read" partial
}

type fileResponse struct {
	RequestId int         `json:"requestId,omitempty"` // Echo back the request ID
	Action    string      `json:"action"`
	Path      string      `json:"path"`
	Error     string      `json:"error,omitempty"`
	Data      interface{} `json:"data,omitempty"`
}

type searchMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Content string `json:"content"`
}

type fileInfo struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // Unix timestamp
	Children []fileInfo `json:"children,omitempty"`
}

// --- File Watcher ---

// watcherManager manages fsnotify watchers and WebSocket subscribers.
type watcherManager struct {
	watcher     *fsnotify.Watcher
	subscribers map[*websocket.Conn]map[string]string // map[client]map[fullPath]reqPath
	mu          sync.Mutex
}

// Global instance of the watcher manager.
var fileWatcher *watcherManager

func init() {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Fatalf("Failed to create file watcher: %v", err)
	}
	fileWatcher = &watcherManager{
		watcher:     watcher,
		subscribers: make(map[*websocket.Conn]map[string]string),
	}
}

// run starts the watcher loop to process and broadcast file events.
func (wm *watcherManager) run() {
	for {
		select {
		case event, ok := <-wm.watcher.Events:
			if !ok {
				return
			}
			wm.broadcastEvent(event)
		case err, ok := <-wm.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("File watcher error: %v", err)
		}
	}
}

func (wm *watcherManager) addSubscription(client *websocket.Conn, reqPath string, fullPath string) {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	if _, ok := wm.subscribers[client]; !ok {
		wm.subscribers[client] = make(map[string]string)
	}
	if wm.subscribers[client][fullPath] == "" {
		wm.subscribers[client][fullPath] = reqPath
		wm.watcher.Add(fullPath)
	}
}

func (wm *watcherManager) removeClient(client *websocket.Conn) {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	// In a real app, you might want to check if a path has no more subscribers
	// and remove it from the underlying fsnotify watcher to save resources.
	delete(wm.subscribers, client)
}

func (wm *watcherManager) broadcastEvent(event fsnotify.Event) {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	for client, paths := range wm.subscribers {
		// Event could be on the watched file, or a file inside a watched directory
		reqPath, watchedFile := paths[event.Name]
		if watchedFile {
			resp := fileResponse{
				Action: "notify",
				Path:   reqPath,
				Data:   event.Op.String(), // e.g., "WRITE", "CREATE"
			}
			client.WriteJSON(resp)
		} else {
			dirPath := filepath.Dir(event.Name)
			reqPathDir, watchedDir := paths[dirPath]
			if watchedDir {
				// Construct the relative path for the child
				childName := filepath.Base(event.Name)
				childReqPath := reqPathDir
				if childReqPath == "." || childReqPath == "" {
					childReqPath = childName
				} else {
					// Use forward slash for the client web api
					childReqPath = childReqPath + "/" + childName
				}

				resp := fileResponse{
					Action: "notify",
					Path:   childReqPath,
					Data:   event.Op.String(),
				}
				client.WriteJSON(resp)
			}
		}
	}
}

func (wm *watcherManager) broadcastIndexerStatus(status interface{}) {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	resp := fileResponse{
		Action: "indexer_status",
		Data:   status,
	}
	for client := range wm.subscribers {
		client.WriteJSON(resp)
	}
}

// --- Main Handler ---

// filesApiHandler routes requests to either REST or WebSocket handlers.
func filesApiHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("[DEBUG] filesApiHandler hit from %s, Origin: %s", r.RemoteAddr, r.Header.Get("Origin"))
	// The upgrader's CheckOrigin function handles WebSocket connections.
	// For consistency, update it to use our new shared authorization function.
	upgrader.CheckOrigin = func(req *http.Request) bool {
		return checkRequestAuthorization(req)
	}
	if websocket.IsWebSocketUpgrade(r) {
		handleFileWs(w, r)
		return
	}

	// For REST calls, use the shared authorization logic.
	if !checkRequestAuthorization(r) {
		// checkRequestAuthorization logs the reason for denial internally.
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	handleFileRest(w, r)
}

// --- Security Helper ---

// securePath cleans and validates a path against the root directory.
func securePath(path string) (string, error) {
	// 1. Get absolute path of the root
	absRoot, err := filepath.Abs(fileAPIRoot)
	if err != nil {
		return "", err
	}
	// 2. Resolve symlinks for the root itself, important if root is a symlink
	absRoot, err = filepath.EvalSymlinks(absRoot)
	if err != nil {
		return "", err // e.g., root doesn't exist or permissions issue
	}
	// 3. Join and clean the requested path relative to the root
	absPath := filepath.Join(absRoot, filepath.Clean(path))
	if !strings.HasPrefix(absPath, absRoot) {
		return "", os.ErrPermission
	}
	return absPath, nil
}

// --- REST Implementation ---

func handleFileRest(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	fullPath, err := securePath(path)
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	switch r.Method {
	case http.MethodGet:
		handleRestGet(w, fullPath, path)
	case http.MethodPost:
		handleRestPost(w, r, fullPath)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleRestGet(w http.ResponseWriter, fullPath, reqPath string) {
	stat, err := os.Stat(fullPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	var respData interface{}

	if stat.IsDir() {
		// List directory
		files, err := ioutil.ReadDir(fullPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		fileList := make([]fileInfo, 0, len(files))
		for _, f := range files {
			fileList = append(fileList, fileInfo{
				Name: f.Name(), IsDir: f.IsDir(), Size: f.Size(), ModTime: f.ModTime().Unix(),
			})
		}
		respData = fileList
	} else {
		// Read file
		content, err := ioutil.ReadFile(fullPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		respData = base64.StdEncoding.EncodeToString(content)
	}

	resp := fileResponse{Action: "read", Path: reqPath, Data: respData}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func handleRestPost(w http.ResponseWriter, r *http.Request, fullPath string) {
	body, err := ioutil.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Cannot read body", http.StatusBadRequest)
		return
	}
	// Assumes raw binary content in POST body for simplicity.
	// A JSON-based approach might wrap it: {"content": "base64data"}
	err = ioutil.WriteFile(fullPath, body, 0644)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

// --- WebSocket Implementation ---

func handleFileWs(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("File WS upgrade failed: %v", err)
		return
	}
	defer ws.Close()
	defer fileWatcher.removeClient(ws)

	for {
		var req fileRequest
		if err := ws.ReadJSON(&req); err != nil {
			log.Printf("WS Read Error (client disconnected or bad JSON): %v", err)
			break
		}
		handleWsRequest(ws, req)
	}
}

func handleWsRequest(ws *websocket.Conn, req fileRequest) {
	fullPath, err := securePath(req.Path)
	if err != nil {
		ws.WriteJSON(fileResponse{Action: req.Action, Path: req.Path, Error: "Forbidden"})
		return
	}

	var resp fileResponse
	resp.Action = req.Action
	resp.Path = req.Path
	resp.RequestId = req.RequestId // Echo back the requestId

	switch req.Action {
	case "list":
		files, err := ioutil.ReadDir(fullPath)
		if err != nil {
			resp.Error = err.Error()
		} else {
			fileList := make([]fileInfo, len(files))
			for i, f := range files {
				fileList[i] = fileInfo{Name: f.Name(), IsDir: f.IsDir(), Size: f.Size(), ModTime: f.ModTime().Unix()}
			}
			resp.Data = fileList
		}
	case "read":
		content, err := ioutil.ReadFile(fullPath)
		if err != nil {
			resp.Error = err.Error()
		} else {
			if req.StartLine > 0 {
				lines := strings.Split(string(content), "\n")
				startIdx := req.StartLine - 1
				endIdx := startIdx + req.LineCount
				if startIdx < 0 {
					startIdx = 0
				}
				if endIdx > len(lines) || req.LineCount <= 0 {
					endIdx = len(lines)
				}
				if startIdx < len(lines) {
					subset := strings.Join(lines[startIdx:endIdx], "\n")
					resp.Data = base64.StdEncoding.EncodeToString([]byte(subset))
				} else {
					resp.Data = base64.StdEncoding.EncodeToString([]byte(""))
				}
			} else {
				resp.Data = base64.StdEncoding.EncodeToString(content)
			}
		}
	case "write":
		// Content is base64 encoded
		decoded, err := base64.StdEncoding.DecodeString(req.Content)
		if err != nil {
			resp.Error = "Invalid base64 content: " + err.Error()
		} else {
			err = ioutil.WriteFile(fullPath, decoded, 0644)
			if err != nil {
				resp.Error = err.Error()
			} else {
				im := getIndexManagerAPI()
				im.UpdateFile(fullPath, string(decoded))
			}
		}
	case "rename":
		newFullPath, err := securePath(req.Content)
		if err != nil {
			resp.Error = "Forbidden new path"
		} else {
			if err := os.Rename(fullPath, newFullPath); err != nil {
				resp.Error = err.Error()
			}
		}
	case "delete":
		if err := os.RemoveAll(fullPath); err != nil {
			resp.Error = err.Error()
		}
	case "watch":
		fileWatcher.addSubscription(ws, req.Path, fullPath)
		// No immediate response needed for watch, confirmations are implicit
		return
	case "search":
		if req.Type == "folder" {
			results, err := walkAndSearchFolders(fileAPIRoot, req.Query)
			if err != nil {
				resp.Error = err.Error()
			} else {
				resp.Data = results
			}
		} else if req.Type == "content" {
			results, err := walkAndSearchContent(fullPath, req.Query)
			if err != nil {
				resp.Error = err.Error()
			} else {
				resp.Data = results
			}
		} else {
			resp.Error = "Unsupported search type"
		}
	case "get_outline":
		im := getIndexManagerAPI()
		resp.Data = im.GetOutline(fullPath)
	case "search_symbols":
		im := getIndexManagerAPI()
		resp.Data = im.SearchSymbols(req.Query)
	case "set_active_roots":
		im := getIndexManagerAPI()
		var roots []string
		
		if err := json.Unmarshal([]byte(req.Content), &roots); err != nil {
			resp.Error = "Invalid roots format"
		} else {
			var secureRoots []string
			for _, r := range roots {
				if secureRoot, err := securePath(r); err == nil {
					secureRoots = append(secureRoots, secureRoot)
				}
			}
			im.SetActiveRoots(secureRoots)
			resp.Data = "ok"
		}
	case "get_indexer_status":
		im := getIndexManagerAPI()
		resp.Data = map[string]interface{}{
			"roots": im.GetRoots(),
			"size":  im.GetTotalSizeFormatted(),
		}
	default:
		resp.Error = "Unknown action"
	}

	ws.WriteJSON(resp)
}

// walkAndSearchFolders recursively searches for directories matching the query.
func walkAndSearchFolders(path, query string) ([]fileInfo, error) {
	visited := make(map[string]bool)
	return walkAndSearchFoldersHelper(path, query, visited, 0)
}

func walkAndSearchFoldersHelper(path, query string, visited map[string]bool, depth int) ([]fileInfo, error) {
	if depth > 15 {
		return nil, nil // Stop deep recursion
	}

	// Resolve the absolute path to detect circular symlinks
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	realPath, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		realPath = absPath // Fallback if eval symlinks fails
	}

	if visited[realPath] {
		return nil, nil // Circular dependency/symlink loop detected
	}
	visited[realPath] = true
	defer func() { visited[realPath] = false }() // Cleanup when unwinding

	baseName := filepath.Base(path)
	// Skip dot folders early (unless it's the exact match query)
	if strings.HasPrefix(baseName, ".") && baseName != "." && strings.ToLower(baseName) != strings.ToLower(query) {
		return nil, nil
	}
	// Skip other standard large/ignored folders early
	lowerBaseName := strings.ToLower(baseName)
	if lowerBaseName == "node_modules" || lowerBaseName == "dist" || lowerBaseName == "build" || lowerBaseName == ".pkgconfig" {
		return nil, nil
	}

	entries, err := ioutil.ReadDir(path)
	if err != nil {
		return nil, err
	}

	var foundItems []fileInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		childName := entry.Name()
		childLower := strings.ToLower(childName)
		// Skip dot folders early, unless it matches the query
		if strings.HasPrefix(childName, ".") && childLower != strings.ToLower(query) {
			continue
		}
		// Skip standard ignored folders early
		if childLower == "node_modules" || childLower == "dist" || childLower == "build" || childLower == ".pkgconfig" {
			continue
		}

		children, _ := walkAndSearchFoldersHelper(filepath.Join(path, childName), query, visited, depth+1)

		if strings.Contains(childLower, strings.ToLower(query)) || len(children) > 0 {
			item := fileInfo{
				Name:     childName,
				IsDir:    true,
				Size:     entry.Size(),
				ModTime:  entry.ModTime().Unix(),
				Children: children,
			}
			foundItems = append(foundItems, item)
		}
	}
	return foundItems, nil
}

// walkAndSearchContent recursively searches text files under rootPath for occurrences of query.
func walkAndSearchContent(rootPath, query string) ([]searchMatch, error) {
	var matches []searchMatch
	queryLower := strings.ToLower(query)
	limit := 100 // Cap results at 100 to prevent overwhelming memory or socket

	startTime := time.Now()
	timeout := 5 * time.Second

	// Map to prevent processing the same file multiple times via symlinks
	visitedFiles := make(map[string]bool)

	err := filepath.WalkDir(rootPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // Skip files we can't access
		}
		if len(matches) >= limit {
			return filepath.SkipDir // Stop walking if limit reached
		}
		if time.Since(startTime) > timeout {
			return filepath.SkipAll // Stop search if it takes longer than 5s
		}

		// Skip hidden folders and specific large/binary directories
		if d.IsDir() {
			name := d.Name()
			nameLower := strings.ToLower(name)
			if strings.HasPrefix(name, ".") && name != "." {
				return filepath.SkipDir
			}
			if nameLower == "node_modules" || nameLower == "dist" || nameLower == "build" || nameLower == ".pkgconfig" {
				return filepath.SkipDir
			}
			return nil
		}

		// Only search regular files
		if !d.Type().IsRegular() {
			return nil
		}

		// Skip files based on extension
		ext := strings.ToLower(filepath.Ext(path))
		skipExts := map[string]bool{
			".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
			".ico": true, ".pdf": true, ".zip": true, ".gz": true,
			".tar": true, ".exe": true, ".bin": true, ".dll": true,
			".mp4": true, ".mp3": true, ".wav": true, ".webp": true,
			".conduit-server": true,
			".gguf": true, ".sqlite": true, ".sqlite3": true, ".db": true,
			".7z": true, ".rar": true, ".tgz": true, ".iso": true,
			".so": true, ".dylib": true, ".onnx": true, ".mov": true,
			".avi": true, ".mkv": true, ".webm": true,
		}
		if skipExts[ext] {
			return nil
		}

		// Check file size using Lstat/Info first, before reading the whole file!
		info, err := d.Info()
		if err != nil {
			return nil // Skip files whose info we can't read
		}
		// Limit file size to 5 MB
		if info.Size() > 5 * 1024 * 1024 {
			return nil // Skip large files
		}

		// Get absolute/canonical path to prevent symlink cycle/redundancy
		absPath, err := filepath.Abs(path)
		if err == nil {
			realPath, err := filepath.EvalSymlinks(absPath)
			if err == nil {
				if visitedFiles[realPath] {
					return nil // Already processed this physical file
				}
				visitedFiles[realPath] = true
			}
		}

		// Quick check for binary: read a small prefix (up to 1024 bytes)
		file, err := os.Open(path)
		if err != nil {
			return nil
		}
		prefix := make([]byte, 1024)
		n, _ := file.Read(prefix)
		file.Close()

		for i := 0; i < n; i++ {
			if prefix[i] == 0 {
				return nil // Binary file check: found null byte
			}
		}

		// Read file content safely
		contentBytes, err := ioutil.ReadFile(path)
		if err != nil {
			return nil // Skip unreadable files
		}
		content := string(contentBytes)

		if strings.Contains(strings.ToLower(content), queryLower) {
			lines := strings.Split(content, "\n")
			relPath, err := filepath.Rel(fileAPIRoot, path)
			if err != nil {
				relPath = path
			}
			relPath = strings.ReplaceAll(filepath.ToSlash(relPath), "\\", "/")

			for idx, line := range lines {
				if strings.Contains(strings.ToLower(line), queryLower) {
					matches = append(matches, searchMatch{
						Path:    relPath,
						Line:    idx + 1,
						Content: strings.TrimSpace(line),
					})
					if len(matches) >= limit {
						break
					}
				}
			}
		}

		return nil
	})

	return matches, err
}
