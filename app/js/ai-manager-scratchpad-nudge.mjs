// ai-manager-scratchpad-nudge.mjs
//
// Ephemeral scratchpad nudge for context pressure.
//
// When the agent's dynamic context (dialogue window + evergreen extras) grows past a
// threshold ratio of the connection's maxPrefill, the model starts losing working
// state. The scratchpad exists for exactly this, but the model often never writes to
// it until it's too late. This module decides whether to append an ephemeral (never
// persisted) system directive to the outgoing prompt that nudges the model to call
// scratchpad_write — and only when the agent hasn't already used the scratchpad
// within the visible context (so the nudge self-clears once the model complies).
//
// Pure & node-importable: no DOM, no imports. Mirrors the architecture of
// ai-manager-cull-index.mjs (pure helpers consumed by ai-manager-history.mjs and
// verified by tests/test-scratchpad-nudge.mjs against these real production exports).

const SCRATCHPAD_WRITE_TOOL = "scratchpad_write";
const TOOL_RESPONSE_MARKER = `[Tool Response: ${SCRATCHPAD_WRITE_TOOL}]`;

/**
 * Scan a message array for evidence of a scratchpad_write tool call:
 *  - native tool call: msg.toolCalls[].name or msg.toolCalls[].functionCall.name
 *  - serialized marker: content containing "[Tool Response: scratchpad_write]"
 * Returns true on the first hit.
 *
 * @param {Array} messages - the visible dialogue window (messages the model will see)
 * @returns {boolean}
 */
export function hasScratchpadWriteInWindow(messages) {
	if (!Array.isArray(messages)) return false;
	for (const msg of messages) {
		if (!msg) continue;
		if (Array.isArray(msg.toolCalls)) {
			for (const tc of msg.toolCalls) {
				if (!tc) continue;
				const callObj = tc.functionCall || tc;
				if (callObj && callObj.name === SCRATCHPAD_WRITE_TOOL) return true;
			}
		}
		if (typeof msg.content === "string" && msg.content.includes(TOOL_RESPONSE_MARKER)) {
			return true;
		}
	}
	return false;
}

/**
 * Gate: should we inject the ephemeral nudge into the outgoing prompt?
 *
 * Injects when ALL of:
 *  - maxTok > 0 (a prefill budget is configured)
 *  - dynamicContextTokens >= ratio * maxTok (context pressure)
 *  - the visible context contains no scratchpad_write call (self-clearing)
 *
 * @param {object}  opts
 * @param {string}  [opts.scratchpad]           - current scratchpad content (reserved for future tuning, e.g. skip when already large)
 * @param {Array}   [opts.visibleDialogue]      - visible context window (messages the model will see)
 * @param {number}  opts.dynamicContextTokens   - estimated tokens of the full outgoing context (window + evergreen extras)
 * @param {number}  opts.maxTok                - connection maxPrefill token budget
 * @param {number}  [opts.ratio=0.9]           - pressure threshold as a fraction of maxTok
 * @returns {{shouldInject: boolean, reason: string, pct: number}}
 */
export function shouldInjectScratchpadNudge({ scratchpad, visibleDialogue, dynamicContextTokens, maxTok, ratio = 0.9 } = {}) {
	const pct = maxTok > 0 && Number.isFinite(dynamicContextTokens)
		? Math.round((dynamicContextTokens / maxTok) * 100)
		: 0;

	if (!(maxTok > 0)) {
		return { shouldInject: false, reason: "no prefill budget configured (maxTok unset)", pct };
	}
	if (!Number.isFinite(dynamicContextTokens)) {
		return { shouldInject: false, reason: "dynamic context token estimate unavailable", pct };
	}
	if (dynamicContextTokens < ratio * maxTok) {
		return { shouldInject: false, reason: `below pressure threshold (${pct}% < ${Math.round(ratio * 100)}%)`, pct };
	}
	if (hasScratchpadWriteInWindow(visibleDialogue)) {
		return { shouldInject: false, reason: "scratchpad_write already used within visible window (self-clearing)", pct };
	}
	return { shouldInject: true, reason: `context pressure (${pct}% >= ${Math.round(ratio * 100)}%) and no scratchpad_write in visible window`, pct };
}

/**
 * Build the ephemeral directive text. Uses the [SYSTEM] prefix convention: trailing
 * array-internal system messages degrade to user turns on most providers, so the
 * prefix makes provenance explicit (mirrors the agent directives block).
 *
 * @param {number} pct - context pressure as a percent of the prefill budget
 * @returns {string}
 */
export function buildScratchpadNudgeContent(pct) {
	return `[SYSTEM] Context pressure: the visible context is at ~${pct}% of the prefill budget. Before continuing, call scratchpad_write (mode: 'append') to persist your key findings, decisions, and next steps to your evergreen scratchpad so they survive context pruning. Keep it concise (4KB max).`;
}

export default { hasScratchpadWriteInWindow, shouldInjectScratchpadNudge, buildScratchpadNudgeContent };
