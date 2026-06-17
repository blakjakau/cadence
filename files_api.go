package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	ModTime   int64       `json:"modTime,omitempty"`
	FullPath  string      `json:"fullPath,omitempty"`
	Size      int64       `json:"size,omitempty"`
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
			safeWriteJSON(client, resp)
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
				safeWriteJSON(client, resp)
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
		safeWriteJSON(client, resp)
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

	// If the path is absolute and under absRoot, make it relative to absRoot first
	// to avoid duplicate path prefix issues.
	cleanedPath := filepath.Clean(path)
	if filepath.IsAbs(cleanedPath) {
		if rel, err := filepath.Rel(absRoot, cleanedPath); err == nil && !strings.HasPrefix(rel, "..") {
			path = rel
		}
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

	resp := fileResponse{
		Action:   "read",
		Path:     reqPath,
		Data:     respData,
		ModTime:  stat.ModTime().Unix(),
		FullPath: filepath.ToSlash(fullPath),
		Size:     stat.Size(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func handleRestPost(w http.ResponseWriter, r *http.Request, fullPath string) {
	body, err := ioutil.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Cannot read body", http.StatusBadRequest)
		return
	}
	// Automatically create paths to the folder if they don't exist
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "Failed to create directory: "+err.Error(), http.StatusInternalServerError)
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
	defer cancelActiveSearch(ws)
	defer cleanupWsWriteMutex(ws)

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
	log.Printf("[DEBUG] WS Request: action=%s, path=%s, requestId=%d", req.Action, req.Path, req.RequestId)
	fullPath, err := securePath(req.Path)
	if err != nil {
		log.Printf("[DEBUG] WS Error: securePath failed for path %s: %v", req.Path, err)
		safeWriteJSON(ws, fileResponse{Action: req.Action, Path: req.Path, Error: "Forbidden"})
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
			if stat, statErr := os.Stat(fullPath); statErr == nil {
				resp.ModTime = stat.ModTime().Unix()
				resp.FullPath = filepath.ToSlash(fullPath)
				resp.Size = stat.Size()
			}
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
			// Automatically create paths to the folder if they don't exist
			dir := filepath.Dir(fullPath)
			if err := os.MkdirAll(dir, 0755); err != nil {
				resp.Error = "Failed to create directory: " + err.Error()
			} else {
				err = ioutil.WriteFile(fullPath, decoded, 0644)
				if err != nil {
					resp.Error = err.Error()
				} else {
					im := getIndexManagerAPI()
					im.UpdateFile(fullPath, string(decoded))
					if stat, statErr := os.Stat(fullPath); statErr == nil {
						resp.ModTime = stat.ModTime().Unix()
						resp.FullPath = filepath.ToSlash(fullPath)
						resp.Size = stat.Size()
					}
				}
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
		} else if req.Type == "grep" {
			go startGrepSearch(ws, req.RequestId, req.Query)
			return // Return early, streaming handles responses
		} else {
			resp.Error = "Unsupported search type"
		}
	case "get_outline":
		im := getIndexManagerAPI()
		resp.Data = im.GetOutline(fullPath)
	case "get_file_symbols":
		im := getIndexManagerAPI()
		resp.Data = im.GetFileSymbols(fullPath)
	case "search_symbols":
		im := getIndexManagerAPI()
		resp.Data = im.SearchSymbols(req.Query)
	case "set_active_roots":
		im := getIndexManagerAPI()
		var payload struct {
			Roots       []string `json:"roots"`
			IgnorePaths []string `json:"ignorePaths"`
		}
		var roots []string
		var ignorePaths []string
		
		if err := json.Unmarshal([]byte(req.Content), &payload); err == nil && len(payload.Roots) > 0 {
			roots = payload.Roots
			ignorePaths = payload.IgnorePaths
		} else {
			// Fallback to legacy string array format
			if err := json.Unmarshal([]byte(req.Content), &roots); err != nil {
				resp.Error = "Invalid roots format"
			}
		}
		
		if resp.Error == "" {
			var secureRoots []string
			for _, r := range roots {
				if secureRoot, err := securePath(r); err == nil {
					secureRoots = append(secureRoots, secureRoot)
				}
			}
			im.SetActiveRoots(secureRoots, ignorePaths)
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

	log.Printf("[DEBUG] WS Response: action=%s, path=%s, requestId=%d, error=%s", resp.Action, resp.Path, resp.RequestId, resp.Error)
	safeWriteJSON(ws, resp)
}

// walkAndSearchFolders recursively searches for directories matching the query.
func walkAndSearchFolders(path, query string) ([]fileInfo, error) {
	im := getIndexManagerAPI()
	var matchingIdx *WorkspaceIndex
	im.mu.RLock()
	for root, idx := range im.Indexes {
		if path == root || strings.HasPrefix(path, root+string(filepath.Separator)) {
			matchingIdx = idx
			break
		}
	}
	im.mu.RUnlock()

	visited := make(map[string]bool)
	return walkAndSearchFoldersHelper(path, query, visited, 0, matchingIdx)
}

func walkAndSearchFoldersHelper(path, query string, visited map[string]bool, depth int, matchingIdx *WorkspaceIndex) ([]fileInfo, error) {
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
	if matchingIdx != nil && matchingIdx.IsPathIgnored(path) {
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

		childPath := filepath.Join(path, childName)
		if matchingIdx != nil && matchingIdx.IsPathIgnored(childPath) {
			continue
		}

		children, _ := walkAndSearchFoldersHelper(childPath, query, visited, depth+1, matchingIdx)

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
	im := getIndexManagerAPI()
	var matchingIdx *WorkspaceIndex
	im.mu.RLock()
	for root, idx := range im.Indexes {
		if rootPath == root || strings.HasPrefix(rootPath, root+string(filepath.Separator)) {
			matchingIdx = idx
			break
		}
	}
	im.mu.RUnlock()

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

		if matchingIdx != nil && matchingIdx.IsPathIgnored(path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
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
		// Limit file size to 0.5 MB
		if info.Size() > 512 * 1024 {
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

		// Quick check for binary
		if isBinaryFile(path) {
			return nil
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

func isBinaryFile(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()

	buf := make([]byte, 1024)
	n, _ := file.Read(buf)
	for i := 0; i < n; i++ {
		if buf[i] == 0 {
			return true
		}
	}
	return false
}


var (
	wsWriteMutexes   = make(map[*websocket.Conn]*sync.Mutex)
	wsWriteMutexesMu sync.Mutex
)

func getWsWriteMutex(ws *websocket.Conn) *sync.Mutex {
	wsWriteMutexesMu.Lock()
	defer wsWriteMutexesMu.Unlock()
	mu, ok := wsWriteMutexes[ws]
	if !ok {
		mu = &sync.Mutex{}
		wsWriteMutexes[ws] = mu
	}
	return mu
}

func cleanupWsWriteMutex(ws *websocket.Conn) {
	wsWriteMutexesMu.Lock()
	defer wsWriteMutexesMu.Unlock()
	delete(wsWriteMutexes, ws)
}

func safeWriteJSON(ws *websocket.Conn, v interface{}) error {
	mu := getWsWriteMutex(ws)
	mu.Lock()
	defer mu.Unlock()
	return ws.WriteJSON(v)
}

// --- Active Search Process Manager ---

type activeSearch struct {
	cmds   []*exec.Cmd
	cancel context.CancelFunc
}

var (
	activeSearches   = make(map[*websocket.Conn]*activeSearch)
	activeSearchesMu sync.Mutex
)

func cancelActiveSearch(ws *websocket.Conn) {
	activeSearchesMu.Lock()
	defer activeSearchesMu.Unlock()
	if search, ok := activeSearches[ws]; ok {
		if search.cancel != nil {
			search.cancel()
		}
		for _, cmd := range search.cmds {
			if cmd != nil && cmd.Process != nil {
				cmd.Process.Kill()
			}
		}
		delete(activeSearches, ws)
	}
}

func startGrepSearch(ws *websocket.Conn, reqId int, query string) {
	// Cancel previous search
	cancelActiveSearch(ws)

	im := getIndexManagerAPI()
	im.mu.RLock()
	type rootInfo struct {
		path        string
		ignorePaths []string
	}
	var roots []rootInfo
	for path, idx := range im.Indexes {
		idx.mu.RLock()
		ignores := make([]string, len(idx.IgnorePaths))
		copy(ignores, idx.IgnorePaths)
		idx.mu.RUnlock()
		roots = append(roots, rootInfo{path: path, ignorePaths: ignores})
	}
	im.mu.RUnlock()

	if len(roots) == 0 {
		safeWriteJSON(ws, fileResponse{
			RequestId: reqId,
			Action:    "search_done",
			Path:      ".",
			Data:      0,
		})
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	searchTracker := &activeSearch{
		cancel: cancel,
	}

	activeSearchesMu.Lock()
	activeSearches[ws] = searchTracker
	activeSearchesMu.Unlock()

	matchChan := make(chan []interface{}, 200)
	var wg sync.WaitGroup

	for _, root := range roots {
		wg.Add(1)
		go func(r rootInfo) {
			defer wg.Done()

			args := []string{"-rnIi", "--line-buffered"}
			args = append(args, "--exclude-dir=.*")
			args = append(args, "--exclude=.*")
			args = append(args, "--exclude-dir=node_modules")
			args = append(args, "--exclude-dir=dist")
			args = append(args, "--exclude-dir=build")
			args = append(args, "--exclude-dir=.pkgconfig")

			for _, ip := range r.ignorePaths {
				ip = strings.TrimSpace(ip)
				if ip == "" {
					continue
				}
				args = append(args, "--exclude-dir="+ip)
				args = append(args, "--exclude="+ip)
			}
			args = append(args, "-e", query, r.path)

			cmd := exec.CommandContext(ctx, "grep", args...)

			// Register cmd so it can be killed on cancel
			activeSearchesMu.Lock()
			if activeSearches[ws] == searchTracker {
				searchTracker.cmds = append(searchTracker.cmds, cmd)
			} else {
				activeSearchesMu.Unlock()
				return
			}
			activeSearchesMu.Unlock()

			stdout, err := cmd.StdoutPipe()
			if err != nil {
				return
			}

			if err := cmd.Start(); err != nil {
				return
			}

			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				select {
				case <-ctx.Done():
					return
				default:
					line := scanner.Text()
					line = strings.TrimSpace(line)
					if line == "" {
						continue
					}

					firstColon := strings.Index(line, ":")
					if firstColon == -1 {
						continue
					}
					if firstColon == 1 && len(line) > 2 && line[2] == '\\' {
						nextColon := strings.Index(line[firstColon+1:], ":")
						if nextColon == -1 {
							continue
						}
						firstColon = firstColon + 1 + nextColon
					}

					filePath := line[:firstColon]
					rest := line[firstColon+1:]

					secondColon := strings.Index(rest, ":")
					if secondColon == -1 {
						continue
					}

					lineNumStr := rest[:secondColon]
					snippet := rest[secondColon+1:]

					lineNum, err := strconv.Atoi(lineNumStr)
					if err != nil {
						continue
					}

					relPath, err := filepath.Rel(fileAPIRoot, filePath)
					if err != nil {
						relPath = filePath
					}
					relPath = strings.ReplaceAll(filepath.ToSlash(relPath), "\\", "/")

					select {
					case matchChan <- []interface{}{relPath, lineNum, strings.TrimSpace(snippet)}:
					case <-ctx.Done():
						return
					}
				}
			}

			cmd.Wait()
		}(root)
	}

	// Writer goroutine
	go func() {
		defer cancelActiveSearch(ws) // Cleanup active search tracking when done

		limit := 500
		count := 0

		for {
			select {
			case match, ok := <-matchChan:
				if !ok {
					goto done
				}
				if count < limit {
					safeWriteJSON(ws, fileResponse{
						RequestId: reqId,
						Action:    "search_match",
						Data:      match,
					})
					count++
				}
			case <-ctx.Done():
				goto done
			}
		}

	done:
		safeWriteJSON(ws, fileResponse{
			RequestId: reqId,
			Action:    "search_done",
			Data:      count,
		})
	}()

	// Wait for searches and close chan
	go func() {
		wg.Wait()
		close(matchChan)
	}()
}
