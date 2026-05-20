# Changes: Actor discipline — multi-agent as a real actor system

**Date**: 2026-05-20
**Iteration**: [PROMPT_ITERATIONS/2026-05-20-actor-discipline.md](../PROMPT_ITERATIONS/2026-05-20-actor-discipline.md)
**Spec**: [specs/actor-discipline.md](../specs/actor-discipline.md)
**Campaign archive**: `.wave/campaigns/actor-discipline-2026-05-20/`

The biggest divergence from the last iteration. Reshapes the multi-agent surface from a 6-tool API into a 10-tool disciplined actor system across four phases. 10 waves orchestrated via planner/generator/evaluator triad from Anthropic's AI Engineer talk on long-running agents. ~80 commits, ~18,000 lines added across 94 files.

## TL;DR for users

- **Two diagnostic bugs fixed end-to-end.** `ses_1c2e8d84affe` (Cidoo ABM066 silent delivery failure) and `ses_1d84f236bffe` Demo 2 (prosecutor/defense sibling deadlock) are unreachable through post-campaign code paths. Both have regression tests in the integration invariant catalog.
- **The model-visible multi-agent tool surface grew from 6 to 10 tools.** Added: `wait_for_reply` (D10; targeted variant of `wait_agent` that wakes only on matching `correlation_id`), `spawn_pool` (D13; declarative fan-out with `collect: "all" / "first" / "any_n"`), `link_agents` and `unlink_agents` (D14; Erlang-style paired-death edges).
- **Saved permissions keep working without edits.** All new tools are in the existing `MULTI_AGENT_TOOLS` group; saved rules under `permission.task` transparently gate them. No config migration required.
- **Subagent prompts now state the delivery contract literally.** Every subagent MUST deliver its result via `send_message`/`followup_task` to its spawner. Text-extraction is a fallback. Prose-grep harness at `test/prose/subagent-prompts.test.ts` (54 assertions at campaign close) keeps this from regressing on future edits.
- **`send_message` and `followup_task` accept an optional `correlation_id`** for request/reply pairing. The recipient's matching reply wakes the caller's `wait_for_reply(correlation_id, timeout_ms)` instead of any-mailbox-update.
- **Subagents can emit `ABORT(<reason>): <details>` as their last assistant line.** The completion-watcher parses line-anchored to the LAST non-empty line, populates a structured `abort_reason` field on the parent's notification. Six reasons: `spec_wrong`, `transient_tool_error`, `out_of_scope`, `context_full`, `approach_failed`, `user_question`.
- **`spawn_agent` accepts `on_failure: respawn / escalate / ignore / kill_pool` and `pool_strategy: one_for_one / one_for_all / rest_for_one`.** Defaults match pre-campaign behavior (escalate + one_for_one). Respawn capped at 3 attempts then escalates with `transient_tool_error`.
- **Mailboxes are now bounded (default capacity 32).** `send_message`/`followup_task` return `{ error: "mailbox_full", retry_after_ms: 250 }` on overflow. Completion notifications bypass the cap — your subagent crashing always notifies you.
- **Per-`agent_type` behavior contracts (observer-only).** Default contracts shipped for `general` (requires `send_message_to_spawner`) and `explore` (requires read-only completion). Violations surface as `behavior_violation` on the parent's notification at terminal-status time. Spawn still succeeds; orchestrator decides whether to pivot.
- **Four `agent.metric.*` bus events ship.** `DeliverableArrived`, `SafetyNetFired`, `SiblingDeadlock`, `SubagentToolError`. In-process observability signals (NOT persisted to the sourced log). Wave 10 dashboard subscriber + rolling-window aggregator is the suggested next iteration deliverable.
- **`wait_agent` and `wait_for_reply` emit `missing_timeout` warning** when `timeout_ms` is omitted, `timeout_clamped` warning when value exceeds 600000ms cap. Surfaces silent stalls as structured warnings.
- **`close_agent(target)` is now optional.** Self-close form when omitted. Plus `error: "already_terminated"` (success case — the child exited before close arrived) split out from `error: "path_invalid"` (model bug — wrong path).

## The two diagnostic bugs

### Bug 1: Cidoo silent delivery failure (`ses_1c2e8d84affeZ7t5g5LKveGDTo`)

User asked for firmware availability research on a Cidoo ABM066 keyboard. Model spawned a research subagent. Subagent wrote a ~5KB report, then in the same assistant turn called `close_agent(target: self)`. Message `finish` reason was `"tool-calls"`. Completion-watcher's auto-extractor predicate at `agent/control.ts:712-716` skipped any message with `finish: "tool-calls"`, walked back to the previous turn, found "Done." as the last text, delivered that as the deliverable. The user saw "Done." as their answer; the actual research was sitting unreachable in the subagent's history.

**Fixed by:** D5 narrowing + safety net (Wave 0) + D5b two-pass walk (Wave 2 inline after `ABORT(spec_wrong)`) + D2 canonical-path injection. Regression tests: INV-D-01 (`extractor-returns-text-from-finish-tool-calls`), INV-D-03 (`safety-net-warning-when-deliverable-missing`), plus the GOTCHA's own end-to-end test reproducing the Cidoo shape.

### Bug 2: prosecutor/defense sibling deadlock (`ses_1d84f236bffe` Demo 2)

User demoed a lawyer simulator: chat spawned prosecutor + defense subagents, both supposed to file opening statements then proceed to examination. Both addressed openings to the shared parent (root), both called `wait_agent` expecting to see the opposing side's opening. `send_message` is unicast — when prosecutor sent to root, defense's mailbox stayed empty. Both deadlocked at `wait_agent` until the user noticed.

**Fixed via prose contract:** D7 Sibling coordination + D8 Limits in `multi-agent-root.txt`. Both sections now explicitly state the unicast doctrine, the three working coordination patterns (CC / coordinator / followup_task chain), and the anti-pattern (do NOT `wait_agent` for a message routed elsewhere). D10 correlation_id + wait_for_reply added the targeted-wait runtime primitive. D18 SiblingDeadlock metric now surfaces this shape live in production traces. Regression tests: INV-D-06 (`send-message-is-unicast-not-broadcast`), INV-D-08 (`coordinator-fan-out-delivers-single-consolidated-message`), INV-D-10 (`wait-for-reply-times-out-without-matching-correlation`), INV-D-28 (`sibling-deadlock-metric-fires-on-wait-timeout`).

Compounded by the Opus 4.6 → 4.7 migration. The new model interprets prompts literally and will not infer implicit contracts. "Your text response IS the deliverable" stopped working as an implicit framing. The pre-campaign runtime was correct — it just relied on contracts the post-4.7 model wouldn't infer. The fix wasn't more runtime checks; it was prose that states the contract literally plus integration invariants that prove the prose is being read.

## What changed by phase

Full per-wave decomposition lives in [`specs/actor-discipline.md`](../specs/actor-discipline.md). High level:

### Phase 0 — bootstrap floor (Wave 0)

Five small but load-bearing changes, executor-solo:

- **D5** — extractor narrowing + safety net in `agent/control.ts`. Predicate at `712-716` rewritten to match any assistant message regardless of `finish` reason, then walk back over text-less turns. New `extractText`, `looksLikeMissingDeliverable`, `buildNotificationBody` helpers. `⚠️` warning prepended to parent's notification when the child silently exited.
- **D2** — canonical-path injection in `session/system.ts:capabilityHints`. Optional `sessionID` parameter; per-spawn `## Your canonical path` block templated into the subagent hint when path is non-root.
- **D3** — `close_agent` target optional. Self-close form.
- **D9** — error tag split. `already_terminated` (success — child exited before close arrived) vs `path_invalid` (model bug — wrong path). New `AgentControl.wasKnownPath` method.
- **D6** — root-hold for in-flight mail. Deferred per WAVE.md §6, permanently deferred at campaign close per CAMPAIGN_AUDIT.md follow-up (D5b two-pass walk obsoletes the concern).

### Phase 1 — delivery contract prose (Waves 1-2)

- **D1** — `multi-agent-subagent.txt` "Final answer" section rewritten as "Delivery contract" with literal tool-call sequence.
- **D7** — `multi-agent-root.txt` Sibling coordination section. Unicast doctrine + three patterns + anti-pattern.
- **D8** — `multi-agent-root.txt` Limits section. What the surface deliberately does NOT give you.
- **D4** — defer-edits in `general/anthropic.txt`, `general/gemini.txt`, `explore.txt`. Replaced implicit "text is deliverable" framing with explicit pointers to the capability-hint delivery contract.
- **Prose-grep harness.** NEW `test/prose/subagent-prompts.test.ts`.
- **D5b** — two-pass extractor walk landed inline in Wave 2 after T1 `ABORT(spec_wrong)`. Pass 1 prefers non-terse bodies; Pass 2 falls back to any non-empty text. GOTCHA `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line` documents it.

INV-D-01..08 + 2 regressions green by close of Wave 2.

### Phase 2 — ask pattern + ABORT protocol (Waves 3-4)

- **D10** — `send_message` + `followup_task` accept optional `correlation_id`. NEW `wait_for_reply(correlation_id, timeout_ms)` second `Tool.define` in agent-wait.
- **D11** — structured ABORT protocol. Subagents emit `ABORT(<reason>): <details>` as last assistant line; completion-watcher parses line-anchored, populates `abort_reason: { reason, details }` on parent's notification. Six reasons in the enum. GOTCHA `agentcontrol-d11-abort-line-parser-last-line-only` documents the last-line constraint.
- **Mandatory-timeout doctrine** — `wait_agent`/`wait_for_reply` emit `missing_timeout` and `timeout_clamped` warnings.

INV-D-09..14 green.

### Phase 3 — Erlang/Akka surface (Waves 5-8)

- **D12** (Wave 5) — supervision strategies on `spawn_agent`. `on_failure: respawn / escalate / ignore / kill_pool` + `pool_strategy: one_for_one / one_for_all / rest_for_one`. Respawn capped at 3 attempts.
- **D13** (Wave 6) — `spawn_pool` (NEW tool dir `agent-pool/`). Declarative fan-out. `collect: all / first / any_n`. Non-atomic pool spawning — failures land in `failures[]` array. `MULTI_AGENT_TOOLS` 7→8.
- **D14** (Wave 7) — `link_agents`/`unlink_agents` (NEW tool dir `agent-link/`). Bidirectional symmetric edges; cascade on non-graceful termination with `linked_death` label. `MULTI_AGENT_TOOLS` 8→10.
- **D15** (Wave 7) — bounded mailboxes. `MAILBOX_DEFAULT_CAPACITY = 32` + `MailboxFullError` + `sendSystem` bypass. `send_message`/`followup_task` return `{ error: "mailbox_full", retry_after_ms: 250 }` on overflow.
- **D16** (Wave 8) — per-`agent_type` behavior contracts. NEW `agent/behaviors.ts`. `BehaviorContract` + `BehaviorViolation` Schema.Class. Observer-only validation at terminal-status time. Default contracts for `general` + `explore`.

INV-D-15..26 green.

### Phase 4 — observability + audit (Wave 9)

- **D18** — NEW `wave/metric.ts`. Four `BusEvent.define` entries under `agent.metric.*` prefix + four pure rate helpers + `DeliverableSource` literal union. Emission wired into completion-watcher, agent-wait (all 4 timeout paths), agent-send (5 error branches), agent-followup (5 error branches). Per GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`, no EventV2 counterpart — these are in-process signals only, not persisted.
- **`CAMPAIGN_AUDIT.md`** — 151-line cross-wave audit synthesized per ANTHROPIC_HARNESS_LEARNINGS.md "sit with the model, read the traces" doctrine.

INV-D-27/28 green.

## File inventory diff

### NEW

- `packages/opencode/src/agent/behaviors.ts` (249 lines) — D16 behavior contract schema, defaults, validator
- `packages/opencode/src/wave/metric.ts` (216 lines) — D18 bus events + rate helpers
- `packages/opencode/src/tool/agent-pool/{agent-pool.ts,.txt,.test.ts}` (1085 lines total) — D13 `spawn_pool`
- `packages/opencode/src/tool/agent-link/{agent-link.ts,.txt,.test.ts}` (828 lines total) — D14 `link_agents` / `unlink_agents`
- `packages/opencode/src/tool/agent-wait/wait-for-reply.txt` (28 lines) — D10 description for the second `Tool.define`
- `packages/opencode/test/prose/subagent-prompts.test.ts` (331 lines) — Wave 1 prose-grep harness (54 assertions at campaign close)

### Modified

- `packages/opencode/src/agent/control.ts` (+1020 lines) — extractor narrowing + safety net (D5/D5b), supervision dispatch (D12), pool primitives (D13), link cascade (D14), behavior validation (D16), metric emission helpers (D18). Per-root maps grew from baseline 5 to 14.
- `packages/opencode/src/agent/control.test.ts` (+2728 lines) — D5/D11/D12/D13/D14/D15/D16/D18 describe blocks, 140 total tests at campaign close
- `packages/opencode/src/agent/mailbox.ts` (+80 lines) — D15 `MAILBOX_DEFAULT_CAPACITY` + `MailboxFullError` + `sendSystem`
- `packages/opencode/src/agent/mailbox.test.ts` (+160 lines) — D15 + correlation_id matcher tests
- `packages/opencode/src/agent/inter-agent-communication.ts` (+34 lines) — `correlation_id` (D10), `abort_reason` (D11), `behavior_violation` (D16) optional fields
- `packages/opencode/src/agent/agent.ts` — D16 attaches behaviors to general+explore + exports `behaviorContractFor` helper
- `packages/opencode/src/agent/prompt/multi-agent-root.txt` (+42 lines) — D7 Sibling coordination, D8 Limits, D13 Routers and pools subsection, mandatory-timeout doctrine
- `packages/opencode/src/agent/prompt/multi-agent-subagent.txt` (+60 lines) — D1 Delivery contract, D11 ABORT section, D15 mailbox backpressure paragraph, D16 Your behavior contract section
- `packages/opencode/src/agent/prompt/general/anthropic.txt` + `general/gemini.txt` + `explore.txt` — D4 defer-edits (lines 1 + Response format pointers)
- `packages/opencode/src/session/system.ts` — D2 canonical-path injection in `capabilityHints`
- `packages/opencode/src/session/prompt.ts` — pass `sessionID` to capabilityHints at the call site
- `packages/opencode/src/permission/index.ts` — `MULTI_AGENT_TOOLS` extended 7→10 (added `spawn_pool`, `link_agents`, `unlink_agents`)
- `packages/opencode/src/tool/registry.ts` — D13 + D14 tool wiring (import + `Tool.init` + builtin array + legacy bridge)
- `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` (+31 lines) — D12 `on_failure` + `pool_strategy` Schema.optional params + execute passthrough
- `packages/opencode/src/tool/agent-spawn/agent-spawn.txt` (+34 lines) — `## Supervision strategies (D12)` section
- `packages/opencode/src/tool/agent-send/agent-send.ts` (+43 lines) — D10 `correlation_id`, D15 mailbox_full structured output, D18 SubagentToolError emission on 5 error branches
- `packages/opencode/src/tool/agent-followup/agent-followup.ts` (+63 lines) — same shape as agent-send
- `packages/opencode/src/tool/agent-wait/agent-wait.ts` (+169 lines) — D10 second `Tool.define` for `wait_for_reply`, D11 mandatory-timeout warnings, D18 SiblingDeadlock emission on 4 timeout paths
- `packages/opencode/src/tool/agent-close/agent-close.ts` (+67 lines) — D3 optional `target` + D9 error tag split
- `packages/opencode/test/integration/multi-agent-invariants.test.ts` (+2268 lines) — INV-D-01..28; total 45 invariants at campaign close (was 17)
- `GOTCHAS.md` — 2 new entries: `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line`, `agentcontrol-d11-abort-line-parser-last-line-only`

### Campaign archive (read-only after settle)

`.wave/campaigns/actor-discipline-2026-05-20/` (everything):

- `STATE.md` — wave state machine, 9 sessions, all_complete
- `CAMPAIGN_AUDIT.md` — 151-line cross-wave audit synthesized at Wave 9 close
- `plan/OVERVIEW.md` — campaign overview (why, what, hard constraints, sequencing, glossary)
- `plan/ORCHESTRATOR_PROTOCOL.md` — operational runbook for orchestrated waves
- `plan/ANTHROPIC_HARNESS_LEARNINGS.md` — talk's principles distilled
- `plan/INTEGRATION_INVARIANTS.md` — INV-D-01..28 catalog
- `plan/PROMPT_SURFACES.md` — ownership map for the five subagent prompt files
- `plan/RUBRIC_GUIDE.md` — how planner subagent drafts per-wave RUBRIC.json
- `plan/REFERENCES.md` — external + internal source paths
- `plan/waves/wave_<N>/{WAVE.md,PLAN.json,CONTRACT.json,RUBRIC.json}` per wave
- `waves/wave_<N>/NOTES.md` per wave (every attempt's narrative)

## Test discipline

INV-D-01..28 (28 new invariants) plus the existing INV-D pre-existing scoping/lifecycle invariants (17) = 45 integration tests in `test/integration/multi-agent-invariants.test.ts` at campaign close. Every D# deliverable has at least one invariant assertion. The integration-first discipline from the codex-parity-hardening campaign is preserved and extended.

Per-file 100% line coverage on every new file:

- `wave/metric.ts` — 100.00% functions / 100.00% lines
- `tool/agent-pool/agent-pool.ts` — 100/100
- `tool/agent-link/agent-link.ts` — 100/100
- `tool/agent-send/agent-send.ts` — 100/100
- `tool/agent-followup/agent-followup.ts` — 100/100
- `tool/agent-wait/agent-wait.ts` — 100/100
- `agent/control.ts` — 100.00% lines (93.38% functions = pre-existing `schema-class-function-coverage` GOTCHA gap, not introduced by this campaign)
- `agent/mailbox.ts` — 100/100 lines, 95.65% functions (preserved Wave 7 baseline)
- `agent/behaviors.ts` — 100/100 (modulo Schema.TaggedErrorClass gap)
- `agent/inter-agent-communication.ts` — 100/100

Total test counts at campaign close:

| Surface | Tests | vs pre-campaign |
|---|---|---|
| `control.test.ts` | 140 | +59 |
| `multi-agent-invariants.test.ts` | 45 | +28 |
| `subagent-prompts.test.ts` | 54 | NEW (+54) |
| `mailbox.test.ts` | 21 | +0 |
| `agent-send.test.ts` | 30 | +21 |
| `agent-followup.test.ts` | 33 | +24 |
| `agent-wait.test.ts` | 78 | +63 |
| `agent-pool.test.ts` | 21 | NEW (+21) |
| `agent-link.test.ts` | 14 | NEW (+14) |
| `metric.test.ts` | 30 | NEW (+30) |
| `agent-close.test.ts` | 30 | +15 |
| `behaviors.test.ts` | 40+ | NEW |

## Stats

- 10 waves (Wave 0 through Wave 9), each its own settle commit
- 80 commits total; 18,393 insertions, 135 deletions across 94 files
- 35 generator+evaluator subagent pairs across Waves 1-8 (Wave 0 + Wave 9 executor-solo)
- **340/340 cumulative contract criteria passed**
- 0 PLAN UNDOABLE emissions, 0 USER QUESTION emissions
- 1 pivot total (Wave 1 T5 negotiation stall → respawn with pre-agreed contract; pattern adopted standard from Wave 4 onward — strictly faster, no quality regression)
- 1 mid-orchestration crash (Wave 4 attempt 1, rolled forward without reverts; harness recoverability worked)
- T2+T3 parallelized in Wave 7; T2+T3+T4 3-way parallelized in Wave 8 (disjoint write sets per task)
- 2 new GOTCHAS, 5 pre-existing GOTCHAS referenced heavily

## Open iteration items (from CAMPAIGN_AUDIT.md follow-up)

- **Wave 10 dashboard** — TUI subscriber on `agent.metric.*` with rolling-window aggregation. Bus events ship; consumer is the next-iteration deliverable.
- **Iteration 11 prompt revision** — tune from observed rates once Wave 10 ships. Triggers: `safety_net_firing_rate > 0.1` over rolling window of 20+ completions, `sibling_deadlock_rate > 0.3` on `wait_for_reply`, `subagent_tool_error_rate > 0.05` on `send_message`. Any signals a prose contract gap; revise per `PROMPT_SURFACES.md` ownership map.
- **Tune `MAILBOX_DEFAULT_CAPACITY = 32`** and `retry_after_ms = 250` once production traces exist.
- **ABORT pivot loop** only exercised in INV-D-13 stub; await first real `ABORT(approach_failed)` in production orchestration before adopting the formal pivot loop.
- **D6 root-hold for in-flight mail** — permanently deferred. D5b two-pass walk obsoletes the concern.
- **Strict ABORT-reason whitelist** — current behavior is graceful degradation. Strict would catch typos; weigh against flexibility cost.
- **Schema.TaggedErrorClass function% gap** — pre-existing upstream Effect-v4 issue documented in GOTCHA `schema-class-function-coverage`; we work around. No campaign action.
