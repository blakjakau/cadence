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
            temperature: { type: "number", label: "Temperature", default: 0.7 },
            n_predict: { type: "number", label: "Max Tokens (n_predict)", default: 4096 },
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
        const activeSystemPrompt = systemPromptOverride || this.config.system || systemPrompt;

        if (activeSystemPrompt) {
            formattedMessages.push({ role: "system", content: activeSystemPrompt });
        }

        for (const msg of messages) {
            if (msg.type === 'file_context') {
                formattedMessages.push({ role: "user", content: `--- File: ${msg.filename} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\`` });
            } else {
                formattedMessages.push({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.content });
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
            
            const requestBody = {
                messages: formattedMessages,
                stream: true,
                temperature: this.config.temperature,
                top_k: this.config.top_k,
                top_p: this.config.top_p,
                max_tokens: this.config.n_predict,
                stop: this.config.stop
            };

            if (cadenceTools && cadenceTools.length > 0) {
                requestBody.tools = cadenceTools.map(t => ({
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
                                if (!isReasoning) {
                                    isReasoning = true;
                                    thinkingStartTime = Date.now();
                                    chunkUpdate += "<thought>\n";
                                }
                                chunkUpdate += delta.reasoning_content;
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
                                    if (call.function) {
                                        const rawCall = { functionCall: { name: call.function.name, args: {} } };
                                        let parsedArgs = {};
                                        try {
                                            parsedArgs = JSON.parse(call.function.arguments);
                                            rawCall.functionCall.args = parsedArgs;
                                        } catch (e) {
                                            // Handle partial JSON or unparseable JSON
                                        }
                                        callbacks.toolCalls.push(rawCall);

                                        let xmlToolCall = `\n<tool_call name="${call.function.name}">\n`;
                                        for (const [key, value] of Object.entries(parsedArgs)) {
                                            const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
                                            xmlToolCall += `  <${key}>${stringValue}</${key}>\n`;
                                        }
                                        xmlToolCall += `</tool_call>\n`;
                                        chunkUpdate += xmlToolCall;
                                    }
                                }
                            }

                            if (chunkUpdate) {
                                fullResponse += chunkUpdate;
                                if (onUpdate) onUpdate(fullResponse);
                            }
                        }
                    } catch (e) {
                        console.warn("[Llama.cpp] JSON parse error:", e);
                    }
                }
            }

            if (isReasoning) {
                isReasoning = false;
                totalThinkingMs += Date.now() - thinkingStartTime;
                fullResponse += "\n</thought>";
                if (onUpdate) onUpdate(fullResponse);
            }

            const requestEndTime = Date.now();
            const finalTokens = this.estimateTokens([...messages, { role: 'model', content: fullResponse }]);
            const outputTokens = Math.max(0, finalTokens - currentTokens);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(finalTokens / this.MAX_CONTEXT_TOKENS);
            }

            this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, Math.round(totalThinkingMs / 1000));

            if (onDone) onDone(fullResponse, Math.round((finalTokens / this.MAX_CONTEXT_TOKENS) * 100));

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
            this.config[name] = newConfig[name];
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

export default LlamaCpp;
