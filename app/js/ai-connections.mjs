// ai-connections.mjs
import Ollama from "./ai-ollama.mjs";
import Claude from "./ai-claude.mjs";
import Gemini from "./ai-gemini.mjs";
import LlamaCpp from "./ai-llamacpp.mjs";

const PROVIDERS = {
	ollama: Ollama,
	claude: Claude,
	gemini: Gemini,
	llamacpp: LlamaCpp
};

// Token-based context pre-fill options for connections.
// "none" means no explicit bound (falls back to legacy 40%/80% of n_ctx).
export const PREFILL_OPTIONS = [
	{ value: "none", label: "None" },
	{ value: "8k", label: "8k", tokens: 8192 },
	{ value: "16k", label: "16k", tokens: 16384 },
	{ value: "24k", label: "24k", tokens: 24576 },
	{ value: "32k", label: "32k", tokens: 32768 },
	{ value: "48k", label: "48k", tokens: 49152 },
	{ value: "64k", label: "64k", tokens: 65536 },
	{ value: "80k", label: "80k", tokens: 81920 },
	{ value: "96k", label: "96k", tokens: 98304 },
	{ value: "128k", label: "128k", tokens: 131072 },
	{ value: "160k", label: "160k", tokens: 163840 },
	{ value: "192k", label: "192k", tokens: 196608 },
	{ value: "256k", label: "256k", tokens: 262144 }
];

// Map a prefill enum value ("8k", "256k", ...) to absolute tokens.
// Returns null for "none" or unset/unknown values.
export function resolvePrefillTokens(value) {
	if (!value || value === "none") return null;
	const opt = PREFILL_OPTIONS.find(o => o.value === value);
	return opt ? opt.tokens : null;
}

class AIConnections {
	constructor() {
		this.connections = [];
		this.defaultConnectionId = null;
		this.instances = new Map(); // id -> AI adapter instance
	}

	init() {
		this.load();
		if (this.connections.length === 0) {
			// Populate default fallback connections
			this.connections = [
				{
					id: "default-gemini",
					name: "Gemini default",
					provider: "gemini",
					size: "medium",
					config: {
						apiKey: "",
						server: "https://generativelanguage.googleapis.com",
						model: "gemini-2.5-flash",
						thinkingLevel: "medium",
						rpmLimit: 15,
						tpmLimit: 250000,
						rpdLimit: 500,
						maxTurns: 50,
						stripCodeBlocksFromContext: false
					}
				},
				{
					id: "default-llamacpp",
					name: "Llama.cpp default",
					provider: "llamacpp",
					size: "medium",
					config: {
						server: "http://localhost:8080",
						model: "unknown",
						n_ctx: 0,
						n_predict: 4096,
						temperature: 0.7,
						top_p: 0.9,
						top_k: 40,
						thinkingLevel: "medium",
						maxTurns: 0,
						system: "",
						stop: ["</s>", "<|end|>", "<|im_end|>", "Llama:", "User:", "Assistant:"]
					}
				}
			];
			this.defaultConnectionId = "default-gemini";
			this.save();
		}
	}

	load() {
		try {
			const data = localStorage.getItem("cadence_connections");
			if (data) {
				this.connections = JSON.parse(data);
			}
			const defId = localStorage.getItem("cadence_default_connection_id");
			if (defId) {
				this.defaultConnectionId = defId;
			}
		} catch (e) {
			console.error("Failed to load connections:", e);
		}
	}

	save() {
		try {
			localStorage.setItem("cadence_connections", JSON.stringify(this.connections));
			if (this.defaultConnectionId) {
				localStorage.setItem("cadence_default_connection_id", this.defaultConnectionId);
			}
			
			// Update active instances config
			for (const conn of this.connections) {
				if (this.instances.has(conn.id)) {
					const instance = this.instances.get(conn.id);
					instance.config = { ...instance.config, ...conn.config };
				}
			}

			window.dispatchEvent(new CustomEvent('connections-changed'));
		} catch (e) {
			console.error("Failed to save connections:", e);
		}
	}

	getConnections() {
		return this.connections;
	}

	getConnection(id) {
		return this.connections.find(c => c.id === id);
	}

	// Best-known context size (n_ctx) for a connection, used to suppress
	// prefill options that exceed the provider's context window.
	// llamacpp: stored config.n_ctx if set, else live instance MAX_CONTEXT_TOKENS.
	// Other providers: live instance MAX_CONTEXT_TOKENS. Returns 0 if unknown.
	connectionContextSize(conn) {
		if (!conn) return 0;
		if (conn.provider === "llamacpp" && Number(conn.config?.n_ctx) > 0) {
			return Number(conn.config.n_ctx);
		}
		const instance = this.instances.get(conn.id);
		if (instance && Number(instance.MAX_CONTEXT_TOKENS) > 0) {
			return Number(instance.MAX_CONTEXT_TOKENS);
		}
		return 0;
	}

	getInstance(id) {
		if (this.instances.has(id)) {
			return this.instances.get(id);
		}
		const conn = this.getConnection(id);
		if (!conn) return null;

		const ProviderClass = PROVIDERS[conn.provider];
		if (!ProviderClass) return null;

		const instance = new ProviderClass();
		instance.connectionId = id;
		instance.config = { ...instance.config, ...conn.config };
		this.instances.set(id, instance);
		
		// Initialize the instance asynchronously
		instance.init().catch(err => {
			console.warn(`Failed to initialize connection instance ${id}:`, err);
		});

		return instance;
	}

	async testConnection(connConfig) {
		const ProviderClass = PROVIDERS[connConfig.provider];
		if (!ProviderClass) throw new Error(`Unknown provider: ${connConfig.provider}`);
		const testInstance = new ProviderClass();
		testInstance.config = { ...testInstance.config, ...connConfig.config };
		
		if (connConfig.provider === "llamacpp") {
			const serverUrl = testInstance.config.server;
			const res = await fetch(`${serverUrl}/health`);
			if (!res.ok) {
				throw new Error(`Server returned status: ${res.status}`);
			}
			// Load props to verify/refresh model paths
			await testInstance.refreshModels();
			connConfig.config.model = testInstance.config.model;
			connConfig.config.n_ctx = testInstance.config.n_ctx;
			return {
				model: testInstance.config.model,
				maxTokens: testInstance.MAX_CONTEXT_TOKENS
			};
		} else if (connConfig.provider === "gemini") {
			if (!testInstance.config.apiKey) {
				throw new Error("API Key is required");
			}
			const models = await testInstance._getAvailableModels();
			if (!models || models.length === 0) {
				throw new Error("Failed to fetch available Gemini models");
			}
			return {
				models: models.map(m => m.value)
			};
		} else if (connConfig.provider === "ollama") {
			const models = await testInstance._getAvailableModels();
			if (!models || models.length === 0 || models.every(m => !m.value)) {
				throw new Error("Failed to connect or fetch models from Ollama");
			}
			return {
				models: models.map(m => m.value)
			};
		} else if (connConfig.provider === "claude") {
			if (!testInstance.config.apiKey) {
				throw new Error("API Key is required");
			}
			const models = await testInstance._getAvailableModels();
			if (!models || models.length === 0) {
				throw new Error("Failed to fetch available Claude models");
			}
			return {
				models: models.map(m => m.value)
			};
		}
		return {};
	}

	saveConnection(conn) {
		const index = this.connections.findIndex(c => c.id === conn.id);
		if (index !== -1) {
			this.connections[index] = conn;
		} else {
			this.connections.push(conn);
		}

		// Update active instance if it exists
		if (this.instances.has(conn.id)) {
			const instance = this.instances.get(conn.id);
			instance.config = { ...instance.config, ...conn.config };
			instance.init().catch(console.error);
		}

		this.save();
		
		// Dispatch event
		window.dispatchEvent(new CustomEvent('connections-changed'));
	}

	deleteConnection(id) {
		const index = this.connections.findIndex(c => c.id === id);
		if (index !== -1) {
			const deleted = this.connections.splice(index, 1)[0];
			this.instances.delete(id);
			if (this.defaultConnectionId === id) {
				this.defaultConnectionId = this.connections[0]?.id || null;
			}
			this.save();
			window.dispatchEvent(new CustomEvent('connections-changed'));
			return deleted;
		}
		return null;
	}

	setDefaultConnection(id) {
		if (this.connections.some(c => c.id === id)) {
			this.defaultConnectionId = id;
			this.save();
			window.dispatchEvent(new CustomEvent('connections-changed'));
			return true;
		}
		return false;
	}
}

export default new AIConnections();
