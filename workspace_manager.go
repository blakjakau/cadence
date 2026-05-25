package main

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"net/http"
	"os"
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

	data, err := ioutil.ReadFile(getAppConfigPath())
	if err == nil {
		json.Unmarshal(data, &appConfig)
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
	ioutil.WriteFile(getAppConfigPath(), data, 0644)
}

func triggerDebouncedDiskSave() {
	workspaceMutex.Lock()
	defer workspaceMutex.Unlock()

	if debounceTimer != nil {
		debounceTimer.Stop()
	}
	// Write to disk 10 seconds after the last modification
	debounceTimer = time.AfterFunc(10*time.Second, func() {
		workspaceMutex.Lock()
		defer workspaceMutex.Unlock()
		for id, w := range workspaces {
			data, err := json.MarshalIndent(w, "", "  ")
			if err == nil {
				ioutil.WriteFile(getWorkspacePath(id), data, 0644)
			}
		}
	})
}

// HTTP Handlers

func appConfigHandler(w http.ResponseWriter, r *http.Request) {
	if !checkRequestAuthorization(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method == http.MethodGet {
		configMutex.Lock()
		defer configMutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(appConfig)
	} else if r.Method == http.MethodPost {
		var newConfig AppConfig
		if err := json.NewDecoder(r.Body).Decode(&newConfig); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		
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
			data, err := ioutil.ReadFile(getWorkspacePath(id))
			if err == nil {
				json.Unmarshal(data, ws)
			}
			workspaceMutex.Lock()
			workspaces[id] = ws
			workspaceMutex.Unlock()
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ws)
	} else if r.Method == http.MethodPost {
		var newWs Workspace
		if err := json.NewDecoder(r.Body).Decode(&newWs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		workspaceMutex.Lock()
		workspaces[newWs.ID] = &newWs
		workspaceMutex.Unlock()

		triggerDebouncedDiskSave()
		w.WriteHeader(http.StatusOK)
	} else if r.Method == http.MethodDelete {
		if id == "" {
			http.Error(w, "Missing workspace ID", http.StatusBadRequest)
			return
		}
		workspaceMutex.Lock()
		delete(workspaces, id)
		workspaceMutex.Unlock()

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

	files, err := ioutil.ReadDir(configDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var sessions []map[string]interface{}
	sessionMutex.Lock()
	defer sessionMutex.Unlock()

	for _, f := range files {
		if !f.IsDir() && strings.HasPrefix(f.Name(), "ai_session_") && strings.HasSuffix(f.Name(), ".json") {
			path := filepath.Join(configDir, f.Name())
			data, err := ioutil.ReadFile(path)
			if err == nil {
				var sessionData struct {
					ID           string `json:"id"`
					Name         string `json:"name"`
					CreatedAt    int64  `json:"createdAt"`
					LastModified int64  `json:"lastModified"`
				}
				if err := json.Unmarshal(data, &sessionData); err == nil && sessionData.ID != "" {
					sessions = append(sessions, map[string]interface{}{
						"id":           sessionData.ID,
						"name":         sessionData.Name,
						"createdAt":    sessionData.CreatedAt,
						"lastModified": sessionData.LastModified,
					})
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}
