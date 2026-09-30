package main

import (
	"encoding/json"
	"errors"
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

// TestCadenceDB_ArchiveCycleSpan verifies the atomic span move:
//  - the raw messages are removed from the main session record
//  - the span is appended to the per-session archive document
//  - the operation is idempotent (a second call is a no-op)
//  - the originating cycle_summary is marked archived
//  - DeleteSession also removes the archive key
func TestCadenceDB_ArchiveCycleSpan(t *testing.T) {
	tempDir, err := ioutil.TempDir("", "cadence_db_archive_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	db, err := openCadenceDB(tempDir)
	if err != nil {
		t.Fatalf("Failed to open CadenceDB: %v", err)
	}
	defer db.Close()

	sessID := "ai-session-archive-1"
	// A main session with a raw span (m1..m4) plus a cycle_summary (s1) that
	// points at the span and is NOT yet archived.
	sessionJSON := []byte(`{` +
		`"id":"ai-session-archive-1","name":"Archive Chat","createdAt":1000,"lastModified":2000,` +
		`"messages":[` +
		`{"id":"m0","type":"user","content":"before"},` +
		`{"id":"m1","type":"user","content":"c1"},` +
		`{"id":"m2","type":"model","content":"c2"},` +
		`{"id":"m3","type":"tool_response","content":"c3"},` +
		`{"id":"s1","type":"cycle_summary","title":"Cycle","content":"sum","cycleStartMsgId":"m1","cycleEndMsgId":"m3"},` +
		`{"id":"m4","type":"user","content":"after"}` +
		`]}`)
	if _, err := db.PutSession(sessID, sessionJSON); err != nil {
		t.Fatalf("Failed to put session: %v", err)
	}

	// No archive record yet.
	if _, err := db.GetSessionArchive(sessID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Expected os.ErrNotExist for empty archive, got %v", err)
	}

	// Archive the raw span (m1..m3) and mark summary s1 archived.
	archived, err := db.ArchiveCycleSpan(sessID, []string{"m1", "m2", "m3"}, "s1")
	if err != nil {
		t.Fatalf("ArchiveCycleSpan failed: %v", err)
	}
	if len(archived) != 3 {
		t.Fatalf("Expected 3 archived IDs, got %d (%v)", len(archived), archived)
	}

	// Main record: m1..m3 removed, m0/m4/s1 kept, s1 marked archived.
	sessBytes, _, err := db.GetSession(sessID)
	if err != nil {
		t.Fatalf("GetSession after archive: %v", err)
	}
	var main struct {
		Messages []struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			Archived bool   `json:"archived"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(sessBytes, &main); err != nil {
		t.Fatalf("Unmarshal main session: %v", err)
	}
	keptIDs := make([]string, 0, len(main.Messages))
	s1Archived := false
	for _, m := range main.Messages {
		keptIDs = append(keptIDs, m.ID)
		if m.ID == "s1" && m.Archived {
			s1Archived = true
		}
	}
	if len(keptIDs) != 3 {
		t.Fatalf("Expected 3 kept messages, got %d (%v)", len(keptIDs), keptIDs)
	}
	if !s1Archived {
		t.Errorf("Expected summary s1 to be marked archived in main record")
	}
	for _, forbidden := range []string{"m1", "m2", "m3"} {
		for _, k := range keptIDs {
			if k == forbidden {
				t.Errorf("Message %s should have been removed from main record", forbidden)
			}
		}
	}

	// Archive document: exactly one span with the moved messages in order.
	archBytes, err := db.GetSessionArchive(sessID)
	if err != nil {
		t.Fatalf("GetSessionArchive: %v", err)
	}
	var doc struct {
		Spans []struct {
			StartMsgID string `json:"startMsgId"`
			EndMsgID   string `json:"endMsgId"`
			Messages   []struct {
				ID string `json:"id"`
			} `json:"messages"`
		} `json:"spans"`
	}
	if err := json.Unmarshal(archBytes, &doc); err != nil {
		t.Fatalf("Unmarshal archive doc: %v", err)
	}
	if len(doc.Spans) != 1 {
		t.Fatalf("Expected 1 archived span, got %d", len(doc.Spans))
	}
	span := doc.Spans[0]
	if span.StartMsgID != "m1" || span.EndMsgID != "m3" {
		t.Errorf("Expected span [m1..m3], got [%s..%s]", span.StartMsgID, span.EndMsgID)
	}
	if len(span.Messages) != 3 || span.Messages[0].ID != "m1" || span.Messages[2].ID != "m3" {
		t.Errorf("Expected span messages [m1,m2,m3], got %v", span.Messages)
	}

	// Idempotency: re-archiving the same span is a no-op.
	archived2, err := db.ArchiveCycleSpan(sessID, []string{"m1", "m2", "m3"}, "s1")
	if err != nil {
		t.Fatalf("Idempotent ArchiveCycleSpan failed: %v", err)
	}
	if archived2 != nil {
		t.Errorf("Expected nil archived IDs on second call, got %v", archived2)
	}
	sessBytes2, _, err := db.GetSession(sessID)
	if err != nil {
		t.Fatalf("GetSession after idempotent archive: %v", err)
	}
	var main2 struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	if err := json.Unmarshal(sessBytes2, &main2); err != nil {
		t.Fatalf("Unmarshal main after idempotent: %v", err)
	}
	if len(main2.Messages) != 3 {
		t.Errorf("Expected 3 kept messages after idempotent call, got %d", len(main2.Messages))
	}
	archBytes2, err := db.GetSessionArchive(sessID)
	if err != nil {
		t.Fatalf("GetSessionArchive after idempotent: %v", err)
	}
	var doc2 struct {
		Spans []interface{} `json:"spans"`
	}
	if err := json.Unmarshal(archBytes2, &doc2); err != nil {
		t.Fatalf("Unmarshal archive after idempotent: %v", err)
	}
	if len(doc2.Spans) != 1 {
		t.Errorf("Expected 1 span after idempotent call, got %d", len(doc2.Spans))
	}

	// DeleteSession removes the main record AND the archive key.
	if err := db.DeleteSession(sessID); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, _, err := db.GetSession(sessID); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Expected os.ErrNotExist after delete, got %v", err)
	}
	if _, err := db.GetSessionArchive(sessID); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Expected archive key removed after delete, got %v", err)
	}
}

// TestCadenceDB_CopySession verifies the atomic session fork:
//  - the main record is copied with a new id and "<name> - fork"
//  - the metadata record is created fresh (revision 1, parentId preserved)
//  - the per-session archive is copied byte-for-byte
//  - the source session is untouched
//  - forking a session with no archive works (fork starts empty)
//  - forking a missing source returns os.ErrNotExist
func TestCadenceDB_CopySession(t *testing.T) {
	tempDir, err := ioutil.TempDir("", "cadence_db_copy_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	db, err := openCadenceDB(tempDir)
	if err != nil {
		t.Fatalf("Failed to open CadenceDB: %v", err)
	}
	defer db.Close()

	// Source session with a main record (including a parentId) and an archive.
	srcID := "ai-session-copy-src"
	srcJSON := []byte(`{"id":"ai-session-copy-src","name":"Source Chat","parentId":"ai-parent-1","createdAt":1000,"lastModified":2000,"messages":[{"id":"m0","type":"user","content":"hello"}]}`)
	if _, err := db.PutSession(srcID, srcJSON); err != nil {
		t.Fatalf("Failed to put source session: %v", err)
	}
	archiveJSON := []byte(`{"spans":[{"startMsgId":"a1","endMsgId":"a2","messages":[{"id":"a1","type":"user","content":"x"}]}]}`)
	if err := db.PutSessionArchive(srcID, archiveJSON); err != nil {
		t.Fatalf("Failed to put source archive: %v", err)
	}

	// Fork the source.
	newID := "ai-session-copy-fork"
	name, err := db.CopySession(srcID, newID)
	if err != nil {
		t.Fatalf("CopySession failed: %v", err)
	}
	if name != "Source Chat - fork" {
		t.Errorf("Expected fork name %q, got %q", "Source Chat - fork", name)
	}

	// Main record: new id, fork name, preserved parent, fresh timestamps.
	forkBytes, rev, err := db.GetSession(newID)
	if err != nil {
		t.Fatalf("GetSession fork: %v", err)
	}
	if rev != 1 {
		t.Errorf("Expected fork revision 1, got %d", rev)
	}
	var fork struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		ParentID     string `json:"parentId"`
		CreatedAt    int64  `json:"createdAt"`
		LastModified int64  `json:"lastModified"`
		Messages     []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(forkBytes, &fork); err != nil {
		t.Fatalf("Unmarshal fork: %v", err)
	}
	if fork.ID != newID || fork.Name != "Source Chat - fork" {
		t.Errorf("Expected id=%s name=%q, got %s %q", newID, "Source Chat - fork", fork.ID, fork.Name)
	}
	if fork.ParentID != "ai-parent-1" {
		t.Errorf("Expected parentId preserved, got %q", fork.ParentID)
	}
	if fork.CreatedAt != fork.LastModified || fork.CreatedAt <= 2000 {
		t.Errorf("Expected fresh timestamps (createdAt=lastModified > 2000), got %d/%d", fork.CreatedAt, fork.LastModified)
	}
	if len(fork.Messages) != 1 || fork.Messages[0].ID != "m0" {
		t.Errorf("Expected copied messages [{m0}], got %v", fork.Messages)
	}

	// Archive: copied byte-for-byte.
	forkArchive, err := db.GetSessionArchive(newID)
	if err != nil {
		t.Fatalf("GetSessionArchive fork: %v", err)
	}
	var forkDoc struct {
		Spans []struct {
			StartMsgID string `json:"startMsgId"`
			Messages   []struct {
				ID string `json:"id"`
			} `json:"messages"`
		} `json:"spans"`
	}
	if err := json.Unmarshal(forkArchive, &forkDoc); err != nil {
		t.Fatalf("Unmarshal fork archive: %v", err)
	}
	if len(forkDoc.Spans) != 1 || forkDoc.Spans[0].StartMsgID != "a1" || len(forkDoc.Spans[0].Messages) != 1 || forkDoc.Spans[0].Messages[0].ID != "a1" {
		t.Errorf("Expected copied span [a1], got %v", forkDoc.Spans)
	}

	// Source untouched: main record still its own, archive still present.
	srcBytes, _, err := db.GetSession(srcID)
	if err != nil {
		t.Fatalf("GetSession source: %v", err)
	}
	var src struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(srcBytes, &src); err != nil {
		t.Fatalf("Unmarshal source: %v", err)
	}
	if src.ID != srcID || src.Name != "Source Chat" {
		t.Errorf("Expected source unchanged (%s / Source Chat), got %s / %s", srcID, src.ID, src.Name)
	}
	if _, err := db.GetSessionArchive(srcID); err != nil {
		t.Errorf("Source archive should still exist: %v", err)
	}

	// Forking a session with no archive works; the fork starts with none.
	noArchID := "ai-session-copy-noarch"
	if _, err := db.PutSession(noArchID, []byte(`{"id":"ai-session-copy-noarch","name":"No Archive","createdAt":3000,"lastModified":3000}`)); err != nil {
		t.Fatalf("Failed to put no-archive session: %v", err)
	}
	noArchFork := "ai-session-copy-noarch-fork"
	if _, err := db.CopySession(noArchID, noArchFork); err != nil {
		t.Fatalf("CopySession no-archive failed: %v", err)
	}
	if _, _, err := db.GetSession(noArchFork); err != nil {
		t.Fatalf("GetSession no-archive fork: %v", err)
	}
	if _, err := db.GetSessionArchive(noArchFork); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Expected no archive on no-archive fork, got %v", err)
	}

	// Forking a missing source returns os.ErrNotExist.
	if _, err := db.CopySession("ai-session-does-not-exist", "ai-session-ghost"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Expected os.ErrNotExist for missing source, got %v", err)
	}
	if _, _, err := db.GetSession("ai-session-ghost"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("Expected ghost session not created on failed copy, got %v", err)
	}
}



