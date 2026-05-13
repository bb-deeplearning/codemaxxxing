# Wave 0 — Test infrastructure + perf baseline

**Prior waves:** none.
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `PERF.md`.

## Goal

Establish the test and performance measurement infrastructure that every subsequent wave depends on. Capture baseline numbers for hot paths so later waves can detect regressions.

## Tasks

This wave is foundational; all tasks run sequentially in this single session.

### 1. Create the perf measurement harness

File: `packages/opencode/test/lib/perf.ts`

Implement these exports:

```ts
// Run a closure N times with warmup, return percentile timings in nanoseconds.
export interface BenchOptions {
  samples: number     // default 1000
  warmup: number      // default 100 (excluded from stats)
  label: string
}

export interface BenchResult {
  label: string
  samples: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
}

export const bench: (opts: BenchOptions, fn: () => Promise<void> | void) => Promise<BenchResult>

// Compare a current bench result against a baseline metric.
// Returns regression info; throws if outside budget.
export interface RegressionBudget {
  p50_max_pct: number  // 5
  p95_max_pct: number  // 10
  p99_max_pct: number  // 15
}

export const DEFAULT_BUDGET: RegressionBudget

export interface RegressionReport {
  metric: string
  baseline: BenchResult
  current: BenchResult
  delta_p50_pct: number
  delta_p95_pct: number
  delta_p99_pct: number
  passed: boolean
  reasons: string[]   // empty when passed
}

export const compareToBaseline: (
  current: BenchResult,
  baselinePath: string,
  metric: string,
  budget?: RegressionBudget,
) => RegressionReport

// Persist a set of bench results to a JSON file (idempotent — overwrites).
export const writeBenchReport: (
  results: BenchResult[],
  outPath: string,
) => Promise<void>
```

Implementation notes:
- Use `Bun.nanoseconds()` for timing
- Warmup runs are discarded
- Sort samples ascending, compute percentiles by index
- Throw `BenchBudgetExceededError` (Effect TaggedErrorClass) on regression
- File I/O via `Bun.file().json()` and `Bun.write()`

Tests for the harness itself live at `packages/opencode/test/lib/perf.test.ts`. Cover: percentile correctness on known data, regression detection on synthetic baseline, file roundtrip.

### 1b. Create the LLM stub helper

File: `packages/opencode/test/lib/stub-provider.ts`

**Existing infrastructure to evaluate first:** `packages/opencode/test/lib/llm-server.ts` (771 lines) is an HTTP+SSE-based LLM mock already in the repo. It intercepts at the HTTP layer rather than swapping `Provider.Service`. Read it before deciding whether to (a) build the Layer-based `stubProvider` below as a sibling for tests that prefer Effect-native injection, (b) extend `llm-server.ts` with a thinner Effect wrapper, or (c) build (a) on top of (b). Pick deliberately and note the choice in the wave commit. The constraint that matters is "no real LLM calls in any perf or E2E test" — the mechanism is up to you.

Implement (assuming option (a)):

```ts
// Returns a Provider.Service implementation that completes immediately with
// a configurable scripted response. NEVER calls fetch or any network.
export interface StubScript {
  // Per-call: what events to emit. Default: a single `finish-step` then `finish`.
  events?: ReadonlyArray<LLM.Event>
  // Per-call: how many milliseconds to "take" (default 0)
  latencyMs?: number
}

export const stubProvider: (script?: StubScript) => Layer.Layer<Provider.Service>

// Asserts that no `fetch` calls were made during the bench. Throws if any
// real network attempt happened (sets up a fetch interceptor, restores in
// afterAll).
export const assertNoNetworkCalls: () => Effect.Effect<void>
```

The stub is what every perf bench (and Wave 14's E2E tests) uses to avoid real LLM calls. **No perf or E2E test in this campaign may make a real LLM call** — this is enforced by `assertNoNetworkCalls()` checks in the bench harness's setup.

Tests for the stub: `packages/opencode/test/lib/stub-provider.test.ts`. Cover: scripted events emitted in order, no fetch made, latency respected.

### 2. Capture baseline benchmarks

Create one bench file per hot path under `packages/opencode/test/perf/baseline/`:

| File | Measures |
|---|---|
| `pty-throughput.bench.ts` | `Pty.create` then push 100 4KiB chunks via simulated `proc.onData`; measure end-to-end time |
| `session-render.bench.ts` | Mount synthetic session route via `testRender` from `@opentui/solid` (documented headless renderer; existing pattern at `packages/opencode/test/cli/tui/slot-replace.test.tsx:44`). Drive N=100 streaming text-delta events into the message store. Measure first-paint and steady-state per-chunk render time. Use `renderer.idle()` to wait for quiescence between iterations; if the component has infinite animations (spinners), use `renderOnce()` instead. Add the JSX pragma at file top: `/** @jsxImportSource @opentui/solid */` |
| `runloop-overhead.bench.ts` | Use `stubProvider({ events: [{type:"finish-step", ...}, {type:"finish"}] })`. Measure `SessionPrompt.runLoop` per-step overhead with no work. Asserts `assertNoNetworkCalls()` at end. |
| `permission-latency.bench.ts` | `Permission.ask` resolution latency for cached (always-allow) and uncached (ask-then-deny) paths |
| `eventv2-throughput.bench.ts` | `EventV2.run` for `SessionEvent.Text.Delta` x 1000 |
| `bus-publish.bench.ts` | `Bus.publish` for a fixture event x 1000 with no subscribers, then with one subscriber |
| `snapshot-track.bench.ts` | `Snapshot.track` and `Snapshot.patch` cycle on a small worktree |

Each bench writes its result into a single combined JSON: `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`

Schema (matches `PERF.md`):

```json
{
  "captured_at": "<ISO8601>",
  "git_sha": "<short SHA>",
  "node_version": "<bun --version>",
  "metrics": {
    "pty.push.4kb": { ... BenchResult ... },
    "session.render.steady": { ... },
    "session.render.first_paint": { ... },
    "runloop.step.no_op": { ... },
    "permission.ask.cached": { ... },
    "permission.ask.uncached": { ... },
    "eventv2.run.text_delta": { ... },
    "bus.publish.no_subscribers": { ... },
    "bus.publish.one_subscriber": { ... },
    "snapshot.track": { ... },
    "snapshot.patch": { ... }
  }
}
```

Run all baseline benches via a single test target: `bun test packages/opencode/test/perf/baseline/`. Each `*.bench.ts` is a `bun:test` file that uses `bench()` and writes its slice into the combined JSON (use a coordinator helper if needed; serial execution is fine).

### 3. Document test patterns for the campaign

File: `packages/opencode/test/lib/CAMPAIGN_TESTING.md` — short markdown with:
- "Use `testEffect` for Effect services. Example: `<paste an existing usage>`"
- "Use `it.live(...)` for live filesystem / child process / sockets. Example: `<paste an existing usage>`"
- "Bench file template" — minimal example for a `*.bench.ts` file
- "Coverage check" — exact command to verify 100% on a file

Look at `packages/opencode/test/lib/effect.ts` for existing testEffect; if it doesn't exist yet, locate similar patterns via grep on `testEffect` in `packages/opencode/test/`.

### 4. Wire bench files into the test runner

Verify `bun test packages/opencode/test/perf/baseline/` discovers and runs every bench file. If `bun:test` doesn't auto-discover `.bench.ts`, rename to `*.bench.test.ts` or add an explicit suite that imports each.

## Gotchas

1. **Bench determinism.** Real perf numbers are noisy. Take the bench results as soft baselines — actual regression budget is 5%/10%/15% (p50/p95/p99) which already accounts for noise. Don't try to make benches deterministic by mocking everything; that defeats the purpose.

2. **Snapshot bench requires a real worktree.** Use `os.tmpdir()` + a fresh git init for the snapshot bench. Clean up in `afterAll`.

3. **Provider stub for runloop bench.** Stub the model provider via `stubProvider()` (built in step 1b) — returns a `finish` event immediately, no real LLM call. The stub is acceptable here because it's a perf bench, not a behavior test. **Real LLM calls are forbidden in any perf or E2E test in this campaign — see `PERF.md` § "No live LLM calls in perf — ever".** Every bench file calls `assertNoNetworkCalls()` at the end as a guard.

4. **TUI bench is REQUIRED.** opentui's headless render path is `testRender` from `@opentui/solid` (documented; existing usage at `packages/opencode/test/cli/tui/slot-replace.test.tsx:44`). The pattern:

   ```ts
   /** @jsxImportSource @opentui/solid */
   import { testRender } from "@opentui/solid"

   const { renderer, renderOnce, captureCharFrame } = await testRender(
     () => <ComponentUnderTest />,
     { width: 100, height: 40 },
   )
   const start = Bun.nanoseconds()
   stateChange()
   await renderer.idle()           // waits for animation/render quiescence
   // OR: await renderOnce()       // forces exactly one frame cycle (use if infinite spinners)
   const elapsed = Bun.nanoseconds() - start
   ```

   Sharp edges to know:
   - `renderer.idle()` hangs forever if the component mounts an infinite spinner (existing TUI does this in some cases). Prefer `renderOnce()` for those benches.
   - The JSX pragma is required or you'll get standard DOM JSX, not opentui JSX, and the test silently renders nothing.
   - Palette/TTY queries bypass real ioctls in test mode — falls back to static test values; OK for benches.

   Document the harness pattern in `CAMPAIGN_TESTING.md` so Wave 4 + Wave 11 can use the same approach without re-discovering it.

5. **`bun:test` lacks built-in benchmark support.** Use plain `it("baseline: pty.push.4kb", async () => { ... })` and call `bench()` from your harness inside it. Assertions inside the test verify the bench actually ran (sample count > 0) and persist the result.

6. **Git SHA capture.** Use `Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])`. Don't hardcode; this file is reproducible.

7. **Bench file warmup.** First few runs of any operation are slower (JIT, cache warmup). Default warmup=100 should handle most cases; if a bench is wildly variable in p50, bump warmup to 500 for that bench.

## Verification

```bash
cd packages/opencode

# typecheck + lint
bun typecheck
bun lint

# the harness self-tests
bun test test/lib/perf.test.ts
bun test --coverage test/lib/perf.ts        # 100% on the harness itself

# baseline benches run and produce the JSON
bun test test/perf/baseline/

# the JSON exists and is valid
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json
bun -e "console.log(JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json').text()).metrics)"
```

All four steps must exit 0. The final `bun -e` should print the metrics object — if `undefined`, the JSON write failed silently.

## Files

New:
- `packages/opencode/test/lib/perf.ts`
- `packages/opencode/test/lib/perf.test.ts`
- `packages/opencode/test/lib/stub-provider.ts`
- `packages/opencode/test/lib/stub-provider.test.ts`
- `packages/opencode/test/lib/CAMPAIGN_TESTING.md`
- `packages/opencode/test/perf/baseline/pty-throughput.bench.ts`
- `packages/opencode/test/perf/baseline/session-render.bench.ts`
- `packages/opencode/test/perf/baseline/runloop-overhead.bench.ts`
- `packages/opencode/test/perf/baseline/permission-latency.bench.ts`
- `packages/opencode/test/perf/baseline/eventv2-throughput.bench.ts`
- `packages/opencode/test/perf/baseline/bus-publish.bench.ts`
- `packages/opencode/test/perf/baseline/snapshot-track.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` (committed)

Modified: none.
