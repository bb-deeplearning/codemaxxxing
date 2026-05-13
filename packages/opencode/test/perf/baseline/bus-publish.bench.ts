import { Effect, Schema, Scope, Stream } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { benchEffect, type BenchResult } from "../../lib/perf"

// Wave 0 baseline: cost of `Bus.publish` on a hot path. Two flavors —
// no subscribers (typed pubsub doesn't yet exist) and one wildcard subscriber
// (the path the TUI takes). Real Bus.Service in a tmpdir instance.

const BenchEvent = BusEvent.define(
  "bench.bus.tick",
  Schema.Struct({ seq: Schema.Number }),
)

export const benchBusPublish = (): Effect.Effect<
  Record<string, BenchResult>,
  never,
  Bus.Service | Scope.Scope
> =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const noSubs = yield* benchEffect(
      { samples: 500, warmup: 50, label: "bus.publish.no_subscribers" },
      () => bus.publish(BenchEvent, { seq: 0 }),
    )

    // attach one wildcard subscriber for the second metric
    let received = 0
    yield* Stream.runForEach(bus.subscribeAll(), () =>
      Effect.sync(() => {
        received++
      }),
    ).pipe(Effect.forkScoped)
    // small yield so the subscription is wired before publishing
    yield* Effect.sleep("10 millis")

    const startReceived = received
    const oneSub = yield* benchEffect(
      { samples: 500, warmup: 50, label: "bus.publish.one_subscriber" },
      () => bus.publish(BenchEvent, { seq: 1 }),
    )
    // assert the subscriber actually got fed (avoids false-positive 'no overhead' if path was elided)
    if (received <= startReceived) {
      yield* Effect.die(new Error("bus.publish.one_subscriber bench: no subscriber events received"))
    }

    return {
      "bus.publish.no_subscribers": noSubs,
      "bus.publish.one_subscriber": oneSub,
    }
  })
