const API_BASE = '/api';

export const workspaceClient = {
    async getAppConfig() {
        const res = await fetch(`${API_BASE}/config`);
        if (!res.ok) {
            throw new Error(`Failed to fetch app config: ${res.statusText}`);
        }
        return await res.json();
    },

    async setAppConfig(config) {
        const res = await fetch(`${API_BASE}/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });
        if (!res.ok) {
            throw new Error(`Failed to save app config: ${res.statusText}`);
        }
    },

    async getWorkspace(id) {
        const res = await fetch(`${API_BASE}/workspace?id=${encodeURIComponent(id)}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch workspace: ${res.statusText}`);
        }
        return await res.json();
    },

    async setWorkspace(workspace) {
        const body = JSON.stringify(workspace);
        const res = await fetch(`${API_BASE}/workspace`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: body
        });
        if (!res.ok) {
            throw new Error(`Failed to save workspace: ${res.statusText}`);
        }
    },

    async deleteWorkspace(id) {
        const res = await fetch(`${API_BASE}/workspace?id=${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        if (!res.ok) {
            throw new Error(`Failed to delete workspace: ${res.statusText}`);
        }
    },

    async getSession(id) {
        try {
            const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}&t=${Date.now()}`, {
                cache: 'no-store'
            });
            if (!res.ok) {
                if (res.status === 404) return undefined;
                throw new Error(`Failed to fetch session: ${res.statusText}`);
            }
            const data = await res.json();
            const rev = res.headers.get('X-Session-Revision');
            if (rev && typeof data === 'object' && data !== null) {
                data.revision = parseInt(rev, 10);
            }
            return data;
        } catch (err) {
            console.warn(`[workspaceClient] getSession failed for ${id}:`, err);
            throw err;
        }
    },

    async getSessions() {
        // Add cache-busting timestamp
        const res = await fetch(`${API_BASE}/sessions?t=${Date.now()}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch sessions: ${res.statusText}`);
        }
        return await res.json();
    },

    async setSession(id, data) {
        try {
            const body = JSON.stringify(data);
            const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: body
            });
            if (!res.ok) {
                throw new Error(`Failed to save session: ${res.statusText}`);
            }
            const rev = res.headers.get('X-Session-Revision');
            if (rev && typeof data === 'object' && data !== null) {
                data.revision = parseInt(rev, 10);
            }
            return res;
        } catch (err) {
            console.warn(`[workspaceClient] setSession failed for ${id}:`, err);
            throw err;
        }
    },

    async deleteSession(id) {
        const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        if (!res.ok) {
            throw new Error(`Failed to delete session: ${res.statusText}`);
        }
    },

    // Fetch the per-session archive record (compacted cycle spans moved out of
    // the main session record). Returns the doc {spans:[...]} or null when the
    // session has no archived spans yet (404/empty).
    async getSessionArchive(id) {
        const res = await fetch(`${API_BASE}/session-archive?id=${encodeURIComponent(id)}&t=${Date.now()}`, {
            cache: 'no-store'
        });
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(`Failed to fetch session archive: ${res.statusText}`);
        }
        const data = await res.json();
        return (data && data.spans && data.spans.length) ? data : null;
    },

    // Atomically move the raw messages for removeMsgIds out of the main session
    // record into the archive record, optionally marking markSummaryId's
    // cycle_summary as archived. Returns {archived, ids}.
    async archiveCycleSpan(id, { removeMsgIds, markSummaryId }) {
        const body = JSON.stringify({
            removeMsgIds,
            markSummaryId: markSummaryId || ''
        });
        const res = await fetch(`${API_BASE}/session-archive?id=${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        });
        if (!res.ok) {
            let msg = res.statusText;
            try { msg = await res.text(); } catch (e) { /* keep statusText */ }
            throw new Error(`Failed to archive cycle span: ${msg}`);
        }
        return await res.json();
    },

    // Fork a session atomically on the backend (main record, metadata, and
    // archive copied). Returns {newId, name}.
    async copySession(id) {
        const res = await fetch(`${API_BASE}/session-copy?id=${encodeURIComponent(id)}`, {
            method: 'POST'
        });
        if (!res.ok) {
            let msg = res.statusText;
            try { msg = await res.text(); } catch (e) { /* keep statusText */ }
            throw new Error(`Failed to fork session: ${msg}`);
        }
        return await res.json();
    },

    async getDBStats() {
        const res = await fetch(`${API_BASE}/db-stats?t=${Date.now()}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch database stats: ${res.statusText}`);
        }
        return await res.json();
    },

    async checkSyntax(path, content) {
        const res = await fetch(`${API_BASE}/check-syntax`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ path, content })
        });
        if (!res.ok) {
            throw new Error(`Failed to check syntax: ${res.statusText}`);
        }
        return await res.json();
    }
};

export default workspaceClient;
