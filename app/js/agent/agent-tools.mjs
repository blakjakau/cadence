import conduit from '../conduit-client.mjs';
import AgentBackup from './agent-backup.mjs';
import { tools } from "../ai-manager-tools-schema.mjs";
import workspaceClient from '../workspace-client.mjs';
import { Agent } from './agent.mjs';
import AIConnections from '../ai-connections.mjs';
import syntaxValidator from '../syntax-validator.mjs';

/**
 * Implements the core tools for Cadence.
 * Prioritizes Conduit for access, with fallback to browser APIs where possible.
 */
class AgentTools {
    constructor() {
        this.conduit = conduit;
        this.editBuffer = {}; // Tracks { [resolvedPath]: { markerIds: [] } }
    }

    _resolveAndValidatePath(targetPath) {
        if (typeof targetPath !== 'string') {
            throw new Error("Path must be a string");
        }
        const folders = window.workspace?.folders || [];
        if (folders.length === 0) {
            throw new Error("No workspace folders are open. Cannot validate paths.");
        }

        // Clean and normalize targetPath
        targetPath = targetPath.replace(/\\/g, '/');

        // Check if targetPath is already absolute and starts with one of the folders
        let resolvedPath = "";
        const matchesAbsolute = folders.some(folder => {
            const normalizedFolder = folder.replace(/\\/g, '/').replace(/\/$/, '');
            return targetPath === normalizedFolder || targetPath.startsWith(normalizedFolder + '/');
        });

        if (targetPath.startsWith('/') && matchesAbsolute) {
            resolvedPath = targetPath;
        } else {
            // It is a relative path or has a partial overlap.
            // Let's find if the targetPath starts with an overlapping segment of any open folder
            const baseFolder = folders[0].replace(/\\/g, '/').replace(/\/$/, '');
            const folderSegments = baseFolder.split('/').filter(p => p);
            
            // Normalize targetPath segments
            let targetSegments = targetPath.split('/').filter(p => p);
            
            // Find maximum segment overlap
            let maxOverlap = 0;
            for (let k = 1; k <= Math.min(folderSegments.length, targetSegments.length); k++) {
                const folderSlice = folderSegments.slice(-k);
                const targetSlice = targetSegments.slice(0, k);
                if (folderSlice.join('/') === targetSlice.join('/')) {
                    maxOverlap = k;
                }
            }
            
            if (maxOverlap > 0) {
                // Strip the overlapping prefix from the target segments
                targetSegments = targetSegments.slice(maxOverlap);
            }
            
            const cleanRelativePath = targetSegments.join('/');
            resolvedPath = cleanRelativePath ? `${baseFolder}/${cleanRelativePath}` : baseFolder;
        }

        // Clean directory traversal sequences
        const parts = resolvedPath.split('/');
        const resolvedParts = [];
        for (const part of parts) {
            if (part === '.' || part === '') continue;
            if (part === '..') {
                if (resolvedParts.length > 0) {
                    resolvedParts.pop();
                }
            } else {
                resolvedParts.push(part);
            }
        }
        
        // Reconstruct absolute path
        const finalResolvedPath = '/' + resolvedParts.join('/');
        
        // Clean double/triple slashes
        const cleanFinalResolvedPath = finalResolvedPath.replace(/\/+/g, '/');

        // Verify it starts with at least one of the allowed folders, or is in the workspace file index
        const isSafe = folders.some(folder => {
            const normalizedFolder = folder.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
            
            // Case 1: Folder is relative or dot
            if (normalizedFolder === '.' || normalizedFolder === '' || !normalizedFolder.startsWith('/')) {
                return true; // Any clean path in the workspace is allowed
            }
            
            // Case 2: Check standard absolute prefix
            return cleanFinalResolvedPath === normalizedFolder || cleanFinalResolvedPath.startsWith(normalizedFolder + '/');
        }) || (window.ui?.fileList?.index?.files || []).some(file => {
            // Case 3: Fallback check against the loaded workspace file index
            const normalizedFilePath = file.path.replace(/\\/g, '/').replace(/\/+/g, '/');
            return cleanFinalResolvedPath === normalizedFilePath || 
                   normalizedFilePath === targetPath.replace(/\\/g, '/').replace(/\/+/g, '/');
        });

        if (!isSafe) {
            console.error("Security violation check failed:", {
                targetPath,
                folders,
                cleanFinalResolvedPath,
                indexCount: window.ui?.fileList?.index?.files?.length
            });
            throw new Error(`Security Exception: Access to path '${targetPath}' is denied. It lies outside the allowed workspace folders.`);
        }

        return cleanFinalResolvedPath;
    }

    _normalizePathForTabComparison(p) {
        if (!p) return "";
        return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');
    }

    _findOpenTab(resolvedPath) {
        if (!resolvedPath) return null;
        const normTarget = this._normalizePathForTabComparison(resolvedPath);
        
        if (window.ui?.leftTabs?.tabs || window.ui?.rightTabs?.tabs) {
            const openTabs = [...(window.ui.leftTabs?.tabs || []), ...(window.ui.rightTabs?.tabs || [])];
            return openTabs.find(tab => {
                if (!tab.config || !tab.config.path || !tab.config.session) return false;
                const normTabPath = this._normalizePathForTabComparison(tab.config.path);
                return normTabPath === normTarget;
            }) || null;
        }
        return null;
    }

    /**
     * Lists files in a directory.
     * @param {string} path 
     * @returns {Promise<string>}
     */
    async listFiles(path = '.') {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsList(resolvedPath);
                if (result.error) throw new Error(result.error);
                if (Array.isArray(result.data)) {
                    const sorted = [...result.data].sort((a, b) => {
                        const aDir = a.is_dir || a.isDir;
                        const bDir = b.is_dir || b.isDir;
                        if (aDir && !bDir) return -1;
                        if (!aDir && bDir) return 1;
                        return a.name.localeCompare(b.name);
                    });
                    return sorted.map(f => `${(f.is_dir || f.isDir) ? '📁 [DIR] ' : '📄 '}${f.name}`).join('\n');
                }
                return "No files found or invalid response.";
            } else {
                return "Error: Conduit not connected. Manual listing via browser API not implemented for agent yet.";
            }
        } catch (error) {
            return `Error listing files: ${error.message}`;
        }
    }

    /**
     * Gets detailed information about a file or folder.
     * @param {string} path 
     * @returns {Promise<string>}
     */
    async fileInfo(path) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsFileInfo(resolvedPath);
                if (result.error) throw new Error(result.error);
                const data = result.data;
                return `Path: ${data.path}
Full Path: ${data.fullPath}
Type: ${data.isDir ? 'Folder' : 'File'}
Size: ${data.sizeFormatted} (${data.size.toLocaleString()} bytes)
Modified: ${data.modTimeStr}
Git Status: ${data.gitStatus}`;
            } else {
                return "Error: Conduit not connected.";
            }
        } catch (error) {
            return `Error getting file info: ${error.message}`;
        }
    }

    /**
     * Searches the web using DuckDuckGo HTML search.
     * @param {string} query
     * @returns {Promise<string>}
     */
    async webSearch(query) {
        try {
            if (!query) return "Error: Query is empty.";
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsWebGet(url);
                if (result.error) throw new Error(result.error);
                const html = result.data;
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const results = [];
                const elements = doc.querySelectorAll('.result');
                elements.forEach(el => {
                    const titleEl = el.querySelector('.result__a');
                    const snippetEl = el.querySelector('.result__snippet');
                    if (titleEl) {
                        results.push({
                            title: titleEl.textContent.trim(),
                            url: titleEl.getAttribute('href'),
                            snippet: snippetEl ? snippetEl.textContent.trim() : ""
                        });
                    }
                });
                if (results.length === 0) {
                    return "No search results found.";
                }
                return results.slice(0, 8).map((r, i) => `Result ${i + 1}:
Title: ${r.title}
URL: ${r.url}
Snippet: ${r.snippet}`).join('\n\n');
            } else {
                return "Error: Conduit not connected.";
            }
        } catch (error) {
            return `Error performing web search: ${error.message}`;
        }
    }

    async webFetch(url) {
        try {
            if (!url) return "Error: URL is empty.";
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsWebGet(url);
                if (result.error) throw new Error(result.error);
                const html = result.data;
                
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const elementsToRemove = doc.querySelectorAll('script, style, head, nav, footer, iframe, noscript');
                elementsToRemove.forEach(el => el.remove());
                let text = doc.body ? doc.body.innerText || doc.body.textContent : "";
                text = text.replace(/\s+/g, ' ').trim();

                if (!text) return "The page contains no readable text content.";

                const maxLength = 6000;
                let truncated = text;
                if (text.length > maxLength) {
                    truncated = text.substring(0, maxLength) + "... [Content Truncated]";
                }

                const activeAi = window.ui?.aiManager?.ai;
                if (activeAi && activeAi.isConfigured()) {
                    const prompt = `Please summarize or extract the key information from the following webpage content. Focus on details relevant to code, API usage, libraries, or programming information if present.
--- Webpage Content ---
${truncated}`;
                    const systemPrompt = "You are a helpful assistant. Clean up and summarize the web content provided, keeping it concise and factual.";
                    try {
                        const summary = await new Promise((resolve, reject) => {
                            const oldSystem = activeAi.config.system;
                            activeAi.config.system = systemPrompt;
                            const oldAgentMode = window.ui?.aiManager?.agentMode;
                            if (window.ui?.aiManager) window.ui.aiManager.agentMode = false;

                            activeAi.generate(prompt, {
                                onDone: (res) => {
                                    activeAi.config.system = oldSystem;
                                    if (window.ui?.aiManager) window.ui.aiManager.agentMode = oldAgentMode;
                                    resolve(res);
                                },
                                onError: (err) => {
                                    activeAi.config.system = oldSystem;
                                    if (window.ui?.aiManager) window.ui.aiManager.agentMode = oldAgentMode;
                                    reject(err);
                                }
                            }).catch(err => {
                                activeAi.config.system = oldSystem;
                                if (window.ui?.aiManager) window.ui.aiManager.agentMode = oldAgentMode;
                                reject(err);
                            });
                        });
                        return summary;
                    } catch (err) {
                        console.error("Failed to summarize webpage using active model connection, returning raw text:", err);
                    }
                }

                return truncated;
            } else {
                return "Error: Conduit not connected.";
            }
        } catch (error) {
            return `Error fetching webpage: ${error.message}`;
        }
    }

    /**
     * Performs high-quality research using Tavily AI-native search if API key is available,
     * otherwise falls back to DuckDuckGo web search.
     * @param {string} query
     * @returns {Promise<string>}
     */
    async research(query) {
        try {
            if (!query) return "Error: Query is empty.";
            const apiKey = localStorage.getItem("tavilyApiKey");

            if (apiKey) {
                const response = await fetch("https://api.tavily.com/search", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        api_key: apiKey,
                        query: query,
                        search_depth: "advanced",
                        include_answer: true,
                        max_results: 5
                    })
                });

                if (!response.ok) {
                    throw new Error(`Tavily API responded with ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();

                if (data.results && data.results.length > 0) {
                    let output = "";
                    if (data.answer) {
                        output += `Summary Answer: ${data.answer}\n\n`;
                    }

                    output += data.results.map((r, i) => {
                        return `Result ${i + 1}:
Title: ${r.title}
URL: ${r.url}
Snippet: ${r.content || r.snippet || ""}`;
                    }).join('\n\n');

                    return output;
                } else {
                    return "Tavily returned no results. Falling back to web search.";
                }
            } else {
                // No API key, fall back to existing webSearch
                return await this.webSearch(query);
            }
        } catch (error) {
            console.error("[AgentTools] Tavily research failed, falling back to web search:", error);
            return await this.webSearch(query);
        }
    }

    /**
     * Helper to verify if the agent is permitted to interact with the file.

     * Enforces size limits: max 1MB generally, max 0.5MB for binaries.
     * @param {string} path 
     * @returns {boolean|string} Returns true if permitted, or an error string if blocked.
     */
    _checkFilePermitted(path) {
        if (!window.ui?.fileList?.index?.files) return true; 

        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            
            const file = window.ui.fileList.index.files.find(f => {
                const fPath = f.path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
                const rPath = resolvedPath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
                return fPath === rPath || fPath.endsWith('/' + rPath) || rPath.endsWith('/' + fPath);
            });

            if (!file) return true; 

            const size = file.size || 0;
            const ONE_MB = 1024 * 1024;
            const HALF_MB = 512 * 1024;

            if (size > ONE_MB) {
                return `Error: Agent interaction blocked. File is ${(size / ONE_MB).toFixed(2)}MB, exceeding the 1MB safety limit.`;
            }

            const extension = resolvedPath.split('.').pop().toLowerCase();
            const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'bin', 'dll', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'wasm', 'woff', 'woff2', 'ttf', 'eot'];
            
            if (binaryExtensions.includes(extension) && size > HALF_MB) {
                return `Error: Agent interaction blocked. Binary file is ${(size / 1024).toFixed(2)}KB, exceeding the 0.5MB safety limit for binary files.`;
            }

            return true;
        } catch (error) {
            return true; // Let it fail normally later if path is invalid
        }
    }

    /**
     * Reads a file's content.
     * @param {string} path 
     */
    async readFile(path, startLine, lineCount, bypassCache = false) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            
            // Try to find if the file is open in the editor
            const openTab = this._findOpenTab(resolvedPath);

            let content = "";
            if (openTab && openTab.config.session) {
                console.debug(`[AgentTools] Reading ${path} from open editor buffer.`);
                const session = openTab.config.session;
                const edits = this.editBuffer[resolvedPath]?.edits || [];
                content = this._getCleanContentOfSession(session, edits);
            } else if (this.conduit.isConnected) {
                const result = await this.conduit.wsRead(resolvedPath);
                if (result.error) throw new Error(result.error);
                if (result.data) {
                    try {
                        content = atob(result.data);
                    } catch (e) {
                        // If not valid base64 (or already decoded), return as-is
                        content = result.data;
                    }
                } else {
                    content = result.content || "";
                }
            } else {
                return "Error: Conduit not connected. Use @file context to provide content.";
            }

            // Check if content matches an existing unpruned tool response
            if (!bypassCache && startLine === undefined && lineCount === undefined && content && this._isContentInUnprunedHistory(content)) {
                return "Content is unchanged from previous request";
            }

            if (startLine !== undefined || lineCount !== undefined) {
                const lines = content.split(/\r?\n/);
                const start = startLine !== undefined ? Math.max(1, parseInt(startLine, 10)) - 1 : 0;
                const count = lineCount !== undefined ? Math.max(0, parseInt(lineCount, 10)) : lines.length;
                content = lines.slice(start, start + count).join('\n');
            }

            return content;
        } catch (error) {
            return `Error reading file: ${error.message}`;
        }
    }

    /**
     * Gets a clean copy of the session content with all pending review edits applied.
     * @param {Object} session - The Ace session
     * @param {Array} edits - The array of pending edits
     * @returns {string} Clean session content
     */
    _getCleanContentOfSession(session, edits) {
        if (!edits || edits.length === 0) {
            return session.getValue();
        }

        const doc = session.getDocument();
        const dirtyContent = session.getValue();

        // Convert anchor positions to dirty 1D offsets
        const ranges = edits.map(edit => {
            const startPos = edit.startDeletedAnchor.getPosition();
            const endPos = edit.startAddedAnchor.getPosition();
            return {
                start: doc.positionToIndex(startPos),
                end: doc.positionToIndex(endPos)
            };
        });

        // Sort ranges by start offset ascending
        ranges.sort((a, b) => a.start - b.start);

        let cleanContent = "";
        let currentDirty = 0;

        for (const range of ranges) {
            if (range.start > currentDirty) {
                cleanContent += dirtyContent.substring(currentDirty, range.start);
            }
            currentDirty = range.end;
        }

        if (currentDirty < dirtyContent.length) {
            cleanContent += dirtyContent.substring(currentDirty);
        }

        return cleanContent;
    }

    /**
     * Maps a 1D offset in the clean content back to a 1D offset in the dirty Ace session content.
     * @param {Object} session - The Ace session
     * @param {Array} edits - The array of pending edits
     * @param {number} cleanIndex - The 1D offset in clean content
     * @returns {number} The 1D offset in dirty content
     */
    _mapCleanToDirtyOffset(session, edits, cleanIndex) {
        if (!edits || edits.length === 0) {
            return cleanIndex;
        }

        const doc = session.getDocument();
        const dirtyLength = session.getValue().length;

        // Convert anchor positions to dirty 1D offsets
        const ranges = edits.map(edit => {
            const startPos = edit.startDeletedAnchor.getPosition();
            const endPos = edit.startAddedAnchor.getPosition();
            return {
                start: doc.positionToIndex(startPos),
                end: doc.positionToIndex(endPos)
            };
        });

        // Sort ranges by start offset ascending
        ranges.sort((a, b) => a.start - b.start);

        let currentDirty = 0;
        let currentClean = 0;

        for (const range of ranges) {
            const segmentLen = range.start - currentDirty;
            if (cleanIndex >= currentClean && cleanIndex <= currentClean + segmentLen) {
                return currentDirty + (cleanIndex - currentClean);
            }
            currentClean += segmentLen;
            currentDirty = range.end;
        }

        const finalLen = dirtyLength - currentDirty;
        if (cleanIndex >= currentClean && cleanIndex <= currentClean + finalLen) {
            return currentDirty + (cleanIndex - currentClean);
        }

        return dirtyLength;
    }

    _isContentInUnprunedHistory(content) {
        try {
            const aiManager = window.ui?.aiManager;
            if (!aiManager || !aiManager.activeSession || !aiManager.historyManager) return false;

            const prepared = aiManager.historyManager.prepareMessagesForAI() || [];
            for (const msg of prepared) {
                // Check in user function/tool response contents as well as direct text contents
                if (msg.content && msg.content.includes(content)) {
                    return true;
                }
            }
        } catch (e) {
            console.error("[AgentTools] Error checking unpruned history:", e);
        }
        return false;
    }

    /**
     * Reads a file's structural outline.
     * @param {string} path 
     */
    async readFileOutline(path) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            let outline = "";
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsGetOutline(resolvedPath);
                if (result.error) throw new Error(result.error);
                outline = result.data || "No outline available.";
            } else {
                return "Error: Conduit not connected.";
            }

            // Check if outline matches an existing unpruned tool response
            if (outline && this._isContentInUnprunedHistory(outline)) {
                return "Content is unchanged from previous request";
            }

            return outline;
        } catch (error) {
            return `Error reading file outline: ${error.message}`;
        }
    }

    /**
     * Searches for a symbol in the workspace index.
     * @param {string} query 
     */
    async readSymbol(query) {
        try {
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsSearchSymbols(query);
                if (result.error) throw new Error(result.error);
                if (!result.data || result.data.length === 0) return "No matches found.";
                return result.data.map(sym => `${sym.filePath}:${sym.line} - ${sym.signature}`).join('\n');
            } else {
                return "Error: Conduit not connected.";
            }
        } catch (error) {
            return `Error searching symbol: ${error.message}`;
        }
    }

    /**
     * Searches for text across files (Grep) accelerating using Go and local buffers.
     * @param {string} query 
     */
    async searchFiles(query) {
        try {
            if (typeof query !== 'string') {
                return "Error: Query must be a string.";
            }
            const matches = [];
            const lowercaseQuery = query.toLowerCase();
            const searchedPaths = new Set();

            // 1. Search all local active editor buffers (open files) first
            const openTabs = [...(window.ui?.leftTabs?.tabs || []), ...(window.ui?.rightTabs?.tabs || [])];
            for (const tab of openTabs) {
                const path = tab.config?.path;
                if (!path || !tab.config.session) continue;
                
                const extension = path.split('.').pop().toLowerCase();
                const skipExtensions = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'bin', 'dll'];
                if (skipExtensions.includes(extension)) continue;

                try {
                    const resolvedPath = this._resolveAndValidatePath(path);
                    searchedPaths.add(resolvedPath);

                    const edits = this.editBuffer[resolvedPath]?.edits || [];
                    const content = this._getCleanContentOfSession(tab.config.session, edits);
                    if (content && content.toLowerCase().includes(lowercaseQuery)) {
                        const lines = content.split('\n');
                        lines.forEach((line, idx) => {
                            if (line.toLowerCase().includes(lowercaseQuery)) {
                                matches.push({ path, line: idx + 1, content: line.trim() });
                            }
                        });
                    }
                } catch (e) {
                    // Ignore local search errors
                }
            }

            // 2. Search remaining files using backend Go server if connected
            if (this.conduit.isConnected) {
                console.debug(`[AgentTools] Running backend Go search for query: "${query}"`);
                try {
                    const res = await this.conduit.wsSearch(".", "content", query);
                    if (res && !res.error && Array.isArray(res.data)) {
                        for (const match of res.data) {
                            try {
                                const resolved = this._resolveAndValidatePath(match.path);
                                if (searchedPaths.has(resolved)) continue; // Already searched
                                matches.push({
                                    path: match.path,
                                    line: match.line,
                                    content: match.content
                                });
                            } catch (e) {
                                // Skip files that fail path resolution
                            }
                        }
                    }
                } catch (e) {
                    console.error("[AgentTools] Backend search failed, falling back...", e);
                }
            }

            // 3. Fallback to client-side indexing if backend search is offline/unavailable
            if (matches.length === 0 && window.ui?.fileList?.index?.files) {
                console.debug("[AgentTools] Falling back to client-side files index search");
                const files = window.ui.fileList.index.files;
                let searchedCount = 0;
                for (const file of files) {
                    if (file.isDir) continue;
                    
                    try {
                        const resolvedPath = this._resolveAndValidatePath(file.path);
                        if (searchedPaths.has(resolvedPath)) continue;
                        
                        searchedCount++;
                        searchedPaths.add(resolvedPath);

                        // Filename match check
                        if (file.path.toLowerCase().includes(lowercaseQuery)) {
                            matches.push({ path: file.path, type: "filename_match" });
                        }

                        const extension = file.path.split('.').pop().toLowerCase();
                        const skipExtensions = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'bin', 'dll'];
                        if (skipExtensions.includes(extension)) continue;

                        const content = await this.readFile(resolvedPath, undefined, undefined, true);
                        if (content && !content.startsWith("Error:") && content.toLowerCase().includes(lowercaseQuery)) {
                            const lines = content.split('\n');
                            lines.forEach((line, idx) => {
                                if (line.toLowerCase().includes(lowercaseQuery)) {
                                    matches.push({ path: file.path, line: idx + 1, content: line.trim() });
                                }
                            });
                        }
                    } catch (e) {
                        continue;
                    }

                    if (matches.length >= 50) break;
                    if (searchedCount >= 200) break;
                }
            }

            if (matches.length === 0) return "No matches found.";

            // Group matches by path to count hits per file
            const matchesByPath = {};
            const filenameMatches = [];

            for (const m of matches) {
                if (m.type === "filename_match") {
                    filenameMatches.push(m);
                } else {
                    if (!matchesByPath[m.path]) {
                        matchesByPath[m.path] = [];
                    }
                    matchesByPath[m.path].push(m);
                }
            }

            const lineData = [];
            for (const m of filenameMatches) {
                lineData.push({ text: `[Match in filename] ${m.path}`, path: m.path });
            }

            for (const path in matchesByPath) {
                const fileMatches = matchesByPath[path];
                if (fileMatches.length >= 3) {
                    const first = fileMatches[0];
                    lineData.push({ text: `${first.path}:${first.line}: ${first.content}`, path });
                    lineData.push({
                        text: `${path}: 1 of ${fileMatches.length} matches, use \`search_in_file\` for more`,
                        path,
                        isGate: true
                    });
                } else {
                    for (const fm of fileMatches) {
                        lineData.push({ text: `${fm.path}:${fm.line}: ${fm.content}`, path });
                    }
                }
            }

            const totalRawLength = lineData.map(ld => ld.text).join('\n').length;
            const allPaths = new Set(lineData.map(ld => ld.path));
            const Y = allPaths.size;

            if (totalRawLength > 4096) {
                let bestLines = [];
                let bestX = 0;
                let foundGate = false;

                // Find the last isGate line that fits under 4KB with the header prepended
                for (let i = lineData.length - 1; i >= 0; i--) {
                    if (lineData[i].isGate) {
                        const subList = lineData.slice(0, i + 1);
                        const pathsInSubList = new Set(subList.map(ld => ld.path));
                        const candidateX = pathsInSubList.size;
                        const header = `Too many search matches, showing ${candidateX} of ${Y}\n\n`;
                        const candidateText = header + subList.map(ld => ld.text).join('\n');
                        if (candidateText.length <= 4096) {
                            bestLines = subList;
                            bestX = candidateX;
                            foundGate = true;
                            break;
                        }
                    }
                }

                // Fallback: if no gate line fits or exists, truncate to the maximum complete paths under 4KB
                if (!foundGate) {
                    for (let i = lineData.length - 1; i >= 0; i--) {
                        const subList = lineData.slice(0, i + 1);
                        const pathsInSubList = new Set(subList.map(ld => ld.path));
                        const candidateX = pathsInSubList.size;
                        const header = `Too many search matches, showing ${candidateX} of ${Y}\n\n`;
                        const candidateText = header + subList.map(ld => ld.text).join('\n');
                        if (candidateText.length <= 4096) {
                            bestLines = subList;
                            bestX = candidateX;
                            break;
                        }
                    }
                }

                const header = `Too many search matches, showing ${bestX} of ${Y}\n\n`;
                return header + bestLines.map(ld => ld.text).join('\n');
            }

            return lineData.map(ld => ld.text).join('\n');
        } catch (error) {
            return `Error searching files: ${error.message}`;
        }
    }

    /**
     * Searches for exact text within a specific file and returns matches with context.
     * @param {string} path 
     * @param {string} query 
     */
    async searchInFile(path, query) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            if (!query) return "Error: Query is empty.";

            let content = "";
            const openTab = this._findOpenTab(resolvedPath);

            if (openTab && openTab.config.session) {
                const edits = this.editBuffer[resolvedPath]?.edits || [];
                content = this._getCleanContentOfSession(openTab.config.session, edits);
            } else if (this.conduit.isConnected) {
                const result = await this.conduit.wsRead(resolvedPath);
                if (result.error) throw new Error(result.error);
                content = atob(result.data);
            } else {
                return "Error: Cannot read file, Conduit is not connected.";
            }

            let outlineSymbols = [];
            try {
                if (this.conduit.isConnected) {
                    const outlineResp = await this.conduit.wsGetOutline(resolvedPath);
                    if (!outlineResp.error && outlineResp.data) {
                        try {
                            const parsed = JSON.parse(outlineResp.data);
                            if (parsed && parsed.symbols) {
                                outlineSymbols = parsed.symbols;
                            }
                        } catch (e) {
                            // Ignored
                        }
                    }
                }
            } catch (e) {
                // Ignore outline errors
            }

            const lines = content.split('\n');
            const matches = [];
            const lowerQuery = query.toLowerCase();
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(lowerQuery)) {
                    matches.push(i);
                }
            }

            if (matches.length === 0) {
                return `[No matches found in ${path} for query: "${query}"]`;
            }

            let output = `Found ${matches.length} matches for "${query}" in ${path}:\n\n`;
            const limit = 10;
            const displayMatches = matches.slice(0, limit);

            for (let i = 0; i < displayMatches.length; i++) {
                const lineIndex = displayMatches[i];
                const lineNum = lineIndex + 1;
                
                let wrappingSymbol = null;
                for (const sym of outlineSymbols) {
                    if (lineNum >= sym.line && (!sym.length || lineNum < sym.line + sym.length)) {
                        wrappingSymbol = sym;
                    }
                }

                const wrapText = wrappingSymbol ? `Found inside ${wrappingSymbol.type} '${wrappingSymbol.name}' (Lines ${wrappingSymbol.line}-${wrappingSymbol.length ? wrappingSymbol.line + wrappingSymbol.length - 1 : '?'})` : 'Found at root level';
                
                output += `Match ${i + 1}: ${wrapText}\n`;
                
                const startContext = Math.max(0, lineIndex - 2);
                const endContext = Math.min(lines.length - 1, lineIndex + 2);
                
                for (let j = startContext; j <= endContext; j++) {
                    const prefix = j === lineIndex ? ">" : " ";
                    output += `Line ${j + 1}: ${prefix}  ${lines[j]}\n`;
                }
                output += `\n`;
            }

            if (matches.length > limit) {
                output += `[Warning: ${matches.length - limit} additional matches omitted. Your search is too broad. Please refine your query to be more specific.]`;
            }

            return output.trim();
        } catch (error) {
            return `Error searching in file: ${error.message}`;
        }
    }

    /**
     * Performs a surgical edit on a file.
     * @param {string} path 
     * @param {string} searchString 
     * @param {string} replacementString 
     * @param {string} sourceId - For backup tracking
     */
    async editFile(path, searchString, replacementString, sourceId) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const cleanSearch = (searchString || "").replace(/\s+/g, "");
            const cleanReplace = (replacementString || "").replace(/\s+/g, "");
            if (cleanSearch === cleanReplace) {
                return "Malformed edit, replace and search blocks are the same";
            }

            const resolvedPath = this._resolveAndValidatePath(path);
            
            // 1. Ensure the file is open in the editor
            let targetTab = this._findOpenTab(resolvedPath);

            if (!targetTab) {
                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(resolvedPath, resolvedPath);
                    targetTab = this._findOpenTab(resolvedPath);
                }
            }

            if (!targetTab) {
                throw new Error(`Failed to open file ${resolvedPath} in the editor.`);
            }

            const session = targetTab.config.session;
            const originalContent = session.getValue();
            const sourceLines = originalContent.split(/\r?\n/);

            // Helper to clean a line: strip leading spaces and comments
            const cleanLine = (line) => {
                let cleaned = line.replace(/^\s+/, "");
                cleaned = cleaned.replace(/("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)|(\/\/.*|#.*|\/\*.*?\*\/)/g, (match, g1, g2) => {
                    if (g2 !== undefined) return "";
                    return g1;
                });
                return cleaned.trim();
            };

            const mappedSource = [];
            for (let i = 0; i < sourceLines.length; i++) {
                const cleaned = cleanLine(sourceLines[i]);
                if (cleaned !== "") {
                    mappedSource.push({ cleaned, index: i });
                }
            }

            const searchLines = (searchString || "").split(/\r?\n/);
            const mappedSearch = [];
            for (let i = 0; i < searchLines.length; i++) {
                const cleaned = cleanLine(searchLines[i]);
                if (cleaned !== "") {
                    mappedSearch.push({ cleaned, index: i });
                }
            }

            let matchIndices = [];

            if (mappedSearch.length > 0) {
                for (let i = 0; i <= mappedSource.length - mappedSearch.length; i++) {
                    let isMatch = true;
                    for (let j = 0; j < mappedSearch.length; j++) {
                        if (mappedSource[i + j].cleaned !== mappedSearch[j].cleaned) {
                            isMatch = false;
                            break;
                        }
                    }
                    if (isMatch) {
                        matchIndices.push(i);
                    }
                }
            }

            if (matchIndices.length === 0) {
                throw new Error("Search text not found");
            }
            if (matchIndices.length > 1) {
                throw new Error("Search text match multiple places, provide more surrounding context");
            }

            const matchIndex = matchIndices[0];
            const startLineIndex = mappedSource[matchIndex].index;
            const endLineIndex = mappedSource[matchIndex + mappedSearch.length - 1].index;

            // Construct proposed new content buffer in memory without applying to editor or disk yet
            const replacementLines = (replacementString ?? "").split(/\r?\n/);
            const proposedLines = [
                ...sourceLines.slice(0, startLineIndex),
                ...replacementLines,
                ...sourceLines.slice(endLineIndex + 1)
            ];
            const proposedContent = proposedLines.join("\n");

            // Pre-Save Syntax Validation
            const syntaxCheck = await syntaxValidator.validate(resolvedPath, proposedContent);
            if (!syntaxCheck.valid) {
                return `Syntax validation failed! Changes were NOT applied to disk or editor.\n${syntaxCheck.error}\nPlease fix the syntax error and try again.`;
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            if (isForgivenessMode) {
                // 1. Create backup if not already present in the active session
                let backupId = "";
                const activeSession = window.ui?.aiManager?.activeSession;
                const hasExistingBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[resolvedPath] && activeSession.modifiedFiles[resolvedPath].length > 0;

                if (hasExistingBackup) {
                    backupId = activeSession.modifiedFiles[resolvedPath][0].backupId;
                } else {
                    try {
                        const actId = sourceId || activeSession?.id || "default";
                        backupId = await AgentBackup.create(resolvedPath, originalContent, actId);
                        
                        if (activeSession) {
                            activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                            if (!activeSession.modifiedFiles[resolvedPath]) {
                                activeSession.modifiedFiles[resolvedPath] = [];
                            }
                            activeSession.modifiedFiles[resolvedPath].push({
                                backupId: backupId,
                                timestamp: Date.now(),
                                sourceId: actId
                            });
                            await workspaceClient.setSession(activeSession.id, activeSession);
                        }
                    } catch (e) {
                        console.error("[AgentTools] Failed to create backup:", e);
                    }
                }

                // 2. Perform the edit on Ace session using the aligned lines range
                const Range = window.ace.require("ace/range").Range;
                const rangeToReplace = new Range(startLineIndex, 0, endLineIndex, sourceLines[endLineIndex].length);
                session.replace(rangeToReplace, replacementString ?? "");

                // 3. Save to disk immediately
                if (window.saveFileTab) {
                    await window.saveFileTab(targetTab);
                    session.baseValue = session.getValue();
                }

                // 4. Set tab to diff view mode automatically for implicit review
                targetTab.config.viewMode = "diff";
                targetTab.config.backupId = backupId;

                // 5. Focus & Redraw
                targetTab.click();
                if (window.ui?.renderPlanTasksView) {
                    const containers = document.querySelectorAll('.plan-tasks-view');
                    containers.forEach(c => window.ui.renderPlanTasksView(c));
                }

                const backupMsg = hasExistingBackup 
                    ? "the rollback backup has been retained" 
                    : "a rollback backup was created";
                return `Successfully edited ${path} in Forgiveness Mode. The change has been committed directly to the file and ${backupMsg}. The tab has switched to the side-by-side Diff view for your review.`;
            }

            // Permission Mode: clean replacement in memory using the aligned lines range
            const Range = window.ace.require("ace/range").Range;
            const rangeToReplace = new Range(startLineIndex, 0, endLineIndex, sourceLines[endLineIndex].length);
            session.replace(rangeToReplace, replacementString ?? "");
            // Set tab to diff view mode automatically for implicit review
            targetTab.config.viewMode = "diff";
            delete targetTab.config.backupId;

            // Track pending AI edits in active session
            const activeSession = window.ui?.aiManager?.activeSession;
            if (activeSession) {
                activeSession.pendingEdits = activeSession.pendingEdits || {};
                activeSession.pendingEdits[resolvedPath] = true;
                await workspaceClient.setSession(activeSession.id, activeSession);
            }

            // Focus & Redraw
            targetTab.click();
            return `Successfully edited ${path} in memory (Permission Mode). The tab has switched to the side-by-side Diff view for your review. Please click 'Apply Changes' at the top to save to disk or 'Discard' to revert.`;
        } catch (error) {
            return `Error editing file: ${error.message}`;
        }
    }

    /**
     * Helper to verify and align line ranges using startAnchor and endAnchor.
     * Searches within 5 lines of specified line numbers.
     * Throws an error if anchors are specified but not found.
     */
    /**
     * Helper to verify and align line ranges using startAnchor and endAnchor.
     * Searches within 8 lines of specified line numbers.
     * Throws an error if anchors are specified but not found.
     */
    _alignAnchors(lines, startLine, lineCount, startAnchor, endAnchor) {
        let adjustedStart = startLine;
        let adjustedCount = lineCount;

        const norm = (s) => s ? s.toLowerCase().replace(/\s+/g, ' ').trim() : "";

        if (startAnchor !== undefined && startAnchor !== null && startAnchor !== "") {
            let found = false;
            const normAnchor = norm(startAnchor);
            const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8];
            for (const offset of offsets) {
                const candidateLineNum = startLine + offset;
                const idx = candidateLineNum - 1;
                if (idx >= 0 && idx < lines.length) {
                    if (norm(lines[idx]) === normAnchor) {
                        adjustedStart = candidateLineNum;
                        found = true;
                        break;
                    }
                }
            }
            if (!found) {
                throw new Error(`startAnchor "${startAnchor}" not found within 8 lines of startLine ${startLine}`);
            }
        }

        if (endAnchor !== undefined && endAnchor !== null && endAnchor !== "") {
            let found = false;
            const normAnchor = norm(endAnchor);
            const expectedEndLine = adjustedStart + lineCount;
            const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8];
            for (const offset of offsets) {
                const candidateLineNum = expectedEndLine + offset;
                const idx = candidateLineNum - 1;
                if (idx >= 0 && idx < lines.length) {
                    if (norm(lines[idx]) === normAnchor) {
                        adjustedCount = candidateLineNum - adjustedStart;
                        found = true;
                        break;
                    }
                }
            }
            if (!found) {
                throw new Error(`endAnchor "${endAnchor}" not found within 8 lines of expected end line ${expectedEndLine}`);
            }
        }

        return { startLine: adjustedStart, lineCount: adjustedCount };
    }

    /**
     * Removes lines from a file.
     * @param {string} path 
     * @param {string} [searchString]
     * @param {number} [startLine]
     * @param {number} [lineCount]
     * @param {string} [startAnchor]
     * @param {string} [endAnchor]
     * @param {string} [sourceId]
     */
    async editRemoveLines(path, searchString, startLine, lineCount, startAnchor, endAnchor, sourceId) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            
            // 1. Ensure the file is open in the editor
            let targetTab = this._findOpenTab(resolvedPath);

            if (!targetTab) {
                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(resolvedPath, resolvedPath);
                    targetTab = this._findOpenTab(resolvedPath);
                }
            }

            if (!targetTab) {
                throw new Error(`Failed to open file ${resolvedPath} in the editor.`);
            }

            const session = targetTab.config.session;
            const originalContent = session.getValue();

            // Validate arguments and calculate range to remove
            const Range = window.ace.require("ace/range").Range;
            let rangeToReplace;

            if (searchString !== undefined && searchString !== null) {
                // Count occurrences
                let count = 0;
                let pos = originalContent.indexOf(searchString);
                while (pos !== -1) {
                    count++;
                    pos = originalContent.indexOf(searchString, pos + 1);
                }
                if (count > 1) {
                    return "multiple instances of search found in file, please use startLine and lineCount";
                }
                
                const cleanStartIndex = originalContent.indexOf(searchString);
                if (cleanStartIndex === -1) {
                    throw new Error(`Target string not found in ${path}. Ensure the search string matches exactly, including whitespace.`);
                }

                const doc = session.getDocument();
                const startPos = doc.indexToPosition(cleanStartIndex);
                const endPos = doc.indexToPosition(cleanStartIndex + searchString.length);
                rangeToReplace = new Range(startPos.row, startPos.column, endPos.row, endPos.column);
            } else if (startLine !== undefined && lineCount !== undefined) {
                const doc = session.getDocument();
                const totalLines = doc.getLength();
                const lines = originalContent.split(/\r?\n/);

                if (!startAnchor || !endAnchor) {
                    throw new Error("You must provide both 'startAnchor' and 'endAnchor' when using 'startLine' and 'lineCount'.");
                }
                const aligned = this._alignAnchors(lines, startLine, lineCount, startAnchor, endAnchor);

                const startRow = Math.max(0, parseInt(aligned.startLine, 10) - 1);
                const countVal = Math.max(1, parseInt(aligned.lineCount, 10));

                if (startRow >= totalLines) {
                    throw new Error(`startLine ${startLine} is out of bounds (1-${totalLines})`);
                }

                if (startRow + countVal < totalLines) {
                    rangeToReplace = new Range(startRow, 0, startRow + countVal, 0);
                } else {
                    if (startRow > 0) {
                        const prevLineLen = doc.getLine(startRow - 1).length;
                        rangeToReplace = new Range(startRow - 1, prevLineLen, totalLines - 1, doc.getLine(totalLines - 1).length);
                    } else {
                        rangeToReplace = new Range(0, 0, totalLines - 1, doc.getLine(totalLines - 1).length);
                    }
                }
            } else {
                throw new Error("You must provide either 'search' or both 'startLine' and 'lineCount'.");
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            if (isForgivenessMode) {
                // 1. Create backup if not already present in the active session
                let backupId = "";
                const activeSession = window.ui?.aiManager?.activeSession;
                const hasExistingBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[resolvedPath] && activeSession.modifiedFiles[resolvedPath].length > 0;

                if (hasExistingBackup) {
                    backupId = activeSession.modifiedFiles[resolvedPath][0].backupId;
                } else {
                    try {
                        const actId = sourceId || activeSession?.id || "default";
                        backupId = await AgentBackup.create(resolvedPath, originalContent, actId);
                        
                        if (activeSession) {
                            activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                            if (!activeSession.modifiedFiles[resolvedPath]) {
                                activeSession.modifiedFiles[resolvedPath] = [];
                            }
                            activeSession.modifiedFiles[resolvedPath].push({
                                backupId: backupId,
                                timestamp: Date.now(),
                                sourceId: actId
                            });
                            await workspaceClient.setSession(activeSession.id, activeSession);
                        }
                    } catch (e) {
                        console.error("[AgentTools] Failed to create backup:", e);
                    }
                }

                // 2. Perform the clean edit on Ace session
                session.replace(rangeToReplace, "");

                // 3. Save to disk immediately
                if (window.saveFileTab) {
                    await window.saveFileTab(targetTab);
                    session.baseValue = session.getValue();
                }

                // 4. Set tab to diff view mode automatically for implicit review
                targetTab.config.viewMode = "diff";
                targetTab.config.backupId = backupId;

                // 5. Focus & Redraw
                targetTab.click();
                if (window.ui?.renderPlanTasksView) {
                    const containers = document.querySelectorAll('.plan-tasks-view');
                    containers.forEach(c => window.ui.renderPlanTasksView(c));
                }

                const backupMsg = hasExistingBackup 
                    ? "the rollback backup has been retained" 
                    : "a rollback backup was created";
                return `Successfully removed lines from ${path} in Forgiveness Mode. The change has been committed directly to the file and ${backupMsg}. The tab has switched to the side-by-side Diff view for your review.`;
            }

            // Permission Mode: clean replacement in memory
            session.replace(rangeToReplace, "");
            // Set tab to diff view mode automatically for implicit review
            targetTab.config.viewMode = "diff";
            delete targetTab.config.backupId;

            // Track pending AI edits in active session
            const activeSession = window.ui?.aiManager?.activeSession;
            if (activeSession) {
                activeSession.pendingEdits = activeSession.pendingEdits || {};
                activeSession.pendingEdits[resolvedPath] = true;
                await workspaceClient.setSession(activeSession.id, activeSession);
            }

            // Focus & Redraw
            targetTab.click();
            return `Successfully removed lines from ${path} in memory (Permission Mode). The tab has switched to the side-by-side Diff view for your review. Please click 'Apply Changes' at the top to save to disk or 'Discard' to revert.`;
        } catch (error) {
            return `Error removing lines: ${error.message}`;
        }
    }

    /**
     * Copy a range of lines from a source file and insert them into a destination file.
     * @param {string} source 
     * @param {number} startLine 
     * @param {number} lineCount 
     * @param {string} destination 
     * @param {number} insertAt 
     * @param {boolean} [removeFromSource]
     * @param {string} [sourceId]
     */
    async refactorCopyLines(source, startLine, lineCount, destination, insertAt, removeFromSource, startAnchor, endAnchor, sourceId) {
        try {
            const sourcePermitted = this._checkFilePermitted(source);
            if (sourcePermitted !== true) return sourcePermitted;
            const destPermitted = this._checkFilePermitted(destination);
            if (destPermitted !== true) return destPermitted;

            const cleanSource = this._resolveAndValidatePath(source);
            const cleanDestination = this._resolveAndValidatePath(destination);

            const sourceContent = await this.readFile(cleanSource, undefined, undefined, true);
            if (sourceContent.startsWith("Error:")) {
                throw new Error(`Failed to read source file: ${sourceContent}`);
            }
            const sourceLines = sourceContent.split(/\r?\n/);

            const aligned = this._alignAnchors(sourceLines, startLine, lineCount, startAnchor, endAnchor);
            startLine = aligned.startLine;
            lineCount = aligned.lineCount;

            const startIdx = Math.max(0, startLine - 1);
            const countVal = Math.max(0, lineCount);
            const linesToCopy = sourceLines.slice(startIdx, startIdx + countVal).join('\n');

            // Check if destination file exists
            let destExists = false;
            let destTab = this._findOpenTab(cleanDestination);
            if (destTab) {
                destExists = true;
            } else {
                const files = window.ui?.fileList?.index?.files || [];
                const normalizedDest = cleanDestination.toLowerCase();
                const foundInIndex = files.some(f => f.path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase() === normalizedDest);
                if (foundInIndex) {
                    destExists = true;
                } else {
                    try {
                        const readRes = await this.conduit.wsRead(cleanDestination);
                        if (readRes && !readRes.error) {
                            destExists = true;
                        }
                    } catch (e) {
                        destExists = false;
                    }
                }
            }

            if (!destExists) {
                if (!this.conduit.isConnected) {
                    return "Error: Conduit not connected.";
                }

                if (removeFromSource) {
                    let sourceTab = this._findOpenTab(cleanSource);
                    if (!sourceTab) {
                        if (window.ui?.fileList?.open) {
                            await window.ui.fileList.open(cleanSource, cleanSource);
                            sourceTab = this._findOpenTab(cleanSource);
                        }
                    }
                    if (!sourceTab) {
                        throw new Error(`Failed to open source file ${cleanSource} in the editor for removal.`);
                    }

                    const srcSession = sourceTab.config.session;
                    const srcOriginalContent = srcSession.getValue();
                    const srcDoc = srcSession.getDocument();
                    const srcTotalLines = srcDoc.getLength();
                    const srcStartRow = Math.max(0, parseInt(startLine, 10) - 1);
                    const srcCountVal = Math.max(1, parseInt(lineCount, 10));

                    const Range = window.ace.require("ace/range").Range;
                    let rangeToRemove;
                    if (srcStartRow + srcCountVal < srcTotalLines) {
                        rangeToRemove = new Range(srcStartRow, 0, srcStartRow + srcCountVal, 0);
                    } else {
                        if (srcStartRow > 0) {
                            const prevLineLen = srcDoc.getLine(srcStartRow - 1).length;
                            rangeToRemove = new Range(srcStartRow - 1, prevLineLen, srcTotalLines - 1, srcDoc.getLine(srcTotalLines - 1).length);
                        } else {
                            rangeToRemove = new Range(0, 0, srcTotalLines - 1, srcDoc.getLine(srcTotalLines - 1).length);
                        }
                    }

                    const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
                    if (isForgivenessMode) {
                        let srcBackupId = "";
                        const activeSession = window.ui?.aiManager?.activeSession;
                        const hasSrcBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[cleanSource] && activeSession.modifiedFiles[cleanSource].length > 0;

                        if (hasSrcBackup) {
                            srcBackupId = activeSession.modifiedFiles[cleanSource][0].backupId;
                        } else {
                            try {
                                const actId = sourceId || activeSession?.id || "default";
                                srcBackupId = await AgentBackup.create(cleanSource, srcOriginalContent, actId);

                                if (activeSession) {
                                    activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                                    if (!activeSession.modifiedFiles[cleanSource]) {
                                        activeSession.modifiedFiles[cleanSource] = [];
                                    }
                                    activeSession.modifiedFiles[cleanSource].push({
                                        backupId: srcBackupId,
                                        timestamp: Date.now(),
                                        sourceId: actId
                                    });
                                    await workspaceClient.setSession(activeSession.id, activeSession);
                                }
                            } catch (e) {
                                console.error("[AgentTools] Failed to create source backup:", e);
                            }
                        }

                        srcSession.replace(rangeToRemove, "");
                        if (window.saveFileTab) {
                            await window.saveFileTab(sourceTab);
                            srcSession.baseValue = srcSession.getValue();
                        }
                        sourceTab.config.viewMode = "diff";
                        sourceTab.config.backupId = srcBackupId;
                    } else {
                        srcSession.replace(rangeToRemove, "");
                        sourceTab.config.viewMode = "diff";
                        delete sourceTab.config.backupId;

                        const activeSession = window.ui?.aiManager?.activeSession;
                        if (activeSession) {
                            activeSession.pendingEdits = activeSession.pendingEdits || {};
                            activeSession.pendingEdits[cleanSource] = true;
                            await workspaceClient.setSession(activeSession.id, activeSession);
                        }
                    }
                }

                const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
                const activeSession = window.ui?.aiManager?.activeSession;
                const actId = sourceId || activeSession?.id || "default";

                if (isForgivenessMode) {
                    const base64Content = btoa(unescape(encodeURIComponent(linesToCopy)));
                    const result = await this.conduit.wsWrite(cleanDestination, base64Content);
                    if (result.error) throw new Error(result.error);

                    if (activeSession) {
                        activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                        if (!activeSession.modifiedFiles[cleanDestination]) {
                            activeSession.modifiedFiles[cleanDestination] = [];
                        }
                        activeSession.modifiedFiles[cleanDestination].push({
                            backupId: "new_file",
                            isNewFile: true,
                            timestamp: Date.now(),
                            sourceId: actId
                        });
                        await workspaceClient.setSession(activeSession.id, activeSession);
                    }

                    if (window.ui?.fileList?.refreshFolders) {
                        window.ui.fileList.refreshFolders();
                    }

                    if (window.ui?.fileList?.open) {
                        await window.ui.fileList.open(cleanDestination);
                    }

                    const actionWord = removeFromSource ? "moved" : "copied";
                    return `Successfully created ${destination} and ${actionWord} the lines in Forgiveness Mode.`;
                }

                const result = await this.conduit.wsWrite(cleanDestination, "");
                if (result.error) throw new Error(result.error);

                if (window.ui?.fileList?.refreshFolders) {
                    window.ui.fileList.refreshFolders();
                }

                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(cleanDestination, cleanDestination);
                }

                let targetTab = this._findOpenTab(cleanDestination);
                if (!targetTab) {
                    throw new Error(`Failed to open new destination file ${cleanDestination} in the editor.`);
                }

                targetTab.config.session.setValue(linesToCopy);
                targetTab.config.viewMode = "diff";
                delete targetTab.config.backupId;

                if (activeSession) {
                    activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                    if (!activeSession.modifiedFiles[cleanDestination]) {
                        activeSession.modifiedFiles[cleanDestination] = [];
                    }
                    activeSession.modifiedFiles[cleanDestination].push({
                        backupId: "new_file",
                        isNewFile: true,
                        timestamp: Date.now(),
                        sourceId: actId
                    });

                    activeSession.pendingEdits = activeSession.pendingEdits || {};
                    activeSession.pendingEdits[cleanDestination] = true;
                    await workspaceClient.setSession(activeSession.id, activeSession);
                }

                targetTab.click();
                const actionWord = removeFromSource ? "moved" : "copied";
                return `Successfully created empty file ${destination} on disk and pending ${actionWord} lines in memory (Permission Mode). The tab has switched to the side-by-side Diff view to review the pending content. Please click 'Apply Changes' at the top to save to disk or 'Discard' to delete/revert.`;
            }

            // If removeFromSource is true and source is the same as destination, we handle it as a move within the same file.
            if (removeFromSource && cleanSource === cleanDestination) {
                // Ensure file is open in editor
                let targetTab = this._findOpenTab(cleanDestination);
                if (!targetTab) {
                    if (window.ui?.fileList?.open) {
                        await window.ui.fileList.open(cleanDestination, cleanDestination);
                        targetTab = this._findOpenTab(cleanDestination);
                    }
                }
                if (!targetTab) {
                    throw new Error(`Failed to open file ${cleanDestination} in the editor.`);
                }

                const session = targetTab.config.session;
                const originalContent = session.getValue();

                const doc = session.getDocument();
                const totalLines = doc.getLength();
                const startRow = Math.max(0, parseInt(startLine, 10) - 1);
                const countVal = Math.max(1, parseInt(lineCount, 10));
                const insertRow = Math.max(0, parseInt(insertAt, 10) - 1);

                if (insertRow >= startRow && insertRow < startRow + countVal) {
                    throw new Error("Cannot insert copied lines inside the range of lines being removed from the same file.");
                }

                const lines = originalContent.split(/\r?\n/);
                const copiedLinesArr = lines.slice(startRow, startRow + countVal);
                lines.splice(startRow, countVal);

                let targetInsertRow = insertRow;
                if (insertRow > startRow) {
                    targetInsertRow = insertRow - countVal;
                }
                lines.splice(targetInsertRow, 0, ...copiedLinesArr);
                const newContent = lines.join('\n');

                const Range = window.ace.require("ace/range").Range;
                const endPos = doc.indexToPosition(originalContent.length);
                const fullRange = new Range(0, 0, endPos.row, endPos.column);

                const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
                if (isForgivenessMode) {
                    let backupId = "";
                    const activeSession = window.ui?.aiManager?.activeSession;
                    const hasExistingBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[cleanDestination] && activeSession.modifiedFiles[cleanDestination].length > 0;

                    if (hasExistingBackup) {
                        backupId = activeSession.modifiedFiles[cleanDestination][0].backupId;
                    } else {
                        try {
                            const actId = sourceId || activeSession?.id || "default";
                            backupId = await AgentBackup.create(cleanDestination, originalContent, actId);

                            if (activeSession) {
                                activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                                if (!activeSession.modifiedFiles[cleanDestination]) {
                                    activeSession.modifiedFiles[cleanDestination] = [];
                                }
                                activeSession.modifiedFiles[cleanDestination].push({
                                    backupId: backupId,
                                    timestamp: Date.now(),
                                    sourceId: actId
                                });
                                await workspaceClient.setSession(activeSession.id, activeSession);
                            }
                        } catch (e) {
                            console.error("[AgentTools] Failed to create backup:", e);
                        }
                    }

                    session.replace(fullRange, newContent);

                    if (window.saveFileTab) {
                        await window.saveFileTab(targetTab);
                        session.baseValue = session.getValue();
                    }

                    targetTab.config.viewMode = "diff";
                    targetTab.config.backupId = backupId;
                    targetTab.click();
                    if (window.ui?.renderPlanTasksView) {
                        const containers = document.querySelectorAll('.plan-tasks-view');
                        containers.forEach(c => window.ui.renderPlanTasksView(c));
                    }

                    const backupMsg = hasExistingBackup ? "the rollback backup has been retained" : "a rollback backup was created";
                    return `Successfully moved lines within ${destination} in Forgiveness Mode. The change has been committed directly to the file and ${backupMsg}. The tab has switched to the side-by-side Diff view for your review.`;
                }

                session.replace(fullRange, newContent);
                targetTab.config.viewMode = "diff";
                delete targetTab.config.backupId;

                const activeSession = window.ui?.aiManager?.activeSession;
                if (activeSession) {
                    activeSession.pendingEdits = activeSession.pendingEdits || {};
                    activeSession.pendingEdits[cleanDestination] = true;
                    await workspaceClient.setSession(activeSession.id, activeSession);
                }

                targetTab.click();
                return `Successfully moved lines within ${destination} in memory (Permission Mode). The tab has switched to the side-by-side Diff view for your review. Please click 'Apply Changes' at the top to save to disk or 'Discard' to revert.`;
            }

            // Normal flow: Different destination file (and optional removal from source)
            // Ensure the destination file is open in the editor
            let targetTab = this._findOpenTab(cleanDestination);

            if (!targetTab) {
                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(cleanDestination, cleanDestination);
                    targetTab = this._findOpenTab(cleanDestination);
                }
            }

            if (!targetTab) {
                throw new Error(`Failed to open destination file ${cleanDestination} in the editor.`);
            }

            const session = targetTab.config.session;
            const originalContent = session.getValue();

            const doc = session.getDocument();
            const totalLines = doc.getLength();
            const insertRow = Math.max(0, parseInt(insertAt, 10) - 1);

            const Range = window.ace.require("ace/range").Range;
            let rangeToInsert;
            let textToInsert;

            if (insertRow >= totalLines) {
                const lastLineLen = doc.getLine(totalLines - 1).length;
                rangeToInsert = new Range(totalLines - 1, lastLineLen, totalLines - 1, lastLineLen);
                textToInsert = "\n" + linesToCopy;
            } else {
                rangeToInsert = new Range(insertRow, 0, insertRow, 0);
                textToInsert = linesToCopy + "\n";
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            
            // Perform removal from source first if requested
            if (removeFromSource) {
                let sourceTab = this._findOpenTab(cleanSource);
                if (!sourceTab) {
                    if (window.ui?.fileList?.open) {
                        await window.ui.fileList.open(cleanSource, cleanSource);
                        sourceTab = this._findOpenTab(cleanSource);
                    }
                }
                if (!sourceTab) {
                    throw new Error(`Failed to open source file ${cleanSource} in the editor for removal.`);
                }

                const srcSession = sourceTab.config.session;
                const srcOriginalContent = srcSession.getValue();
                const srcDoc = srcSession.getDocument();
                const srcTotalLines = srcDoc.getLength();
                const srcStartRow = Math.max(0, parseInt(startLine, 10) - 1);
                const srcCountVal = Math.max(1, parseInt(lineCount, 10));

                let rangeToRemove;
                if (srcStartRow + srcCountVal < srcTotalLines) {
                    rangeToRemove = new Range(srcStartRow, 0, srcStartRow + srcCountVal, 0);
                } else {
                    if (srcStartRow > 0) {
                        const prevLineLen = srcDoc.getLine(srcStartRow - 1).length;
                        rangeToRemove = new Range(srcStartRow - 1, prevLineLen, srcTotalLines - 1, srcDoc.getLine(srcTotalLines - 1).length);
                    } else {
                        rangeToRemove = new Range(0, 0, srcTotalLines - 1, srcDoc.getLine(srcTotalLines - 1).length);
                    }
                }

                if (isForgivenessMode) {
                    let srcBackupId = "";
                    const activeSession = window.ui?.aiManager?.activeSession;
                    const hasSrcBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[cleanSource] && activeSession.modifiedFiles[cleanSource].length > 0;

                    if (hasSrcBackup) {
                        srcBackupId = activeSession.modifiedFiles[cleanSource][0].backupId;
                    } else {
                        try {
                            const actId = sourceId || activeSession?.id || "default";
                            srcBackupId = await AgentBackup.create(cleanSource, srcOriginalContent, actId);

                            if (activeSession) {
                                activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                                if (!activeSession.modifiedFiles[cleanSource]) {
                                    activeSession.modifiedFiles[cleanSource] = [];
                                }
                                activeSession.modifiedFiles[cleanSource].push({
                                    backupId: srcBackupId,
                                    timestamp: Date.now(),
                                    sourceId: actId
                                });
                                await workspaceClient.setSession(activeSession.id, activeSession);
                            }
                        } catch (e) {
                            console.error("[AgentTools] Failed to create source backup:", e);
                        }
                    }

                    srcSession.replace(rangeToRemove, "");
                    if (window.saveFileTab) {
                        await window.saveFileTab(sourceTab);
                        srcSession.baseValue = srcSession.getValue();
                    }
                    sourceTab.config.viewMode = "diff";
                    sourceTab.config.backupId = srcBackupId;
                } else {
                    srcSession.replace(rangeToRemove, "");
                    sourceTab.config.viewMode = "diff";
                    delete sourceTab.config.backupId;

                    const activeSession = window.ui?.aiManager?.activeSession;
                    if (activeSession) {
                        activeSession.pendingEdits = activeSession.pendingEdits || {};
                        activeSession.pendingEdits[cleanSource] = true;
                        await workspaceClient.setSession(activeSession.id, activeSession);
                    }
                }
            }

            // Insert into destination
            if (isForgivenessMode) {
                let backupId = "";
                const activeSession = window.ui?.aiManager?.activeSession;
                const hasExistingBackup = activeSession && activeSession.modifiedFiles && activeSession.modifiedFiles[cleanDestination] && activeSession.modifiedFiles[cleanDestination].length > 0;

                if (hasExistingBackup) {
                    backupId = activeSession.modifiedFiles[cleanDestination][0].backupId;
                } else {
                    try {
                        const actId = sourceId || activeSession?.id || "default";
                        backupId = await AgentBackup.create(cleanDestination, originalContent, actId);

                        if (activeSession) {
                            activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                            if (!activeSession.modifiedFiles[cleanDestination]) {
                                activeSession.modifiedFiles[cleanDestination] = [];
                            }
                            activeSession.modifiedFiles[cleanDestination].push({
                                backupId: backupId,
                                timestamp: Date.now(),
                                sourceId: actId
                            });
                            await workspaceClient.setSession(activeSession.id, activeSession);
                        }
                    } catch (e) {
                        console.error("[AgentTools] Failed to create backup:", e);
                    }
                }

                session.replace(rangeToInsert, textToInsert);

                if (window.saveFileTab) {
                    await window.saveFileTab(targetTab);
                    session.baseValue = session.getValue();
                }

                targetTab.config.viewMode = "diff";
                targetTab.config.backupId = backupId;
                targetTab.click();
                if (window.ui?.renderPlanTasksView) {
                    const containers = document.querySelectorAll('.plan-tasks-view');
                    containers.forEach(c => window.ui.renderPlanTasksView(c));
                }

                const backupMsg = hasExistingBackup
                    ? "the rollback backup has been retained"
                    : "a rollback backup was created";
                const removeMsg = removeFromSource ? " moved" : " copied";
                return `Successfully${removeMsg} lines to ${destination} in Forgiveness Mode. The change has been committed directly to the file and ${backupMsg}. The tab has switched to the side-by-side Diff view for your review.`;
            }

            session.replace(rangeToInsert, textToInsert);
            targetTab.config.viewMode = "diff";
            delete targetTab.config.backupId;

            const activeSession = window.ui?.aiManager?.activeSession;
            if (activeSession) {
                activeSession.pendingEdits = activeSession.pendingEdits || {};
                activeSession.pendingEdits[cleanDestination] = true;
                await workspaceClient.setSession(activeSession.id, activeSession);
            }

            targetTab.click();
            const removeMsg = removeFromSource ? "moved" : "copied";
            return `Successfully ${removeMsg} lines to ${destination} in memory (Permission Mode). The tab has switched to the side-by-side Diff view for your review. Please click 'Apply Changes' at the top to save to disk or 'Discard' to revert.`;
        } catch (error) {
            return `Error copying lines: ${error.message}`;
        }
    }

    /**
     * Creates a new file.
     */
    async createFile(path, content, sourceId) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            if (!this.conduit.isConnected) {
                return "Error: Conduit not connected.";
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            const activeSession = window.ui?.aiManager?.activeSession;
            const actId = sourceId || activeSession?.id || "default";

            // Pre-Save Syntax Validation
            const syntaxCheck = await syntaxValidator.validate(resolvedPath, content);
            if (!syntaxCheck.valid) {
                return `Syntax validation failed! File was NOT created on disk or editor.\n${syntaxCheck.error}\nPlease fix the syntax error and try again.`;
            }

            if (isForgivenessMode) {
                const base64Content = btoa(unescape(encodeURIComponent(content))); // Safe base64 encoding
                const result = await this.conduit.wsWrite(resolvedPath, base64Content);
                if (result.error) throw new Error(result.error);

                if (activeSession) {
                    activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                    if (!activeSession.modifiedFiles[resolvedPath]) {
                        activeSession.modifiedFiles[resolvedPath] = [];
                    }
                    activeSession.modifiedFiles[resolvedPath].push({
                        backupId: "new_file",
                        isNewFile: true,
                        timestamp: Date.now(),
                        sourceId: actId
                    });
                    await workspaceClient.setSession(activeSession.id, activeSession);
                }

                // Refresh directory tree
                if (window.ui?.fileList?.refreshFolders) {
                    window.ui.fileList.refreshFolders();
                }

                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(resolvedPath);
                }
                
                return `Successfully created ${path}.`;
            }

            // Permission Mode: Create empty on disk, open, set content in memory, show diff
            const result = await this.conduit.wsWrite(resolvedPath, "");
            if (result.error) throw new Error(result.error);

            if (window.ui?.fileList?.refreshFolders) {
                window.ui.fileList.refreshFolders();
            }

            if (window.ui?.fileList?.open) {
                await window.ui.fileList.open(resolvedPath, resolvedPath);
            }

            const targetTab = this._findOpenTab(resolvedPath);
            if (!targetTab) {
                throw new Error(`Failed to open new file ${resolvedPath} in the editor.`);
            }
            // Populate modified content in memory
            targetTab.config.session.setValue(content);
            targetTab.config.viewMode = "diff";
            delete targetTab.config.backupId;

            // Track pending AI edits in active session
            if (activeSession) {
                activeSession.modifiedFiles = activeSession.modifiedFiles || {};
                if (!activeSession.modifiedFiles[resolvedPath]) {
                    activeSession.modifiedFiles[resolvedPath] = [];
                }
                activeSession.modifiedFiles[resolvedPath].push({
                    backupId: "new_file",
                    isNewFile: true,
                    timestamp: Date.now(),
                    sourceId: actId
                });

                activeSession.pendingEdits = activeSession.pendingEdits || {};
                activeSession.pendingEdits[resolvedPath] = true;
                await workspaceClient.setSession(activeSession.id, activeSession);
            }

            // Trigger click to render side-by-side diff review showing all lines added!
            targetTab.click();
            return `Successfully created empty file ${path} on disk. The tab has switched to the side-by-side Diff view to review the pending content in memory. Please click 'Apply Changes' at the top to save to disk or 'Discard' to delete/revert.`;
        } catch (error) {
            return `Error creating file: ${error.message}`;
        }
    }

    /**
     * Opens a file in the workspace editor for the user to review.
     * @param {string} path 
     */
    async openFile(path) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            if (window.ui?.fileList?.open) {
                await window.ui.fileList.open(resolvedPath);
                return `Successfully opened ${path} in the editor.`;
            } else {
                return `Error: Editor is not ready or not available.`;
            }
        } catch (error) {
            return `Error opening file: ${error.message}`;
        }
    }

    /**
     * Executes a terminal command.
     */
    async execCommand(command) {
        if (typeof command !== 'string') {
            return "Error: Command must be a string.";
        }
        return `Executing: ${command}\nOutput: (Terminal execution via agent is not supported directly for security reasons. Please use the terminal tab instead.)`;
    }

    /**
     * Centralized tool execution dispatcher.
     * @param {string} name - The tool name.
     * @param {object} args - The arguments.
     * @param {string} [sourceId] - Optional session ID for tracking
     */
     async execute(name, args = {}, sourceId = null) {
        // Prevent file editing/creation tools in planning mode
        if (window.ui?.aiManager?.planningMode && (name === 'create_file' || name === 'edit_file' || name === 'edit_remove_lines' || name === 'refactor_copy_lines')) {
            return `Tool Error: Tool '${name}' is not allowed while in planning mode.`;
        }

        // Fallback required parameter check
        const toolDef = tools.find(t => t.name === name);
        if (toolDef && toolDef.parameters && Array.isArray(toolDef.parameters.required)) {
            for (const reqParam of toolDef.parameters.required) {
                if (args[reqParam] === undefined || args[reqParam] === null || (args[reqParam] === "" && reqParam !== "replace" && reqParam !== "content")) {
                    return `Tool Error: ${name} requires "${reqParam}" parameter`;
                }
            }
        }

        switch (name) {
            case 'list_files':
                return await this.listFiles(args.path);
            case 'file_info':
                return await this.fileInfo(args.path);
            case 'web_search':
                return await this.webSearch(args.query);
            case 'research':
                return await this.research(args.query);
            case 'web_fetch':
                return await this.webFetch(args.url);
            case 'read_file':
                return await this.readFile(args.path, args.startLine, args.lineCount);
            case 'read_file_outline':
                return await this.readFileOutline(args.path);
            case 'read_symbol':
                return await this.readSymbol(args.query || args.symbol);
            case 'search_files':
                return await this.searchFiles(args.query);
            case 'search_in_file':
                return await this.searchInFile(args.path, args.query);
            case 'edit_file':
                return await this.editFile(
                    args.path,
                    args.search !== undefined && args.search !== null ? args.search : args.searchString,
                    args.replace !== undefined && args.replace !== null ? args.replace : args.replacementString,
                    sourceId
                );
            case 'edit_remove_lines':
                return await this.editRemoveLines(
                    args.path,
                    args.search,
                    args.startLine,
                    args.lineCount,
                    args.startAnchor,
                    args.endAnchor,
                    sourceId
                );
            case 'refactor_copy_lines':
                return await this.refactorCopyLines(
                    args.source,
                    args.startLine,
                    args.lineCount,
                    args.destination,
                    args.insertAt,
                    args.removeFromSource,
                    args.startAnchor,
                    args.endAnchor,
                    sourceId
                );
            case 'create_file':
                return await this.createFile(args.path, args.content, sourceId);
            case 'validate_syntax':
                const syntaxCheck = await syntaxValidator.validate(args.path, args.content);
                if (syntaxCheck.valid) {
                    return `Valid syntax for ${args.path}.`;
                }
                return `Syntax validation failed for ${args.path}:\n${syntaxCheck.error}`;
            case 'open_file':
                return await this.openFile(args.path);
            case 'find_file':
                return await this.findFile(args.path);
            case 'exec_command':
                return await this.execCommand(args.command);
            case 'create_implementation_plan':
                return "Implementation plan created. The user is reviewing it.";
            case 'create_task_list':
            	return "Task list created.";
            case 'update_task_list':
                return "Task list updated.";
            case 'complete_task':
                return `Task marked complete: ${args.taskName}`;
            case 'query':
                return await this.queryUser(args, sourceId);
            case 'create_sub_agent':
                return await this.createSubAgent(args, sourceId);
            case 'sub_agent_complete':
                return await this.subAgentComplete(args, sourceId);
            case 'query_sub_agent':
                return await this.querySubAgent(args, sourceId);
            case 'query_parent':
                return await this.queryParent(args, sourceId);
            case 'done':
                return "Agent successfully completed the execution loop.";
            default:
                throw new Error(`Tool '${name}' is not recognized.`);
        }
    }

    getEditBuffer() {
        return this.editBuffer;
    }

    async resolveEdit(path, editIndex, accept) {
        const resolvedPath = this._resolveAndValidatePath(path);
        const info = this.editBuffer[resolvedPath];
        if (!info || !info.edits || !info.edits[editIndex]) {
            return; // Already resolved or invalid
        }
        
        const edit = info.edits[editIndex];
        
        // Find open tab
        const tab = this._findOpenTab(resolvedPath);
        if (!tab) {
            throw new Error(`Tab for ${resolvedPath} is not open.`);
        }
        const session = tab.config.session;
        
        // Remove marker
        try {
            session.removeMarker(edit.id);
        } catch (e) {
            console.warn("[AgentTools] Failed to remove marker:", e);
        }
        
        const Range = window.ace.require("ace/range").Range;
        if (accept) {
            // Keep the replacement block: delete the original search block + separating newline
            const start = edit.startDeletedAnchor.getPosition();
            const end = edit.startAddedAnchor.getPosition();
            const deleteRange = new Range(start.row, start.column, end.row, end.column);
            session.replace(deleteRange, "");
        } else {
            // Reject: keep the original search block: delete the separating newline + replacement block
            const start = edit.endDeletedAnchor.getPosition();
            const end = edit.endAddedAnchor.getPosition();
            const deleteRange = new Range(start.row, start.column, end.row, end.column);
            session.replace(deleteRange, "");
        }
        
        // Detach anchors to prevent leaks
        try {
            if (edit.startDeletedAnchor) edit.startDeletedAnchor.detach();
            if (edit.endDeletedAnchor) edit.endDeletedAnchor.detach();
            if (edit.startAddedAnchor) edit.startAddedAnchor.detach();
            if (edit.endAddedAnchor) edit.endAddedAnchor.detach();
            if (edit.startAnchor) edit.startAnchor.detach();
            if (edit.endAnchor) edit.endAnchor.detach();
        } catch (e) {
            console.warn("[AgentTools] Failed to detach anchors:", e);
        }
        
        // Remove from the edits list
        info.edits.splice(editIndex, 1);
        
        // Adjust currentIndex if necessary
        if (info.currentIndex >= info.edits.length) {
            info.currentIndex = Math.max(0, info.edits.length - 1);
        }
        
        // If there are no more pending edits for this file, save it!
        if (info.edits.length === 0) {
            delete this.editBuffer[resolvedPath];
            if (window.saveFileTab) {
                await window.saveFileTab(tab);
                tab.config.session.baseValue = tab.config.session.getValue();
            }
            
            // Check if there are other files with edits
            const remainingPaths = Object.keys(this.editBuffer);
            if (remainingPaths.length > 0) {
                const nextPath = remainingPaths[0];
                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(nextPath);
                }
            } else {
                // Hide notice bar completely
                if (window.ui?.hideAgentEditsNotice) {
                    window.ui.hideAgentEditsNotice(tab.config.side);
                }
            }
        }
        
        if (window.ui?.aiManager?._renderEditBuffer) {
            window.ui.aiManager._renderEditBuffer();
        }
        
        // Trigger UI refresh
        if (window.ui?.updateAgentEditsNotice) {
            window.ui.updateAgentEditsNotice(tab);
        }
    }

    async resolveAllEdits(path, accept) {
        const resolvedPath = this._resolveAndValidatePath(path);
        const info = this.editBuffer[resolvedPath];
        if (!info || !info.edits) return;
        
        // Resolve from end to start to avoid shifting earlier positions
        for (let i = info.edits.length - 1; i >= 0; i--) {
            await this.resolveEdit(resolvedPath, i, accept);
        }
    }

    async commitEdits() {
        const paths = Object.keys(this.editBuffer);
        for (const resolvedPath of paths) {
            await this.resolveAllEdits(resolvedPath, true);
        }
        return `Successfully committed all pending edits.`;
    }

    async discardEdits() {
        const paths = Object.keys(this.editBuffer);
        for (const resolvedPath of paths) {
            await this.resolveAllEdits(resolvedPath, false);
        }
        return `Successfully discarded all pending edits.`;
    }

    /**
     * Finds files in the workspace matching a path using progressive atoms.
     * @param {string} searchPath 
     * @returns {Promise<string>}
     */
    async findFile(searchPath) {
        try {
            if (typeof searchPath !== 'string') {
                return "Error: Path must be a string.";
            }
            if (!window.ui?.fileList?.index?.files) {
                return "Error: File list index is not loaded.";
            }
            const files = window.ui.fileList.index.files;
            
            // Normalize slashes
            const cleanSearch = searchPath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
            
            // Split path into segments
            const segments = cleanSearch.split('/').filter(s => s && s !== '.');
            if (segments.length === 0) {
                return "Error: Empty search path.";
            }

            let matches = [];
            
            // Try matching with progressively fewer leading atoms
            for (let i = 0; i < segments.length; i++) {
                const subPath = segments.slice(i).join('/');
                matches = files.filter(f => {
                    if (f.isDir) return false;
                    const filePath = f.path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
                    return filePath.endsWith('/' + subPath) || filePath === subPath;
                });
                
                if (matches.length > 0) {
                    break;
                }
            }

            // Fallback: If no match, try checking if the last segment is a substring anywhere in the path
            if (matches.length === 0) {
                const lastSegment = segments[segments.length - 1];
                matches = files.filter(f => {
                    if (f.isDir) return false;
                    const filePath = f.path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
                    return filePath.includes(lastSegment);
                });
            }

            if (matches.length === 0) {
                return `No files found matching '${searchPath}'.`;
            }

            return matches.map(f => f.path).join('\n');
        } catch (error) {
            return `Error finding file: ${error.message}`;
        }
    }

    async queryUser(args, subSessionId) {
        if (!args.question) {
            throw new Error("query: 'question' parameter is required");
        }

        const aiManager = window.ui?.aiManager;

        // Use the running sub-agent's in-memory session (same object render() reads from)
        const runningSub = aiManager?.runningSessions.get(subSessionId);
        const subSession = (runningSub && runningSub.instance?.session)
            ? runningSub.instance.session
            : await workspaceClient.getSession(subSessionId);
        if (!subSession) {
            throw new Error(`query: sub-agent session not found: ${subSessionId}`);
        }

        // Add a pending-query marker to the sub-session (in-memory + IndexedDB)
        const queryId = crypto.randomUUID();
        const queryMsg = {
            id: queryId,
            role: "system",
            type: "agent_query",
            content: args.question,
            answered: false,
            subSessionId: subSessionId,
            timestamp: Date.now()
        };
        subSession.messages.push(queryMsg);
        subSession.pendingQueryId = queryId;
        subSession.lastModified = Date.now();
        await workspaceClient.setSession(subSessionId, subSession);

        // Re-render the sub-agent thread if it's currently viewed
        if (aiManager?.isSessionViewed(subSessionId)) {
            aiManager.historyManager.render();
        }

        // Highlight the parent session's tab and re-render parent thread for card badge
        const parentId = subSession.parentId;
        if (parentId && aiManager) {
            aiManager._updateTabStatus(parentId, "pending-query");
            // Re-render parent thread so the sub-agent card updates its badge
            if (aiManager.isSessionViewed(parentId)) {
                aiManager.historyManager.render();
            }
        }

        // Block the sub-agent loop until the user answers
        const answer = await new Promise((resolve) => {
            if (!window._agentQueryResolvers) {
                window._agentQueryResolvers = {};
            }
            window._agentQueryResolvers[queryId] = resolve;
        });

        // Mark the query as answered in-memory
        queryMsg.answered = true;
        queryMsg.answer = answer;
        delete subSession.pendingQueryId;
        subSession.lastModified = Date.now();
        await workspaceClient.setSession(subSessionId, subSession);

        // Restore parent tab to running status
        if (parentId && aiManager) {
            aiManager._updateTabStatus(parentId, "running");
            if (aiManager.isSessionViewed(parentId)) {
                aiManager.historyManager.render();
            }
        }

        // Re-render sub-agent thread to show answered state
        if (aiManager?.isSessionViewed(subSessionId)) {
            aiManager.historyManager.render();
        }

        return `User answered: ${answer}`;
    }

    async createSubAgent(args, parentSessionId) {
        if (!parentSessionId) {
            throw new Error("create_sub_agent: parentSessionId is required");
        }

        const runningParent = window.ui?.aiManager?.runningSessions.get(parentSessionId);
        const managerActiveSession = window.ui?.aiManager?.activeSession;
        const parentSession = (managerActiveSession && managerActiveSession.id === parentSessionId)
            ? managerActiveSession
            : (runningParent && runningParent.instance?.session ? runningParent.instance.session : await workspaceClient.getSession(parentSessionId));
        if (!parentSession) {
            throw new Error(`Parent session not found: ${parentSessionId}`);
        }

        // Check if sub-agents are allowed for the parent session
        if (parentSession.allowSubAgents === false) {
            return "Tool Error: Sub-agents are disabled for this session.";
        }

        // 1. Determine connection via pool selector
        const parentConnectionId = parentSession.connectionId || window.ui?.aiManager?.activeSession?.connectionId || "default-gemini";
        const selectedConnectionId = await window.ui.aiManager.selectConnectionForSubAgent(args.size || "medium", parentConnectionId);
        
        // 2. Check the maximum sub-agents limit
        const max = window.ui.aiManager.config.maxSubAgents || 3;
        let activeCount = 0;
        for (const [id, run] of window.ui.aiManager.runningSessions) {
            if (run.type === 'agent' && run.instance?.session?.parentId === parentSessionId) {
                activeCount++;
            }
        }
        if (activeCount >= max) {
            return `Tool Error: Cannot spawn sub-agent. Reached maximum parallel sub-agents limit of ${max}.`;
        }

        const connection = AIConnections.getInstance(selectedConnectionId);
        if (!connection || !connection.isConfigured()) {
            return `Tool Error: Connection '${selectedConnectionId}' is not configured.`;
        }

        // 3. Create a clean session structure
        const subId = `ai-session-${crypto.randomUUID()}`;
        const subName = `Sub-Agent: ${args.objective.slice(0, 30)}${args.objective.length > 30 ? '...' : ''}`;
        
        const subSystemPrompt = `You are a specialized child sub-agent spawned to perform the following objective:
"${args.objective}"

You operate with a limited toolset. Do not try to perform tasks outside this scope.

# STRICT RULES
- You MUST end EVERY turn with a tool call. No exceptions.
- If you have completed your objective, call \`sub_agent_complete\` with your results.
- If you are blocked or need clarification from the user, call \`query\` to ask your question.
- If you encounter an unrecoverable error, call \`sub_agent_complete\` with the error details.
- NEVER end a turn with only conversational text and no tool call. If you are unsure what to do next, call \`query\`.`;

        const subSessionData = {
            id: subId,
            name: subName,
            parentId: parentSessionId,
            createdAt: Date.now(),
            lastModified: Date.now(),
            messages: [],
            promptInput: "",
            promptHistory: [],
            scrollTop: 0,
            evergreenFiles: [],
            modifiedFiles: {},
            pendingEdits: {},
            agentMode: true,
            planningMode: false,
            forgivenessMode: parentSession.forgivenessMode ?? false,
            connectionId: selectedConnectionId,
            systemPromptOverride: subSystemPrompt
        };

        // Save session files to IndexedDB
        await workspaceClient.setSession(subId, subSessionData);

        // 4. Generate the user message [sub-agent:session_id] in the parent thread
        const triggerMessage = {
            role: "user",
            type: "user",
            content: `[sub-agent:${subId}]`,
            timestamp: Date.now(),
            id: crypto.randomUUID()
        };
        parentSession.messages.push(triggerMessage);
        parentSession.lastModified = Date.now();
        await workspaceClient.setSession(parentSessionId, parentSession);

        // Crucial: Synchronize with the parent agent's in-memory session messages if running in the background
        if (runningParent && runningParent.instance && runningParent.instance.session) {
            const parentAgentSession = runningParent.instance.session;
            if (!parentAgentSession.messages.some(m => m.id === triggerMessage.id)) {
                parentAgentSession.messages.push(triggerMessage);
            }
        }

        // Notify parent session history to render the new trigger card
        if (window.ui?.aiManager?.activeSessionId === parentSessionId) {
            window.ui.aiManager.historyManager.render();
        }

        // 5. Trigger background execution of the sub-agent
        const agent = new Agent(window.ui.aiManager, subSessionData, connection);
        window.ui.aiManager.runningSessions.set(subId, { type: 'agent', instance: agent });
        
        // Start asynchronously
        (async () => {
            try {
                const initUserMessage = {
                    role: "user",
                    type: "user",
                    content: `${args.objective}`,
                    timestamp: Date.now(),
                    id: crypto.randomUUID()
                };
                subSessionData.messages.push(initUserMessage);
                await workspaceClient.setSession(subId, subSessionData);

                // Run the agent loop
                await agent.run(initUserMessage, null);
            } catch (e) {
                console.error(`Sub-Agent ${subId} background run failed:`, e);
                try {
                    const subSession = await workspaceClient.getSession(subId);
                    if (subSession) {
                        subSession.messages.push({
                            role: "system",
                            type: "system_message",
                            content: `Error: Sub-agent execution crashed. Details: ${e.message}`,
                            timestamp: Date.now()
                        });
                        await workspaceClient.setSession(subId, subSession);
                    }
                } catch (err) {
                    console.error("Failed to append crash message to sub-agent:", err);
                }
            } finally {
                window.ui.aiManager.runningSessions.delete(subId);
                // Trigger parent history update to reflect completion status badge
                if (window.ui?.aiManager?.activeSessionId === parentSessionId) {
                    window.ui.aiManager.historyManager.render();
                }
            }
        })();

        return `[Sub-Agent ${subId} spawned to perform: "${args.objective}"]`;
    }

    async subAgentComplete(args, subSessionId) {
        if (!subSessionId) {
            throw new Error("sub_agent_complete: session ID is required");
        }
        
        const running = window.ui?.aiManager?.runningSessions.get(subSessionId);
        if (running && running.type === 'agent' && running.instance) {
            running.instance.session.completedResult = args.result;
            running.instance.session.lastModified = Date.now();
            await workspaceClient.setSession(subSessionId, running.instance.session);
            running.instance.stop("Sub-agent completed task");
        } else {
            const subSession = await workspaceClient.getSession(subSessionId);
            if (!subSession) {
                throw new Error(`Sub-agent session not found: ${subSessionId}`);
            }
            subSession.completedResult = args.result;
            subSession.lastModified = Date.now();
            await workspaceClient.setSession(subSessionId, subSession);
        }

        return "Sub-agent task successfully completed and reported back.";
    }

    async querySubAgent(args, parentSessionId) {
        const { subSessionId, prompt } = args;
        if (!subSessionId || !prompt) {
            throw new Error("query_sub_agent: subSessionId and prompt are required");
        }

        const aiManager = window.ui?.aiManager;
        const subSessionData = await workspaceClient.getSession(subSessionId);
        if (!subSessionData) {
            return `Tool Error: Sub-agent session not found: ${subSessionId}`;
        }

        // 1. Append prompt as a user message to the sub-agent thread
        const subMsg = {
            role: "user",
            type: "user",
            content: prompt,
            timestamp: Date.now(),
            id: crypto.randomUUID()
        };
        subSessionData.messages.push(subMsg);
        subSessionData.isWaitingForParent = false;
        delete subSessionData.pendingParentQuery;
        await workspaceClient.setSession(subSessionId, subSessionData);

        // 2. Clear any parent pending query state since parent answered
        if (subSessionData.pendingQueryId) {
            delete subSessionData.pendingQueryId;
            await workspaceClient.setSession(subSessionId, subSessionData);
        }

        // 3. Resolve user query resolvers if any parent-user resolver exists (just in case)
        const resolver = window._agentQueryResolvers?.[subSessionId];
        if (resolver) {
            delete window._agentQueryResolvers[subSessionId];
            resolver(prompt);
        }

        // 4. Trigger subagent execution (create new agent instance if not active in background)
        const parentConnectionId = subSessionData.connectionId || "default-gemini";
        const connection = AIConnections.getInstance(parentConnectionId);
        
        let runningSub = aiManager?.runningSessions.get(subSessionId);
        if (!runningSub) {
            const agent = new Agent(aiManager, subSessionData, connection);
            aiManager.runningSessions.set(subSessionId, { type: 'agent', instance: agent });
            (async () => {
                try {
                    await agent.run(subMsg, null);
                } catch (e) {
                    console.error(`Sub-Agent ${subSessionId} resume run failed:`, e);
                } finally {
                    aiManager.runningSessions.delete(subSessionId);
                    if (aiManager.activeSessionId === parentSessionId) {
                        aiManager.historyManager.render();
                    }
                }
            })();
        } else {
            // If subagent runner is already active, resume it or feed the message
            runningSub.instance.session.isWaitingForParent = false;
            delete runningSub.instance.session.pendingParentQuery;
            runningSub.instance.session.messages.push(subMsg);
            await workspaceClient.setSession(subSessionId, runningSub.instance.session);
            // Re-run loop step
            runningSub.instance.run(subMsg, null).catch(err => {
                console.error(`Failed to resume running subagent:`, err);
            });
        }

        // 5. Update UI
        if (aiManager?.activeSessionId === parentSessionId) {
            aiManager.historyManager.render();
        }

        return `Prompt sent to Sub-Agent ${subSessionId}. The sub-agent has resumed execution in the background.`;
    }

    async queryParent(args, subSessionId) {
        const { prompt } = args;
        if (!prompt) {
            throw new Error("query_parent: prompt is required");
        }

        const aiManager = window.ui?.aiManager;
        const subSession = await workspaceClient.getSession(subSessionId);
        if (!subSession) {
            throw new Error(`query_parent: sub-agent session not found: ${subSessionId}`);
        }

        const parentSessionId = subSession.parentId;
        if (!parentSessionId) {
            return "Tool Error: No parent session associated with this sub-agent.";
        }

        const runningParent = aiManager?.runningSessions.get(parentSessionId);
        const parentSession = (aiManager?.activeSession && aiManager.activeSession.id === parentSessionId)
            ? aiManager.activeSession
            : (runningParent && runningParent.instance?.session ? runningParent.instance.session : await workspaceClient.getSession(parentSessionId));

        if (!parentSession) {
            return `Tool Error: Parent session not found: ${parentSessionId}`;
        }

        // 1. Alert/Notify Tab status for parent session
        if (aiManager) {
            aiManager._updateTabStatus(parentSessionId, "pending-query");
            if (aiManager.activeSessionId === parentSessionId) {
                aiManager.historyManager.render();
            }
        }

        // 2. Mark the sub-session as waiting for parent and store the query string
        const running = aiManager?.runningSessions.get(subSessionId);
        if (running && running.instance && running.instance.session) {
            running.instance.session.isWaitingForParent = true;
            running.instance.session.pendingParentQuery = prompt;
            running.instance.session.lastModified = Date.now();
        }
        subSession.isWaitingForParent = true;
        subSession.pendingParentQuery = prompt;
        subSession.lastModified = Date.now();
        await workspaceClient.setSession(subSessionId, subSession);

        // 3. Block subagent loop until parent agent calls query_sub_agent
        const answer = await new Promise((resolve) => {
            if (!window._agentQueryResolvers) {
                window._agentQueryResolvers = {};
            }
            window._agentQueryResolvers[subSessionId] = resolve;
        });

        return `Parent agent answered: ${answer}`;
    }
}

const agentTools = new AgentTools();
window.agentTools = agentTools
export default agentTools;
