import conduit from '../conduit-client.mjs';
import AgentBackup from './agent-backup.mjs';

/**
 * Implements the core tools for the CodeAgent.
 * Prioritizes Conduit for access, with fallback to browser APIs where possible.
 */
class AgentTools {
    constructor() {
        this.conduit = conduit;
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
     * Searches for text across files (Grep) client-side.
     * @param {string} query 
     */
    async searchFiles(query) {
        try {
            if (!window.ui?.fileList?.index?.files) {
                return "Error: File list index is not loaded.";
            }
            const files = window.ui.fileList.index.files;
            const matches = [];
            const lowercaseQuery = query.toLowerCase();
            
            // Limit search count to avoid freezing UI on huge repos
            let searchedCount = 0;
            for (const file of files) {
                if (file.isDir) continue;
                searchedCount++;
                
                // If path matches query
                if (file.path.toLowerCase().includes(lowercaseQuery)) {
                    matches.push({ path: file.path, type: "filename_match" });
                }
                
                // Read and check content of text files (skip known binaries/large formats)
                const extension = file.path.split('.').pop().toLowerCase();
                const skipExtensions = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'pdf', 'zip', 'gz', 'tar', 'exe', 'bin', 'dll'];
                if (skipExtensions.includes(extension)) continue;

                // Validate before reading
                try {
                    const resolvedPath = this._resolveAndValidatePath(file.path);
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
                    // Ignore search access errors for secure skipped files
                    continue;
                }
                
                if (matches.length >= 50) break;
                if (searchedCount >= 200) break; // Safety limit
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
            const originalContent = await this.readFile(resolvedPath);
            if (originalContent.startsWith("Error:")) throw new Error(originalContent);

            if (!originalContent.includes(searchString)) {
                throw new Error(`Target string not found in ${path}. Ensure the search string matches exactly, including whitespace.`);
            }

            const newContent = originalContent.replace(searchString, replacementString);
            
            // Create backup before writing
            await AgentBackup.create(resolvedPath, originalContent, sourceId);

            if (this.conduit.isConnected) {
                const base64Content = btoa(unescape(encodeURIComponent(newContent))); // Safe base64 encoding
                const result = await this.conduit.wsWrite(resolvedPath, base64Content);
                if (result.error) throw new Error(result.error);

                // Update open editor tab dynamically
                if (window.ui?.leftTabs?.tabs || window.ui?.rightTabs?.tabs) {
                    const openTabs = [...(window.ui.leftTabs?.tabs || []), ...(window.ui.rightTabs?.tabs || [])];
                    for (const tab of openTabs) {
                        if (tab.config && tab.config.path === resolvedPath && tab.config.session) {
                            tab.config.session.setValue(newContent);
                            break;
                        }
                    }
                }
                
                // Refresh directory tree
                if (window.ui?.fileList?.refreshFolders) {
                    window.ui.fileList.refreshFolders();
                }

                return `Successfully updated ${path}.`;
            } else {
                return "Error: Conduit not connected. Persistent writes require Conduit.";
            }
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
}

const agentTools = new AgentTools();
export default agentTools;
