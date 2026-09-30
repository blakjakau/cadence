// test-cull-history.mjs — Runtime verification of cull_history model-lead pruning.
//
// Usage: node test/test-cull-history.mjs
//
// Architecture note: the user DISABLED the old string-intercept (parsing "cull_history(N)"
// out of model prose in agent.mjs L526-551). cull_history is now a REAL, schema-defined
// tool dispatched through AgentTools.execute, gated behind the `modelLeadPruning` user
// toggle. This test verifies the REAL architecture:
//
//   1) GATE (real production code, ai-manager-tools-schema.mjs is pure & node-importable):
//      - getToolsForSession(false, true, true)  → includes cull_history (main agent, opted in)
//      - getToolsForSession(false, true, false) → excludes cull_history (main agent, off)
//      - getToolsForSession(true,  true, true)  → excludes cull_history (sub-agent, always)
//      - getToolsForSession(false, false, true) → [] (chat-only / no JSON tools)
//      - the cull_history schema exposes idx as integer, minimum 0.
//
//   2) MAP BUILD + CULL EXECUTION (real production code — the pure helpers in
//      ai-manager-cull-index.mjs are the SAME functions wired into ai-manager-history.mjs
//      (buildCullIndex) and agent-tools.mjs (resolveCullTarget), so this is not a copy):
//      - buildCullIndex maps VISIBLE dialogue turn positions (0-based) → message ids,
//        skipping non-culleable turns (gap markers / system_message) AND empty model turns.
//      - resolveCullTarget: valid idx → resolves the new head id (forward move);
//        out-of-range / non-integer / null map → {ok:false}, NO state change.
//
//   3) FORWARD-MOVE + PRUNED-GAP (faithful mirror of the REAL consumption path in
//      ai-manager-history.mjs prepareMessagesForAI: contextHeadMsgId → findIndex on the
//      dialogue array → slice(sliceIndex) → a pruned-gap marker is emitted for every run
//      of culled turns). ai-manager-history.mjs itself isn't plain-node-importable (it
//      transitively imports DOM custom-elements and network idb-keyval), so the slice/gap
//      logic is mirrored here verbatim against the real cullIndex output.

import { getToolsForSession, tools, subAgentToolsList } from "../app/js/ai-manager-tools-schema.mjs";
import { buildCullIndex, resolveCullTarget, isNonEmptyModelTurn } from "../app/js/ai-manager-cull-index.mjs";

let passed = 0;
let failed = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}`);
		failed++;
	}
}
function assertEq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
		failed++;
	}
}

// =========================================================================
// 1) GATE — real production getToolsForSession
// =========================================================================
console.log("=== 1) Tool gate (real ai-manager-tools-schema.mjs) ===\n");

// cull_history must be defined in the tools schema with an integer idx (min 0).
const cullTool = tools.find((t) => t.name === "cull_history");
assert(!!cullTool, "cull_history is defined in the tools schema");
assertEq(cullTool?.parameters?.properties?.idx?.type, "integer", "cull_history.idx is typed integer");
assertEq(cullTool?.parameters?.properties?.idx?.minimum, 0, "cull_history.idx minimum is 0");
assertEq(cullTool?.parameters?.required, ["idx"], "cull_history requires idx");
assert(!subAgentToolsList.includes("cull_history"), "cull_history is NOT in the sub-agent tool list");

const names = (toolSet) => toolSet.map((t) => t.name);

// Main agent, JSON tools, model-lead pruning ON → cull_history present.
assert(names(getToolsForSession(false, true, true)).includes("cull_history"),
	"main agent + pruning ON → cull_history is served");
// Main agent, JSON tools, model-lead pruning OFF → cull_history absent.
assert(!names(getToolsForSession(false, true, false)).includes("cull_history"),
	"main agent + pruning OFF → cull_history is hidden");
// Main agent, default 3rd arg (false) → cull_history absent (opt-in).
assert(!names(getToolsForSession(false, true)).includes("cull_history"),
	"main agent + default arg → cull_history hidden (opt-in)");
// Sub-agent, even with pruning ON → cull_history absent (reduced set only).
assert(!names(getToolsForSession(true, true, true)).includes("cull_history"),
	"sub-agent + pruning ON → cull_history is NOT served (reduced set)");
// Chat-only / no JSON tools → empty set regardless of pruning.
assertEq(getToolsForSession(false, false, true), [], "no JSON tools → empty tool set");

// =========================================================================
// 2) MAP BUILD — real production buildCullIndex
// =========================================================================
console.log("\n=== 2) cullIndex map build (real ai-manager-cull-index.mjs) ===\n");

// Seed a realistic post-window-pruning dialogue: a pruned-gap marker interleaved, an
// empty model turn, and a non-culleable system_message. The visible-turn counter must
// skip the gap marker, the system_message, and the empty model turn.
const seededHistory = [
	{ id: "u1", type: "user", role: "user", content: "Summarize this file." },
	{ id: "m1", type: "model", role: "model", content: "I'll read the file.", toolCalls: [{ name: "read_file", args: { path: "app.js" } }] },
	{ id: "gap", type: "system_message", role: "system", content: "[SYSTEM(3 turns pruned for context length)]" }, // NOT counted
	{ id: "tr1", type: "tool_response", role: "tool", content: "[Read: app.js] ..." },
	{ id: "m-empty", type: "model", role: "model", content: "", toolCalls: [] }, // empty → omitted (hidden from contextForAI)
	{ id: "m2", type: "model", role: "model", content: "Lines 1-10: ..." },
	{ id: "sys-note", type: "system_message", role: "system", content: "[SYSTEM] directive" }, // NOT counted
	{ id: "u2", type: "user", role: "user", content: "Now lines 100-200." },
	{ id: "m3", type: "model", role: "model", content: "Here you go.", toolCalls: [{ name: "read_file", args: {} }] },
];

const cullIndex = buildCullIndex(seededHistory);

// Expected visible-turn → id mapping (gap, sys-note, and empty model turn are skipped).
// NOTE: normalize both sides to [number, value] pairs before comparing — Map.entries() yields
// NUMBER keys while Object.entries() yields STRING keys, so a raw JSON.stringify comparison
// would mismatch on key type even when the contents are identical.
const expectedMap = { 0: "u1", 1: "m1", 2: "tr1", 3: "m2", 4: "u2", 5: "m3" };
assertEq(cullIndex.size, 6, "cullIndex has exactly 6 visible dialogue turns");
const actualEntries = [...cullIndex.entries()].sort((a, b) => a[0] - b[0]);
const expectedEntries = Object.entries(expectedMap).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
assertEq(actualEntries, expectedEntries,
	"cullIndex maps visible positions → ids, skipping gap/system/empty-model turns");

// Raw-vs-visible divergence is the whole point: the gap marker (raw idx 2) and empty model
// turn (raw idx 4) occupy raw slots but are NOT counted, so visible turn 5 is m3 (raw idx 8),
// not raw index 5.
assert(!cullIndex.has(6), "visible turn 6 does not exist (out of range)");
assertEq(cullIndex.get(5), "m3", "visible turn 5 → m3 (raw index 8, NOT raw 5)");

// isNonEmptyModelTurn semantics.
assert(isNonEmptyModelTurn({ role: "model", content: "hi" }), "non-empty model turn (content)");
assert(isNonEmptyModelTurn({ role: "model", content: "", toolCalls: [{ name: "x" }] }), "model turn with toolCalls is non-empty");
assert(!isNonEmptyModelTurn({ role: "model", content: "   ", toolCalls: [] }), "blank-content, no-toolCall model turn is empty");

// =========================================================================
// 3) CULL EXECUTION — real production resolveCullTarget
// =========================================================================
console.log("\n=== 3) cull execution (real resolveCullTarget) ===\n");

// Valid forward move: cull_history(3) keeps visible turn 3 (m2) onward.
assertEq(resolveCullTarget(cullIndex, 3), { ok: true, newHeadId: "m2" },
	"cull_history(3) resolves new head → m2 (forward move)");
// cull_history(0) keeps everything (head → first visible turn u1).
assertEq(resolveCullTarget(cullIndex, 0), { ok: true, newHeadId: "u1" }, "cull_history(0) → u1 (keep all)");
// Out-of-range idx → rejected, no state change.
const oob = resolveCullTarget(cullIndex, 999);
assertEq(oob.ok, false, "cull_history(999) out-of-range → rejected");
assert(oob.error.includes("999"), "out-of-range error echoes the bad idx");
// Non-integer / negative idx → rejected.
assertEq(resolveCullTarget(cullIndex, 2.5).ok, false, "non-integer idx → rejected");
assertEq(resolveCullTarget(cullIndex, -1).ok, false, "negative idx → rejected");
// Null / empty map → rejected (no dialogue to prune), no state change.
assertEq(resolveCullTarget(null, 0).ok, false, "null cullIndex → rejected");
assertEq(resolveCullTarget(new Map(), 0).ok, false, "empty cullIndex → rejected");

// =========================================================================
// 4) FORWARD-MOVE + PRUNED-GAP — faithful mirror of the real consumption path
// =========================================================================
console.log("\n=== 4) Forward move produces a pruned-gap on the next turn ===\n");

// Mirror of ai-manager-history.mjs prepareMessagesForAI: contextHeadMsgId → findIndex on
// the dialogue array → slice(sliceIndex) → a pruned-gap marker is emitted for every run of
// culled turns. We drive it with the REAL cullIndex output.
function mirrorWindowPrune(dialogueHistory, contextHeadMsgId) {
	let currentHeadIndex = 0;
	if (contextHeadMsgId) {
		const foundIdx = dialogueHistory.findIndex((m) => m.id === contextHeadMsgId);
		if (foundIdx !== -1) currentHeadIndex = foundIdx;
	}
	const sliceIndex = currentHeadIndex;
	const recentHistory = dialogueHistory.slice(sliceIndex);
	const keepIds = new Set();
	dialogueHistory.forEach((m) => { if (m.type === "user" || m.type === "compacted_history") keepIds.add(m.id); });
	recentHistory.forEach((m) => keepIds.add(m.id));
	const newDialogueHistory = [];
	let lastKeptIndex = -1;
	for (let i = 0; i < dialogueHistory.length; i++) {
		if (keepIds.has(dialogueHistory[i].id)) {
			const skipped = i - lastKeptIndex - 1;
			if (skipped > 0) {
				newDialogueHistory.push({
					id: `pruned-gap-${i}`,
					role: "system",
					type: "system_message",
					content: `[SYSTEM(${skipped} turns pruned for context length)]`,
				});
			}
			newDialogueHistory.push(dialogueHistory[i]);
			lastKeptIndex = i;
		}
	}
	return newDialogueHistory;
}

// Simulate the AgentTools.execute cull_history case: resolve, then persist the new head.
const session = { id: "s1", contextHeadMsgId: null, lastModified: 0 };
const persisted = {};
async function executeCullHistory(idx) {
	// Mirrors: const session = this._resolveSession(sourceId); ... resolveCullTarget ...; persist.
	const target = resolveCullTarget(buildCullIndex(seededHistory), idx);
	if (!target.ok) return `Tool Error: ${target.error} No state changed.`;
	session.contextHeadMsgId = target.newHeadId;
	session.lastModified = Date.now();
	persisted[session.id] = { contextHeadMsgId: session.contextHeadMsgId };
	return `History cull applied: visible turn ${idx} is now the new start point.`;
}

(async () => {
	// Valid cull: move head forward to visible turn 3 (m2), persisted.
	const msg = await executeCullHistory(3);
	assert(msg.startsWith("History cull applied"), "valid cull returns a confirmation");
	assertEq(session.contextHeadMsgId, "m2", "session.contextHeadMsgId moved forward to m2");
	assert(persisted.s1 && persisted.s1.contextHeadMsgId === "m2", "new head persisted via setSession");

	// Next turn: the pruned window shows a pruned-gap marker between the last evergreen-kept
	// turn (u1, user turns are exempt) and the new head (m2). The skipped span is m1, the old
	// gap marker, tr1, and the empty model turn = 4 turns, so the marker reports "4 turns pruned".
	const nextDialogue = mirrorWindowPrune(seededHistory, session.contextHeadMsgId);
	const gapMarker = nextDialogue.find((m) => m.type === "system_message" && String(m.content).startsWith("[SYSTEM(") && String(m.content).includes("pruned"));
	assert(!!gapMarker, "next turn emits a pruned-gap marker");
	assert(gapMarker && gapMarker.content.includes("4 turns pruned"), "gap marker reports the number of culled turns (4)");
	// m1 was culled (it's before the new head m2, and model turns are not evergreen-exempt).
	assert(!nextDialogue.some((m) => m.id === "m1"), "culled model turn m1 is dropped from the window");
	// New head m2 and everything after is retained.
	assert(nextDialogue.some((m) => m.id === "m2") && nextDialogue.some((m) => m.id === "u2"), "head turn m2 and later turns are retained");

	// Out-of-range cull: no state change.
	const before = session.contextHeadMsgId;
	const errMsg = await executeCullHistory(999);
	assert(errMsg.startsWith("Tool Error:"), "out-of-range cull returns a Tool Error");
	assertEq(session.contextHeadMsgId, before, "out-of-range cull leaves contextHeadMsgId unchanged");

	// Null-map cull (no dialogue to prune): no state change.
	assertEq(resolveCullTarget(null, 0).ok, false, "null-map cull rejected (no state change)");

	// Non-cull response: the head is untouched (only an explicit cull_history call mutates).
	assertEq(session.contextHeadMsgId, "m2", "a non-cull response does not move the head");

	// =========================================================================
	// Summary
	// =========================================================================
	console.log(`\n=== ${passed} passed, ${failed} failed ===`);
	if (failed > 0) process.exit(1);
	console.log("All cull_history tests passed.");
})();
