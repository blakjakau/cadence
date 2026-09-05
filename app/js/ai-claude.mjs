// ai-claude.mjs
import AI from './ai.mjs';
import systemPrompt from "./claudeSystemPrompt.mjs";
import { tools as cadenceTools } from "./ai-manager-tools-schema.mjs";

// Fallback static list of common Claude models with their context window sizes.
// Used when the API endpoint is unavailable or fails.
const fallbackClaudeModels = [
    { value: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet (200k)", maxTokens: 200000 },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (200k)", maxTokens: 200000 },
    { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku (200k)", maxTokens: 200000 },
    { value: "claude-sonnet-4-20250514", label: "Claude 4 Sonnet (200k)", maxTokens: 200000 },
    { value: "claude-opus-4-1-20250805", label: "Claude 4.1 Opus (200k)", maxTokens: 200000 },
];

let claudeModels = [...fallbackClaudeModels]; // Start with fallback models

class Claude extends AI {
    constructor() {
        super();
        this.providerId = 'claude';
        this.config = {
            apiKey: "",
            model: "claude-3-5-sonnet-20241022", 
            server: "https://api.anthropic.com", 
            system: "",
            maxTurns: 50
        };
        // Default to the max tokens for the default model. This will be updated in init().
        this.MAX_CONTEXT_TOKENS = 200000;
        this.abortController = null;
        this.abortReason = "";

        this._settingsSchema = {
            apiKey: { type: "string", label: "Anthropic API Key", default: "" },
            server: { type: "string", label: "Anthropic API Server", default: "https://api.anthropic.com" },
            model: { 
                type: "enum", 
                label: "Model", 
                default: "claude-3-5-sonnet-20241022", 
                enum: claudeModels,
                lookupCallback: this._getAvailableModels.bind(this) 
            },
            maxTurns: { type: "number", label: "Max Agent Turns (0 for unlimited)", default: 50 }
        };
    }
    
    isConfigured() {
    	return this.config.apiKey !== "" && this.config.model !== "";
    }

    get supportsJSONTools() {
        return true;
    }

    get supportsReasoning() {
        const model = (this.config.model || "").toLowerCase();
        return model.includes('thinking') || model.includes('reasoning') || model.includes('3-7');
    }

    stop(reason = "User requested stop") {
        if (this.abortController) {
            this.abortReason = reason;
            this.abortController.abort(reason);
            this.abortController = null;
        }
    }

    async _getAvailableModels() {
        // Try to fetch models from the API, fall back to static list if it fails
        try {
            const response = await this._fetchWithRetry(`${this.config.server}/v1/models`, {
                method: 'GET',
                headers: {
                    'x-api-key': this.config.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
            }, { maxRetries: 2, initialDelayMs: 500 });

            if (response.ok) {
                const data = await response.json();
                if (data.data && Array.isArray(data.data)) {
                    // Transform API response to our format
                    const apiModels = data.data
                        .filter(model => model.id && model.id.startsWith('claude'))
                        .map(model => {
                            let maxTokens = 200000;
                            let label = model.id;
                            
                            if (model.display_name) {
                                label = model.display_name;
                            } else {
                                label = model.id
                                    .replace(/-/g, ' ')
                                    .replace(/\b\w/g, c => c.toUpperCase())
                                    .replace(/(\d+)/, ' $1');
                            }
                            
                            if (!label.includes('k')) {
                                label += ` (${maxTokens / 1000}k)`;
                            }
                            
                            return { value: model.id, label, maxTokens };
                        });
                    
                    claudeModels = apiModels.length > 0 ? apiModels : fallbackClaudeModels;
                    return apiModels;
                }
            }
        } catch (error) {
            console.log("[Claude] Could not fetch models from API, using fallback list:", error.message);
        }
        
        return fallbackClaudeModels;
    }
    
    async init() {
        await super.init(); 
        
        const selectedModelInfo = claudeModels.find(
            model => model.value === this.config.model
        );
        if (selectedModelInfo) {
            this.MAX_CONTEXT_TOKENS = selectedModelInfo.maxTokens;
        } else {
            const defaultModel = claudeModels.find(m => m.value === this._settingsSchema.model.default);
            this.MAX_CONTEXT_TOKENS = defaultModel?.maxTokens || 200000;
        }
    }
    
    get _apiUrl() {
        return `${this.config.server}/v1/messages`;
    }

    _getFormattedTools() {
        return cadenceTools.map(tool => ({
            name: tool.name,
            description: tool.description || "",
            input_schema: {
                type: "object",
                properties: tool.parameters?.properties || {},
                required: tool.parameters?.required || []
            }
        }));
    }

    // Transforms internal message format to Claude's format.
    // Handles text, file contexts, tool_use blocks, and tool_result blocks.
    _toClaudeMessages(messages) {
        const claudeMessages = [];

        // Build a map of tool_use id by tool name in recent turns
        let lastToolUseIdsByName = new Map();

        for (const msg of messages) {
            const isModel = (msg.role === 'model' || msg.role === 'assistant');
            const role = isModel ? 'assistant' : 'user';

            if (msg.type === 'file_context') {
                const fileContent = `--- File: ${msg.filename || msg.id} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\``;
                this._appendClaudeContentBlock(claudeMessages, 'user', { type: 'text', text: fileContent });
            } else if (msg.type === 'tool_response') {
                // If this is a tool response, format as tool_result if possible
                const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                
                // Extract matching tool name if present in standard header
                const match = contentStr.match(/\[Tool Response:\s*([a-zA-Z0-9_]+)/);
                const toolName = match ? match[1] : null;
                const toolUseId = (toolName && lastToolUseIdsByName.get(toolName)) || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

                this._appendClaudeContentBlock(claudeMessages, 'user', {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: contentStr
                });
            } else if (isModel) {
                const contentBlocks = [];
                if (msg.content && msg.content.trim()) {
                    contentBlocks.push({ type: 'text', text: msg.content.trim() });
                }

                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        const callObj = tc.functionCall || tc;
                        const toolName = callObj.name;
                        let argsObj = {};
                        try {
                            argsObj = typeof callObj.args === 'string' ? JSON.parse(callObj.args) : (callObj.args || callObj.arguments || {});
                        } catch (e) {
                            argsObj = {};
                        }
                        const toolUseId = tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
                        lastToolUseIdsByName.set(toolName, toolUseId);

                        contentBlocks.push({
                            type: 'tool_use',
                            id: toolUseId,
                            name: toolName,
                            input: argsObj
                        });
                    }
                }

                if (contentBlocks.length === 0) {
                    contentBlocks.push({ type: 'text', text: "..." });
                }

                for (const block of contentBlocks) {
                    this._appendClaudeContentBlock(claudeMessages, 'assistant', block);
                }
            } else if (role === 'user') {
                if (msg.content) {
                    this._appendClaudeContentBlock(claudeMessages, 'user', { type: 'text', text: msg.content });
                }
            }
        }

        // Ensure alternating user/assistant structure and non-empty content
        return claudeMessages.filter(m => m.content && m.content.length > 0);
    }

    _appendClaudeContentBlock(claudeMessages, targetRole, block) {
        if (claudeMessages.length > 0 && claudeMessages[claudeMessages.length - 1].role === targetRole) {
            claudeMessages[claudeMessages.length - 1].content.push(block);
        } else {
            claudeMessages.push({ role: targetRole, content: [block] });
        }
    }

    async _countTokens(messages) {
        return this.estimateTokens(messages);
    }

    async tokenize(content) {
        if (typeof content === 'string') {
            return this._countTokens([{ role: 'user', content }]);
        } else if (Array.isArray(content)) {
            return this._countTokens(content);
        }
        return null;
    }

    async _processApiResponseStream(reader, callbacks) {
        const { onUpdate, onError } = callbacks;
        let buffer = '';
        const decoder = new TextDecoder('utf-8');
        let fullResponseAccumulator = '';
        let currentToolCall = null;
        let isReasoning = false;
        let thinkingStartTime = 0;
        let totalThinkingMs = 0;
        callbacks.thought = callbacks.thought || "";
        callbacks.isThinking = false;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        const jsonString = line.substring(5).trim();
                        if (!jsonString) continue;
                        try {
                            const parsed = JSON.parse(jsonString);

                            // Handle content block start
                            if (parsed.type === 'content_block_start') {
                                const block = parsed.content_block;
                                if (block?.type === 'tool_use') {
                                    currentToolCall = {
                                        id: block.id,
                                        name: block.name,
                                        partial_json: ''
                                    };
                                } else if (block?.type === 'thinking') {
                                    isReasoning = true;
                                    callbacks.isThinking = true;
                                    thinkingStartTime = Date.now();
                                    if (onUpdate) onUpdate(fullResponseAccumulator, { thought: callbacks.thought, isThinking: true, toolCalls: callbacks.toolCalls });
                                }
                            }

                            // Handle content deltas
                            if (parsed.type === 'content_block_delta') {
                                const delta = parsed.delta;
                                if (delta?.type === 'text_delta') {
                                    fullResponseAccumulator += delta.text;
                                    if (onUpdate) onUpdate(fullResponseAccumulator, { thought: callbacks.thought, isThinking: callbacks.isThinking, toolCalls: callbacks.toolCalls });
                                } else if (delta?.type === 'thinking_delta') {
                                    callbacks.thought = (callbacks.thought || "") + delta.thinking;
                                    if (onUpdate) onUpdate(fullResponseAccumulator, { thought: callbacks.thought, isThinking: true, toolCalls: callbacks.toolCalls });
                                } else if (delta?.type === 'input_json_delta' && currentToolCall) {
                                    currentToolCall.partial_json += delta.partial_json;
                                    let argsObj = {};
                                    try {
                                        argsObj = JSON.parse(currentToolCall.partial_json);
                                    } catch (e) {
                                        argsObj = parseRelaxedJson(currentToolCall.partial_json);
                                    }
                                    if (!callbacks.toolCalls) callbacks.toolCalls = [];
                                    const existingIdx = callbacks.toolCalls.findIndex(tc => tc.id === currentToolCall.id);
                                    const toolEntry = {
                                        id: currentToolCall.id,
                                        name: currentToolCall.name,
                                        args: argsObj,
                                        functionCall: {
                                            name: currentToolCall.name,
                                            args: argsObj
                                        }
                                    };
                                    if (existingIdx >= 0) {
                                        callbacks.toolCalls[existingIdx] = toolEntry;
                                    } else {
                                        callbacks.toolCalls.push(toolEntry);
                                    }
                                    if (onUpdate) onUpdate(fullResponseAccumulator, { thought: callbacks.thought, isThinking: callbacks.isThinking, toolCalls: callbacks.toolCalls });
                                }
                            }

                            // Handle content block stop
                            if (parsed.type === 'content_block_stop') {
                                if (isReasoning) {
                                    isReasoning = false;
                                    callbacks.isThinking = false;
                                    if (thinkingStartTime) {
                                        totalThinkingMs += (Date.now() - thinkingStartTime);
                                        callbacks.totalThinkingMs = totalThinkingMs;
                                    }
                                    if (onUpdate) onUpdate(fullResponseAccumulator, { thought: callbacks.thought, isThinking: false, toolCalls: callbacks.toolCalls });
                                }

                                if (currentToolCall) {
                                    let argsObj = {};
                                    try {
                                        argsObj = currentToolCall.partial_json ? JSON.parse(currentToolCall.partial_json) : {};
                                    } catch (e) {
                                        argsObj = parseRelaxedJson(currentToolCall.partial_json);
                                    }

                                    if (!callbacks.toolCalls) callbacks.toolCalls = [];
                                    const existingIdx = callbacks.toolCalls.findIndex(tc => tc.id === currentToolCall.id);
                                    const toolEntry = {
                                        id: currentToolCall.id,
                                        name: currentToolCall.name,
                                        args: argsObj,
                                        functionCall: {
                                            name: currentToolCall.name,
                                            args: argsObj
                                        }
                                    };
                                    if (existingIdx >= 0) {
                                        callbacks.toolCalls[existingIdx] = toolEntry;
                                    } else {
                                        callbacks.toolCalls.push(toolEntry);
                                    }

                                    currentToolCall = null;
                                }
                            }
                        } catch (e) {
                            console.warn("[Claude] Failed to parse stream JSON object:", jsonString, e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("[Claude] Error processing API response stream:", error);
            if (onError) onError(error);
            throw error;
        }

        return fullResponseAccumulator;
    }

    async generate(prompt, callbacks = {}) {
        const messages = [{ role: "user", type: "user", content: prompt }];
        return this.chat(messages, callbacks);
    }
    
    async chat(messages, callbacks = {}, systemPrompt = null, session = null) {
        const { onStart, onError, onDone, onContextRatioUpdate } = callbacks;
        if (onStart) onStart();

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const claudeMessages = this._toClaudeMessages(messages);
            
            const requestBody = {
                model: this.config.model,
                messages: claudeMessages,
                stream: true,
                max_tokens: 4096,
                tools: this._getFormattedTools()
            };

            if (session && session.temperatureOverride !== undefined) {
                requestBody.temperature = session.temperatureOverride;
            } else if (this.config.temperature !== undefined) {
                requestBody.temperature = this.config.temperature;
            }

            if (systemPrompt) {
            	requestBody.system = systemPrompt;
            } else if (this.config.system) {
                requestBody.system = this.config.system;
            }

            const currentTokens = await this._countTokens(messages);
            const contextRatio = currentTokens / this.MAX_CONTEXT_TOKENS;

            if (onContextRatioUpdate) {
                onContextRatioUpdate(contextRatio);
            }

            const requestStartTime = Date.now();
            const response = await this._fetchWithRetry(this._apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.config.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify(requestBody),
            }, {
                maxRetries: 3,
                initialDelayMs: 1000,
                signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                const httpError = new Error(`HTTP error! Status: ${response.status}, Message: ${errorText}`);
                if (onError) onError(httpError);
                return;
            }

            const reader = response.body.getReader();
            const fullResponse = await this._processApiResponseStream(reader, callbacks);
            const requestEndTime = Date.now();
            
            messages.push({ role: "model", content: fullResponse });

            const finalTokens = await this._countTokens(messages);
            const outputTokens = Math.max(0, finalTokens - currentTokens);
            const finalContextRatio = finalTokens / this.MAX_CONTEXT_TOKENS;
            if (onContextRatioUpdate) {
                onContextRatioUpdate(finalContextRatio);
            }

            this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, 0);

            if (onDone) {
                onDone(fullResponse, Math.round(finalContextRatio * 100));
            }

        } catch (error) {
            if (error.name === "AbortError" || signal.aborted) {
                console.debug("[Claude] Chat aborted by user/system:", this.abortReason);
                return;
            }
            console.error("[Claude] Error in chat:", error);
            if (onError) onError(error);
        } finally {
            this.abortController = null;
        }
    }
    
    async setOptions(newSettings, onErrorCallback, onSuccessCallback, useWorkspaceSettings, source = 'global') {
	    let changesApplied = false;
        let modelChanged = false;
	    for (const key in newSettings) {
	        if (newSettings.hasOwnProperty(key)) {
	            if (this.config[key] !== newSettings[key]) {
	                this.config[key] = newSettings[key];
	                changesApplied = true;
                    if (key === 'model') modelChanged = true;
	            }
	        }
	    }
	
        if (modelChanged) {
            const selectedModelInfo = claudeModels.find(
                model => model.value === this.config.model
            );
            if (selectedModelInfo) {
                this.MAX_CONTEXT_TOKENS = selectedModelInfo.maxTokens;
            }
        }
	
	    if (changesApplied) {
	    	if ("function" == typeof onSuccessCallback) {
	        	onSuccessCallback("Settings saved successfully.");
	    	}
	        const event = new CustomEvent('setting-changed', {
	            detail: {
	                settingsName: 'claudeConfig', 
	                settings: { ...this.config }, 
	                useWorkspaceSettings: useWorkspaceSettings,
	                source: this._settingsSource
	            }
	        });
	        window.dispatchEvent(event);
	    }
    }

    clearContext() {
        console.log("Claude internal context cleared (AIManager manages chat history).");
    }

    async refreshModels() {
        const freshModels = await this._getAvailableModels();
        if (freshModels && freshModels.length > 0) {
            claudeModels = freshModels;
            this._settingsSchema.model.enum = freshModels;
        }
    }
}

function parseRelaxedJson(str) {
    if (!str) return {};
    let cleaned = str.replace(/<\|"\|>/g, '"');
    try {
        return JSON.parse(cleaned);
    } catch (e) {}

    try {
        const fn = new Function(`return (${cleaned});`);
        return fn();
    } catch (e) {}

    const obj = {};
    const pairRegex = /"([a-zA-Z0-9_-]+)"\s*:\s*(?:"((?:\\.|[^"\\])*)"|([0-9\.-]+|true|false|null))/g;
    let match;
    const matchedKeys = new Set();
    while ((match = pairRegex.exec(cleaned)) !== null) {
        const key = match[1];
        matchedKeys.add(key);
        if (match[2] !== undefined) {
            try {
                obj[key] = JSON.parse(`"${match[2]}"`);
            } catch (e) {
                obj[key] = match[2];
            }
        } else if (match[3] !== undefined) {
            try {
                obj[key] = JSON.parse(match[3]);
            } catch (e) {
                obj[key] = match[3];
            }
        }
    }

    // Capture unclosed string values (e.g. "replace": "some streamed text without closing quote)
    const unclosedPairRegex = /"([a-zA-Z0-9_-]+)"\s*:\s*"((?:\\.|[^"\\])*)$/g;
    let unclosedMatch;
    // Check everywhere after known matches or at end of text
    const tailText = cleaned.substring(pairRegex.lastIndex || 0);
    const unclosedTailMatch = tailText.match(/"([a-zA-Z0-9_-]+)"\s*:\s*"((?:\\.|[^"\\])*)$/);
    if (unclosedTailMatch) {
        const key = unclosedTailMatch[1];
        let rawVal = unclosedTailMatch[2];
        try {
            rawVal = JSON.parse(`"${rawVal.replace(/\\$/,'')}"`);
        } catch (e) {
            rawVal = rawVal
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
        obj[key] = rawVal;
    }

    // Handle "edits": [ ... ] array for edit_file if present
    if (cleaned.includes('"edits"')) {
        const editsMatch = cleaned.match(/"edits"\s*:\s*\[([\s\S]*)/);
        if (editsMatch) {
            const items = [];
            const objRegex = /\{([^{}]*)\}/g;
            let om;
            while ((om = objRegex.exec(editsMatch[1])) !== null) {
                const sub = parseRelaxedJson(`{${om[1]}}`);
                if (sub && Object.keys(sub).length > 0) {
                    items.push(sub);
                }
            }
            // Capture unclosed trailing edit object in the edits array
            const trailingEditsText = editsMatch[1].substring(objRegex.lastIndex);
            const unclosedObjMatch = trailingEditsText.match(/\{([^{}]*)$/);
            if (unclosedObjMatch) {
                const sub = parseRelaxedJson(`{${unclosedObjMatch[1]}}`);
                if (sub && Object.keys(sub).length > 0) {
                    items.push(sub);
                }
            }
            if (items.length > 0) {
                obj.edits = items;
            }
        }
    }

    return obj;
}

export default Claude;
