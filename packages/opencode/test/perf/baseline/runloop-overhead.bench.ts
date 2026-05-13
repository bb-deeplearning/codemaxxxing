import { Effect, Stream } from "effect"
import { LLM } from "@/session/llm"
import { bench, type BenchResult } from "../../lib/perf"
import { assertNoNetworkCalls, installNoNetworkGuard, stubProvider } from "../../lib/stub-provider"

// Wave 0 baseline: per-step LLM stream-consumption overhead with a stub
// provider. Approximates the per-iteration cost of `SessionPrompt.runLoop`
// outside the model call. Wave 9 (runLoop integration) compares against this.
//
// Real session/prompt setup is too heavy for a 200-sample bench (every step
// does git snapshot, message persistence, etc. — see prompt.ts:1423-1652).
// This bench measures the LLM service yield + Stream.runDrain cost, which is
// the consumption-side cost the runLoop pays per step.

const dummyInput: LLM.StreamInput = {
  user: undefined,
  sessionID: "ses_bench_runloop",
  model: { providerID: "test", id: "test-model" },
  agent: { name: "build", mode: "build" },
  system: [],
  messages: [],
  tools: {},
} as unknown as LLM.StreamInput

export const benchRunloopOverhead = async (): Promise<Record<string, BenchResult>> => {
  const guard = installNoNetworkGuard()
  try {
    const layer = stubProvider()
    const result = await bench(
      { samples: 200, warmup: 20, label: "runloop.step.no_op" },
      async () => {
        await Effect.runPromise(
          Effect.gen(function* () {
            const llm = yield* LLM.Service
            yield* Stream.runDrain(llm.stream(dummyInput))
          }).pipe(Effect.provide(layer)),
        )
      },
    )
    await Effect.runPromise(assertNoNetworkCalls())
    return { "runloop.step.no_op": result }
  } finally {
    guard.restore()
  }
}
