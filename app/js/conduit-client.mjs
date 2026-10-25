// /code-pwa/js/conduit-client.mjs

/**
 * A client for interacting with the Conduit API (both REST and WebSocket).
 * This class manages connections, authentication, and API calls.
 * It also acts as a simple event emitter for WebSocket messages.
 * @example
 * import conduit from './conduit-client.mjs';
 * conduit.on('list', ({ path, data }) => console.log(`Files in ${path}:`, data));
 * conduit.on('notify', ({ path, data }) => console.log(`File change in ${path}:`, data));
 * conduit.on('status', (s) => console.log('Conduit is', s.state));
 * conduit.connect();
 * conduit.wsList('.');
 * conduit.wsWatch('.');
 * // Query live connection status:
 * console.log(conduit.status); // { state, connected, connecting, attempts, nextRetryIn }
 * // Guard an action on the connection being ready:
 * conduit.ready.then(() => conduit.wsRead('README.md')).catch(err => console.warn(err));
 */
class ConduitClient {
    constructor() {
        this.host = window.location.hostname || '127.0.0.1';
        this.port = window.location.port || 3022;
        this.apiKey = null;
        this.ws = null;
        this.isConnecting = false;
        this.isConnected = false;
        this.messageQueue = [];
        this.eventListeners = new Map();
        this.requestIdCounter = 0;
        this.pendingRequests = new Map(); // For tracking responses to specific requests
        // Reconnect engine
        this._reconnectTimer = null; // setTimeout handle for the pending auto-reconnect
        this._reconnectAttempt = 0; // consecutive failed attempts (resets on a successful open)
        this._intentionalClose = false; // set by disconnect(); suppresses auto-reconnect
        this._readyResolvers = []; // { resolve, reject } pairs for pending `ready` promises
        this._state = 'disconnected';
    }

    // --- Configuration ---
    configure({ host, port, apiKey }) {
        this.host = host || this.host;
        this.port = port || this.port;
        this.apiKey = apiKey || this.apiKey;
    }

    get baseUrl() {
        return window.location.origin || `http://${this.host}:${this.port}`;
    }

    get wsUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || `${this.host}:${this.port}`;
        let url = `${protocol}//${host}/files`;
        if (this.apiKey) {
            url += `?key=${this.apiKey}`;
        }
        return url;
    }

    // --- Event Emitter ---
    on(eventName, listener) {
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push(listener);
    }

    off(eventName, listener) {
        if (!this.eventListeners.has(eventName)) return;
        const listeners = this.eventListeners.get(eventName);
        const index = listeners.indexOf(listener);
        if (index > -1) {
            listeners.splice(index, 1);
        }
    }

    emit(eventName, ...args) {
        if (!this.eventListeners.has(eventName)) return;
        this.eventListeners.get(eventName).forEach(listener => listener(...args));
    }

    // --- REST API Methods ---
    async list(path) {
        const url = new URL(`${this.baseUrl}/files`);
        url.searchParams.set('path', path);
        const headers = {};
        if (this.apiKey) headers['X-Cadence-Key'] = this.apiKey;

        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.action !== 'list') throw new Error('Expected list action from server');
        return data;
    }

    async read(path) {
        const url = new URL(`${this.baseUrl}/files`);
        url.searchParams.set('path', path);
        const headers = {};
        if (this.apiKey) headers['X-Cadence-Key'] = this.apiKey;

        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.action !== 'read') throw new Error('Expected read action from server');
        // Decode base64 content
        data.content = atob(data.data);
        return data;
    }

    async write(path, content) {
        const url = new URL(`${this.baseUrl}/files`);
        url.searchParams.set('path', path);
        const headers = {};
        if (this.apiKey) headers['X-Cadence-Key'] = this.apiKey;
        headers['Content-Type'] = 'application/octet-stream';

        const response = await fetch(url, { method: 'POST', headers, body: content });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.status === 201;
    }

    // Sandbox capability probe + live sandbox instance list (GET /api/sandbox).
    // Returns { available, method, reason, instances: [{ id, roots, owners, shared }] }.
    // Used for a capability indicator and to list attachable agent sandboxes.
    async wsGetSandboxStatus() {
        const url = new URL(`${this.baseUrl}/api/sandbox`);
        const headers = {};
        if (this.apiKey) headers['X-Cadence-Key'] = this.apiKey;

        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.json();
    }

    // --- WebSocket ---
    // Opens (or re-opens) the WebSocket connection. Idempotent: safe to call at
    // any time. Clears any intentional-close flag and pending reconnect timer,
    // then opens a socket immediately. If the connection drops later, the
    // client auto-reconnects with exponential backoff (1s base, doubling,
    // capped at 10s) until `disconnect()` is called.
    connect() {
        this._intentionalClose = false;
        this._clearReconnectTimer();
        if (this.isConnected || this.isConnecting) return;
        this._reconnectAttempt = 0;
        this._openSocket();
    }

    // Intentionally closes the connection and stops auto-reconnecting.
    // Call `connect()` again to re-establish (resets the backoff counter).
    disconnect() {
        this._intentionalClose = true;
        this._clearReconnectTimer();
        const ws = this.ws;
        this.ws = null; // detach first so the socket's onclose handler is a no-op
        if (ws) {
            try { ws.close(); } catch (e) { /* socket already closing */ }
        }
        if (this.isConnected || this.isConnecting) {
            this._handleWsClose();
        } else {
            // Nothing open; just refresh status so nextRetryIn clears.
            this._setState('disconnected');
        }
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer != null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _openSocket() {
        if (this.isConnected) return;
        this.isConnecting = true;
        this._setState('connecting');
        console.debug(`[Conduit] Connecting to WebSocket (Attempt ${this._reconnectAttempt + 1}):`, this.wsUrl);

        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws) return; // stale socket
            this._handleWsOpen();
        };
        ws.onmessage = (event) => {
            if (this.ws !== ws) return; // stale socket
            this._handleWsMessage(event);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return; // stale socket
            this._handleWsClose();
        };
        ws.onerror = (error) => {
            if (this.ws !== ws) return; // stale socket
            this._handleWsError(error);
        };
    }

    _handleWsOpen() {
        console.log('[Conduit] WebSocket connected.');
        this._reconnectAttempt = 0;
        this._clearReconnectTimer();
        this.isConnecting = false;
        this.isConnected = true;
        this._setState('connected');
        this.emit('connect');

        // Send any queued messages
        this.messageQueue.forEach(msg => this.ws.send(JSON.stringify(msg)));
        this.messageQueue = [];

        // Resolve any pending `ready` promises
        const resolvers = this._readyResolvers;
        this._readyResolvers = [];
        resolvers.forEach(({ resolve }) => resolve(this.status));
    }

    _handleWsClose() {
        // Guard against a double-close (e.g. the socket's onclose handler firing
        // after disconnect() already tore the socket down).
        if (this.ws == null && !this.isConnected && !this.isConnecting) return;

        const wasEstablished = this.isConnected;
        const intentional = this._intentionalClose;
        console.warn('[Conduit] WebSocket disconnected.');
        this.ws = null;
        this.isConnected = false;
        this.isConnecting = false;

        // A dropped *established* connection (or an intentional close) invalidates
        // in-flight requests. A *failed attempt* (socket never opened) does not:
        // the pending _send requests were never actually sent, so keep them alive
        // and let the next successful connect flush them.
        if (wasEstablished || intentional) {
            this.emit('disconnect');
            this.pendingRequests.forEach(({ reject }) => reject(new Error('WebSocket disconnected')));
            this.pendingRequests.clear();
            const resolvers = this._readyResolvers;
            this._readyResolvers = [];
            resolvers.forEach(({ reject }) => reject(new Error('WebSocket disconnected')));
        }

        if (intentional) {
            this._setState('disconnected');
            return;
        }

        // Schedule an auto-reconnect with exponential backoff:
        // 1s, 2s, 4s, 8s, then capped at 10s while retries continue.
        const wait = this._reconnectWait();
        this._setState('disconnected', wait);
        console.log(`[Conduit] Reconnecting in ${wait / 1000}s...`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._reconnectAttempt++;
            this._openSocket();
        }, wait);
    }

    _reconnectWait() {
        return Math.min(1000 * Math.pow(2, this._reconnectAttempt), 10000);
    }

    _handleWsError(error) {
        console.error('[Conduit] WebSocket error for:', this.wsUrl, error);
        // Let onclose handle the reconnect logic
    }

    // --- Connection Status ---
    // Current connection state. `state` is one of:
    //   'connected'    - the WebSocket is open and usable
    //   'connecting'   - a socket is in the process of opening
    //   'disconnected' - no socket; if not intentionally closed, an
    //                    auto-reconnect is scheduled (see `nextRetryIn`)
    get status() {
        const state = this._state;
        return {
            state,
            connected: this.isConnected,
            connecting: this.isConnecting,
            attempts: this._reconnectAttempt,
            nextRetryIn: this._reconnectTimer != null ? this._reconnectWait() : null,
        };
    }

    // A promise that resolves with the current status once the connection is
    // (or becomes) established, and rejects if the connection drops while it
    // is still pending. Use it to guard actions that require a live socket:
    //   conduit.ready.then(() => conduit.wsRead('README.md'));
    // Each call returns a fresh promise; all pending promises resolve together
    // when the socket opens and reject together if it closes first.
    get ready() {
        if (this.isConnected) return Promise.resolve(this.status);
        return new Promise((resolve, reject) => {
            this._readyResolvers.push({ resolve, reject });
        });
    }

    _setState(state, nextRetryIn = null) {
        this._state = state;
        const status = {
            state,
            connected: this.isConnected,
            connecting: this.isConnecting,
            attempts: this._reconnectAttempt,
            nextRetryIn: nextRetryIn,
        };
        this.emit('status', status);
        return status;
    }

    _handleWsMessage(event) {
        try {
            const message = JSON.parse(event.data);
            console.debug('[Conduit] Received:', message);

            if (message.requestId && this.pendingRequests.has(message.requestId)) {
                const { resolve, reject } = this.pendingRequests.get(message.requestId);
                if (message.error) {
                    reject(new Error(message.error));
                    this.pendingRequests.delete(message.requestId);
                } else if (message.action === "search_match") {
                    // Do not resolve or delete pending request yet since this is a streaming chunk!
                } else {
                    resolve(message);
                    this.pendingRequests.delete(message.requestId);
                }
            }

            this.emit(message.action, message); // e.g., emit('list', { path, data, error })
            if (message.error) {
                this.emit('error', message);
            }
        } catch (e) {
            console.error('[Conduit] Error parsing message:', e);
            this.emit('error', { error: 'Invalid JSON message from server' });
        }
    }

    _send(payload, explicitRequestId = null) {
        return new Promise((resolve, reject) => {
            const requestId = explicitRequestId || ++this.requestIdCounter;
            const message = { ...payload, requestId };
            this.pendingRequests.set(requestId, { resolve, reject });

            const sender = () => {
                try {
                    console.debug('[Conduit] Sending:', message);
                    this.ws.send(JSON.stringify(message));
                } catch (e) {
                    reject(e);
                    this.pendingRequests.delete(requestId);
                }
            };

            if (this.isConnected) {
                sender();
            } else {
                const connectHandler = () => {
                    sender();
                    this.off('connect', connectHandler);
                    this.off('disconnect', disconnectHandler);
                };
                const disconnectHandler = () => {
                    reject(new Error('Failed to connect to WebSocket'));
                    this.off('connect', connectHandler);
                    this.off('disconnect', disconnectHandler);
                };
                this.on('connect', connectHandler);
                this.on('disconnect', disconnectHandler);
                if (!this.isConnecting) this.connect();
            }

            // Timeout for the request
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    reject(new Error(`Request ${requestId} timed out`));
                    this.pendingRequests.delete(requestId);
                }
            }, 10000); // 10 second timeout
        });
    }

    // --- WebSocket Actions (Promise-based) ---
    wsMkdir(path) {
        return this._send({ action: 'mkdir', path });
    }

    wsList(path) {
        return this._send({ action: 'list', path });
    }

    wsRead(path, startLine = 0, lineCount = 0) {
        const payload = { action: 'read', path };
        if (startLine > 0) payload.startLine = startLine;
        if (lineCount > 0) payload.lineCount = lineCount;
        return this._send(payload);
    }

    wsWrite(path, base64Content) {
        return this._send({ action: 'write', path, content: base64Content });
    }

    wsRename(oldPath, newPath) {
        return this._send({ action: 'rename', path: oldPath, content: newPath });
    }

    wsDelete(path) {
        return this._send({ action: 'delete', path });
    }

    wsCountFiles(path) {
        return this._send({ action: 'count_files', path });
    }

    wsSearch(path, type, query, opts = null) {
        const payload = { action: 'search', path, type, query };
        if (opts && opts.agent) payload.agent = true;
        return this._send(payload);
    }

    wsSearchWithId(requestId, path, type, query, opts = null) {
        const payload = { action: 'search', path, type, query };
        if (opts && opts.agent) payload.agent = true;
        return this._send(payload, requestId);
    }

    wsSearchSymbols(query) {
        return this._send({ action: 'search_symbols', query });
    }

    wsGetOutline(path) {
        return this._send({ action: 'get_outline', path });
    }

    wsGetFileSymbols(path) {
        return this._send({ action: 'get_file_symbols', path });
    }

    wsGetIndexerStatus() {
        return this._send({ action: 'get_indexer_status' });
    }

    wsFileInfo(path) {
        return this._send({ action: 'file_info', path });
    }

    wsWebGet(url) {
        return this._send({ action: 'web_get', path: url });
    }

    wsSetActiveRoots(roots, ignorePaths = null) {
        if (!ignorePaths && window.workspace && window.workspace.ignorePaths) {
            ignorePaths = window.workspace.ignorePaths;
        }
        const payload = { roots, ignorePaths };
        return this._send({ action: 'set_active_roots', content: JSON.stringify(payload) });
    }

    // Watch is fire-and-forget, it just sends the command.
    wsWatch(path) {
        const message = { action: 'watch', path };
        if (this.isConnected) {
            this.ws.send(JSON.stringify(message));
        } else {
            this.messageQueue.push(message);
            if (!this.isConnecting) this.connect();
        }
        return Promise.resolve();
    }
}

const conduitClient = new ConduitClient();
// For easy debugging from the console
window.conduit = conduitClient;

export default conduitClient;
