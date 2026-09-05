
import { Button, Icon } from "./elements.mjs";
import { loadScript, addStylesheet } from "./elements/utils.mjs";
import { TabBar } from "./elements/tabbar.mjs";
import { SettingsPanel } from "./elements/settings-panel.mjs";
import { TabItem } from "./elements/tabitem.mjs";
import { Modal } from './elements/modal.mjs'; // Import Modal

// The URL for the backend WebSocket server
const CONDUIT_RELEASE_TAG = "v0.0.11";
const CONDUIT_DOWNLOAD_PATH = `https://github.com/blakjakau/dev.jakbox.conduit/releases/download/${CONDUIT_RELEASE_TAG}`;
const CONDUIT_PROTOCOL_URL = 'conduit://';

class TerminalManager {
	constructor() {
		this._initialized = false;
		this.port = window.location.port || 3022;
		this.settingsPanel = null;
		this.settingsButton = null;
		this.conduitStatus = { isRunning: false, isInstalled: false, version: 'N/A', mode: 'unknown' };
		this.config = {
			prompt: "$ ",
			backgroundColor: "#1e1e1e",
			fontSize: 13,
			defaultDir: "home" // "home", "current", "restore"
		};
		this.isPolling = false;
		this.keepAliveIntervalId = null;
		this._fitDebounce = null

		this._sessions = new Map(); // Map: sessionId -> { term, fitAddon, ws, containerElement, tabItem }
		this._activeSessionId = null;
		this._nextSessionId = 1; // Simple counter for session IDs

		this.panel = null; // Reference to the SidebarPanel that hosts this manager's UI
	}

	setPort(port) {
		this.port = parseInt(port) || this.port;
	}

	get wsHost() {
		return window.location.host || `localhost:${this.port}`;
	}

	get baseUrl() {
		return window.location.origin || `http://localhost:${this.port}`;
	}

	get wsUrl() {
		const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${wsProtocol}//${this.wsHost}/terminal`;
	}

	get conduitUpUrl() {
		return `${this.baseUrl}/up`;
	}

	get conduitInstallUrl() {
		return `${this.baseUrl}/install-user`;
	}

	get conduitUninstallUrl() {
		return `${this.baseUrl}/uninstall`;
	}

	get conduitKillUrl() {
		return `${this.baseUrl}/kill`;
	}

    /**
     * Initializes the TerminalManager and creates its UI within the provided panel.
     * This method is called once when the UI is created.
     * @param {HTMLElement} panel - The SidebarPanel instance that will host the terminal UI.
     */
	async init(panel) {
		this._loadSettings();
		this._updateKeepAlive();

		this.panel = panel;
		this.panel.classList.add('terminal-panel-container'); // Add a class for specific styling if needed

		// Create TabBar for managing terminal sessions
		this.sessionTabBar = new TabBar();
		this.sessionTabBar.setAttribute("slim", "");
		this.sessionTabBar.classList.add("terminal-session-tabs");
		this.sessionTabBar.classList.add("tabs-inverted");
		this.sessionTabBar.exclusiveDropType = "terminal-tab";
		this.sessionTabBar.click = (e) => this.switchTerminalSession(e.tab.config.id);
		this.sessionTabBar.close = (e) => this.deleteTerminalSession(e.tab.config.id, e.tab);

		// Button to create a new terminal session
		const newTerminalButton = new Button(""); // No text
		newTerminalButton.icon = "add_circle";
		newTerminalButton.classList.add("new-terminal-button");
		newTerminalButton.onclick = () => this.createNewTerminalSession();
		newTerminalButton.showClose = false; // Hide close button for 'New Terminal' button

		this.settingsButton = new Button("");
		this.settingsButton.icon = "settings";
		this.settingsButton.classList.add("settings-button");
		this.settingsButton.onclick = () => this.toggleSettingsPanel();
		this.sessionTabBar.append(newTerminalButton, this.settingsButton);

		// Wrapper for individual terminal instance containers
		this.terminalContainersWrapper = document.createElement("div");
		this.terminalContainersWrapper.classList.add("terminal-containers-wrapper");
		
		// NEW: Create elements for loading and empty states
		this._loadingStateElement = this._createLoadingStateElement();
		this._emptyStateElement = this._createEmptyStateElement();
		this.terminalContainersWrapper.append(this._loadingStateElement, this._emptyStateElement);

		// Append UI elements. The containing panel should use flexbox to manage layout.
		this.panel.append(this.terminalContainersWrapper, this.sessionTabBar);

		// ResizeObserver to fit the *active* terminal when its container (this panel) resizes
		const resizeObserver = new ResizeObserver(() => this.fit());
		resizeObserver.observe(this.panel);
	}

	/**
	 * Loads xterm.js scripts/styles (only once) and creates a new xterm.js instance.
	 * @param {HTMLElement} containerElement - The DOM element to open the terminal in.
	 * @returns {Promise<{term: Terminal, fitAddon: FitAddon}|null>} Object with xterm instance and fit addon, or null if loading fails.
	 */
	async _createTerminalInstance(containerElement) {
		// Load xterm.js and addons from CDN only once
		if (!this._initialized) {
			try {
				await addStylesheet("https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css");
				await loadScript("https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js");
				await loadScript("https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js");
				await loadScript("https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.8.0/lib/xterm-addon-web-links.min.js"); // Load WebLinksAddon
				this._initialized = true; // Mark scripts loaded
			} catch (error) {
				this.panel.textContent = "Error loading terminal scripts."; // Display error on the panel
				console.error(error);
				return null; // Return null if script loading fails
			}
		}

		// Create a new xterm.js instance
		const term = new window.Terminal({
			cursorBlink: true,
			fontFamily: "monospace",
			fontSize: this.config.fontSize || 13,
			cursorStyle: 'bar', // Set cursor style to thin bar
			theme: {
				background: this.config.backgroundColor || '#1e1e1e',
				foreground: '#d4d4d4',
				selectionBackground: '#5c5c5c',
			},
		});

		// Load the fit addon for this specific terminal instance
		const fitAddon = new window.FitAddon.FitAddon();
		term.loadAddon(fitAddon);

		// Load the weblinks addon for this specific terminal instance
		const webLinksAddon = new window.WebLinksAddon.WebLinksAddon();
		term.loadAddon(webLinksAddon);
		// Open the terminal in the provided container
		term.open(containerElement);

		// // Handle CTRL+1 through CTRL+9 tab switching
		// term.attachCustomKeyEventHandler((event) => {
		// 	if (event.type === "keydown") {
		// 		const isCtrl = event.ctrlKey || event.metaKey;
		// 		if (isCtrl && event.key >= "1" && event.key <= "9") {
		// 			const index = parseInt(event.key) - 1;
		// 			const tab = this.sessionTabBar.tabs[index];
		// 			if (tab) {
		// 				event.preventDefault();
		// 				event.stopPropagation();
		// 				tab.click();
		// 			}
		// 			return false;
		// 		}
		// 	}
		// 	return true;
		// });

		return { term, fitAddon };
	}

	/**
	 * Establishes a WebSocket connection for a given xterm.js instance and sets up event listeners.
	 * @param {string} sessionId - The ID of the session this WebSocket belongs to.
	 * @param {Terminal} term - The xterm.js instance to connect.
	 * @returns {WebSocket} The established WebSocket instance.
	 */
	_connectWebSocket(sessionId, term) {
		let url = this.wsUrl + `?sessionId=${sessionId}`;
		if (this.config.prompt) url += `&prompt=${encodeURIComponent(this.config.prompt)}`;
		
		let dir = "";
		
		const activeEl = document.activeElement;
		const isTerminalFocused = activeEl && (activeEl.closest?.(".terminal-instance-container") || activeEl.closest?.(".terminal-panel-container"));

		// 1. If terminal currently has focus (e.g. CTRL+N from terminal), prioritize current terminal's CWD
		if (isTerminalFocused && this._activeSessionId) {
			const activeSession = this._sessions.get(this._activeSessionId);
			if (activeSession && activeSession.cwd) {
				dir = activeSession.cwd;
			}
		}

		// 2. Directory of the currently active/focused code editor tab
		if (!dir) {
			const activeTab = window.ui?.currentTabs?.activeTab || window.ui?.leftTabs?.activeTab || window.ui?.rightTabs?.activeTab;
			if (activeTab?.config) {
				const config = activeTab.config;
				const filePath = config.handle?.path || config.fileItem?.path || config.path || (typeof config.folder === 'string' ? config.folder : null);
				if (filePath && typeof filePath === 'string') {
					const normalized = filePath.replace(/\\/g, '/');
					if (config.isDir || config.handle?.isDir) {
						dir = normalized;
					} else {
						const parts = normalized.split('/');
						parts.pop();
						dir = parts.join('/');
					}
				}
			}
		}

		// 3. Fallback: CWD of the current active terminal window
		if (!dir && this._activeSessionId) {
			const activeSession = this._sessions.get(this._activeSessionId);
			if (activeSession && activeSession.cwd) {
				dir = activeSession.cwd;
			}
		}

		// 4. Fallback: First root folder of the current project workspace
		if (!dir) {
			const rawFolder = window.workspace?.folders?.[0];
			dir = typeof rawFolder === 'string' ? rawFolder : (rawFolder?.path || rawFolder?.name || "");
		}

		if (dir) url += `&dir=${encodeURIComponent(dir)}`;

		const ws = new WebSocket(url);
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			term.clear();
			term.writeln(`Connected to terminal session: ${sessionId}\r\n`);
			this.fit(); // Fit immediately after connection is established
		};
		ws.onmessage = (event) => {
			if (typeof event.data === 'string') {
				// Handle TextMessage (JSON control messages)
				try {
					const msg = JSON.parse(event.data);
					if (msg.type === "terminalInfo") {
						const session = this._sessions.get(sessionId);
						if (session) {
							session.hostname = msg.hostname;
							session.cwd = msg.cwd;
							this._updateTerminalTabName(sessionId);
						}
						return; // Handled
					}
				} catch (e) {
					// Not JSON, write as raw text
				}
				term.write(event.data);
			} else {
				// Handle BinaryMessage (ArrayBuffer) from PTY
				const arrayBuffer = event.data;
				const uint8Array = new Uint8Array(arrayBuffer);
				
				// Quick check for CWD update escape sequence: OSC 9;9;path ST
				// We decode to text to safely run the regex and strip it if present.
				const textDecoder = new TextDecoder('utf-8', { fatal: false });
				let text = textDecoder.decode(uint8Array);
				const CWD_UPDATE_REGEX = /\x1b]9;9;([^\x1b]*)\x1b\\/g;
				let hasMatch = false;
				let match;
				
				while ((match = CWD_UPDATE_REGEX.exec(text)) !== null) {
					hasMatch = true;
					const newCwd = match[1];
					const session = this._sessions.get(sessionId);
					if (session) {
						session.cwd = newCwd;
						localStorage.setItem('terminalLastDir', newCwd);
						this._updateTerminalTabName(sessionId);
					}
					text = text.replace(match[0], '');
				}

				if (hasMatch) {
					// We modified the output, so write the text
					term.write(text);
				} else {
					// Write raw binary for perfect passthrough (fixes vim encoding issues)
					term.write(uint8Array);
				}
			}
		};
		ws.onerror = (error) => {
			console.error(`WebSocket Error for session ${sessionId}:`, error);
			term.writeln(`\r\n\n[Connection Error for session ${sessionId}: Could not connect to terminal server or connection lost.]\r\n[Please ensure the Cadence backend server is running and accessible at ${this.wsUrl}]\r\n`);
			const session = this._sessions.get(sessionId);
			if (session && session.ws === ws) {
				this.deleteTerminalSession(sessionId, session.tabItem);
			}
		};

		ws.onclose = () => {
			const session = this._sessions.get(sessionId);
			if (session && session.ws === ws) {
				console.log(`WebSocket closed for session ${sessionId}.`);
				if(session.term) term.writeln("\r\n\n[Disconnected from terminal server.]\r\n");
				this.deleteTerminalSession(sessionId, session.tabItem);
			}
		};
		// Relay data typed into xterm.js to the WebSocket (to the PTY)
		term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "data", content: data }));
			}
		});
		// Handle terminal resize events and send new dimensions to the PTY
		term.onResize(({ cols, rows }) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "resize", cols, rows }));
			}
		});
		return ws;
	}

	/**
	 * Helper to clean up a specific session's associated resources (WebSocket, xterm.js instance).
	 * Does NOT remove DOM elements or tab items, as those are handled by deleteTerminalSession.
	 * @param {string} sessionId - The ID of the session to disconnect.
	 */
	_disconnectSession(sessionId) {
		const session = this._sessions.get(sessionId);
		if (session) {
			if (session.ws) {
                // Remove handlers to prevent re-entrant calls when we manually close the socket.
                session.ws.onclose = null;
                session.ws.onerror = null;
                if (session.ws.readyState === WebSocket.OPEN) {
				    session.ws.close();
                }
			}
			if (session.term) {
				session.term.dispose(); // Dispose the xterm.js instance
			}
		}
	}

	/**
	 * Creates a new terminal session, including a new tab, xterm.js instance, and WebSocket connection.
	 */
	async createNewTerminalSession() {
		// Ensure xterm.js scripts are loaded globally first
		if (!this._initialized) {
			// Attempt to load scripts by creating a dummy instance if needed
			await this._createTerminalInstance(document.createElement("div"));
			if (!this._initialized) {
				console.error("Failed to load xterm.js scripts. Cannot create new terminal session.");
				return;
			}
		}
		const sessionId = `term-${this._nextSessionId++}`;
		const sessionName = `Terminal ${this._nextSessionId - 1}`;
		// Create a dedicated container for this new terminal instance
		const terminalContainer = document.createElement("div");
		terminalContainer.classList.add("terminal-instance-container");
		terminalContainer.style.display = "none"; // Initially hidden
		this.terminalContainersWrapper.append(terminalContainer);
		// Create the xterm.js instance and its fit addon
		const { term, fitAddon } = await this._createTerminalInstance(terminalContainer);
		if (!term) {
			terminalContainer.remove(); // Clean up if terminal creation failed
			return;
		}
		// Establish WebSocket connection for this terminal
		const ws = this._connectWebSocket(sessionId, term);
		// Create a new tab item for this session
		const tab = this.sessionTabBar.add({ name: sessionName, id: sessionId });
		tab.config.id = sessionId; // Ensure config has the session ID
		// Store all relevant data for this new session
		const sessionData = {
			term,
			fitAddon,
			ws,
			containerElement: terminalContainer,
			tabItem: tab,
		};
		this._sessions.set(sessionId, sessionData);
		// Hide the empty state message now that we have a session
		if (this._emptyStateElement) this._emptyStateElement.style.display = 'none';

		sessionData.tabItem.click(); // Activate the tab which triggers switchTerminalSession
		sessionData.term.focus(); // Focus the new terminal for immediate typing after tab activation
	}

	/**
	 * Switches the active terminal session. Hides all other terminal containers and shows the selected one.
	 * @param {string} sessionId - The ID of the terminal session to switch to.
	 */
	switchTerminalSession(sessionId) {
		if (this._activeSessionId === sessionId) {
			// If already active, ensure it's visible and fitted, then return
			if (this._sessions.has(sessionId)) {
				const session = this._sessions.get(sessionId);
				if (session.containerElement.style.display === "none") {
					session.containerElement.style.display = "block"; // Only make content visible
				}
				this.fit();
				session.term.focus(); // Focus the terminal
			}
			return;
		}
		this._sessions.forEach((session) => {
			session.containerElement.style.display = "none";
		});
		// Show the selected terminal container and update active session
		const newSession = this._sessions.get(sessionId);
		if (newSession) {
			newSession.containerElement.style.display = "block";
			this._activeSessionId = sessionId; // Update internal active session ID
			this.fit(); // Fit the newly visible terminal (before focusing)
			newSession.term.focus(); // Focus the newly active terminal
		} else {
			console.warn(`Attempted to switch to non-existent session: ${sessionId}`);
			this._activeSessionId = null; // Clear active session if not found
		}
	}

	/**
	 * Deletes a terminal session, closing its WebSocket, disposing the xterm.js instance,
	 * and removing its associated DOM elements and tab.
	 * @param {string} sessionId - The ID of the session to delete.
	 * @param {TabItem} tab - The TabItem associated with the session.
	 */
	deleteTerminalSession(sessionId, tab) {
		const session = this._sessions.get(sessionId);
		if (session) {
			this._disconnectSession(sessionId); // Close WebSocket and dispose xterm.js
			session.containerElement.remove(); // Remove its dedicated DOM container
			this._sessions.delete(sessionId); // Remove from our internal map

			if (tab) {
				this.sessionTabBar.remove(tab); // Remove its tab from the TabBar
			}

			// If the deleted session was the active one, switch to another session
			if (this._activeSessionId === sessionId) {
				// The TabBar's remove method should handle activating the next tab,
				// which will then call switchTerminalSession and set the new active ID.
				// We just need to clear the old one here.
				this._activeSessionId = null;
			}
			// If this was the last session, automatically open a new one
			if (this._sessions.size === 0 && this.conduitStatus.isRunning) {
				this.createNewTerminalSession();
			}
			
		} else {
			console.warn(`Attempted to delete non-existent session: ${sessionId}`);
		}
	}

	/**
	 * Fits the currently active xterm.js terminal to its container.
	 * Should be called when the container size changes or visibility changes.
	 */
	fit() {
		// debounce this action
		clearTimeout(this._fitDebounce)
		this._fitDebounce = setTimeout(()=>{
			if (this._activeSessionId && this._sessions.has(this._activeSessionId)) {
				const activeSession = this._sessions.get(this._activeSessionId);
				// Only attempt to fit if the terminal instance and fit addon exist,
				// and its container is actually rendered (has an offsetParent and non-zero height).
				if (activeSession.term && activeSession.fitAddon && activeSession.containerElement.offsetParent !== null && activeSession.containerElement.clientHeight > 0) {
					activeSession.fitAddon.fit();
				}
			}
		}, 100)
	}

	/**
	 * Updates the name of a terminal tab based on the session's hostname and CWD.
	 * @param {string} sessionId - The ID of the session whose tab name needs updating.
	 */
	_updateTerminalTabName(sessionId) {
		const session = this._sessions.get(sessionId);
		if (session && session.tabItem) {
			let tabDisplayName = `Terminal ${sessionId.split('-')[1]}`; // Default name
			let fullPathTooltip = '';

			if (session.hostname && session.cwd) {
				const pathSegments = session.cwd.split(/[\\/]/).filter(s => s !== ''); // Split by / or \ and remove empty
				if (pathSegments.length > 2) {
					tabDisplayName = `(${session.hostname}): .../${pathSegments[pathSegments.length - 2]}/${pathSegments[pathSegments.length - 1]}`;
				} else {
					tabDisplayName = `(${session.hostname}):${session.cwd}`;
				}
				fullPathTooltip = `(${session.hostname}):${session.cwd}`;
			}
			// Update the tab item's display name
			session.tabItem.name = tabDisplayName;
			session.tabItem.setAttribute('title', fullPathTooltip); // Add full path as a title attribute (tooltip)
		}
	}

	/**
	 * Initializes the terminal panel. If no sessions exist, it creates the first one.
	 * If sessions exist, it ensures the currently active one is displayed and fitted.
	 * This method is intended to be called when the terminal sidebar panel becomes active.
	 */
	async connect() {
		this.terminalContainersWrapper.style.display = 'block'; // Show parent wrapper
		this._sessions.forEach(session => session.containerElement.style.display = 'none'); // Hide instances
		this.sessionTabBar.style.display = 'flex';
		
		if (this._sessions.size === 0) {
			if (this.conduitStatus.isRunning) {
				this.createNewTerminalSession();
			} else {
				this._emptyStateElement.style.display = 'flex';
			}
		} else {
			// Ensure an active session is selected if sessions exist
			if (!this._activeSessionId || !this._sessions.has(this._activeSessionId)) {
				this._activeSessionId = this._sessions.keys().next().value;
			}
			
			const session = this._sessions.get(this._activeSessionId);
			if (session) {
				// Activate the tab in the UI if it's not already active
				if (session.tabItem && !session.tabItem.hasAttribute("active")) {
					session.tabItem.click();
				}
				session.containerElement.style.display = 'block';
				this.fit();
				session.term.focus();
			}
		}
	}

	/**
	 * Loads settings from localStorage.
	 */
	_loadSettings() {
		const storedPrompt = localStorage.getItem('terminalPrompt');
		if (storedPrompt !== null) this.config.prompt = storedPrompt;
		
		const storedBgColor = localStorage.getItem('terminalBgColor');
		if (storedBgColor !== null) this.config.backgroundColor = storedBgColor;

		const storedFontSize = localStorage.getItem('terminalFontSize');
		if (storedFontSize !== null) this.config.fontSize = parseInt(storedFontSize);

		const storedDefaultDir = localStorage.getItem('terminalDefaultDir');
		if (storedDefaultDir !== null) this.config.defaultDir = storedDefaultDir;
	}

	/**
	 * Saves settings to localStorage.
	 */
	_saveSettings() {
		localStorage.setItem('terminalPrompt', this.config.prompt);
		localStorage.setItem('terminalBgColor', this.config.backgroundColor);
		localStorage.setItem('terminalFontSize', this.config.fontSize);
		localStorage.setItem('terminalDefaultDir', this.config.defaultDir);
	}

	_updateKeepAlive() {
		if (this.keepAliveIntervalId) {
			clearInterval(this.keepAliveIntervalId);
			this.keepAliveIntervalId = null;
		}
		if (this.config.keepAlive) {
			this.keepAliveIntervalId = setInterval(async () => {
				// Only ping if the panel is visible and conduit is running.
				if (this.panel.offsetParent && this.conduitStatus.isRunning) {
					try {
						// Use a short timeout to prevent hanging requests
						await fetch(this.conduitUpUrl, { signal: AbortSignal.timeout(500) });
						console.debug('Conduit keep-alive ping sent.');
					} catch (e) {
						console.debug('Keep-alive ping failed, conduit might be down.');
					}
				}
			}, 10000); // every 60 seconds
		}
	}

	/**
	 * Checks if the Conduit backend service is running and updates internal status.
	 */
	async _checkConduitStatus() {
		// Reset status before check, but preserve version info if server goes down.
		this.conduitStatus.isRunning = false;
		// Do not reset isInstalled here; we want to preserve the last known state if the server is down.
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 200); // Short timeout
		try {
			const response = await fetch(this.conduitUpUrl, { signal: controller.signal });
			clearTimeout(timeoutId);

			if (response.ok) { // Server is up, get authoritative status.
				const data = await response.json();
				this.conduitStatus.isRunning = true;
				this.conduitStatus.isInstalled = data.is_installed || false;
				this.conduitStatus.version = data.version || 'N/A';
				this.conduitStatus.mode = data.mode || 'unknown';
			} else { // Server is up but returned an error. Treat as not running.
				this.conduitStatus.isRunning = false;
			}
		} catch (error) {
			clearTimeout(timeoutId);
			this.conduitStatus.isRunning = false;
		}
	}

	_startPollingConduit() {
		if (this.isPolling) return;
		this.isPolling = true;
		
		this._pollingIntervalId = setInterval(async () => {
			// Stop if panel is hidden
			if (!this.panel.offsetParent) return this._stopPollingConduit();
			
			await this._checkConduitStatus();
			if (this.conduitStatus.isRunning) {
				this._stopPollingConduit();
				this.toggleSettingsPanel(false);
				
				// Now that it's running, re-run the full connection logic.
				this.connect();
			}
		}, 2000); // Poll every 2 seconds
	}

	_stopPollingConduit() {
		if (this._pollingIntervalId) {
			clearInterval(this._pollingIntervalId);
			this._pollingIntervalId = null;
		}
		this.isPolling = false;
	}

	async _installConduit(button) {
		button.textContent = 'Installing...';
		button.disabled = true;
		const downloadContainer = this.setupGuideElement.querySelector('#conduit-download-section');
		const actionsContainer = this.setupGuideElement?.querySelector('#conduit-actions-section');
		try {
			const response = await fetch(this.conduitInstallUrl);
			const outputText = await response.text();
			
			if (downloadContainer) { // Use the download container to show output
				let outputPre = actionsContainer.querySelector('.install-output');
				if (!outputPre) {
					outputPre = document.createElement('pre');
					outputPre.className = 'install-output';
					actionsContainer.append(outputPre);
				}
				outputPre.textContent = outputText;
			}
			if (!response.ok) {
				throw new Error(`Installation failed. Server responded with ${response.status}`);
			}
			
			button.textContent = 'Restarting Conduit...';
			localStorage.setItem('conduitInstalled', 'true'); // Set client-side flag
			this.config.autoLaunch = true;
			this._saveSettings();
			
			try { await fetch(this.conduitKillUrl); } catch (e) { /* Expected */ }
			await this._launchConduitViaProtocol();
			button.textContent = 'Waiting for restart...';
			this._startPollingConduit(); // Polling will detect the new instance and call connect().

		} catch (error) {
			console.error("Conduit installation failed:", error);
			button.textContent = 'Installation Failed (Retry)';
			button.disabled = false;
		}
	}

	/**
	 * Launches the Conduit helper via its protocol URL using a temporary iframe.
	 * This is async and includes a delay to allow the OS to process the request.
	 */
	async _launchConduitViaProtocol() {
		const iframe = document.createElement('iframe');
		iframe.style.display = 'none';
		document.body.appendChild(iframe);
		iframe.src = CONDUIT_PROTOCOL_URL;
		// The iframe is removed after a short delay to ensure the protocol launch is triggered.
		// await new Promise(resolve => setTimeout(() => { iframe.remove(); resolve(); }, 500));
		iframe.addEventListener("loaded", ()=>{ 
			console.debug("conduit:// loaded via iframe")
			iframe.remove()
		})
	}

	async _uninstallConduit(button) {
		button.textContent = 'Uninstalling...';
		button.disabled = true;

		// Terminate all open terminal sessions before uninstalling
		for (const [sessionId, session] of this._sessions.entries()) {
			this.deleteTerminalSession(sessionId, session.tabItem);
		}

		try { // Use Modal.notice for alerts
			const response = await fetch(this.conduitUninstallUrl);
			if (!response.ok) throw new Error(`Server responded with ${response.status}`);
			
			localStorage.removeItem('conduitInstalled'); // Clear client-side flag
			this.conduitStatus.isInstalled = false; // Update local state immediately
			try { await fetch(this.conduitKillUrl); } catch(e) { /* Expected to fail if server is already gone */ }
			Modal.notice("Conduit has been uninstalled and all terminal sessions have been closed.", "Uninstalled");
			this.toggleSettingsPanel(false);
		} catch (error) {
			console.error("Conduit uninstallation failed:", error);
			Modal.notice(`Uninstallation failed: <small>${error.message}</small>`, "Uninstallation Failed");
			button.textContent = 'Uninstall Conduit';
			button.disabled = false;
		}
	}

	_createSettingsPanel() {
		const panel = document.createElement("div")
		panel.className = "settings-panel-container" // Wrapper
		panel.style.display = 'none'; // Initially hidden

		const settingsContent = new SettingsPanel()
		panel.append(settingsContent)

		settingsContent.on("settings-saved", (e) => {
			this.config.prompt = e.detail["terminal-prompt"];
			this.config.backgroundColor = e.detail["terminal-bg-color"];
			this.config.fontSize = parseInt(e.detail["terminal-font-size"]);
			this.config.defaultDir = e.detail["terminal-default-dir"];
			this._saveSettings()
			this.toggleSettingsPanel(false); // Close the settings panel after saving
		})

		settingsContent.on("install-conduit", (e) => this._installConduit(e.detail.element))
		settingsContent.on("uninstall-conduit", async (e) => { // Make this callback async
			const confirmed = await Modal.confirm( // Use Modal.confirm
				'Confirm Uninstall',
					"Are you sure you want to uninstall the Conduit helper? This will close all active terminal sessions and stop the helper process."
				)
			if (confirmed) {
				this._uninstallConduit(e.detail.element)
			}
		})

		return panel;
	}

	async _renderSettingsPanel() {
		await this._checkConduitStatus(); // Get latest status

		const schema = [
			{ type: "text", id: "terminal-prompt", label: "Custom Prompt", text: "Custom PS1 prompt to forward to the server" },
			{ type: "text", id: "terminal-bg-color", label: "Background Color", text: "CSS color for the terminal background" },
			{ type: "number", id: "terminal-font-size", label: "Font Size", text: "Font size in pixels" },
			{
				type: "select",
				id: "terminal-default-dir",
				label: "Default Directory",
				options: [
					{ value: "home", text: "User Home" },
					{ value: "current", text: "Current File Directory" },
					{ value: "restore", text: "Last Used Directory" }
				]
			}
		]

		if (this.conduitStatus.isInstalled) {
			schema.push({
				type: "button",
				id: "uninstall-btn",
				label: "Uninstall",
				text: "Uninstall Conduit",
				className: "themed cancel",
				onClickEvent: "uninstall-conduit",
				help: "Remove the app and disable the protocol handler."
			})
		} else if (this.conduitStatus.isRunning) {
			schema.push({ type: "button", id: "install-btn", label: "Install Conduit", className: "themed", onClickEvent: "install-conduit" })
		}

		const values = {
			"terminal-prompt": this.config.prompt,
			"terminal-bg-color": this.config.backgroundColor,
			"terminal-font-size": this.config.fontSize,
			"terminal-default-dir": this.config.defaultDir
		}

		const panelContent = this.settingsPanel.querySelector("ui-settings-panel")
		panelContent.render(schema, values)
	}
	_createLoadingStateElement() {
		const el = document.createElement('div');
		el.className = 'terminal-background-element';
		el.innerHTML = `
			<div class="spinner-container">
				<div class="loading-spinner"></div>
			</div>
			<div class="caption">Connecting to Conduit...</div>
		`;
		el.style.display = 'none';
		return el;
	}
	_createEmptyStateElement() {
		const el = document.createElement('div');
		el.className = 'terminal-background-element';
		el.innerHTML = `
			<ui-icon style="font-size: 48px; opacity: 0.5;">terminal</ui-icon>
			<div class="caption">Connected to Conduit<br/>Press Ctrl+N to create a new terminal session.</div>
		`;
		el.style.display = 'none';
		return el;
	}
	toggleSettingsPanel(forceState=undefined) {
		if (window.ui && window.ui.openTerminalSettings) {
			window.ui.openTerminalSettings();
		}
	}
}

export default new TerminalManager();
