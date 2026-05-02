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

    /**
     * Lists files in a directory.
     * @param {string} path 
     * @returns {Promise<string>}
     */
    async listFiles(path = '.') {
        try {
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsList(path);
                if (result.error) throw new Error(result.error);
                return Array.isArray(result.data) 
                    ? result.data.map(f => `${f.is_dir ? '[DIR] ' : ''}${f.name}`).join('\n')
                    : "No files found or invalid response.";
            } else {
                // Fallback: Browser File System Access API listing (requires folder handle)
                // This is limited because we don't always have the root handle easily accessible here.
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
            if (this.conduit.isConnected) {
                const result = await this.conduit.wsRead(path);
                if (result.error) throw new Error(result.error);
                // content is already base64 decoded in conduit-client if using wsRead? 
                // Wait, conduit-client.mjs wsRead doesn't decode, but REST read does.
                // Looking at conduit-client.mjs:95, it decodes REST response.
                // Let's check wsRead in conduit-client.mjs:233. It just sends 'read'.
                // The handler in conduit-client.mjs:141 should handle the response.
                
                // If the client doesn't decode WS messages, we do it here.
                if (result.data) {
                    return atob(result.data);
                }
                return result.content || "File is empty.";
            } else {
                return "Error: Conduit not connected. Use @file context to provide content.";
            }
        } catch (error) {
            return `Error reading file: ${error.message}`;
        }
    }

    /**
     * Searches for text across files (Grep).
     * @param {string} query 
     */
    async searchFiles(query) {
        // Conduit doesn't have a direct 'search' action in conduit-client.mjs
        // But we can use 'exec' if we have it, or implement a search action.
        // For now, let's assume we can run 'grep' via terminal.
        try {
            if (this.conduit.isConnected) {
                // We'll use a hypothetical search tool if available, or exec.
                // Since conduit-client.mjs doesn't have it, we might need to add it or use exec.
                return await this.execCommand(`grep -r "${query}" . | head -n 20`);
            }
            return "Error: Search requires Conduit connection.";
        } catch (error) {
            return `Error searching files: ${error.message}`;
        }
    }

    /**
     * Perfroms a surgical edit on a file.
     * @param {string} path 
     * @param {string} searchString 
     * @param {string} replacementString 
     * @param {string} sourceId - For backup tracking
     */
    async editFile(path, searchString, replacementString, sourceId) {
        try {
            const originalContent = await this.readFile(path);
            if (originalContent.startsWith("Error:")) throw new Error(originalContent);

            if (!originalContent.includes(searchString)) {
                throw new Error(`Target string not found in ${path}. Ensure the search string matches exactly, including whitespace.`);
            }

            const newContent = originalContent.replace(searchString, replacementString);
            
            // Create backup before writing
            await AgentBackup.create(path, originalContent, sourceId);

            if (this.conduit.isConnected) {
                const base64Content = btoa(newContent);
                const result = await this.conduit.wsWrite(path, base64Content);
                if (result.error) throw new Error(result.error);
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
            // Check if file exists to avoid accidental overwrite? 
            // AgentBackup.create(path, "", sourceId); // Backup as empty if new?
            
            if (this.conduit.isConnected) {
                const base64Content = btoa(content);
                const result = await this.conduit.wsWrite(path, base64Content);
                if (result.error) throw new Error(result.error);
                return `Successfully created ${path}.`;
            } else {
                return "Error: Conduit not connected.";
            }
        } catch (error) {
            return `Error creating file: ${error.message}`;
        }
    }

    /**
     * Executes a terminal command.
     */
    async execCommand(command) {
        // The current conduit-client.mjs doesn't have a direct 'exec' promise.
        // It mostly handles terminal via Xterm and the /terminal endpoint.
        // We'd need to implement a 'one-shot' exec or pipe through a terminal session.
        // For now, let's suggest it's not fully implemented or use a placeholder.
        return `Executing: ${command}\nOutput: (Terminal integration via Agent pending implementation of one-shot conduit exec)`;
    }
}

const agentTools = new AgentTools();
export default agentTools;
