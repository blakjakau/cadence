// ai-llamacpp.mjs
import AI from './ai.mjs';
import systemPrompt from "./llamacppSystemPrompt.mjs";

class LlamaCpp extends AI {
    constructor() {
        super();
        this.config = {
            server: "http://localhost:8080",
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
            temperature: { type: "number", label: "Temperature", default: 0.7 },
            n_predict: { type: "number", label: "Max Tokens (n_predict)", default: 4096 },
            system: { type: "textarea", label: "System Prompt Override", default: "", multiline: true }
        };
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
            // llama.cpp server provides some info at /props or /health
            const response = await fetch(`${this.config.server}/props`);
            if (response.ok) {
                const data = await response.json();
                if (data.default_generation_settings && data.default_generation_settings.n_ctx) {
                    this.MAX_CONTEXT_TOKENS = data.default_generation_settings.n_ctx;
                }
            }
        } catch (e) {
            console.warn("[Llama.cpp] Could not query model info:", e.message);
        }
    }

    /**
     * Formats the messages array into a ChatML-style string for the /completion endpoint.
     */
    _formatPrompt(messages, systemPromptOverride = null) {
        let prompt = "";
        const activeSystemPrompt = systemPromptOverride || this.config.system || systemPrompt;

        if (activeSystemPrompt) {
            prompt += `<|im_start|>system\n${activeSystemPrompt}<|im_end|>\n`;
        }

        for (const msg of messages) {
            if (msg.type === 'file_context') {
                prompt += `<|im_start|>user\n--- File: ${msg.filename} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\`<|im_end|>\n`;
            } else {
                const role = msg.role === 'model' ? 'assistant' : 'user';
                prompt += `<|im_start|>${role}\n${msg.content}<|im_end|>\n`;
            }
        }

        prompt += `<|im_start|>assistant\n`;
        return prompt;
    }

    async generate(prompt, callbacks = {}) {
        const messages = [{ role: "user", content: prompt }];
        return this.chat(messages, callbacks);
    }

    async chat(messages, callbacks = {}, systemPromptOverride = null) {
        const { onStart, onUpdate, onDone, onError, onContextRatioUpdate } = callbacks;
        if (onStart) onStart();

        try {
            const prompt = this._formatPrompt(messages, systemPromptOverride);
            
            const requestBody = {
                prompt: prompt,
                stream: true,
                temperature: this.config.temperature,
                top_k: this.config.top_k,
                top_p: this.config.top_p,
                n_predict: this.config.n_predict,
                stop: this.config.stop
            };

            const currentTokens = this.estimateTokens(messages);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(currentTokens / this.MAX_CONTEXT_TOKENS);
            }

            const response = await fetch(`${this.config.server}/completion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! Status: ${response.status}, Message: ${errorText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullResponse = '';
            let buffer = '';

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

                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.content) {
                            fullResponse += parsed.content;
                            if (onUpdate) onUpdate(fullResponse);
                        }
                        if (parsed.stop) {
                            // End of stream indicator in llama.cpp
                        }
                    } catch (e) {
                        console.warn("[Llama.cpp] JSON parse error:", e);
                    }
                }
            }

            const finalTokens = this.estimateTokens([...messages, { role: 'model', content: fullResponse }]);
            if (onContextRatioUpdate) {
                onContextRatioUpdate(finalTokens / this.MAX_CONTEXT_TOKENS);
            }

            if (onDone) onDone(fullResponse, Math.round((finalTokens / this.MAX_CONTEXT_TOKENS) * 100));

        } catch (error) {
            console.error("[Llama.cpp] Chat error:", error);
            if (onError) onError(error);
        }
    }

    async setOptions(newConfig, onErrorCallback, onSuccessCallback, useWorkspaceSettings, source = 'global') {
        for (const name in newConfig) {
            this.config[name] = newConfig[name];
        }
        this._settingsSource = source;

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
