import AgentTools from './agent-tools.mjs';
import aiManager from '../ai-manager.mjs';

/**
 * Manages the agentic conversation loop and tool handling.
 * Operates independently of the main AI chat but uses the same provider settings.
 */
class AgenticManager {
    constructor() {
        this.history = [];
        this.editBuffer = [];
        this.isProcessing = false;
        this.isInterrupted = false;
        this.planOnly = true; // Toggle for Planning vs Action
        this.onUpdate = null; // Callback for UI updates
        this.onConsentRequired = null; // Callback for UI consent prompt
        
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
            },
            {
                name: "find_file",
                description: "Find files matching a specific path using progressive segment/atom matching.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        path: { type: "STRING", description: "The file path or partial path to locate." }
                    },
                    required: ["path"]
                }
            }
        ];
    }

    async submit(prompt) {
        if (this.isProcessing) {
            // If already processing, a new prompt acts as an interruption
            this.isInterrupted = true;
            return;
        }
        this.isProcessing = true;
        this.isInterrupted = false;
        
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
            this.isInterrupted = false;
            if (this.onUpdate) this.onUpdate();
        }
    }

    stop() {
        this.isInterrupted = true;
    }

    async _requestConsent() {
        if (this.onConsentRequired) {
            return await this.onConsentRequired();
        }
        return true;
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
        let iterationCount = 0;
        while (loopActive) {
            // 1. Check for interruptions
            if (this.isInterrupted) {
                console.log("[AgenticManager] Loop interrupted.");
                loopActive = false;
                break;
            }

            // 2. Heartbeat/Consent check every 10 iterations
            iterationCount++;
            if (iterationCount > 0 && iterationCount % 10 === 0) {
                console.log(`[AgenticManager] Heartbeat: ${iterationCount} iterations reached. Requesting consent...`);
                const consent = await this._requestConsent(iterationCount);
                if (!consent) {
                    console.log("[AgenticManager] Consent denied by user.");
                    loopActive = false;
                    break;
                }
            }

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
                    
                    // Execute tool (with buffering for edits)
                    let result;
                    if (call.name === 'edit_file') {
                        this.editBuffer.push(call.args);
                        result = { status: "staged", message: `Edit staged. Total pending: ${this.editBuffer.length}`, pending: this.editBuffer };
                    } else {
                        result = await AgentTools.execute(call.name, call.args);
                    }
                    
                    // Record the result
                    this.history.push({ role: "tool", name: call.name, content: JSON.stringify(result) });
                    if (this.onUpdate) this.onUpdate();
                }
            } else {
                // Final response (no more tools) or a Plan
                const text = response.text || "";
                this.history.push({ role: "model", content: text });
                if (this.onUpdate) this.onUpdate();

                if (this.planOnly) {
                    console.log("[AgenticManager] Plan received. Requesting consent to proceed to action mode.");
                    const consent = await this._requestConsent();
                    if (consent) {
                        console.log("[AgenticManager] Consent granted. Switching to ACTION mode.");
                        this.planOnly = false;
                        loopActive = true; // Continue loop in ACTION mode
                    } else {
                        console.log("[AgenticManager] Consent denied. Stopping after plan.");
                        loopActive = false;
                    }
                } else {
                    loopActive = false;
                }
            }
        }
    }

    _getProjectSummary() {
        return "Workspace loaded via Conduit.";
    }

    async commitEdits() {
        for (const args of this.editBuffer) {
            await AgentTools.execute('edit_file', args);
        }
        const count = this.editBuffer.length;
        this.editBuffer = [];
        if (this.onUpdate) this.onUpdate();
        return `Applied ${count} edits.`;
    }

    clearHistory() {
        this.history = [];
        this.editBuffer = [];
        if (this.onUpdate) this.onUpdate();
    }
}

const agenticManager = new AgenticManager();
export default agenticManager;
