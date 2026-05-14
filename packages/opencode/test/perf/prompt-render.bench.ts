// Wave 5 — prompt token count bench. Measures `exec_command` and
// `spawn_agent` rendered description sizes after the prose migration and
// writes the result to `artifacts/perf/wave_5.json`. The integration
// invariant `prompt-token-count-within-budget` consumes that file and
// asserts the budgets per PERF.md § "Prompt token budget".
//
// Token-count proxy: `description.length` — same proxy used by the Wave 0
// baseline (per `artifacts/baseline-perf.json` and `baseline.bench.ts`'s
// `renderMetric` helper). Stay consistent so deltas compare like-for-like.
//
// No microbench wall-time is captured; the whole Wave is prose-only and
// rendering is one function call. The bench's value is the artifact it
// writes for cross-wave trend tracking.
//
// Pattern: embedded `test()` + `afterAll` writer (per GOTCHA
// `bench-file-pattern-split`). Run with the `./` prefix per
// `bun-test-bench-file-path`:
//   bun test ./test/perf/prompt-render.bench.ts

import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { AgentControl } from "../../src/agent/control"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"

interface RenderMetric {
  label: string
  samples: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
  bytes: number
  tokens: number
}

const allResults: Record<string, RenderMetric> = {}

const wavePerfFile = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "replace-bash-task-2026-05-15",
  "artifacts",
  "perf",
  "wave_5.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const benchLayer = Layer.mergeAll(
  AgentControl.defaultLayer,
  Agent.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
)

const runWithInstance = <A, E, R>(self: Effect.Effect<A, E, R>): Promise<A> => {
  const runtime = ManagedRuntime.make(benchLayer)
  return runtime
    .runPromise(Effect.scoped(provideTmpdirInstance(() => self)) as Effect.Effect<A, E, never>)
    .finally(() => runtime.dispose())
}

const renderDescription = (toolID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const tools = yield* registry.tools({ ...STUB_MODEL, agent: build })
    const found = tools.find((t) => t.id === toolID)
    if (!found) throw new Error(`tool ${toolID} not present`)
    return found.description
  })

const renderMetric = (label: string, description: string): RenderMetric => ({
  label,
  samples: 1,
  p50: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  mean: 0,
  bytes: description.length,
  tokens: description.length,
})

test("bench: prompt.render.exec_command", async () => {
  const description = await runWithInstance(renderDescription("exec_command"))
  const metric = renderMetric("prompt.render.exec_command", description)
  allResults[metric.label] = metric
  expect(metric.bytes).toBeGreaterThan(0)
})

test("bench: prompt.render.spawn_agent", async () => {
  const description = await runWithInstance(renderDescription("spawn_agent"))
  const metric = renderMetric("prompt.render.spawn_agent", description)
  allResults[metric.label] = metric
  expect(metric.bytes).toBeGreaterThan(0)
})

afterAll(async () => {
  if (Object.keys(allResults).length === 0) return
  const payload = {
    captured_at: new Date().toISOString(),
    git_sha: gitSha(),
    bun_version: Bun.version,
    metrics: allResults,
  }
  await fs.mkdir(path.dirname(wavePerfFile), { recursive: true })
  await Bun.write(wavePerfFile, JSON.stringify(payload, null, 2))
})
