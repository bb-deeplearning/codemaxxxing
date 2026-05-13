# Performance — measurement protocol and regression budget

Performance is a feature in codemaxxxing. The TUI session route is already hand-tuned (see comments in `routes/session/index.tsx:134-154, 240-242`). Every wave that touches a hot path must measure before and after.

## Hot paths

These are the surfaces where regressions hurt users immediately. Any change to code on these paths requires a benchmark.

1. **TUI session render** (`tui/routes/session/index.tsx`) — runs every streaming chunk
2. **runLoop step overhead** (`session/prompt.ts:1431-1646`) — runs every model step
3. **Pty output push** (`pty/index.ts:231-255`) — runs every PTY chunk
4. **Permission.ask** (`permission/index.ts:179-214`) — runs every tool call
5. **EventV2.run + Bus publish** (`v2/event.ts:44`, `bus/index.ts:87`) — runs many times per turn
6. **Snapshot.track / Snapshot.patch** (`processor.ts:115, 484`) — runs at every tool-call boundary

## Baseline (Wave 0)

Wave 0 captures baseline numbers for every hot path on the current `codemaxxxing` HEAD. Stored as JSON at:

```
.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json
```

Format (each metric is a `{ p50, p95, p99, samples, op }` block in nanoseconds):

```json
{
  "captured_at": "2026-05-13T...",
  "git_sha": "568da2532...",
  "node_version": "...",
  "metrics": {
    "pty.push.4kb": { "p50": ..., "p95": ..., "p99": ..., "samples": 1000, "op": "Pty.create then onData chunks" },
    "session.render.tool_part": { "p50": ..., "p95": ..., ... },
    "runloop.step": { "p50": ..., ... },
    "permission.ask.cached": { "p50": ..., ... },
    "permission.ask.uncached": { "p50": ..., ... },
    "eventv2.run": { "p50": ..., ... },
    "bus.publish": { "p50": ..., ... },
    "snapshot.track": { "p50": ..., ... }
  }
}
```

This file is committed to the repo so subsequent waves can compare against a known reference, even after a fresh clone.

## Per-wave perf

Every wave that touches a hot path adds its own bench. Output goes to:

```
.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_<N>.json
```

Same metric format. The wave's verification step computes deltas vs baseline for every metric the wave touches.

## Regression budget

**5% on p50, 10% on p95, 15% on p99.** If any metric the wave touches exceeds these bounds versus baseline, the wave fails.

If you genuinely cannot stay under the budget — for instance, an unavoidable correctness fix that costs a few percent — write the regression and its justification into NOTES.md, mark the wave `failed`, and surface as USER QUESTION. Do not silently bump the baseline.

## No live LLM calls in perf — ever

Every perf bench in this campaign uses a **stubbed provider** for any code path that goes through the model. Reasons:

- Live LLM latency is dominated by network + model serving — measuring it tells you nothing about our overhead
- Cost: a 1000-sample bench × 4 hot-path benches per wave × 16 waves = burned API budget for zero signal
- Determinism: provider responses vary; bench p99 would be unmeaningful

The stub is acceptable for perf because perf is measuring *our* code, not theirs. **Behavior tests still use real providers (or carefully-scoped fakes) where required, but never as part of a perf bench.**

The harness ships with a `stubProvider()` helper. Every bench that touches `runLoop`, `processor`, or any tool execution path that includes a model step uses this helper. If a wave adds a perf bench that exercises code reaching `LLM.Service.stream`, it MUST use `stubProvider()` and the wave's verification asserts no real `fetch` calls were made during the bench.

Same rule for E2E tests in Wave 14: they exercise full agent workflows (spawn → message → wait → close) but the model is stubbed to follow a scripted decision tree. Real LLM tests are out-of-scope for this campaign and don't gate any wave.

If you find yourself reaching for `process.env.OPENAI_API_KEY` in a perf or E2E test, stop. Use the stub.

## Bench harness

Use the harness created in Wave 0 at `packages/opencode/test/lib/perf.ts`. Shape:

```ts
import { bench, baselineDelta } from "@opencode/test/lib/perf"

await bench("session.render.tool_part", { samples: 1000, warmup: 100 }, async () => {
  // op under measurement
})

const report = baselineDelta(".wave/campaigns/.../artifacts/baseline-perf.json")
expect(report.regressions).toEqual([])  // fails wave if any
```

The harness uses `Bun.nanoseconds()` for timing (sub-microsecond precision), warms up, runs samples, computes percentiles. No fancy stats library.

## What counts as a hot path touch

You touch a hot path if your wave:
- Adds a memo or signal in `tui/routes/session/index.tsx`
- Adds work inside `runLoop` between `slog.info("loop")` and `step++` (any per-iteration cost)
- Adds work inside `processor.ts handleEvent` (per-chunk cost)
- Changes anything in `pty/index.ts` `proc.onData` callback
- Adds a `Permission.ask` call site that executes per turn
- Adds a `EventV2.run` or `Bus.publish` call site that executes per chunk

If you're unsure: bench it. Cost of a bench you didn't need is small. Cost of a regression you missed is real.

## TUI render measurement

The TUI is harder to bench than backend code (Solid.js + opentui has render cycles tied to terminal frame rate). The harness includes a `renderBench` helper that:

1. Spins up a headless renderer
2. Mounts a fake `<Session>` route with synthetic `sync.data`
3. Drives N synthetic streaming chunks through the message store
4. Measures wall time from first chunk push to render quiescence

Wave 11's verification asserts that with N=4 concurrent siblings, render time per chunk is ≤ 1.5× the single-session baseline. This is generous because we expect SOME overhead from concurrent updaters; we don't accept catastrophic blow-up.

## Concurrent-session perf invariant

Multi-agent v2 means N runLoops run concurrently in one instance. The invariants:

- 4 sibling sessions running in parallel: total CPU ≤ 1.6× single-session (40% acceptable overhead from coordination)
- Per-sibling LLM stream latency: same as single-session (no shared bottleneck on LLM service or HTTP client)
- Mailbox seq-watch wakeup latency: ≤ 5ms p99 from `send` to `wait_agent` resume

These get measured in Wave 14 (e2e + final perf audit).

## Memory budget

- 64 PTYs × 1 MiB head/tail buffer = 64 MiB max for unified_exec — hard cap, enforced by `MAX_UNIFIED_EXEC_PROCESSES`
- 16 concurrent agents × ~10 MiB session state each = 160 MiB max for multi-agent — soft, depends on session size
- Mailbox: unbounded queue, but messages are short text strings; expect <1 KiB each, watch for runaway growth in tests

If a test or bench exceeds 200 MiB resident set size, fail the wave.
