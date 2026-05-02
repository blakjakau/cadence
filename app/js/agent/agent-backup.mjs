import { get, set, del, update } from "https://cdn.jsdelivr.net/npm/idb-keyval@6/+esm"

const MAX_VERSIONS = 10;
const SESSION_CLEANUP_THRESHOLD = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Handles file backups before modification to allow for rollback functionality.
 * Stored in IndexedDB via idb-keyval.
 */
class AgentBackup {
    /**
     * Creates a backup of a file's content.
     * @param {string} path - The absolute or relative path of the file.
     * @param {string} content - The current (pre-write) content of the file.
     * @param {string} sourceId - An identifier for the action that triggered the backup (e.g., message ID).
     */
    static async create(path, content, sourceId) {
        const timestamp = Date.now();
        const backupId = `agent_backup_${timestamp}_${sourceId}`;
        const backupData = {
            path,
            content,
            timestamp,
            sourceId
        };

        // Save the backup data
        await set(backupId, backupData);

        // Update the metadata for this path
        await update(`agent_backups_meta_${path}`, (metadata = []) => {
            const newMetadata = [...metadata, { backupId, timestamp, sourceId }];
            // Sort by timestamp descending
            newMetadata.sort((a, b) => b.timestamp - a.timestamp);
            
            // Handle version limit
            if (newMetadata.length > MAX_VERSIONS) {
                const toDelete = newMetadata.slice(MAX_VERSIONS);
                toDelete.forEach(item => del(item.backupId));
                return newMetadata.slice(0, MAX_VERSIONS);
            }
            return newMetadata;
        });

        console.debug(`[AgentBackup] Created backup for ${path}: ${backupId}`);
        return backupId;
    }

    /**
     * Retrieves the backup metadata for a specific path.
     * @param {string} path 
     */
    static async getHistory(path) {
        return await get(`agent_backups_meta_${path}`) || [];
    }

    /**
     * Retrieves a specific backup by its ID.
     * @param {string} backupId 
     */
    static async getBackup(backupId) {
        return await get(backupId);
    }

    /**
     * Rolls back a file to a specific backup state.
     * Note: This only returns the content; the caller must handle the actual file write.
     * @param {string} backupId 
     */
    static async rollback(backupId) {
        const backup = await this.getBackup(backupId);
        if (!backup) throw new Error("Backup not found or expired.");
        return backup.content;
    }

    /**
     * Periodically clean up old backups (optional call).
     */
    static async cleanup() {
        // This is a more complex operation as idb-keyval doesn't support prefix listing easily.
        // We'd need to iterate over all keys in the default store if we wanted a global cleanup.
        // For now, cleanup is handled on a per-file basis during 'create'.
    }
}

export default AgentBackup;
