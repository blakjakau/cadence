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

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"
)


// fileAPIRoot is a global variable set in main.go

// --- File API message structs ---

type fileRequest struct {
	Action    string `json:"action"` // "list", "read", "write", "watch", "search"
	Path      string `json:"path"`
	RequestId int    `json:"requestId,omitempty"` // Added to track specific requests
	Content   string `json:"content,omitempty"`   // Base64 encoded content for "write"
	Type      string `json:"type,omitempty"`      // For "search"
	Query     string `json:"query,omitempty"`     // For "search"
}

type fileResponse struct {
	RequestId int         `json:"requestId,omitempty"` // Added to echo back the request ID
	Action    string      `json:"action"`
	Path      string      `json:"path"`
	Error     string      `json:"error,omitempty"`
	Data      interface{} `json:"data,omitempty"`
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
			resp.Data = base64.StdEncoding.EncodeToString(content)
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
		} else {
			resp.Error = "Unsupported search type"
		}
	default:
		resp.Error = "Unknown action"
	}

	ws.WriteJSON(resp)
}

// walkAndSearchFolders recursively searches for directories matching the query.
func walkAndSearchFolders(path, query string) ([]fileInfo, error) {
	entries, err := ioutil.ReadDir(path)
	if err != nil {
		return nil, err
	}

	if strings.HasPrefix(filepath.Base(path), ".") && filepath.Base(path) != "." {
		return nil, nil // Skip dot files/folders themselves for top-level search
	}

	var foundItems []fileInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		children, _ := walkAndSearchFolders(filepath.Join(path, entry.Name()), query)
		
		// Skip dot folders from being added to results, unless it's the specific query.
		if strings.HasPrefix(entry.Name(), ".") && strings.ToLower(entry.Name()) != strings.ToLower(query) {
			continue
		}
		if strings.Contains(strings.ToLower(entry.Name()), strings.ToLower(query)) || len(children) > 0 {
			item := fileInfo{Name: entry.Name(), IsDir: true, Size: entry.Size(), ModTime: entry.ModTime().Unix(), Children: children}
			foundItems = append(foundItems, item)
		}
	}
	return foundItems, nil
}
