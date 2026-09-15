// ai-probe.mjs
const CAP_STORE = 'cadence_model_capabilities';
const TRANSIENT = new Map();

export const PROBE_PRESETS = {
	coding: { temperature: 0.2, top_p: 0.9, thinkingLevel: 'low' },
	planning: { temperature: 0.7, top_p: 0.95, thinkingLevel: 'high' },
	default: null
};

const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

const STATE_META = {
	locked: { icon: '\u{1F512}', label: 'Fixed', tip: 'The model/server rejects this parameter. It cannot be changed.' },
	preset: { icon: '\u{1F511}', label: 'Restricted', tip: 'Only specific values are accepted (listed below).' },
	unlocked: { icon: '\u{1F513}', label: 'Adjustable', tip: 'This parameter accepts custom values and was verified live.' },
	unverified: { icon: '\u{2753}', label: 'Unconfirmed', tip: 'Could not confirm the value takes effect. It may be silently ignored.' }
};

const COMPAT_FAMILIES = new Set(['openai', 'openrouter', 'vllm', 'lmstudio', 'llamacpp', 'unknown']);

export function guessFamilyFromUrl(server) {
	const s = String(server || '').toLowerCase();
	if (s.includes('openrouter')) return 'openrouter';
	if (s.includes('anthropic')) return 'anthropic';
	if (s.includes('generativelanguage')) return 'gemini';
	if (s.includes('11434') || s.includes('/ollama')) return 'ollama';
	return 'openai';
}

export function familyLabel(family) {
	const labels = {
		openai: 'OpenAI-compatible',
		openrouter: 'OpenRouter',
		ollama: 'Ollama',
		llamacpp: 'Llama.cpp',
		anthropic: 'Anthropic',
		gemini: 'Gemini',
		vllm: 'vLLM',
		lmstudio: 'LM Studio',
		unknown: 'Unknown'
	};
	return labels[family] || family || 'Unknown';
}

export function isCompatFamily(family) {
	return COMPAT_FAMILIES.has(family);
}

export function stateMeta(state) {
	return STATE_META[state] || STATE_META.unverified;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function readJson(res) {
	try {
		return await res.json();
	} catch (e) {
		return null;
	}
}

function noteFrom(res, json) {
	if (json && (json.error || json.error_message)) {
		const err = json.error || json.error_message;
		if (typeof err === 'string') return err;
		if (err && (err.message || err.type)) return err.message || err.type;
	}
	return res.statusText || `HTTP ${res.status}`;
}

function errorFieldMessage(json) {
	if (!json) return '';
	const err = json.error || json.error_message;
	let msg = '';
	if (typeof err === 'string') msg = err;
	else if (err && typeof err.message === 'string') msg = err.message;
	else if (typeof json.message === 'string') msg = json.message;
	return msg || '';
}

export async function detectFamily(serverUrl, { timeoutMs = 3000 } = {}) {
	const base = String(serverUrl || '').replace(/\/+$/, '');
	if (!base) return 'unknown';
	try {
		const tags = await fetchWithTimeout(`${base}/api/tags`, {}, timeoutMs);
		if (tags.ok) return 'ollama';
	} catch (e) {}
	try {
		const health = await fetchWithTimeout(`${base}/health`, {}, timeoutMs);
		if (health.ok) {
			const info = await readJson(health);
			if (!info || info.status === 'ok' || info.status === 'loading' || info.status === 'done' || info.version) {
				return 'llamacpp';
			}
		}
	} catch (e) {}
	try {
		const props = await fetchWithTimeout(`${base}/props`, {}, timeoutMs);
		if (props.ok) return 'llamacpp';
	} catch (e) {}
	const modelsPaths = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
	for (const p of modelsPaths) {
		try {
			const models = await fetchWithTimeout(p, {}, timeoutMs);
			if (models.ok || models.status === 401 || models.status === 403) {
				return /openrouter/i.test(base) ? 'openrouter' : 'openai';
			}
		} catch (e) {}
	}
	return guessFamilyFromUrl(base);
}

function openaiChatUrl(base) {
	return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export async function probeChat(config, { model, params = {}, timeoutMs = 8000, maxTokens = 16 } = {}) {
	const server = String(config.server || '').replace(/\/+$/, '');
	let family = config._family;
	if (!family) {
		const guess = guessFamilyFromUrl(server);
		family = (guess === 'openai' || guess === 'llamacpp') ? await detectFamily(server) : guess;
		config._family = family;
	}
	const start = Date.now();
	const messages = [{ role: 'user', content: 'Reply ok' }];
	let url = '';
	let init = null;

	if (family === 'ollama') {
		url = `${server}/api/chat`;
		const body = { model, messages, stream: false };
		if (Object.keys(params).length > 0) body.options = params;
		init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
	} else if (family === 'anthropic') {
		url = `${server}/v1/messages`;
		const body = { model, max_tokens: maxTokens, messages };
		if (Object.keys(params).length > 0) Object.assign(body, params);
		init = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': config.apiKey || '',
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify(body)
		};
	} else if (family === 'gemini') {
		url = `${server}/v1beta/models/${model}:generateContent`;
		const body = { contents: [{ parts: [{ text: 'Reply ok' }] }] };
		if (Object.keys(params).length > 0) body.generationConfig = params;
		const headers = { 'Content-Type': 'application/json' };
		if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
		init = { method: 'POST', headers, body: JSON.stringify(body) };
	} else {
		url = openaiChatUrl(server);
		const body = { model, messages, stream: false, max_tokens: maxTokens };
		if (Object.keys(params).length > 0) Object.assign(body, params);
		init = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey || ''}` },
			body: JSON.stringify(body)
		};
	}

	try {
		const res = await fetchWithTimeout(url, init, timeoutMs);
		const json = await readJson(res);
		const ok = res.ok;
		return {
			ok,
			status: res.status,
			family,
			latencyMs: Date.now() - start,
			body: json,
			error: ok ? null : noteFrom(res, json),
			errorMessage: ok ? '' : errorFieldMessage(json)
		};
	} catch (err) {
		return {
			ok: false,
			status: 0,
			family,
			latencyMs: Date.now() - start,
			body: null,
			error: err.name === 'AbortError' ? 'Probe timed out' : (err.message || String(err)),
			errorMessage: err.message || String(err)
		};
	}
}

function mentions(json, key) {
	const msg = errorFieldMessage(json).toLowerCase();
	return msg.includes(key.toLowerCase()) || (json && json.type && String(json.type).toLowerCase().includes(key.toLowerCase()));
}

export async function probeParam(config, model, key, { valid, invalid }) {
	const accepted = await probeChat(config, { model, params: { [key]: valid } });
	if (!accepted.ok) {
		return { key, state: 'locked', note: `Rejected by server: ${accepted.error}`, inserted: valid, probedAt: Date.now() };
	}
	const invalidTest = await probeChat(config, { model, params: { [key]: invalid } });
	if (!invalidTest.ok) {
		return { key, state: 'unlocked', note: 'Custom values accepted (verified live)', probedAt: Date.now() };
	}
	return { key, state: 'unverified', note: 'Accepted, but the effect cannot be confirmed', probedAt: Date.now() };
}

export async function probeReasoning(config, model) {
	const candidates = [
		{ key: 'reasoning', wrap: 'object', value: { effort: 'high' }, mode: 'openrouter' },
		{ key: 'reasoning_effort', wrap: 'flat', value: 'high', mode: 'o-series' },
		{ key: 'thinking', wrap: 'object', value: { type: 'enabled', budget_tokens: 1024 }, mode: 'budget' },
		{ key: 'think', wrap: 'flat', value: true, mode: 'flat' }
	];
	const probedAt = Date.now();
	for (const cand of candidates) {
		const res = await probeChat(config, { model, params: { [cand.key]: cand.value } });
		if (res.ok) {
			const effortValues = cand.mode === 'openrouter' ? ['high', 'medium', 'low', 'none', 'xhigh', 'max'] : ['high', 'medium', 'low', 'xhigh', 'max'];
			const accepted = [];
			for (const val of effortValues) {
				const probeValue = cand.wrap === 'object' ? { [cand.key]: cand.mode === 'openrouter' ? { effort: val } : { type: 'enabled', budget_tokens: 1024 } } : { [cand.key]: cand.mode === 'openrouter' ? { effort: val } : val };
				const vres = await probeChat(config, { model, params: probeValue });
				if (vres.ok) accepted.push(val);
				if (vres.ok && (cand.mode === 'openrouter' || cand.mode === 'o-series')) {
					if (accepted.length >= 2 && !vres.ok) break;
				}
			}
			return {
				accepted: true,
				key: cand.key,
				mode: cand.mode,
				wrap: cand.wrap,
				effortAllowed: accepted.filter(v => v !== 'none'),
				supportsOff: accepted.includes('none') || cand.mode === 'budget',
				probedAt
			};
		}
		if (!res.ok && res.errorMessage && !mentions(res.body || {}, cand.key)) {
			continue;
		}
		if (!res.ok && res.status !== 400 && res.status !== 422) {
			continue;
		}
	}
	return { accepted: false, probedAt };
}

export function pickProbeModel(models) {
	const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string' && m.trim());
	if (list.length === 0) return null;
	if (list.length === 1) return list[0];
	const hints = ['free', 'mini', 'flash', 'lite', 'small', 'nano', 'tiny', ':free'];
	const scored = list.map(m => {
		const lower = m.toLowerCase();
		let score = 0;
		for (const h of hints) if (lower.includes(h)) score -= 10;
		return { model: m, score, len: m.length + (lower.includes('/') ? lower.lastIndexOf('/') : 0) };
	});
	scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.len - b.len));
	return scored[0].model;
}

export function investigateModel(config, model, { timeoutMs = 8000 } = {}) {
	return Promise.resolve().then(async () => {
		const family = config._family || guessFamilyFromUrl(config.server) || 'openai';
		const start = Date.now();
		const base = await probeChat(config, { model, timeoutMs });
		const record = {
			family,
			model,
			server: config.server,
			probedAt: Date.now(),
			latencyMs: Date.now() - start,
			probeOk: base.ok,
			error: base.error || null,
			params: {},
			reasoning: null,
			preset: 'default'
		};
		if (!base.ok) return record;
		const [temperature, topP, topK] = await Promise.all([
			probeParam(config, model, 'temperature', { valid: 0.9, invalid: -1000 }),
			probeParam(config, model, 'top_p', { valid: 0.5, invalid: -1000 }),
			probeParam(config, model, 'top_k', { valid: 10, invalid: -1 })
		]);
		record.params.temperature = temperature;
		record.params.top_p = topP;
		record.params.top_k = topK;
		record.reasoning = await probeReasoning(config, model);
		if (record.reasoning && record.reasoning.accepted && temperature.state === 'locked') {
			record.params.temperature.note = `${record.params.temperature.note} Reasoning model may require temperature to be omitted.`;
		}
		return record;
	});
}

export function setCapability(connId, model, record, { persist = false } = {}) {
	if (!connId || !model) return;
	const key = `${connId}:${model}`;
	TRANSIENT.set(key, record);
	if (persist) writeSaved({ ...readSaved(), [key]: record });
}

export function getCapability(connId, model, { server } = {}) {
	if (!connId || !model) return undefined;
	const key = `${connId}:${model}`;
	let record = TRANSIENT.get(key);
	if (!record) record = readSaved()[key];
	if (record && server && record.server !== server) return undefined;
	return record;
}

export function commitCapabilities(connId) {
	if (!connId) return;
	const saved = readSaved();
	let changed = false;
	for (const [key, record] of TRANSIENT) {
		if (key.startsWith(`${connId}:`)) {
			saved[key] = record;
			changed = true;
		}
	}
	if (changed) writeSaved(saved);
}

export function clearTransient(connId) {
	if (!connId) return;
	for (const key of [...TRANSIENT.keys()]) {
		if (key.startsWith(`${connId}:`)) TRANSIENT.delete(key);
	}
}

export function pruneCapabilities(validIds) {
	const ids = new Set(validIds || []);
	writeSaved(Object.fromEntries(Object.entries(readSaved()).filter(([key]) => ids.has(key.split(':')[0]))));
}

function readSaved() {
	try {
		if (typeof localStorage === 'undefined') return {};
		const raw = localStorage.getItem(CAP_STORE);
		return raw ? JSON.parse(raw) : {};
	} catch (e) {
		return {};
	}
}

function writeSaved(data) {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(CAP_STORE, JSON.stringify(data || {}));
	} catch (e) {
		console.warn('[AIProbe] Failed to persist capabilities:', e);
	}
}

export function effFromLevel(level) {
	const map = { off: null, low: 'low', medium: 'medium', high: 'high', unlimited: 'high' };
	return map[level] || 'medium';
}

export function applyReasoningToBody(body, reasoning, level) {
	if (!reasoning || !reasoning.accepted) return body;
	const want = effFromLevel(level);
	if (reasoning.mode === 'openrouter') {
		if ((level === 'off' || want === null) && reasoning.supportsOff) {
			body.reasoning = { enabled: false };
			return body;
		}
		body.reasoning = { effort: pickAllowed(reasoning, want) };
	} else if (reasoning.mode === 'o-series') {
		if (level === 'off' || want === null) return body;
		body.reasoning_effort = pickAllowed(reasoning, want);
	} else if (reasoning.mode === 'budget' && level !== 'off') {
		const mult = level === 'low' ? 1 : level === 'high' ? 3 : 2;
		body.thinking = { type: 'enabled', budget_tokens: 1024 * mult };
	}
	return body;
}

function pickAllowed(reasoning, want) {
	const allowed = reasoning.effortAllowed || [];
	if (allowed.length === 0) return want;
	if (allowed.includes(want)) return want;
	let best = allowed[0];
	let bestDelta = Infinity;
	for (const val of allowed) {
		const delta = Math.abs(EFFORT_LEVELS.indexOf(want) - EFFORT_LEVELS.indexOf(val));
		if (delta < bestDelta) {
			bestDelta = delta;
			best = val;
		}
	}
	return best;
}