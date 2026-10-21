# The Cadence Harness Standard

> ⚠️ **Superseded.** This is the **August 2026** edition. It has been re-verified and updated by the **October 2026** edition — see [`harness-sota-oct26.md`](harness-sota-oct26.md) for the current standard, refreshed SOTA citations, and re-scored rubric. Kept here for the historical record.

> A state-of-the-art reference for agentic-coding-harness design, written to serve two purposes at once:
> (1) a specification of what "good" looks like in an agent harness, and
> (2) a self-evaluation rubric for auditing and evolving **Cadence's** own implementation.
>
> Each section follows the same shape:
> - **SOTA reference** — how the frontier systems and research address the theme.
> - **The standard** — the properties a production-grade harness should exhibit.
> - **Cadence self-evaluation** — a maturity rubric (1–5), Cadence's current status, and concrete gaps to close.

---

## 0. What a harness is (and why it matters more than the model)

A **harness** is the runtime that wraps a base model in the loops, tools, memory, safety gates, and human interfaces that make it reliably useful. The central thesis of modern agent engineering is:

> *A marginally-smarter model inside a better harness will routinely beat a frontier model inside a poor one. Harnessability should be a first-class criterion in architecture decisions.*

Evidence for this is empirical: frontier coding agents (Claude Code, Codex, Gemini Agent) converge architecturally despite different base models, which means the *runtime patterns* are the differentiator, not the weights. This document codifies those patterns.

---

## 1. Tool Design

### SOTA reference
- **Anthropic Agent SDK** ships tools as strict JSON-Schema objects with declarative `name`, `description`, and `parameters`. Descriptions are treated as *interfaces to the model* — the single most important signal for correct tool selection.
- **MCP (Model Context Protocol)** — now a Linux Foundation (Agentic AI Foundation) standard with 97M+ monthly SDK downloads. Decouples tools from the agent runtime via a universal client/server contract, enabling a marketplace of shareable tool servers.
- **A2A (Agent2Agent)** — the peer-to-peer protocol agents use to hand off work to *other agents* (as opposed to MCP, which lets agents talk to *tools*).
- **OpenAI Codex** and **Gemini Agent** expose tools with typed schemas and enforce schema validation server-side before any model output reaches a tool.

### The standard
1. **Every tool is a JSON-Schema object.** Parameters are typed, `required` arrays are explicit, and `enum`s constrain choice.
2. **Descriptions are first-class.** Each tool's description states *when* to use it, *what* it returns, and *failure modes* — not just *what* it does.
3. **Schemas are validated server-side.** Malformed tool input is rejected before execution, not after a side effect.
4. **Discovery is structured.** The model receives the full tool list (or a reduced, capability-appropriate subset) up front.
5. **A universal protocol** (MCP for tools, A2A for agents) decouples the harness from any single tool or agent implementation.
6. **Tool output hygiene** — large outputs are capped/truncated; long-lived results are persisted out of the context window.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| JSON-Schema tools | ❌ | ⬜ | ✓ Typed schema | ✓ Validated | ✓ Validated + described | **4** |
| Description quality | ❌ | ⬜ | Partial | ✓ Clear | ✓ Clear + usage/failure | **4** |
| Server-side validation | ❌ | ⬜ | Partial | ✓ Partial | ✓ Pre-exec check | **3** |
| Capability-scoped toolset | ❌ | ⬜ | Partial | ✓ Subset | ✓ `getToolsForSession` | **4** |
| Universal protocol (MCP/A2A) | ❌ | ⬜ | ❌ | ⬜ | ⬜ | **1** |
| Output hygiene/capping | ❌ | ⬜ | Partial | ✓ Truncation | ✓ Truncation + LRU cache | **3** |

**Current status:** Cadence defines every tool as a JSON-Schema object with clear descriptions, validates tools via the schema, and serves capability-appropriate subsets (`getToolsForSession` gives sub-agents a reduced set and chat-only sessions none). Web outputs are truncated at 6 KB and `web_fetch` uses an LRU cache (20 entries / 5 MB).

**Gaps to close:**
- **No MCP / A2A integration.** Tools are bespoke to Cadence. Adopt MCP for external tool servers and A2A for inter-agent handoff — this is the single largest structural gap.
- **No server-side schema validation before execution** (validation happens at the tool boundary but is not a hard schema-enforced gate).
- **Output capping is ad hoc** (6 KB truncation) rather than a principled "persist long outputs to disk / vector store, keep only a pointer in context" policy.

---

## 2. Agentic Loops

### SOTA reference
- **ReAct** (Yao et al., 2022) interleaves **Reasoning** (`<thought>` / chain-of-thought) and **Acting** (tool calls), feeding observations back into the next reasoning step. This is the dominant loop shape.
- **Reflection** (Shinn et al.) adds a self-critique pass: after acting, the agent reviews its own output and improves it before finalizing.
- **Plan-then-execute** (and Tree-of-Thoughts, Yao et al. 2023) decomposes goals into explicit, ordered sub-tasks, sometimes exploring alternatives as a tree.
- **Anthropic Agent SDK "4 loops"**: (a) **Self-critique loop**, (b) **Memory loop**, (c) **Multi-agent loop**, (d) **Self-generating-tests loop**. These are the canonical modern refinement loops.
- **OpenAI Codex Agent** uses a plan-then-execute loop with built-in self-critique and test-driven verification.

### The standard
1. **Reason-Act-Observate core.** Each turn contains explicit reasoning, a tool action, and an observation folded back into context.
2. **Bounded iteration.** The loop has a hard turn limit and a soft throttle point well before it.
3. **Self-critique / reflection.** The agent reviews its own work before declaring completion.
4. **Explicit planning for complex work.** A plan (and ideally a task checklist) precedes multi-step execution; trivial tasks skip planning.
5. **Loop safeguards.** Detection of repetition loops, protocol violations, empty turns, and runaway loops — with forced recovery (halt, re-plan, or escalate).

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| ReAct core (thought+act+observe) | ❌ | ⬜ | Partial | ✓ `<thought>` + tools | ✓ Native reasoning aware | **4** |
| Bounded iteration | ❌ | ⬜ | Partial | ✓ Turn limit | ✓ maxTurns + throttle | **4** |
| Self-critique / reflection | ❌ | ⬜ | Partial | ❌ | ✓ Loop-level | **2** |
| Explicit planning | ❌ | ⬜ | Partial | ✓ Plan mode | ✓ Planning mode + tasks | **4** |
| Loop safeguards | ❌ | ⬜ | Partial | ✓ Repetition detect | ✓ Multiple safeguards | **4** |

**Current status:** Cadence implements a ReAct loop with `<thought>` blocks (and a native-reasoning variant that leverages the model's own thinking), a hard `maxTurns` limit with a soft throttle bar at ⅓ of the budget, and explicit safeguards: protocol-flag detection, repetition-loop detection, empty-turn handling, and `consecutiveHaltCount`. Planning mode adds a plan + task-checklist phase.

**Gaps to close:**
- **No dedicated reflection / self-critique pass.** The loop is ReAct + plan-then-execute but lacks the Anthropic "self-critique loop" — a post-action review step that critiques and re-generates before finalizing.
- **No self-generating-tests loop.** Tests are produced by the human or the agent ad hoc, not as a structured, loop-driven mechanism.
- **Reflection-style planning is reactive** (plan exists, but there's no mechanism to re-plan after a failed cycle beyond compaction).

---

## 3. Error Handling & Recovery

### SOTA reference
- **Forgiving edits** (Claude Code, OpenHands): edits are proposed, syntax-checked, and auto-rolled-back on failure rather than mutating the workspace destructively.
- **Checkpoints / rollbacks**: systems snapshot state and offer point-in-time restore (e.g., `git`-like history of agent actions).
- **Retry with backoff**: transient failures (network, rate limits, model errors) are retried with exponential backoff.
- **Idempotency**: operations that may be retried (compaction, backups) are designed to be safe to repeat.
- **Safe failure modes**: a failing subsystem degrades to a no-op rather than crashing the whole agent.

### The standard
1. **Edits are forgiving.** Changes are validated before they hit disk and can be rolled back to a prior state.
2. **Atomic transactions.** A turn's changes are grouped; partial failures don't leave the workspace half-mutated.
3. **Checkpoints.** The agent can mark milestones and restore to them.
4. **Bounded retries.** Transient errors retry a limited number of times before escalating or halting.
5. **Idempotent compaction.** Context reduction never double-applies or loses recoverable information.
6. **Auto-rollback thresholds.** A model that repeatedly produces invalid output is forced to recover rather than dig a deeper hole.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Forgiving edits | ❌ | ⬜ | Partial | ✓ Validate-before-disk | ✓ Validate + modes | **4** |
| Atomic transactions | ❌ | ⬜ | Partial | ✓ Turn tx | ✓ IndexedDB tx | **4** |
| Checkpoints | ❌ | ⬜ | Partial | ✓ Named | ✓ `checkpoint` tool | **4** |
| Bounded retries | ❌ | ⬜ | Partial | ⬜ | ✓ Auto-rollback threshold | **3** |
| Idempotent compaction | ❌ | ⬜ | Partial | ✓ Idempotent guard | ✓ Idempotent + seed | **4** |
| Auto-rollback | ❌ | ⬜ | Partial | ✓ Partial | ✓ Threshold=3 | **4** |

**Current status:** Cadence is strong here. `edit_file` validates syntax *before* writing (via `syntax-validator.mjs`), backs up before writing, and groups changes per-turn via an IndexedDB atomic transaction (`AgentBackup.recordFileChange` with `turnTransactionId`). Forgiveness mode auto-backups and auto-rolls-back; Permission mode holds edits in a review buffer. Consecutive syntax failures (default threshold 3) trigger auto-rollback to `cycle_start`. Compaction is idempotent and uses a lightweight "seed" while the full summary is generated.

**Gaps to close:**
- **No network / rate-limit retry with backoff** is documented in the harness itself — recovery is mainly edit/rollback focused.
- **Checkpoints are manual** (the agent must call `checkpoint`); a mature harness could auto-checkpoint at milestones or before risky operations.
- **`MAX_VERSIONS=10`** is a hard cap with no visibility policy — older backups are silently dropped.

---

## 4. Safety & Guardrails

### SOTA reference
- **Permission gating**: dangerous operations (shell commands, network, file writes) require explicit approval or a verified allowlist.
- **Allow / deny lists with precedence**: block-wins semantics; scoped allowlists (e.g., allow `git status` but block `git reset`).
- **Sandboxing**: agents run in constrained environments (read-only mounts, no egress, resource caps).
- **Risk classification**: commands/actions are categorized (safe/moderate/dangerous) and gated accordingly.
- **Least privilege**: agents get only the tools and permissions needed for the task.

### The standard
1. **Every side-effecting action is gated.** Reads are free; writes/execution require approval or a trusted allowlist.
2. **Block-wins precedence.** When allow and block conflict, block wins.
3. **Scoped allowlists.** Permissions constrain sub-commands, not just programs (allow `git status`, not all of `git`).
4. **Nested-command coverage.** A top-level allow must not mask an unapproved program nested inside a substitution (`echo $(rm -rf /)`).
5. **Risk ordering.** Actions are classified by risk and escalated proportionally.
6. **Sandboxing** at the environment layer (network egress controls, filesystem boundaries, resource limits).

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Side-effect gating | ❌ | ⬜ | Partial | ✓ Approval | ✓ Approval + whitelist | **4** |
| Block-wins precedence | ❌ | ⬜ | Partial | ✓ Yes | ✓ Yes | **4** |
| Scoped allowlists | ❌ | ⬜ | Partial | ✓ subs filter | ✓ subs + argsPrefix | **4** |
| Nested coverage | ❌ | ⬜ | Partial | ✓ Partial | ✓ Full coverage | **4** |
| Risk classification | ❌ | ⬜ | Partial | ✓ safe/mod/dang | ✓ ordered + badges | **4** |
| Sandboxing | ❌ | ⬜ | ❌ | ⬜ | ⬜ | **1** |

**Current status:** Cadence has a sophisticated, well-tested command policy engine (`command-rules.mjs`): canonical `{allow, block}` policies, `mergePolicies(master, session)`, block-wins precedence, `subs` subcommand filters, `argsPrefix` matching, risk ordering (safe → moderate → dangerous → unknown), and full nested-program coverage so a top-level allow cannot mask a nested dangerous program.

**Gaps to close:**
- **No true sandboxing.** Command execution is gated by policy but not isolated in a sandbox (namespace, seccomp, container, or egress restriction). This is the highest-priority safety gap.
- **Permission model is policy-only** — no runtime capability enforcement (e.g., read-only filesystem mounts, network allowlist at the OS layer).

---

## 5. Memory & Context Management

### SOTA reference
- **Short-term (context window)**: the working memory; managed by compaction, caching, and "persist large outputs outside the window."
- **Long-term (session / vector store / DB)**: durable state across turns and sessions — files, backups, summaries, preferences.
- **Two-stage compaction**: first a lightweight "seed" keeps the agent oriented while a full summary is generated, then the summary replaces the span.
- **Anthropic memory loop**: a dedicated loop that decides what to persist, retrieve, and forget.
- **Context engineering**: pruning irrelevant history, using embeddings for retrieval, and treating context as a scarce, budgeted resource.

### The standard
1. **Clear separation of short- and long-term memory.** Ephemeral context is compacted; durable state is persisted.
2. **Two-stage compaction.** A seed maintains orientation during summary generation.
3. **Idempotent, lossless-ish compaction.** Summaries preserve recoverable facts; the process can be safely repeated.
4. **Bounded context budget.** Hard limits on context size with eviction (LRU / size caps).
5. **Retrieval over brute force.** Prefer targeted read/search over dumping whole files into context.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Short/long-term split | ❌ | ⬜ | Partial | ✓ Split | ✓ Split + persistence | **4** |
| Two-stage compaction | ❌ | ⬜ | Partial | ✓ Seed + summary | ✓ Seed + summary | **4** |
| Idempotent compaction | ❌ | ⬜ | Partial | ✓ Idempotent | ✓ Idempotent | **4** |
| Bounded budget | ❌ | ⬜ | Partial | ✓ LRU | ✓ LRU 20/5MB | **3** |
| Retrieval over brute force | ❌ | ⬜ | Partial | ✓ Tool guidance | ✓ Guidance + tools | **3** |
| Explicit memory loop | ❌ | ⬜ | Partial | ⬜ | ⬜ | **1** |

**Current status:** Cadence implements two-stage context compaction: a lightweight content seed is extracted while the full `cycle_summary` is generated, then the summary replaces the collapsed span. Compaction is idempotent (guard against double-summarizing) and persists session state via `workspaceClient`. Web fetches use an LRU cache (20 entries / 5 MB). The system prompt explicitly discourages reading whole files.

**Gaps to close:**
- **No dedicated memory loop.** Retrieval/persistence is not loop-driven; there's no structured "decide what to remember" mechanism (Anthropic loop #2).
- **No vector-store / semantic retrieval.** Context pruning is heuristic; there's no embedding-based recall of past work.
- **Context budget is implicit** (model limits) rather than an explicit, enforced token budget with proactive pruning.

---

## 6. Multi-Agent Orchestration

### SOTA reference
- **Supervisor / worker (or orchestrator / sub-worker)**: a main agent delegates discrete, scoped tasks to sub-agents with isolated context and a reduced toolset, then compiles results.
- **Mission control** (GitHub): coordinates multiple coding agents — parallel vs. sequential execution, when to intervene, how to review.
- **Orchestration libraries** (LangGraph, AutoGen, CrewAI, MetaGPT): the developer composes a graph or role spec; the runtime is thin.
- **Key hazard**: parallel agents can clobber each other's filesystem changes — coordination must prevent interference.
- **A2A** enables agents to hand work to other agents across process/organization boundaries.

### The standard
1. **Sub-agents have isolated context and scoped tools.** They cannot see or touch the parent's full workspace or orchestration capabilities.
2. **Clear delegation contract.** Each sub-agent gets a single objective and a defined completion signal.
3. **Result compilation.** The parent merges/validates sub-agent results before continuing.
4. **Parallel-safety.** Concurrent agents are coordinated so they don't mutate shared state unsafely.
5. **Size/cost-aware delegation.** Match sub-agent capability to task complexity.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Isolated sub-agent context | ❌ | ⬜ | Partial | ✓ Clean context | ✓ Clean + scoped tools | **4** |
| Delegation contract | ❌ | ⬜ | Partial | ✓ Objective | ✓ Objective + complete | **4** |
| Result compilation | ❌ | ⬜ | Partial | ✓ Partial | ✓ `checkAndCompile` | **4** |
| Parallel-safety | ❌ | ⬜ | Partial | ⬜ | ⬜ | **2** |
| Size-aware delegation | ❌ | ⬜ | Partial | ✓ size enum | ✓ tiny/small/medium | **4** |

**Current status:** Cadence implements a supervisor/worker model: `create_sub_agent` spawns agents with clean context and a reduced toolset (`subAgentToolsList`, no orchestration tools), a `size` enum (tiny/small/medium) for cost-aware delegation, a sub-agent protocol in the system prompt, and `checkAndCompileSubAgentResults` to fold completed sub-agent results back into the parent's turn.

**Gaps to close:**
- **Parallel-safety is unaddressed.** If multiple sub-agents run concurrently, there's no documented coordination to prevent filesystem clobbering — a known hazard in multi-agent systems.
- **No graph/role orchestration.** Sub-agents are ad hoc; there's no composed graph of specialized roles (unlike LangGraph/CrewAI).
- **No A2A** for cross-boundary agent handoff.

---

## 7. Evaluation Methodology

### SOTA reference
- **SWE-bench**: real GitHub issues resolved against a repo's test suite; the canonical *coding agent* benchmark.
- **SWE-bench Pro** (harder, longer-horizon, multi-file): **Qwen3 27B scores 61.7%** — a notable result for a model of its size, demonstrating that harness quality amplifies smaller models.
- **DeepSWE**: a demanding eval where **Qwen3 27B scores 42.2**, again underscoring harness-over-model scaling.
- **SWE-Agent / SWE-Rollout**: reproducible agent eval frameworks.
- **LLM-as-judge** vs. **computational controls** (tests, linters): the latter are more reliable for code.
- **Trajectory retention + replay**: evals record full agent trajectories for analysis.

### The standard
1. **A representative eval suite.** Real tasks with objective pass/fail criteria (tests), not just human preference.
2. **Multiple dimensions.** Correctness, efficiency, safety, cost, and user-satisfaction are measured separately.
3. **Trajectory logging.** Full turn-by-turn records enable post-hoc analysis and self-improvement.
4. **Reproducibility.** Runs are deterministic-enough to compare across versions.
5. **Model-size-agnostic scoring.** Recognize that a good harness lets smaller models approach or beat frontier models on hard benchmarks.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Objective eval suite | ❌ | ⬜ | Partial | ⬜ | ⬜ | **1** |
| Multiple dimensions | ❌ | ⬜ | Partial | ⬜ | ✓ Partial (telemetry) | **2** |
| Trajectory logging | ❌ | ⬜ | Partial | ✓ History | ✓ History + compaction | **3** |
| Reproducibility | ❌ | ⬜ | Partial | ⬜ | ⬜ | **1** |
| Cost/latency telemetry | ❌ | ⬜ | Partial | ✓ Partial | ✓ tokensIn/out/tok-s | **4** |

**Current status:** Cadence tracks per-provider telemetry (tokens in/out, tokens/sec, latency) and retains full message history (compacted into summaries). It does *not* run an objective benchmark suite (SWE-bench / SWE-bench Pro / DeepSWE) or structured trajectory replay.

**Gaps to close:**
- **No objective eval suite.** Cadence has no SWE-bench-style harness to measure end-to-end task success against a test oracle.
- **No trajectory replay / analysis tooling** for post-hoc debugging or self-improvement.
- **Opportunity:** Qwen3 27B's 61.7 (SWE-bench Pro) / 42.2 (DeepSWE) results are a reminder that harness quality is measurable and that Cadence's strong harness could be *validated* against these benchmarks once an eval harness exists.

---

## 8. Human-in-the-Loop

### SOTA reference
- **Permission mode** (Claude Code, Codex): proposed edits are reviewed in a diff view and explicitly applied/discarded by the human.
- **Approval gating**: side-effecting actions pause for human confirmation.
- **Transparency**: the human can see the agent's reasoning, tool calls, and current plan at all times.
- **Interruptibility**: the human can halt, throttle, resume, or redirect the agent at any moment.
- **Progressive autonomy**: trust scales with task reliability — more autonomy for low-risk, more review for high-risk.

### The standard
1. **Review before irreversible action.** Edits and dangerous commands are surfaced for human approval.
2. **Diff-based review.** Changes are shown as diffs, not raw file dumps.
3. **Live transparency.** Reasoning, tool calls, and plan are visible.
4. **Runtime control.** Halt, throttle, continue, and redirect are always available.
5. **Escalation.** Unclear or high-risk actions escalate to the human rather than proceeding autonomously.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Review before action | ❌ | ⬜ | Partial | ✓ Permission mode | ✓ Permission + diff | **4** |
| Diff-based review | ❌ | ⬜ | Partial | ✓ Diff view | ✓ Diff view | **4** |
| Live transparency | ❌ | ⬜ | Partial | ✓ Messages | ✓ Messages + plan | **4** |
| Runtime control | ❌ | ⬜ | Partial | ✓ Throttle/halt | ✓ Throttle/halt/continue | **4** |
| Escalation | ❌ | ⬜ | Partial | ✓ Escalate | ✓ Escalate + query | **4** |

**Current status:** Cadence is mature here. Permission mode holds edits in a review buffer shown in a side-by-side diff view for apply/discard; Forgiveness mode auto-backups and auto-rolls-back. The `query` tool lets the agent ask the user for decisions at any time. Throttle/halt bars give runtime control. Command execution is gated behind approval unless whitelisted.

**Gaps to close:**
- **Escalation is agent-initiated** (the agent *asks* via `query`) rather than a structured, policy-driven escalation path for high-risk actions.
- **No staged/rolling approval** for multi-step changes (approve the plan once, or per-cycle) — every edit currently reviews individually.

---

## 9. Self-Improvement

### SOTA reference
- **Self-generating-tests loop** (Anthropic loop #4): the agent writes its own tests, then uses them to verify and correct its work.
- **Self-critique loop** (Anthropic loop #1): the agent reviews and re-generates its outputs.
- **RL from human feedback (RLHF) / RL from AI feedback (RLAIF)**: fine-tuning the base model on agent trajectories.
- **Self-trained / self-collected data**: successful trajectories are mined and used for future fine-tuning.
- **Continuous improvement via eval feedback**: benchmark results feed back into prompt/tool/harness revisions.

### The standard
1. **The agent generates and runs its own tests** to verify work, not just claim it.
2. **Structured self-critique** that re-generates failing outputs.
3. **Trajectory mining** to surface recurring failure modes.
4. **A feedback loop** where eval results drive harness/prompt/tool improvements.
5. **Versioned harness** so improvements can be measured, not just shipped.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Self-generated tests | ❌ | ⬜ | Partial | ❌ | ❌ | **1** |
| Self-critique loop | ❌ | ⬜ | Partial | ❌ | ⬜ | **1** |
| Trajectory mining | ❌ | ⬜ | ❌ | ⬜ | ⬜ | **1** |
| Eval feedback loop | ❌ | ⬜ | Partial | ❌ | ⬜ | **1** |
| Versioned harness | ❌ | ⬜ | ✓ Git | ✓ Git | ✓ Git | **4** |

**Current status:** Cadence has a versioned, git-tracked harness (improvements are reviewable). It does *not* yet implement self-generating tests, a self-critique loop, trajectory mining, or an eval-driven feedback loop.

**Gaps to close:**
- **No self-generating-tests loop** — the most impactful self-improvement mechanism and one of Anthropic's four canonical loops.
- **No self-critique loop** (see §2).
- **No trajectory mining or eval feedback loop** — improvements are manual, not data-driven.

---

## 10. Concurrency & Parallelism

### SOTA reference
- **Parallel tool calls**: independent tools (reads, searches) are batched in a single turn; dependent calls are serialized.
- **Provider-aware parallelism**: not all models/providers support parallel tool calling — the harness gates it per capability.
- **Read-only parallelism**: parallel execution is safest for read-only operations; writes require coordination.
- **Throttling**: long-running tasks are throttled to respect rate limits and keep the human informed.
- **Concurrency hazards**: parallel agents writing to shared state can clobber each other — coordination is essential.

### The standard
1. **Batch independent tool calls.** Serialize only when a later call depends on an earlier result.
2. **Gate parallelism per-provider.** Respect each model's native parallel tool-call support.
3. **Prefer read-only parallelism.** Coordinate or serialize writes.
4. **Rate-limit-aware throttling.** Long tasks are throttled before hitting provider limits.
5. **Concurrency-safe orchestration.** Parallel agents don't mutate shared state unsafely.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Batch independent calls | ❌ | ⬜ | Partial | ✓ Guidance | ✓ Guidance + schema | **3** |
| Provider-gated parallelism | ❌ | ⬜ | Partial | ✓ Per-provider | ✓ supportsParallelTools | **4** |
| Read-only parallel preference | ❌ | ⬜ | Partial | ⬜ | ⬜ | **2** |
| Rate-limit throttling | ❌ | ⬜ | Partial | ✓ Throttle bar | ✓ Throttle + halt | **4** |
| Concurrency-safe orchestration | ❌ | ⬜ | Partial | ⬜ | ⬜ | **2** |

**Current status:** Cadence gates parallel tool calls per-provider (`supportsParallelTools` / `supportsJSONTools`), guides the model to batch independent calls and serialize dependent ones, and throttles long-running tasks via throttle/halt bars tied to `maxTurns`.

**Gaps to close:**
- **Parallelism is single-agent only.** Within a turn, "batch independent calls" is a prompt suggestion, not enforced — there's no runtime fan-out.
- **No concurrency safety for parallel sub-agents** (see §6).
- **No read-vs-write parallelism policy** — the harness doesn't distinguish read-only (safe to parallelize) from write (needs coordination) operations.

---

## Appendix A — Overall Maturity Summary

| Theme | Status | Notes |
|---|---|---|
| 1. Tool Design | **4** | Adopt MCP/A2A to close the structural gap. |
| 2. Agentic Loops | **4** | Add reflection/self-critique + self-gen-tests loops. |
| 3. Error Handling | **4** | Add retry/backoff; auto-checkpoint. |
| 4. Safety & Guardrails | **4** | **Sandboxing is the critical gap.** |
| 5. Memory & Context | **4** | Add memory loop + semantic retrieval. |
| 6. Multi-Agent | **4** | Parallel-safety + role graphs. |
| 7. Evaluation | **1** | No objective eval suite — build SWE-bench-style harness. |
| 8. Human-in-the-Loop | **4** | Add staged/rolling approval. |
| 9. Self-Improvement | **1** | No self-gen-tests / self-critique / feedback loop. |
| 10. Concurrency | **4** | Enforce parallelism policy; concurrency safety. |

**Highest-priority gaps (impact × effort):**
1. **Sandboxing** (§4) — the single most important safety improvement.
2. **Objective evaluation harness** (§7) — enables everything in §9.
3. **Self-generating-tests loop** (§9) — a canonical Anthropic loop with high leverage.
4. **Reflection / self-critique loop** (§2) — closes the main loop gap.
5. **MCP / A2A integration** (§1) — closes the tool/agent protocol gap.

**What's already SOTA:** Cadence's command policy engine, forgiving-edit + auto-rollback recovery, two-stage compaction, supervisor/worker sub-agents, and human-in-the-loop diff review are all at or near frontier quality. The gaps below are the difference between "strong today" and "reference standard."
