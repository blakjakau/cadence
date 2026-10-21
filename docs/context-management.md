# AI Context Management in Cadence

This document assesses the AI context management architecture of **Cadence** (`dev.jakbox.cadence`). Cadence handles long-running agentic coding sessions without exhausting the active LLM connection's prefill window or suffering from context degradation. It does so through a layered system: a **token-driven sliding window**, **automated multi-cycle compaction** (with archive separation), an **evergreen scratchpad** with an **ephemeral pressure nudge**, **model-led culling** via an index-space contract (`cull_history`), and **sub-agent context isolation**.

This assessment is written directly against the current source.

---

## 0. The Five Pillars at a Glance

| Pillar | Mechanism | Where |
|---|---|---|
| **A. Token-Budget Window** | A token-driven (not count-driven) sliding window over the dialogue history, bounded by the connection's `minPrefill`/`maxPrefill`. | `ai-manager-history.mjs` (`prepareMessagesForAI`) |
| **B. Evergreen Scratchpad + Nudge** | A session-scoped scratchpad turn that is always re-injected; an ephemeral `[SYSTEM]` pressure nudge appended at the tail when the window is near saturation. | `ai-manager-history.mjs`, `ai-manager-scratchpad-nudge.mjs`, `agent-tools.mjs` |
| **C. Automated Multi-Cycle Compaction** | A token-based cycle trigger that condenses the uncompacted region into a `cycle_summary`, splices it head-anchored, and archives the raw span. | `ai-manager-history.mjs`, `agent.mjs` (preemption) |
| **D. Model-Led Culling** | The model calls `cull_history(idx)` using a visible-turn index space; the result is a persistent window head. | `ai-manager-cull-index.mjs`, `agent-tools.mjs`, `ai-manager-tools-schema.mjs` |
| **E. Sub-Agent Isolation** | Sub-agents run on clean sessions with a reduced tool set and no orchestration tools. | `agent-tools.mjs` (`createSubAgent`), `ai-manager-tools-schema.mjs` |

The two "standard mode" vs. "agent mode" paths are distinct and both matter (see §6).

---

## 1. The Prepared Context: What the Model Actually Sees

`prepareMessagesForAI` (`ai-manager-history.mjs`) reconstructs the outgoing `contextForAI` from the persisted session record. The order of the assembled context is:

1. **`compacted_history`** — a single markdown turn built from all non-seed `cycle_summary` messages (see §3).
2. **`task_state`** — the evergreen task-state message (extracted and protected from pruning).
3. **`EVERGREEN PLAN & TASKS`** — the combined implementation-plan + task-list turn (agent mode).
4. **Scratchpad** — the session's `=== CADENCE'S SCRATCHPAD ===` system turn (agent mode).
5. **Directives** — the `[SYSTEM]` directive block (plan/tasks/acceptance/planning-mode/sub-agent state).
6. **Dialogue window** — the token-bounded slice of the dialogue history (see §2).
7. **Scratchpad nudge** (optional, ephemeral) — a trailing `[SYSTEM]` directive appended last (see §4).

Two important reconstruction facts:

- **The reconstruction drops `.id` fields.** The dialogue array that is windowed and cull-indexed is the *persisted* `chatHistory`/`dialogueHistory` (which still carries stable `id`s). The final `contextForAI` sent to the model does not. This is why the cull index is built over the *culleable dialogue* array, **not** over `contextForAI` (see §5).
- **Evergreen turns are prepended, not hoisted-to-end.** The scratchpad and plan/tasks are *prepended* as leading system turns, not appended at the end. Only the *nudge* is appended at the tail.

### Dead code note
`MAX_RECENT_MESSAGES_TO_PRESERVE = 5` (`ai-manager-history.mjs:14`) is **exported but unused**. The sliding window is **token-driven, not count-driven** — it never preserves "the last 5 messages." The exported constant is a vestige of an earlier count-based design and is imported in `ai-manager.mjs` but not referenced by any windowing logic.

---

## 2. Pillar A — Token-Budget Sliding Window

The window is computed inside the agent-mode block of `prepareMessagesForAI`.

### Bounds
```js
const maxContextTokens = this.ai?.MAX_CONTEXT_TOKENS || 8192;
const conn = AIConnections.getConnection(targetSession?.connectionId || AIConnections.defaultConnectionId);
const minTok = resolvePrefillTokens(conn?.minPrefill) ?? Math.floor(maxContextTokens * 0.4);
const maxTok = resolvePrefillTokens(conn?.maxPrefill) ?? Math.floor(maxContextTokens * 0.8);

const minTargetLimit = Math.max(1000, minTok - extraTokens);
const maxTargetLimit = Math.max(minTargetLimit, maxTok - extraTokens); // sanity: max can't fall below min
```

- **`minTok` / `maxTok`** come from the session's *connection* prefill selects (absolute token counts). When unset/`"none"`, they fall back to the legacy **40% / 80% of `n_ctx`** (`MAX_CONTEXT_TOKENS`).
- **`extraTokens`** is the estimated cost of everything that is *not* dialogue: the evergreen plan+tasks turn, the scratchpad turn, the task-state message, the directives block, the system prompt (or a 500-token estimate), plus a 500-token safety headroom. Subtracting `extraTokens` from the prefill bounds yields the **dialogue budget** (`minTargetLimit` / `maxTargetLimit`).

### The cull-back walk
Per-message token counts are precomputed (cached `msg.tokenCount` when present, else `estimateTokens`), and a prefix-sum `nonUserPrunedCostBefore` is built so the cost of "everything from index `i` onward, excluding user prompts" is an O(1) lookup.

- **User prompts are always kept.** The prefix sum only accumulates non-user costs, so a window boundary can never slice out a user prompt.
- **The window head** is the session's `contextHeadMsgId` (set by the sliding window or by a `cull_history` call). If the head lands on a `tool_response`, it is backed up one slot to pair the tool call with its response.
- **Aggressive cull-back:** if the current window's token cost exceeds `maxTargetLimit`, the algorithm walks the boundary back (from the tail) until the cost drops to `minTargetLimit`. This is the safety-net "prune" that runs automatically whenever context grows beyond its budget.

### Gap markers
When a span is pruned, the reconstruction inserts explanatory **`pruned-gap-${i}`** markers so the model can see that turns were omitted (e.g. `[SYSTEM(22 turns pruned for context length)]`). Gap markers are **not** counted as dialogue turns by the cull index (see §5).

### `compacted_history` is always kept
The single `compacted_history` turn is never culled — it is the durable anchor for all prior cycles (see §3). Pruning never removes it.

---

## 3. Pillar C — Automated Multi-Cycle Compaction

This is the "evergreen" engine: completed task cycles are condensed into summaries while their raw turns are archived out of the main record.

### The trigger
`checkCycleCompactionTrigger` (`ai-manager-history.mjs`) is a **cheap, fire-and-forget** check: one backward scan plus a token tally of the tail region. It runs from **two call sites**:

- **Prompt gate** — `ai-manager.mjs:2774`, `source: "prompt"`, before the new prompt is appended (`headId = null`, so the span is the tail region after the last `cycle_summary`).
- **Prepare** — `ai-manager-history.mjs:4715`, `source: "prepare"`, with `headId = dialogueHistory[sliceIndex]?.id` (the current window head).

**Threshold:** the **uncompacted region** (everything after the most recent *real* `cycle_summary`, up to and including the head) triggers compaction when it reaches **`Math.floor(maxTok * 0.5)`** (≈ 50% of the connection's `maxPrefill`). Below threshold it is a no-op, so the per-prompt/per-prepare cost is negligible.

**Re-entrancy guards:** the check skips when the region starts at a `cycle_summary`, when a real summary already covers the head (`hasCycleSummaryCovering`), or when a seed/`_pendingCycleCompaction` is already in flight.

### Where the summary runs
- **Preferred:** a **separate, non-primary connection** (fastest available, by average tokens/sec; size-based heuristic when telemetry is empty). A **tail seed** is inserted as a stand-in so the in-flight seed never falls inside its own span.
- **Fallback:** the **agent-loop preemption** (`agent.mjs` Phase 3.3). When no separate connection is available (or the background compaction failed), the compaction is forced onto the session's own primary connection at the next turn start, bounded by a **90 s timeout** with a progress chip + toast. On timeout the seed anchor is *retained* (the in-flight compaction still lands the real summary in place); on a genuine no-op/failure the stale seed is cleared.

### The summarizer budget
```js
const budgetTokens = Math.min(
    49152,                                            // Hard 48k ceiling
    prefillCap ?? Number.MAX_SAFE_INTEGER,            // Connection's maxPrefill, when set
    Math.max(2000, Math.floor(maxTokens * 0.6))      // 60%-of-window, 2k floor
);
```
A single summarization call never exceeds any of these bounds. The summarizer also receives a **PRIOR CYCLE CONTEXT** section built from the session's preceding (non-seed) summaries for continuity (newest `MAX_DIRECT_CYCLE_SUMMARIES` full, older title-only; omitted when there are none).

### Head-anchored splice + archive
`_compactCycleSpan` splices the new `cycle_summary` **head-anchored** — *before* the covered span's head — so cycles stay contiguous and a later boundary scan never leaks the summary into the next region. The raw span is then moved **out of the main record into a per-session archive** by `_archiveCycleSpan`, which:

- moves only the raw message **IDs** (skipping `cycle_summary` markers, the summary itself, and **sub-agent marker** messages, which are structural anchors that must stay in place);
- marks the summary `archived: true`;
- is **best-effort** — a failure never fails the compaction; the span simply stays eligible for a future attempt.

A load-time **JIT backfill** re-archives legacy sessions whose raw spans were never split out (idempotent, cheap when clean).

### The `compacted_history` turn
`_buildCompactedHistoryMarkdown` collapses **all** non-seed `cycle_summary` messages into a **single** `compacted_history` markdown turn:

```
# Compacted History
## <title of cycle 1>
## <title of cycle 2>
## <title of cycle N>
<full content of the last MAX_DIRECT_CYCLE_SUMMARIES cycles>
```

- Every cycle gets a `## <title>` line (title derived from `s.title`, else the first sentence of content, else `"Completed Task"`).
- Only the **last `MAX_DIRECT_CYCLE_SUMMARIES = 3`** cycles carry full content; older cycles are title-only. This bounds the anchor's token cost while keeping the most recent cycles fully readable.
- The raw turns covered by the summaries are spliced out (collapsed), so nothing is double-sent.

---

## 4. Pillar B — Evergreen Scratchpad + Ephemeral Pressure Nudge

### The scratchpad
- **Session-scoped**, stored on `session.scratchpad` (persisted via `workspaceClient.setSession`). **Not** file-based — there is no `scratch/history.md` in the repo; the scratchpad lives on the session record. (The plan's reference to `scratch/history.md` is a non-existent file.)
- **Evergreen:** re-injected every turn as a leading `=== CADENCE'S SCRATCHPAD ===` system turn, so key findings/decisions/next-steps survive dialogue pruning and compaction.
- **Tools:** `scratchpad_write` (modes `replace` default / `append`) and `scratchpad_clear` (`agent-tools.mjs`). `write` enforces a **4 KB byte limit** and snapshots the previous content into scratchpad history before overwriting/clearing. `replace` is destructive; `append` concatenates.

### The ephemeral nudge
`ai-manager-scratchpad-nudge.mjs` is a **pure, dependency-free** module (no DOM/browser globals) so tests exercise the *real* production gate. The gate (`shouldInjectScratchpadNudge`) fires when **both** hold:

1. **Pressure:** the post-cull **dynamic context** (dialogue window tokens + `extraTokens`) is **≥ 90% of `maxTok`** (`dynamicContextTokens >= 0.9 * maxTok`). Guarded: `maxTok` of 0/null/undefined → no inject; non-finite dynamic tokens → no inject.
2. **No recent save:** the model has **not** called `scratchpad_write` within the visible window. `hasScratchpadWriteInWindow` detects the call across three shapes — native `msg.toolCalls: [{name:"scratchpad_write"}]`, the `functionCall` nesting, and the serialized `[Tool Response: scratchpad_write]` content marker.

When it fires, a **one-shot** `[SYSTEM]` directive is **appended at the end** of `contextForAI` (history:5050) telling the model to persist its state via `scratchpad_write(mode:'append')`. It is **never persisted** — recomputed every turn — so it **self-clears** once the model writes to the scratchpad (the window scan finds the call) or the context drops below threshold. The `[SYSTEM]` prefix is used because trailing *system* turns degrade to *user* turns on most providers.

Verified by `tests/test-scratchpad-nudge.mjs` (gate boundaries at exactly 90%, the three window-scan shapes, and the content prefix/pct).

---

## 5. Pillar D — Model-Led Culling via the Index-Space Contract (`cull_history`)

### The index-space contract
The model's *visible* dialogue position diverges from the raw `chatHistory` array position whenever gap markers (`pruned-gap-*`), standalone `system_message`s, or empty model turns are present. `ai-manager-cull-index.mjs` is **pure and dependency-free** (browser-free) so unit tests import the *real* logic.

`buildCullIndex(chatHistory)` maps **visible turn index → message id**, counting **only** the **culleable** dialogue turns the model actually sees, in display order:

```js
export const CULLEABLE_TYPES = new Set([
    'user', 'agent', 'model', 'tool_response', 'compacted_history', 'cycle_summary',
]);
```

It **skips**:
- gap markers (`pruned-gap-*`) and standalone `system_message`s (not in `CULLEABLE_TYPES`);
- **empty model turns** (`isNonEmptyModelTurn` = has trimmed content OR pending tool calls) — these are also hidden from `contextForAI`;
- evergreen/directive prepends (`compacted_history` summary, plan/tasks, scratchpad, task status) and `[SYSTEM]` directives (not culleable dialogue turns).

`resolveCullTarget(cullIndex, idx)` validates the index **defensively** — rejects non-integer/negative/out-of-range indices with a descriptive error and **no state change** — and returns `{ok, newHeadId}`.

### Gating & dispatch
- **Main-agent-only, user-gated.** `cull_history` is exposed only when the user opts in via the **`modelLeadPruning`** toggle **and** JSON tools are active (`getToolsForSession(isSubAgent, supportsJSONTools, modelLeadPruning)`, `ai-manager-tools-schema.mjs:446`). It is **strictly excluded from sub-agent** tool sets (see §7).
- The tool is dispatched as a **structured tool call** (no string-intercept). The `cull_history` case (`agent-tools.mjs:3316`) resolves the session, fetches the current `cullIndex` from the history manager, validates via `resolveCullTarget`, and on success sets **`session.contextHeadMsgId = resolved.newHeadId`** and persists. The next model turn then windows from that head.
- **Opt-out is safe:** if the model never calls it, the automatic safety-net cull-back (§2) still runs.

The system prompt (`ai-manager-agent-prompt.mjs`) includes a **Context Pruning** section (only when `modelLeadPruning` **and** the model is a known reasoning model) explaining the `cull_history({idx})` semantics and the out-of-range safety guarantee.

Verified by `tests/test-cull-history.mjs` (mirrors `prepareMessagesForAI`, confirming the pruned window shows `pruned-gap-*` markers between the last evergreen-kept turn and the sliding-window head).

---

## 6. Standard Mode vs. Agent Mode

Two distinct summarization paths coexist:

- **Agent mode** — the **token-based cycle compaction** above (§3). `checkCycleCompactionTrigger` is called at the prompt gate (`ai-manager.mjs:2774`) and is the primary mechanism.
- **Standard mode** — the traditional **total-tokens `summarizeThreshold`** gate (`ai-manager.mjs:2775-2786`): when `estimateTokens(session.messages) / MAX_CONTEXT_TOKENS * 100 >= config.summarizeThreshold`, it calls `performSummarization()` (awaited before continuing). `performSummarization` (`ai-manager-history.mjs:2985`) finds the first non-`file_context` message, blocks the whole conversation to date, and guards against running while already processing.

The cycle-compaction methods early-return (`return false`) when `agentModeEnabled` is false, so the standard path is the only active one there.

---

## 7. Pillar E — Sub-Agent Context Isolation

`createSubAgent` (`agent-tools.mjs:3848`) spawns a **clean** sub-session:

- **`messages: []`** — the sub-agent does **not** inherit the parent's full history; it starts fresh with only its objective.
- **Reduced tool set** — `subAgentToolsList` (`ai-manager-tools-schema.mjs:1`): read/search/edit/create, `run_command`, `research`, `web_fetch`, `checkpoint`, `rollback_file`, `scratchpad_write`/`clear`, and the two lifecycle tools **`sub_agent_complete`** + **`query_parent`**. It **excludes** all orchestration tools — **no `cull_history`**, no `create_sub_agent` (no further spawning), no `done`.
- **Inherited:** `pinnedRoots` and `forgivenessMode` from the parent.
- **Parent linkage:** a **`[sub-agent:<subId>]`** user message is pushed into the *parent* thread as a structural anchor; the sub-session carries `parentId`. This marker is preserved through archival (§3).
- **Limits:** max parallel sub-agents (`config.maxSubAgents || 3`); `allowSubAgents === false` disables spawning; connection chosen by a size-based pool selector.
- **Prompt:** sub-agent system prompt (`ai-manager-agent-prompt.mjs`) instructs it to stay in scope, finish via `sub_agent_complete` (never `done`), and use `query_parent` when blocked.

The effect: sub-agents operate on **isolated, focused contexts** with no access to the parent's pruning/compaction machinery, preventing runaway context pollution and keeping the parent's window clean.

---

## 8. Strengths & Architectural Resiliencies

1. **Pure, testable core logic.** `ai-manager-cull-index.mjs` and `ai-manager-scratchpad-nudge.mjs` are dependency-free (no DOM, no `window`), so `tests/test-cull-history.mjs` and `tests/test-scratchpad-nudge.mjs` exercise the *real* production functions rather than drift-prone copies.
2. **Token-driven, not count-driven.** The window keys off the *connection's* actual prefill bounds (`minPrefill`/`maxPrefill`) rather than a fixed message count, so it adapts to whatever model/connection is active and reserves budget for the evergreen prepends (`extraTokens`).
3. **Cheap common path.** The cycle-compaction trigger is a backward scan + tail tally — a no-op below threshold — so it runs on every prompt/prepare without cost. Compaction itself is offloaded to a separate connection or a bounded preemption, never stalling the active turn indefinitely (90 s cap).
4. **Head-anchored contiguity + archive separation.** Summaries splice *before* their span head (no leakage into the next region), and raw spans are moved out of the main record into per-session archives, keeping the active record lean and fast to re-serialize. Archival is best-effort and idempotent (JIT backfill for legacy sessions).
5. **Bounded durable anchor.** `compacted_history` collapses all cycles into one turn with title-only older entries and full content for only the last 3, capping the anchor's token cost.
6. **Defensive, state-safe culling.** `cull_history` validates indices and never mutates state on a bad call; the automatic cull-back remains the safety net when the model doesn't act.
7. **Clean sub-agent isolation.** Reduced tool set, no orchestration tools, fresh context, and a preserved parent anchor.
8. **Self-clearing ephemeral nudge.** The scratchpad nudge is recomputed per turn and clears itself once the model complies or pressure eases — no lingering state.

---

## 9. Trade-Offs & Future Hardening Recommendations

- **Model compliance on the nudge.** Nudge efficacy varies across backends (some may reply inline instead of calling `scratchpad_write`). *Recommendation:* track backend telemetry on nudge→`scratchpad_write` conversion and tune phrasing/strength if non-compliance rises.
- **Index-drift edge cases.** `cullIndex` is built on-the-fly over the windowed dialogue; the empty-model-turn filter and gap-marker exclusion are the subtle parts. *Recommendation:* keep `tests/test-cull-history.mjs` in lockstep with any change to `CULLEABLE_TYPES` or `isNonEmptyModelTurn`.
- **Archive growth.** As sessions accumulate many compaction cycles, per-session archives grow. *Recommendation:* ensure lazy-loading / summary-index queries for archive retrieval so ultra-long sessions stay fast to load.
- **Dead code.** `MAX_RECENT_MESSAGES_TO_PRESERVE = 5` is exported-but-unused. *Recommendation:* remove it (or wire it) to avoid misleading future readers about the windowing model.
- **Timeout semantics.** On the 90 s preemption timeout the seed is retained and the in-flight compaction lands later; a reader should understand the summary may arrive *after* the turn that triggered it. *Recommendation:* document/surface this in the progress chip copy if it isn't already.
- **Summarizer budget coupling.** The 48k ceiling / 60%-of-window floor are hardcoded. *Recommendation:* consider making the hard ceiling configurable per-connection for very large or very small models.

---

## 10. Source Map

| Concern | File(s) |
|---|---|
| Sliding window, `checkCycleCompactionTrigger`, `autoCompactAgentCycle(Async)`, `_compactCycleSpan`, `_archiveCycleSpan`, `_buildCompactedHistoryMarkdown`, `prepareMessagesForAI`, `performSummarization`, nudge wiring | `app/js/ai-manager-history.mjs` |
| Pure cull-index contract (`CULLEABLE_TYPES`, `buildCullIndex`, `resolveCullTarget`, `isNonEmptyModelTurn`) | `app/js/ai-manager-cull-index.mjs` |
| Pure scratchpad-nudge gate (`shouldInjectScratchpadNudge`, `hasScratchpadWriteInWindow`, `buildScratchpadNudgeContent`) | `app/js/ai-manager-scratchpad-nudge.mjs` |
| Prompt gate (agent vs. standard), compaction-connection selection, summarizer budget, `_hasSeparateCompactionConnection` | `app/js/ai-manager.mjs` |
| Agent-loop preemption (Phase 3.3, 90 s timeout, seed handling) | `app/js/agent/agent.mjs` |
| Tool dispatch (`cull_history`, `scratchpad_write`/`clear`, `createSubAgent`), `subAgentToolsList`, `getToolsForSession` | `app/js/agent/agent-tools.mjs`, `app/js/ai-manager-tools-schema.mjs` |
| Context Pruning prompt section, sub-agent prompt | `app/js/ai-manager-agent-prompt.mjs` |
| Runtime verification | `tests/test-cull-history.mjs`, `tests/test-scratchpad-nudge.mjs` |
