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
        this.syntaxErrors = {}; // Tracks pending syntax errors: { [resolvedPath]: errorString }
    }

    _getEffectiveWorkspaceFolders(sourceId = null) {
        const allFolders = window.workspace?.folders || [];
        if (allFolders.length === 0) return [];

        try {
            const aiManager = window.ui?.aiManager;
            const targetSessionId = sourceId || aiManager?.activeSessionId;
            const session = (targetSessionId && aiManager?.runningSessions?.get(targetSessionId)?.instance?.session)
                || (targetSessionId === aiManager?.activeSessionId ? aiManager?.activeSession : null);

            const pinnedRoots = session?.pinnedRoots || [];
            if (pinnedRoots.length > 0) {
                const filtered = allFolders.filter(f => pinnedRoots.some(p => f === p || f.endsWith('/' + p) || f.split(/[\\/]/).filter(Boolean).pop() === p));
                if (filtered.length > 0) return filtered;
            }
        } catch (e) {
            console.warn("[AgentTools] Error resolving pinned roots:", e);
        }

        return allFolders;
    }

    _resolveAndValidatePath(targetPath, sourceId = null) {
        if (typeof targetPath !== 'string') {
            throw new Error("Path must be a string");
        }
        const folders = this._getEffectiveWorkspaceFolders(sourceId);
        if (folders.length === 0) {
            throw new Error("No workspace folders are open. Cannot validate paths.");
        }

        // Clean and normalize targetPath
        targetPath = targetPath.replace(/\\/g, '/').trim();

        // 1. If targetPath is already absolute and starts with one of the open workspace folders
        for (const folder of folders) {
            const normFolder = folder.replace(/\\/g, '/').replace(/\/+$/, '');
            if (targetPath === normFolder || targetPath.startsWith(normFolder + '/')) {
                return this._cleanNormalizedPath(targetPath, sourceId);
            }
        }

        // 2. Check if targetPath starts with the folder basename of ANY open workspace folder
        // e.g. targetPath = "dev.jakbox.docs/src/index.js" or "dev.jakbox.docs"
        for (const folder of folders) {
            const normFolder = folder.replace(/\\/g, '/').replace(/\/+$/, '');
            const folderName = normFolder.split('/').filter(Boolean).pop();
            if (folderName) {
                if (targetPath === folderName) {
                    return this._cleanNormalizedPath(normFolder, sourceId);
                }
                if (targetPath.startsWith(folderName + '/')) {
                    const subPath = targetPath.substring(folderName.length + 1);
                    return this._cleanNormalizedPath(`${normFolder}/${subPath}`, sourceId);
                }
            }
        }

        // 3. Check for segment overlap against ALL open workspace folders
        // Pick the folder with the maximum segment overlap >= 1
        let bestOverlapCount = 0;
        let bestOverlapFolder = null;
        let bestTargetSegments = null;

        const targetSegments = targetPath.split('/').filter(p => p && p !== '.');

        for (const folder of folders) {
            const normFolder = folder.replace(/\\/g, '/').replace(/\/+$/, '');
            const folderSegments = normFolder.split('/').filter(Boolean);

            let maxOverlap = 0;
            for (let k = 1; k <= Math.min(folderSegments.length, targetSegments.length); k++) {
                const folderSlice = folderSegments.slice(-k);
                const targetSlice = targetSegments.slice(0, k);
                if (folderSlice.join('/').toLowerCase() === targetSlice.join('/').toLowerCase()) {
                    maxOverlap = k;
                }
            }

            if (maxOverlap > bestOverlapCount) {
                bestOverlapCount = maxOverlap;
                bestOverlapFolder = normFolder;
                bestTargetSegments = targetSegments.slice(maxOverlap);
            }
        }

        if (bestOverlapFolder && bestOverlapCount > 0) {
            const cleanRelative = bestTargetSegments.join('/');
            const resolved = cleanRelative ? `${bestOverlapFolder}/${cleanRelative}` : bestOverlapFolder;
            return this._cleanNormalizedPath(resolved, sourceId);
        }

        // 4. Check if targetPath matches a known file path in the workspace file index
        if (window.ui?.fileList?.index?.files) {
            const cleanTarget = targetPath.replace(/^\/+/, '').toLowerCase();
            const indexedFile = window.ui.fileList.index.files.find(f => {
                const fPath = f.path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
                if (fPath !== cleanTarget && !fPath.endsWith('/' + cleanTarget)) return false;
                const normIndexMatch = f.path.replace(/\\/g, '/');
                const fullIndexMatch = normIndexMatch.startsWith('/') ? normIndexMatch : `/${normIndexMatch}`;
                return folders.some(folder => {
                    const normFolder = folder.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
                    return fullIndexMatch === normFolder || fullIndexMatch.startsWith(normFolder + '/');
                });
            });
            if (indexedFile) {
                const normIndexMatch = indexedFile.path.replace(/\\/g, '/');
                return this._cleanNormalizedPath(normIndexMatch.startsWith('/') ? normIndexMatch : `/${normIndexMatch}`, sourceId);
            }
        }

        // 5. If targetPath is '.' or empty and there's 1 root folder
        if ((targetPath === '.' || targetPath === '' || targetPath === '/') && folders.length === 1) {
            return this._cleanNormalizedPath(folders[0], sourceId);
        }

        // 6. Default to first workspace folder for relative paths
        const baseFolder = folders[0].replace(/\\/g, '/').replace(/\/+$/, '');
        const cleanRelative = targetSegments.join('/');
        const resolvedPath = cleanRelative ? `${baseFolder}/${cleanRelative}` : baseFolder;
        return this._cleanNormalizedPath(resolvedPath, sourceId);
    }

    _cleanNormalizedPath(rawPath, sourceId = null) {
        const folders = this._getEffectiveWorkspaceFolders(sourceId);
        rawPath = rawPath.replace(/\\/g, '/');

        // Resolve traversal sequences
        const parts = rawPath.split('/');
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

        const finalResolvedPath = '/' + resolvedParts.join('/');
        const cleanFinalPath = finalResolvedPath.replace(/\/+/g, '/');

        // Verify security against open workspace folders
        const isSafe = folders.some(folder => {
            const normalizedFolder = folder.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
            if (normalizedFolder === '.' || normalizedFolder === '' || !normalizedFolder.startsWith('/')) {
                return true;
            }
            return cleanFinalPath === normalizedFolder || cleanFinalPath.startsWith(normalizedFolder + '/');
        }) || (window.ui?.fileList?.index?.files || []).some(file => {
            const normalizedFilePath = file.path.replace(/\\/g, '/').replace(/\/+/g, '/');
            if (cleanFinalPath !== normalizedFilePath) return false;
            return folders.some(folder => {
                const normFolder = folder.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
                return cleanFinalPath === normFolder || cleanFinalPath.startsWith(normFolder + '/');
            });
        });

        if (!isSafe) {
            console.error("Security violation check failed:", {
                rawPath,
                folders,
                cleanFinalPath
            });
            throw new Error(`Security Exception: Access to path '${rawPath}' is denied. It lies outside the allowed workspace folders.`);
        }

        return cleanFinalPath;
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
    async listFiles(path = '.', sourceId = null) {
        try {
            const folders = this._getEffectiveWorkspaceFolders(sourceId);
            
            // If in a multi-root workspace and path is root/unspecified, list all workspace root folders
            if ((!path || path === '.' || path === '' || path === '/') && folders.length > 1) {
                const rootLines = [];
                rootLines.push(`This workspace contains ${folders.length} root folders:`);
                for (let i = 0; i < folders.length; i++) {
                    const f = folders[i];
                    const folderName = f.split(/[\\/]/).filter(Boolean).pop() || f;
                    rootLines.push(`📁 [ROOT FOLDER] ${folderName} (${f})`);
                }
                const firstRootName = folders[0].split(/[\\/]/).filter(Boolean).pop() || folders[0];
                rootLines.push(`\nTo explore files inside a specific root, pass its folder name or path (e.g. list_files with path: "${firstRootName}")`);
                return rootLines.join('\n');
            }

            const resolvedPath = this._resolveAndValidatePath(path, sourceId);
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
    async fileInfo(path, sourceId = null) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path, sourceId);
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
            let openTab = this._findOpenTab(resolvedPath);

            const hasPendingDeferredEdits = !!(this.syntaxErrors && this.syntaxErrors[resolvedPath]) ||
                !!(window.ui?.aiManager?.activeSession?.pendingEdits && window.ui.aiManager.activeSession.pendingEdits[resolvedPath]);

            let content = "";
            if (openTab && openTab.config.session) {
                console.debug(`[AgentTools] Reading ${path} from open editor buffer.`);
                const session = openTab.config.session;
                const edits = this.editBuffer[resolvedPath]?.edits || [];
                content = this._getCleanContentOfSession(session, edits);
            } else if (hasPendingDeferredEdits && window.ui?.fileList?.open) {
                // If deferred validation edits exist but tab wasn't actively open, load from session
                await window.ui.fileList.open(resolvedPath, resolvedPath);
                openTab = this._findOpenTab(resolvedPath);
                if (openTab && openTab.config.session) {
                    const session = openTab.config.session;
                    const edits = this.editBuffer[resolvedPath]?.edits || [];
                    content = this._getCleanContentOfSession(session, edits);
                }
            }
            
            if (!content && this.conduit.isConnected) {
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
            } else if (!content && !openTab) {
                return "Error: Conduit not connected. Use @file context to provide content.";
            }

            // Check if content matches an existing unpruned tool response (skip cache if has pending deferred edits)
            if (!bypassCache && !hasPendingDeferredEdits && startLine === undefined && lineCount === undefined && content && this._isContentInUnprunedHistory(content)) {
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
    async readSymbol(query, sourceId = null) {
        try {
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsSearchSymbols(query);
                if (result.error) throw new Error(result.error);
                if (!result.data || result.data.length === 0) return "No matches found.";
                const folders = this._getEffectiveWorkspaceFolders(sourceId);
                const filtered = result.data.filter(sym => {
                    const norm = (sym.filePath || '').replace(/\\/g, '/');
                    const full = norm.startsWith('/') ? norm : `/${norm}`;
                    return folders.some(folder => {
                        const normFolder = folder.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
                        return full === normFolder || full.startsWith(normFolder + '/');
                    });
                });
                if (filtered.length === 0) return "No matches found.";
                return filtered.map(sym => `${sym.filePath}:${sym.line} - ${sym.signature}`).join('\n');
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
                    const folders = this._getEffectiveWorkspaceFolders(sourceId);
                    const searchRoots = folders.length > 0 ? folders : ["."];
                    for (const rootFolder of searchRoots) {
                        try {
                            const res = await this.conduit.wsSearch(rootFolder, "content", query);
                            if (res && !res.error && Array.isArray(res.data)) {
                                for (const match of res.data) {
                                    try {
                                        const resolved = this._resolveAndValidatePath(match.path, sourceId);
                                        if (searchedPaths.has(resolved)) continue; // Already searched
                                        searchedPaths.add(resolved);
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
                        } catch (errRoot) {
                            console.warn(`[AgentTools] Search failed for root ${rootFolder}:`, errRoot);
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
                        const resolvedPath = this._resolveAndValidatePath(file.path, sourceId);
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
     * Fuzzy line-by-line matching with similarity scoring and tolerance for minor indentation/whitespace differences.
     * @param {string[]} sourceLines 
     * @param {string[]} searchLines 
     * @returns {{ matchLineIndex: number, endLineIndex: number, bestScore: number, nearestLineIndex?: number } | null}
     */
    _fuzzyMatchLines(sourceLines, searchLines) {
        if (!sourceLines || !searchLines || searchLines.length === 0 || sourceLines.length < searchLines.length) {
            return null;
        }

        const normalizeLine = (l) => (l || "").replace(/\s+/g, ' ').trim().toLowerCase();
        const searchNorm = searchLines.map(normalizeLine);
        const searchTotalChars = searchNorm.join("").length;
        if (searchTotalChars === 0) return null;

        let bestScore = 0;
        let bestStart = -1;
        let bestEnd = -1;
        let secondBestScore = 0;

        const targetLen = searchLines.length;

        for (let i = 0; i <= sourceLines.length - targetLen; i++) {
            let matchingChars = 0;
            let matchingLines = 0;

            for (let j = 0; j < targetLen; j++) {
                const sLine = normalizeLine(sourceLines[i + j]);
                const qLine = searchNorm[j];

                if (sLine === qLine) {
                    matchingChars += qLine.length;
                    matchingLines++;
                } else if (sLine.includes(qLine) || qLine.includes(sLine)) {
                    matchingChars += Math.min(sLine.length, qLine.length);
                    matchingLines += 0.5;
                }
            }

            const lineScore = matchingLines / targetLen;
            const charScore = matchingChars / Math.max(1, searchTotalChars);
            const combinedScore = (lineScore * 0.6) + (charScore * 0.4);

            if (combinedScore > bestScore) {
                secondBestScore = bestScore;
                bestScore = combinedScore;
                bestStart = i;
                bestEnd = i + targetLen - 1;
            } else if (combinedScore > secondBestScore) {
                secondBestScore = combinedScore;
            }
        }

        // Require at least 85% similarity and clear distinction from second best candidate
        if (bestScore >= 0.85 && (bestScore - secondBestScore >= 0.15 || secondBestScore < 0.70)) {
            return {
                matchLineIndex: bestStart,
                endLineIndex: bestEnd,
                bestScore
            };
        }

        return {
            matchLineIndex: -1,
            endLineIndex: -1,
            bestScore,
            nearestLineIndex: bestStart
        };
    }

    /**
     * Performs a surgical edit on a file.
     * @param {string} path 
     * @param {string} searchString 
     * @param {string} replacementString 
     * @param {string} sourceId - For backup tracking
     */
    _applySingleSearchReplace(originalContent, searchString, replacementString, editIndex = 0, totalEdits = 1) {
        const cleanSearch = (searchString || "").replace(/\s+/g, "");
        const cleanReplace = (replacementString || "").replace(/\s+/g, "");
        if (cleanSearch === cleanReplace) {
            throw new Error(`Malformed edit${totalEdits > 1 ? ` (edit #${editIndex + 1})` : ""}: replace and search blocks are identical`);
        }

        const normOriginal = originalContent.replace(/\r\n/g, "\n");
        const normSearch = (searchString || "").replace(/\r\n/g, "\n");
        const normReplace = (replacementString ?? "").replace(/\r\n/g, "\n");

        let startLineIndex = -1;
        let startColIndex = 0;
        let endLineIndex = -1;
        let endColIndex = 0;
        let proposedContent = "";

        // 1. Primary Match Strategy: Exact character-for-character substring match
        let matchCount = 0;
        let firstMatchOffset = -1;
        let searchOffset = 0;

        if (normSearch.length > 0) {
            while ((searchOffset = normOriginal.indexOf(normSearch, searchOffset)) !== -1) {
                matchCount++;
                if (matchCount === 1) firstMatchOffset = searchOffset;
                searchOffset += normSearch.length;
            }
        }

        if (matchCount > 1) {
            throw new Error(`Search text${totalEdits > 1 ? ` for edit #${editIndex + 1}` : ""} matches multiple locations (${matchCount} matches). Provide more surrounding context lines.`);
        }

        if (matchCount === 1) {
            const beforeMatch = normOriginal.slice(0, firstMatchOffset);
            const matchedText = normOriginal.slice(firstMatchOffset, firstMatchOffset + normSearch.length);

            const beforeLines = beforeMatch.split("\n");
            startLineIndex = beforeLines.length - 1;
            startColIndex = beforeLines[beforeLines.length - 1].length;

            const matchedLines = matchedText.split("\n");
            endLineIndex = startLineIndex + matchedLines.length - 1;
            endColIndex = matchedLines.length === 1 ? startColIndex + matchedText.length : matchedLines[matchedLines.length - 1].length;

            proposedContent = normOriginal.slice(0, firstMatchOffset) + normReplace + normOriginal.slice(firstMatchOffset + normSearch.length);
        } else {
            // 2. Secondary Match Strategy: Line-by-line match with trailing whitespace tolerance
            const sourceLines = normOriginal.split("\n");
            const searchLines = normSearch.split("\n");

            const lineMatches = [];
            if (searchLines.length > 0) {
                for (let i = 0; i <= sourceLines.length - searchLines.length; i++) {
                    let isMatch = true;
                    for (let j = 0; j < searchLines.length; j++) {
                        if (sourceLines[i + j] !== searchLines[j] && sourceLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
                            isMatch = false;
                            break;
                        }
                    }
                    if (isMatch) {
                        lineMatches.push(i);
                    }
                }
            }

            if (lineMatches.length > 1) {
                throw new Error(`Search text${totalEdits > 1 ? ` for edit #${editIndex + 1}` : ""} matches multiple locations (${lineMatches.length} matches). Provide more surrounding context lines.`);
            }

            if (lineMatches.length === 1) {
                const matchLineIndex = lineMatches[0];
                startLineIndex = matchLineIndex;
                startColIndex = 0;
                endLineIndex = matchLineIndex + searchLines.length - 1;
                endColIndex = sourceLines[endLineIndex].length;

                const replacementLines = normReplace.split("\n");
                const proposedLines = [
                    ...sourceLines.slice(0, startLineIndex),
                    ...replacementLines,
                    ...sourceLines.slice(endLineIndex + 1)
                ];
                proposedContent = proposedLines.join("\n");
            } else {
                // 3. Tertiary Match Strategy (Fuzzy/Normalized token fallback)
                const fuzzy = this._fuzzyMatchLines(sourceLines, searchLines);
                if (fuzzy && fuzzy.matchLineIndex !== -1) {
                    console.info(`🎯 [AgentTools] Fuzzy match found for edit_file at lines ${fuzzy.matchLineIndex + 1}-${fuzzy.endLineIndex + 1} (${Math.round(fuzzy.bestScore * 100)}% similarity)`);
                    startLineIndex = fuzzy.matchLineIndex;
                    startColIndex = 0;
                    endLineIndex = fuzzy.endLineIndex;
                    endColIndex = sourceLines[endLineIndex].length;

                    const replacementLines = normReplace.split("\n");
                    const proposedLines = [
                        ...sourceLines.slice(0, startLineIndex),
                        ...replacementLines,
                        ...sourceLines.slice(endLineIndex + 1)
                    ];
                    proposedContent = proposedLines.join("\n");
                } else {
                    const nearest = fuzzy?.nearestLineIndex >= 0 
                        ? ` Nearest candidate match found near line ${fuzzy.nearestLineIndex + 1} (${Math.round(fuzzy.bestScore * 100)}% match). Check search string indentation or re-read file around that line with read_file.` 
                        : " Check search string or re-read file with read_file.";
                    throw new Error(`Search text${totalEdits > 1 ? ` for edit #${editIndex + 1}` : ""} not found.${nearest}`);
                }
            }
        }

        return {
            proposedContent,
            startLineIndex,
            startColIndex,
            endLineIndex,
            endColIndex
        };
    }

    /**
     * Replaces exact search blocks with replacement blocks in a file.
     * Supports either a single (searchString, replacementString) or an array of edits [{ search, replace }].
     * @param {string} path 
     * @param {string} [searchString] 
     * @param {string} [replacementString] 
     * @param {string} [sourceId] - For backup tracking
     * @param {Array<{search: string, replace: string}>} [edits] - Optional array of edits
     */
    async editFile(path, searchString, replacementString, sourceId, edits = null) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            // Normalize edit operations list
            let editList = [];
            if (Array.isArray(edits) && edits.length > 0) {
                editList = edits;
            } else if (typeof edits === "string") {
                try {
                    const parsed = JSON.parse(edits);
                    if (Array.isArray(parsed) && parsed.length > 0) editList = parsed;
                } catch (e) {}
            }
            if (editList.length === 0) {
                if (searchString === undefined && replacementString === undefined) {
                    throw new Error("Missing search and replace arguments or edits array for edit_file.");
                }
                editList = [{ search: searchString || "", replace: replacementString || "" }];
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

            let currentContent = originalContent;
            let firstStartLine = -1;
            let firstStartCol = 0;
            let lastEndLine = -1;
            let lastEndCol = 0;

            for (let idx = 0; idx < editList.length; idx++) {
                const item = editList[idx];
                const s = item.search !== undefined ? item.search : (item.searchString || "");
                const r = item.replace !== undefined ? item.replace : (item.replacementString ?? "");
                
                const applied = this._applySingleSearchReplace(currentContent, s, r, idx, editList.length);
                currentContent = applied.proposedContent;

                if (idx === 0) {
                    firstStartLine = applied.startLineIndex;
                    firstStartCol = applied.startColIndex;
                }
                lastEndLine = applied.endLineIndex;
                lastEndCol = applied.endColIndex;
            }

            const proposedContent = currentContent;
            const startLineIndex = firstStartLine;
            const startColIndex = firstStartCol;
            const endLineIndex = lastEndLine;
            const endColIndex = lastEndCol;

            // Pre-Save Syntax Validation
            const syntaxCheck = await syntaxValidator.validate(resolvedPath, proposedContent);
            if (syntaxCheck.valid) {
                delete this.syntaxErrors[resolvedPath];
            } else {
                this.syntaxErrors[resolvedPath] = syntaxCheck.error;
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            if (isForgivenessMode) {
                // 1. Create backup if not already present in the active session for the current milestone
                let backupId = "";
                const activeSession = window.ui?.aiManager?.activeSession;
                const existingBackups = (activeSession?.modifiedFiles && activeSession.modifiedFiles[resolvedPath]) || [];
                const milestoneTs = activeSession?.lastMilestoneTimestamp || 0;
                
                // An existing backup is current for this milestone if it was created after the milestone
                const currentMilestoneBackup = existingBackups.length > 0 && existingBackups[existingBackups.length - 1].timestamp >= milestoneTs 
                    ? existingBackups[existingBackups.length - 1] 
                    : null;

                if (currentMilestoneBackup) {
                    backupId = currentMilestoneBackup.backupId;
                } else {
                    try {
                        const actId = sourceId || activeSession?.id || "default";
                        if (activeSession?.turnTransactionId) {
                            backupId = await AgentBackup.recordFileChange(activeSession.turnTransactionId, resolvedPath, originalContent, actId);
                        } else {
                            backupId = await AgentBackup.create(resolvedPath, originalContent, actId);
                        }
                        
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

                // 2. Perform the edit on Ace session using the aligned range
                const Range = window.ace.require("ace/range").Range;
                const rangeToReplace = new Range(startLineIndex, startColIndex, endLineIndex, endColIndex);
                session.replace(rangeToReplace, replacementString ?? "");

                // 3. Save to disk immediately only if syntax is valid; otherwise defer save to memory
                if (syntaxCheck.valid && window.saveFileTab) {
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

                if (syntaxCheck.valid) {
                    return `Successfully edited ${path}.`;
                } else {
                    return `Successfully edited ${path}.\n⚠️ Notice: File currently has syntax errors (${syntaxCheck.error}). Ensure subsequent edits resolve this before completing the task.`;
                }
            }

            // Permission Mode: clean replacement in memory using the aligned range
            const Range = window.ace.require("ace/range").Range;
            const rangeToReplace = new Range(startLineIndex, startColIndex, endLineIndex, endColIndex);
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
            if (syntaxCheck.valid) {
                return `Successfully edited ${path}.`;
            } else {
                return `Successfully edited ${path}.\n⚠️ Notice: File currently has syntax errors (${syntaxCheck.error}). Ensure subsequent edits resolve this before completing the task.`;
            }
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
                // 1. Create backup if not already present in the active session for the current milestone
                let backupId = "";
                const activeSession = window.ui?.aiManager?.activeSession;
                const existingBackups = (activeSession?.modifiedFiles && activeSession.modifiedFiles[resolvedPath]) || [];
                const milestoneTs = activeSession?.lastMilestoneTimestamp || 0;
                
                const currentMilestoneBackup = existingBackups.length > 0 && existingBackups[existingBackups.length - 1].timestamp >= milestoneTs 
                    ? existingBackups[existingBackups.length - 1] 
                    : null;

                if (currentMilestoneBackup) {
                    backupId = currentMilestoneBackup.backupId;
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

                return `Successfully removed lines from ${path} in Forgiveness Mode. The tab has switched to the side-by-side Diff view for your review.`;
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
            const startRow = aligned.startLine - 1;
            const countVal = aligned.lineCount;

            if (startRow >= sourceLines.length) {
                throw new Error(`Start line ${startLine} is beyond the end of the source file (${sourceLines.length} lines).`);
            }

            const extractedLines = sourceLines.slice(startRow, startRow + countVal);
            const linesToCopy = extractedLines.join('\n');

            let destOriginalContent = "";
            let destinationExists = true;
            try {
                const readResult = await this.readFile(cleanDestination, undefined, undefined, true);
                if (readResult.startsWith("Error:")) {
                    destinationExists = false;
                } else {
                    destOriginalContent = readResult;
                }
            } catch (e) {
                destinationExists = false;
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            const actId = sourceId || window.ui?.aiManager?.activeSession?.id || "default";
            const activeSession = window.ui?.aiManager?.activeSession;
            const milestoneTs = activeSession?.lastMilestoneTimestamp || 0;

            if (removeFromSource) {
                const sourceTab = this._findOpenTab(cleanSource);
                if (!sourceTab) {
                    throw new Error(`Failed to open source file ${cleanSource} in the editor.`);
                }
                const srcSession = sourceTab.config.session;
                const srcDoc = srcSession.getDocument();
                const Range = window.ace.require("ace/range").Range;

                let rangeToRemove;
                if (startRow + countVal < sourceLines.length) {
                    rangeToRemove = new Range(startRow, 0, startRow + countVal, 0);
                } else {
                    if (startRow > 0) {
                        const prevLineLen = srcDoc.getLine(startRow - 1).length;
                        rangeToRemove = new Range(startRow - 1, prevLineLen, sourceLines.length - 1, srcDoc.getLine(sourceLines.length - 1).length);
                    } else {
                        rangeToRemove = new Range(0, 0, sourceLines.length - 1, srcDoc.getLine(sourceLines.length - 1).length);
                    }
                }

                if (isForgivenessMode) {
                    let srcBackupId = "";
                    const existingSrcBackups = (activeSession?.modifiedFiles && activeSession.modifiedFiles[cleanSource]) || [];
                    const currentSrcMilestoneBackup = existingSrcBackups.length > 0 && existingSrcBackups[existingSrcBackups.length - 1].timestamp >= milestoneTs
                        ? existingSrcBackups[existingSrcBackups.length - 1]
                        : null;

                    if (currentSrcMilestoneBackup) {
                        srcBackupId = currentSrcMilestoneBackup.backupId;
                    } else {
                        try {
                            srcBackupId = await AgentBackup.create(cleanSource, sourceContent, actId);

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

                    if (activeSession) {
                        activeSession.pendingEdits = activeSession.pendingEdits || {};
                        activeSession.pendingEdits[cleanSource] = true;
                        await workspaceClient.setSession(activeSession.id, activeSession);
                    }
                }
            }

            // Handle destination insertion
            if (!destinationExists) {
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
                return `Successfully ${actionWord} lines from ${source} to ${destination} in memory (Permission Mode). The tab has switched to the Diff view for your review. Please click 'Apply Changes' at the top to save or 'Discard' to revert.`;
            }

            // Normal flow: Insert into destination
            const targetTab = this._findOpenTab(cleanDestination);
            if (!targetTab) {
                throw new Error(`Failed to open destination file ${cleanDestination} in the editor.`);
            }

            const session = targetTab.config.session;
            const doc = session.getDocument();
            const originalContent = session.getValue();
            const totalLines = doc.getLength();

            let insertRow = insertAt - 1;
            if (insertRow < 0) insertRow = 0;
            if (insertRow > totalLines) insertRow = totalLines;

            const textToInsert = (insertRow >= totalLines && totalLines > 0 && doc.getLine(totalLines - 1) !== "")
                ? "\n" + linesToCopy
                : linesToCopy + (totalLines > 0 ? "\n" : "");

            const Range = window.ace.require("ace/range").Range;
            const rangeToInsert = new Range(insertRow, 0, insertRow, 0);

            if (isForgivenessMode) {
                let backupId = "";
                const existingDestBackups = (activeSession?.modifiedFiles && activeSession.modifiedFiles[cleanDestination]) || [];
                const currentDestMilestoneBackup = existingDestBackups.length > 0 && existingDestBackups[existingDestBackups.length - 1].timestamp >= milestoneTs
                    ? existingDestBackups[existingDestBackups.length - 1]
                    : null;

                if (currentDestMilestoneBackup) {
                    backupId = currentDestMilestoneBackup.backupId;
                } else {
                    try {
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

                const actionWord = removeFromSource ? "moved" : "copied";
                return `Successfully ${actionWord} lines from ${source} to ${destination} in Forgiveness Mode.`;
            }

            session.replace(rangeToInsert, textToInsert);
            targetTab.config.viewMode = "diff";
            delete targetTab.config.backupId;

            if (activeSession) {
                activeSession.pendingEdits = activeSession.pendingEdits || {};
                activeSession.pendingEdits[cleanDestination] = true;
                await workspaceClient.setSession(activeSession.id, activeSession);
            }

            targetTab.click();
            const actionWord = removeFromSource ? "moved" : "copied";
            return `Successfully ${actionWord} lines from ${source} to ${destination} in memory (Permission Mode). The tab has switched to the Diff view for your review. Please click 'Apply Changes' at the top to save or 'Discard' to revert.`;
        } catch (error) {
            return `Error copying lines: ${error.message}`;
        }
    }

    /**
     * Creates a new file.
     */
    async createFile(path, content, sourceId, overwrite = false) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            if (!this.conduit.isConnected) {
                return "Error: Conduit not connected.";
            }

            // Guard against accidental overwrite loops on existing files
            if (!overwrite) {
                const openTab = this._findOpenTab(resolvedPath);
                let fileExists = !!openTab;
                if (!fileExists && this.conduit.isConnected) {
                    try {
                        const check = await this.conduit.wsRead(resolvedPath);
                        if (check && !check.error && check.data !== undefined) {
                            fileExists = true;
                        }
                    } catch (e) {}
                }
                if (fileExists) {
                    return `Error: File '${path}' already exists. 'create_file' is strictly for new files. To modify an existing file, use 'edit_file' with targeted search/replace blocks or an 'edits' array.`;
                }
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            const activeSession = window.ui?.aiManager?.activeSession;
            const actId = sourceId || activeSession?.id || "default";

            // Pre-Save Syntax Validation
            const syntaxCheck = await syntaxValidator.validate(resolvedPath, content);
            if (syntaxCheck.valid) {
                delete this.syntaxErrors[resolvedPath];
            } else {
                this.syntaxErrors[resolvedPath] = syntaxCheck.error;
            }

            if (isForgivenessMode && syntaxCheck.valid) {
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

            // Permission Mode or Deferred Forgiveness Mode: Create empty on disk, open, set content in memory, show diff
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
            if (syntaxCheck.valid) {
                return `Successfully created ${path}.`;
            } else {
                return `Successfully created ${path}.\n⚠️ Notice: File currently has syntax errors (${syntaxCheck.error}). Ensure subsequent edits resolve this before completing the task.`;
            }
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
     * Executes a terminal shell command gated by explicit user approval / dynamic whitelist.
     */
    async runCommand(command, cwdOverride = null, subSessionId = null, timeoutMs = 60000) {
        if (typeof command !== 'string' || !command.trim()) {
            return "Error: Command must be a non-empty string.";
        }
        const cleanCmd = command.trim();
        const aiManager = window.ui?.aiManager;
        const targetSessionId = subSessionId || aiManager?.activeSessionId;
        
        // 0. Check session / global toggle
        const sessionObj = aiManager?.runningSessions.get(targetSessionId)?.instance?.session ||
                           aiManager?.activeSession;

        if (sessionObj && sessionObj.allowRunCommand === false) {
            return "Tool Error: Terminal command execution (`run_command`) is disabled for this session.";
        }
        
        if (sessionObj) {
            sessionObj.commandPolicy = sessionObj.commandPolicy || { whitelist: [], blacklist: [] };
        }
        const policy = sessionObj?.commandPolicy || { whitelist: [], blacklist: [] };

        // 2. Check Blacklist & Whitelist
        const isBlacklisted = policy.blacklist.some(rule => cleanCmd.startsWith(rule));
        if (isBlacklisted) {
            return `Command execution rejected by workspace security policy for command: ${cleanCmd}`;
        }

        const isWhitelisted = policy.whitelist.some(rule => cleanCmd === rule || cleanCmd.startsWith(rule + " "));
        let isApproved = isWhitelisted;

        // Resolve target working directory across multi-root workspace
        let targetCwd = cwdOverride;
        if (targetCwd) {
            try {
                targetCwd = this._resolveAndValidatePath(targetCwd, targetSessionId);
            } catch (e) {
                // If path resolution fails, leave as targetCwd
            }
        }
        if (!targetCwd) {
            const folders = this._getEffectiveWorkspaceFolders(targetSessionId);
            if (folders.length > 0) {
                const item = folders[0];
                targetCwd = typeof item === 'string' ? item : (item?.path || item?.name || "");
            }
        }

        // 3. User Approval Workflow if not whitelisted
        if (!isApproved) {
            const runningSub = aiManager?.runningSessions.get(targetSessionId);
            const activeSession = (runningSub && runningSub.instance?.session)
                ? runningSub.instance.session
                : (aiManager?.activeSessionId === targetSessionId ? aiManager.activeSession : await workspaceClient.getSession(targetSessionId));
            
            if (!activeSession) {
                return "Error: Session context not found for command approval.";
            }

            const queryId = crypto.randomUUID();
            const cmdMsg = {
                id: queryId,
                role: "system",
                type: "agent_command_approval",
                command: cleanCmd,
                cwd: targetCwd || "",
                timeoutMs: timeoutMs,
                status: "pending",
                subSessionId: targetSessionId,
                timestamp: Date.now()
            };

            activeSession.messages.push(cmdMsg);
            activeSession.pendingQueryId = queryId;
            activeSession.lastModified = Date.now();
            await workspaceClient.setSession(targetSessionId, activeSession);

            if (aiManager?.isSessionViewed(targetSessionId)) {
                aiManager.historyManager.render();
            }

            // Halt the agent loop so waiting for approval does not hold active resources
            // and can survive workspace/app reloads
            if (aiManager) {
                aiManager.setSessionProcessing(targetSessionId, false);
                aiManager._updateTabStatus(targetSessionId, "halted");
            }

            return `__AGENT_HALT_AWAITING_COMMAND_APPROVAL__:${queryId}`;
        }

        // 4. Streamed Terminal Execution via WebSocket (if auto-approved / whitelisted)
        return await this.executeTerminalCommand(cleanCmd, targetCwd, targetSessionId, timeoutMs);
    }

    /**
     * Executes a terminal shell command via WebSocket and streams output to chat with timeout cancellation.
     */
    async executeTerminalCommand(cleanCmd, cwdOverride = null, targetSessionId = null, timeoutMs = 60000) {
        const aiManager = window.ui?.aiManager;
        return await new Promise((resolve) => {
            let outputBuffer = "";
            let isFinished = false;
            const timeoutDuration = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 60000;

            const port = window.location.port || 3022;
            const wsHost = window.location.host || `localhost:${port}`;
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = `${wsProtocol}//${wsHost}/terminal?sessionId=agent_${Date.now()}`;
            
            let targetDir = cwdOverride;
            if (targetDir) {
                try {
                    targetDir = this._resolveAndValidatePath(targetDir, targetSessionId);
                } catch (e) {}
            }
            if (!targetDir) {
                const folders = this._getEffectiveWorkspaceFolders(targetSessionId);
                if (folders.length > 0) {
                    const item = folders[0];
                    targetDir = typeof item === 'string' ? item : (item?.path || item?.name || "");
                }
            }
            if (targetDir) {
                wsUrl += `&dir=${encodeURIComponent(targetDir)}`;
            }

            const activeSession = aiManager?.runningSessions.get(targetSessionId)?.instance?.session || aiManager?.activeSession;
            const executionMsgId = crypto.randomUUID();
            const streamMsg = {
                id: executionMsgId,
                role: "system",
                type: "agent_command_output",
                command: cleanCmd,
                cwd: targetDir,
                output: "",
                status: "running",
                subSessionId: targetSessionId,
                timestamp: Date.now()
            };

            if (activeSession) {
                activeSession.messages.push(streamMsg);
                if (aiManager?.isSessionViewed(targetSessionId)) {
                    aiManager.historyManager.render();
                }
            }

            const ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';

            let cleanedOutput = "";

            const sanitizeText = (rawStr) => {
                if (!rawStr) return "";
                let s = rawStr;
                // 1. Strip OSC escape sequences (e.g. \x1b]9;9;...\x1b\ or \x1b]0;...\x07)
                s = s.replace(/\x1b\][^\x1b\x07]*[\x1b\x07\\]/g, "");
                // 2. Strip standard ANSI color/cursor escape sequences
                s = s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
                // 3. Strip non-printable ASCII control characters except newlines/tabs
                s = s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
                return s;
            };

            const updateOutputDom = (chunk) => {
                outputBuffer += chunk;
                
                let s = sanitizeText(outputBuffer);

                // 1. Strip the initial prologue line containing stty / export setup if present
                s = s.replace(/^[^\n]*(?:stty\s+-echo|export\s+PAGER)[^\n]*\n?/gm, "");

                // 2. Strip command input echo lines up to the first newline after the clean command
                if (cleanCmd && s.includes(cleanCmd)) {
                    const idx = s.indexOf(cleanCmd);
                    const afterCmd = s.substring(idx + cleanCmd.length);
                    const firstNewline = afterCmd.indexOf('\n');
                    if (firstNewline !== -1) {
                        s = afterCmd.substring(firstNewline + 1);
                    } else {
                        s = afterCmd;
                    }
                }

                // 3. Strip trailing exit command, standalone 'exit' lines, and prompt noise
                s = s.replace(/(?:^|\n)(?:[^\n]*?[#$]\s*)?exit(?:\s+status\s+\d+)?(?=\n|$)/gi, "");
                s = s.replace(/^.*?[#$]\s*/gm, "");
                s = s.trim();

                cleanedOutput = s;
                streamMsg.output = cleanedOutput;
                
                const block = document.querySelector(`.agent-cmd-output-block[data-message-id="${executionMsgId}"]`);
                if (block) {
                    const code = block.querySelector("pre code");
                    if (code) {
                        code.textContent = cleanedOutput || "(Running command...)";
                        const pre = code.parentElement;
                        if (pre) pre.scrollTop = pre.scrollHeight;
                    }
                }
            };

            const finish = (code = 0, isTimedOut = false) => {
                if (isFinished) return;
                isFinished = true;
                clearTimeout(timeoutTimer);

                streamMsg.status = isTimedOut ? "timed_out" : (code === 0 ? "completed" : "failed");
                if (activeSession) {
                    workspaceClient.setSession(targetSessionId, activeSession).catch(() => {});
                }
                if (aiManager?.isSessionViewed(targetSessionId)) {
                    aiManager.historyManager.render();
                }

                if (isTimedOut) {
                    resolve(`Command execution timed out after ${(timeoutDuration / 1000).toFixed(0)}s.\nOutput captured:\n${cleanedOutput || "(No output)"}`);
                } else {
                    resolve(`Command execution completed.\nOutput:\n${cleanedOutput || "(No output)"}`);
                }
            };

            const timeoutTimer = setTimeout(() => {
                if (isFinished) return;
                updateOutputDom(`\n[Command Execution Timed Out after ${(timeoutDuration / 1000).toFixed(0)}s. Terminating process...]`);
                try {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send('\x03\nexit\n');
                        setTimeout(() => {
                            try {
                                if (ws.readyState === WebSocket.OPEN) ws.close();
                            } catch (e) {}
                        }, 500);
                    }
                } catch (e) {}
                finish(124, true);
            }, timeoutDuration);

            ws.onopen = () => {
                // Disable terminal echo and interactive pagers before executing command
                ws.send(`stty -echo 2>/dev/null || true; export PAGER=cat GIT_PAGER=cat CI=true NO_COLOR=1 2>/dev/null || true\n${cleanCmd}\nexit\n`);
            };

            ws.onmessage = (event) => {
                let text = "";
                if (typeof event.data === 'string') {
                    try {
                        const jsonMsg = JSON.parse(event.data);
                        if (jsonMsg && jsonMsg.type === "terminalInfo") {
                            return;
                        }
                    } catch (e) {}
                    text = event.data;
                } else if (event.data instanceof ArrayBuffer) {
                    text = new TextDecoder('utf-8').decode(new Uint8Array(event.data));
                } else if (event.data && event.data.arrayBuffer) {
                    event.data.arrayBuffer().then(buf => {
                        const blobText = new TextDecoder('utf-8').decode(new Uint8Array(buf));
                        updateOutputDom(blobText);
                    });
                    return;
                }

                if (text) {
                    updateOutputDom(text);
                }
            };

            ws.onerror = (err) => {
                updateOutputDom(`\n[Execution Error: ${err.message || 'Connection failed'}]`);
                finish(1, false);
            };

            ws.onclose = () => {
                finish(0, false);
            };
        });
    }

    /**
     * Verifies that all files currently flagged with syntax errors have been resolved.
     * If a file has been resolved to valid syntax, saves to disk in Forgiveness Mode.
     * @returns {Promise<string|null>} Error message if any file has syntax errors, or null if all clean.
     */
    async _checkPendingSyntaxErrors() {
        const pathsWithErrors = Object.keys(this.syntaxErrors);
        for (const resolvedPath of pathsWithErrors) {
            const tab = this._findOpenTab(resolvedPath);
            const content = tab?.config?.session?.getValue();
            if (typeof content === 'string') {
                const check = await syntaxValidator.validate(resolvedPath, content);
                if (check.valid) {
                    delete this.syntaxErrors[resolvedPath];
                    // In forgiveness mode, commit to disk now that syntax is valid
                    if (window.ui?.aiManager?.forgivenessMode === true && tab && window.saveFileTab) {
                        await window.saveFileTab(tab);
                        tab.config.session.baseValue = tab.config.session.getValue();
                    }
                } else {
                    this.syntaxErrors[resolvedPath] = check.error;
                    return `File '${resolvedPath}' has remaining syntax errors:\n${check.error}`;
                }
            } else if (this.syntaxErrors[resolvedPath]) {
                return `File '${resolvedPath}' has remaining syntax errors:\n${this.syntaxErrors[resolvedPath]}`;
            }
        }
        return null;
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
                return await this.listFiles(args.path, sourceId);
            case 'file_info':
                return await this.fileInfo(args.path, sourceId);
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
                return await this.readSymbol(args.query || args.symbol, sourceId);
            case 'search_files':
                return await this.searchFiles(args.query, sourceId);
            case 'search_in_file':
                return await this.searchInFile(args.path, args.query);
            case 'edit_file':
                return await this.editFile(
                    args.path,
                    args.search !== undefined && args.search !== null ? args.search : args.searchString,
                    args.replace !== undefined && args.replace !== null ? args.replace : args.replacementString,
                    sourceId,
                    args.edits
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
                return await this.createFile(args.path, args.content, sourceId, args.overwrite);
            case 'validate_syntax': {
                let contentToValidate = args.content;
                if (!contentToValidate && (args.edits || (args.search && args.replace !== undefined))) {
                    try {
                        const resolvedPath = this._resolveAndValidatePath(args.path, sourceId);
                        const targetTab = this._findOpenTab(resolvedPath);
                        let originalContent = targetTab?.config?.session?.getValue() || (await this.readFile(args.path));
                        if (typeof originalContent === 'string') {
                            if (args.edits && Array.isArray(args.edits)) {
                                for (const ed of args.edits) {
                                    const s = ed.search !== undefined ? ed.search : ed.searchString;
                                    const r = ed.replace !== undefined ? ed.replace : ed.replacementString;
                                    if (s && r !== undefined) {
                                        originalContent = originalContent.replace(s, r);
                                    }
                                }
                                contentToValidate = originalContent;
                            } else if (args.search && args.replace !== undefined) {
                                contentToValidate = originalContent.replace(args.search, args.replace);
                            }
                        }
                    } catch (e) {
                        // fallback to args.content
                    }
                }
                const syntaxCheck = await syntaxValidator.validate(args.path, contentToValidate || "");
                if (syntaxCheck.valid) {
                    return `Valid syntax for ${args.path}.`;
                }
                return `Syntax validation failed for ${args.path}:\n${syntaxCheck.error}`;
            }
            case 'open_file':
                return await this.openFile(args.path);
            case 'find_file':
                return await this.findFile(args.path, sourceId);
            case 'run_command':
            case 'exec_command':
                return await this.runCommand(args.command || args.cmd, args.cwd, sourceId, args.timeoutMs || args.timeout);
            case 'create_implementation_plan': {
                const targetSessionId = sourceId || window.ui?.aiManager?.activeSessionId;
                const aiManager = window.ui?.aiManager;
                const session = (targetSessionId && aiManager?.runningSessions?.get(targetSessionId)?.instance?.session)
                    || (targetSessionId === aiManager?.activeSessionId ? aiManager?.activeSession : null);

                if (session && args.plan) {
                    session.implementationPlan = args.plan.trim();
                    if (args.tasks) {
                        const formatted = aiManager?.messageRenderer?.formatTaskList ? aiManager.messageRenderer.formatTaskList(args.tasks.trim()) : args.tasks.trim();
                        session.taskList = formatted;
                    }
                    session.lastModified = Date.now();
                    workspaceClient.setSession(session.id, session);
                    aiManager?._updateAgentProgressPanel?.();

                    if (window.ui?.openPlanAndTaskList) {
                        const isOpen = (window.ui.leftTabs?.tabs?.some(t => t.config?.path === "plan_tasks")) ||
                            (window.ui.rightTabs?.tabs?.some(t => t.config?.path === "plan_tasks"));
                        if (!isOpen) {
                            window.ui.openPlanAndTaskList();
                        }
                    }
                }
                return "Implementation plan created. The user is reviewing it.";
            }
            case 'create_task_list':
            case 'update_task_list': {
                const targetSessionId = sourceId || window.ui?.aiManager?.activeSessionId;
                const aiManager = window.ui?.aiManager;
                const session = (targetSessionId && aiManager?.runningSessions?.get(targetSessionId)?.instance?.session)
                    || (targetSessionId === aiManager?.activeSessionId ? aiManager?.activeSession : null);

                const tasksInput = args.tasks || args.taskList || "";
                if (session && tasksInput) {
                    const formatted = aiManager?.messageRenderer?.formatTaskList ? aiManager.messageRenderer.formatTaskList(tasksInput.trim()) : tasksInput.trim();
                    session.taskList = formatted;
                    session.lastModified = Date.now();
                    workspaceClient.setSession(session.id, session);
                    aiManager?._updateAgentProgressPanel?.();
                }
                return "Task list updated.";
            }
            case 'complete_task': {
                const syntaxIssue = await this._checkPendingSyntaxErrors();
                if (syntaxIssue) {
                    return `Cannot mark task complete: ${syntaxIssue}\nPlease resolve the syntax error before completing the task.`;
                }

                const taskName = (args.taskName || args.task || args.name || "").trim();
                const targetSessionId = sourceId || window.ui?.aiManager?.activeSessionId;
                const aiManager = window.ui?.aiManager;
                const session = (targetSessionId && aiManager?.runningSessions?.get(targetSessionId)?.instance?.session)
                    || (targetSessionId === aiManager?.activeSessionId ? aiManager?.activeSession : null);

                if (session && session.taskList && taskName) {
                    const escapedTaskText = taskName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    const checkboxRegex = new RegExp(`([\\-*]\\s*\\[\\s*\\]\\s*)${escapedTaskText}`, 'i');
                    if (checkboxRegex.test(session.taskList)) {
                        session.taskList = session.taskList.replace(checkboxRegex, (match, bulletGroup) => {
                            return bulletGroup.replace(/\[\s*\]/, '[x]') + taskName;
                        });
                    } else {
                        // Fallback partial match if exact string didn't match whole line
                        const lines = session.taskList.split('\n');
                        let matched = false;
                        const lowerTaskName = taskName.toLowerCase();
                        const updatedLines = lines.map(line => {
                            if (!matched && (line.includes('- [ ]') || line.includes('* [ ]')) && line.toLowerCase().includes(lowerTaskName)) {
                                matched = true;
                                return line.replace(/\[\s*\]/, '[x]');
                            }
                            return line;
                        });
                        if (matched) {
                            session.taskList = updatedLines.join('\n');
                        }
                    }
                    session.lastModified = Date.now();
                    workspaceClient.setSession(session.id, session);
                    aiManager?._updateAgentProgressPanel?.();
                }

                return `Task marked complete: ${taskName}`;
            }
            case 'query':
                return await this.queryUser(args, sourceId);
            case 'create_sub_agent':
                return await this.createSubAgent(args, sourceId);
            case 'sub_agent_complete': {
                const syntaxIssue = await this._checkPendingSyntaxErrors();
                if (syntaxIssue) {
                    return `Cannot complete sub-agent execution: ${syntaxIssue}\nPlease resolve the syntax error before finishing.`;
                }
                return await this.subAgentComplete(args, sourceId);
            }
            case 'query_sub_agent':
                return await this.querySubAgent(args, sourceId);
            case 'query_parent':
                return await this.queryParent(args, sourceId);
            case 'done': {
                const syntaxIssue = await this._checkPendingSyntaxErrors();
                if (syntaxIssue) {
                    return `Cannot finish agent execution: ${syntaxIssue}\nPlease resolve the syntax error before completing your work.`;
                }
                return "Agent successfully completed the execution loop.";
            }
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
    async findFile(searchPath, sourceId = null) {
        try {
            if (typeof searchPath !== 'string') {
                return "Error: Path must be a string.";
            }
            if (!window.ui?.fileList?.index?.files) {
                return "Error: File list index is not loaded.";
            }
            const folders = this._getEffectiveWorkspaceFolders(sourceId);
            const allFiles = window.ui.fileList.index.files;
            const files = allFiles.filter(f => {
                const normPath = f.path.replace(/\\/g, '/');
                const fullPath = normPath.startsWith('/') ? normPath : `/${normPath}`;
                return folders.some(folder => {
                    const normFolder = folder.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
                    return fullPath === normFolder || fullPath.startsWith(normFolder + '/');
                });
            });
            
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
            systemPromptOverride: subSystemPrompt,
            pinnedRoots: parentSession.pinnedRoots || []
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
                // Trigger parent history update and wake waiting parent loops
                window.dispatchEvent(new CustomEvent('subagent-updated', { detail: { subSessionId: subId, parentSessionId, status: "finished" } }));
                if (window.ui?.aiManager?.activeSessionId === parentSessionId) {
                    window.ui.aiManager.historyManager.render();
                }
            }
        })();

        window.dispatchEvent(new CustomEvent('subagent-updated', { detail: { subSessionId: subId, parentSessionId, status: "spawned" } }));
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

        window.dispatchEvent(new CustomEvent('subagent-updated', { detail: { subSessionId, status: "completed" } }));
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
                    window.dispatchEvent(new CustomEvent('subagent-updated', { detail: { subSessionId, parentSessionId, status: "finished" } }));
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

        window.dispatchEvent(new CustomEvent('subagent-updated', { detail: { subSessionId, parentSessionId, status: "resumed" } }));

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

        window.dispatchEvent(new CustomEvent('subagent-updated', { detail: { subSessionId, parentSessionId, status: "waiting_for_parent" } }));

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
