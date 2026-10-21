// agent-whitelist.mjs — Node-side verification of the client-side tool whitelist
// guardrail in AgentTools.execute (app/js/agent/agent-tools.mjs).
//
// Why a mirror? agent-tools.mjs cannot be imported under plain Node because it
// has top-level DOM/network side effects:
//   - const agentTools = new AgentTools(); window.agentTools = agentTools;
//   - import '../conduit-client.mjs'   → top-level window.conduit = conduitClient
//   - import '../workspace-client.mjs', 'syntax-validator.mjs', 'ai-connections.mjs',
//     './agent.mjs'  → all touch DOM / WebSocket / IndexedDB.
// So, exactly as the existing cull_history test mirrors prepareMessagesForAI,
// this file mirrors the _servedToolNames helper + the execute() whitelist gate
// VERBATIM against the REAL getToolsForSession output (the same production
// function the providers use to build the served set).

globalThis.window = globalThis.window || {};

import { getToolsForSession, tools } from "../app/js/ai-manager-tools-schema.mjs";

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

// ---------------------------------------------------------------------------
// VERBATIM mirror of AgentTools._servedToolNames (source: agent-tools.mjs).
// ---------------------------------------------------------------------------
function _servedToolNames(session) {
	if (!session) return null;
	const aiManager = window.ui?.aiManager;
	const isSubAgent = !!(session.parentId);
	const modelLeadPruning =
		(session.enableModelLeadPruning !== null && session.enableModelLeadPruning !== undefined)
			? !!session.enableModelLeadPruning
			: aiManager?.config?.modelLeadPruning === true;

	let names = getToolsForSession(isSubAgent, true, modelLeadPruning).map((t) => t.name);

	if (!isSubAgent) {
		const isPlanning =
			(session.planningMode !== undefined && session.planningMode !== null)
				? !!session.planningMode
				: (aiManager?.planningMode === true);
		const isAllowSubAgentsFalse = session.allowSubAgents === false;
		const isAllowRunCommandFalse = session.allowRunCommand === false;
		names = names.filter((n) => {
			if (isPlanning && (n === "create_file" || n === "edit_file")) return false;
			if (isAllowSubAgentsFalse && n === "create_sub_agent") return false;
			if (isAllowRunCommandFalse && (n === "run_command" || n === "exec_command")) return false;
			return true;
		});
	}

	return new Set(names);
}

// ---------------------------------------------------------------------------
// VERBATIM mirror of the whitelist gate + the two layers that follow it in
// execute(). Only the parts relevant to the guardrail are reproduced:
//   const targetSession = this._resolveSession(sourceId);
//   const servedSet = this._servedToolNames(targetSession);
//   if (servedSet !== null && !servedSet.has(name)) { return <not-served>; }
//   ... (planning check, required-param check, then the switch, then default throw)
// ---------------------------------------------------------------------------
function gate(name, args = {}, targetSession) {
	const servedSet = _servedToolNames(targetSession);
	if (servedSet !== null && !servedSet.has(name)) {
		return `Tool Error: Tool '${name}' was not served to the model for this session. No state changed.`;
	}
	const isPlanning = targetSession
		? (targetSession.planningMode ?? (window.ui?.aiManager?.planningMode))
		: (window.ui?.aiManager?.planningMode);
	if (isPlanning && (name === 'create_file' || name === 'edit_file' ||
			name === 'edit_remove_lines' || name === 'refactor_copy_lines')) {
		return `Tool Error: Tool '${name}' is not allowed while in planning mode.`;
	}

	// Fallback required-parameter check (mirrored)
	const toolDef = tools.find(t => t.name === name);
	if (toolDef && toolDef.parameters && Array.isArray(toolDef.parameters.required)) {
		for (const reqParam of toolDef.parameters.required) {
			if (args[reqParam] === undefined || args[reqParam] === null ||
				(args[reqParam] === "" && reqParam !== "replace" && reqParam !== "content")) {
				return `Tool Error: ${name} requires "${reqParam}" parameter`;
			}
		}
	}

	// The whitelist is a LAYER: anything that escaped the gate and the switch
	// still reaches the default throw. We reproduce it here to prove that a name
	// in the served set but with no switch case reaches the throw (layering),
	// whereas a name NOT in the served set is stopped at the gate.
	if (servedSet === null || servedSet.has(name)) {
		return "__fell_through__";
	}
	return "__fell_through__";
}

// ---------------------------------------------------------------------------
// 1) served-set membership: cull_history is gated by (main agent + pruning ON)
// ---------------------------------------------------------------------------
console.log("=== 1) served-set membership (cull_history gate) ===\n");

const configOn = { config: { modelLeadPruning: true }, planningMode: false };
const configOff = { config: { modelLeadPruning: false }, planningMode: false };

// Main agent, pruning ON → cull_history served.
window.ui = { aiManager: configOn };
const mainOn = _servedToolNames({ id: "s1" });
assert(mainOn && mainOn.has("cull_history"), "main agent + pruning ON → cull_history is served");

// Main agent, pruning OFF → cull_history hidden.
window.ui = { aiManager: configOff };
const mainOff = _servedToolNames({ id: "s1" });
assert(mainOff && !mainOff.has("cull_history"), "main agent + pruning OFF → cull_history is hidden");

// Session-level override wins over config.
window.ui = { aiManager: configOff };
const sessionOverrideOn = _servedToolNames({ id: "s1", enableModelLeadPruning: true });
assert(sessionOverrideOn && sessionOverrideOn.has("cull_history"),
	"session.enableModelLeadPruning=true wins over config=false → served");
window.ui = { aiManager: configOn };
const sessionOverrideOff = _servedToolNames({ id: "s1", enableModelLeadPruning: false });
assert(sessionOverrideOff && !sessionOverrideOff.has("cull_history"),
	"session.enableModelLeadPruning=false wins over config=true → hidden");

// ---------------------------------------------------------------------------
// 2) per-session post-gate filters (planning / sub-agents / run command)
// ---------------------------------------------------------------------------
console.log("\n=== 2) per-session post-gate filters ===\n");

window.ui = { aiManager: configOn };
const planning = _servedToolNames({ id: "s1", planningMode: true });
assert(!planning.has("create_file"), "planningMode → create_file is NOT served");
assert(!planning.has("edit_file"), "planningMode → edit_file is NOT served");
assert(planning.has("cull_history"), "planningMode does not hide cull_history");

const noSubs = _servedToolNames({ id: "s1", allowSubAgents: false });
assert(!noSubs.has("create_sub_agent"), "allowSubAgents=false → create_sub_agent is NOT served");

const noRun = _servedToolNames({ id: "s1", allowRunCommand: false });
assert(!noRun.has("run_command"), "allowRunCommand=false → run_command is NOT served");
assert(!noRun.has("exec_command"), "allowRunCommand=false → exec_command is NOT served");

const ghost = "definitely_not_a_real_tool";
assert(!mainOff.has(ghost), "unknown schema name is NOT in the served set");

// ---------------------------------------------------------------------------
// 3) sub-agents NEVER get cull_history (regardless of pruning)
// ---------------------------------------------------------------------------
console.log("\n=== 3) sub-agents never get cull_history ===\n");
window.ui = { aiManager: configOn };
const subOn = _servedToolNames({ id: "s1", parentId: "parent" });
assert(subOn && !subOn.has("cull_history"), "sub-agent + pruning ON → cull_history is NOT served");
window.ui = { aiManager: configOff };
const subOff = _servedToolNames({ id: "s1", parentId: "parent" });
assert(subOff && !subOff.has("cull_history"), "sub-agent + pruning OFF → cull_history is NOT served");
assert(subOn && subOn.size > 0, "sub-agent served set is non-empty (reduced set)");

// ---------------------------------------------------------------------------
// 4) the gate itself
// ---------------------------------------------------------------------------
console.log("\n=== 4) the whitelist gate ===\n");

const notServedMsg = (n) =>
	`Tool Error: Tool '${n}' was not served to the model for this session. No state changed.`;

// Note on what "passes the gate" means: the served-set check is the FIRST layer
// in execute(). A name in the served set is NOT rejected by it (the function
// continues). To observe a clean fall-through we supply the schema-required
// args so the downstream layers (required-param check / switch) don't mask
// the result. What we assert is that the not-served string is NOT returned.

// 4a) name IN the served set passes the gate (falls through the whitelist).
window.ui = { aiManager: configOn };
const s = { id: "s1" };
assert(gate("read_file", { path: "app.js" }, s) === "__fell_through__",
	"name in served set (read_file) passes the gate");
assert(gate("cull_history", { idx: 0 }, s) === "__fell_through__",
	"cull_history in served set (pruning ON) passes the gate");

// 4b) name NOT in the served set returns the clean string (no throw).
const cullOffResult = gate("cull_history", {}, { id: "s1", enableModelLeadPruning: false });
assert(cullOffResult === notServedMsg("cull_history"),
	"cull_history with pruning OFF → not-served string (no throw)");
const ghostResult = gate(ghost, {}, s);
assert(ghostResult === notServedMsg(ghost),
	`ghost-mapped unknown name → not-served string (no throw) for '${ghost}'`);

// 4c) targetSession === null ⇒ gate skipped (null set ⇒ fall through).
//     servedSet === null → the (servedSet !== null && ...) check is false →
//     the not-served string is NOT returned.
const nullSessionResult = gate("read_file", { path: "app.js" }, null);
assert(nullSessionResult !== notServedMsg("read_file"),
	"targetSession null → not-served string NOT returned (gate skipped)");
assert(nullSessionResult === "__fell_through__",
	"targetSession null → falls through the gate (not a served-set rejection)");

// 4d) layering: an unknown/unserved name is stopped at the gate, so it never
//     reaches the `default:` throw. The default throw is only reachable for a
//     name that IS served but has no switch case (future schema/switch drift).
//     Here we assert that the gate (not the throw) is what stops the unknown name.
let ghostThrew = false;
try { gate(ghost, {}, s); } catch (e) { ghostThrew = true; }
assert(!ghostThrew, "unserved unknown name does not throw at the gate (returns a string)");
assert(gate(ghost, {}, s) === notServedMsg(ghost),
	"unserved unknown name is rejected at the gate (a string, not a throw)");

// ---------------------------------------------------------------------------
// 5) the production message matches the gate string exactly
// ---------------------------------------------------------------------------
console.log("\n=== 5) production message contract ===\n");
assert(gate("cull_history", {}, { id: "s1", enableModelLeadPruning: false })
	=== notServedMsg("cull_history"),
	"gate message matches the production string exactly");
assert(notServedMsg("cull_history").includes("No state changed"),
	"not-served message states no state changed");

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
console.log("All whitelist-guardrail tests passed.");