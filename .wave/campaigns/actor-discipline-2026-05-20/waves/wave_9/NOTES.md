# Wave 9 — Notes

## Attempt 1 — success (WAVE COMPLETE)

**Session:** ses_1ba5566e5ffeUj6iUyR5ONe2dp
**Settle commit:** 8f52750a0
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** executor-solo per WAVE.md header. No planner, no gen+eval pairs, no pivots — the audit synthesis is irreducibly the executor's job and the instrumentation surface is small enough (4 metric emitters + 1 new file) that a planner-evaluator decomposition would multiply work without adding value.

## What shipped

### Task 9.1 — D18 instrumentation

- **NEW `packages/opencode/src/wave/metric.ts`** (~230 lines): defines 4 BusEvent under the `agent.metric.*` prefix + 4 pure rate helpers + the `DeliverableSource` literal union (`"explicit_send" | "extracted" | "safety_net"`). Per GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`, no EventV2 counterpart is registered — these are in-process observability signals only.
  - `Event.DeliverableArrived` — sessionID + child_path + child_session_id + source + body_length.
  - `Event.SafetyNetFired` — sessionID + child_path + child_session_id.
  - `Event.SiblingDeadlock` — sessionID + timeout_ms + tool_id.
  - `Event.SubagentToolError` — sessionID + tool_id + error_kind.
  - Pure helpers: `deliverableArrivalRate`, `safetyNetFiringRate` (inverse twin), `siblingDeadlockRate`, `subagentToolErrorRate`. Empty input → 0; otherwise fraction in [0, 1].
- **`control.ts` completion-watcher** (line ~1259 region): after the existing `sendInterAgentCommunication` call, emit `Metric.Event.DeliverableArrived` with `source` derived from D5's `childDelivered` + `needsWarning` flags. Pair `Metric.Event.SafetyNetFired` when `needsWarning` is true. Fire-and-forget via `.pipe(Effect.ignore)`.
- **`control.ts` Interface extension**: added `emitSiblingDeadlock(sessionID, timeoutMs, tool_id)` and `emitSubagentToolError(sessionID, tool_id, error_kind)` Effect helpers that wrap `bus.publish(Metric.Event.*).pipe(Effect.ignore)`. Centralizes emission inside the AgentControl service so callers don't need their own Bus reference.
- **`agent-wait.ts`**: emits `emitSiblingDeadlock` on every timeout path — the early-sleep branch (no mailbox), the race-timeout branch, the `wait_for_reply` no-mailbox fallback, and the `wait_for_reply` race-timeout branch. Also emits `emitSubagentToolError` on the `invalid_timeout` branches of both tools.
- **`agent-send.ts`**: emits `emitSubagentToolError` on `empty_message`, `target_not_found`, `mailbox_full`, and `send_failed` branches.
- **`agent-followup.ts`**: emits `emitSubagentToolError` on `empty_message`, `reference_invalid`, `root_target`, `mailbox_full`, and `send_failed` branches.

### Task 9.2 — `CAMPAIGN_AUDIT.md`

151-line markdown audit at `.wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md`. Sections per WAVE.md spec:
- Per-wave summary table (10 rows × {outcome, SHA, phase, ships, criteria, pivots, orchestration}).
- Phase 0-4 outcome paragraphs.
- Drift catalog (6 entries with file:line citations).
- Follow-up iteration items (7 entries with recommendation per item).
- The two diagnostic sessions linked back to regression tests.
- "What to do if you're reading this" — 5-item guidance for future agents resuming the surface.

Summary stats from the audit:
- 10 waves, 35 generator+evaluator pairs, ~140 commits, **340/340 cumulative contract criteria passed**, zero PLAN UNDOABLE, zero USER QUESTION (Wave 0's `wave 0 (paused)` resolved same-session), one mid-orchestration crash (Wave 4 attempt 1, rolled forward).

## Tests added

- **`packages/opencode/src/wave/metric.test.ts`** (NEW, 30 tests, 100% lines / 100% functions): schema decode per event, schema rejection on bad input, prefix-string assertions, rate-helper math (empty / all-ok / all-bad / mixed), the inverse identity `deliverableArrivalRate + safetyNetFiringRate ≈ 1`, and 5 bus-end-to-end tests using `Bus.Service.subscribeCallback` (in-effect, per GOTCHA `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch`).
- **`packages/opencode/src/agent/control.test.ts`** extended with `AgentControl D18 observability metric emission` describe block (5 it.live tests): DeliverableArrived with source=extracted on substantive completion; DeliverableArrived + SafetyNetFired pair on silent child; DeliverableArrived with source=explicit_send when child sent to spawner; emitSiblingDeadlock publishes with tool_id + timeout_ms (both wait_agent and wait_for_reply); emitSubagentToolError publishes with tool_id + error_kind.
- **`packages/opencode/test/integration/multi-agent-invariants.test.ts`** extended with **INV-D-27** (deliverable + safety-net metric pair fires on completion) and **INV-D-28** (sibling-deadlock metric fires on wait_agent timeout). Both use real `Bus.Service.subscribeCallback`. Sample size = 1 verifies rate helpers compute reasonable values (safetyNetFiringRate=1; deliverableArrivalRate=0; siblingDeadlockRate=1 across single observations).

## Verification results (orchestrator-run at settle)

| Surface | Result |
|---|---|
| `bun typecheck` | exit 0 (tsgo --noEmit clean) |
| `bun lint` (repo root, oxlint) | 0 errors / 3148 pre-existing warnings (same as Wave 8 baseline; no drift) |
| `bun test src/wave/metric.test.ts` | 30 pass / 0 fail / 45 expects |
| `bun test --coverage src/wave/metric.test.ts` → metric.ts | 100.00% functions / 100.00% lines |
| `bun test src/agent/control.test.ts` | 140 pass / 0 fail / 324 expects (was 135; +5 for D18 describe block) |
| `bun test --coverage src/agent/control.test.ts` → control.ts | 93.38% functions / 100.00% lines (function% gap = pre-existing Schema.TaggedErrorClass GOTCHA) |
| `bun test src/agent/mailbox.test.ts` | preserved 21 pass / 0 fail (no mailbox.ts changes this wave) |
| `bun test --coverage src/agent/mailbox.test.ts` → mailbox.ts | 95.65% functions / 100.00% lines (preserved Wave 7 baseline) |
| `bun test --coverage src/tool/agent-send/agent-send.test.ts` → agent-send.ts | 100.00% functions / 100.00% lines |
| `bun test --coverage src/tool/agent-followup/agent-followup.test.ts` → agent-followup.ts | 100.00% functions / 100.00% lines |
| `bun test --coverage src/tool/agent-wait/agent-wait.test.ts` → agent-wait.ts | 100.00% functions / 100.00% lines |
| `bun test ./test/integration/multi-agent-invariants.test.ts` | 45 pass / 0 fail / 231 expects (was 43; +2 for INV-D-27/28) |
| `bun test ./test/prose/subagent-prompts.test.ts` | 54 pass / 0 fail / 55 expects (preserved Wave 8 baseline) |
| `bun test -t 'INV-D-27'` | 1 pass / 44 filtered |
| `bun test -t 'INV-D-28'` | 1 pass / 44 filtered |
| `test -f .wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md` | exit 0 |
| `wc -l .wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md` | 151 lines (well above WAVE.md's `> 50` floor) |

## Design decisions

1. **No publish-helper wrappers in metric.ts.** Considered an Effect-based `publishX(data)` helper that yields `Bus.Service` internally. Rejected because the resulting Effect's `R` would force `Bus.Service` into every caller's environment, and Tool.define's outer-gen would need to provide it (extra import + extra yield in every tool). Cleaner: callers `bus.publish(Metric.Event.X, ...).pipe(Effect.ignore)` inline OR call the new `control.emitX(...)` helpers (which capture the bus once at AgentControl layer-build time).
2. **emitSiblingDeadlock + emitSubagentToolError on AgentControl, not on Metric module.** Centralizes the bus reference inside the service that already owns lifecycle. Tools yield `control.emitX(...)` without needing their own `Bus.Service` import. The Metric module stays pure (event definitions + rate helpers); the emission glue lives on the service that has access to the bus.
3. **NO EventV2 dual-emission for `agent.metric.*` events.** Per WAVE.md gotcha 2 and GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`, these are in-process observability signals only. Persisting metrics to the sourced log would create a parallel-prefix mess + couple the metric surface to projector/replay machinery for no gain (consumers don't replay them). Wave 10+'s dashboard subscribes via `Bus.Service.subscribeCallback`; failure to attach is silent and safe.
4. **`source` literal union vs three booleans.** Considered `{ delivered: boolean, safety_net_fired: boolean, extracted: boolean }` per event. Rejected: a single tagged union (`source: "explicit_send" | "extracted" | "safety_net"`) is mutually exclusive by construction — the rate helpers can't double-count, and consumers filter cleanly. The `SafetyNetFired` event is a strict subset of `DeliverableArrived(source=safety_net)` exposed as a separate event so alarm-only consumers (TUI badge, audit script) can subscribe narrowly.
5. **integration test added Bus.defaultLayer to Layer.mergeAll.** The existing chain provided Bus transitively through AgentControl.defaultLayer, but `yield* Bus.Service` from the test required Bus.Service to be SATISFIED at the test's R. AgentControl provides Bus as a private dep, not publicly. Adding `Bus.defaultLayer` to the merge exposes Bus.Service to test scope without changing AgentControl's surface.
6. **Cleanup of lazy `Effect.promise(() => import("@/wave/metric"))` pattern.** First-draft tests used dynamic import to defer the metric reference; replaced with top-of-file `import { Metric } from "@/wave/metric"` after typecheck flagged the `source: string` type widening from lazy imports.

## Observations for the user

- **Pre-agreed contract pattern + cross-task parallelization scaled cleanly across Waves 4-8.** Wave 9's executor-solo shape proves the FSM/state surface tolerates both ends of the spectrum (full orchestration AND no-orchestration) without modification.
- **No new GOTCHAS discovered.** Existing entries covered everything: `agentcontrol-providerref-must-live-in-layer-not-instancestate` (the bus reference is layer-scope, not InstanceState — same pattern); `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` (Bus-only emission justified); `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch` (used in-effect subscribeCallback throughout tests); `schema-class-function-coverage` (control.ts function% gap preserved at 93.38% — same baseline as Wave 8).
- **CAMPAIGN_AUDIT.md surfaces 7 follow-up iteration items.** Most actionable: tune `MAILBOX_DEFAULT_CAPACITY=32` and `retry_after_ms=250` from production observability now that the metrics ship. Suggest a Wave 10 dashboard subscribing to `agent.metric.*` aggregating rolling windows.
- **The two diagnostic sessions are unreachable through post-campaign code paths.** Both regression tests run on every wave's verification. The campaign's first-class deliverable (the integration invariant catalog) prevented every shape it set out to prevent.
- **Total Wave 9 effort:** 1 NEW file + 4 modified files (control.ts, agent-wait.ts, agent-send.ts, agent-followup.ts) + 3 modified test files (control.test.ts, multi-agent-invariants.test.ts, plus NEW metric.test.ts) + 1 NEW CAMPAIGN_AUDIT.md. Zero subagent sessions; zero pivots; first-attempt success.
- **Campaign complete: 10 of 10 waves shipped.** STATE.md transitions to `wave_status: all_complete` and `current_wave: 10` after this commit.
