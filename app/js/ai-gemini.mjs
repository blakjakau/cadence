// ai-gemini.mjs
import AI from './ai.mjs';
import systemPrompt from "./geminiSystemPrompt.mjs"
import { tools as cadenceTools, subAgentToolsList } from "./ai-manager-tools-schema.mjs";

class Gemini extends AI {
    constructor() {
        super();
        this.config = {
            apiKey: "",
            model: "", 
            server: "https://generativelanguage.googleapis.com", 
            system: "",
            stripCodeBlocksFromContext: false, // New setting to control code block stripping
            rpmLimit: 15,
            tpmLimit: 250000,
            rpdLimit: 500,
            thinkingLevel: "medium",
            maxInputTokens: 0
        };
        this.MAX_CONTEXT_TOKENS = 32768*2; 

        this.requestTimestamps = [];
        this.tokenTimestamps = [];

        this._settingsSchema = {
            apiKey: { type: "string", label: "Gemini API Key", default: "" },
            server: { type: "string", label: "Gemini API Server", default: "https://generativelanguage.googleapis.com" },
            model: { 
                type: "enum", 
                label: "Model", 
                default: "gemini-2.5-flash", 
                lookupCallback: this._getAvailableModels.bind(this) 
            },
            stripCodeBlocksFromContext: { type: "boolean", label: "Strip Code Blocks from Context", default: false },
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
            rpmLimit: { type: "number", label: "RPM Limit (Requests/Min)", default: 15 },
            tpmLimit: { type: "number", label: "TPM Limit (Tokens/Min)", default: 250000 },
            rpdLimit: { type: "number", label: "RPD Limit (Requests/Day)", default: 500 },
            maxInputTokens: { type: "number", label: "Max Input Tokens (0 for unlimited)", default: 0 }
            //system: { type: "string", label: "System Prompt", default: systemPrompt, multiline: true },
        };
    }

    // Helper to strip the "models/" prefix
    _stripModelPrefix(modelName) {
        if (modelName && modelName.startsWith("models/")) {
            return modelName.substring("models/".length);
        }
        return modelName;
    }
    
    stop(reason) {
        if (this.abortController) {
            this.abortReason = reason;
            this.abortController.abort(reason);
            this.abortController = null;
        }
    }

    isConfigured() {
    	return this.config.apiKey != "" && this.config.model != ""
    }

    get supportsJSONTools() {
        return true;
    }

    get supportsReasoning() {
        const model = (this.config.model || "").toLowerCase();
        return model.includes("gemini") || model.includes("gemma-4")
        // return model.includes('thinking') || model.includes('pro') || model.includes('2.0') || model.includes('2.5') || model.includes('3.1') || model.includes('3.5');
    }

    get supportsParallelTools() {
        return true;
    }

    async _enforceRateLimits(estimatedTokens) {
        const rpmLimit = this.config.rpmLimit || 15;
        const tpmLimit = this.config.tpmLimit || 250000;
        const rpdLimit = this.config.rpdLimit || 500;

        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        const oneDayAgo = now - 86400000;

        this.requestTimestamps = this.requestTimestamps.filter(t => t > oneDayAgo);
        this.tokenTimestamps = this.tokenTimestamps.filter(t => t.time > oneMinuteAgo);

        let delayMs = 0;
        let limitHit = "";

        // 1. Baseline RPM Spacing
        const baselineSpacingMs = 60000 / rpmLimit;
        if (this.requestTimestamps.length > 0) {
            const timeSinceLastRequest = now - this.requestTimestamps[this.requestTimestamps.length - 1];
            if (timeSinceLastRequest < baselineSpacingMs) {
                const spacingDelay = baselineSpacingMs - timeSinceLastRequest;
                if (spacingDelay > delayMs) {
                    delayMs = spacingDelay;
                    limitHit = "RPM (Baseline Pacing)";
                }
            }
        }

        // 2. Predictive TPM Throttling
        const currentTps = this.tokensPerSec; // From base AI class
        if (currentTps > 0) {
            const projectedTpm = currentTps * 60;
            if (projectedTpm > tpmLimit) {
                const last = this._telemetryTokens[this._telemetryTokens.length - 1];
                if (last && last.tokens > 0) {
                    const targetTps = tpmLimit / 60;
                    const requiredTotalTime = last.tokens / targetTps;
                    const elapsedSecs = last.elapsedMs / 1000;
                    const requiredDelaySecs = requiredTotalTime - elapsedSecs;
                    if (requiredDelaySecs > 0) {
                        const predictiveDelayMs = requiredDelaySecs * 1000;
                        if (predictiveDelayMs > delayMs) {
                            delayMs = predictiveDelayMs;
                            limitHit = "Predictive TPM Spacing";
                        }
                    }
                }
            }
        }

        // 3. Hard Limit: RPD
        if (this.requestTimestamps.length >= rpdLimit) {
            const timeToWait = this.requestTimestamps[0] - oneDayAgo;
            if (timeToWait > delayMs) {
                delayMs = timeToWait;
                limitHit = "RPD (Requests per day)";
            }
        }

        // 4. Hard Limit: RPM
        const requestsLastMinute = this.requestTimestamps.filter(t => t > oneMinuteAgo);
        if (requestsLastMinute.length >= rpmLimit) {
            const timeToWait = requestsLastMinute[0] - oneMinuteAgo;
            if (timeToWait > delayMs) {
                delayMs = timeToWait;
                limitHit = "RPM (Requests per minute)";
            }
        }

        // 5. Hard Limit: TPM
        const tokensLastMinute = this.tokenTimestamps.reduce((sum, entry) => sum + entry.tokens, 0);
        if (tokensLastMinute + estimatedTokens > tpmLimit) {
            let tokensToFree = (tokensLastMinute + estimatedTokens) - tpmLimit;
            let timeToWait = 0;
            let tokensFreed = 0;
            
            for (const entry of this.tokenTimestamps) {
                tokensFreed += entry.tokens;
                if (tokensFreed >= tokensToFree) {
                    timeToWait = entry.time - oneMinuteAgo;
                    break;
                }
            }
            if (timeToWait > delayMs) {
                delayMs = timeToWait;
                limitHit = "TPM (Tokens per minute)";
            }
        }

        if (delayMs > 0) {
            delayMs += 50; 
            console.info(`⏳ [Gemini] API request delayed for ${(delayMs / 1000).toFixed(1)} seconds to avoid hitting rate limit for ${limitHit}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const finalTime = Date.now();
        this.requestTimestamps.push(finalTime);
        const keyId = this.connectionId || 'gemini';
        localStorage.setItem(`${keyId}_request_timestamps`, JSON.stringify(this.requestTimestamps));
    }

    async _getAvailableModels() {
        const fallbackModels = [
            { value: "gemini-2.5-pro", label: "Gemini Pro (1M)", maxTokens: 1048576 },
            { value: "gemini-2.5-flash", label: "Gemini Flash (1M)", maxTokens: 1048576 },
            { value: "gemini-2.5-flash-lite", label: "Gemini Flash Lite (Preview, 1M)", maxTokens: 1000000 },
        ]; 

        if (!this.config.apiKey) {
            console.warn("[Gemini] API Key not set. Using fallback models.");
            const strippedFallbacks = fallbackModels.map(m => ({ ...m, value: this._stripModelPrefix(m.value) }));
            this._settingsSchema.model.enum = strippedFallbacks;
            if (this._settingsSchema.model.default.startsWith("models/")) {
                this._settingsSchema.model.default = this._stripModelPrefix(this._settingsSchema.model.default);
            }
            return strippedFallbacks;
        }

        const modelsApiUrl = `${this.config.server}/v1beta/models?key=${this.config.apiKey}`;

        try {
            console.log(`[Gemini] Fetching models from: ${modelsApiUrl}`);
            const response = await fetch(modelsApiUrl);

            if (!response.ok) {
                console.warn(`[Gemini] Failed to fetch models (Status: ${response.status}). Using fallback models. Response:`, response.statusText);
                const strippedFallbacks = fallbackModels.map(m => ({ ...m, value: this._stripModelPrefix(m.value) }));
                this._settingsSchema.model.enum = strippedFallbacks;
                 if (this._settingsSchema.model.default.startsWith("models/")) {
                    this._settingsSchema.model.default = this._stripModelPrefix(this._settingsSchema.model.default);
                }
                return strippedFallbacks;
            }

            const data = await response.json();
            
            if (!data.models || !Array.isArray(data.models)) {
                console.warn("[Gemini] API returned unexpected data format. Using fallback models.", data);
                const strippedFallbacks = fallbackModels.map(m => ({ ...m, value: this._stripModelPrefix(m.value) }));
                this._settingsSchema.model.enum = strippedFallbacks;
                 if (this._settingsSchema.model.default.startsWith("models/")) {
                    this._settingsSchema.model.default = this._stripModelPrefix(this._settingsSchema.model.default);
                }
                return strippedFallbacks;
            }

            // Removed detailed logging of raw models
            // console.log(`[Gemini] Raw models from API (${data.models.length} found):`, data.models.map(m => ({ name: m.name, displayName: m.displayName, supportedMethods: m.supportedGenerationMethods, tokenLimit: m.inputTokenLimit })));

            const capableModels = data.models
                .filter(model => 
                    model.supportedGenerationMethods && 
                    model.supportedGenerationMethods.includes("generateContent") &&
                    model.inputTokenLimit > 0 
                )
                .map(model => ({
                    value: this._stripModelPrefix(model.name), 
                    label: `${model.displayName || model.name} (${model.inputTokenLimit >= 1000 ? Math.round(model.inputTokenLimit / 1000) + 'k' : model.inputTokenLimit + ' tokens'})`,
                    maxTokens: model.inputTokenLimit
                }));
            
            // Removed detailed logging of filtered models
            // console.log(`[Gemini] Models passing capability filters (${capableModels.length} found):`, capableModels);

            const uniqueCapableModelsMap = new Map(capableModels.map(m => [m.value, m]));
            const finalModels = [];

            const processedFallbacks = fallbackModels.map(m => ({ ...m, value: this._stripModelPrefix(m.value) }));

            for (const fallbackModel of processedFallbacks) {
                if (uniqueCapableModelsMap.has(fallbackModel.value)) {
                    finalModels.push(uniqueCapableModelsMap.get(fallbackModel.value));
                    uniqueCapableModelsMap.delete(fallbackModel.value); 
                } else {
                    finalModels.push(fallbackModel);
                }
            }

            for (const model of uniqueCapableModelsMap.values()) {
                finalModels.push(model);
            }
            
            // Removed detailed logging of final models
            // console.log(`[Gemini] Final models for settings dropdown (${finalModels.length} found):`, finalModels);

            this._settingsSchema.model.enum = finalModels;

            if (this._settingsSchema.model.default.startsWith("models/")) {
                 this._settingsSchema.model.default = this._stripModelPrefix(this._settingsSchema.model.default);
            }
            const defaultModelExists = finalModels.some(m => m.value === this._settingsSchema.model.default);
            if (!defaultModelExists) {
                console.warn(`[Gemini] Default model '${this._settingsSchema.model.default}' not found or not capable. Resetting default.`);
                this._settingsSchema.model.default = finalModels[0]?.value || "gemini-2.5-flash";
                if (this.aiProvider === this._settingsSchema.model.default) { 
                    this.aiProvider = this._settingsSchema.model.default; 
                }
                console.log(`[Gemini] New default model set to: ${this._settingsSchema.model.default}`);
            }

            return finalModels;

        } catch (error) {
            console.error("[Gemini] Error fetching models:", error);
            const strippedFallbacks = fallbackModels.map(m => ({ ...m, value: this._stripModelPrefix(m.value) }));
            this._settingsSchema.model.enum = strippedFallbacks;
            if (this._settingsSchema.model.default.startsWith("models/")) {
                this._settingsSchema.model.default = this._stripModelPrefix(this._settingsSchema.model.default);
            }
            return strippedFallbacks; 
        }
    }

	async init() {
        await super.init(); 
        const keyId = this.connectionId || 'gemini';
        try {
            this.requestTimestamps = JSON.parse(localStorage.getItem(`${keyId}_request_timestamps`) || '[]');
            this.tokenTimestamps = JSON.parse(localStorage.getItem(`${keyId}_token_timestamps`) || '[]');
        } catch(e) {
            this.requestTimestamps = [];
            this.tokenTimestamps = [];
        }
        
        await this._getAvailableModels(); 

        const selectedModelInfo = this._settingsSchema.model.enum.find(
            model => model.value === this.config.model
        );
        if (selectedModelInfo && selectedModelInfo.maxTokens) {
            this.MAX_CONTEXT_TOKENS = selectedModelInfo.maxTokens;
        } else {
            const defaultModelInfo = this._settingsSchema.model.enum.find(m => m.value === this._settingsSchema.model.default);
            if (defaultModelInfo && defaultModelInfo.maxTokens) {
                this.MAX_CONTEXT_TOKENS = defaultModelInfo.maxTokens;
            } else {
                this.MAX_CONTEXT_TOKENS = 32768; 
            }
        }
        console.log(`[Gemini] Initialized with model: '${this.config.model}', MAX_CONTEXT_TOKENS: ${this.MAX_CONTEXT_TOKENS}`);
    }
    
    get _streamApiUrl() {
        return `${this.config.server}/v1beta/models/${this.config.model}:streamGenerateContent?key=${this.config.apiKey}`;
    }

    get _countTokensApiUrl() {
        return `${this.config.server}/v1beta/models/${this.config.model}:countTokens?key=${this.config.apiKey}`;
    }

    _toGeminiContents(messages) {
        const preprocessed = [];
        for (const msg of messages) {
            if (msg.type === 'file_context') {
                preprocessed.push(msg);
                continue;
            }
            
            const role = msg.role === 'model' ? 'model' : 'user';
            const last = preprocessed.length > 0 ? preprocessed[preprocessed.length - 1] : null;
            
            if (last && last.role === role && last.type !== 'file_context') {
                last.content = (last.content || '') + '\n\n' + (msg.content || '');
                if (msg.toolCalls) {
                    last.toolCalls = (last.toolCalls || []).concat(msg.toolCalls);
                }
                if (msg.thoughtSignature) {
                    last.thoughtSignature = msg.thoughtSignature;
                }
            } else {
                preprocessed.push({
                    ...msg,
                    role: role
                });
            }
        }

        const contents = [];
        for (const msg of preprocessed) {
            if (msg.role === 'user' || msg.role === 'model') {
                if (msg.role === 'user' && msg.content.startsWith('[Tool Response: ')) {
                    const parts = [];
                    const regex = /\[Tool Response: ([^\]]+)\]\n\n/g;
                    let match;
                    const matches = [];
                    
                    while ((match = regex.exec(msg.content)) !== null) {
                        matches.push({
                            toolName: match[1].split(' ')[0],
                            index: match.index,
                            contentStart: regex.lastIndex
                        });
                    }
                    
                    for (let i = 0; i < matches.length; i++) {
                        const current = matches[i];
                        const next = matches[i + 1];
                        let sectionContent = next ? msg.content.substring(current.contentStart, next.index) : msg.content.substring(current.contentStart);
                        
                        sectionContent = sectionContent.replace(/\n\n---\n\n$/, '').trim();
                        
                        parts.push({
                            functionResponse: {
                                name: current.toolName,
                                response: { result: sectionContent }
                            }
                        });
                    }

                    if (parts.length > 0) {
                        contents.push({
                            role: 'function',
                            parts: parts
                        });
                        continue;
                    }
                }
                
                if (msg.role === 'model') {
                    if (msg.toolCalls && msg.toolCalls.length > 0) {
                        const parts = [];
                        
                        // Extract any leading text (e.g., thoughts) before the first tool call from the content
                        let textPart = msg.content;
                        const toolCallIdx = msg.content.indexOf('<tool_call');
                        if (toolCallIdx !== -1) {
                            textPart = msg.content.substring(0, toolCallIdx).trim();
                        }
                        if (textPart) {
                            parts.push({ text: textPart });
                        }

                        for (const rawCall of msg.toolCalls) {
                            const callObj = rawCall.functionCall || rawCall;
                            let args = callObj.args || callObj.arguments || {};
                            if (typeof args === 'string') {
                                try {
                                    args = JSON.parse(args);
                                } catch (e) {
                                    console.error("[Gemini] Failed to parse tool call arguments as JSON:", args, e);
                                    args = {};
                                }
                            }
                            const functionCallPart = {
                                functionCall: {
                                    name: callObj.name,
                                    args: args
                                }
                            };
                            if (rawCall.thoughtSignature) {
                                functionCallPart.thoughtSignature = rawCall.thoughtSignature;
                            }
                            parts.push(functionCallPart);
                        }

                        contents.push({
                            role: 'model',
                            parts: parts
                        });
                        continue;
                    }
                }

                contents.push({ role: msg.role, parts: [{ text: msg.content }] });
            } else if (msg.type === 'file_context') {
                const fileContent = `--- File: ${msg.filename} ---\n\`\`\`${msg.language}\n${msg.content}\n\`\`\``;
                if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
                    contents[contents.length - 1].parts.push({ text: fileContent });
                } else {
                    contents.push({ role: 'user', parts: [{ text: fileContent }] });
                }
            }
        }
        return contents;
    }

    async _countTokens(messages) {
        if (!this.config.apiKey) {
            return 0;
        }
        try {
            const contents = this._toGeminiContents(messages);
            const requestBody = { contents };
            // if (this.config.system) {
            //     requestBody.systemInstruction = { parts: [{ text: this.config.system }] };
            // }

            const response = await fetch(this._countTokensApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorBody = await response.json();
                throw new Error(`Gemini API Error (countTokens): ${response.status} ${response.statusText} - ${errorBody.error?.message || JSON.stringify(errorBody)}`);
            }

            const data = await response.json();
            console.log(`[Gemini] Token count for ${this.config.model}: ${data.totalTokens} tokens`);
            return data.totalTokens || 0;
        } catch (error) {
            console.error("[Gemini] Error in _countTokens:", error);
            return this.estimateTokens(messages); 
        }
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
        let processedIndex = 0;
        let isReasoning = false;
        let thinkingStartTime = 0;
        let totalThinkingMs = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: true }); 

                while (true) {
                    const objectStartIndex = buffer.indexOf('{', processedIndex);
                    if (objectStartIndex === -1) {
                        break;
                    }

                    let braceCount = 0;
                    let objectEndIndex = -1;
                    let inString = false; 

                    for (let i = objectStartIndex; i < buffer.length; i++) {
                        const char = buffer[i];
                        
                        if (char === '"' && (i === 0 || buffer[i - 1] !== '\\')) {
                            inString = !inString;
                        }

                        if (!inString) {
                            if (char === '{') {
                                braceCount++;
                            } else if (char === '}') {
                                braceCount--;
                            }
                        }

                        if (braceCount === 0) {
                            objectEndIndex = i;
                            break;
                        }
                    }

                    if (objectEndIndex !== -1) {
                        const jsonString = buffer.substring(objectStartIndex, objectEndIndex + 1);
                        
                        let parsed;
                        try {
                            parsed = JSON.parse(jsonString);
                        } catch (e) {
                            // Malformed JSON, skip this chunk and continue trying to parse from the stream.
                            console.warn("[Gemini] Malformed JSON chunk in stream, skipping:", jsonString);
                            processedIndex = objectEndIndex + 1;
                            continue; // continue the `while(true)` loop
                        }

                        // Now that we have a valid JSON object, check for errors.
                        if (parsed.error) {
                            const errorMessage = `Gemini API Error: ${parsed.error.message} (Code: ${parsed.error.code}, Status: ${parsed.error.status})`;
                            throw new Error(errorMessage); // This will be caught by the outer try/catch of the function.
                        }

                        if (parsed.candidates && parsed.candidates[0]) {
                            const candidate = parsed.candidates[0];
                            
                            if (candidate.finishReason && candidate.finishReason !== "STOP") {
                                const msg = candidate.finishMessage || candidate.finishReason;
                                throw new Error(`Gemini stream aborted by API (finishReason: ${msg})`);
                            }

                            if (candidate.content && candidate.content.parts) {
                                for (const part of candidate.content.parts) {
                                    if (part.thoughtSignature) {
                                        callbacks.thoughtSignature = part.thoughtSignature;
                                    }
                                    if (part.text || part.thought) {
                                        const partThought = !!part.thought;
                                        const partText = part.text || '';
                                        if (partThought && !isReasoning) {
                                            isReasoning = true;
                                            thinkingStartTime = Date.now();
                                            fullResponseAccumulator += "<thought>\n" + partText;
                                        } else if (partThought && isReasoning) {
                                            if (partText) {
                                                fullResponseAccumulator += partText;
                                            }
                                        } else if (!partThought && isReasoning) {
                                            isReasoning = false;
                                            totalThinkingMs += Date.now() - thinkingStartTime;
                                            const backticks = fullResponseAccumulator.match(/```/g);
                                            if (backticks && backticks.length % 2 !== 0) {
                                                fullResponseAccumulator += "\n```\n";
                                            }
                                            fullResponseAccumulator += "\n</thought>\n" + partText;
                                        } else if (!partThought && !isReasoning) {
                                            if (partText) {
                                                fullResponseAccumulator += partText;
                                            }
                                        }
                                    } else if (part.functionCall) {
                                        if (isReasoning) {
                                            isReasoning = false;
                                            totalThinkingMs += Date.now() - thinkingStartTime;
                                            const backticks = fullResponseAccumulator.match(/```/g);
                                            if (backticks && backticks.length % 2 !== 0) {
                                                fullResponseAccumulator += "\n```\n";
                                            }
                                            fullResponseAccumulator += "\n</thought>\n";
                                        }

                                        if (!callbacks.toolCalls) callbacks.toolCalls = [];
                                        const rawCall = { functionCall: part.functionCall };
                                        if (part.thoughtSignature) {
                                            rawCall.thoughtSignature = part.thoughtSignature;
                                        }
                                        callbacks.toolCalls.push(rawCall);

                                        const toolName = part.functionCall.name;
                                        const args = part.functionCall.args || {};
                                        let xmlToolCall = `\n<tool_call name="${toolName}">\n`;
                                        for (const [key, value] of Object.entries(args)) {
                                            const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
                                            xmlToolCall += `  <${key}>${stringValue}</${key}>\n`;
                                        }
                                        xmlToolCall += `</tool_call>\n`;
                                        fullResponseAccumulator += xmlToolCall;
                                    }
                                }
                                callbacks.totalThinkingMs = totalThinkingMs;
                                if (onUpdate) onUpdate(fullResponseAccumulator);
                            }
                        }
                        processedIndex = objectEndIndex + 1;
                    } else {
                        break;
                    }
                }

                if (done) {
                    if (isReasoning) {
                        isReasoning = false;
                        totalThinkingMs += Date.now() - thinkingStartTime;
                        const backticks = fullResponseAccumulator.match(/```/g);
                        if (backticks && backticks.length % 2 !== 0) {
                            fullResponseAccumulator += "\n```\n";
                        }
                        fullResponseAccumulator += "\n</thought>";
                        if (onUpdate) onUpdate(fullResponseAccumulator);
                    }
                    buffer = ''; 
                    processedIndex = 0;
                    break;
                }
            }
            return { fullResponseAccumulator, totalThinkingMs };
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw error; // Let the outer functions handle intentional aborts cleanly
            }
            console.error("[Gemini] Error processing API response stream:", error);
            if (onError) onError(error);
            throw error;
        }
    }

    async generate(prompt, callbacks = {}) {
        const { onStart, onError, onDone, onContextRatioUpdate } = callbacks;
        if (onStart) onStart();

        const maxAttempts = 3;
        const backoffs = [10000, 15000, 20000];
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;
            this.abortController = new AbortController();

            try {
                const isGemmaModel = this.config.model.includes('gemma');
                let userPromptContent = prompt;
                const requestBody = {};

                // Gemma models do not support `systemInstruction`; prepend to prompt instead.
                if (this.config.system && isGemmaModel) {
                    userPromptContent = `${this.config.system}\n\n${prompt}`;
                } else if (this.config.system) {
                    requestBody.systemInstruction = { parts: [{ text: this.config.system }] };
                }

                // Truncate prompt if it exceeds maxInputTokens
                const limit = this.config.maxInputTokens;
                if (limit > 0) {
                    const tokens = await this._countTokens([{ role: "user", content: userPromptContent }]);
                    if (tokens > limit) {
                        const ratio = limit / tokens;
                        const keepLen = Math.floor(userPromptContent.length * ratio);
                        userPromptContent = userPromptContent.substring(0, keepLen);
                        console.warn(`[Gemini] Truncated single prompt to ${keepLen} chars to fit maxInputTokens limit of ${limit}`);
                    }
                }

                if (supportsThinking) {
                    requestBody.generationConfig = requestBody.generationConfig || {};
                    let budget = 2048;
                    const level = this.config.thinkingLevel || "medium";
                    if (level === 'off') {
                        budget = 0;
                    } else if (level === 'low') {
                        budget = 1024;
                    } else if (level === 'med' || level === 'medium') {
                        budget = 2048;
                    } else if (level === 'high') {
                        budget = 4096;
                    } else if (level === 'unlimited' || level === 'ultra') {
                        budget = 32768;
                    }
                    requestBody.generationConfig.thinkingConfig = {
                        thinkingBudget: budget
                    };
                }

                requestBody.contents = [{ role: "user", parts: [{ text: userPromptContent }] }];
                
                if (window.ui?.aiManager?.agentMode) {
                    const isPlanning = window.ui?.aiManager?.planningMode === true;
                    const filteredTools = cadenceTools.filter(t => !(isPlanning && (t.name === "create_file" || t.name === "edit_file")));
                    const geminiTools = filteredTools.map(t => {
                        const properties = {};
                        for (const [k, v] of Object.entries(t.parameters.properties)) {
                            properties[k] = { ...v, type: v.type.toUpperCase() };
                        }
                        return {
                            name: t.name,
                            description: t.description,
                            parameters: {
                                type: t.parameters.type.toUpperCase(),
                                properties,
                                required: t.parameters.required
                            }
                        };
                    });
                    requestBody.tools = [{ functionDeclarations: geminiTools }];
                }

                requestBody.safetySettings = [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ];

                const currentTokens = await this._countTokens([{ role: "user", content: userPromptContent }]);
                const contextRatio = currentTokens / this.MAX_CONTEXT_TOKENS;

                if (onContextRatioUpdate) {
                    onContextRatioUpdate(contextRatio);
                }

                await this._enforceRateLimits(currentTokens);

                const requestStartTime = Date.now();
                const response = await fetch(this._streamApiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                    signal: this.abortController.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP error! Status: ${response.status}, Message: ${errorText}`);
                }

                const reader = response.body.getReader();
                const { fullResponseAccumulator: fullResponse, totalThinkingMs } = await this._processApiResponseStream(reader, callbacks);
                const requestEndTime = Date.now();
                
                const finalTokens = await this._countTokens([{ role: "user", content: prompt }, { role: "model", content: fullResponse }]);
                const outputTokens = Math.max(0, finalTokens - currentTokens);
                const finalContextRatio = finalTokens / this.MAX_CONTEXT_TOKENS;

                this.tokenTimestamps.push({ time: Date.now(), tokens: finalTokens });
                localStorage.setItem(`${keyId}_token_timestamps`, JSON.stringify(this.tokenTimestamps));

                this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, Math.round(totalThinkingMs / 1000));

                if (onDone) {
                    onDone(fullResponse, Math.round(finalContextRatio * 100));
                }

                return; // Success! Exit the function

            } catch (error) {
                if (error && error.name === 'AbortError') {
                    const reasonStr = this.abortReason ? `: ${this.abortReason}` : " by Cadence Agent Protocol.";
                    console.info(`⏸️ [Gemini] Generate intentionally halted${reasonStr}`);
                    this.abortReason = null;
                    return;
                }
                
                if (typeof error === 'string') {
                    console.info(`⏸️ [Gemini] Generate intentionally halted: ${error}`);
                    return;
                }

                // Check if we can retry on temporary unavailable (503/UNAVAILABLE) errors
                const isUnavailable = this._isTemporaryUnavailableError(error);
                if (isUnavailable && attempt < maxAttempts) {
                    const delay = backoffs[attempt - 1] || 10000;
                    console.warn(`⏳ [Gemini] Temporary unavailable error (attempt ${attempt}/${maxAttempts}). Retrying in ${delay / 1000}s... Error: ${error.message}`);
                    try {
                        await this._sleep(delay, this.abortController.signal);
                        continue; // Proceed to next attempt
                    } catch (sleepErr) {
                        if (sleepErr.name === 'AbortError') {
                            console.info("⏸️ [Gemini] Retry sleep aborted.");
                            return;
                        }
                    }
                }

                // If not retryable, or we ran out of attempts, raise to the caller
                console.error(`[Gemini] Error in generate after attempt ${attempt}/${maxAttempts}:`, error);
                if (onError) onError(error);
                return;
            }
        }
    }

    async chat(messages, callbacks = {}, systemPrompt=null, session=null) {
        const { onStart, onError, onDone, onContextRatioUpdate } = callbacks;
        if (onStart) onStart();

        const maxAttempts = 3;
        const backoffs = [10000, 15000, 20000];
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;
            this.abortController = new AbortController();
            
            try {
                const isGemmaModel = this.config.model.includes('gemma');
                const effectiveSystemPrompt = systemPrompt || this.config.system;
                let processedMessages = [...messages];
                
                // Truncate context window to fit maxInputTokens
                const limit = this.config.maxInputTokens;
                if (limit > 0) {
                    let estimatedSum = 0;
                    let keepCount = 0;
                    for (let i = processedMessages.length - 1; i >= 0; i--) {
                        const msg = processedMessages[i];
                        const charCount = (msg.content || "").length;
                        const est = Math.ceil(charCount / 3.8);
                        if (estimatedSum + est > limit && keepCount > 0) {
                            break;
                        }
                        estimatedSum += est;
                        keepCount++;
                    }
                    
                    let candidateMessages = processedMessages.slice(processedMessages.length - keepCount);
                    let actualTokens = await this._countTokens(candidateMessages);
                    while (actualTokens > limit && candidateMessages.length > 1) {
                        candidateMessages.shift();
                        actualTokens = await this._countTokens(candidateMessages);
                    }
                    processedMessages = candidateMessages;
                    console.info(`[Gemini] Truncated context to ${processedMessages.length} messages (${actualTokens} tokens) to fit maxInputTokens limit of ${limit}`);
                }

                const requestBody = {};

                if (effectiveSystemPrompt) {
                    if (isGemmaModel) {
                        // For Gemma, inject system prompt into the first user message.
                        // Create a copy of the specific message object to avoid mutating the original
                        const firstUserMessageIndex = processedMessages.findIndex(m => m.role === 'user');
                        if (firstUserMessageIndex !== -1) {
                            processedMessages[firstUserMessageIndex] = {
                                ...processedMessages[firstUserMessageIndex],
                                content: `${effectiveSystemPrompt}\n\n${processedMessages[firstUserMessageIndex].content}`
                            };
                        }
                    } else {
                        // For other models, use the standard systemInstruction field.
                        requestBody.systemInstruction = { parts: [{ text: effectiveSystemPrompt }] };
                    }
                }

                const supportsThinking = this.config.model.includes('thinking') || this.config.model.includes('pro') || this.config.model.includes('2.0') || this.config.model.includes('2.5') || this.config.model.includes('3.1') || this.config.model.includes('3.5');
                if (supportsThinking) {
                    requestBody.generationConfig = requestBody.generationConfig || {};
                    let budget = 2048;
                    const sessionLevel = session?.thinkingLevel;
                    const level = (sessionLevel && sessionLevel !== 'auto') ? sessionLevel : (this.config.thinkingLevel || "medium");
                    if (session && session.disableReasoning === true) {
                        budget = 0;
                    } else if (level === 'off') {
                        budget = 0;
                    } else if (level === 'low') {
                        budget = 1024;
                    } else if (level === 'med' || level === 'medium') {
                        budget = 2048;
                    } else if (level === 'high') {
                        budget = 4096;
                    } else if (level === 'unlimited' || level === 'ultra') {
                        budget = 32768;
                    }
                    requestBody.generationConfig.thinkingConfig = {
                        thinkingBudget: budget
                    };
                }

                requestBody.generationConfig = requestBody.generationConfig || {};
                if (session && session.temperatureOverride !== undefined) {
                    requestBody.generationConfig.temperature = session.temperatureOverride;
                } else if (this.config.temperature !== undefined) {
                    requestBody.generationConfig.temperature = this.config.temperature;
                }

                requestBody.contents = this._toGeminiContents(processedMessages);
                
                if (window.ui?.aiManager?.agentMode || (session && session.parentId)) {
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
                    const geminiTools = filteredTools.map(t => {
                        const properties = {};
                        for (const [k, v] of Object.entries(t.parameters.properties)) {
                            properties[k] = { ...v, type: v.type.toUpperCase() };
                        }
                        return {
                            name: t.name,
                            description: t.description,
                            parameters: {
                                type: t.parameters.type.toUpperCase(),
                                properties,
                                required: t.parameters.required
                            }
                        };
                    });
                    requestBody.tools = [{ functionDeclarations: geminiTools }];
                }

                requestBody.safetySettings = [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ];

                const currentTokens = await this._countTokens(processedMessages);
                const contextRatio = currentTokens / this.MAX_CONTEXT_TOKENS;

                if (onContextRatioUpdate) {
                    onContextRatioUpdate(contextRatio);
                }

                await this._enforceRateLimits(currentTokens);

                const requestStartTime = Date.now();
                const response = await fetch(this._streamApiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                    signal: this.abortController.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP error! Status: ${response.status}, Message: ${errorText}`);
                }

                const reader = response.body.getReader();
                const { fullResponseAccumulator: fullResponse, totalThinkingMs } = await this._processApiResponseStream(reader, callbacks);
                const requestEndTime = Date.now();
                
                messages.push({ role: "model", content: fullResponse });

                const sentMessagesWithResponse = [...processedMessages, { role: "model", content: fullResponse }];
                const finalTokens = await this._countTokens(sentMessagesWithResponse);
                const outputTokens = Math.max(0, finalTokens - currentTokens);
                const finalContextRatio = finalTokens / this.MAX_CONTEXT_TOKENS;
                if (onContextRatioUpdate) {
                    onContextRatioUpdate(finalContextRatio);
                }

                this.tokenTimestamps.push({ time: Date.now(), tokens: finalTokens });
                const keyId = this.connectionId || 'gemini';
                localStorage.setItem(`${keyId}_token_timestamps`, JSON.stringify(this.tokenTimestamps));

                this.recordTelemetry(currentTokens, outputTokens, requestEndTime - requestStartTime, Math.round(totalThinkingMs / 1000));

                if (onDone) {
                    onDone(fullResponse, Math.round(finalContextRatio * 100));
                }

                return; // Success! Exit the function

            } catch (error) {
                if (error && error.name === 'AbortError') {
                    const reasonStr = this.abortReason ? `: ${this.abortReason}` : " by Cadence Agent Protocol.";
                    console.info(`⏸️ [Gemini] Stream generation intentionally halted${reasonStr}`);
                    this.abortReason = null;
                    return;
                }
                
                if (typeof error === 'string') {
                    console.info(`⏸️ [Gemini] Stream generation intentionally halted: ${error}`);
                    return;
                }

                // Check if we can retry on temporary unavailable (503/UNAVAILABLE) errors
                const isUnavailable = this._isTemporaryUnavailableError(error);
                if (isUnavailable && attempt < maxAttempts) {
                    const delay = backoffs[attempt - 1] || 10000;
                    console.warn(`⏳ [Gemini] Temporary unavailable error (attempt ${attempt}/${maxAttempts}). Retrying in ${delay / 1000}s... Error: ${error.message}`);
                    try {
                        await this._sleep(delay, this.abortController.signal);
                        continue; // Proceed to next attempt
                    } catch (sleepErr) {
                        if (sleepErr.name === 'AbortError') {
                            console.info("⏸️ [Gemini] Retry sleep aborted.");
                            return;
                        }
                    }
                }

                // If not retryable, or we ran out of attempts, raise to the caller
                console.error(`[Gemini] Error in chat after attempt ${attempt}/${maxAttempts}:`, error);
                if (onError) onError(error);
                return;
            }
        }
    }
    
    async setOptions(newSettings, onErrorCallback, onSuccessCallback, useWorkspaceSettings, source = 'global') {
	    let changesApplied = false;
	    for (const key in newSettings) {
	        if (newSettings.hasOwnProperty(key)) {
                let val = newSettings[key];
                if (key === 'model' && typeof val === 'string' && val.startsWith("models/")) {
                    val = this._stripModelPrefix(val);
                }
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
	
	    const selectedModelInfo = this._settingsSchema.model.enum?.find(
            model => model.value === this.config.model
        );
        if (selectedModelInfo && selectedModelInfo.maxTokens) {
            this.MAX_CONTEXT_TOKENS = selectedModelInfo.maxTokens;
        } else {
            const defaultModelInfo = this._settingsSchema.model.enum?.find(m => m.value === this._settingsSchema.model.default);
            if (defaultModelInfo && defaultModelInfo.maxTokens) {
                this.MAX_CONTEXT_TOKENS = defaultModelInfo.maxTokens;
            } else {
                this.MAX_CONTEXT_TOKENS = 32768; 
            }
        }
	
	    if (changesApplied) {
	    	if("function" == typeof onSuccessCallback) {
	        	onSuccessCallback("Settings saved successfully.");
	    	}
	        const event = new CustomEvent('setting-changed', {
	            detail: {
	                settingsName: 'geminiConfig', 
	                settings: { ...this.config }, 
	                useWorkspaceSettings: useWorkspaceSettings,
	                source: this._settingsSource
	            }
	        });
	        window.dispatchEvent(event);
	    }
    }

    clearContext() {
        console.log("Gemini internal context cleared (AIManager manages chat history).");
    }

    async refreshModels() {
        const freshModels = await this._getAvailableModels();
        this._settingsSchema.model.enum = freshModels; 

        const currentModelValid = freshModels.some(m => m.value === this.config.model);
        if (!currentModelValid) {
            console.warn(`[Gemini] Current model '${this.config.model}' is no longer available or valid. Resetting.`);
            const newDefault = this._settingsSchema.model.default; 
            this.config.model = newDefault; 
            
            const defaultModelInfo = freshModels.find(m => m.value === newDefault);
            if (defaultModelInfo && defaultModelInfo.maxTokens) {
                this.MAX_CONTEXT_TOKENS = defaultModelInfo.maxTokens;
            } else {
                this.MAX_CONTEXT_TOKENS = 32768; 
            }
            
            console.log(`[Gemini] Model reset to default: '${this.config.model}' with MAX_CONTEXT_TOKENS: ${this.MAX_CONTEXT_TOKENS}`);

            window.dispatchEvent(new CustomEvent('setting-changed', {
                detail: {
                    settingsName: 'geminiConfig', 
                    settings: { ...this.config }, 
                    source: this._settingsSource
                }
            }));
        } else {
            console.log(`[Gemini] Refreshed models. Current model '${this.config.model}' remains valid.`);
        }
    }
}

export default Gemini;
