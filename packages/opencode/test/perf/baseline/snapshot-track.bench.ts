import { Effect } from "effect"
import { Snapshot } from "@/snapshot"
import { benchEffect, type BenchResult } from "../../lib/perf"

// Wave 0 baseline: cost of `Snapshot.track` (initial git plumbing) and
// `Snapshot.patch` (diff against a prior snapshot). Real Snapshot.Service in
// a tmpdir-with-git instance. Sample count kept low because each track call
// shells out to git; budget checks elsewhere control the regression bound.

export const benchSnapshotTrack = (): Effect.Effect<Record<string, BenchResult>, never, Snapshot.Service> =>
  Effect.gen(function* () {
    const snap = yield* Snapshot.Service
    yield* snap.init()

    // initial baseline hash to diff against
    const baseHash = yield* snap.track()

    const trackResult = yield* benchEffect(
      { samples: 30, warmup: 3, label: "snapshot.track" },
      () => Effect.asVoid(snap.track()),
    )

    const patchHash = baseHash ?? ""
    const patchResult = yield* benchEffect(
      { samples: 30, warmup: 3, label: "snapshot.patch" },
      () => Effect.asVoid(snap.patch(patchHash)),
    )

    return {
      "snapshot.track": trackResult,
      "snapshot.patch": patchResult,
    }
  })
