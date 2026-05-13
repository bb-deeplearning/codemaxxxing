import { afterAll, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { Bus } from "@/bus"
import { Permission } from "@/permission"
import { Snapshot } from "@/snapshot"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../../lib/effect"
import type { BenchResult } from "../../lib/perf"
import { benchBusPublish } from "./bus-publish.bench"
import { benchEventV2Throughput } from "./eventv2-throughput.bench"
import { benchPermissionLatency } from "./permission-latency.bench"
import { benchPtyThroughput } from "./pty-throughput.bench"
import { benchRunloopOverhead } from "./runloop-overhead.bench"
import { benchSessionRender } from "./session-render.bench"
import { benchSnapshotTrack } from "./snapshot-track.bench"

// Wave 0 perf baseline orchestrator. Each bench file exports a function or
// Effect that returns `Record<string, BenchResult>`. We aggregate everything
// here, then write the combined JSON in `afterAll`. Future waves compare
// their changes against the resulting `baseline-perf.json` via
// `compareToBaseline` from the perf harness.

const baselineLayer = Layer.mergeAll(
  Bus.layer,
  Permission.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(baselineLayer)
const allResults: Record<string, BenchResult> = {}

const baselineFile = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "codex-parity-2026-05-13",
  "artifacts",
  "baseline-perf.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

test("baseline: pty.push.4kb", async () => {
  const out = await benchPtyThroughput()
  Object.assign(allResults, out)
  expect(out["pty.push.4kb"].samples).toBeGreaterThan(0)
})

test("baseline: runloop.step.no_op", async () => {
  const out = await benchRunloopOverhead()
  Object.assign(allResults, out)
  expect(out["runloop.step.no_op"].samples).toBeGreaterThan(0)
})

test("baseline: session.render.first_paint + steady", async () => {
  const out = await benchSessionRender()
  Object.assign(allResults, out)
  expect(out["session.render.first_paint"].samples).toBeGreaterThan(0)
  expect(out["session.render.steady"].samples).toBeGreaterThan(0)
})

it.instance("baseline: eventv2.run.text_delta", () =>
  Effect.gen(function* () {
    const out = yield* benchEventV2Throughput()
    Object.assign(allResults, out)
    expect(out["eventv2.run.text_delta"].samples).toBeGreaterThan(0)
  }),
)

it.instance("baseline: bus.publish", () =>
  Effect.gen(function* () {
    const out = yield* benchBusPublish()
    Object.assign(allResults, out)
    expect(out["bus.publish.no_subscribers"].samples).toBeGreaterThan(0)
    expect(out["bus.publish.one_subscriber"].samples).toBeGreaterThan(0)
  }),
)

it.instance("baseline: permission.ask", () =>
  Effect.gen(function* () {
    const out = yield* benchPermissionLatency()
    Object.assign(allResults, out)
    expect(out["permission.ask.cached"].samples).toBeGreaterThan(0)
    expect(out["permission.ask.uncached"].samples).toBeGreaterThan(0)
  }),
)

it.instance(
  "baseline: snapshot.track + patch",
  () =>
    Effect.gen(function* () {
      const out = yield* benchSnapshotTrack()
      Object.assign(allResults, out)
      expect(out["snapshot.track"].samples).toBeGreaterThan(0)
      expect(out["snapshot.patch"].samples).toBeGreaterThan(0)
    }),
  { git: true },
)

afterAll(async () => {
  if (Object.keys(allResults).length === 0) return
  await fs.mkdir(path.dirname(baselineFile), { recursive: true })
  const payload = {
    captured_at: new Date().toISOString(),
    git_sha: gitSha(),
    bun_version: Bun.version,
    metrics: allResults,
  }
  await Bun.write(baselineFile, JSON.stringify(payload, null, 2))
})
