import conduit from '../conduit-client.mjs';
import AgentBackup from './agent-backup.mjs';
import { tools } from "../ai-manager-tools-schema.mjs";
import workspaceClient from '../workspace-client.mjs';

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
                return Array.isArray(result.data) 
                    ? result.data.map(f => `${f.is_dir ? '[DIR] ' : ''}${f.name}`).join('\n')
                    : "No files found or invalid response.";
            } else {
                return "Error: Conduit not connected. Manual listing via browser API not implemented for agent yet.";
            }
        } catch (error) {
            return `Error listing files: ${error.message}`;
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
    async readFile(path) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            
            // Try to find if the file is open in the editor
            const openTab = this._findOpenTab(resolvedPath);

            if (openTab && openTab.config.session) {
                console.log(`[AgentTools] Reading ${path} from open editor buffer.`);
                const session = openTab.config.session;
                const edits = this.editBuffer[resolvedPath]?.edits || [];
                return this._getCleanContentOfSession(session, edits);
            }

            if (this.conduit.isConnected) {
                const result = await this.conduit.wsRead(resolvedPath);
                if (result.error) throw new Error(result.error);
                if (result.data) {
                    try {
                        return atob(result.data);
                    } catch (e) {
                        // If not valid base64 (or already decoded), return as-is
                        return result.data;
                    }
                }
                return result.content || "";
            } else {
                return "Error: Conduit not connected. Use @file context to provide content.";
            }
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

    /**
     * Reads a file's structural outline.
     * @param {string} path 
     */
    async readFileOutline(path) {
        try {
            const permitted = this._checkFilePermitted(path);
            if (permitted !== true) return permitted;

            const resolvedPath = this._resolveAndValidatePath(path);
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsGetOutline(resolvedPath);
                if (result.error) throw new Error(result.error);
                return result.data || "No outline available.";
            } else {
                return "Error: Conduit not connected.";
            }
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
                console.log(`[AgentTools] Running backend Go search for query: "${query}"`);
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
                console.log("[AgentTools] Falling back to client-side files index search");
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

                        const content = await this.readFile(resolvedPath);
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
            return matches.map(m => {
                if (m.type === "filename_match") {
                    return `[Match in filename] ${m.path}`;
                }
                return `${m.path}:${m.line}: ${m.content}`;
            }).join('\n');
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
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(query)) {
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

            // 2. Perform the edit ON THE ACE SESSION
            const session = targetTab.config.session;

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            if (isForgivenessMode) {
                const originalContent = session.getValue();
                const cleanStartIndex = originalContent.indexOf(searchString);
                if (cleanStartIndex === -1) {
                    throw new Error(`Target string not found in ${path}. Ensure the search string matches exactly, including whitespace.`);
                }
                
                // 1. Create backup
                let backupId = "";
                try {
                    const actId = sourceId || window.ui?.aiManager?.activeSession?.id || "default";
                    backupId = await AgentBackup.create(resolvedPath, originalContent, actId);
                    
                    const activeSession = window.ui?.aiManager?.activeSession;
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

                // 2. Perform the clean edit on Ace session
                const doc = session.getDocument();
                const startPos = doc.indexToPosition(cleanStartIndex);
                const endPos = doc.indexToPosition(cleanStartIndex + searchString.length);
                const Range = window.ace.require("ace/range").Range;
                const rangeToReplace = new Range(startPos.row, startPos.column, endPos.row, endPos.column);
                session.replace(rangeToReplace, replacementString);

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

                return `Successfully edited ${path} in Forgiveness Mode. The change has been committed directly to the file and a rollback backup was created. The tab has switched to the side-by-side Diff view for your review.`;
            }

            // Permission Mode: clean replacement in memory
            const originalContent = session.getValue();
            const cleanStartIndex = originalContent.indexOf(searchString);
            if (cleanStartIndex === -1) {
                throw new Error(`Target string not found in ${path}. Ensure the search string matches exactly, including whitespace.`);
            }

            // Perform clean, in-memory replacement on Ace session
            const doc = session.getDocument();
            const startPos = doc.indexToPosition(cleanStartIndex);
            const endPos = doc.indexToPosition(cleanStartIndex + searchString.length);
            const Range = window.ace.require("ace/range").Range;
            const rangeToReplace = new Range(startPos.row, startPos.column, endPos.row, endPos.column);
            session.replace(rangeToReplace, replacementString);
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
     * Creates a new file.
     */
    async createFile(path, content, sourceId) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            if (!this.conduit.isConnected) {
                return "Error: Conduit not connected.";
            }

            const isForgivenessMode = window.ui?.aiManager?.forgivenessMode === true;
            if (isForgivenessMode) {
                const base64Content = btoa(unescape(encodeURIComponent(content))); // Safe base64 encoding
                const result = await this.conduit.wsWrite(resolvedPath, base64Content);
                if (result.error) throw new Error(result.error);

                // Refresh directory tree
                if (window.ui?.fileList?.refreshFolders) {
                    window.ui.fileList.refreshFolders();
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
            const activeSession = window.ui?.aiManager?.activeSession;
            if (activeSession) {
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
        // Fallback required parameter check
        const toolDef = tools.find(t => t.name === name);
        if (toolDef && toolDef.parameters && Array.isArray(toolDef.parameters.required)) {
            for (const reqParam of toolDef.parameters.required) {
                if (args[reqParam] === undefined || args[reqParam] === null || args[reqParam] === "") {
                    return `Tool Error: ${name} requires "${reqParam}" parameter`;
                }
            }
        }

        switch (name) {
            case 'list_files':
                return await this.listFiles(args.path);
            case 'read_file':
                return await this.readFile(args.path);
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
                    args.search || args.searchString,
                    args.replace || args.replacementString,
                    sourceId
                );
            case 'create_file':
                return await this.createFile(args.path, args.content, sourceId);
            case 'open_file':
                return await this.openFile(args.path);
            case 'find_file':
                return await this.findFile(args.path);
            case 'exec_command':
                return await this.execCommand(args.command);
            case 'create_implementation_plan':
                return "Successfully created implementation plan. The user is reviewing it.";
            case 'update_task_list':
                return "Successfully updated task list.";
            case 'complete_task':
                return `Successfully marked task as complete: ${args.taskName}`;
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
}

const agentTools = new AgentTools();
window.agentTools = agentTools
export default agentTools;
