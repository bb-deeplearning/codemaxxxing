import { Effect } from "effect"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { SessionID } from "@/session/schema"
import * as DateTime from "effect/DateTime"
import { benchEffect, type BenchResult } from "../../lib/perf"

// Wave 0 baseline: cost of `EventV2.run` on the per-chunk text-delta path.
// EventV2.run is a no-op if the experimental flag is off; the test preload
// turns it on (see test/preload.ts). This measures the gated-on overhead
// every text streaming chunk pays.

const sessionID = SessionID.make("ses_bench_eventv2")

export const benchEventV2Throughput = (): Effect.Effect<Record<string, BenchResult>> =>
  Effect.gen(function* () {
    const result = yield* benchEffect(
      { samples: 1000, warmup: 100, label: "eventv2.run.text_delta" },
      () =>
        Effect.sync(() => {
          EventV2.run(SessionEvent.Text.Delta.Sync, {
            sessionID,
            delta: "x",
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }),
    )
    return { "eventv2.run.text_delta": result }
  })
