// ai.mjs
export default class AI {
	constructor() {
		this._editor = null;
		this.connectionId = null; // Associated connection config ID
		this.config = {
			maxTurns: 0
		}; // Internal configuration object
		this._settingsSchema = {}; // Schema for settings metadata
        this._settingsSource = 'global'; // 'global' or 'workspace'
		this.providerId = 'generic'; // Override in subclasses
		this._telemetryRequests = []; 
		this._telemetryTokens = []; 
		this._totalTokensIn = 0;
		this._totalTokensOut = 0;
	}
	
	async init() {
		this._loadTelemetry();
	}

	_loadTelemetry() {
		try {
			const keyId = this.connectionId || this.providerId;
			const data = localStorage.getItem(`telemetry_${keyId}`);
			if (data) {
				const parsed = JSON.parse(data);
				this._telemetryRequests = parsed.requests || [];
				this._telemetryTokens = parsed.tokens || [];
				this._totalTokensIn = parsed.totalTokensIn || 0;
				this._totalTokensOut = parsed.totalTokensOut || 0;
			}
		} catch (e) {
			console.warn("Failed to load telemetry data", e);
		}
	}

	_saveTelemetry() {
		try {
			// Clean up old telemetry data (older than 1 minute)
			const oneMinuteAgo = Date.now() - 60000;
			this._telemetryRequests = this._telemetryRequests.filter(t => t > oneMinuteAgo);
			
			// Always preserve at least the last 5 tokens entries for rolling average calculations
			if (this._telemetryTokens.length > 5) {
				const lastFive = this._telemetryTokens.slice(-5);
				const others = this._telemetryTokens.slice(0, -5).filter(t => t.time > oneMinuteAgo);
				this._telemetryTokens = [...others, ...lastFive];
			} else {
				this._telemetryTokens = this._telemetryTokens.filter(t => t.time > oneMinuteAgo);
			}

			const keyId = this.connectionId || this.providerId;
			localStorage.setItem(`telemetry_${keyId}`, JSON.stringify({
				requests: this._telemetryRequests,
				tokens: this._telemetryTokens,
				totalTokensIn: this._totalTokensIn,
				totalTokensOut: this._totalTokensOut
			}));
		} catch (e) {
			console.warn("Failed to save telemetry data", e);
		}
	}

	recordTelemetry(tokensIn, tokensOut, elapsedMs = 0, secondsThinking = 0) {
		const now = Date.now();
		this._telemetryRequests.push(now);
		this._telemetryTokens.push({ time: now, tokens: tokensIn + tokensOut, elapsedMs, secondsThinking });
		this._totalTokensIn += tokensIn;
		this._totalTokensOut += tokensOut;
		this._saveTelemetry();
	}

	resetTelemetry() {
		this._telemetryRequests = [];
		this._telemetryTokens = [];
		this._totalTokensIn = 0;
		this._totalTokensOut = 0;
		try {
			const keyId = this.connectionId || this.providerId;
			localStorage.removeItem(`telemetry_${keyId}`);
		} catch (e) {
			console.warn("Failed to reset telemetry data", e);
		}
	}

	get tokensPerSec() {
		if (this._telemetryTokens.length > 0) {
			const last = this._telemetryTokens[this._telemetryTokens.length - 1];
			if (last.elapsedMs > 0) {
				return Math.round((last.tokens) / (last.elapsedMs / 1000));
			}
		}
		return 0;
	}

	get averageTokensPerSec() {
		const validResponses = this._telemetryTokens
			.filter(t => t.elapsedMs > 0)
			.slice(-5);
		
		if (validResponses.length === 0) return 0;
		
		const sumTps = validResponses.reduce((sum, t) => {
			const tps = t.tokens / (t.elapsedMs / 1000);
			return sum + tps;
		}, 0);
		
		return Math.round(sumTps / validResponses.length);
	}

	get tokensPerMin() {
		const now = Date.now();
		const oneMinuteAgo = now - 60000;
		return this._telemetryTokens.filter(t => t.time > oneMinuteAgo).reduce((sum, t) => sum + t.tokens, 0);
	}

	get requestsPerMin() {
		const now = Date.now();
		const oneMinuteAgo = now - 60000;
		return this._telemetryRequests.filter(t => t > oneMinuteAgo).length;
	}

	get secondsPerRequest() {
		const rpm = this.requestsPerMin;
		if (rpm === 0) return 0;
		return 60 / rpm;
	}

	get secondsThinking() {
		if (this._telemetryTokens.length > 0) {
			const last = this._telemetryTokens[this._telemetryTokens.length - 1];
			return last.secondsThinking || 0;
		}
		return 0;
	}

	set editor(editor) {
		this._editor = editor;
	}

	get editor() {
		return this._editor;
	}

	get settingsSource() {
		return this._settingsSource;
	}

	// Public interface for settings
	getOption(name) {
		const setting = this._settingsSchema[name];
		if (!setting) return undefined;
		return { ...setting, value: this.config[name] };
	}

	async getOptions() {
		const options = {};
		for (const name in this._settingsSchema) {
			const setting = this._settingsSchema[name];
			let enumValues = setting.enum;
			if (setting.lookupCallback) {
				enumValues = await setting.lookupCallback();
			}
			options[name] = { ...setting, value: this.config[name], enum: enumValues };
		}
		return options;
	}

	isConfigured() { 
		return false
	}

	get supportsJSONTools() {
		return false;
	}

	get supportsReasoning() {
		return false;
	}

	get supportsParallelTools() {
		return false;
	}

	setOption(name, value) {
		if (this._settingsSchema[name]) {
			this.config[name] = value;
			return true;
		}
		return false;
	}

	setOptions(newConfig) {
		for (const name in newConfig) {
			this.setOption(name, newConfig[name]);
		}
	}

    saveSettings(newConfig, useWorkspaceSettings, appConfig, workspaceConfig) {
        throw new Error("saveSettings must be implemented by subclass");
    }

	async _readEditor(){
		if (!this.editor) return;
		// read  either the selection, or the full text
		const selection = this.editor.getSelectionRange();
		const selectedText = this.editor.session.getTextRange(selection);
		const fileContent = selectedText || this.editor.getValue();

		// get the current mode and code language
		const mode = this.editor.getOption("mode"); // e.g., "ace/mode/javascript"
		const language = mode.split('/').pop(); // e.g., "javascript"

		if (fileContent) {
			const config = this.editor?.tabs?.activeTab?.config;
			const filename = config?.name || "unknown"; 
			const path = config?.path || filename;

			if (selectedText) {
				return { source: "selection", path: `selection:${path}`, type: "code", language: language, content: fileContent, isSelection: true };
			} else {
				return { source: filename, path: path, type: "file", language: language, content: fileContent, isSelection: false };
			}
		}
		return;
	}

    // Existing _readOpenBuffers (no change needed as _getTabSessionByPath is more direct for apply diff)
    async _readOpenBuffers() {
        const openFilesContent = [];
        const allTabs = this._getAllOpenTabs(); // Use the new helper

        for (const tabInfo of allTabs) {
            try {
                if (!tabInfo.config || !tabInfo.config.session) continue;

                const filename = tabInfo.config.name;
                const path = tabInfo.config.path;
                const session = tabInfo.config.session;
                const content = session.getValue();
                const modeId = session.$modeId; 
                const language = modeId ? modeId.split('/').pop() : 'text'; 

                if (content && filename !== 'untitled' && path) {
                    openFilesContent.push({ 
                        source: filename, 
                        path: path, 
                        type: "file", 
                        language: language, 
                        content: content, 
                        isSelection: false 
                    });
                }
            } catch (e) {
                console.error("Error reading content from an open editor tab:", tabInfo, e);
            }
        }
        return openFilesContent;
    }

    // NEW METHOD: Helper to get all open tabs regardless of pane
    _getAllOpenTabs() {
        const allTabs = [];
        if (window.ui && window.ui.leftTabs && window.ui.leftTabs.tabs) {
            allTabs.push(...window.ui.leftTabs.tabs);
        }
        if (window.ui && window.ui.rightTabs && window.ui.rightTabs.tabs) {
            allTabs.push(...window.ui.rightTabs.tabs);
        }
        // Ensure uniqueness by path, preferring left over right if path duplicates
        const uniqueTabsMap = new Map();
        for (const tab of allTabs) {
            if (tab.config && tab.config.path && !uniqueTabsMap.has(tab.config.path)) {
                uniqueTabsMap.set(tab.config.path, tab);
            }
        }
        return Array.from(uniqueTabsMap.values());
    }

    // NEW METHOD: Finds an open tab's full info object by its file path
    async _getTabSessionByPath(targetPath) {
        if (!targetPath) return null;
        const openTabs = this._getAllOpenTabs();
        
        const cleanPath = (p) => p ? p.replace(/\\/g, '/') : '';
        const normTarget = cleanPath(targetPath);

        const matches = openTabs.filter(tab => {
            if (!tab.config || !tab.config.path || !tab.config.session) return false;
            const normTabPath = cleanPath(tab.config.path);
            if (normTabPath === normTarget) return true;
            if (normTabPath.endsWith('/' + normTarget) || normTarget.endsWith('/' + normTabPath)) {
                return true;
            }
            return false;
        });

        if (matches.length > 0) {
            if (matches.length > 1) {
                console.warn(`Multiple tabs match path suffix: ${targetPath}`);
            }
            return matches[0];
        }
        return null;
    }
	/**
	 * Finds a file's data from the workspace index by its path.
	 * It prioritizes exact matches but can also find files based on partial end paths.
	 * @param {string} targetPath - The path (or partial path) of the file to find.
	 * @returns {object|null} The file data object from the index or null if not found.
	 */
	_findFileByPath(targetPath) {
		if (!window.ui?.fileList?.index?.files) return null;
		const files = window.ui.fileList.index.files;
		// Normalize targetPath to remove leading '@' or '/' for matching
		const normalizedTargetPath = targetPath.replace(/^[@/]+/, '');
		// 1. Prioritize exact match on full path
		let foundFile = files.find(f => f.path === normalizedTargetPath);
		if (foundFile) return foundFile;
		// 2. If not, find a file that *ends with* the provided path.
		foundFile = files.find(f => f.path.endsWith(normalizedTargetPath));
		if (foundFile) return foundFile;
		
		// 3. Final fallback: check just by filename
		foundFile = files.find(f => f.name === normalizedTargetPath);
		return foundFile || null;
	}
	/**
	 * Simplifies a full file path to the shortest possible unique path within the workspace.
	 * @param {string} fullPath - The complete path of the file.
	 * @param {Array<string>} allFilePaths - An array of all file paths in the workspace.
	 * @returns {string} The simplified, unique path.
	 */
	_simplifyPath(fullPath, allFilePaths) {
		const pathParts = fullPath.split('/').filter(p => p);
		const filename = pathParts[pathParts.length - 1];
		if (!filename) return fullPath;
		// Check if the filename alone is unique
		const filesWithSameName = allFilePaths.filter(p => p.endsWith(`/${filename}`));
		if (filesWithSameName.length <= 1) {
			return filename;
		}
		// If not unique, add parent directories one by one until it is unique
		for (let i = pathParts.length - 2; i >= 0; i--) {
			const simplified = pathParts.slice(i).join('/');
			const filesWithSameSimplifiedPath = allFilePaths.filter(p => p.endsWith(`/${simplified}`));
			if (filesWithSameSimplifiedPath.length <= 1) {
				return simplified;
			}
		}
		// If all else fails, return the full path (but without any pesky leading slash)
		return fullPath.startsWith('/') ? fullPath.substring(1) : fullPath;
	}
	/**
	 * Processes the user's prompt to extract `@` tags for context inclusion.
	 * @param {string} prompt - The original user prompt.
	 * @param {'chat' | 'generate'} runMode - The current run mode.
	 * @param {Array<string>} evergreenFiles - List of persistent file paths to include as context.
	 * @param {boolean} agentMode - Whether agent mode is enabled.
	 * @returns {Promise<{processedPrompt: string, contextItems: Array<Object>}>}
	 */
	async _getContextualPrompt(prompt, runMode, evergreenFiles = [], agentMode = false) {
        let processedPrompt = prompt;
        const contextItems = [];
		const allFilePaths = window.ui?.fileList?.index?.files.map(f => f.path) || [];
		const processedPaths = new Set();
        
        // --- Pre-process Evergreen Files ---
        if (!agentMode) {
            for (const pathString of evergreenFiles) {
                if (processedPaths.has(pathString)) continue;
                processedPaths.add(pathString);
                const fileData = this._findFileByPath(pathString);
                if (!fileData) continue;
                let tab = await this._getTabSessionByPath(fileData.path);
                if (!tab && window.ui?.fileList?.open) {
                    await window.ui.fileList.open(fileData);
                    tab = await this._getTabSessionByPath(fileData.path);
                }
                if (tab) {
                    contextItems.push({
                        type: "file_context",
                        id: fileData.path,
                        filename: fileData.name,
                        language: tab.config.mode.name || 'text',
                        content: tab.config.session.getValue(),
                        isSelection: false
                    });
                }
            }
        }

		if (this.editor && prompt.includes("@")) {
			// --- Phase 1: Handle @/path/to/file.ext tags ---
			// Regex to find any @-mention followed by non-space characters.
			const fileTagRegex = /@(\S+)/g;
			let match;
			while ((match = fileTagRegex.exec(prompt)) !== null) {
				const fullTag = match[0]; // e.g., "@src/main.mjs"
				const pathString = match[1]; // e.g., "src/main.mjs"

				// Skip if it's a known keyword like @code or @open, which are handled in Phase 2
				if (['code', 'current', 'open'].includes(pathString)) {
					continue;
				}

				if (processedPaths.has(pathString)) continue;
				processedPaths.add(pathString);
				const fileData = this._findFileByPath(pathString);
				if (!fileData) continue;
				let tab = await this._getTabSessionByPath(fileData.path);
				if (!tab && window.ui?.fileList?.open) {
					await window.ui.fileList.open(fileData);
					tab = await this._getTabSessionByPath(fileData.path);
				}
				if (tab) {
					contextItems.push({
						type: "file_context",
						id: fileData.path,
						filename: fileData.name,
						language: tab.config.mode.name || 'text',
						content: tab.config.session.getValue(),
						isSelection: false
					});
					const simplifiedPath = this._simplifyPath(fileData.path, allFilePaths);
					const tagToReplaceRegex = new RegExp(fullTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
					processedPrompt = processedPrompt.replace(tagToReplaceRegex, `\`${simplifiedPath}\``);
				}
			}
			// --- Phase 2: Handle keyword tags like @code and @open ---
			// Note: This operates on the already-modified `processedPrompt`.
			const keywords = [
				{ tag: "@code", handler: async () => [await this._readEditor()] },
				{ tag: "@current", handler: async () => [await this._readEditor()] },
				{ tag: "@open", handler: async () => await this._readOpenBuffers() }
			];
			for (const { tag, handler } of keywords) {
				if (processedPrompt.includes(tag)) {
					const items = await handler();
					if (items && items.length > 0) {
						items.forEach(item => {
							if (item && item.path) { // Ensure item is valid
								contextItems.push({
									type: "file_context",
									id: item.path,
									filename: item.source,
									language: item.language,
									content: item.content,
									isSelection: item.isSelection
								});
							}
						});
					}
					processedPrompt = processedPrompt.replace(new RegExp(tag, "ig"), "");
				}
			}
			// Deprecated fallback for original generate mode.
			if (runMode === "generate") {
				const item = await this._readEditor();
				if (item) {
                    openFilesContentString = "\n\n(No open files found or available via editor API)\n\n";
                }
                
                if (runMode === "generate") {
                    processedPrompt = processedPrompt.replace(/@open/ig, openFilesContentString);
                }
            }
            
            // Clean up all tags for chat mode after processing
            if (runMode === "chat") {
                processedPrompt = processedPrompt.replace(/@(code|current|open)/ig, "");
            }
            // If after processing tags, the prompt is just whitespace, set a default message
            if (runMode === "chat" && processedPrompt.trim() === "" && contextItems.length > 0) {
                // do nothing!
            }
		}
        processedPrompt = processedPrompt.trim(); // Clean up any extra whitespace from replacements
        return { processedPrompt, contextItems };
    }

	/**
     * Estimates the token count for a given text or array of messages.
     * This is a very rough character-based estimate (e.g., 1 token per 4 characters)
     * used when a precise token counting API is not available.
     * @param {string | Array<Object>} messages The text string or array of messages.
     * @returns {number} Estimated token count.
     */
    async tokenize(content) {
        return null;
    }

	/**
     * Estimates the token count for a given text or array of messages.
     * This is a very rough character-based estimate (e.g., 1 token per 3.2 characters)
     * used when a precise token counting API is not available.
     * @param {string | Array<Object>} messages The text string or array of messages.
     * @returns {number} Estimated token count.
     */
    estimateTokens(messages) {
        if (typeof messages === 'string') {
            return Math.ceil(messages.length / 3.2);
        } else if (Array.isArray(messages)) {
            let totalLength = 0;
            let totalTokens = 0;
            for (const msg of messages) {
                // If it already has an exact tokenCount, use it directly!
                if (typeof msg.tokenCount === 'number') {
                    totalTokens += msg.tokenCount;
                    continue;
                }

                // IMPORTANT: Only count content that would be sent to the AI
                // The `type: 'error'` or `type: 'system_message'` should not contribute to AI tokens.
                if (msg.type === 'file_context' && msg.content) {
                    // Include context messages, also consider the "framing" text like filename and code block markers
                    // This estimation should match how _prepareMessagesForAI formats file_context for AI (using the full path from msg.id)
                    const fileContentForAI = `--- File: ${msg.id || msg.filename || 'unknown'} ---\n\`\`\`${msg.language || ''}\n${msg.content}\n\`\`\``;
                    totalLength += fileContentForAI.length;
                } else if (msg.role === 'user' || msg.role === 'model' || msg.role === 'assistant' || msg.role === 'system' || msg.role === 'tool') {
                    totalLength += (msg.content || '').length;
                }
            }
            return totalTokens + Math.ceil(totalLength / 3.2);
        }
        return 0;
    }

	_isTemporaryUnavailableError(error) {
		if (!error || !error.message) return false;
		const msg = error.message.toUpperCase();
		
		// Exclude rate limit and access denied explicitly
		if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("RATE_LIMIT")) {
			return false;
		}
		if (msg.includes("403") || msg.includes("401") || msg.includes("ACCESS_DENIED") || msg.includes("PERMISSION_DENIED") || msg.includes("API_KEY")) {
			return false;
		}
		
		// Include 503 or UNAVAILABLE
		if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
			return true;
		}
		
		return false;
	}

	_sleep(ms, signal) {
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timeout);
				reject(new DOMException("Aborted", "AbortError"));
			};
			if (signal?.aborted) {
				return onAbort();
			}
			const timeout = setTimeout(() => {
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			if (signal) {
				signal.addEventListener("abort", onAbort);
			}
		});
	}

	async _fetchWithRetry(url, options = {}, retryConfig = {}) {
		const {
			maxRetries = 3,
			initialDelayMs = 1000,
			maxDelayMs = 30000,
			signal = null
		} = retryConfig;

		let attempt = 0;
		while (true) {
			if (signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}

			try {
				const response = await fetch(url, { ...options, signal });
				
				// Handle 429 Too Many Requests or 5xx Temporary Server Errors
				const isRateLimit = response.status === 429;
				const isServerError = response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;

				if ((isRateLimit || isServerError) && attempt < maxRetries) {
					attempt++;
					let delayMs = initialDelayMs * Math.pow(2, attempt - 1);
					
					// Check for Retry-After header
					const retryAfterHeader = response.headers.get("retry-after") || response.headers.get("Retry-After");
					if (retryAfterHeader) {
						const seconds = parseFloat(retryAfterHeader);
						if (!isNaN(seconds) && seconds > 0) {
							delayMs = seconds * 1000;
						}
					} else {
						// Add jitter (+/- 25%)
						const jitter = (Math.random() * 0.5 - 0.25) * delayMs;
						delayMs = Math.min(maxDelayMs, Math.max(500, Math.round(delayMs + jitter)));
					}

					const reasonStr = isRateLimit ? "Rate limit (429)" : `Server error (${response.status})`;
					console.warn(`⏳ [${this.providerId || 'AI'}] ${reasonStr} encountered. Retrying in ${(delayMs / 1000).toFixed(1)}s (Attempt ${attempt} of ${maxRetries})...`);
					
					await this._sleep(delayMs, signal);
					continue;
				}

				return response;
			} catch (fetchError) {
				if (fetchError.name === "AbortError" || signal?.aborted) {
					throw fetchError;
				}

				if (attempt < maxRetries) {
					attempt++;
					const delayMs = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500);
					console.warn(`⏳ [${this.providerId || 'AI'}] Network fetch error (${fetchError.message}). Retrying in ${(delayMs / 1000).toFixed(1)}s (Attempt ${attempt} of ${maxRetries})...`);
					await this._sleep(delayMs, signal);
					continue;
				}

				throw fetchError;
			}
		}
	}

	generate(messages, callbacks) {
		throw new Error("Not implemented");
	}

	chat(messages, callbacks, systemPrompt = null, session = null) {
		throw new Error("Not implemented");
	}
}

