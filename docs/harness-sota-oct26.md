# The Cadence Harness Standard — October 2026 Edition

> A state-of-the-art reference for agentic-coding-harness design, written to serve two purposes at once:
> (1) a specification of what "good" looks like in an agent harness, and
> (2) a self-evaluation rubric for auditing and evolving **Cadence's** own implementation.
>
> Each section follows the same shape:
> - **SOTA reference** — how the frontier systems and research address the theme.
> - **The standard** — the properties a production-grade harness should exhibit.
> - **Cadence self-evaluation** — a maturity rubric (1–5), Cadence's current status, and concrete gaps to close.
>
> **This is the October 2026 edition**, a re-verification of every rubric item against the current codebase with refreshed SOTA citations. The August 2026 edition is [`harness-sota-aug26.md`](harness-sota-aug26.md).

> ### What changed since August 2026
> Two material improvements and one structural re-scoring:
> - **Sandboxing (1 → 4).** Cadence now ships a native Linux user-namespace sandbox (`sandbox_*.go`): a persistent reexec *keeper* coprocess, raw-syscall `unshare` child, `pivot_root` to hide the host filesystem and close the `/oldroot` backdoor, a `bwrap` fallback, refcounted shared instances keyed by a layout fingerprint, environment scrubbing, and `PR_SET_PDEATHSIG`. This matches the Claude Code (bwrap) / Codex (bubblewrap+Landlock+seccomp) SOTA pattern and is *more* thorough than raw bwrap. It is Linux-only (macOS/Windows run unsandboxed), which is why the score lands at **4** rather than 5.
> - **Bounded retries (3 → 4).** `_fetchWithRetry` (`ai.mjs:569`) now implements exponential backoff (1 s → 30 s), ±25 % jitter, `Retry-After` header support, and 429/5xx handling; `_isTemporaryUnavailableError` (503/UNAVAILABLE) surfaces a Try-again banner.
> - **New context-management machinery.** `ai-manager-cull-index.mjs` (model-lead `cull_history` pruning) and `ai-manager-scratchpad-nudge.mjs` (ephemeral nudge on context pressure) are now pure, testable modules.
>
> Confirmed still-missing (re-verified): MCP/A2A, self-critique loop, self-generating-tests loop, memory loop / semantic retrieval, sub-agent parallel-safety, objective eval suite, staged/rolling approval.

---

## 0. What a harness is (and why it matters more than the model)

A **harness** is the runtime that wraps a base model in the loops, tools, memory, safety gates, and human interfaces that make it reliably useful. The central thesis of modern agent engineering is:

> *A marginally-smarter model inside a better harness will routinely beat a frontier model inside a poor one. Harnessability should be a first-class criterion in architecture decisions.*

The evidence for this is now sharper than in August 2026. **[SWE-bench Verified](https://www.swebench.com/)** (500 human-filtered issues) has become *saturating* at the frontier — the top models now cluster within a ~12-point band — which means the differentiator is shifting from raw model capability to **harness quality**. New benchmarks are designed specifically to resist saturation: **DeepSWE** (113 original long-horizon tasks across 91 repos and 5 languages, with hand-written behavioral verifiers and contamination resistance), **ProgramBench** (code-from-scratch, May 2026), and **CodeClash** (goal-oriented, Nov 2025). A striking data point: **[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) — ~100 lines of Python — scored 65 % on SWE-bench Verified**, demonstrating that a well-shaped, *simple* harness can approach frontier results. Frontier coding agents (Claude Code, Codex, Gemini Agent) continue to converge architecturally despite different base models, which confirms that the *runtime patterns* — not the weights — are the differentiator. This document codifies those patterns.

---

## 1. Tool Design

### SOTA reference
- **Anthropic Agent SDK** ships tools as strict JSON-Schema objects with declarative `name`, `description`, and `parameters`. Descriptions are treated as *interfaces to the model* — the single most important signal for correct tool selection.
- **[MCP (Model Context Protocol)](https://modelcontextprotocol.io/)** — donated by Anthropic to the Linux Foundation's new **Agentic AI Foundation (AAIF)** on **Dec 9, 2025** ([announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)) (co-founded with Block and OpenAI), giving it vendor-neutral governance. It is now adopted by **OpenAI** and **Google DeepMind** in addition to Anthropic. MCP decouples tools from the agent runtime via a universal client/server contract, enabling a marketplace of shareable tool servers.
- **[A2A (Agent2Agent)](https://a2a-protocol.org/)** — donated by Google to the Linux Foundation in **June 2025**. By its one-year mark (Apr 2026, [one-year report](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)) it had **150+ member organizations** and **22k+ GitHub stars**, with production integrations spanning Google, Microsoft, and AWS. A2A is the peer-to-peer protocol agents use to hand off work to *other agents* (as opposed to MCP, which lets agents talk to *tools*).
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

**Current status:** Cadence defines every tool as a JSON-Schema object with clear descriptions (typed `properties`, explicit `required`, `enum`s), validates tool arguments at the tool boundary, and serves capability-appropriate subsets via `getToolsForSession` (`ai-manager-tools-schema.mjs:446`): sub-agents get a reduced 15-tool `subAgentToolsList` (no orchestration tools), chat-only sessions get none, and the main agent gets the full set plus `cull_history` when model-lead pruning is opted in. `web_fetch` uses an LRU cache (20 entries / 5 MB, `agent-tools.mjs:22–26`).

**Gaps to close:**
- **No MCP / A2A integration.** Tools are bespoke to Cadence. With MCP now under the vendor-neutral AAIF and A2A at 150+ orgs, the cost of adopting these protocols has dropped sharply. Adopt MCP for external tool servers and A2A for inter-agent handoff — this remains the single largest *structural* gap in tool design.
- **No hard server-side schema gate before execution** (validation happens at the tool boundary but is not a schema-enforced pre-execution check).
- **Output capping is ad hoc** (truncation + LRU) rather than a principled "persist long outputs to disk / vector store, keep only a pointer in context" policy.

---

## 2. Agentic Loops

### SOTA reference
- **[ReAct](https://arxiv.org/abs/2210.03629)** (Yao et al., 2022) interleaves **Reasoning** (`<thought>` / chain-of-thought) and **Acting** (tool calls), feeding observations back into the next reasoning step. This is the dominant loop shape.
- **[Reflexion](https://arxiv.org/abs/2303.11366)** (Shinn et al.) adds a self-critique pass: after acting, the agent reviews its own output and improves it before finalizing.
- **Plan-then-execute** (and [Tree-of-Thoughts](https://arxiv.org/abs/2305.10601), Yao et al. 2023) decomposes goals into explicit, ordered sub-tasks, sometimes exploring alternatives as a tree.
- **[Anthropic "Building Effective Agents"](https://www.anthropic.com/research/building-effective-agents)** (Dec 2024, still the reference text) names **5 composable workflow patterns** and the **4 canonical refinement loops**: (a) **Self-critique loop**, (b) **Memory loop**, (c) **Multi-agent loop**, (d) **Self-generating-tests loop**. These are the canonical modern refinement loops, and the gap list below is organized around them.
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

**Current status:** Cadence implements a ReAct loop with `<thought>` blocks (and a native-reasoning variant that leverages the model's own thinking), a hard `maxTurns` limit with a soft throttle bar at ⅓ of the budget (`maxIterations = maxTurns/3`, `agent.mjs:64`), and explicit planning via a plan + task-checklist phase.

The **recovery machinery** is unusually rich (all in `agent.mjs`):
- **Protocol-flag recovery** — a `secondary_thought`/`secondary_tool_call` flag strips the offending turn and resubmits, up to 5 attempts (`protocolFlagRepeatCount < 5`, `agent.mjs:326–355`), then halts with a Continue affordance that resets the counter for another 5 (`agent.mjs:392–394`).
- **Repetition-loop recovery** — `_detectRepetition` trims the repeated pattern, scales temperature to force divergence (`temperatureOverride = 0.75 + 0.05·count`, capped at 0.98, `agent.mjs:458`), injects a `system_directive`, up to 5 attempts (`repetitionHaltCount < 5`, `agent.mjs:436`), then halts (`agent.mjs:511`).
- **Empty-turn recovery** — a thought-only / no-tool turn is cropped and resubmitted, up to 5 attempts (`emptyTurnRetryCount < 5`, `agent.mjs:646–653`).
- **Sub-agent directive** — a sub-agent that ends a turn without a tool call gets a firm "you MUST end with a tool call" directive injected, up to 3 attempts (`consecutiveHaltCount < 3`, `agent.mjs:693–712`), then is forced to `sub_agent_complete` so the parent is never left hanging.
- **Auto-continue** — an optional `autoContinue` mode resumes a halted loop up to 3 times (`agent.mjs:760`).
- **Throttle reset** — the `query` tool resets the loop counter so human-in-the-loop pauses don't consume budget (`agent.mjs:912–916`).

**Gaps to close:**
- **No dedicated reflection / self-critique pass.** The loop is ReAct + plan-then-execute but lacks the Anthropic "self-critique loop" — a post-action review step that critiques and re-generates before finalizing.
- **No self-generating-tests loop.** Tests are produced by the human or the agent ad hoc, not as a structured, loop-driven mechanism (Anthropic loop #4).
- **Reflection-style planning is reactive** (a plan exists, but there's no mechanism to re-plan after a failed cycle beyond compaction).

---

## 3. Error Handling & Recovery

### SOTA reference
- **Forgiving edits** (Claude Code, [OpenHands](https://github.com/All-Hands-AI/OpenHands)): edits are proposed, syntax-checked, and auto-rolled-back on failure rather than mutating the workspace destructively.
- **Checkpoints / rollbacks**: systems snapshot state and offer point-in-time restore (e.g., `git`-like history of agent actions).
- **Retry with backoff**: transient failures (network, rate limits, model errors) are retried with exponential backoff and jitter, honoring `Retry-After`.
- **Idempotency**: operations that may be retried (compaction, backups) are designed to be safe to repeat.
- **Safe failure modes**: a failing subsystem degrades to a no-op rather than crashing the whole agent.

### The standard
1. **Edits are forgiving.** Changes are validated before they hit disk and can be rolled back to a prior state.
2. **Atomic transactions.** A turn's changes are grouped; partial failures don't leave the workspace half-mutated.
3. **Checkpoints.** The agent can mark milestones and restore to them.
4. **Bounded retries.** Transient errors retry a limited number of times with backoff before escalating or halting.
5. **Idempotent compaction.** Context reduction never double-applies or loses recoverable information.
6. **Auto-rollback thresholds.** A model that repeatedly produces invalid output is forced to recover rather than dig a deeper hole.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Forgiving edits | ❌ | ⬜ | Partial | ✓ Validate-before-disk | ✓ Validate + modes | **4** |
| Atomic transactions | ❌ | ⬜ | Partial | ✓ Turn tx | ✓ IndexedDB tx | **4** |
| Checkpoints | ❌ | ⬜ | Partial | ✓ Named | ✓ `checkpoint` tool | **4** |
| Bounded retries | ❌ | ⬜ | Partial | ✓ Backoff + jitter | ✓ + Retry-After | **4** |
| Idempotent compaction | ❌ | ⬜ | Partial | ✓ Idempotent guard | ✓ Idempotent + seed | **4** |
| Auto-rollback | ❌ | ⬜ | Partial | ✓ Partial | ✓ Threshold=3 | **4** |

**Current status:** Cadence is strong here. `edit_file` validates syntax *before* writing (via `syntax-validator.mjs`), backs up before writing, and groups changes per-turn via an IndexedDB atomic transaction (`AgentBackup.recordFileChange` with `turnTransactionId`). Forgiveness mode auto-backups and auto-rolls-back; Permission mode holds edits in a review buffer. Consecutive syntax failures (default threshold 3) trigger auto-rollback to `cycle_start`. Compaction is idempotent and uses a lightweight "seed" while the full summary is generated.

**Bounded retries are now implemented** (the main gap from August 2026 is closed). `_fetchWithRetry` (`ai.mjs:569`) retries transient failures up to 3 times with exponential backoff (1 s → 30 s), ±25 % jitter (clamped 500 ms–30 s), and `Retry-After` header support; it handles 429 and 5xx (500/502/503/504) and network errors. `_isTemporaryUnavailableError` (`ai.mjs:530`) classifies 503/UNAVAILABLE so the loop can surface a Try-again banner (`agent.mjs:1159`) rather than a hard failure, and the Gemini provider has its own 503 retry path with a backoff schedule (`ai-gemini.mjs:1069`).

**Gaps to close:**
- **Checkpoints are manual** (the agent must call `checkpoint`); a mature harness could auto-checkpoint at milestones or before risky operations.
- **`MAX_VERSIONS=10`** is a hard cap with no visibility policy — older backups are silently dropped (`agent-backup.mjs:3`).
- **Retry is transport-focused**; there is no retry-with-backoff for *tool-level* transient failures (e.g., a flaky `run_command`), only for the model API.

---

## 4. Safety & Guardrails

### SOTA reference
- **Permission gating**: dangerous operations (shell commands, network, file writes) require explicit approval or a verified allowlist.
- **Allow / deny lists with precedence**: block-wins semantics; scoped allowlists (e.g., allow `git status` but block `git reset`).
- **Sandboxing**: agents run in constrained environments (read-only mounts, no egress, resource caps). The frontier pattern is **OS-native primitives**: **[Claude Code](https://docs.anthropic.com/en/docs/claude-code/security)** uses Seatbelt (`sandbox-exec`) on macOS and bubblewrap on Linux/WSL2, with network via a proxy allowlist. **[Codex CLI](https://github.com/openai/codex)** uses Seatbelt (SBPL) on macOS, bubblewrap + Landlock + seccomp on Linux, and restricted tokens + DACLs on Windows.
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
| Sandboxing | ❌ | ⬜ | ✓ Policy-only | ✓ Native userns | ✓ Native + multi-OS | **4** |

**Current status:** Cadence has a sophisticated, well-tested command policy engine (`command-rules.mjs`): canonical `{allow, block}` policies, `mergePolicies(master, session)`, block-wins precedence, `subs` subcommand filters, `argsPrefix` matching, risk ordering (safe → moderate → dangerous → unknown), and full nested-program coverage so a top-level allow cannot mask a nested dangerous program.

**Sandboxing is now real** (the highest-priority safety gap from August 2026 is closed on Linux). The native implementation (`sandbox_*.go`, documented in `docs/sandbox.md`) runs `run_command` shells — and optionally user terminal tabs — inside a **shared Linux user-namespace sandbox**:
- **Reexec keeper model** — a long-lived keeper coprocess (a reexec of the same binary as `--sandbox-keeper <id> <socket>`, `sandbox_other.go:10`) has unshared into a fresh `user+mount+uts+ipc` namespace and applied the bind-mount layout once; owners *join* it by asking the keeper to fork a shell child. The unshare runs in a single-threaded `clone` child using raw syscalls only.
- **Host filesystem hidden** — a `pivot_root` sequence hides the host fs, and the `/oldroot` backdoor is closed (`rawDetachOldRoot` detaches every `/oldroot*` submount deepest-first with `MNT_DETACH`, plus the `/newroot/oldroot` staging bind). This is *more* thorough than raw bwrap.
- **Refcounted shared instances** keyed by a **layout fingerprint** (`sbx-xxxx` = first 4 bytes of a SHA-256 over sorted rw roots + sorted ro roots + the four namespace flags) — two owners with the same layout share one instance; the last owner reaps the keeper.
- **Hardening** — environment scrubbing (`scrubEnv` strips `LD_PRELOAD`, `GIT_SSH_COMMAND`, `SSH_AUTH_SOCK`, `*PROXY`), `PR_SET_PDEATHSIG=SIGKILL`, and server-side `securePath()` re-validation of roots.
- **`bwrap` fallback** — when the native path is unavailable (e.g., Ubuntu's AppArmor userns restriction) but `bwrap` is on PATH, each shell runs under `bwrap` with an empty tmpfs at `/` (host fs hidden).
- **Wired in** — `run_command` (`agent-tools.mjs`) sends `session=<id>` (a *sticky* owner so the sandbox persists for the session's lifetime) + `sandbox_roots=<workspace folders>`; user terminals can *attach* to an agent's sandbox; `GET /api/sandbox` (`main_common.go`) exposes capability + live instances; graceful degradation reports `sandbox: "unavailable"` + a reason rather than silently pretending.
- **Tested** — `sandbox_unix_test.go` verifies the bind-mount is real and writable, the host fs is hidden, the `/oldroot` backdoor is closed, `exit` EOFs the pty master, shared-instance semantics, the bwrap argv, env scrubbing, and the fingerprint.

This matches the Claude Code (bwrap on Linux) / Codex (bubblewrap+Landlock+seccomp) SOTA pattern.

**Gaps to close:**
- **Linux-only.** macOS/Windows report `sandbox: "unsupported"` and run unsandboxed. The path to a **5** is a macOS Seatbelt (`sandbox-exec`) implementation (and Windows restricted tokens/DACLs), matching the frontier multi-OS pattern.
- **Ubuntu AppArmor userns restriction** is the biggest deployment risk — mitigated by detection + graceful degradation + the documented `bwrap-userns-restrict` profile, but it means the native path is unavailable on stock Ubuntu 23.10+/24.04+ without the scoped profile.
- **No network egress control inside the sandbox** (the `sandbox_net` flag exists but is off by default); egress is not enforced at the OS layer.

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
6. **Model-lead pruning.** The model can proactively drop stale context it has decided is no longer needed.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Short/long-term split | ❌ | ⬜ | Partial | ✓ Split | ✓ Split + persistence | **4** |
| Two-stage compaction | ❌ | ⬜ | Partial | ✓ Seed + summary | ✓ Seed + summary | **4** |
| Idempotent compaction | ❌ | ⬜ | Partial | ✓ Idempotent | ✓ Idempotent | **4** |
| Bounded budget | ❌ | ⬜ | Partial | ✓ LRU | ✓ LRU 20/5MB | **3** |
| Retrieval over brute force | ❌ | ⬜ | Partial | ✓ Tool guidance | ✓ Guidance + tools | **3** |
| Model-lead pruning | ❌ | ⬜ | Partial | ✓ `cull_history` | ✓ + nudge | **4** |
| Explicit memory loop | ❌ | ⬜ | Partial | ⬜ | ⬜ | **1** |

**Current status:** Cadence implements two-stage context compaction: a lightweight content seed is extracted while the full `cycle_summary` is generated, then the summary replaces the collapsed span. Compaction is idempotent (a guard against double-summarizing) and persists session state via `workspaceClient`. Web fetches use an LRU cache (20 entries / 5 MB, `agent-tools.mjs:22–26`). The system prompt explicitly discourages reading whole files.

Two **new** context-management mechanisms (both pure, dependency-free, and unit-tested):
- **Model-lead pruning** — the `cull_history` tool (`ai-manager-tools-schema.mjs:420`) lets the model proactively drop stale dialogue turns as a structured tool call; the live handler is the tool-dispatched `case 'cull_history'` (`agent-tools.mjs:3316`), which resolves the model's *visible* dialogue position against the transient cull index and advances `session.contextHeadMsgId`. `ai-manager-cull-index.mjs` provides the pure index-space helpers (`buildCullIndex`, `resolveCullTarget`). It is main-agent-only and opt-in.
- **Scratchpad nudge** — `ai-manager-scratchpad-nudge.mjs` injects an *ephemeral* (never persisted) system directive nudging the model to call `scratchpad_write` when dynamic context grows past a threshold ratio of the prefill budget and the model hasn't already used the scratchpad in the visible window (self-clearing).

**Gaps to close:**
- **No dedicated memory loop.** Retrieval/persistence is not loop-driven; the scratchpad nudge and `cull_history` are *reactive* heuristics, not the Anthropic "memory loop" that decides what to remember/forget (loop #2).
- **No vector-store / semantic retrieval.** Context pruning is heuristic and lexical; there's no embedding-based recall of past work.
- **Context budget is implicit** (model limits + the nudge threshold) rather than a single explicit, enforced token budget with proactive, prioritized pruning.

---

## 6. Multi-Agent Orchestration

### SOTA reference
- **Supervisor / worker (or orchestrator / sub-worker)**: a main agent delegates discrete, scoped tasks to sub-agents with isolated context and a reduced toolset, then compiles results.
- **Mission control** (GitHub): coordinates multiple coding agents — parallel vs. sequential execution, when to intervene, how to review.
- **Orchestration libraries** (LangGraph, AutoGen, CrewAI, MetaGPT): the developer composes a graph or role spec; the runtime is thin.
- **Key hazard**: parallel agents can clobber each other's filesystem changes — coordination must prevent interference.
- **A2A** (now a Linux Foundation standard, 150+ orgs) enables agents to hand work to other agents across process/organization boundaries.

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

**Current status:** Cadence implements a supervisor/worker model: `create_sub_agent` spawns agents with clean context and a reduced 15-tool set (`subAgentToolsList`, no orchestration tools), a `size` enum (tiny/small/medium) for cost-aware delegation, a sub-agent protocol in the system prompt, and `checkAndCompileSubAgentResults` (`agent.mjs:1239`, called at turn start and after tool batches) to fold completed sub-agent results back into the parent's turn. A `create_another` flag (`agent.mjs:947`) lets a sub-agent spawn a further sub-agent. Sub-agents that end a turn without a tool call are forced to complete (see §2) so the parent is never left hanging.

**Gaps to close:**
- **Parallel-safety is unaddressed.** If multiple sub-agents run concurrently, there's no documented coordination to prevent filesystem clobbering — a known hazard in multi-agent systems. (The sandbox's shared-instance model is a *partial* mitigation for read-heavy work but not a write-coordination mechanism.)
- **No graph/role orchestration.** Sub-agents are ad hoc; there's no composed graph of specialized roles (unlike LangGraph/CrewAI).
- **No A2A** for cross-boundary agent handoff.

---

## 7. Evaluation Methodology

### SOTA reference
- **[SWE-bench Verified](https://www.swebench.com/)** (500 human-filtered issues, built with OpenAI): the canonical *coding agent* benchmark. It is now **saturating at the frontier** — the top models cluster within a ~**12-point band** — so it is less discriminative than it once was.
- **[DeepSWE](https://arxiv.org/abs/2607.07946)**: 113 *original* long-horizon tasks across 91 repos and 5 languages, with hand-written behavioral verifiers and contamination resistance — designed specifically to avoid the saturation SWE-bench is hitting.
- **[ProgramBench](https://www.swebench.com/)** (May 2026): code-from-scratch generation.
- **[CodeClash](https://www.swebench.com/)** (Nov 2025): goal-oriented, multi-agent.
- **[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)**: ~100 lines of Python scored **65 % on SWE-bench Verified** — a harness-simplicity data point showing the loop shape matters more than the harness's size.
- **LLM-as-judge** vs. **computational controls** (tests, linters): the latter are more reliable for code.
- **Trajectory retention + replay**: evals record full agent trajectories for analysis.

### The standard
1. **A representative eval suite.** Real tasks with objective pass/fail criteria (tests), not just human preference.
2. **Multiple dimensions.** Correctness, efficiency, safety, cost, and user-satisfaction are measured separately.
3. **Trajectory logging.** Full turn-by-turn records enable post-hoc analysis and self-improvement.
4. **Reproducibility.** Runs are deterministic-enough to compare across versions.
5. **Contamination resistance.** Prefer benchmarks with original tasks and hand-written verifiers (DeepSWE-style) over saturated, memorizable ones.

### Cadence self-evaluation

| Property | 1 | 2 | 3 | 4 | 5 | Status |
|---|---|---|---|---|---|---|
| Objective eval suite | ❌ | ⬜ | Partial | ⬜ | ⬜ | **1** |
| Multiple dimensions | ❌ | ⬜ | Partial | ⬜ | ✓ Partial (telemetry) | **2** |
| Trajectory logging | ❌ | ⬜ | Partial | ✓ History | ✓ History + compaction | **3** |
| Reproducibility | ❌ | ⬜ | Partial | ⬜ | ⬜ | **1** |
| Cost/latency telemetry | ❌ | ⬜ | Partial | ✓ Partial | ✓ tokensIn/out/tok-s | **4** |

**Current status:** Cadence tracks per-provider telemetry (tokens in/out, tokens/sec, latency) and retains full message history (compacted into summaries). It does *not* run an objective benchmark suite or structured trajectory replay.

**Gaps to close (now with a concrete target list):**
- **No objective eval suite.** Cadence has no SWE-bench-style harness to measure end-to-end task success against a test oracle. **Target:** a small, reproducible suite of real tasks with hand-written behavioral verifiers (DeepSWE-style, to resist contamination) rather than a saturated preference benchmark.
- **No trajectory replay / analysis tooling** for post-hoc debugging or self-improvement.
- **No reproducibility controls** (seeded prompts, fixed task set, deterministic-enough runs) to compare harness versions.
- **Opportunity:** with SWE-bench Verified saturating, Cadence's strong harness is best *validated* against a non-saturated, long-horizon benchmark (DeepSWE / ProgramBench) where harness quality is the differentiator.

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

**Current status:** Cadence is mature here. Permission mode holds edits in a review buffer shown in a side-by-side diff view for apply/discard; Forgiveness mode auto-backups and auto-rolls-back. The `query` tool lets the agent ask the user for decisions at any time (and resets the throttle counter so human-in-the-loop pauses don't consume budget). Throttle/halt bars give runtime control. Command execution is gated behind approval unless whitelisted (`run_command` halts with a `__AGENT_HALT_AWAITING_COMMAND_APPROVAL__` sentinel, `agent-tools.mjs:2641`).

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

**Current status:** Cadence gates parallel tool calls per-provider (`supportsParallelTools` / `supportsJSONTools`, `ai.mjs:182`, `ai-gemini.mjs:88`, `ai-llamacpp.mjs:71`), guides the model to batch independent calls and serialize dependent ones, and throttles long-running tasks via throttle/halt bars tied to `maxTurns`.

**Gaps to close:**
- **Parallelism is single-agent only.** Within a turn, "batch independent calls" is a prompt suggestion, not enforced — there's no runtime fan-out.
- **No concurrency safety for parallel sub-agents** (see §6).
- **No read-vs-write parallelism policy** — the harness doesn't distinguish read-only (safe to parallelize) from write (needs coordination) operations.

---

## Appendix A — Overall Maturity Summary (Oct 2026)

| Theme | Aug 2026 | **Oct 2026** | Notes |
|---|---|---|---|
| 1. Tool Design | 4 | **4** | Protocol gap (MCP/A2A) unchanged; now easier to close (AAIF + 150-org A2A). |
| 2. Agentic Loops | 4 | **4** | Rich recovery machinery; still no self-critique / self-gen-tests loops. |
| 3. Error Handling | 4 | **4** | **Bounded retries now implemented (3→4 on that row).** |
| 4. Safety & Guardrails | 4 | **4** | **Sandboxing now real (1→4 on that row)** — the critical gap is closed on Linux. |
| 5. Memory & Context | 4 | **4** | New `cull_history` + scratchpad-nudge; still no memory loop / semantic retrieval. |
| 6. Multi-Agent | 4 | **4** | Supervisor/worker solid; parallel-safety still unaddressed. |
| 7. Evaluation | 1 | **1** | Still no objective suite; now has a concrete (DeepSWE-style) target. |
| 8. Human-in-the-Loop | 4 | **4** | Mature; still no staged/rolling approval. |
| 9. Self-Improvement | 1 | **1** | No self-gen-tests / self-critique / feedback loop. |
| 10. Concurrency | 4 | **4** | Provider-gated parallel tools; no runtime fan-out / read-write distinction. |

**Delta vs August 2026:**
- **§4 Sandboxing: 1 → 4** — the single largest improvement. A native Linux user-namespace sandbox (keeper model, `pivot_root`, env scrub, `bwrap` fallback, shared instances) is now wired into `run_command` and the terminal. Path to **5** via macOS Seatbelt + Windows tokens/DACLs.
- **§3 Bounded retries: 3 → 4** — exponential backoff + jitter + `Retry-After` now implemented in `_fetchWithRetry`.
- **§5 Context management** — `cull_history` (model-lead pruning) and the scratchpad nudge are new, pure, testable modules; the "Model-lead pruning" row is now **4**.
- **All other scores unchanged**; the "still missing" items (MCP/A2A, self-critique, self-gen-tests, memory loop, parallel-safety, eval suite, staged approval) were re-verified as still absent.

**Highest-priority gaps (impact × effort), re-ranked for Oct 2026:**
1. **Objective evaluation harness** (§7) — now the top priority (sandboxing is closed). Build a small, reproducible, DeepSWE-style suite with hand-written verifiers; it enables everything in §9.
2. **Self-generating-tests loop** (§9) — a canonical Anthropic loop with high leverage.
3. **Reflection / self-critique loop** (§2) — closes the main loop gap.
4. **MCP / A2A integration** (§1) — closes the tool/agent protocol gap; adoption cost has dropped (vendor-neutral AAIF + 150-org A2A).
5. **Sub-agent parallel-safety** (§6) — a known multi-agent hazard now that the sandbox provides shared-instance isolation.
6. **Memory loop + semantic retrieval** (§5) — upgrade the reactive heuristics to a loop-driven memory loop with embedding-based recall.
7. **Multi-OS sandboxing** (§4) — macOS Seatbelt + Windows tokens/DACLs to take sandboxing from 4 → 5.

**What's already SOTA (Oct 2026):** Cadence's command policy engine, **native Linux user-namespace sandboxing**, forgiving-edit + auto-rollback recovery, **bounded transport retries**, two-stage compaction, model-lead context pruning (`cull_history` + scratchpad nudge), supervisor/worker sub-agents, and human-in-the-loop diff review are all at or near frontier quality. The remaining gaps are the difference between "strong today" and "reference standard."

---

## Sources

External references cited in this document (linked inline at first mention):

**Protocols & governance**
- Model Context Protocol — <https://modelcontextprotocol.io/>
- MCP joins the Agentic AI Foundation (MCP blog, Dec 9 2025) — <https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/>
- Linux Foundation: formation of the Agentic AI Foundation (Dec 9 2025) — <https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation>
- Anthropic: donating MCP to the Agentic AI Foundation — <https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation>
- A2A Protocol — <https://a2a-protocol.org/>
- Linux Foundation: A2A one-year adoption report (Apr 9 2026) — <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>

**Benchmarks**
- SWE-bench (leaderboard + ProgramBench / CodeClash announcements) — <https://www.swebench.com/>
- DeepSWE (arXiv 2607.07946) — <https://arxiv.org/abs/2607.07946>
- mini-SWE-agent — <https://github.com/SWE-agent/mini-swe-agent>

**Loop-shape research**
- ReAct (Yao et al., 2022) — <https://arxiv.org/abs/2210.03629>
- Reflexion (Shinn et al.) — <https://arxiv.org/abs/2303.11366>
- Tree of Thoughts (Yao et al., 2023) — <https://arxiv.org/abs/2305.10601>
- Anthropic, "Building Effective Agents" (Dec 2024) — <https://www.anthropic.com/research/building-effective-agents>

**Sandboxing & systems**
- Claude Code security (Seatbelt / bubblewrap) — <https://docs.anthropic.com/en/docs/claude-code/security>
- OpenAI Codex CLI — <https://github.com/openai/codex>
- OpenHands — <https://github.com/All-Hands-AI/OpenHands>

---

*Method: every code claim above was re-verified against the current codebase (file:line references in the self-evaluation sections). SOTA references were refreshed with current (Oct 2026) citations and linked to their primary sources. Scores are internally consistent with the per-row rubric tables.*
