package main

import (
	"encoding/json"
	"io/ioutil"
	"os"
	"path/filepath"
	"testing"
)

func TestCadenceDB(t *testing.T) {
	tempDir, err := ioutil.TempDir("", "cadence_db_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a dummy legacy session file and workspace file
	legacySessionID := "ai-session-test-123"
	legacySessionData := []byte(`{"id":"ai-session-test-123","name":"Test Chat","parentId":"","createdAt":1000,"lastModified":2000,"messages":[{"role":"user","content":"hello"}]}`)
	err = ioutil.WriteFile(filepath.Join(tempDir, "ai_session_"+legacySessionID+".json"), legacySessionData, 0644)
	if err != nil {
		t.Fatalf("Failed to write legacy session: %v", err)
	}

	legacyWsID := "test_ws"
	legacyWsData := []byte(`{"id":"test_ws","name":"Test Workspace"}`)
	err = ioutil.WriteFile(filepath.Join(tempDir, "workspace_"+legacyWsID+".json"), legacyWsData, 0644)
	if err != nil {
		t.Fatalf("Failed to write legacy workspace: %v", err)
	}

	// Open DB (triggers migration)
	db, err := openCadenceDB(tempDir)
	if err != nil {
		t.Fatalf("Failed to open CadenceDB: %v", err)
	}
	defer db.Close()

	// Verify legacy files were renamed to .bak
	if _, err := os.Stat(filepath.Join(tempDir, "ai_session_"+legacySessionID+".json.bak")); os.IsNotExist(err) {
		t.Errorf("Expected legacy session file to be renamed to .bak")
	}
	if _, err := os.Stat(filepath.Join(tempDir, "workspace_"+legacyWsID+".json.bak")); os.IsNotExist(err) {
		t.Errorf("Expected legacy workspace file to be renamed to .bak")
	}

	// Verify migrated session is readable
	sessionBytes, rev, err := db.GetSession(legacySessionID)
	if err != nil {
		t.Fatalf("Failed to get migrated session: %v", err)
	}
	if rev != 1 {
		t.Errorf("Expected revision 1, got %d", rev)
	}
	var loadedSession struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(sessionBytes, &loadedSession); err != nil || loadedSession.Name != "Test Chat" {
		t.Errorf("Unexpected session data: %s", string(sessionBytes))
	}

	// Verify ListSessions contains migrated session
	list, err := db.ListSessions()
	if err != nil {
		t.Fatalf("Failed to list sessions: %v", err)
	}
	if len(list) != 1 || list[0]["id"] != legacySessionID {
		t.Errorf("Unexpected sessions list: %+v", list)
	}

	// Put new session
	newSessionID := "ai-session-new-456"
	newSessionData := []byte(`{"id":"ai-session-new-456","name":"New Chat","createdAt":3000,"lastModified":4000,"messages":[]}`)
	newRev, err := db.PutSession(newSessionID, newSessionData)
	if err != nil {
		t.Fatalf("Failed to put new session: %v", err)
	}
	if newRev != 1 {
		t.Errorf("Expected new session revision 1, got %d", newRev)
	}

	// Update existing session -> revision should increment to 2
	updatedSessionData := []byte(`{"id":"ai-session-new-456","name":"New Chat Updated","createdAt":3000,"lastModified":5000,"messages":[{"role":"user","content":"ping"}]}`)
	upRev, err := db.PutSession(newSessionID, updatedSessionData)
	if err != nil {
		t.Fatalf("Failed to update session: %v", err)
	}
	if upRev != 2 {
		t.Errorf("Expected updated revision 2, got %d", upRev)
	}

	// Verify update
	gotData, gotRev, err := db.GetSession(newSessionID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}
	if gotRev != 2 {
		t.Errorf("Expected gotRev 2, got %d", gotRev)
	}
	if err := json.Unmarshal(gotData, &loadedSession); err != nil || loadedSession.Name != "New Chat Updated" {
		t.Errorf("Unexpected updated session data: %s", string(gotData))
	}

	// Verify delete
	err = db.DeleteSession(legacySessionID)
	if err != nil {
		t.Fatalf("Failed to delete session: %v", err)
	}
	_, _, err = db.GetSession(legacySessionID)
	if err != os.ErrNotExist {
		t.Errorf("Expected os.ErrNotExist, got %v", err)
	}

	// Test Workspace operations
	wsBytes, err := db.GetWorkspace(legacyWsID)
	if err != nil {
		t.Fatalf("Failed to get migrated workspace: %v", err)
	}
	var ws struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(wsBytes, &ws); err != nil || ws.Name != "Test Workspace" {
		t.Errorf("Unexpected workspace: %s", string(wsBytes))
	}

	// Put workspace
	err = db.PutWorkspace("ws2", []byte(`{"id":"ws2","name":"Second WS"}`))
	if err != nil {
		t.Fatalf("Failed to put workspace: %v", err)
	}
	ws2Bytes, err := db.GetWorkspace("ws2")
	if err != nil || string(ws2Bytes) != `{"id":"ws2","name":"Second WS"}` {
		t.Errorf("Unexpected ws2: %s", string(ws2Bytes))
	}

	// Delete workspace
	err = db.DeleteWorkspace("ws2")
	if err != nil {
		t.Fatalf("Failed to delete workspace: %v", err)
	}
	_, err = db.GetWorkspace("ws2")
	if err != os.ErrNotExist {
		t.Errorf("Expected os.ErrNotExist for deleted workspace, got %v", err)
	}

	// Test GetDBStats
	stats, err := db.GetDBStats()
	if err != nil {
		t.Fatalf("Failed to get DB stats: %v", err)
	}
	if stats.SizeBytes <= 0 {
		t.Errorf("Expected positive DB file size, got %d", stats.SizeBytes)
	}
	if stats.SessionCount != 1 {
		t.Errorf("Expected 1 session in DB stats, got %d", stats.SessionCount)
	}
	if stats.WorkspaceCount != 1 {
		t.Errorf("Expected 1 workspace in DB stats, got %d", stats.WorkspaceCount)
	}

	// Verify cadence.db.bak was created during launch
	bakPath := filepath.Join(tempDir, "cadence.db.bak")
	bakFi, err := os.Stat(bakPath)
	if err != nil || bakFi.Size() == 0 {
		t.Errorf("Expected cadence.db.bak to exist with size > 0, got err: %v", err)
	}

	// Verify database can be closed and re-opened cleanly with backup and compaction
	db.Close()
	reopened, err := openCadenceDB(tempDir)
	if err != nil {
		t.Fatalf("Failed to reopen CadenceDB: %v", err)
	}
	defer reopened.Close()

	sessCheck, _, err := reopened.GetSession(newSessionID)
	if err != nil || len(sessCheck) == 0 {
		t.Errorf("Failed to read session after compaction and reopen: %v", err)
	}
}

// TestCadenceDB_FreshAndDeleted verifies that creating a DB works properly:
// 1. In a completely fresh directory without existing DB or legacy files.
// 2. When the db file is deleted while the app is stopped and restarted.
func TestCadenceDB_FreshAndDeleted(t *testing.T) {
	tempDir, err := ioutil.TempDir("", "cadence_db_fresh_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Case 1: Fresh instance (empty directory, brand new DB creation)
	db, err := openCadenceDB(tempDir)
	if err != nil {
		t.Fatalf("Failed to open brand new CadenceDB in empty dir: %v", err)
	}

	// Verify buckets and basic operations on brand new DB
	sessID := "ai-session-fresh-1"
	sessData := []byte(`{"id":"ai-session-fresh-1","name":"Fresh Chat","messages":[]}`)
	rev, err := db.PutSession(sessID, sessData)
	if err != nil || rev != 1 {
		t.Fatalf("Failed to PutSession on fresh DB: err=%v, rev=%d", err, rev)
	}

	readData, readRev, err := db.GetSession(sessID)
	if err != nil || readRev != 1 || len(readData) == 0 {
		t.Fatalf("Failed to GetSession on fresh DB: err=%v, rev=%d", err, readRev)
	}

	stats, err := db.GetDBStats()
	if err != nil || stats.SessionCount != 1 {
		t.Fatalf("Failed to GetDBStats on fresh DB: err=%v, stats=%+v", err, stats)
	}

	// Close cleanly
	if err := db.Close(); err != nil {
		t.Fatalf("Failed to close DB: %v", err)
	}

	// Case 2: DB file is deleted (simulating user or tool deleting cadence.db)
	dbPath := filepath.Join(tempDir, "cadence.db")
	if err := os.Remove(dbPath); err != nil {
		t.Fatalf("Failed to delete cadence.db: %v", err)
	}

	// Reopen after DB file deletion
	recreatedDB, err := openCadenceDB(tempDir)
	if err != nil {
		t.Fatalf("Failed to reopen/recreate CadenceDB after cadence.db deletion: %v", err)
	}
	defer recreatedDB.Close()

	// Verify it starts fresh and operations work seamlessly
	recreatedStats, err := recreatedDB.GetDBStats()
	if err != nil {
		t.Fatalf("Failed to get stats on recreated DB: %v", err)
	}
	if recreatedStats.SessionCount != 0 {
		t.Errorf("Expected 0 sessions in recreated DB, got %d", recreatedStats.SessionCount)
	}

	// Verify writing and reading in recreated DB works
	recreatedSessID := "ai-session-recreated-1"
	recreatedSessData := []byte(`{"id":"ai-session-recreated-1","name":"Recreated Chat","messages":[]}`)
	rev2, err := recreatedDB.PutSession(recreatedSessID, recreatedSessData)
	if err != nil || rev2 != 1 {
		t.Fatalf("Failed to PutSession on recreated DB: err=%v, rev=%d", err, rev2)
	}

	readData2, readRev2, err := recreatedDB.GetSession(recreatedSessID)
	if err != nil || readRev2 != 1 || len(readData2) == 0 {
		t.Fatalf("Failed to GetSession on recreated DB: err=%v, rev=%d", err, readRev2)
	}

	// Verify cadence.db.bak exists and is valid
	bakPath := filepath.Join(tempDir, "cadence.db.bak")
	if _, err := os.Stat(bakPath); err != nil {
		t.Errorf("Expected cadence.db.bak to exist after recreation, got err: %v", err)
	}
}



