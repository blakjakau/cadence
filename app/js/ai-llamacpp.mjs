// ai-llamacpp.mjs
import AI from './ai.mjs';
import systemPrompt from "./llamacppSystemPrompt.mjs";
import { tools as cadenceTools, subAgentToolsList } from "./ai-manager-tools-schema.mjs";

class LlamaCpp extends AI {
    constructor() {
        super();
        this.providerId = 'llamacpp';
        this.config = {
            server: "http://localhost:8080",
            model: "unknown",
            n_ctx: 0,
            system: "",
            temperature: 0.7,
            top_k: 40,
            top_p: 0.9,
            n_predict: 4096,
            stop: ["</s>", "<|end|>", "<|im_end|>", "Llama:", "User:", "Assistant:"],
            thinkingLevel: "medium",
            maxTurns: 0
        };
        this.MAX_CONTEXT_TOKENS = 32768; // Default, will try to query if possible

        this._settingsSchema = {
            server: { type: "string", label: "Llama.cpp Server", default: "http://localhost:8080" },
            model: { type: "string", label: "Current Model", default: "unknown", readonly: true },
            n_ctx: { type: "number", label: "Context Window (Detected)", default: 0, readonly: true },
            n_predict: { type: "number", label: "Max Tokens (n_predict)", default: 4096 },
            temperature: { type: "number", label: "Temperature", default: 0.7 },
            top_p: { type: "number", label: "Top P", default: 0.9 },
            top_k: { type: "number", label: "Top K", default: 40 },
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
            maxTurns: { type: "number", label: "Max Agent Turns (0 for unlimited)", default: 0 },
            system: { type: "textarea", label: "System Prompt Override", default: "", multiline: true }
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
        return this.config.server !== "";
    }

    get supportsJSONTools() {
        if (this.serverSupportsTools !== undefined) {
            return this.serverSupportsTools;
        }
        return true;
    }

    get supportsReasoning() {
        if (this.serverSupportsReasoning !== undefined) {
            return this.serverSupportsReasoning;
        }
        const model = (this.config.model || "").toLowerCase();
        return model.includes('r1') 
        	|| model.includes('reasoning') 
        	|| model.includes('deepseek') 
        	|| model.includes('think') 
        	|| model.includes("gemma-4")
        	|| model.includes('qwen')
        	|| model.includes('ornith');
    }

    async init() {
        await super.init();
        await this._queryModelInfo();
    }

    async _queryModelInfo() {
        if (!this.config.server) return;
        try {
            const response = await fetch(`${this.config.server}/props`);
            if (response.ok) {
                const data = await response.json();
                if (data.default_generation_settings && data.default_generation_settings.n_ctx) {
                    this.MAX_CONTEXT_TOKENS = data.default_generation_settings.n_ctx;
                    this.config.n_ctx = data.default_generation_settings.n_ctx;
                }
                if (data.model_path) {
                    this.config.model = data.model_path.split('/').pop();
                }

                // Dynamically detect reasoning and tool calling capabilities from server props
                const chatTemplate = (data.chat_template || data.default_generation_settings?.chat_template || "").toLowerCase();
                const defaultGen = data.default_generation_settings || {};
                
                // Reasoning detection via template tags (<think>, thought, reasoning_content, [THINK]) or settings
                const hasReasoningInTemplate = chatTemplate.includes('<think>') 
                    || chatTemplate.includes('thought') 
                    || chatTemplate.includes('reasoning_content') 
                    || chatTemplate.includes('[think]')
                    || chatTemplate.includes('<channel>');
                const hasReasoningInSettings = defaultGen.reasoning_budget !== undefined 
                    || defaultGen.thinking_budget !== undefined 
                    || defaultGen.enable_thinking !== undefined
                    || data.has_reasoning === true;
                
                if (hasReasoningInTemplate || hasReasoningInSettings) {
                    this.serverSupportsReasoning = true;
                }

                // Tool calling detection via template or capabilities
                const hasToolsInTemplate = chatTemplate.includes('tool_call') 
                    || chatTemplate.includes('tools') 
                    || chatTemplate.includes('[tool_calls]') 
                    || chatTemplate.includes('call:');
                const hasToolsInProps = data.tools === true || (Array.isArray(data.capabilities) && data.capabilities.includes('tools'));

                if (hasToolsInTemplate || hasToolsInProps) {
                    this.serverSupportsTools = true;
                }

                console.debug(`[Llama.cpp] Server model info queried: model=${this.config.model}, supportsReasoning=${this.serverSupportsReasoning}, supportsTools=${this.serverSupportsTools}`);
            }
        } catch (e) {
            console.warn("[Llama.cpp] Could not query model info:", e.message);
        }
    }

    /**
     * Formats the messages array into the OpenAI-compatible Chat format
     */
    _formatChatMessages(messages, systemPromptOverride = null) {
        const formattedMessages = [];
        let activeSystemPrompt = systemPromptOverride || this.config.system || systemPrompt;

        const modelName = (this.config.model || "").toLowerCase();
        if (modelName.includes("gemma")) {
            activeSystemPrompt = "" + (activeSystemPrompt || "");
        }

        if (activeSystemPrompt) {
            formattedMessages.push({ role: "system", content: activeSystemPrompt });
        }

        let lastAssistantToolCalls = null;

        for (const msg of messages) {
            if (msg.type === 'file_context') {
                formattedMessages.push({ role: "user", content: `--- File: ${msg.filename} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\`` });
            } else if (msg.role === 'model') {
                let toolCalls = msg.toolCalls || [];
                
                // Self-healing: if no toolCalls are explicitly saved on the message object,
                // but the content contains XML <tool_call> tags, parse them dynamically!
                if (toolCalls.length === 0 && msg.content && msg.content.includes('<tool_call')) {
                    const parsedCalls = [];
                    const tcRegex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
                    let tcMatch;
                    while ((tcMatch = tcRegex.exec(msg.content)) !== null) {
                        const name = tcMatch[1];
                        const innerArgs = tcMatch[2];
                        const args = {};
                        
                        // Extract tag values
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
                    
                    // Extract text before <tool_call
                    let textPart = msg.content;
                    const toolCallIdx = msg.content.indexOf('<tool_call');
                    if (toolCallIdx !== -1) {
                        textPart = msg.content.substring(0, toolCallIdx).trim();
                    }
                    
                    // Also filter out any remaining tool_call blocks from textPart
                    textPart = textPart.replace(/<tool_call[\s\S]*?<\/tool_call>/g, '').trim();

                    const validToolCalls = (Array.isArray(toolCalls) ? toolCalls : []).filter(tc => tc && typeof tc === 'object');
                    formattedMessages.push({
                        role: "assistant",
                        content: textPart || null,
                        tool_calls: validToolCalls.map(tc => {
                            const name = tc?.functionCall?.name || tc?.function?.name || tc?.name || "";
                            const rawArgs = tc?.functionCall?.args || tc?.functionCall?.arguments || tc?.function?.arguments || tc?.arguments || tc?.args || {};
                            const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
                            return {
                                id: tc?.id || `call_${crypto.randomUUID()}`,
                                type: "function",
                                function: {
                                    name: name,
                                    arguments: argsStr
                                }
                            };
                        })
                    });
                } else {
                    formattedMessages.push({ role: "assistant", content: msg.content });
                }
            } else if (msg.type === 'tool_response') {
                const parts = msg.content.split(/\n\n---\n\n/);
                for (const part of parts) {
                    const match = part.match(/\[Tool Response: ([^\]]+)\]\n\n([\s\S]*)/);
                    if (match) {
                        const toolName = match[1].split(' ')[0];
                        const toolResponse = match[2];
                        
                        // Find matching tool call to get the ID
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
                            content: toolResponse
                        });
                    } else {
                        // Fallback
                        formattedMessages.push({ role: "user", content: part });
                    }
                }
            } else {
                formattedMessages.push({ role: "user", content: msg.content });
            }
        }

        return formattedMessages;
    }

    async tokenize(content) {
        if (!this.config.server) return null;
        try {
            let textToTokenize = "";
            if (typeof content === 'string') {
                textToTokenize = content;
            } else if (Array.isArray(content)) {
                const formatted = this._formatChatMessages(content);
                textToTokenize = formatted.map(m => `<|im_start|>${m.role}\n${m.content || ''}<|im_end|>`).join('\n');
            } else {
                return null;
            }

            let response = await fetch(`${this.config.server}/tokenize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: textToTokenize })
            });
            if (!response.ok) {
                response = await fetch(`${this.config.server}/v1/tokenize`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: textToTokenize })
                });
            }
            if (response.ok) {
                const data = await response.json();
                if (data.tokens && Array.isArray(data.tokens)) {
                    return data.tokens.length;
                }
            }
        } catch (e) {
            console.warn("[Llama.cpp] tokenize failed:", e.message);
        }
        return null;
    }

    async generate(prompt, callbacks = {}) {
        const messages = [{ role: "user", content: prompt }];
        return this.chat(messages, callbacks);
    }

    async chat(messages, callbacks = {}, systemPromptOverride = null, session = null) {
        const { onStart, onUpdate, onDone, onError, onContextRatioUpdate, onPrefillProgress } = callbacks;
        if (onStart) onStart();

        try {
            const formattedMessages = this._formatChatMessages(messages, systemPromptOverride);
            let stopTokens = Array.isArray(this.config.stop) ? [...this.config.stop] : ["</s>", "<|end|>", "<|im_end|>", "Llama:", "User:", "Assistant:"];
            stopTokens = stopTokens.filter(token => token !== "</tool_call>");

            const nCtx = this.config.n_ctx || this.MAX_CONTEXT_TOKENS || 0;
            const maxTokens = Math.max(4096, Math.round(nCtx * 0.2));

            const requestBody = {
                messages: formattedMessages,
                stream: true,
                max_tokens: maxTokens,
                temperature: (session && session.temperatureOverride !== undefined) ? session.temperatureOverride : this.config.temperature,
                top_k: this.config.top_k,
                top_p: this.config.top_p,
                stop: stopTokens,
                tool_choice: "auto",
                return_progress: true
            };

            const sessionLevel = session?.thinkingLevel;
            const level = (sessionLevel && sessionLevel !== 'auto') ? sessionLevel : (this.config.thinkingLevel || "medium");
            const isReasoningDisabled = (session && session.disableReasoning === true) || (level === 'off');
            if (isReasoningDisabled) {
                requestBody.enable_thinking = false;
                requestBody.thinking_budget = 0;
                requestBody.thinking_budget_tokens = 0;
                requestBody.reasoning_budget = 0;
                requestBody.reasoning_effort = "none";
            } else if (this.supportsReasoning) {
                requestBody.enable_thinking = true;
                if (level !== 'unlimited' && level !== 'ultra') {
                    let budget = 2048;
                    if (level === 'low') {
                        budget = Math.max(512, Math.min(1024, Math.round(this.MAX_CONTEXT_TOKENS * 0.03125)));
                    } else if (level === 'medium' || level === 'med') {
                        budget = Math.max(1024, Math.min(2048, Math.round(this.MAX_CONTEXT_TOKENS * 0.0625)));
                    } else if (level === 'high') {
                        budget = Math.max(2048, Math.min(4096, Math.round(this.MAX_CONTEXT_TOKENS * 0.125)));
                    }
                    requestBody.thinking_budget_tokens = budget;
                    requestBody.thinking_budget = budget;
                    requestBody.reasoning_budget = budget;
                }
            }

            if ((window.ui?.aiManager?.agentMode || (session && session.parentId)) && cadenceTools && cadenceTools.length > 0) {
                let filteredTools;
                if (session && session.parentId) {
                    filteredTools = cadenceTools.filter(t => subAgentToolsList.includes(t.name));
                } else {
                    const isPlanning = window.ui?.aiManager?.planningMode === true;
                    filteredTools = cadenceTools.filter(t => {
                        if (isPlanning && (t.name === "create_file" || t.name === "edit_file")) return false;
                        if (session && session.allowSubAgents === false && t.name === "create_sub_agent") return false;
                        if (session && session.allowRunCommand === false && (t.name === "run_command" || t.name === "exec_command")) return false;
                        return true;
                    });
                }
                requestBody.tools = filteredTools.map(t => ({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters
                    }
                }));
            }

            const currentTokens = this.estimateTokens(messages);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(currentTokens / this.MAX_CONTEXT_TOKENS);
            }

            this.abortController = new AbortController();

            const requestStartTime = Date.now();
            const response = await fetch(`${this.config.server}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
            let looseToolCallCount = 0;

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
                        if (parsed.prompt_progress) {
                            if (onPrefillProgress) {
                                onPrefillProgress(parsed.prompt_progress);
                            }
                            continue;
                        }
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

                                        // Update callbacks.toolCalls with current parsed state
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
                                        console.warn("[Llama.cpp] Error parsing streamed tool calls:", err);
                                    }
                                }
                            }

                            if (chunkUpdate || delta.tool_calls) {
                                fullResponse += chunkUpdate;

                                 // Loose tool call protection in content tokens
                                const looseToolCallRegex = /<tool_call[\s\S]*?>|<\|tool[\s\S]*?>|<\|im_start\|>call:/gi;
                                let match;
                                while ((match = looseToolCallRegex.exec(fullResponse)) !== null) {
                                    looseToolCallCount++;
                                    console.warn(`[Llama.cpp] Loose tool call hit #${looseToolCallCount} detected in text: ${match[0]}`);
 
                                    // Strip the loose tool call tag from fullResponse
                                    fullResponse = fullResponse.substring(0, match.index) + fullResponse.substring(match.index + match[0].length);
                                    looseToolCallRegex.lastIndex = 0; // Reset index since we modified the string
 
                                    if (looseToolCallCount > 3) {
                                        this.stop("Too many redundant/loose tool calls generated in text stream.");
                                        break;
                                    }
                                }
 
                                if (onUpdate) onUpdate(fullResponse, { thought: callbacks.thought, isThinking: callbacks.isThinking, toolCalls: callbacks.toolCalls });
                            }
                        }
                    } catch (e) {
                        //console.warn("[Llama.cpp] JSON parse error:", e);
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
            let finalResponse = fullResponse;

            const finalTokens = this.estimateTokens([...messages, { role: 'model', content: finalResponse }]);
            const outputTokens = Math.max(0, finalTokens - currentTokens);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(finalTokens / this.MAX_CONTEXT_TOKENS);
            }

            this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, Math.round(totalThinkingMs / 1000));
            callbacks.totalThinkingMs = totalThinkingMs;

            if (onDone) onDone(finalResponse, Math.round((finalTokens / this.MAX_CONTEXT_TOKENS) * 100));

        } catch (error) {
            if (error && error.name === 'AbortError') {
                const reasonStr = this.abortReason ? `: ${this.abortReason}` : " by Cadence Agent Protocol.";
                console.info(`⏸️ [Llama.cpp] Stream generation intentionally halted${reasonStr}`);
                this.abortReason = null;
            } else if (typeof error === 'string') {
                console.info(`⏸️ [Llama.cpp] Stream generation intentionally halted: ${error}`);
            } else {
                console.error("[Llama.cpp] Chat error:", error);
                if (onError) onError(error);
            }
        }
    }

    async setOptions(newConfig, onErrorCallback, onSuccessCallback, useWorkspaceSettings, source = 'global') {
        for (const name in newConfig) {
            let val = newConfig[name];
            if (this._settingsSchema[name]) {
                const type = this._settingsSchema[name].type;
                if (type === 'number') {
                    val = Number(val);
                } else if (type === 'boolean' || type === 'checkbox') {
                    val = val === true || val === 'true';
                }
            }
            this.config[name] = val;
        }
        if (Array.isArray(this.config.stop)) {
            this.config.stop = this.config.stop.filter(token => token !== "</tool_call>");
        }
        this._settingsSource = source;

        // Try to update model info immediately
        await this._queryModelInfo();

        // Try to verify connection
        try {
            const response = await fetch(`${this.config.server}/health`);
            if (response.ok) {
                if (onSuccessCallback) onSuccessCallback(`Connected to Llama.cpp server at ${this.config.server}`);
            } else {
                throw new Error(`Health check failed with status ${response.status}`);
            }
        } catch (e) {
            if (onErrorCallback) onErrorCallback(`Llama.cpp server at ${this.config.server} is unreachable or unhealthy: ${e.message}`);
        }

        const event = new CustomEvent('setting-changed', {
            detail: {
                settingsName: 'llamacppConfig',
                settings: { ...this.config },
                useWorkspaceSettings: useWorkspaceSettings,
                source: this._settingsSource
            }
        });
        window.dispatchEvent(event);
    }

    async refreshModels() {
        // llama.cpp server typically serves one model. We can just re-query info.
        await this._queryModelInfo();
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

export default LlamaCpp;
