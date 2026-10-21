// test-scratchpad-nudge.mjs — Runtime verification of the ephemeral scratchpad nudge.
//
// Usage: node tests/test-scratchpad-nudge.mjs
//
// Architecture note: ai-manager-history.mjs isn't plain-node-importable (it
// transitively imports DOM custom-elements and network idb-keyval), so the nudge
// gate lives in the PURE production module app/js/ai-manager-scratchpad-nudge.mjs —
// the SAME functions wired into prepareMessagesForAI's agent block (post-cull
// dynamic tokens → shouldInjectScratchpadNudge → trailing [SYSTEM] push). This test
// verifies that real production code:
//
//   1) GATE (shouldInjectScratchpadNudge):
//      - below the 90% pressure threshold → no inject
//      - exactly at 90% → inject (>= boundary)
//      - above the threshold → inject
//      - maxTok = 0 / null / undefined → no inject (no prefill budget configured)
//      - non-finite dynamicContextTokens → no inject
//      - custom ratio respected
//      - the reason string carries the pct
//
//   2) WINDOW SCAN (hasScratchpadWriteInWindow) — the self-clearing signal:
//      - native tool call msg.toolCalls: [{name:"scratchpad_write"}] → suppress
//      - functionCall nesting msg.toolCalls: [{functionCall:{name:"scratchpad_write"}}] → suppress
//      - serialized marker content "[Tool Response: scratchpad_write]" → suppress
//      - unrelated tool calls / content → still inject
//      - empty / null / non-array inputs → no false positive
//
//   3) CONTENT (buildScratchpadNudgeContent):
//      - [SYSTEM] prefix (trailing system turns degrade to user turns on most providers)
//      - names scratchpad_write and the append mode
//      - carries the pct figure

import { hasScratchpadWriteInWindow, shouldInjectScratchpadNudge, buildScratchpadNudgeContent } from "../app/js/ai-manager-scratchpad-nudge.mjs";

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

const MAXTOK = 10000; // convenient budget: 90% = 9000

// =========================================================================
// 1) GATE — real production shouldInjectScratchpadNudge
// =========================================================================
console.log("\n1) GATE — shouldInjectScratchpadNudge");

// Below threshold → no inject
{
	const r = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: 8999, maxTok: MAXTOK });
	assertEq(r.shouldInject, false, "below threshold (89.99%) → no inject");
	assertEq(r.pct, 90, "pct reported even when below threshold");
	assert(r.reason.includes("below pressure threshold"), "reason explains the below-threshold exit");
}

// Exactly at 90% → inject (>= boundary)
{
	const r = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: 9000, maxTok: MAXTOK });
	assertEq(r.shouldInject, true, "exactly at 90% → inject (>= boundary)");
	assertEq(r.pct, 90, "pct at the boundary");
	assert(r.reason.includes("90%"), "reason carries the pct figure");
}

// Above threshold → inject
{
	const r = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: 12000, maxTok: MAXTOK });
	assertEq(r.shouldInject, true, "above threshold (120%) → inject");
	assertEq(r.pct, 120, "pct above threshold");
}

// No prefill budget configured → no inject (maxTok 0 / null / undefined)
for (const bad of [0, null, undefined]) {
	const r = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: 9000, maxTok: bad });
	assertEq(r.shouldInject, false, `maxTok=${String(bad)} → no inject (no budget)`);
}

// Non-finite token estimate → no inject
{
	const r = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: NaN, maxTok: MAXTOK });
	assertEq(r.shouldInject, false, "NaN dynamicContextTokens → no inject");
}

// Custom ratio respected
{
	const r = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: 7500, maxTok: MAXTOK, ratio: 0.75 });
	assertEq(r.shouldInject, true, "custom ratio 0.75: at 75% → inject");
	const r2 = shouldInjectScratchpadNudge({ visibleDialogue: [], dynamicContextTokens: 7499, maxTok: MAXTOK, ratio: 0.75 });
	assertEq(r2.shouldInject, false, "custom ratio 0.75: just below → no inject");
}

// =========================================================================
// 2) WINDOW SCAN — real production hasScratchpadWriteInWindow (self-clearing)
// =========================================================================
console.log("\n2) WINDOW SCAN — hasScratchpadWriteInWindow");

// Native tool call → suppress
{
	const msgs = [{ role: "model", toolCalls: [{ name: "scratchpad_write", arguments: "{}" }] }];
	assertEq(hasScratchpadWriteInWindow(msgs), true, "native toolCalls [{name:'scratchpad_write'}] → suppress");
}

// functionCall nesting (provider-wrapped shape) → suppress
{
	const msgs = [{ role: "model", toolCalls: [{ functionCall: { name: "scratchpad_write" } }] }];
	assertEq(hasScratchpadWriteInWindow(msgs), true, "functionCall nesting → suppress");
}

// Serialized marker in tool_response content → suppress
{
	const msgs = [
		{ role: "model", toolCalls: [{ name: "scratchpad_write" }] },
		{ role: "tool", type: "tool_response", content: "[Tool Response: scratchpad_write]\n\nScratchpad appended (512 bytes)." }
	];
	assertEq(hasScratchpadWriteInWindow(msgs), true, "serialized [Tool Response: scratchpad_write] marker → suppress");
}

// Unrelated tools → still inject
{
	const msgs = [
		{ role: "model", toolCalls: [{ name: "read_file" }, { name: "edit_file" }] },
		{ role: "tool", type: "tool_response", content: "[Tool Response: read_file]\n\nfile contents…" }
	];
	assertEq(hasScratchpadWriteInWindow(msgs), false, "unrelated tools → no suppression");
}

// Similar-but-different tool name must NOT match
{
	const msgs = [{ role: "model", toolCalls: [{ name: "scratchpad_clear" }] }];
	assertEq(hasScratchpadWriteInWindow(msgs), false, "scratchpad_clear is not scratchpad_write");
}

// Empty / null / non-array inputs → no false positive
assertEq(hasScratchpadWriteInWindow([]), false, "empty array → no suppression");
assertEq(hasScratchpadWriteInWindow(null), false, "null → no suppression");
assertEq(hasScratchpadWriteInWindow(undefined), false, "undefined → no suppression");
assertEq(hasScratchpadWriteInWindow([{ role: "model" }, null, { role: "user", content: "hello" }]), false, "null entries + unrelated content → no suppression");

// End-to-end self-clearing: the SAME gate flips from inject → suppress once the
// model's scratchpad_write lands in the visible window (this is what makes the
// nudge ephemeral — no persisted counter needed).
{
	const windowBefore = [{ role: "user", content: "start the task" }];
	const windowAfter = [
		...windowBefore,
		{ role: "model", toolCalls: [{ name: "scratchpad_write", arguments: "{}" }] },
		{ role: "tool", type: "tool_response", content: "[Tool Response: scratchpad_write]\n\nScratchpad updated (400 bytes)." }
	];
	const before = shouldInjectScratchpadNudge({ visibleDialogue: windowBefore, dynamicContextTokens: 9500, maxTok: MAXTOK });
	const after = shouldInjectScratchpadNudge({ visibleDialogue: windowAfter, dynamicContextTokens: 9500, maxTok: MAXTOK });
	assertEq(before.shouldInject, true, "before write: at 95% with clean window → inject");
	assertEq(after.shouldInject, false, "after write: same pressure, window now has the call → self-clears");
	assert(after.reason.includes("self-clearing"), "reason explains the self-clearing exit");
}

// =========================================================================
// 3) CONTENT — real production buildScratchpadNudgeContent
// =========================================================================
console.log("\n3) CONTENT — buildScratchpadNudgeContent");

{
	const text = buildScratchpadNudgeContent(93);
	assert(text.startsWith("[SYSTEM]"), "[SYSTEM] prefix (trailing system turns degrade to user turns on most providers)");
	assert(text.includes("scratchpad_write"), "names the scratchpad_write tool");
	assert(text.includes("'append'"), "recommends append mode (non-destructive)");
	assert(text.includes("93%"), "carries the pct figure");
	assert(text.includes("4KB"), "mentions the 4KB scratchpad limit");
	assertEq(buildScratchpadNudgeContent(93), buildScratchpadNudgeContent(93), "deterministic for a given pct");
}

// =========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
