import AgentTools from './agent-tools.mjs';
import aiManager from '../ai-manager.mjs';

/**
 * Manages the agentic conversation loop and tool handling.
 * Operates independently of the main AI chat but uses the same provider settings.
 */
class AgenticManager {
    constructor() {
        this.history = [];
        this.isProcessing = false;
        this.planOnly = true; // Toggle for Planning vs Action
        this.onUpdate = null; // Callback for UI updates
        
        // Tool Definitions (Gemini format)
        this.toolDefinitions = [
            {
                name: "list_files",
                description: "List files and directories in a given path.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: { type: "STRING", description: "The directory path to list. Defaults to '.'" }
                    }
                }
            },
            {
                name: "read_file",
                description: "Read the full content of a file.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: { type: "STRING", description: "The path of the file to read." }
                    },
                    required: ["path"]
                }
            },
            {
                name: "search_files",
                description: "Search for a query across projects files (Grep).",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        query: { type: "STRING", description: "The search term or regex." }
                    },
                    required: ["query"]
                }
            },
            {
                name: "edit_file",
                description: "Surgically edit a file by replacing a specific search string with a replacement string.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: { type: "STRING", description: "The path of the file to edit." },
                        search: { type: "STRING", description: "The exact string to find in the file." },
                        replace: { type: "STRING", description: "The replacement content." }
                    },
                    required: ["path", "search", "replace"]
                }
            },
            {
                name: "create_file",
                description: "Create a new file with the specified content.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: { type: "STRING", description: "The path of the new file." },
                        content: { type: "STRING", description: "The initial content." }
                    },
                    required: ["path", "content"]
                }
            },
            {
                name: "exec_command",
                description: "Execute a terminal command via Conduit.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        command: { type: "STRING", description: "The terminal command to run." }
                    },
                    required: ["command"]
                }
            }
        ];
    }

    async submit(prompt) {
        if (this.isProcessing) return;
        this.isProcessing = true;
        
        // Add user message to history
        this.history.push({ role: "user", content: prompt });
        if (this.onUpdate) this.onUpdate();

        try {
            await this._runLoop();
        } catch (error) {
            console.error("[AgenticManager] Loop error:", error);
            this.history.push({ role: "system_message", content: `Error: ${error.message}` });
        } finally {
            this.isProcessing = false;
            if (this.onUpdate) this.onUpdate();
        }
    }
    async _runLoop() {
        const ai = aiManager.ai;
        if (!ai) throw new Error("AI provider not initialized.");
        const currentMode = this.planOnly ? 'PLANNING' : 'ACTION';
        const systemPrompt = `You are CodeAgent, a precise coding assistant. 
You use tools to explore and modify code. 
Current project context: ${this._getProjectSummary()}
Currently in ${currentMode} mode.
${this.planOnly ? "Explain your plan in detail but do NOT call any tools yet." : "You may call tools to execute your plan."}`;
        let loopActive = true;
        while (loopActive) {
            const callbacks = {
                tools: this.toolDefinitions,
                onUpdate: () => this.onUpdate?.()
            };
            const response = await ai.chat(this.history, callbacks, systemPrompt);

            // 1. Handle undefined/null response
            if (!response) {
                throw new Error("AI Provider returned undefined. Ensure ai.chat() returns { text, toolCalls } or a string.");
            }

            // 2. Handle raw string response (some providers return text directly)
            if (typeof response === 'string') {
                this.history.push({ role: "model", content: response });
                if (this.onUpdate) this.onUpdate();
                loopActive = false;
                continue;
            }

            // 3. Handle object response { text, toolCalls }
            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const call of response.toolCalls) {
                    // Record the model's intent
                    this.history.push({ role: "model", tool_calls: call.tool_calls });
                    if (this.onUpdate) this.onUpdate();
                    
                    // Execute tool
                    const result = await AgentTools.execute(call.name, call.args);
                    
                    // Record the result
                    this.history.push({ role: "tool", name: call.name, content: JSON.stringify(result) });
                    if (this.onUpdate) this.onUpdate();
                }
            } else {
                // Final response (no more tools)
                this.history.push({ role: "model", content: response.text || "" });
                if (this.onUpdate) this.onUpdate();
                loopActive = false;
            }
        }
    }

    _getProjectSummary() {
        return "Workspace loaded via Conduit.";
    }

    clearHistory() {
        this.history = [];
        if (this.onUpdate) this.onUpdate();
    }
}

const agenticManager = new AgenticManager();
export default agenticManager;
