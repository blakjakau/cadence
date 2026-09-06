package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	bucketSessionsData = []byte("sessions_data")
	bucketSessionsMeta = []byte("sessions_meta")
	bucketWorkspaces   = []byte("workspaces")
	bucketAppConfig    = []byte("app_config")
	keyAppConfig       = []byte("config")
	keyMigrationMarker = []byte("migration_v1_done")
)

type SessionMetadataRecord struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	ParentID        string `json:"parentId"`
	CreatedAt       int64  `json:"createdAt"`
	LastModified    int64  `json:"lastModified"`
	CompletedResult string `json:"completedResult,omitempty"`
	Revision        int64  `json:"revision"`
}

type CadenceDB struct {
	db   *bolt.DB
	path string
	mu   sync.RWMutex
}

var globalDB *CadenceDB

func openCadenceDB(dir string) (*CadenceDB, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create config dir: %w", err)
	}

	dbPath := filepath.Join(dir, "cadence.db")
	db, err := bolt.Open(dbPath, 0600, &bolt.Options{Timeout: 3 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("failed to open bbolt database at %s: %w", dbPath, err)
	}

	// Ensure all required buckets exist
	err = db.Update(func(tx *bolt.Tx) error {
		for _, bName := range [][]byte{bucketSessionsData, bucketSessionsMeta, bucketWorkspaces, bucketAppConfig} {
			if _, err := tx.CreateBucketIfNotExists(bName); err != nil {
				return fmt.Errorf("failed to create bucket %s: %w", string(bName), err)
			}
		}
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}

	cdb := &CadenceDB{
		db:   db,
		path: dbPath,
	}

	// Perform one-time migration from legacy JSON files
	if err := cdb.migrateLegacyFiles(dir); err != nil {
		log.Printf("[CadenceDB] Warning: migration encountered issue: %v", err)
	}

	// Create a backup copy (cadence.db.bak) and compact the database on launch
	if err := cdb.backupAndCompact(); err != nil {
		log.Printf("[CadenceDB] Launch-time backup/compaction notice: %v", err)
	}

	return cdb, nil
}

func (c *CadenceDB) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db != nil {
		return c.db.Close()
	}
	return nil
}

// migrateLegacyFiles imports legacy ai_session_*.json and workspace_*.json files into bbolt
func (c *CadenceDB) migrateLegacyFiles(dir string) error {
	var alreadyMigrated bool
	err := c.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketAppConfig)
		if b != nil && b.Get(keyMigrationMarker) != nil {
			alreadyMigrated = true
		}
		return nil
	})
	if err == nil && alreadyMigrated {
		return nil
	}

	files, err := ioutil.ReadDir(dir)
	if err != nil {
		return err
	}

	migratedSessions := 0
	migratedWorkspaces := 0

	err = c.db.Update(func(tx *bolt.Tx) error {
		bSessionsData := tx.Bucket(bucketSessionsData)
		bSessionsMeta := tx.Bucket(bucketSessionsMeta)
		bWorkspaces := tx.Bucket(bucketWorkspaces)
		bAppConfig := tx.Bucket(bucketAppConfig)

		for _, f := range files {
			if f.IsDir() {
				continue
			}

			// Migrate ai_session_<id>.json
			if strings.HasPrefix(f.Name(), "ai_session_") && strings.HasSuffix(f.Name(), ".json") && !strings.HasSuffix(f.Name(), ".bak") {
				path := filepath.Join(dir, f.Name())
				data, err := ioutil.ReadFile(path)
				if err != nil {
					log.Printf("[CadenceDB Migration] Error reading %s: %v", path, err)
					continue
				}

				var raw struct {
					ID              string `json:"id"`
					Name            string `json:"name"`
					ParentID        string `json:"parentId"`
					CreatedAt       int64  `json:"createdAt"`
					LastModified    int64  `json:"lastModified"`
					CompletedResult string `json:"completedResult"`
				}
				if err := json.Unmarshal(data, &raw); err != nil || raw.ID == "" {
					idPart := strings.TrimPrefix(f.Name(), "ai_session_")
					raw.ID = strings.TrimSuffix(idPart, ".json")
					if raw.Name == "" {
						raw.Name = raw.ID
					}
				}

				// Only insert if not already present
				if bSessionsData.Get([]byte(raw.ID)) == nil {
					meta := SessionMetadataRecord{
						ID:              raw.ID,
						Name:            raw.Name,
						ParentID:        raw.ParentID,
						CreatedAt:       raw.CreatedAt,
						LastModified:    raw.LastModified,
						CompletedResult: raw.CompletedResult,
						Revision:        1,
					}
					metaBytes, _ := json.Marshal(meta)

					if err := bSessionsData.Put([]byte(raw.ID), data); err == nil {
						_ = bSessionsMeta.Put([]byte(raw.ID), metaBytes)
						migratedSessions++
					}
				}

				// Rename legacy file to .bak to prevent re-processing
				_ = os.Rename(path, path+".bak")
			}

			// Migrate workspace_<id>.json
			if strings.HasPrefix(f.Name(), "workspace_") && strings.HasSuffix(f.Name(), ".json") && !strings.HasSuffix(f.Name(), ".bak") {
				path := filepath.Join(dir, f.Name())
				data, err := ioutil.ReadFile(path)
				if err != nil {
					log.Printf("[CadenceDB Migration] Error reading %s: %v", path, err)
					continue
				}

				wsID := strings.TrimPrefix(f.Name(), "workspace_")
				wsID = strings.TrimSuffix(wsID, ".json")

				if bWorkspaces.Get([]byte(wsID)) == nil {
					if err := bWorkspaces.Put([]byte(wsID), data); err == nil {
						migratedWorkspaces++
					}
				}

				_ = os.Rename(path, path+".bak")
			}

			// Migrate appConfig.json
			if f.Name() == "appConfig.json" {
				path := filepath.Join(dir, f.Name())
				data, err := ioutil.ReadFile(path)
				if err == nil && len(data) > 0 {
					if bAppConfig.Get(keyAppConfig) == nil {
						_ = bAppConfig.Put(keyAppConfig, data)
					}
				}
			}
		}

		// Mark migration done
		nowBytes := []byte(time.Now().UTC().Format(time.RFC3339))
		return bAppConfig.Put(keyMigrationMarker, nowBytes)
	})

	if err != nil {
		return err
	}

	if migratedSessions > 0 || migratedWorkspaces > 0 {
		log.Printf("[CadenceDB Migration] Successfully migrated %d sessions and %d workspaces into cadence.db (legacy files backed up as .bak)", migratedSessions, migratedWorkspaces)
	}

	return nil
}

// Session operations

func (c *CadenceDB) GetSession(id string) ([]byte, int64, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var data []byte
	var revision int64 = 1

	err := c.db.View(func(tx *bolt.Tx) error {
		bData := tx.Bucket(bucketSessionsData)
		bMeta := tx.Bucket(bucketSessionsMeta)
		if bData == nil {
			return fmt.Errorf("session bucket not found")
		}

		v := bData.Get([]byte(id))
		if v == nil {
			return os.ErrNotExist
		}
		data = make([]byte, len(v))
		copy(data, v)

		if bMeta != nil {
			if mVal := bMeta.Get([]byte(id)); mVal != nil {
				var meta SessionMetadataRecord
				if err := json.Unmarshal(mVal, &meta); err == nil && meta.Revision > 0 {
					revision = meta.Revision
				}
			}
		}

		return nil
	})

	return data, revision, err
}

func (c *CadenceDB) PutSession(id string, data []byte) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var raw struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		ParentID        string `json:"parentId"`
		CreatedAt       int64  `json:"createdAt"`
		LastModified    int64  `json:"lastModified"`
		CompletedResult string `json:"completedResult"`
	}
	_ = json.Unmarshal(data, &raw)
	if raw.ID == "" {
		raw.ID = id
	}
	if raw.LastModified == 0 {
		raw.LastModified = time.Now().UnixMilli()
	}
	if raw.CreatedAt == 0 {
		raw.CreatedAt = raw.LastModified
	}

	var newRevision int64 = 1

	err := c.db.Update(func(tx *bolt.Tx) error {
		bData := tx.Bucket(bucketSessionsData)
		bMeta := tx.Bucket(bucketSessionsMeta)

		// Check previous revision
		if prevMetaVal := bMeta.Get([]byte(id)); prevMetaVal != nil {
			var prevMeta SessionMetadataRecord
			if err := json.Unmarshal(prevMetaVal, &prevMeta); err == nil {
				newRevision = prevMeta.Revision + 1
				if raw.Name == "" {
					raw.Name = prevMeta.Name
				}
				if raw.ParentID == "" {
					raw.ParentID = prevMeta.ParentID
				}
				if raw.CreatedAt == 0 {
					raw.CreatedAt = prevMeta.CreatedAt
				}
			}
		}

		meta := SessionMetadataRecord{
			ID:              raw.ID,
			Name:            raw.Name,
			ParentID:        raw.ParentID,
			CreatedAt:       raw.CreatedAt,
			LastModified:    raw.LastModified,
			CompletedResult: raw.CompletedResult,
			Revision:        newRevision,
		}
		metaBytes, err := json.Marshal(meta)
		if err != nil {
			return err
		}

		if err := bData.Put([]byte(id), data); err != nil {
			return err
		}
		return bMeta.Put([]byte(id), metaBytes)
	})

	return newRevision, err
}

func (c *CadenceDB) DeleteSession(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.db.Update(func(tx *bolt.Tx) error {
		bData := tx.Bucket(bucketSessionsData)
		bMeta := tx.Bucket(bucketSessionsMeta)

		if bData != nil {
			_ = bData.Delete([]byte(id))
		}
		if bMeta != nil {
			_ = bMeta.Delete([]byte(id))
		}
		return nil
	})
}

func (c *CadenceDB) ListSessions() ([]map[string]interface{}, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var sessions []map[string]interface{}

	err := c.db.View(func(tx *bolt.Tx) error {
		bMeta := tx.Bucket(bucketSessionsMeta)
		if bMeta == nil {
			return nil
		}

		c := bMeta.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var meta SessionMetadataRecord
			if err := json.Unmarshal(v, &meta); err == nil && meta.ID != "" {
				sessions = append(sessions, map[string]interface{}{
					"id":              meta.ID,
					"name":            meta.Name,
					"parentId":        meta.ParentID,
					"createdAt":       meta.CreatedAt,
					"lastModified":    meta.LastModified,
					"completedResult": meta.CompletedResult,
					"revision":        meta.Revision,
				})
			}
		}
		return nil
	})

	// Sort by lastModified descending
	sort.Slice(sessions, func(i, j int) bool {
		lmI, _ := sessions[i]["lastModified"].(int64)
		lmJ, _ := sessions[j]["lastModified"].(int64)
		return lmI > lmJ
	})

	return sessions, err
}

// Workspace operations

func (c *CadenceDB) GetWorkspace(id string) ([]byte, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var data []byte
	err := c.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketWorkspaces)
		if b == nil {
			return os.ErrNotExist
		}
		v := b.Get([]byte(id))
		if v == nil {
			return os.ErrNotExist
		}
		data = make([]byte, len(v))
		copy(data, v)
		return nil
	})

	return data, err
}

func (c *CadenceDB) PutWorkspace(id string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketWorkspaces)
		return b.Put([]byte(id), data)
	})
}

func (c *CadenceDB) DeleteWorkspace(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketWorkspaces)
		if b != nil {
			return b.Delete([]byte(id))
		}
		return nil
	})
}

// AppConfig operations

func (c *CadenceDB) GetAppConfig() ([]byte, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var data []byte
	err := c.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketAppConfig)
		if b == nil {
			return os.ErrNotExist
		}
		v := b.Get(keyAppConfig)
		if v == nil {
			return os.ErrNotExist
		}
		data = make([]byte, len(v))
		copy(data, v)
		return nil
	})

	return data, err
}

func (c *CadenceDB) PutAppConfig(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketAppConfig)
		return b.Put(keyAppConfig, data)
	})
}

// DBStats information
type DBStats struct {
	SizeFormatted     string `json:"sizeFormatted"`
	SizeBytes         int64  `json:"sizeBytes"`
	FreePageBytes     int64  `json:"freePageBytes"`
	FreePageFormatted string `json:"freePageFormatted"`
	SessionCount      int    `json:"sessionCount"`
	WorkspaceCount    int    `json:"workspaceCount"`
	Path              string `json:"path"`
}

func (c *CadenceDB) GetDBStats() (DBStats, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	stats := DBStats{Path: c.path}

	fi, err := os.Stat(c.path)
	if err == nil {
		stats.SizeBytes = fi.Size()
		stats.SizeFormatted = formatByteSize(fi.Size())
	}

	dbStats := c.db.Stats()
	stats.FreePageBytes = int64(dbStats.FreeAlloc)
	stats.FreePageFormatted = formatByteSize(stats.FreePageBytes)

	err = c.db.View(func(tx *bolt.Tx) error {
		if bMeta := tx.Bucket(bucketSessionsMeta); bMeta != nil {
			stats.SessionCount = bMeta.Stats().KeyN
		}
		if bWs := tx.Bucket(bucketWorkspaces); bWs != nil {
			stats.WorkspaceCount = bWs.Stats().KeyN
		}
		return nil
	})

	return stats, err
}

func formatByteSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// backupAndCompact copies the current database to cadence.db.bak for safety,
// and compacts the live database if free space is available.
func (c *CadenceDB) backupAndCompact() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	dir := filepath.Dir(c.path)
	bakPath := filepath.Join(dir, "cadence.db.bak")
	compactPath := filepath.Join(dir, "cadence.db.compact")

	// Clean up any stale compact file from a previously interrupted process
	_ = os.Remove(compactPath)

	// Step 1: Create atomic backup of the database to cadence.db.bak
	bakFile, err := os.OpenFile(bakPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to open backup file: %w", err)
	}

	err = c.db.View(func(tx *bolt.Tx) error {
		_, writeErr := tx.WriteTo(bakFile)
		return writeErr
	})
	bakFile.Close()
	if err != nil {
		return fmt.Errorf("failed to write backup file: %w", err)
	}

	// Step 2: Open temporary destination DB for compaction
	compactDB, err := bolt.Open(compactPath, 0600, &bolt.Options{Timeout: 3 * time.Second})
	if err != nil {
		return fmt.Errorf("failed to create compact db: %w", err)
	}

	// Perform bbolt compaction from live DB -> compact DB
	compactErr := bolt.Compact(compactDB, c.db, 0)
	compactDB.Close()
	if compactErr != nil {
		_ = os.Remove(compactPath)
		return fmt.Errorf("compaction failed: %w", compactErr)
	}

	// Step 3: Check if compaction succeeded and produced a valid smaller/cleaner file
	compactFi, err := os.Stat(compactPath)
	if err != nil || compactFi.Size() == 0 {
		_ = os.Remove(compactPath)
		return fmt.Errorf("compact file invalid")
	}

	// Step 4: Close current DB handle to swap files
	origFi, _ := os.Stat(c.path)
	if err := c.db.Close(); err != nil {
		_ = os.Remove(compactPath)
		return fmt.Errorf("failed to close current db for replacement: %w", err)
	}

	// Atomic rename: compact -> cadence.db
	if err := os.Rename(compactPath, c.path); err != nil {
		// Attempt recovery from backup if rename failed
		_ = os.Rename(bakPath, c.path)
		// Reopen original
		reopenedDB, reOpenErr := bolt.Open(c.path, 0600, &bolt.Options{Timeout: 3 * time.Second})
		if reOpenErr == nil {
			c.db = reopenedDB
		}
		return fmt.Errorf("failed to swap compacted db: %w", err)
	}

	// Re-open newly compacted database
	reopenedDB, err := bolt.Open(c.path, 0600, &bolt.Options{Timeout: 3 * time.Second})
	if err != nil {
		return fmt.Errorf("failed to re-open compacted db: %w", err)
	}
	c.db = reopenedDB

	if origFi != nil {
		log.Printf("[CadenceDB] Launch backup created (cadence.db.bak) & compacted: %s -> %s",
			formatByteSize(origFi.Size()), formatByteSize(compactFi.Size()))
	}

	return nil
}


