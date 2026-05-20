# actor-discipline

> **Status (as of 2026-05-20):** shipped on the `codemaxxxing` branch in
> 10 waves (Wave 0 through Wave 9). 340/340 cumulative contract criteria
> passed across 35 generator+evaluator subagent pairs. 28 new integration
> invariants in `multi-agent-invariants.test.ts` (INV-D-01..28). Both
> motivating diagnostic sessions (`ses_1c2e8d84affe`, `ses_1d84f236bffe`
> Demo 2) are unreachable through post-campaign code paths. The full
> pre-existing test suite still passes under `bun test --timeout 30000`.
> Campaign archive: `.wave/campaigns/actor-discipline-2026-05-20/`.

## Background

The previous campaign ([`specs/codex-parity-hardening.md`](./codex-parity-hardening.md))
shipped per-root scoping plus the completion-watcher fiber plus the
`INTEGRATION_INVARIANTS.md` discipline. Two bugs surfaced in real-world
use after that gate. Both were reproducible from session diagnostics
and neither was a primitive failure — both were prose contract failures
that the post-Opus-4.7 model interpreted literally where prior models
had inferred:

1. **Multi-agent delivery contract failure** (`ses_1c2e8d84affeZ7t5g5LKveGDTo`).
   Subagent emitted text plus `close_agent(target: self)` in the same
   assistant turn → message `finish: "tool-calls"` → completion-watcher
   auto-extractor (`agent/control.ts:712-716`) skipped the report and
   walked back to the previous turn → parent received a one-line cleanup
   ("Done.") as the "deliverable." Cascaded with path-fragile self-close
   (`agent_type` used instead of canonical path), tool-error-as-success
   rationalisation, and race between completion notification and pending
   sends.

2. **Sibling-coordination deadlock** (`ses_1d84f236bffeEWmrmOhp6SoLma`
   Demo 2). Two siblings `/root/prosecutor` and `/root/defense` addressed
   openings to a shared parent then idled waiting for each other's
   openings to arrive. No broadcast primitive exists — messages are
   unicast — but the prompts never said so. Both subagents sat at
   `wait_agent` until the user noticed.

Compounded by the Opus 4.6 → 4.7 migration. The new model interprets
prompts literally and will not infer implicit contracts. "Your text
response IS the deliverable" stopped working as an implicit framing;
the model now needs the literal `send_message` instruction. Cursor's
"Continually improving our agent harness" post and Anthropic's AI
Engineer talk on long-running agents (Ash + Andrew, May 2026) both
emphasize the same lesson — prose contracts, integration invariants,
adversarial evaluators.

This campaign reshapes the multi-agent surface into a disciplined actor
system across four phases: prose contracts (P1), ask pattern + ABORT
protocol (P2), the Erlang/Akka surface adapted for LLMs (P3), and
observability instrumentation plus cross-wave audit (P4).

## Phase 0 — bootstrap floor (Wave 0)

Five small but load-bearing changes that the orchestrated waves depend
on. Executor-solo by design — no orchestration means no harness
dependency; landing the safety net BEFORE Wave 1 starts orchestrating
subagents is what catches harness failures during the campaign itself.

### D5 — extractor narrowing plus safety net

The completion-watcher's auto-extractor at `agent/control.ts:712-716`
previously skipped any assistant message with `finish: "tool-calls"`.
That predicate dropped the deliverable in `ses_1c2e8d84affe` — the
substantive body lived in the same turn as the `close_agent` tool call.

| Reference | Lines |
|---|---|
| `extractText` helper (filter text parts, join, trim) | `packages/opencode/src/agent/control.ts:735-755` |
| `looksLikeMissingDeliverable` heuristic (empty OR <200 chars + single-line + cleanup-words regex) | `packages/opencode/src/agent/control.ts:760-790` |
| `buildNotificationBody` (renders ⚠️ warning prefix on silent exits) | `packages/opencode/src/agent/control.ts:795-820` |
| Two-pass walk (D5b, landed inline in Wave 2 after T1 ABORT) | `packages/opencode/src/agent/control.ts:820-859` |

The two-pass walk is the hardening that emerged from Wave 2's
`ABORT(spec_wrong)`. Pass 1 prefers non-terse bodies (`text.length > 0
&& !looksLikeMissingDeliverable(text)`); Pass 2 falls back to any
non-empty text. Preserves the safety-net behavior for the
genuinely-silent-with-only-status-line case (INV-D-03 stays green).
Captured as GOTCHA `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line`.

### D2 — canonical-path injection in subagent system prompts

Subagents previously had to guess their own canonical path from
context. The model would sometimes refer to a sibling as `worker_a`
when the actual path was `/root/coordinator/worker_a` two hops down.
`session/system.ts:capabilityHints` gained an optional `sessionID`
parameter; when provided AND the agent is a subagent AND the resolved
path is non-root, a per-spawn `## Your canonical path` block is
appended to the hints array.

| Reference | Lines |
|---|---|
| `capabilityHints(agent, sessionID?)` extension | `packages/opencode/src/session/system.ts:101-135` |
| `AgentControl` added to `SystemPrompt.defaultLayer` self-supply | `packages/opencode/src/session/system.ts:144-150` |
| Call site updated to pass `sessionID` | `packages/opencode/src/session/prompt.ts:1771` |

### D3 — `close_agent` target optional

`agent-close`'s `target` parameter was required. Subagents wrote
`close_agent(target: "<canonical path I have to compute>")` everywhere
instead of `close_agent()` self-closing. Schema'd `target` as
`Schema.optional`; execute body defaults to caller path.

### D9 — `path_invalid` vs `already_terminated` error split

`close_agent` previously returned `error: "invalid_target"` for both
"wrong path" and "self-terminated child." The first is a model bug
(typo, wrong reference); the second is the success case (the child
exited before close arrived). New `AgentControl.wasKnownPath(senderID,
path)` method, per-root scoped via `slot.knownPaths`. Tool returns
`error: "already_terminated", previous_status: "shutdown"` (no
permission ask) when the path was once registered under this root,
`error: "path_invalid"` when it was never registered.

### D6 — root-hold for in-flight mail (deferred)

The runLoop's break at `prompt.ts:1826` is the natural hook for "hold
root settle until pending mail drains." Investigation showed the
semantics-changing addition wants its own focused wave with explicit
test coverage of the "model says stop → root settles" contract. The
safety net (D5) already catches the failure mode — parent sees a ⚠️
warning instead of silently missing the deliverable — so the race is
observable from the user's side even without the hold. Per Wave 0
WAVE.md §6 explicit allowance and `CAMPAIGN_AUDIT.md` follow-up,
permanently deferred: D5b two-pass walk obsoletes the original
concern.

## Phase 1 — delivery contract prose (Waves 1-2)

The prose surfaces had to state the delivery contract literally for
Opus 4.7. Wave 1 rewrote the five subagent prompts; Wave 2 reproduced
both diagnostic sessions end-to-end as regression invariants.

### D1 — `multi-agent-subagent.txt` delivery contract

The "Final answer" section (pre-campaign lines 35-37) became the
"Delivery contract" section with literal tool-call sequence: every
subagent MUST deliver its result via `send_message` or `followup_task`
to its spawner. Text-extraction via the completion-watcher is a
fallback, not the primary path.

### D7 — sibling coordination patterns

`multi-agent-root.txt` gained the "Sibling coordination" section with
the unicast doctrine plus three working patterns:

- **CC.** Address one primary recipient and CC the others by making
  N explicit `send_message` calls. Cheap, obvious. Use when the peer
  set is small (2-4) and the message is FYI.
- **Coordinator.** Spawn a coordinator subagent that fans out to its
  own children, drains their replies, and sends ONE consolidated
  message back. Use when fan-out is wide (5+) or integration is
  non-trivial.
- **followup_task chain.** Assign the next step to one agent at a
  time. Use when the work is genuinely sequential.

Plus the anti-pattern: do NOT `wait_agent` for a message routed to a
different sibling. `wait_agent` wakes on ANY mailbox update for YOU;
messages addressed to a peer land in the peer's mailbox, not yours.

### D8 — limits of the actor model

`multi-agent-root.txt` gained the "Limits" section enumerating what
the surface deliberately does NOT give you:

- no broadcast primitive (every send is unicast; the runtime will not
  multicast)
- no sibling introspection (you cannot read a peer's mailbox)
- no deadlock detection (the runtime will not break a wait cycle; set
  finite timeouts on every `wait_agent`)
- idle ≠ alive (an agent parked at `wait_agent` holds a slot; close it
  when you're done)
- bounded mailboxes (D15 wired this — sends can fail with
  `mailbox_full`)

### D4 — defer-edits in the base prompts

`general/anthropic.txt`, `general/gemini.txt`, and `explore.txt` each
carry implicit "your text response IS the deliverable" framing in
their opening paragraph and Response format section. Replaced with
explicit pointers to the capability-hint delivery contract. Preserves
caveman output rules, absolute-paths, code-references rules.

### Prose-grep harness

`packages/opencode/test/prose/subagent-prompts.test.ts` (NEW) asserts
forbidden-prose absent and required-phrase present across the five
subagent prompt files. 54 assertions at campaign close. Catches future
regressions where a prompt edit silently drops the delivery contract.

| Reference | Lines |
|---|---|
| `multi-agent-subagent.txt` Delivery contract section | `packages/opencode/src/agent/prompt/multi-agent-subagent.txt:1-30` |
| `multi-agent-root.txt` Sibling coordination | `packages/opencode/src/agent/prompt/multi-agent-root.txt:80-115` |
| `multi-agent-root.txt` Limits | `packages/opencode/src/agent/prompt/multi-agent-root.txt:117-130` |
| Prose harness | `packages/opencode/test/prose/subagent-prompts.test.ts` |

## Phase 2 — ask pattern plus ABORT protocol (Waves 3-4)

Two additive features on the existing tool surface.

### D10 — `correlation_id` plus `wait_for_reply`

`send_message` and `followup_task` accept an optional `correlation_id`.
A new `wait_for_reply(correlation_id, timeout_ms)` variant on the
agent-wait tool blocks until a mailbox message carrying the matching
`correlation_id` arrives — targeted wait that ignores unrelated
mailbox traffic. The broad `wait_agent` (no correlation) still works
for "any mailbox update."

| Reference | Lines |
|---|---|
| `InterAgentCommunication.correlation_id` field | `packages/opencode/src/agent/inter-agent-communication.ts:50-58` |
| `agent-wait` second `Tool.define` for `wait_for_reply` | `packages/opencode/src/tool/agent-wait/agent-wait.ts:280-380` |
| `wait_for_reply` description | `packages/opencode/src/tool/agent-wait/wait-for-reply.txt` |
| `findMailboxByCorrelationId` matcher | `packages/opencode/src/agent/control.ts` |

### D11 — structured ABORT protocol

Subagents can emit `ABORT(<reason>): <details>` as their last
assistant line. The completion-watcher parses the set-phrase
line-anchored to the LAST non-empty line (interior or quoted mentions
do NOT trigger), populates a structured `abort_reason: { reason,
details }` field on the parent's `InterAgentCommunication`
notification, and continues with the human-readable text. Six reasons
in the enum: `spec_wrong`, `transient_tool_error`, `out_of_scope`,
`context_full`, `approach_failed`, `user_question`. Mirrors the wave
system's set-phrase ladder. GOTCHA
`agentcontrol-d11-abort-line-parser-last-line-only` documents the
last-line constraint.

### Mandatory-timeout doctrine

`wait_agent` and `wait_for_reply` now emit a `missing_timeout` warning
in result metadata when `timeout_ms` is omitted, and a
`timeout_clamped` warning when the value exceeds the 600000ms cap. The
call still completes (informational only). Designed to surface silent
stalls as structured warnings rather than 30s-default waits.

| Reference | Lines |
|---|---|
| `abort_reason` schema field | `packages/opencode/src/agent/inter-agent-communication.ts:60-75` |
| `parseAbortReason` line-anchored regex | `packages/opencode/src/agent/control.ts:221-260` |
| `multi-agent-subagent.txt` `## ABORT` section | `packages/opencode/src/agent/prompt/multi-agent-subagent.txt:80-115` |

## Phase 3 — supervision plus pools plus lifecycle plus behaviors (Waves 5-8)

The Erlang/Akka surface adapted to LLM constraints. Each wave shipped
one Phase 3 feature; net effect is the multi-agent tool surface grew
from 6 to 10 tools and the runtime gained per-root supervision,
linking, bounded mailboxes, and per-`agent_type` behavior contracts.

### D12 — supervision strategies (Wave 5)

`spawn_agent` accepts two new optional params:

- **`on_failure`** — `escalate` (default; forward completion-watcher
  notification with terminal status), `respawn` (re-spawn at same
  task_name with fresh session id, capped at 3 attempts then escalates
  with `transient_tool_error`), `ignore` (swallow the failure
  silently, no completion notification), `kill_pool` (Wave 6 wires
  pool teardown).
- **`pool_strategy`** — Erlang OTP-style. `one_for_one` (default;
  isolates failures), `one_for_all` (Wave 6 wires; tears down whole
  pool on single failure), `rest_for_one` (Wave 6 wires; tears down
  members spawned after the failing one).

| Reference | Lines |
|---|---|
| `OnFailureStrategy` + `PoolStrategy` types | `packages/opencode/src/agent/control.ts` |
| 4 new `PerRootData` maps (onFailureOf, poolStrategyOf, respawnAttemptsOf, escalateBudgetOf) | `packages/opencode/src/agent/control.ts` |
| Completion-watcher respawn / ignore / cap-exceeded / escalate dispatch | `packages/opencode/src/agent/control.ts` |
| `agent-spawn.ts` Schema.optional + Union + Literal params | `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` |
| `## Supervision strategies (D12)` in tool description | `packages/opencode/src/tool/agent-spawn/agent-spawn.txt` |

### D13 — `spawn_pool` (Wave 6)

First-class fan-out primitive. Replaces the "spawn N agents in one
message and manage them by hand" pattern with a declarative `count` +
`collect` contract. NEW tool dir `packages/opencode/src/tool/agent-pool/`.

Three collect strategies:

- **`collect: "all"`** — block until every member has sent its
  deliverable via `send_message`. Use when you need every result.
- **`collect: "first"`** — return the first member's deliverable, the
  runtime closes the losers. Race pattern.
- **`collect: "any_n", collect_n: K`** — return when K members have
  delivered, leave the rest alive. Quorum pattern.

A deliverable is an explicit `send_message`/`followup_task` body
authored by a pool member. Completion notifications ("Agent <path>
reached status: …") are filtered out and do NOT count. Pool spawning
is non-atomic — if the K-th spawn trips depth or cap, the pool returns
with K-1 successful + the failure metadata in the `failures` array.

| Reference | Lines |
|---|---|
| `CreatePoolInput` / `CreatePoolResult` / `PoolMemberFailure` / `PoolDeliverable` interfaces | `packages/opencode/src/agent/control.ts` |
| `createPool` / `collectPool` / `listPoolMembers` / `closePoolMembers` methods | `packages/opencode/src/agent/control.ts` |
| `agent-pool.ts` (278 lines, 21 tests, 100/100 coverage) | `packages/opencode/src/tool/agent-pool/agent-pool.ts` |
| `MULTI_AGENT_TOOLS` extended 7→8 | `packages/opencode/src/permission/index.ts` |
| "Routers and pools" subsection | `packages/opencode/src/agent/prompt/multi-agent-root.txt:150-180` |

### D14 — `link_agents` / `unlink_agents` (Wave 7)

Bidirectional symmetric edges on the per-root adjacency map. When
either peer terminates non-gracefully (crash, runtime error, close
from above), the runtime cascades the death to every linked partner
with the `linked_death` label so the completion notification reads
"reached status: linked_death" instead of "shutdown."

Same parameter shape for both ops (`target_a`, `target_b`); symmetric
and idempotent on the pair. Cross-root linking rejected with
`cross_root` error. Self-linking rejected with `self_link`. NEW tool
dir `packages/opencode/src/tool/agent-link/`.

| Reference | Lines |
|---|---|
| `links` + `linkedDeathOf` per-root maps | `packages/opencode/src/agent/control.ts` |
| `linkAgents` / `unlinkAgents` / `agentLinks` methods | `packages/opencode/src/agent/control.ts` |
| Completion-watcher cascade with `linked_death` label | `packages/opencode/src/agent/control.ts` |
| `agent-link.ts` (2 tools, 14 tests, 100/100 coverage) | `packages/opencode/src/tool/agent-link/agent-link.ts` |
| `MULTI_AGENT_TOOLS` extended 8→10 | `packages/opencode/src/permission/index.ts` |

### D15 — bounded mailboxes (Wave 7)

Each agent's mailbox has a finite capacity (default 32 user
messages). When `send_message` or `followup_task` is called against a
full mailbox, the runtime returns `{ error: "mailbox_full",
retry_after_ms: 250 }` instead of queueing. Completion notifications
from terminating subagents bypass this cap (system-bypass via
`sendSystem`) — your subagent crashing always notifies you regardless
of mailbox state.

| Reference | Lines |
|---|---|
| `MAILBOX_DEFAULT_CAPACITY = 32` + `MailboxFullError` | `packages/opencode/src/agent/mailbox.ts` |
| `sendSystem` bypass helper | `packages/opencode/src/agent/mailbox.ts` |
| `sendInterAgentCommunication` `flags?.system` propagation | `packages/opencode/src/agent/control.ts` |
| Mailbox-full structured tool output (retry_after_ms hint) | `packages/opencode/src/tool/agent-send/agent-send.ts`, `agent-followup/agent-followup.ts` |
| Mailbox-backpressure paragraph | `packages/opencode/src/agent/prompt/multi-agent-subagent.txt:115-130` |

### D16 — per-`agent_type` behavior contracts (Wave 8)

NEW file `packages/opencode/src/agent/behaviors.ts`. Declares a
`BehaviorContract` per `agent_type` (e.g. `general` requires
`send_message_to_spawner` before terminating; `explore` requires
read-only completion). At terminal-status time the completion-watcher
computes `BehaviorViolation`s against the declared contract and
attaches them to the parent's `InterAgentCommunication.behavior_violation`
struct. Observer-only — spawn returns successfully regardless; the
orchestrator decides whether to pivot, retry, or abort.

Default contracts shipped for `general` and `explore`; custom agents
inherit no contract by default. Per-spawn override via
`spawn_agent(..., behavior_version: "subagent_v2")`.

| Reference | Lines |
|---|---|
| `BehaviorContract` + `BehaviorViolation` Schema.Class | `packages/opencode/src/agent/behaviors.ts:1-110` |
| `DEFAULT_CONTRACTS` for general + explore | `packages/opencode/src/agent/behaviors.ts:115-180` |
| `resolveContract` + `computeViolations` + `ABORT_REASONS` const | `packages/opencode/src/agent/behaviors.ts:185-249` |
| `behavior_violation` schema field | `packages/opencode/src/agent/inter-agent-communication.ts` |
| `agent.ts` attaches behaviors via `behaviorContractFor` helper | `packages/opencode/src/agent/agent.ts` |
| `PerRootData.behaviorOf` map + completion-watcher validation | `packages/opencode/src/agent/control.ts` |
| `## Your behavior contract` section | `packages/opencode/src/agent/prompt/multi-agent-subagent.txt:140-180` |

## Phase 4 — observability plus audit (Wave 9)

### D18 — `agent.metric.*` bus events

NEW file `packages/opencode/src/wave/metric.ts`. Four `BusEvent.define`
entries under the `agent.metric.*` prefix plus four pure rate helpers
plus the `DeliverableSource` literal union.

- **`DeliverableArrived`** — emitted once per subagent completion-watcher
  notification. `source: "explicit_send" | "extracted" | "safety_net"`
  names HOW the deliverable arrived. `body_length` records the
  extracted body byte count.
- **`SafetyNetFired`** — emitted whenever the D5 safety-net warning
  prefix is prepended. Strict subset of
  `DeliverableArrived(source="safety_net")`, exposed as a separate
  event so alarm-only consumers (TUI badge, audit script) can
  subscribe narrowly without filtering.
- **`SiblingDeadlock`** — emitted when `wait_agent`/`wait_for_reply`
  exits via timeout. `tool_id` ("wait_agent" or "wait_for_reply") lets
  consumers split the rate by call shape — `wait_for_reply` timing out
  is more diagnostic of unicast contract violation.
- **`SubagentToolError`** — emitted when a multi-agent tool call
  returns a tool-recoverable error. `error_kind` tags the failure
  (`mailbox_full`, `target_not_found`, `send_failed`,
  `invalid_timeout`, etc.). High rate is "context rot" canary per
  Cursor's harness post.

Four pure rate helpers: `deliverableArrivalRate`,
`safetyNetFiringRate` (inverse twin), `siblingDeadlockRate`,
`subagentToolErrorRate`. Empty input → 0; otherwise fraction in [0,
1]. Composes cleanly with `Array.prototype.filter` / `slice` to scope
by time window or session.

Per GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`,
no EventV2 counterpart is registered — these are in-process
observability signals only, not persisted to the sourced log.
Emission is fire-and-forget at every call site (`.pipe(Effect.ignore)`).
PubSub failures during instance disposal MUST NOT crash callers.

| Reference | Lines |
|---|---|
| `Event.DeliverableArrived` + `SafetyNetFired` + `SiblingDeadlock` + `SubagentToolError` | `packages/opencode/src/wave/metric.ts:62-139` |
| 4 pure rate helpers | `packages/opencode/src/wave/metric.ts:154-214` |
| `emitSiblingDeadlock` + `emitSubagentToolError` on `AgentControl` | `packages/opencode/src/agent/control.ts` |
| `agent-wait` emits SiblingDeadlock on all 4 timeout paths | `packages/opencode/src/tool/agent-wait/agent-wait.ts` |
| `agent-send` emits SubagentToolError on 5 error branches | `packages/opencode/src/tool/agent-send/agent-send.ts` |
| `agent-followup` emits SubagentToolError on 5 error branches | `packages/opencode/src/tool/agent-followup/agent-followup.ts` |

### `CAMPAIGN_AUDIT.md`

Synthesized at Wave 9 close-out per ANTHROPIC_HARNESS_LEARNINGS.md
§ "Sit with the model, read the traces." Per-wave summary table (10
rows × {outcome, SHA, phase, ships, criteria, pivots, orchestration}),
phase outcome paragraphs, drift catalog with file:line citations,
follow-up iteration items, and the two diagnostic sessions linked
back to their regression tests. 151 lines at
`.wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md`.

## The orchestration shape

Planner / generator / evaluator triad from Anthropic's AI Engineer
talk on long-running agents, evolved over the campaign into
orchestrator-authored CONTRACT.json + per-task gen+eval pairs
("pre-agreed contract" pattern). Captured in
`.wave/campaigns/actor-discipline-2026-05-20/plan/ORCHESTRATOR_PROTOCOL.md`
and `ANTHROPIC_HARNESS_LEARNINGS.md`.

Across the campaign:

- 10 waves, 35 generator+evaluator subagent pairs across Waves 1-8
  (Wave 0 + Wave 9 executor-solo)
- ~140 commits including settle commits and per-task contract commits
- **340/340 cumulative contract criteria passed**
- zero PLAN UNDOABLE emissions, zero USER QUESTION emissions
- one mid-orchestration crash (Wave 4 attempt 1, rolled forward
  without reverts)
- one pivot total (Wave 1 T5 negotiation stall → respawn with
  pre-agreed contract; pattern adopted standard from Wave 4 onward)
- T2+T3 parallelized in Wave 7; T2+T3+T4 3-way parallelized in Wave 8

The "negotiation phase" the talk emphasized was effectively replaced
by orchestrator-authored contracts. The asymmetric-evaluator pattern
(separate agent grades) was preserved end-to-end — no self-evaluation
ever shipped. Drift catalog with file:line citations lives in
`CAMPAIGN_AUDIT.md`.

## Integration invariants (the first-class deliverable)

The campaign extends the per-campaign `INTEGRATION_INVARIANTS.md`
catalog with INV-D-01 through INV-D-28. Each `it.instance` walks the
scenario the invariant describes and asserts what a user would
observe. Every wave touching multi-agent code added at least one
invariant before its production code landed. The full catalog lives
at `.wave/campaigns/actor-discipline-2026-05-20/plan/INTEGRATION_INVARIANTS.md`.

Test surface: `packages/opencode/test/integration/multi-agent-invariants.test.ts`
grew from 13 invariants (post codex-parity-hardening) to **28 invariants
plus 17 pre-existing scoping/lifecycle invariants** = 45 total tests.

Both motivating diagnostic sessions are unreachable through
post-campaign code paths:

| Session | Title | Status | Regression test |
|---|---|---|---|
| `ses_1c2e8d84affeZ7t5g5LKveGDTo` | Cidoo ABM066 delivery failure | **FIXED.** D5 narrowing + safety net + D2 path injection + D5b two-pass walk. | INV-D-01, INV-D-03 + D5b end-to-end test in GOTCHAS. |
| `ses_1d84f236bffeEWmrmOhp6SoLma` Demo 2 | prosecutor/defense sibling deadlock | **FIXED via prose contract.** D7 sibling coordination + D8 limits + D10 correlation_id + wait_for_reply. Runtime gain: D18 SiblingDeadlock metric surfaces this shape live in production. | INV-D-06, INV-D-08, INV-D-10, INV-D-28. |

## Tool surface evolution (6 → 10)

Before this campaign: `spawn_agent`, `send_message`, `followup_task`,
`wait_agent`, `list_agents`, `close_agent`. After: those six plus
`wait_for_reply` (second `Tool.define` in agent-wait), `spawn_pool`
(NEW dir), `link_agents` (NEW dir), `unlink_agents` (same NEW dir).
All consult permission key `task` per the
`MULTI_AGENT_TOOLS` group collapse.

| Tool | Phase | What |
|---|---|---|
| `spawn_agent` | pre-existing + D12 | fire-and-keep-running; now accepts `on_failure` + `pool_strategy` |
| `send_message` | pre-existing + D10 + D15 | FYI queue; now accepts `correlation_id`; returns `mailbox_full` on overflow |
| `followup_task` | pre-existing + D10 + D15 | queue AND wake; now accepts `correlation_id`; returns `mailbox_full` on overflow |
| `wait_agent` | pre-existing + D11 | block on any mailbox update; emits `missing_timeout` warning |
| `wait_for_reply` | D10 NEW | targeted wait — wakes only on matching `correlation_id` |
| `list_agents` | pre-existing | snapshot of every live agent in the tree |
| `close_agent` | pre-existing + D3 + D9 | release a slot; `target` now optional; split `path_invalid` vs `already_terminated` |
| `spawn_pool` | D13 NEW | fan-out N workers with `collect: "all" / "first" / "any_n"` |
| `link_agents` | D14 NEW | bidirectional paired-death edge |
| `unlink_agents` | D14 NEW | drop the edge; symmetric + idempotent |

## Permission keys (unchanged surface)

All new tools land under existing `MULTI_AGENT_TOOLS` group
(permission key `task`). Saved rules like `permission.task: {
"explore": "allow" }` transparently gate `spawn_pool`, `link_agents`,
and `unlink_agents`. Per the `EDIT_TOOLS` precedent — no user
configuration change required. Mirror documented in
`.wave/campaigns/replace-bash-task-2026-05-15/plan/PERMISSION_MAPPING.md`.

## Backward compatibility

Verified end-to-end. Every constraint enumerated in this campaign's
`OVERVIEW.md` § "Hard constraints" holds:

- **No deletions.** All ADR-009 changes are additive (new params with
  defaults, new tools, new prose sections) or surgical (extractor
  predicate change, error-tag split). Existing six-tool API surface
  stays compatible.
- **No Drizzle migrations.** `correlation_id`, `abort_reason`,
  `behavior_violation` are optional fields on
  `InterAgentCommunication`; existing rows remain valid.
- **No prompt-cache invalidation surprises.** Capability hints render
  LAST. Per-spawn path injection (D2) is in the hint; the rest of the
  prompt cache stays stable.
- **Per-root scoping is preserved.** Every new AgentControl method
  takes a `senderID: SessionID` parameter and resolves the caller's
  root. Mirrors the Iteration 8 hardening pattern. Multi-chat-same-project
  keeps working.
- **No subagent self-evaluation.** Orchestrated waves spawn separate
  evaluator subagents; the generator never grades its own work, and
  the executor never grades the generator's work directly.
- **The 5 prompt files stay in place.** No file moves. D1 rewrites
  `multi-agent-subagent.txt` in place; D4 defer-edits the three base
  prompts in place; D7/D8 add sections to `multi-agent-root.txt` in
  place.

The full pre-existing test suite passes under
`bun test --timeout 30000`. Per-file 100% line coverage on every new
file (`control.ts` function% gap is the pre-existing
`schema-class-function-coverage` GOTCHA, not introduced by this
campaign).

## Discoveries appended to GOTCHAS.md

Two new entries:

- **`agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line`**
  — D5 completion-watcher must prefer non-terse bodies before falling
  back to terse status lines (Cidoo ABM066 shape regression test).
- **`agentcontrol-d11-abort-line-parser-last-line-only`** — parse
  ABORT set-phrase anchored to LAST non-empty line; interior or quoted
  ABORT mentions must NOT trigger false positives.

Pre-existing GOTCHAS referenced heavily by this campaign (not added
by it):
- `agentcontrol-providerref-must-live-in-layer-not-instancestate` —
  per-root scoping invariant for every new AgentControl method.
- `schema-class-function-coverage` — function% gap explanation for
  `control.ts` (multiple Schema.TaggedErrorClass), `behaviors.ts`,
  `inter-agent-communication.ts`, `mailbox.ts` (MailboxFullError).
- `bun-test-coverage-source-file-arg-runs-zero-tests` +
  `bun-coverage-aggregation-flake` — single-file coverage discipline
  preserved end-to-end.
- `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch` —
  used by Wave 9 `metric.test.ts` and INV-D-27/28 bus subscription.
- `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` — used
  by Wave 9 `metric.ts` to justify Bus-only emission (no EventV2
  counterpart for in-process observability signals).

## What this campaign explicitly does NOT do

- **Wave 10 TUI dashboard for the 4 D18 rates.** The bus events ship;
  a TUI subscriber + rolling window aggregator is suggested as a
  next-iteration deliverable. Not blocked.
- **Iteration 11 prompt revision.** Recommended after Wave 10's
  dashboard surfaces real production rates. Trigger thresholds:
  `safety_net_firing_rate > 0.1` over a rolling window of 20+
  completions, `sibling_deadlock_rate > 0.3` on `wait_for_reply`,
  `subagent_tool_error_rate > 0.05` on `send_message`. Any of those
  signals a prose contract gap; revise the relevant prompt section
  per `PROMPT_SURFACES.md` ownership map.
- **D6 root-hold for in-flight mail.** Permanently deferred. D5b
  two-pass walk obsoletes the original concern.
- **Tune `MAILBOX_DEFAULT_CAPACITY=32` and `retry_after_ms=250` from
  production observability.** Available now that D18 metrics ship; do
  not tune until real traces exist.
- **Strict ABORT-reason whitelist.** Current behavior is graceful
  degradation — unrecognized reasons forwarded verbatim. Strict
  whitelist would catch typos; weigh against the flexibility cost.
- **ABORT pivot loop in production wave orchestration.** Wave 4
  shipped the ABORT protocol but only tested in INV-D-13 stub. Wave
  10+ orchestration can adopt the formal pivot loop once an evaluator
  emits `ABORT(approach_failed)` in a real wave.

## Forward-looking

The next multi-agent feature MUST add tests against
[`INTEGRATION_INVARIANTS.md`](../.wave/campaigns/actor-discipline-2026-05-20/plan/INTEGRATION_INVARIANTS.md)
before its production code lands. Adding a new invariant is allowed
and expected: discover a sharp edge during implementation, write the
green test, append the doc entry, ship. The integration-first
discipline from the codex-parity-hardening campaign is preserved and
extended.

The pre-agreed contract orchestration pattern is the default. Waves
4-8 prove it works at scale (28 subagent sessions, 0 pivots in Waves
5-8). Future orchestrated waves should follow this pattern unless the
criteria require subjective grading (in which case the formal
negotiation phase is the right tool).

The Anthropic talk's harness is one shape; ours is now provably
another. We kept the planner/generator/evaluator triad but evolved the
negotiation phase out and replaced it with orchestrator-authored
contracts. The talk's "27 contract criteria" maps cleanly to our
pre-agreed CONTRACT.json. The pivot mechanism is exercised in tests
(INV-D-13) but didn't fire in production orchestration after Wave 1.
If a future wave hits a real ABORT(approach_failed) → pivot scenario,
the protocol is ready.

## Campaign archive

Full per-wave plans, NOTES, decisions, contracts, and the
campaign-curated `CAMPAIGN_AUDIT.md` live at
`.wave/campaigns/actor-discipline-2026-05-20/`. Ten waves (`wave_0`
through `wave_9`), each with its own commit on the `codemaxxxing`
branch:

| Wave | Phase | Settle SHA | What landed |
|---|---|---|---|
| 0 | bootstrap (P0) | `bfe5e1db3` | D5 extractor narrowing + safety net; D2 canonical-path injection; D3 self-close optional `target`; D9 `path_invalid`/`already_terminated` split |
| 1 | prose contract (P1) | `1278d48be` | D1 delivery contract; D7 sibling coordination + D8 limits; D4 defer-edits; prose-grep harness; INV-D-06 + INV-D-08 |
| 2 | validation (P1) | `4fda52548` | INV-D-01..08 + 2 regressions green; D5b two-pass extractor hardening; GOTCHA `agentcontrol-d5-extractor-needs-two-pass-walk-...` |
| 3 | ask pattern (P2A) | `39ffe0e2f` | D10 correlation_id + wait_for_reply; mandatory-timeout doctrine; INV-D-09..11 |
| 4 | ABORT protocol (P2B) | `8c16cbc7d` | D11 schema + parser + prose; INV-D-12..14; GOTCHA `agentcontrol-d11-abort-line-parser-last-line-only` |
| 5 | supervision (P3A) | `209ce3e63` | D12 control.ts runtime + agent-spawn params + INV-D-15..17 |
| 6 | spawn_pool (P3B) | `991721ef6` | D13 pool primitives + NEW agent-pool tool + INV-D-18..20 |
| 7 | lifecycle (P3C) | `3347ac552` | D14 link/unlink + NEW agent-link tool + D15 bounded mailbox + INV-D-21..23 |
| 8 | behaviors (P3D) | `93b3f7867` | D16 NEW behaviors.ts + InterAgentCommunication.behavior_violation + per-`agent_type` contracts + INV-D-24..26 |
| 9 | observability (P4) | `8f52750a0` | D18 NEW metric.ts + 4 bus events + 4 rate helpers + emission wiring + INV-D-27/28 + CAMPAIGN_AUDIT.md |

Wave specs live at
`.wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_<N>/WAVE.md`.
Per-wave NOTES.md (every attempt's narrative, what failed, what was
tried) live at
`.wave/campaigns/actor-discipline-2026-05-20/waves/wave_<N>/NOTES.md`
(Waves 4-9) or
`.wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_<N>/NOTES.md`
(Waves 0-3, before the directory layout was finalized).

The branch base is the previous campaign's `codex-parity` HEAD; this
campaign continues on the same `codemaxxxing` branch. The default
branch `dev` does NOT carry the campaign's changes — merge is a
separate decision.
