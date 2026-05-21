import conduit from '../conduit-client.mjs';
import AgentBackup from './agent-backup.mjs';

/**
 * Implements the core tools for the CodeAgent.
 * Prioritizes Conduit for access, with fallback to browser APIs where possible.
 */
class AgentTools {
    constructor() {
        this.conduit = conduit;
        this.editBuffer = {}; // Tracks { [resolvedPath]: { markerIds: [] } }
    }

    _resolveAndValidatePath(targetPath) {
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
     * Reads a file's content.
     * @param {string} path 
     */
    async readFile(path) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            
            // Try to find if the file is open in the editor
            let openTab = null;
            if (window.ui?.leftTabs?.tabs || window.ui?.rightTabs?.tabs) {
                const openTabs = [...(window.ui.leftTabs?.tabs || []), ...(window.ui.rightTabs?.tabs || [])];
                openTab = openTabs.find(tab => tab.config && tab.config.path === resolvedPath && tab.config.session);
            }

            if (openTab && openTab.config.session) {
                console.log(`[AgentTools] Reading ${path} from open editor buffer.`);
                return openTab.config.session.getValue();
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
     * Searches for text across files (Grep) accelerating using Go and local buffers.
     * @param {string} query 
     */
    async searchFiles(query) {
        try {
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

                    const content = tab.config.session.getValue();
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
     * Performs a surgical edit on a file.
     * @param {string} path 
     * @param {string} searchString 
     * @param {string} replacementString 
     * @param {string} sourceId - For backup tracking
     */
    async editFile(path, searchString, replacementString, sourceId) {
        try {
            const resolvedPath = this._resolveAndValidatePath(path);
            
            // 1. Ensure the file is open in the editor
            let targetTab = null;
            const findTab = () => {
                if (window.ui?.leftTabs?.tabs || window.ui?.rightTabs?.tabs) {
                    const openTabs = [...(window.ui.leftTabs?.tabs || []), ...(window.ui.rightTabs?.tabs || [])];
                    return openTabs.find(tab => tab.config && tab.config.path === resolvedPath && tab.config.session);
                }
                return null;
            };

            targetTab = findTab();

            if (!targetTab) {
                if (window.ui?.fileList?.open) {
                    await window.ui.fileList.open(resolvedPath, resolvedPath);
                    targetTab = findTab();
                }
            }

            if (!targetTab) {
                throw new Error(`Failed to open file ${resolvedPath} in the editor.`);
            }

            // 2. Perform the edit ON THE ACE SESSION
            const session = targetTab.config.session;
            const originalContent = session.getValue();

            const startIndex = originalContent.indexOf(searchString);
            if (startIndex === -1) {
                throw new Error(`Target string not found in the open editor tab for ${path}. Ensure the search string matches exactly, including whitespace.`);
            }

            const indexToPosition = (text, index) => {
                const lines = text.substring(0, index).split('\n');
                return {
                    row: lines.length - 1,
                    column: lines[lines.length - 1].length
                };
            };

            const startPos = indexToPosition(originalContent, startIndex);
            const endPos = indexToPosition(originalContent, startIndex + searchString.length);
            
            const Range = window.ace.require("ace/range").Range;
            const rangeToReplace = new Range(startPos.row, startPos.column, endPos.row, endPos.column);
            
            // Perform review replacement: show search string and replacement string inline separated by a newline
            const combinedString = searchString + "\n" + replacementString;
            session.replace(rangeToReplace, combinedString);
            
            // Create dynamic Anchors that track the edited range dynamically
            const newContent = session.getValue();
            const startDeletedPos = indexToPosition(newContent, startIndex);
            const endDeletedPos = indexToPosition(newContent, startIndex + searchString.length);
            const startAddedPos = indexToPosition(newContent, startIndex + searchString.length + 1);
            const endAddedPos = indexToPosition(newContent, startIndex + searchString.length + 1 + replacementString.length);

            const doc = session.getDocument();
            const startDeletedAnchor = doc.createAnchor(startDeletedPos.row, startDeletedPos.column);
            const endDeletedAnchor = doc.createAnchor(endDeletedPos.row, endDeletedPos.column);
            const startAddedAnchor = doc.createAnchor(startAddedPos.row, startAddedPos.column);
            const endAddedAnchor = doc.createAnchor(endAddedPos.row, endAddedPos.column);

            // Add a dynamic marker to annotate the change in the editor (red for deleted, green for added)
            const dynamicMarker = {
                update: function(html, markerLayer, session, config) {
                    const startDel = startDeletedAnchor.getPosition();
                    const endDel = endDeletedAnchor.getPosition();
                    const startAdd = startAddedAnchor.getPosition();
                    const endAdd = endAddedAnchor.getPosition();
                    
                    const Range = window.ace.require("ace/range").Range;
                    
                    // Draw deleted marker (red)
                    const rangeDel = new Range(startDel.row, 0, endDel.row, Infinity);
                    markerLayer.drawFullLineMarker(html, rangeDel, "agent-edit-deleted", config);
                    
                    // Draw added marker (green)
                    const rangeAdd = new Range(startAdd.row, 0, endAdd.row, Infinity);
                    markerLayer.drawFullLineMarker(html, rangeAdd, "agent-edit-added", config);
                }
            };
            session.addDynamicMarker(dynamicMarker);
            
            // Track in edit buffer
            if (!this.editBuffer[resolvedPath]) {
                this.editBuffer[resolvedPath] = {
                    edits: [],
                    currentIndex: 0
                };
            }
            
            const edit = {
                id: dynamicMarker.id,
                startDeletedAnchor: startDeletedAnchor,
                endDeletedAnchor: endDeletedAnchor,
                startAddedAnchor: startAddedAnchor,
                endAddedAnchor: endAddedAnchor,
                // Fallbacks for backward compatibility
                startAnchor: startDeletedAnchor,
                endAnchor: endAddedAnchor,
                originalText: searchString,
                replacementText: replacementString,
                status: "pending"
            };
            
            this.editBuffer[resolvedPath].edits.push(edit);

            if (window.ui?.aiManager?._renderEditBuffer) {
                window.ui.aiManager._renderEditBuffer();
            }

            // Focus the tab
            targetTab.click();

            // Refresh UI notice bar if active
            if (window.ui?.updateAgentEditsNotice) {
                window.ui.updateAgentEditsNotice(targetTab);
            }

            return `Successfully edited ${path} in the editor. The changes are pending user review and save.`;
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
            if (this.conduit.isConnected) {
                const base64Content = btoa(unescape(encodeURIComponent(content))); // Safe base64 encoding
                const result = await this.conduit.wsWrite(resolvedPath, base64Content);
                if (result.error) throw new Error(result.error);

                // Refresh directory tree
                if (window.ui?.fileList?.refreshFolders) {
                    window.ui.fileList.refreshFolders();
                }
                
                return `Successfully created ${path}.`;
            } else {
                return "Error: Conduit not connected.";
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
        return `Executing: ${command}\nOutput: (Terminal execution via agent is not supported directly for security reasons. Please use the terminal tab instead.)`;
    }

    getEditBuffer() {
        return this.editBuffer;
    }

    async resolveEdit(resolvedPath, editIndex, accept) {
        const info = this.editBuffer[resolvedPath];
        if (!info || !info.edits || !info.edits[editIndex]) {
            return; // Already resolved or invalid
        }
        
        const edit = info.edits[editIndex];
        
        // Find open tab
        const openTabs = [...(window.ui?.leftTabs?.tabs || []), ...(window.ui?.rightTabs?.tabs || [])];
        const tab = openTabs.find(t => t.config && t.config.path === resolvedPath && t.config.session);
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

    async resolveAllEdits(resolvedPath, accept) {
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
export default agentTools;
