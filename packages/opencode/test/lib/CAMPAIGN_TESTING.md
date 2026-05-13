# Campaign Testing — codex-parity

Quick reference for tests added by the codex-parity campaign. Pair with the repo-wide guide at `packages/opencode/test/AGENTS.md`.

## When to use which helper

| Need                                   | Use                                                              |
| -------------------------------------- | ---------------------------------------------------------------- |
| Plain bun:test                         | `import { test } from "bun:test"`                                |
| Effect service under TestClock         | `it.effect(name, () => Effect.gen(...))` from `testEffect(layer)`|
| Real time / git / child process / sock | `it.live(name, () => Effect.gen(...))`                           |
| Single tmpdir instance bound           | `it.instance(name, () => Effect.gen(...), { git?: boolean })`    |
| Multiple instances or custom setup     | `provideTmpdirInstance((dir) => ...)` from `fixture/fixture.ts`  |

```ts
import { Effect } from "effect"
import { Bus } from "@/bus"
import { testEffect } from "../lib/effect"

const it = testEffect(Bus.layer)

it.instance("publishes", () =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.publish(SomeEvent, { ... })
  }),
)
```

## Bench file template

The harness lives at `test/lib/perf.ts`. Two flavors:

- `bench(opts, fn)` — Promise-based, for non-Effect ops
- `benchEffect(opts, eff)` — Effect-native, avoids per-call `Effect.runPromise` cost

Each `*.bench.ts` exports a function (or Effect) that returns `Record<string, BenchResult>`. The orchestrator at `test/perf/baseline/baseline.test.ts` aggregates and writes the combined JSON.

```ts
// test/perf/baseline/example.bench.ts
import { Effect } from "effect"
import { MyService } from "@/my/service"
import { benchEffect, type BenchResult } from "../../lib/perf"

export const benchExample = (): Effect.Effect<Record<string, BenchResult>, never, MyService.Service> =>
  Effect.gen(function* () {
    const svc = yield* MyService.Service
    const result = yield* benchEffect(
      { samples: 500, warmup: 50, label: "my.metric" },
      () => svc.someOp(),
    )
    return { "my.metric": result }
  })
```

```ts
// in baseline.test.ts orchestrator (or per-wave bench test file)
it.instance("baseline: my.metric", () =>
  Effect.gen(function* () {
    Object.assign(allResults, yield* benchExample())
  }),
)
```

## TUI render bench template

Use opentui's documented `testRender` from `@opentui/solid`. Required pragma at file top — without it your JSX silently renders nothing.

```tsx
/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { bench } from "../../lib/perf"

const handle = await testRender(() => <text>{value()}</text>, { width: 100, height: 40 })
await handle.renderOnce()  // forces one frame; required if component has infinite spinners
// ... drive state changes, call renderOnce() between each
handle.renderer.destroy()  // free native resources between iterations
```

Sharp edges:

- `renderer.idle()` may hang if the component mounts an infinite spinner. Prefer `renderOnce()` for benches.
- The `/** @jsxImportSource @opentui/solid */` pragma is required. JSX without it falls through to standard DOM JSX and silently renders nothing.
- Each `testRender` call allocates native resources. Call `handle.renderer.destroy()` between iterations to keep memory bounded.

## LLM stub for perf

Real LLM calls are forbidden in any perf or E2E test in this campaign. Use the layer-based stub at `test/lib/stub-provider.ts`:

```ts
import { stubProvider, installNoNetworkGuard, assertNoNetworkCalls } from "../../lib/stub-provider"

const guard = installNoNetworkGuard()
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* LLM.Service
      yield* Stream.runDrain(llm.stream(input))
    }).pipe(Effect.provide(stubProvider({ events: [...] }))),
  )
  await Effect.runPromise(assertNoNetworkCalls())
} finally {
  guard.restore()
}
```

For tests that need real LLM behavior over HTTP+SSE, use `TestLLMServer` from `test/lib/llm-server.ts` (existing, integration-grade). The two coexist — `stubProvider` for perf and unit tests, `TestLLMServer` for integration and E2E.

## Coverage check

```bash
cd packages/opencode
bun test --coverage path/to/your.test.ts
```

The summary table shows function% and line%. Wave verification asserts 100% line coverage on every file the wave adds or modifies.

If you see `~99%` line coverage with only line 1 missing, swap your imports — `import * as fs from "node:fs/promises"` first, then `import * as path from ...`, then `import { Schema } from "effect"`. Some import orderings cause bun's coverage to mark line 1 as 0-hit even though the import IS evaluated.

## Comparing against the baseline

Wave 0 captures `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`. From any subsequent wave's bench file:

```ts
import { compareToBaseline } from "../../lib/perf"

const current = await bench({ ... })
const report = await compareToBaseline(
  current,
  ".wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json",
  "my.metric",
)
// `compareToBaseline` throws BenchBudgetExceededError on regression.
// Default budget: p50 ≤ +5%, p95 ≤ +10%, p99 ≤ +15%.
```
