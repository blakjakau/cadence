package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type AppConfig struct {
	Folders                  []string               `json:"folders,omitempty"`
	Workspaces               []string               `json:"workspaces,omitempty"`
	SessionOptions           map[string]interface{} `json:"sessionOptions,omitempty"`
	RendererOptions          map[string]interface{} `json:"rendererOptions,omitempty"`
	EnableLiveAutocompletion interface{}            `json:"enableLiveAutocompletion,omitempty"` // bool or int
	Darkmode                 string                 `json:"darkmode,omitempty"`
	AiConfig                 map[string]interface{} `json:"aiConfig,omitempty"`
	SystemPromptConfig       map[string]interface{} `json:"systemPromptConfig,omitempty"`
	Workspace                string                 `json:"workspace,omitempty"`
	Port                     string                 `json:"port,omitempty"`
}

type Workspace struct {
	ID                 string                 `json:"id"`
	Name               string                 `json:"name"`
	Folders            []string               `json:"folders,omitempty"`
	IgnorePaths        []string               `json:"ignorePaths,omitempty"`
	Files              []interface{}          `json:"files,omitempty"`
	SidebarPanelWidths map[string]interface{} `json:"sidebarPanelWidths,omitempty"`
	Scratchpad         string                 `json:"scratchpad,omitempty"`
	AiConfig           map[string]interface{} `json:"aiConfig,omitempty"`
	SystemPromptConfig map[string]interface{} `json:"systemPromptConfig,omitempty"`
	AiSessionsMetadata []interface{}          `json:"aiSessionsMetadata,omitempty"`
	ActiveAiSessionId  interface{}            `json:"activeAiSessionId,omitempty"`
	OpenFolders        []string               `json:"openFolders,omitempty"`
	ActiveSidebarTab   interface{}            `json:"activeSidebarTab,omitempty"`
	// New fields for editor tab persistence
	ActiveEditorTabHandle string               `json:"activeEditorTabHandle,omitempty"`
	ActiveEditorSide      string               `json:"activeEditorSide,omitempty"`
	AgentConfigSide       string               `json:"agentConfigSide,omitempty"`
	PlanTasksSide         string               `json:"planTasksSide,omitempty"`
	WorkspaceSettingsSide string               `json:"workspaceSettingsSide,omitempty"`
	TerminalSettingsSide  string               `json:"terminalSettingsSide,omitempty"`
}

var (
	appConfig      AppConfig
	workspaces     = make(map[string]*Workspace)
	configDir      string
	configMutex    sync.Mutex
	workspaceMutex sync.Mutex
	sessionMutex   sync.Mutex
	debounceTimer  *time.Timer
)

func initWorkspaceManager() {
	userConfigDir, err := os.UserConfigDir()
	if err != nil {
		log.Printf("Error getting user config dir, falling back to .cadence: %v", err)
		userConfigDir = "."
	}
	configDir = filepath.Join(userConfigDir, "cadence")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		log.Printf("Failed to create config dir: %v", err)
	}

	var errDB error
	globalDB, errDB = openCadenceDB(configDir)
	if errDB != nil {
		log.Printf("[WorkspaceManager] Warning: failed to open CadenceDB: %v", errDB)
	} else {
		log.Printf("[WorkspaceManager] Initialized CadenceDB at %s", filepath.Join(configDir, "cadence.db"))
	}

	loadAppConfig()
}

func getAppConfigPath() string {
	return filepath.Join(configDir, "appConfig.json")
}

func getWorkspacePath(id string) string {
	return filepath.Join(configDir, "workspace_"+id+".json")
}

func getSessionPath(id string) string {
	return filepath.Join(configDir, "ai_session_"+id+".json")
}

func loadAppConfig() {
	configMutex.Lock()
	defer configMutex.Unlock()

	loaded := false
	if globalDB != nil {
		data, err := globalDB.GetAppConfig()
		if err == nil && len(data) > 0 {
			if err := json.Unmarshal(data, &appConfig); err == nil {
				loaded = true
			}
		}
	}

	if !loaded {
		data, err := ioutil.ReadFile(getAppConfigPath())
		if err == nil {
			json.Unmarshal(data, &appConfig)
		}
	}

	if appConfig.Workspaces == nil {
		appConfig.Workspaces = []string{"default"}
	}
}

func saveAppConfigToDisk() {
	configMutex.Lock()
	defer configMutex.Unlock()

	data, err := json.MarshalIndent(appConfig, "", "  ")
	if err != nil {
		log.Printf("Failed to marshal AppConfig: %v", err)
		return
	}

	if globalDB != nil {
		_ = globalDB.PutAppConfig(data)
	}
	ioutil.WriteFile(getAppConfigPath(), data, 0644)
}

// HTTP Handlers

func appConfigHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method == http.MethodGet {
		configMutex.Lock()
		appConfig.Port = port
		configMutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		configMutex.Lock()
		defer configMutex.Unlock()
		json.NewEncoder(w).Encode(appConfig)
	} else if r.Method == http.MethodPost {
		var newConfig AppConfig
		if err := json.NewDecoder(r.Body).Decode(&newConfig); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		
		newConfig.Port = "" // Do not persist port to disk
		configMutex.Lock()
		appConfig = newConfig
		configMutex.Unlock()

		saveAppConfigToDisk()
		w.WriteHeader(http.StatusOK)
	} else {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func workspaceHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	id := r.URL.Query().Get("id")

	if r.Method == http.MethodGet {
		if id == "" {
			http.Error(w, "Missing workspace ID", http.StatusBadRequest)
			return
		}
		workspaceMutex.Lock()
		ws, exists := workspaces[id]
		workspaceMutex.Unlock()

		if !exists {
			ws = &Workspace{ID: id, Name: id}
			loaded := false
			if globalDB != nil {
				data, err := globalDB.GetWorkspace(id)
				if err == nil && len(data) > 0 {
					if err := json.Unmarshal(data, ws); err == nil {
						loaded = true
					}
				}
			}
			if !loaded {
				data, err := ioutil.ReadFile(getWorkspacePath(id))
				if err == nil {
					json.Unmarshal(data, ws)
				}
			}
			workspaceMutex.Lock()
			workspaces[id] = ws
			workspaceMutex.Unlock()
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ws)
	} else if r.Method == http.MethodPost {
		data, err := ioutil.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var newWs Workspace
		if err := json.Unmarshal(data, &newWs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		workspaceMutex.Lock()
		workspaces[newWs.ID] = &newWs
		workspaceMutex.Unlock()

		// Save immediately to CadenceDB for ACID persistence
		if globalDB != nil {
			if err := globalDB.PutWorkspace(newWs.ID, data); err != nil {
				log.Printf("[WorkspaceManager] Failed to put workspace %s to DB: %v", newWs.ID, err)
			}
		}

		w.WriteHeader(http.StatusOK)
	} else if r.Method == http.MethodDelete {
		if id == "" {
			http.Error(w, "Missing workspace ID", http.StatusBadRequest)
			return
		}
		workspaceMutex.Lock()
		delete(workspaces, id)
		workspaceMutex.Unlock()

		if globalDB != nil {
			_ = globalDB.DeleteWorkspace(id)
		}
		os.Remove(getWorkspacePath(id))
		w.WriteHeader(http.StatusOK)
	} else {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func sessionHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	id := r.URL.Query().Get("id")

	if r.Method == http.MethodGet {
		if id == "" {
			http.Error(w, "Missing session ID", http.StatusBadRequest)
			return
		}
		if globalDB != nil {
			data, rev, err := globalDB.GetSession(id)
			if err == nil {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Session-Revision", fmt.Sprintf("%d", rev))
				w.Write(data)
				return
			}
		}
		// Fallback to legacy file read if not found in DB
		path := getSessionPath(id)
		sessionMutex.Lock()
		data, err := ioutil.ReadFile(path)
		sessionMutex.Unlock()
		if err != nil {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	} else if r.Method == http.MethodPost {
		idFromQuery := id
		data, err := ioutil.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Try to extract ID from JSON if not provided in URL
		if idFromQuery == "" {
			var sessionData struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(data, &sessionData); err == nil && sessionData.ID != "" {
				idFromQuery = sessionData.ID
			} else {
				http.Error(w, "Missing session ID", http.StatusBadRequest)
				return
			}
		}

		if globalDB != nil {
			rev, err := globalDB.PutSession(idFromQuery, data)
			if err != nil {
				log.Printf("[WorkspaceManager] Failed to put session %s to DB: %v", idFromQuery, err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("X-Session-Revision", fmt.Sprintf("%d", rev))
			w.WriteHeader(http.StatusOK)
			return
		}

		// Fallback to disk write if DB not available
		path := getSessionPath(idFromQuery)
		sessionMutex.Lock()
		ioutil.WriteFile(path, data, 0644)
		sessionMutex.Unlock()
		w.WriteHeader(http.StatusOK)
	} else if r.Method == http.MethodDelete {
		if id == "" {
			http.Error(w, "Missing session ID", http.StatusBadRequest)
			return
		}
		if globalDB != nil {
			_ = globalDB.DeleteSession(id)
		}
		path := getSessionPath(id)
		sessionMutex.Lock()
		os.Remove(path)
		sessionMutex.Unlock()
		w.WriteHeader(http.StatusOK)
	} else {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func sessionsHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// First attempt instant in-memory index read via bbolt
	if globalDB != nil {
		sessions, err := globalDB.ListSessions()
		if err == nil {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(sessions)
			return
		}
		log.Printf("[WorkspaceManager] ListSessions from DB failed: %v, falling back to disk", err)
	}

	// Legacy fallback: scan directory files
	files, err := ioutil.ReadDir(configDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var sessions []map[string]interface{}
	sessionMutex.Lock()
	defer sessionMutex.Unlock()

	for _, f := range files {
		if !f.IsDir() && strings.HasPrefix(f.Name(), "ai_session_") && strings.HasSuffix(f.Name(), ".json") && !strings.HasSuffix(f.Name(), ".bak") {
			path := filepath.Join(configDir, f.Name())
			data, err := ioutil.ReadFile(path)
			if err == nil {
				var sessionData struct {
					ID              string `json:"id"`
					Name            string `json:"name"`
					ParentID        string `json:"parentId"`
					CreatedAt       int64  `json:"createdAt"`
					LastModified    int64  `json:"lastModified"`
					CompletedResult string `json:"completedResult"`
				}
				if err := json.Unmarshal(data, &sessionData); err == nil && sessionData.ID != "" {
					sessions = append(sessions, map[string]interface{}{
						"id":              sessionData.ID,
						"name":            sessionData.Name,
						"parentId":        sessionData.ParentID,
						"createdAt":       sessionData.CreatedAt,
						"lastModified":    sessionData.LastModified,
						"completedResult": sessionData.CompletedResult,
					})
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

func dbStatsHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if globalDB != nil {
		stats, err := globalDB.GetDBStats()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
		return
	}

	http.Error(w, "Database not initialized", http.StatusServiceUnavailable)
}


type SyntaxCheckRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type SyntaxCheckResponse struct {
	Valid         bool   `json:"valid"`
	Error         string `json:"error,omitempty"`
	NodeAvailable bool   `json:"nodeAvailable"`
}

func checkSyntaxHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SyntaxCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	nodePath, err := exec.LookPath("node")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SyntaxCheckResponse{
			Valid:         true,
			NodeAvailable: false,
		})
		return
	}

	ext := strings.ToLower(filepath.Ext(req.Path))
	if ext == ".json" {
		w.Header().Set("Content-Type", "application/json")
		if !json.Valid([]byte(req.Content)) {
			// Find detailed error using json.Unmarshal
			var dummy interface{}
			jsonErr := json.Unmarshal([]byte(req.Content), &dummy)
			errMsg := "Invalid JSON syntax"
			if jsonErr != nil {
				errMsg = jsonErr.Error()
			}
			json.NewEncoder(w).Encode(SyntaxCheckResponse{
				Valid:         false,
				Error:         errMsg,
				NodeAvailable: true,
			})
			return
		}
		json.NewEncoder(w).Encode(SyntaxCheckResponse{
			Valid:         true,
			NodeAvailable: true,
		})
		return
	}

	if ext != ".js" && ext != ".mjs" && ext != ".cjs" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SyntaxCheckResponse{
			Valid:         true,
			NodeAvailable: true,
		})
		return
	}

	args := []string{"--check"}
	if ext == ".cjs" {
		args = append(args, "--input-type=commonjs")
	} else if ext == ".js" || ext == ".mjs" {
		args = append(args, "--input-type=module")
	}

	cmd := exec.Command(nodePath, args...)
	cmd.Stdin = strings.NewReader(req.Content)

	var stderr strings.Builder
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	w.Header().Set("Content-Type", "application/json")

	if runErr != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = runErr.Error()
		}
		json.NewEncoder(w).Encode(SyntaxCheckResponse{
			Valid:         false,
			Error:         errMsg,
			NodeAvailable: true,
		})
		return
	}

	json.NewEncoder(w).Encode(SyntaxCheckResponse{
		Valid:         true,
		NodeAvailable: true,
	})
}
