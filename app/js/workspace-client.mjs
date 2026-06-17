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
        const res = await fetch(`${API_BASE}/workspace`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(workspace)
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
        const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}`);
        if (!res.ok) {
            if (res.status === 404) return undefined;
            throw new Error(`Failed to fetch session: ${res.statusText}`);
        }
        return await res.json();
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
        const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            throw new Error(`Failed to save session: ${res.statusText}`);
        }
    },

    async deleteSession(id) {
        const res = await fetch(`${API_BASE}/session?id=${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        if (!res.ok) {
            throw new Error(`Failed to delete session: ${res.statusText}`);
        }
    }
};

export default workspaceClient;
