# Performance — measurement protocol and regression budget

Carries forward from `.wave/campaigns/codex-parity-2026-05-13/plan/PERF.md`. The frozen baseline lives at the previous campaign's artifact path; this campaign compares against it without writing back.

## Hot paths

Same as the previous campaign. The bugs this campaign fixes touch:

- `AgentControl.spawnAgent` (Wave 1 refactor + Wave 2 adds a watcher fiber)
- `AgentControl.sendInterAgentCommunication` (Wave 1 root resolution + Wave 2's notification path uses it)
- `AgentControl.listAgents` (Wave 1 scoping)
- `AgentControl.closeAgent` (Wave 1 scoping)

Each of those operations has a metric in the baseline JSON. Wave 1, Wave 2, and Wave 3 each re-run the relevant bench and assert no regression beyond budget.

## Baseline (FROZEN)

```
.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json
```

Captured at SHA `18369b2a8`. This file is FROZEN — never overwrite. Per GOTCHA `bun-test-test-dir-runs-baseline-orchestrator`: do NOT run `bun test test/` for spot-checks (it will silently rerun the orchestrator and overwrite the baseline). Run per-area instead. If the baseline is accidentally regenerated, restore via `git checkout .wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`.

Relevant baseline metrics for this campaign (from the previous campaign's wave 7 capture):

- `spawn_agent.spawn` — p50 ~403µs
- `agent_control.send` — p50 ~17µs
- `agent_control.list(16)` — p50 ~12µs
- `mailbox.wakeup` — p99 < 5ms (per `PERF.md`'s concurrent-session invariant)

## Per-wave perf

Each wave that touches a hot path adds its own bench file in `packages/opencode/test/perf/<area>.bench.ts` and outputs JSON to `.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf/wave_<N>.json`.

Use the harness at `packages/opencode/test/lib/perf.ts`. `Bun.nanoseconds()` for timing. Same `bench` / `compareToBaseline` API the previous campaign used.

Regression budget: **5/10/15 % on p50/p95/p99** vs baseline. If any metric the wave touches exceeds these bounds, the wave fails — surface as USER QUESTION with the regression details if you genuinely cannot stay under budget.

## Wave-specific perf expectations

### Wave 1 (per-root scoping)

Adds one Map lookup per AgentControl method (resolve caller's root → look up PerRootData). This is O(1) on a small Map. Expected impact: < 5% on p50 of `spawnAgent`, `sendInterAgentCommunication`, `listAgents`. Re-run `test/perf/agent-control.bench.ts` and assert.

If a metric regresses > 5% on p50, the lookup is too expensive — switch from `Map<RootSessionID, PerRootData>` to a different data structure or cache the root resolution per-session.

### Wave 2 (completion watcher)

Adds one forked fiber per `spawnAgent` call. Forking a fiber is cheap (sub-µs) but not free; a perf-conscious refactor will check that the per-spawn cost stays within budget.

The watcher's body subscribes to a SubscriptionRef and sleeps until a final status. Zero work between spawns. Per-spawn p50 should not regress > 5% vs baseline.

The notification SEND (when a child completes) routes through `sendInterAgentCommunication` and adds a notify-broadcast cost on the parent's mailbox. `mailbox.wakeup` p99 must stay < 5ms.

### Wave 3 (audit pass)

May add additional integration tests but should not change production code in any way that touches a hot path. If Wave 3 patches a bug discovered by an invariant test, rerun the relevant bench.

### Wave 4 (verification)

Re-runs every relevant bench file. Aggregates results into `artifacts/perf-final-report.md`.

## No live LLM calls — ever

Same as the previous campaign. `stub-provider.ts` for any test or bench that goes through the model. Per `PERF.md`'s reasoning: live latency is dominated by network, costs API budget for zero signal, is non-deterministic.

The completion-watcher integration test in Wave 2 uses `stub-provider.ts` to script a single-turn child response that completes within ~50ms. Any e2e perf test in Wave 4 also uses the stub.

## Bench harness

```ts
import { bench, compareToBaseline } from "@opencode/test/lib/perf"

await bench("agent_control.spawn", { samples: 1000, warmup: 100 }, async () => {
  // op under measurement
})

const report = compareToBaseline(
  ".wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json",
)
expect(report.regressions).toEqual([])  // fails wave if any
```

Bench files use the embedded `test()` + `afterAll` writer pattern (per GOTCHA `bench-file-pattern-split`). Run via `bun test ./test/perf/<wave>.bench.ts` (with `./` prefix per `bun-test-bench-file-path` GOTCHA).

For benches that need an Instance binding, wrap with `Effect.scoped(provideTmpdirInstance(...))` per GOTCHA `bench-managed-runtime-needs-effect-scoped`.

For benches that compare against the wave_0 single-shot baseline algorithm, follow the methodology in GOTCHA `runloop-bench-vs-baseline-methodology-mismatch` — match the per-sample structure or treat the comparison as a sanity check, not a strict bound.

For TUI benches, apply the best-of-N pattern from GOTCHA `opentui-render-bench-noise-needs-best-of-n` (this campaign has no TUI benches expected, but Wave 3's audit may surface one).

## Memory budget

Same as previous campaign:

- 64 PTYs × 1 MiB head/tail buffer = 64 MiB max for unified_exec.
- 16 concurrent agents × ~10 MiB session state ≈ 160 MiB max for multi-agent.
- Mailbox: unbounded queue of small messages.

If a test or bench exceeds 200 MiB resident set size, fail the wave.

## What "no regression" means in practice

For each metric the wave touches:

- `(post.p50 - baseline.p50) / baseline.p50 ≤ 0.05`
- `(post.p95 - baseline.p95) / baseline.p95 ≤ 0.10`
- `(post.p99 - baseline.p99) / baseline.p99 ≤ 0.15`

If `post < baseline`, ratio is negative — that's an improvement, no concern. If positive and within budget, fine. If positive and over budget, the wave fails.

If a wave's metric is suspiciously fast (e.g. -50% vs baseline), apply the methodology audit from GOTCHA `runloop-bench-vs-baseline-methodology-mismatch` — verify the per-sample structure matches before claiming a speedup.
