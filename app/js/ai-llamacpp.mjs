import AI from './ai.mjs';
import systemPrompt from "./llamacppSystemPrompt.mjs"

const defaultModels = [
    { value: "llama.cpp", label: "Llama.cpp (Default)", maxTokens: 4096 },
];

class LlamaCpp extends AI {
    constructor() {
        super();
        this.config = {
            server: "http://localhost:8080",
            model: "llama.cpp",
            system: systemPrompt()
        };
        this.MAX_CONTEXT_TOKENS = 4096;

        this._settingsSchema = {
            server: { type: "string", label: "Llama.cpp Server", default: "http://localhost:8080" },
            model: {
                type: "enum",
                label: "Model (v1/models)",
                default: "llama.cpp",
                enum: defaultModels,
                lookupCallback: this._getAvailableModels.bind(this)
            }
        };
    }

    isConfigured() {
        return this.config.server !== "";
    }

    async _getAvailableModels() {
        try {
            const modelsEndpoint = `${this.config.server}/v1/models`;
            const response = await fetch(modelsEndpoint);
            if (!response.ok) {
                return JSON.parse(JSON.stringify(defaultModels));
            }
            const data = await response.json();
            
            const fetchedModels = data.data.map(m => ({
                value: m.id,
                label: m.id
            }));

            const uniqueModelsMap = new Map();
            defaultModels.forEach(m => uniqueModelsMap.set(m.value, m));
            fetchedModels.forEach(m => uniqueModelsMap.set(m.value, m));

            return Array.from(uniqueModelsMap.values());
        } catch (error) {
            console.error("Error fetching llama.cpp models:", error);
            return JSON.parse(JSON.stringify(defaultModels));
        }
    }

    async init() {
        // llama.cpp doesn't always provide easy context length querying without props
        try {
            const propsResponse = await fetch(`${this.config.server}/props`, { signal: AbortSignal.timeout(2000) });
            if (propsResponse.ok) {
                const props = await propsResponse.json();
                if (props.default_generation_settings && props.default_generation_settings.n_ctx) {
                    this.MAX_CONTEXT_TOKENS = props.default_generation_settings.n_ctx;
                }
            }
        } catch (e) {
            console.warn("Could not fetch llama.cpp props, using default context length.", e.message);
        }
    }

    _handleFetchError(error) {
        if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
            return new Error(`Failed to connect to llama.cpp server at ${this.config.server}. Ensure the server is running and that you can access it from your browser. Note: If you are running the PWA via HTTPS, your browser may block requests to a local HTTP server (Mixed Content).`);
        }
        return error;
    }

    async generate(prompt, callbacks = {}) {
        const { onStart, onUpdate, onDone, onError } = callbacks;
        if (onStart) onStart();

        try {
            const requestBody = {
                prompt: prompt,
                stream: true,
                n_predict: -1, 
            };
            if (this.config.system) {
                requestBody.prompt = `${this.config.system}\n\n${prompt}`;
            }

            const response = await fetch(`${this.config.server}/completion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            }).catch(err => { throw this._handleFetchError(err); });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Llama.cpp Completion Error: ${response.status} - ${errorText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullResponse = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (onDone) onDone(fullResponse);
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                let lines = buffer.split('\n');
                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (line) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.content) {
                                fullResponse += parsed.content;
                                if (onUpdate) onUpdate(fullResponse);
                            }
                        } catch (e) {
                            console.error('Error parsing JSON chunk from generate stream:', e, line);
                        }
                    }
                }
                buffer = lines[lines.length - 1];
            }
        } catch (error) {
            console.error("Error in llama.cpp generate:", error);
            if (onError) onError(error);
        }
    }

    async chat(messages, callbacks = {}, systemPrompt = null) {
        const { onStart, onUpdate, onDone, onError } = callbacks;
        if (onStart) onStart();

        try {
            const intermediateMessages = messages.map(msg => {
                if (msg.type === 'file_context') {
                    return {
                        role: 'user',
                        content: `--- File: ${msg.filename} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\``
                    };
                }
                const role = msg.role === 'model' ? 'assistant' : msg.role;
                return { role: role, content: msg.content };
            });

            const messagesToSend = [];
            for (const msg of intermediateMessages) {
                const lastMessage = messagesToSend.length > 0 ? messagesToSend[messagesToSend.length - 1] : null;
                if (lastMessage && lastMessage.role === 'user' && msg.role === 'user') {
                    lastMessage.content += '\n\n' + msg.content;
                } else {
                    messagesToSend.push(msg);
                }
            }

            const effectiveSystemPrompt = systemPrompt || this.config.system;
            if (effectiveSystemPrompt) {
                messagesToSend.unshift({ role: 'system', content: effectiveSystemPrompt });
            }

            const requestBody = {
                model: this.config?.model || "llama.cpp",
                messages: messagesToSend,
                stream: true,
            };

            const response = await fetch(`${this.config.server}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            }).catch(err => { throw this._handleFetchError(err); });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Llama.cpp Chat Error: ${response.status} - ${errorText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullResponse = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (onDone) onDone(fullResponse);
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                let lines = buffer.split('\n');
                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6);
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(jsonStr);
                            const content = parsed.choices?.[0]?.delta?.content;
                            if (content) {
                                fullResponse += content;
                                if (onUpdate) onUpdate(fullResponse);
                            }
                        } catch (e) {
                            console.error('Error parsing JSON chunk from chat stream:', e, jsonStr);
                        }
                    }
                }
                buffer = lines[lines.length - 1];
            }
        } catch (error) {
            console.error("Error in llama.cpp chat:", error);
            if (onError) onError(error);
        }
    }

    async setOptions(newConfig, onErrorCallback, onSuccessCallback, useWorkspaceSettings, source = 'global') {
        let changed = false;
        for (const name in newConfig) {
            if (this.config[name] !== newConfig[name]) {
                this.config[name] = newConfig[name];
                changed = true;
            }
        }
        this._settingsSource = source;

        console.log(`[LlamaCpp] setOptions called (source: ${source}, useWorkspaceSettings: ${useWorkspaceSettings}, changed: ${changed})`, this.config);

        // ALWAYS dispatch event immediately to ensure consistency and trigger persistence in main.mjs
        // Moving this to occur BEFORE await init() ensures changes are saved even if init() is slow or fails.
        const event = new CustomEvent('setting-changed', {
            detail: {
                settingsName: 'llamacppConfig',
                settings: { ...this.config },
                useWorkspaceSettings: useWorkspaceSettings,
                source: this._settingsSource
            }
        });
        window.dispatchEvent(event);

        if (changed) {
            await this.init(); 
            if (onSuccessCallback) onSuccessCallback(`Llama.cpp settings updated. Server: ${this.config.server}`);
        } else {
            if (onSuccessCallback) onSuccessCallback(`Llama.cpp connected. Server: ${this.config.server}`);
        }
    }

    saveSettings(newConfig, useWorkspaceSettings) {
        // This is a synchronous version that ensures the event is fired for persistence
        // The actual logic is handled by setOptions, but this is kept for API compatibility.
        this.setOptions(newConfig, null, null, useWorkspaceSettings, useWorkspaceSettings ? 'workspace' : 'global');
    }

    clearContext() {
        console.log("Llama.cpp internal context cleared.");
    }

    async refreshModels() {
        this._settingsSchema.model.enum = await this._getAvailableModels();
        await this.init();
    }
}

export default LlamaCpp;
