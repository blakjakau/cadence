// ai-manager-cull-index.mjs
//
// Pure, dependency-free helpers for model-lead context pruning (the `cull_history` tool).
// Kept browser-free (no DOM, no window, no custom elements) so unit tests can import the
// REAL production logic rather than a drift-prone copy.
//
// Index space contract (the user's #1 concern — raw array index vs. the model's VISIBLE
// dialogue position):
//   cull_history(N) means "keep the Nth visible dialogue turn onward." N is a 0-based
//   position counted over ONLY the culleable dialogue turns the model actually sees, in
//   display order. Raw array positions into `chatHistory` are NOT used as keys because
//   they diverge from what the model sees whenever:
//     - window-pruning inserts `pruned-gap-*` / `system_message` gap markers (visible to
//       the model in contextForAI, but not counted as dialogue turns here); or
//     - empty model turns are omitted from contextForAI (they occupy a raw slot but the
//       model never sees them as a turn).
//   Evergreen prepends (compacted_history summary, plan/tasks, scratchpad, task status) and
//   [SYSTEM] directives are NOT culleable dialogue turns and are not counted.

// Turn types that represent a real, culleable dialogue turn.
export const CULLEABLE_TYPES = new Set([
	'user',
	'agent',
	'model',
	'tool_response',
	'compacted_history',
	'cycle_summary',
]);

/**
 * Build the transient visible-turn -> messageId map for `cull_history(idx)`.
 *
 * @param {Array<object>} chatHistory - The (already window-pruned) dialogue array.
 * @returns {Map<number,string>} visibleTurnIndex -> message id (or `__diag_<rawPos>` fallback).
 */
export function buildCullIndex(chatHistory) {
	const cullIndex = new Map();
	let visibleTurn = 0;
	for (let p = 0; p < chatHistory.length; p++) {
		const msg = chatHistory[p];
		if (!msg || !CULLEABLE_TYPES.has(msg.type)) continue;
		// Omit empty model turns from the count — they are also hidden from contextForAI.
		if (msg.role === 'model' && !isNonEmptyModelTurn(msg)) continue;
		const id = msg.id != null ? msg.id : `__diag_${p}`;
		cullIndex.set(visibleTurn, id);
		visibleTurn++;
	}
	return cullIndex;
}

/** A model turn is "non-empty" if it has trimmed content OR pending tool calls. */
export function isNonEmptyModelTurn(msg) {
	if (msg && msg.toolCalls && msg.toolCalls.length > 0) return true;
	if (msg && msg.content && String(msg.content).trim()) return true;
	return false;
}

/**
 * Validate a `cull_history` index against a cullIndex map and resolve the target message id.
 * Pure (no session persistence) so it is unit-testable. The caller persists the result.
 *
 * @param {Map<number,string>|null|undefined} cullIndex
 * @param {number} idx
 * @returns {{ok: boolean, error?: string, newHeadId?: string}}
 */
export function resolveCullTarget(cullIndex, idx) {
	if (!cullIndex || cullIndex.size === 0) {
		return { ok: false, error: 'Cull index unavailable (no dialogue context to prune).' };
	}
	if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= cullIndex.size || !cullIndex.has(idx)) {
		return { ok: false, error: `Invalid cull index ${JSON.stringify(idx)}. Must be a 0-based index of a visible dialogue turn (0..${cullIndex.size - 1}).` };
	}
	return { ok: true, newHeadId: cullIndex.get(idx) };
}
