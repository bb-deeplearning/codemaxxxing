# Iteration 9: Actor discipline — multi-agent as a real actor system

**Date**: 2026-05-20 (10 waves in one day, ~80 commits, ~18K LOC)

The multi-agent surface from Iteration 8 was correct but loose. It worked when the model inferred the right contract from context. Opus 4.7 stopped inferring. This iteration reshapes the surface into a disciplined actor system across four phases: prose contracts, ask pattern + ABORT protocol, the Erlang/Akka surface (supervision, pools, links, bounded mailboxes, behavior contracts), and observability. Ten waves orchestrated via planner / generator / evaluator triad from Anthropic's AI Engineer talk on long-running agents.

## Discovery

Two reproducible bugs from real diagnostic sessions.

### Bug 1: silent delivery failure (`ses_1c2e8d84affe`)

User asked the model to research firmware availability for a Cidoo ABM066 keyboard. The model spawned a research subagent. Subagent did the research, wrote a 5KB report, then in the same assistant turn called `close_agent(target: self)`. Message `finish` reason was `"tool-calls"` (because the last operation was a tool call). The completion-watcher's auto-extractor at `agent/control.ts:712-716` had a predicate that skipped any message with `finish: "tool-calls"`, walked back to the previous turn, found "Done." as the last assistant text, and delivered THAT to the parent as the deliverable.

User saw: a one-line "Done." cleanup as the answer to their question. The actual research was sitting in the subagent's history, unreachable.

Compounded by three smaller defects in the same shape:

- **Path-fragile self-close.** Subagent used `close_agent(target: "explore")` (the `agent_type` string) instead of `close_agent(target: "/root/researcher")` (the canonical path). The path lookup failed. Sometimes silently.
- **Tool-error-as-success rationalisation.** When `close_agent` returned `invalid_target`, the subagent treated it as "well, maybe the parent closed me already, my work here is done" and stopped. The error was real; the rationalisation was wrong.
- **Completion-notification race.** The watcher posted a completion notification in parallel with any pending sends from the child. Sometimes the notification arrived first; the parent treated the child as terminated and ignored the late send.

### Bug 2: sibling-coordination deadlock (`ses_1d84f236bffe` Demo 2)

User demoed a "lawyer simulator": one chat spawned a prosecutor subagent and a defense subagent, both supposed to file opening statements then proceed to examination. Both subagents addressed their openings to a shared parent (root). Both then called `wait_agent` expecting to see the opposing side's opening before continuing.

Neither opening reached the other side. `send_message` is unicast — when prosecutor sent to root, defense's mailbox stayed empty. Both subagents sat at `wait_agent` until the user noticed something was wrong about 90 seconds later.

The prose said nothing about unicast vs broadcast. Both subagents inferred (wrongly) that messages sent to root would be visible to siblings. The runtime didn't broadcast; the prose didn't say so; nobody got the openings.

### The compounding factor: Opus 4.7

The Opus 4.6 → 4.7 migration ([platform.claude.com/docs/en/about-claude/models/migration-guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)) lists six behavior changes. The one that matters here:

> Models now interpret prompts more literally. Implicit contracts that worked in earlier models — "your text response IS the result" — may need to be stated explicitly.

The pre-iteration prompts had "your text response IS the deliverable" as an implicit framing. The completion-watcher's auto-extractor was the safety net. 4.6 inferred the contract correctly most of the time. 4.7 treats the extractor as the primary path. Subagents stopped explicitly delivering and started relying on text-extraction. When the extractor's predicate had a hole, the deliverable vanished.

Both bugs are prose contract failures dressed up as runtime bugs.

## Research

### Cursor's harness post

Cursor's [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness) (2026) describes the same shape of problem from the other end: per-model customization required for prompts that worked across a model upgrade, "surface errors don't swallow" as a principle (every tool-recoverable error visible to the model so it can recover, not silently rationalised). Influences D11 ABORT protocol design and D18 metric event structure.

### Anthropic AI Engineer talk

Ash + Andrew, applied AI team, May 2026. Talk on long-running agents. Five takeaways:

1. **Self-evaluation is a trap.** Use an adversarial evaluator. The model judging its own output is sycophantic. Tuning a standalone critic to be harsh is tractable; tuning a builder to be self-critical is not.
2. **Compaction ≠ coherence.** Lossy summaries drift. Use fresh subagent context per task; pass state via files on disk (JSON, not Markdown — models overwrite markdown more readily).
3. **Structured handoffs + clean context.** Each subagent reads its inputs, writes its outputs, terminates. The orchestrator reads the trail.
4. **Subjective quality IS gradable** if you write down what good looks like. Their rubric: design, originality, craft, functionality — each weighted, with a few-shot calibration against reference examples.
5. **Sit with the model, read the traces.** Primary debugging loop is reading subagent traces by hand, not running more experiments.

Their orchestration shape: planner → generator → evaluator triad. Three roles, three context windows, three system prompts. Generator and evaluator negotiate a contract (their number: 27 criteria for one feature was the granularity required to make findings actionable) before any line of code is written. Evaluator grades against the negotiated contract. Pivot if hill-climbing fails.

We adopted the triad. Evolved the negotiation phase out by Wave 4 — the orchestrator drafts CONTRACT.json upfront from the wave spec, gen+eval skip negotiation, one commit-grade cycle per task. Pre-agreed contract pattern proved strictly faster with no quality regression across Waves 5-8 (zero pivots, 0 wave-orchestration ABORTs).

### Erlang/Akka actor semantics

The runtime concepts (supervision strategies, links, bounded mailboxes, behavior contracts) are direct ports of Erlang/OTP and Akka primitives:

- **Supervision strategies.** `on_failure: respawn` mirrors OTP supervisor `restart: permanent`. `pool_strategy: one_for_all` is OTP's `one_for_all`. Same naming preserves the conceptual mapping for engineers who already know OTP.
- **Linking.** `link_agents`/`unlink_agents` are Erlang `link/1`/`unlink/1`. Bidirectional symmetric edges; either peer's death cascades to linked partners.
- **Bounded mailboxes.** Akka has `mailbox-push-timeout-time` and `BoundedMailbox`. We have `MAILBOX_DEFAULT_CAPACITY = 32` and `MailboxFullError`. Same shape.
- **Behavior contracts.** Erlang's `behaviour` declaration plus `gen_server` callbacks. Each `agent_type` declares a contract; runtime validates at terminal-status time.

We deliberately did NOT import Akka's preStart/postStop lifecycle hooks (LLM subagents don't need them — spawn/close are sufficient), supervisor strategy escalation chains beyond depth 1 (LLM cost makes deep retry loops expensive), or persistence (state lives in messages, not in subagent memory across crashes).

## Solution

Ten waves grouped into four phases. Each wave shipped one phase increment; each non-bootstrap wave orchestrated via the talk's planner/gen+eval triad. Full engineering reference at [`specs/actor-discipline.md`](../specs/actor-discipline.md); this iteration log is the narrative.

### Phase 0 — bootstrap floor (Wave 0)

Five small but load-bearing changes. Executor-solo by design — landing the safety net BEFORE Wave 1 starts orchestrating subagents is what catches harness failures during the campaign itself.

- **D5 — extractor narrowing + safety net.** The predicate at `agent/control.ts:712-716` rewritten to match any assistant message regardless of `finish` reason, then walk back over text-less turns. New `looksLikeMissingDeliverable` heuristic gates a ⚠️ warning prepended to the parent's notification body when the child silently exited (empty text OR <200 chars + single-line + cleanup-words regex). New helper fns at module scope: `extractText`, `looksLikeMissingDeliverable`, `buildNotificationBody`. `PerRootData` extended with `spawnerOf`, `outgoingToSpawner`, `knownPaths`. The safety-net branch fires when the child never delivered AND the body is empty/status-like.
- **D2 — canonical-path injection.** `SystemPrompt.capabilityHints(agent, sessionID?)` extended to template a per-spawn `## Your canonical path` block when the agent is a subagent and the path resolves non-root. Stops the model from guessing its own canonical path.
- **D3 — `close_agent` target optional.** Self-close form. `Parameters.target` wrapped in `Schema.optional`; execute defaults to caller path.
- **D9 — error tag split.** `close_agent` returns `error: "already_terminated"` for paths once known under this root (success case — the child exited before close arrived), `error: "path_invalid"` for paths never registered. New `AgentControl.wasKnownPath(senderID, path)` method.
- **D6 — root-hold for in-flight mail (deferred).** Per Wave 0 WAVE.md explicit allowance. Investigation showed it wants its own focused wave with explicit test coverage of the "model says stop → root settles" contract. The safety net (D5) catches the failure mode from the user's side. Permanently deferred at campaign close: D5b two-pass walk obsoletes the original concern.

### Phase 1 — delivery contract prose (Waves 1-2)

The prose surfaces had to state the delivery contract literally for Opus 4.7. Wave 1 rewrote the five subagent prompts; Wave 2 reproduced both diagnostic sessions end-to-end as regression invariants.

Wave 1 deliverables:

- **D1.** `multi-agent-subagent.txt` "Final answer" section (pre-campaign lines 35-37) became "Delivery contract" with the literal tool-call sequence: every subagent MUST deliver its result via `send_message`/`followup_task`. Text-extraction is a fallback.
- **D7.** `multi-agent-root.txt` Sibling coordination section. Unicast doctrine + three working patterns (CC, coordinator, followup_task chain) + anti-pattern (do NOT `wait_agent` for a message routed elsewhere).
- **D8.** `multi-agent-root.txt` Limits section. What the surface deliberately does NOT give you: no broadcast, no sibling introspection, no deadlock detection, idle ≠ alive, bounded mailboxes (D15 wired this).
- **D4.** Defer-edits in `general/anthropic.txt`, `general/gemini.txt`, `explore.txt`. Replaced implicit "text is deliverable" framing with explicit pointers to the capability-hint delivery contract. Preserves caveman output rules.
- **Prose-grep harness.** NEW file `packages/opencode/test/prose/subagent-prompts.test.ts`. Asserts forbidden phrases absent and required phrases present across the five prompts.

Wave 2 hit `ABORT(spec_wrong)` on T1. The D5 extractor's predicate was insufficient against the Cidoo terse-follow-up shape — substantive body in one turn (`finish: "tool-calls"`), terse "Done." status line in another (`finish: "stop"`). The orchestrator landed D5b inline (two-pass walk: pass 1 prefers non-terse bodies, pass 2 falls back). Captured as GOTCHA `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line`.

INV-D-01..08 + 2 regressions green by close of Wave 2. Both diagnostic sessions reproduce end-to-end and fail without the campaign's fixes.

### Phase 2 — ask pattern + ABORT protocol (Waves 3-4)

Two additive features.

**D10 — ask pattern.** `send_message` and `followup_task` accept an optional `correlation_id`. NEW `wait_for_reply(correlation_id, timeout_ms)` variant on agent-wait — second `Tool.define` in the same file. Targeted wait that ignores unrelated mailbox traffic. The broad `wait_agent` still works for "any mailbox update."

**D11 — structured ABORT.** Subagents can emit `ABORT(<reason>): <details>` as their last assistant line. Completion-watcher parses line-anchored to the LAST non-empty line (interior or quoted mentions do NOT trigger), populates a structured `abort_reason: { reason, details }` field on the parent's notification, continues with the human-readable text. Six reasons: `spec_wrong`, `transient_tool_error`, `out_of_scope`, `context_full`, `approach_failed`, `user_question`. Mirrors the wave system's set-phrase ladder. GOTCHA `agentcontrol-d11-abort-line-parser-last-line-only` documents the last-line constraint.

**Mandatory-timeout doctrine.** `wait_agent` and `wait_for_reply` emit `missing_timeout` warning when `timeout_ms` is omitted, `timeout_clamped` warning when value exceeds the 600000ms cap. Call still completes. Surfaces silent stalls as structured warnings.

Wave 4 attempt 1 crashed mid-orchestration (likely an unrelated `opencode` exit; no recorded ABORT). Attempt 2 rolled forward without reverts — T1+T2 had clean commits and green CONTRACT.json grading. NOT a spec issue; harness recoverability worked. Pre-agreed-contract pattern (orchestrator drafts CONTRACT.json upfront, gen+eval skip negotiation) institutionalised from Wave 4 attempt 2 onward.

### Phase 3 — Erlang/Akka surface (Waves 5-8)

The full actor-system surface in four sequential waves.

**Wave 5 (D12) — supervision strategies.** `spawn_agent` accepts `on_failure: respawn / escalate / ignore / kill_pool` and `pool_strategy: one_for_one / one_for_all / rest_for_one`. Completion-watcher dispatches per strategy. Respawn capped at 3 attempts before escalating with `transient_tool_error`. 4 new per-root maps in `PerRootData`. 6 D12 it.live tests. Wave 5 T1's evaluator self-closed mid-grade (C1-C7 only); orchestrator inline-adjudicated C8-C12 + 2 recipe-shape adjustments per Wave 4 T2 precedent. Introduced "STAY ALIVE" explicit reminder in every evaluator spawn message from Wave 5 T2 onward — zero mid-grade self-closes in Waves 6-8.

**Wave 6 (D13) — `spawn_pool`.** NEW tool dir `packages/opencode/src/tool/agent-pool/`. Declarative `count` + `collect` contract replaces the "spawn N agents in one message, manage them by hand" pattern. Three collect strategies: `all` (wait for every member), `first` (race; runtime closes losers), `any_n` (quorum). Pool spawning is non-atomic — failures land in a `failures[]` array. `MULTI_AGENT_TOOLS` extended 7→8.

**Wave 7 (D14 + D15) — lifecycle.** D14: `link_agents`/`unlink_agents` bidirectional symmetric edges; cascade on non-graceful termination with `linked_death` label. D15: `MAILBOX_DEFAULT_CAPACITY = 32` plus `MailboxFullError`. `send_message`/`followup_task` return `{ error: "mailbox_full", retry_after_ms: 250 }` on overflow. Completion notifications bypass via `sendSystem`. `MULTI_AGENT_TOOLS` extended 8→10. First cross-task parallelization in the campaign: T2+T3 ran in parallel (disjoint write sets).

**Wave 8 (D16) — behavior contracts.** NEW file `packages/opencode/src/agent/behaviors.ts`. Declares a `BehaviorContract` per `agent_type` (`general` requires `send_message_to_spawner` before terminating; `explore` requires read-only completion). Completion-watcher computes `BehaviorViolation`s at terminal-status time, attaches to parent's notification. Observer-only — spawn returns successfully; orchestrator decides whether to pivot. 3-way cross-task parallelization (T2+T3+T4).

### Phase 4 — observability + audit (Wave 9)

**D18 — `agent.metric.*` bus events.** NEW file `packages/opencode/src/wave/metric.ts`. Four `BusEvent.define` entries (`DeliverableArrived`, `SafetyNetFired`, `SiblingDeadlock`, `SubagentToolError`) + four pure rate helpers + `DeliverableSource` literal union. Emission wired into completion-watcher, agent-wait (all 4 timeout paths), agent-send (5 error branches), agent-followup (5 error branches). Per GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`, no EventV2 counterpart — these are in-process signals only, not persisted.

The four rates the campaign tracks:

- **deliverable_arrival_rate** — fraction of subagent completions whose deliverable reached the spawner via explicit `send_message` or auto-extraction (NOT via the safety net). Post-D1/D5 target is ~1.0; close to 0 means subagents are silently failing.
- **safety_net_firing_rate** — count of safety-net warnings per completion. Inverse twin. Elevated rate (>0.1 over rolling window of 20+) is the canary that prompts aren't teaching the delivery contract correctly.
- **sibling_deadlock_rate** — count of `wait_agent`/`wait_for_reply` calls that exited via timeout. The `ses_1d84f236bffe` Demo 2 shape, now observable live.
- **subagent_tool_error_rate** — count of multi-agent tool calls that returned a tool-recoverable error. "Context rot" canary per Cursor's harness post.

**CAMPAIGN_AUDIT.md.** Synthesized cross-wave audit per the talk's "sit with the model, read the traces" doctrine. Per-wave summary table (10 rows × {outcome, SHA, phase, ships, criteria, pivots, orchestration}), phase outcome paragraphs, drift catalog with file:line citations, 7 follow-up iteration items, diagnostic sessions linked to regression tests, "What to do if you're reading this" — 5-item guidance for future agents resuming the surface.

## Observe

Watch for these behaviors when running codemaxxxing on real work.

### Delivery contract

- **Subagents call `send_message` to their spawner before `close_agent`.** Read any subagent's session log; the second-to-last assistant turn should be a `send_message`/`followup_task` to the spawner, the last should be `close_agent`. If you see `close_agent` without a preceding send, the prompt fragment isn't taking.
- **Parent's mailbox shows clean deliverables, not ⚠️ warnings.** When a subagent finishes, the parent's next-turn user message should show `[from <child_path>] <clean body>` for the explicit send AND `[from <child_path>] Agent <path> reached status: shutdown` for the completion notification. If you see a `⚠️ Auto-extraction returned a short/likely-status message ...` warning, the subagent silently failed to deliver — the prompt contract isn't being followed.
- **Cidoo-shape regression test.** Subagent emits a substantive body in one turn (`finish: "tool-calls"`) and a terse status line ("Done.") in another (`finish: "stop"`). The substantive body should reach the parent, not the status line. D5b two-pass walk does this.

### Sibling coordination

- **Two siblings sending to a shared parent both arrive.** Spawn two siblings from root; both `send_message(target: "/root", message: ...)`. Root's mailbox shows BOTH messages on its next turn — they don't collide, they don't broadcast. Each is unicast to root.
- **`wait_for_reply` with `correlation_id` is targeted.** Send a message with `correlation_id: "req-1"`. The recipient's reply must carry the same `correlation_id`. The caller's `wait_for_reply(correlation_id: "req-1", timeout_ms: 5000)` should wake only on the matching reply, not on unrelated mailbox traffic.
- **Demo 2 doesn't deadlock anymore.** Spawn prosecutor + defense siblings. Tell each to file an opening to root. Each should send to root (not to the sibling), and neither should `wait_agent` expecting to see the other's opening on its own mailbox.

### Supervision + pools + links

- **`on_failure: respawn` regenerates a crashed child.** Spawn a child with `on_failure: "respawn"`. Crash the child. Within 200ms `list_agents` should show a NEW child at the same task_name with a regenerated session id. Capped at 3 attempts then escalates with `transient_tool_error`.
- **`spawn_pool(collect: "first")` cancels losers.** Spawn pool with `count: 3, collect: "first"`. First child completes. The other two should close within 100ms. Useful for "race three search strategies."
- **`link_agents(a, b)` cascades on crash.** Link two agents. Crash one. The other should close within 100ms with `linked_death` status. Symmetric — either direction works.

### Bounded mailbox

- **`mailbox_full` returned on overflow.** Set per-agent mailbox cap to 4 (test override). Send to the same child 5 times. The 5th call should return `{ error: "mailbox_full", retry_after_ms: 250 }`. After the child drains, sends succeed again.
- **Completion notification arrives even on full mailbox.** Same setup, mailbox full. Child terminates. Parent's mailbox should receive the completion notification despite the user-backpressure. The system-bypass path is what makes this work.

### Behavior contracts (observer-only)

- **Violations surface via `behavior_violation` on the notification.** Spawn a `general` subagent that never calls `send_message`. The parent's completion notification should carry `behavior_violation: { reason: "missing_send_message_to_spawner", ... }`. The spawn still succeeds; validation runs at terminal-status time.

### Observability

- **`agent.metric.*` events fire on every completion.** Subscribe to the bus via `Bus.Service.subscribeCallback`. Every subagent completion fires `DeliverableArrived` (with `source`); silent completions ALSO fire `SafetyNetFired`. Every `wait_agent` timeout fires `SiblingDeadlock`. Every multi-agent tool error fires `SubagentToolError`.
- **Rate helpers compute reasonable values on empty input.** `deliverableArrivalRate([])` returns 0. `safetyNetFiringRate([{source: "safety_net"}])` returns 1.0. Compose with `Array.prototype.filter` to scope by time window.

## Architectural choices worth recording

### Prose contracts are first-class

The two motivating bugs were prose contract failures dressed up as runtime bugs. The pre-iteration runtime was correct — it just relied on implicit contracts the post-Opus-4.7 model wouldn't infer. The fix wasn't more runtime checks; it was prose that states the contract literally, plus integration invariants that prove the prose is being read.

The five subagent prompt files (`multi-agent-root.txt`, `multi-agent-subagent.txt`, `general/anthropic.txt`, `general/gemini.txt`, `explore.txt`) are the contract surface. The prose-grep harness at `test/prose/subagent-prompts.test.ts` asserts the contract phrases survive future edits. The integration invariants at `test/integration/multi-agent-invariants.test.ts` assert the model behaves as if the prose was read.

PROMPT_SURFACES.md (in the campaign archive) is the ownership map: which file owns which guidance, who edits what when. Every prose wave consults it before editing.

### Adversarial evaluator, never self-evaluation

The talk's strongest principle. Every orchestrated wave in this campaign spawned a separate evaluator subagent. The generator never graded its own work. The executor (`caveman`) never graded the generator's work directly — its role is supervisor; it watches for set-phrases and reads CONTRACT.json but does NOT score criteria.

Two evaluator self-close incidents (Wave 5 T1; Wave 6 T1/T3 inline-adj) showed up over 35 gen+eval pairs. Both handled by orchestrator inline-adjudication per the Wave 4 T2 precedent. The discipline held end-to-end. ANTHROPIC_HARNESS_LEARNINGS.md captures the "Self-evaluation is a trap" entry as non-negotiable.

### Pre-agreed contracts beat negotiation phases

The talk emphasizes the negotiation phase (gen+eval iterate via send_message until both emit CONTRACT AGREED). We tried this in Wave 1 — T5 stalled in negotiation, burned 1 pivot. From Wave 4 attempt 2 onward, orchestrator drafts CONTRACT.json upfront from the wave spec; gen+eval skip negotiation; one commit-grade cycle per task.

Strictly faster (no negotiation roundtrips), no quality regression observed across 28 subagent sessions in Waves 5-8 (0 pivots, 0 wave-orchestration ABORTs). The negotiation phase the talk emphasized was replaced by orchestrator pre-work. The asymmetric-evaluator pattern was preserved.

The drift catalog in CAMPAIGN_AUDIT.md documents this departure explicitly with file:line citations. Future orchestrated waves should follow the pre-agreed pattern unless the criteria require subjective grading (in which case full negotiation is the right tool).

### `wait_for_reply` over broad `wait_agent`

The unicast doctrine + the targeted-wait variant are the runtime answer to the Demo 2 deadlock. Subagents that need a specific reply from a specific peer use `correlation_id` + `wait_for_reply`; deadlocks surface as structured `timed_out: true` instead of silent stalls.

Broad `wait_agent` (no `correlation_id`) still works for "any mailbox update" — useful when watching multiple peers without caring which one replies first. Both tools share the mandatory-timeout doctrine: `missing_timeout` warning when omitted, `timeout_clamped` when above 600000ms cap.

### Erlang/Akka semantics where they fit; LLM-shaped where they don't

`on_failure: respawn` mirrors OTP `restart: permanent` but caps respawn attempts at 3 because LLM cost makes deep retry loops expensive. `pool_strategy: one_for_all` mirrors OTP one_for_all exactly. `link_agents`/`unlink_agents` mirror Erlang `link/1`/`unlink/1`.

We deliberately did NOT import Akka's preStart/postStop lifecycle hooks (LLM subagents don't need them), supervisor strategy escalation chains beyond depth 1 (cost), or persistence (state lives in messages, not in subagent memory across crashes).

The default behavior for every new param is the conservative one (`on_failure: "escalate"`, `pool_strategy: "one_for_one"`). Existing call sites get the same semantics as pre-campaign. Saved permissions, plugin hooks, and the v1 tool surface stay byte-compatible.

### D18 metrics as bus-only, not persisted

The four `agent.metric.*` events are in-process observability signals. They surface drift live (Wave 10 dashboard subscribes to the prefix; future Iteration 11 prompt revisions tune from observed rates). They are NOT persisted to the sourced log — per GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`, dual-emission to EventV2 would create a parallel-prefix mess plus couple the metric surface to projector/replay machinery for no gain (consumers don't replay them).

Emission is fire-and-forget at every call site (`.pipe(Effect.ignore)`). PubSub failures during instance disposal MUST NOT crash callers — the completion-watcher fork can race the disposal finalizer; absorbing the failure keeps the lifecycle clean.

Triggers for Iteration 11 prompt revision (per CAMPAIGN_AUDIT.md follow-up):

- `safety_net_firing_rate > 0.1` over a rolling window of 20+ completions → prose contract gap in `multi-agent-subagent.txt` Delivery contract section
- `sibling_deadlock_rate > 0.3` on `wait_for_reply` calls → prose contract gap in `multi-agent-root.txt` Sibling coordination section
- `subagent_tool_error_rate > 0.05` on `send_message` → prose contract gap or mailbox-cap tuning

### Integration invariants discipline carries forward

The codex-parity-hardening campaign established the rule: every wave touching multi-agent code MUST add at least one `it.instance` against the relevant scenario before its production code lands. This campaign extends the catalog with INV-D-01..28 — every D# deliverable has at least one invariant assertion.

Coverage is necessary; the harness is sufficient. The harness is what proves the prose contract is being read by the model, the runtime cascades fire on the right shapes, and the rate helpers compute reasonable values. New invariants append to the catalog's "Discovered during execution" section; the wave that discovered them owns the test.

### Wave system FSM tolerates both orchestration shapes

Waves 0 + 9 ran executor-solo (single-agent, no planner, no gen+eval pairs). Waves 1-8 ran orchestrated (planner + per-task gen+eval pairs, with cross-task parallelization in Waves 7+8). The FSM and state surface tolerate both ends of the spectrum without modification. The wave loop just spawns the executor; the executor decides whether to orchestrate based on WAVE.md header.

Cross-wave parallelism is not supported. Sequential waves preserve the always-commit audit trail and recover cleanly from mid-wave crashes (Wave 4 attempt 1 → attempt 2 rolled forward without reverts).
