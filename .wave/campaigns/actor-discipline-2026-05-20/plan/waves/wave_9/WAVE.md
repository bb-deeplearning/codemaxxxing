# Wave 9 — Observability + cross-wave audit (executor-solo)

<!--
Previous waves: 0-8.
Orchestration: SOLO. The audit is irreducibly your job — you have access to all
prior wave NOTES.md files and can synthesize across them. Spawning subagents
to "audit the audit" is unnecessary recursion.

Also read:
- ../../OVERVIEW.md (skip ORCHESTRATOR_PROTOCOL.md — not orchestrating)
- ../../ANTHROPIC_HARNESS_LEARNINGS.md § "Sit with the model, read the traces"
- ../../INTEGRATION_INVARIANTS.md (full catalog; assert nothing red)
- ../../REFERENCES.md
- Every prior wave's NOTES.md if present
- packages/opencode/test/AGENTS.md
-->

## Goal

Two deliverables, both about observing the campaign's outcome:

1. **D18 instrumentation** — emit metrics for the four key health signals the campaign exists to improve. The metrics flow through the existing bus infrastructure; downstream consumers (TUI dashboard, future Wave 10's dashboard if shipped) read them.
2. **Cross-wave audit** — read every prior wave's NOTES.md. Synthesize a `CAMPAIGN_AUDIT.md` document at `.wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md`. Captures drift between intended pattern and what the orchestrators actually did, surface follow-up iteration items.

This wave is executor-solo because:
- Instrumentation is small surface (4 metric emitters + their bus event definitions).
- The audit requires synthesizing across all wave NOTES.md files, which is irreducibly the executor's job.
- Adding a planner+evaluator pair would multiply work without adding value (no rubric is going to help grade a meta-audit).

Deliverables:

1. **D18 metrics** — four counters / gauges:
   - `multi_agent.deliverable_arrival_rate` — fraction of completed subagents whose deliverable reached the spawner via explicit send_message (vs auto-extraction vs safety-net warning). Track over a rolling window.
   - `multi_agent.safety_net_firing_rate` — count of safety-net warnings per N completions.
   - `multi_agent.sibling_deadlock_rate` — count of `wait_agent` calls that timed out (vs woke on mailbox event). High rate suggests prompts aren't teaching unicast.
   - `multi_agent.subagent_tool_error_rate` — count of subagent tool calls that returned a tool-recoverable error. High rate is "context rot" canary per Cursor's harness post.
2. **Bus events for each metric** — `agent.metric.*` event types. Existing bus + sourced-log dual emission pattern applies (see GOTCHA `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`).
3. **CAMPAIGN_AUDIT.md** — markdown document at the campaign root (alongside STATE.md). Sections:
   - Per-wave summary (one line each: what shipped, pivot count, orchestration style)
   - Phase 1 outcomes (delivery contract: did it take? safety net firing rate from the test runs?)
   - Phase 2 outcomes (ask pattern adoption in tests? ABORT protocol observed firing?)
   - Phase 3 outcomes (pool/link/behavior adoption?)
   - Drift catalog: where did orchestrator behavior diverge from ORCHESTRATOR_PROTOCOL.md? File:line citations.
   - Follow-up iteration items: what's the next campaign / iteration?
   - The two diagnostic sessions: linked back to the regression tests; status (fixed / still possible / new shape?).

## Tasks (solo)

Do these in sequence yourself.

### Task 9.1 — Instrumentation

Files (likely):
- `packages/opencode/src/agent/control.ts` — increment metrics on completion-watcher events.
- `packages/opencode/src/agent/mailbox.ts` — increment metrics on send / drain / overflow.
- `packages/opencode/src/wave/metric.ts` (NEW) — metric definitions + bus event types.

Use the existing bus infrastructure. Don't add a new metric SDK; metrics are bus events that downstream consumers aggregate.

Tests:
- `packages/opencode/src/wave/metric.test.ts` (NEW) — unit tests per metric.
- Integration test: run the multi-agent invariant suite, observe metric events fire with plausible values.

### Task 9.2 — CAMPAIGN_AUDIT.md

Read every wave's NOTES.md. Read every CONTRACT.json. Read STATE.md.

For drift detection:
- Compare each wave's actual orchestration style (from NOTES.md "Orchestration:" line) against the protocol (planner + per-task gen+eval pairs).
- Note any pivots burned, any USER QUESTIONs surfaced, any waves that emitted PLAN UNDOABLE.
- Note the safety-net firing rate observed in tests — was it within expectation, or too noisy?

For follow-up items:
- Anything marked in any NOTES.md as "future work" or "deferred."
- Any invariants that needed loosening to land green.
- Any GOTCHAS added during the campaign (look at repo-root GOTCHAS.md for new entries dated 2026-05-20+).
- Any open USER QUESTIONs that the user answered with "defer."

## Gotchas

1. **Don't spawn subagents.** This wave is solo. You have the context to do both deliverables.
2. **Instrumentation must be cheap.** Counter increments via bus events should be sub-microsecond. Don't add blocking IO. If you find yourself wanting to write metrics to disk, stop — bus events with downstream consumers is the pattern.
3. **CAMPAIGN_AUDIT.md is for humans + future agents.** Caveman style for prose, but include enough specifics (commit shas, file:line refs, invariant slugs) that someone resuming a year later can act on it.
4. **The audit IS a deliverable** — it must commit alongside Wave 9's WAVE COMPLETE. If you can't write a useful audit because prior NOTES.md files are empty/sparse, that's diagnostic: emit USER QUESTION about whether to retroactively fill or proceed with what's available.
5. **GOTCHAS to consult:**
   - `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` — for the new agent.metric.* events.
   - `bus-subscriber-needs-instance-state-fork-and-instance-ref` — if you wire a metric aggregator.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/wave/metric.test.ts                       # NEW
bun test src/agent/control.test.ts                     # extend (metric emission)
bun test src/agent/mailbox.test.ts                     # extend

# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/wave/metric.test.ts
bun test --coverage src/agent/control.test.ts
bun test --coverage src/agent/mailbox.test.ts

# Full integration suite — final regression
bun test ./test/integration/multi-agent-invariants.test.ts

# Audit artefact
test -f .wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md
wc -l .wave/campaigns/actor-discipline-2026-05-20/CAMPAIGN_AUDIT.md   # should be > 50 lines
```

All must exit 0. On success: emit `WAVE COMPLETE`, advance STATE.md `wave_status: all_complete`.
