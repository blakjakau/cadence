import { get, set, del, update } from "https://cdn.jsdelivr.net/npm/idb-keyval@6/+esm"

const MAX_VERSIONS = 10;
const SESSION_CLEANUP_THRESHOLD = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Handles file backups before modification to allow for rollback functionality.
 * Supports individual file versioning and multi-file atomic transactions.
 * Stored in IndexedDB via idb-keyval.
 */
class AgentBackup {
    /**
     * Creates a backup of a file's content.
     * @param {string} path - The absolute or relative path of the file.
     * @param {string} content - The current (pre-write) content of the file.
     * @param {string} sourceId - An identifier for the action that triggered the backup (e.g., message ID, transaction ID).
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

    // --- Multi-File Atomic Transaction Rollback Methods ---

    /**
     * Begins or registers a multi-file transaction group.
     * @param {string} transactionId - Unique identifier for the multi-file transaction (e.g. turn ID).
     */
    static async beginTransaction(transactionId) {
        const txKey = `agent_tx_${transactionId}`;
        const existing = await get(txKey);
        if (!existing) {
            await set(txKey, {
                id: transactionId,
                startedAt: Date.now(),
                status: "active",
                files: []
            });
        }
        return transactionId;
    }

    /**
     * Records a file change within an atomic transaction.
     * Creates an individual backup and associates it with the transaction group.
     * @param {string} transactionId 
     * @param {string} path 
     * @param {string} originalContent 
     * @param {string} sourceId 
     */
    static async recordFileChange(transactionId, path, originalContent, sourceId = "tx") {
        const backupId = await this.create(path, originalContent, `${transactionId}_${sourceId}`);
        const txKey = `agent_tx_${transactionId}`;
        
        await update(txKey, (txData = { id: transactionId, startedAt: Date.now(), status: "active", files: [] }) => {
            const fileEntry = {
                path,
                backupId,
                timestamp: Date.now()
            };
            // Deduplicate path within transaction (keep earliest backup)
            const exists = txData.files.some(f => f.path === path);
            if (!exists) {
                txData.files.push(fileEntry);
            }
            return txData;
        });

        return backupId;
    }

    /**
     * Retrieves transaction metadata and file entries.
     * @param {string} transactionId 
     */
    static async getTransaction(transactionId) {
        return await get(`agent_tx_${transactionId}`);
    }

    /**
     * Atomically rolls back all files modified during a multi-file transaction.
     * Restores memory buffers in open tabs and writes changes to disk.
     * @param {string} transactionId 
     * @returns {Promise<Array<{path: string, restored: boolean}>>}
     */
    static async rollbackTransaction(transactionId) {
        const txKey = `agent_tx_${transactionId}`;
        const txData = await get(txKey);
        if (!txData || !Array.isArray(txData.files) || txData.files.length === 0) {
            console.warn(`[AgentBackup] No transaction data found to rollback for ${transactionId}`);
            return [];
        }

        const results = [];

        for (const fileEntry of txData.files) {
            try {
                const originalContent = await this.rollback(fileEntry.backupId);
                const path = fileEntry.path;

                // 1. If tab is open in Ace editor, restore its buffer and baseline
                let targetTab = null;
                const openTabs = [...(window.ui?.leftTabs?.tabs || []), ...(window.ui?.rightTabs?.tabs || [])];
                const normTarget = path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
                
                targetTab = openTabs.find(tab => {
                    const tabPath = (tab.config?.path || "").replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
                    return tabPath === normTarget || tabPath.endsWith('/' + normTarget) || normTarget.endsWith('/' + tabPath);
                });

                if (targetTab && targetTab.config?.session) {
                    targetTab.config.session.setValue(originalContent);
                    targetTab.config.session.baseValue = originalContent;
                    targetTab.config.viewMode = "editor";
                    delete targetTab.config.backupId;
                }

                // 2. Write original content back to disk via Conduit WebSocket API
                if (window.conduit && window.conduit.isConnected) {
                    await window.conduit.wsWrite(path, btoa(unescape(encodeURIComponent(originalContent))));
                } else if (targetTab && window.saveFileTab) {
                    await window.saveFileTab(targetTab);
                }

                results.push({ path, restored: true });
            } catch (err) {
                console.error(`[AgentBackup] Failed to rollback file ${fileEntry.path} in transaction ${transactionId}:`, err);
                results.push({ path: fileEntry.path, restored: false, error: err.message });
            }
        }

        // Mark transaction as rolled back
        txData.status = "rolled_back";
        txData.rolledBackAt = Date.now();
        await set(txKey, txData);

        return results;
    }

    /**
     * Commits a transaction group.
     * @param {string} transactionId 
     */
    static async commitTransaction(transactionId) {
        const txKey = `agent_tx_${transactionId}`;
        const txData = await get(txKey);
        if (txData) {
            txData.status = "committed";
            txData.committedAt = Date.now();
            await set(txKey, txData);
        }
    }

    /**
     * Periodically clean up old backups (optional call).
     */
    static async cleanup() {
        // Handled on a per-file basis during 'create'.
    }
}

export default AgentBackup;
