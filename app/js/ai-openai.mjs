// ai-openai.mjs
import AI from './ai.mjs';
import systemPrompt from "./openaiSystemPrompt.mjs";
import { getToolsForSession } from "./ai-manager-tools-schema.mjs";
import { getCapability, applyReasoningToBody, PROBE_PRESETS } from "./ai-probe.mjs";

function sanitizeSurrogates(str) {
    if (typeof str !== 'string') return str;
    if (typeof str.toWellFormed === 'function') {
        return str.toWellFormed();
    }
    return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

class OpenAI extends AI {
    constructor() {
        super();
        this.providerId = 'openai';
        this.config = {
            apiKey: "",
            server: "https://api.openai.com/v1",
            model: "",
            system: "",
            temperature: 0.7,
            top_p: 1.0,
            top_k: 0,
            maxTokens: 4096,
            thinkingLevel: "medium",
            maxTurns: 0,
            stripCodeBlocksFromContext: false
        };
        this.MAX_CONTEXT_TOKENS = 128000;

        this._settingsSchema = {
            apiKey: { type: "string", label: "API Key", default: "" },
            server: { type: "string", label: "API Server", default: "https://api.openai.com/v1" },
            model: {
                type: "string",
                label: "Model",
                default: "",
                lookupCallback: this._getAvailableModels.bind(this)
            },
            temperature: { type: "number", label: "Temperature", default: 0.7 },
            top_p: { type: "number", label: "Top P", default: 1.0 },
            top_k: { type: "number", label: "Top K", default: 0 },
            maxTokens: { type: "number", label: "Max Tokens (per response)", default: 4096 },
            thinkingLevel: {
                type: "enum",
                label: "Thinking Level",
                default: "medium",
                enum: [
                    { value: "off", label: "Off" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "unlimited", label: "Unlimited" }
                ]
            },
            maxTurns: { type: "number", label: "Max Agent Turns (0 for unlimited)", default: 0 }
        };
    }

    stop(reason) {
        if (this.abortController) {
            this.abortReason = reason;
            this.abortController.abort(reason);
            this.abortController = null;
        }
    }

    isConfigured() {
        return this.config.apiKey !== "" && this.config.model !== "";
    }

    get supportsJSONTools() {
        return true;
    }

    get supportsReasoning() {
        const model = (this.config.model || "").toLowerCase();
        return model.includes('o1')
            || model.includes('o3')
            || model.includes('r1')
            || model.includes('deepseek')
            || model.includes('reasoning')
            || model.includes('think')
            || model.includes('qwen');
    }

    get supportsParallelTools() {
        return true;
    }

    async init() {
        await super.init();
        await this._getAvailableModels();
    }

    async _getAvailableModels(options = {}) {
        const { strict = false } = options;
        const fallbackModels = [
            { value: "gpt-4o", label: "GPT-4o", maxTokens: 128000 },
            { value: "gpt-4o-mini", label: "GPT-4o mini", maxTokens: 128000 },
            { value: "gpt-4.1-mini", label: "GPT-4.1 mini", maxTokens: 1000000 },
            { value: "o3-mini", label: "o3-mini", maxTokens: 200000 },
            { value: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek Chat V3-0324 (via OpenRouter)", maxTokens: 64000 }
        ];

        if (!this.config.apiKey) {
            if (strict) throw new Error("API Key is required");
            console.warn("[OpenAI] API Key not set. Using fallback models.");
            this._settingsSchema.model.enum = fallbackModels;
            return fallbackModels;
        }

        const modelsUrl = `${this.config.server.replace(/\/$/, "")}/models`;

        try {
            console.log(`[OpenAI] Fetching models from: ${modelsUrl}`);
            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                if (strict) throw new Error(`Authentication failed (HTTP ${response.status}: ${response.statusText})`);
                console.warn(`[OpenAI] Failed to fetch models (Status: ${response.status}). Using fallback models. Response:`, response.statusText);
                this._settingsSchema.model.enum = fallbackModels;
                return fallbackModels;
            }

            const data = await response.json();

            if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
                if (strict) throw new Error("No models returned by API");
                console.warn("[OpenAI] API returned unexpected data format. Using fallback models.", data);
                this._settingsSchema.model.enum = fallbackModels;
                return fallbackModels;
            }

            const models = data.data
                .filter(model => model.id && typeof model.id === 'string')
                .map(model => ({
                    value: model.id,
                    label: model.id,
                    maxTokens: 0
                }));

            if (models.length === 0) {
                if (strict) throw new Error("No usable models returned by API");
                this._settingsSchema.model.enum = fallbackModels;
                return fallbackModels;
            }

            this._settingsSchema.model.enum = models;
            return models;

        } catch (error) {
            if (strict) {
                if (error && error.message && error.message.startsWith("Authentication failed")) {
                    throw error;
                }
                if (error && error.message && error.message.startsWith("No")) {
                    throw error;
                }
                throw new Error(`Failed to connect: ${error.message || error}`);
            }
            console.error("[OpenAI] Error fetching models:", error);
            this._settingsSchema.model.enum = fallbackModels;
            return fallbackModels;
        }
    }

    _formatChatMessages(messages, systemPromptOverride = null) {
        const formattedMessages = [];
        const activeSystemPrompt = systemPromptOverride || this.config.system || systemPrompt;

        if (activeSystemPrompt) {
            const stripped = this.config.stripCodeBlocksFromContext ?? false;
            const sysContent = stripped ? this._stripCodeBlocks(activeSystemPrompt) : activeSystemPrompt;
            formattedMessages.push({ role: "system", content: sanitizeSurrogates(sysContent) });
        }

        let lastAssistantToolCalls = null;

        for (const msg of messages) {
            if (msg.type === 'file_context') {
                const fileContent = `--- File: ${msg.filename || msg.id} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\``;
                formattedMessages.push({
                    role: "user",
                    content: sanitizeSurrogates(this.config.stripCodeBlocksFromContext ? this._stripCodeBlocks(fileContent) : fileContent)
                });
            } else if (msg.role === 'model') {
                let toolCalls = msg.toolCalls || [];

                // Self-healing: parse XML <tool_call> tags from content if no explicit tool calls saved
                if (toolCalls.length === 0 && msg.content && msg.content.includes('<tool_call')) {
                    const parsedCalls = [];
                    const tcRegex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
                    let tcMatch;
                    while ((tcMatch = tcRegex.exec(msg.content)) !== null) {
                        const name = tcMatch[1];
                        const innerArgs = tcMatch[2];
                        const args = {};

                        const argRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
                        let argMatch;
                        while ((argMatch = argRegex.exec(innerArgs)) !== null) {
                            args[argMatch[1]] = argMatch[2].trim();
                        }

                        parsedCalls.push({
                            id: `call_${crypto.randomUUID()}`,
                            functionCall: { name, args }
                        });
                    }
                    toolCalls = parsedCalls;
                }

                if (toolCalls.length > 0) {
                    lastAssistantToolCalls = toolCalls;

                    let textPart = msg.content || '';
                    const toolCallIdx = textPart.indexOf('<tool_call');
                    if (toolCallIdx !== -1) {
                        textPart = textPart.substring(0, toolCallIdx).trim();
                    }
                    textPart = textPart.replace(/<tool_call[\s\S]*?<\/tool_call>/g, '').trim();

                    const validToolCalls = (Array.isArray(toolCalls) ? toolCalls : []).filter(tc => tc && typeof tc === 'object');
                    formattedMessages.push({
                        role: "assistant",
                        content: textPart ? sanitizeSurrogates(textPart) : null,
                        tool_calls: validToolCalls.map(tc => {
                            const name = tc?.functionCall?.name || tc?.function?.name || tc?.name || "";
                            const rawArgs = tc?.functionCall?.args || tc?.functionCall?.arguments || tc?.function?.arguments || tc?.arguments || tc?.args || {};
                            const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
                            return {
                                id: tc?.id || `call_${crypto.randomUUID()}`,
                                type: "function",
                                function: {
                                    name,
                                    arguments: sanitizeSurrogates(argsStr)
                                }
                            };
                        })
                    });
                } else {
                    formattedMessages.push({ role: "assistant", content: sanitizeSurrogates(msg.content) });
                }
            } else if (msg.type === 'tool_response') {
                const parts = msg.content.split(/\n\n---\n\n/);
                for (const part of parts) {
                    const match = part.match(/\[Tool Response: ([^\]]+)\]\n\n([\s\S]*)/);
                    if (match) {
                        const toolName = match[1].split(' ')[0];
                        const toolResponse = match[2];

                        let toolCallId = `call_${crypto.randomUUID()}`;
                        if (lastAssistantToolCalls) {
                            const found = lastAssistantToolCalls.find(tc => (tc.functionCall?.name || tc.function?.name || tc.name) === toolName);
                            if (found && found.id) {
                                toolCallId = found.id;
                            }
                        }

                        formattedMessages.push({
                            role: "tool",
                            tool_call_id: toolCallId,
                            name: toolName,
                            content: sanitizeSurrogates(toolResponse)
                        });
                    } else {
                        formattedMessages.push({ role: "user", content: sanitizeSurrogates(part) });
                    }
                }
            } else if (msg.type === 'error' || msg.type === 'system_message') {
                // Do not send error/system_messages to the AI
            } else {
                formattedMessages.push({ role: "user", content: sanitizeSurrogates(msg.content) });
            }
        }

        return formattedMessages;
    }

    _stripCodeBlocks(text) {
        if (!text) return text;
        return text.replace(/```[\s\S]*?```/g, '""');
    }

    async tokenize(content) {
        return this.estimateTokens(content);
    }

    async generate(prompt, callbacks = {}) {
        const messages = [{ role: "user", content: prompt }];
        return this.chat(messages, callbacks, null, { noTools: true });
    }

    async chat(messages, callbacks = {}, systemPromptOverride = null, session = null) {
        const { onStart, onUpdate, onDone, onError, onContextRatioUpdate } = callbacks;
        if (onStart) onStart();

        try {
            const formattedMessages = this._formatChatMessages(messages, systemPromptOverride);

            const requestBody = {
                messages: formattedMessages,
                model: this.config.model,
                stream: true,
                max_tokens: this.config.maxTokens || 4096,
                temperature: (session && session.temperatureOverride !== undefined) ? session.temperatureOverride : this.config.temperature,
                top_p: this.config.top_p,
                tool_choice: "auto"
            };

            const sessionLevel = session?.thinkingLevel;
            const level = (sessionLevel && sessionLevel !== 'auto') ? sessionLevel : (this.config.thinkingLevel || "medium");

            const cap = getCapability(this.connectionId, this.config.model, { server: this.config.server });
            if (cap) {
                const tempState = cap.params?.temperature?.state;
                const topPState = cap.params?.top_p?.state;
                const topKState = cap.params?.top_k?.state;
                if (tempState === 'locked') delete requestBody.temperature;
                if (topPState === 'locked') delete requestBody.top_p;
                if (cap.preset && PROBE_PRESETS[cap.preset]) {
                    const presetParams = PROBE_PRESETS[cap.preset];
                    if (tempState !== 'locked') requestBody.temperature = presetParams.temperature;
                    if (topPState !== 'locked') requestBody.top_p = presetParams.top_p;
                }
                const capLevel = (cap.preset && PROBE_PRESETS[cap.preset] && !sessionLevel) ? PROBE_PRESETS[cap.preset].thinkingLevel : level;
                applyReasoningToBody(requestBody, cap.reasoning, capLevel);
            }

            if (this.config.top_k > 0) {
                const topKState = cap?.params?.top_k?.state;
                if (topKState !== 'locked') {
                    requestBody.top_k = this.config.top_k;
                }
            }

            const modelName = (this.config.model || "").toLowerCase();
            const isReasoningModel = this.supportsReasoning;
            if (!cap && isReasoningModel && (modelName.includes('o1') || modelName.includes('o3'))) {
                if (level === 'low' || level === 'medium' || level === 'high') {
                    requestBody.reasoning_effort = level;
                }
            }

            const isAgent = session ? (session.agentMode ?? window.ui?.aiManager?.agentMode) : window.ui?.aiManager?.agentMode;
            if (!(session && session.noTools) && (isAgent || (session && session.parentId))) {
                const isSubAgent = !!(session && session.parentId);
                let filteredTools = getToolsForSession(isSubAgent, this.supportsJSONTools);
                if (!isSubAgent) {
                    const isPlanning = session ? (session.planningMode ?? window.ui?.aiManager?.planningMode === true) : (window.ui?.aiManager?.planningMode === true);
                    filteredTools = filteredTools.filter(t => {
                        if (isPlanning && (t.name === "create_file" || t.name === "edit_file")) return false;
                        if (session && session.allowSubAgents === false && t.name === "create_sub_agent") return false;
                        if (session && session.allowRunCommand === false && (t.name === "run_command" || t.name === "exec_command")) return false;
                        return true;
                    });
                }
                if (filteredTools.length > 0) {
                    requestBody.tools = filteredTools.map(t => ({
                        type: "function",
                        function: {
                            name: t.name,
                            description: t.description,
                            parameters: t.parameters
                        }
                    }));
                }
            }

            const currentTokens = this.estimateTokens(messages);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(currentTokens / this.MAX_CONTEXT_TOKENS);
            }

            this.abortController = new AbortController();

            const requestStartTime = Date.now();
            const response = await fetch(`${this.config.server.replace(/\/$/, "")}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! Status: ${response.status}, Message: ${errorText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullResponse = '';
            let buffer = '';
            let isReasoning = false;
            let thinkingStartTime = 0;
            let totalThinkingMs = 0;
            const streamedToolCalls = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.substring(6).trim();
                    if (!jsonStr) continue;
                    if (jsonStr === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.choices && parsed.choices.length > 0 && parsed.choices[0].delta) {
                            const delta = parsed.choices[0].delta;
                            let chunkUpdate = '';

                            if (typeof delta.reasoning_content === 'string') {
                                let reasoningPart = delta.reasoning_content;

                                if (!isReasoning) {
                                    isReasoning = true;
                                    callbacks.isThinking = true;
                                    callbacks.thought = callbacks.thought || "";
                                    thinkingStartTime = Date.now();
                                }
                                callbacks.thought += reasoningPart;
                                if (onUpdate) onUpdate(fullResponse, { thought: callbacks.thought, isThinking: true, toolCalls: callbacks.toolCalls });
                            }

                            if (typeof delta.content === 'string') {
                                if (isReasoning) {
                                    isReasoning = false;
                                    callbacks.isThinking = false;
                                    totalThinkingMs += Date.now() - thinkingStartTime;
                                }
                                chunkUpdate += delta.content;
                            }

                            if (delta.tool_calls || ('tool_calls' in delta)) {
                                if (isReasoning) {
                                    isReasoning = false;
                                    callbacks.isThinking = false;
                                    totalThinkingMs += Date.now() - thinkingStartTime;
                                }

                                callbacks.totalThinkingMs = totalThinkingMs;
                                if (chunkUpdate) {
                                    fullResponse += chunkUpdate;
                                    chunkUpdate = '';
                                    if (onUpdate) onUpdate(fullResponse, { thought: callbacks.thought, isThinking: callbacks.isThinking, toolCalls: callbacks.toolCalls });
                                }

                                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                                    try {
                                        if (!callbacks.toolCalls) callbacks.toolCalls = [];
                                        for (const call of delta.tool_calls) {
                                            if (!call) continue;
                                            const idx = call.index !== undefined ? call.index : 0;
                                            if (!streamedToolCalls[idx]) {
                                                streamedToolCalls[idx] = {
                                                    id: call.id || "",
                                                    name: call.function?.name || "",
                                                    arguments: ""
                                                };
                                            }
                                            if (call.id) streamedToolCalls[idx].id = call.id;
                                            if (call.function?.name) streamedToolCalls[idx].name = call.function.name;
                                            if (call.function?.arguments) streamedToolCalls[idx].arguments += call.function.arguments;
                                        }

                                        callbacks.toolCalls = [];
                                        for (const tc of streamedToolCalls) {
                                            if (!tc || !tc.name) continue;
                                            let parsedArgs = {};
                                            try {
                                                parsedArgs = JSON.parse(tc.arguments);
                                            } catch (e) {
                                                parsedArgs = parseRelaxedJson(tc.arguments);
                                            }
                                            callbacks.toolCalls.push({
                                                id: tc.id || `call_${crypto.randomUUID()}`,
                                                functionCall: {
                                                    name: tc.name,
                                                    args: parsedArgs
                                                }
                                            });
                                        }
                                    } catch (err) {
                                        console.warn("[OpenAI] Error parsing streamed tool calls:", err);
                                    }
                                }
                            }

                            if (chunkUpdate || delta.tool_calls) {
                                fullResponse += chunkUpdate;

                                // Loose tool call protection in content tokens
                                const looseToolCallRegex = /<tool_call[\s\S]*?>|<\|tool[\s\S]*?>|<\|im_start\|>call:/gi;
                                let looseToolCallCount = 0;
                                let match;
                                while ((match = looseToolCallRegex.exec(fullResponse)) !== null) {
                                    looseToolCallCount++;
                                    console.warn(`[OpenAI] Loose tool call hit #${looseToolCallCount} detected in text: ${match[0]}`);

                                    fullResponse = fullResponse.substring(0, match.index) + fullResponse.substring(match.index + match[0].length);
                                    looseToolCallRegex.lastIndex = 0;

                                    if (looseToolCallCount > 3) {
                                        this.stop("Too many redundant/loose tool calls generated in text stream.");
                                        break;
                                    }
                                }

                                if (onUpdate) onUpdate(fullResponse, { thought: callbacks.thought, isThinking: callbacks.isThinking, toolCalls: callbacks.toolCalls });
                            }
                        }
                    } catch (e) {
                        // Ignore malformed stream chunks
                    }
                }
            }

            if (isReasoning) {
                isReasoning = false;
                callbacks.isThinking = false;
                totalThinkingMs += Date.now() - thinkingStartTime;
                callbacks.totalThinkingMs = totalThinkingMs;
            }

            const requestEndTime = Date.now();
            const finalTokens = this.estimateTokens([...messages, { role: 'model', content: fullResponse }]);
            const outputTokens = Math.max(0, finalTokens - currentTokens);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(finalTokens / this.MAX_CONTEXT_TOKENS);
            }

            this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, Math.round(totalThinkingMs / 1000));
            callbacks.totalThinkingMs = totalThinkingMs;

            if (onDone) onDone(fullResponse, Math.round((finalTokens / this.MAX_CONTEXT_TOKENS) * 100));

        } catch (error) {
            if (error && error.name === 'AbortError') {
                const reasonStr = this.abortReason ? `: ${this.abortReason}` : " by Cadence Agent Protocol.";
                console.info(`⏸️ [OpenAI] Stream generation intentionally halted${reasonStr}`);
                this.abortReason = null;
            } else if (typeof error === 'string') {
                console.info(`⏸️ [OpenAI] Stream generation intentionally halted: ${error}`);
            } else {
                console.error("[OpenAI] Chat error:", error);
                if (onError) onError(error);
            }
        }
    }

    async setOptions(newSettings, onErrorCallback, onSuccessCallback, useWorkspaceSettings, source = 'global') {
        let changesApplied = false;
        for (const key in newSettings) {
            if (newSettings.hasOwnProperty(key)) {
                let val = newSettings[key];
                if (this._settingsSchema[key]) {
                    const type = this._settingsSchema[key].type;
                    if (type === 'number') {
                        val = Number(val);
                    } else if (type === 'boolean' || type === 'checkbox') {
                        val = val === true || val === 'true';
                    }
                }
                if (this.config[key] !== val) {
                    this.config[key] = val;
                    changesApplied = true;
                }
            }
        }

        if (changesApplied) {
            if (typeof onSuccessCallback === 'function') {
                onSuccessCallback("Settings saved successfully.");
            }
            const event = new CustomEvent('setting-changed', {
                detail: {
                    settingsName: 'openaiConfig',
                    settings: { ...this.config },
                    useWorkspaceSettings: useWorkspaceSettings,
                    source: this._settingsSource
                }
            });
            window.dispatchEvent(event);
        }
    }

    clearContext() {
        console.log("OpenAI internal context cleared (AIManager manages chat history).");
    }

    async refreshModels() {
        const freshModels = await this._getAvailableModels();
        this._settingsSchema.model.enum = freshModels;

        const currentModelValid = freshModels.some(m => m.value === this.config.model);
        if (!currentModelValid) {
            console.warn(`[OpenAI] Current model '${this.config.model}' is no longer available.`);
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

    const tailText = cleaned.substring(pairRegex.lastIndex || 0);
    const unclosedTailMatch = tailText.match(/"([a-zA-Z0-9_-]+)"\s*:\s*"((?:\\.|[^"\\])*)$/);
    if (unclosedTailMatch) {
        const key = unclosedTailMatch[1];
        let rawVal = unclosedTailMatch[2];
        try {
            rawVal = JSON.parse(`"${rawVal.replace(/\\$/, '')}"`);
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
            if (items.length > 0) {
                obj.edits = items;
            }
        }
    }

    return obj;
}

export default OpenAI;