// ai-llamacpp.mjs
import AI from './ai.mjs';
import systemPrompt from "./llamacppSystemPrompt.mjs";
import { tools as cadenceTools } from "./ai-manager-tools-schema.mjs";

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
            stop: ["</s>", "<|end|>", "<|im_end|>", "Llama:", "User:", "Assistant:"]
        };
        this.MAX_CONTEXT_TOKENS = 8192; // Default, will try to query if possible

        this._settingsSchema = {
            server: { type: "string", label: "Llama.cpp Server", default: "http://localhost:8080" },
            model: { type: "string", label: "Current Model", default: "unknown", readonly: true },
            n_ctx: { type: "number", label: "Context Window (Detected)", default: 0, readonly: true },
            n_predict: { type: "number", label: "Max Tokens (n_predict)", default: 4096 },
            temperature: { type: "number", label: "Temperature", default: 0.7 },
            top_p: { type: "number", label: "Top P", default: 0.9 },
            top_k: { type: "number", label: "Top K", default: 40 },
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
        return true;
    }

    get supportsReasoning() {
        const model = (this.config.model || "").toLowerCase();
        return model.includes('r1') || model.includes('reasoning') || model.includes('deepseek') || model.includes('think') || model.includes("gemma-4");
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

                    formattedMessages.push({
                        role: "assistant",
                        content: textPart || null,
                        tool_calls: toolCalls.map(tc => ({
                            id: tc.id || `call_${crypto.randomUUID()}`,
                            type: "function",
                            function: {
                                name: tc.functionCall.name,
                                arguments: JSON.stringify(tc.functionCall.args || tc.functionCall.arguments || {})
                            }
                        }))
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
                            const found = lastAssistantToolCalls.find(tc => tc.functionCall && tc.functionCall.name === toolName);
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

    async generate(prompt, callbacks = {}) {
        const messages = [{ role: "user", content: prompt }];
        return this.chat(messages, callbacks);
    }

    async chat(messages, callbacks = {}, systemPromptOverride = null) {
        const { onStart, onUpdate, onDone, onError, onContextRatioUpdate } = callbacks;
        if (onStart) onStart();

        try {
            const formattedMessages = this._formatChatMessages(messages, systemPromptOverride);
            let stopTokens = Array.isArray(this.config.stop) ? [...this.config.stop] : ["</s>", "<|end|>", "<|im_end|>", "Llama:", "User:", "Assistant:"];
            stopTokens = stopTokens.filter(token => token !== "</tool_call>");

            const requestBody = {
                messages: formattedMessages,
                stream: true,
                max_tokens: this.config.n_predict,
                temperature: this.config.temperature,
                top_k: this.config.top_k,
                top_p: this.config.top_p,
                stop: stopTokens
            };

            if (this.supportsReasoning) {
                requestBody.enable_thinking = true;
            }

            if (window.ui?.aiManager?.agentMode && cadenceTools && cadenceTools.length > 0) {
                const isPlanning = window.ui?.aiManager?.planningMode === true;
                const filteredTools = cadenceTools.filter(t => !(isPlanning && (t.name === "create_file" || t.name === "edit_file")));
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
                        if (parsed.choices && parsed.choices.length > 0 && parsed.choices[0].delta) {
                            const delta = parsed.choices[0].delta;
                            let chunkUpdate = '';

                            if (typeof delta.reasoning_content === 'string') {
                                let reasoningPart = delta.reasoning_content;
                                reasoningPart = reasoningPart.replace(/<[^>]*?\b(?:tool(?:_?call)?|thought|think|channel)\b[^>]*?>/gi, '');

                                if (!isReasoning) {
                                    isReasoning = true;
                                    thinkingStartTime = Date.now();
                                    chunkUpdate += "<thought>\n";
                                }
                                chunkUpdate += reasoningPart;
                            }

                            if (typeof delta.content === 'string') {
                                if (isReasoning) {
                                    isReasoning = false;
                                    totalThinkingMs += Date.now() - thinkingStartTime;
                                    chunkUpdate += "\n</thought>\n";
                                }
                                chunkUpdate += delta.content;
                            }

                            if (delta.tool_calls) {
                                if (isReasoning) {
                                    isReasoning = false;
                                    totalThinkingMs += Date.now() - thinkingStartTime;
                                    chunkUpdate += "\n</thought>\n";
                                }
                                if (!callbacks.toolCalls) callbacks.toolCalls = [];
                                for (const call of delta.tool_calls) {
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
                            }

                            if (chunkUpdate || delta.tool_calls) {
                                fullResponse += chunkUpdate;

                                // Loose tool call protection in content tokens
                                const looseToolCallRegex = /<tool_call[\s\S]*?>|<\|tool[\s\S]*?>/gi;
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

                                let processedResponse = translateGemmaToolCalls(fullResponse);
                                processedResponse = getResponseWithToolCalls(processedResponse, streamedToolCalls);
                                if (onUpdate) onUpdate(processedResponse);
                            }
                        }
                    } catch (e) {
                        //console.warn("[Llama.cpp] JSON parse error:", e);
                    }
                }
            }

            if (isReasoning) {
                isReasoning = false;
                totalThinkingMs += Date.now() - thinkingStartTime;
                fullResponse += "\n</thought>";
            }

            const requestEndTime = Date.now();
            let finalResponse = translateGemmaToolCalls(fullResponse);
            finalResponse = getResponseWithToolCalls(finalResponse, streamedToolCalls);

            const finalTokens = this.estimateTokens([...messages, { role: 'model', content: finalResponse }]);
            const outputTokens = Math.max(0, finalTokens - currentTokens);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(finalTokens / this.MAX_CONTEXT_TOKENS);
            }

            this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, Math.round(totalThinkingMs / 1000));

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
    let cleaned = str.replace(/<\|"\|>/g, '"');
    try {
        return JSON.parse(cleaned);
    } catch (e) {}

    try {
        const fn = new Function(`return (${cleaned});`);
        return fn();
    } catch (e) {
        console.debug("[Llama.cpp] Relaxed JSON parsing failed:", e);
    }

    const obj = {};
    const pairRegex = /(?:["']?([a-zA-Z0-9_-]+)["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_\.-]+)))/g;
    let match;
    while ((match = pairRegex.exec(cleaned)) !== null) {
        const key = match[1];
        const val = match[2] !== undefined ? match[3] || match[2] : match[4];
        obj[key] = val;
    }
    return obj;
}

function getResponseWithToolCalls(baseContent, streamedToolCalls) {
    let result = baseContent;
    for (const tc of streamedToolCalls) {
        if (!tc || !tc.name) continue;
        let parsedArgs = {};
        try {
            parsedArgs = JSON.parse(tc.arguments);
        } catch (e) {
            parsedArgs = parseRelaxedJson(tc.arguments);
        }
        
        let xmlToolCall = `\n<tool_call name="${tc.name}">\n`;
        for (const [key, value] of Object.entries(parsedArgs)) {
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
            xmlToolCall += `  <${key}>${stringValue}</${key}>\n`;
        }
        xmlToolCall += `</tool_call>\n`;
        result += xmlToolCall;
    }
    return result;
}

function translateGemmaToolCalls(text) {
    if (!text) return text;
    const gemmaRegex = /<\|tool>(?:declaration|call):([a-zA-Z0-9_-]+)\s*(\{[\s\S]*?\})(?:<\|?tool_call\|?>)?/g;
    return text.replace(gemmaRegex, (match, toolName, argsStr) => {
        const args = parseRelaxedJson(argsStr);
        let xml = `<tool_call name="${toolName}">\n`;
        for (const [key, value] of Object.entries(args)) {
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
            xml += `  <${key}>${stringValue}</${key}>\n`;
        }
        xml += `</tool_call>`;
        return xml;
    });
}

export default LlamaCpp;
