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
            const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}`);
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
