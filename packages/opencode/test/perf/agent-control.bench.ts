import * as fs from "node:fs/promises"
import * as path from "node:path"
import { afterAll, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AgentControl } from "../../src/agent/control"
import { AgentPath } from "../../src/agent/agent-path"
import { Agent } from "../../src/agent/agent"
import { InterAgentCommunication } from "../../src/agent/inter-agent-communication"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { type BenchResult } from "../lib/perf"

// Wave 7 perf bench. Three metrics, all measured against the new AgentControl
// service. No wave_0 baseline applies (AgentControl is brand-new); the bench
// records actual numbers for future regression checks. Each metric is
// captured inside a single tmpdir instance (one Session.Service / SQLite db
// per metric) so the per-iteration cost is dominated by the AgentControl
// operation rather than instance setup.

const allResults: Record<string, BenchResult> = {}

const wavePerfFile = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "codex-parity-hardening-2026-05-14",
  "artifacts",
  "perf",
  "wave_1.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const layer = Layer.mergeAll(
  AgentControl.defaultLayer,
  Agent.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
)

const ROOT = AgentPath.root()

const percentile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]

const summarize = (label: string, samples: number[]): BenchResult => {
  samples.sort((a, b) => a - b)
  let sum = 0
  for (const s of samples) sum += s
  return {
    label,
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    min: samples[0],
    max: samples[samples.length - 1],
    mean: sum / samples.length,
  }
}

const runWithInstance = <A, E, R>(self: Effect.Effect<A, E, R>) => {
  const runtime = ManagedRuntime.make(layer)
  return runtime
    .runPromise(
      Effect.scoped(provideTmpdirInstance(() => self)) as Effect.Effect<A, E, never>,
    )
    .finally(() => runtime.dispose())
}

test("bench: agentControl.spawnAgent", async () => {
  const samples: number[] = []
  await runWithInstance(
    Effect.gen(function* () {
      const control = yield* AgentControl.Service
      const sessions = yield* Session.Service
      // Stub run loop so each spawn returns immediately and the bench measures
      // only the AgentControl mechanics (path/nickname reservation, mailbox
      // setup, registry commit, fiber fork) — not real model work.
      yield* control.registerRunLoop(() => Effect.never)
      const root = yield* sessions.create({ title: "root" })
      yield* control.registerSessionRoot(root.id)

      // Warmup
      for (let i = 0; i < 30; i++) {
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: `w${i}`,
          initial_message: ".",
        })
      }
      // Measured
      for (let i = 0; i < 200; i++) {
        const t0 = Bun.nanoseconds()
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: `s${i}`,
          initial_message: ".",
        })
        samples.push(Bun.nanoseconds() - t0)
      }
    }),
  )
  const result = summarize("agentControl.spawnAgent", samples)
  allResults[result.label] = result
  expect(result.samples).toBe(200)
})

test("bench: agentControl.sendInterAgentCommunication", async () => {
  const samples: number[] = []
  await runWithInstance(
    Effect.gen(function* () {
      const control = yield* AgentControl.Service
      const sessions = yield* Session.Service
      yield* control.registerRunLoop(() => Effect.never)
      const root = yield* sessions.create({ title: "root" })
      yield* control.registerSessionRoot(root.id)
      const target = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: ROOT,
        task_name: "tgt",
        initial_message: ".",
      })
      const recipient = target.metadata.agent_path ?? ROOT

      const comm = (i: number) =>
        new InterAgentCommunication({
          author: ROOT,
          recipient,
          content: `m${i}`,
          trigger_turn: i % 2 === 0,
          sent_at: i,
        })

      // Warmup
      for (let i = 0; i < 50; i++) yield* control.sendInterAgentCommunication(target.thread_id, comm(i), root.id)
      // Drain to keep the mailbox bounded.
      yield* control.drainMailbox(target.thread_id)

      for (let i = 0; i < 1000; i++) {
        const t0 = Bun.nanoseconds()
        yield* control.sendInterAgentCommunication(target.thread_id, comm(i), root.id)
        samples.push(Bun.nanoseconds() - t0)
        if (i % 100 === 99) yield* control.drainMailbox(target.thread_id)
      }
    }),
  )
  const result = summarize("agentControl.sendInterAgentCommunication", samples)
  allResults[result.label] = result
  expect(result.samples).toBe(1000)
})

test("bench: agentControl.listAgents.populated", async () => {
  const samples: number[] = []
  await runWithInstance(
    Effect.gen(function* () {
      const control = yield* AgentControl.Service
      const sessions = yield* Session.Service
      yield* control.registerRunLoop(() => Effect.never)
      const root = yield* sessions.create({ title: "root" })
      yield* control.registerSessionRoot(root.id)
      // Populate 16 live agents under root.
      for (let i = 0; i < 16; i++) {
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: `a${i}`,
          initial_message: ".",
        })
      }

      // Warmup
      for (let i = 0; i < 50; i++) yield* control.listAgents(ROOT, root.id)
      // Measured
      for (let i = 0; i < 1000; i++) {
        const t0 = Bun.nanoseconds()
        const out = yield* control.listAgents(ROOT, root.id)
        samples.push(Bun.nanoseconds() - t0)
        // Sanity check on the first few iterations to ensure the populated
        // tree wasn't truncated.
        if (i < 3 && out.length !== 17) {
          throw new Error(`expected 17 (root + 16), got ${out.length}`)
        }
      }
    }),
  )
  const result = summarize("agentControl.listAgents.populated", samples)
  allResults[result.label] = result
  expect(result.samples).toBe(1000)
})

afterAll(async () => {
  if (Object.keys(allResults).length === 0) return
  await fs.mkdir(path.dirname(wavePerfFile), { recursive: true })
  const payload = {
    captured_at: new Date().toISOString(),
    git_sha: gitSha(),
    bun_version: Bun.version,
    metrics: allResults,
  }
  await Bun.write(wavePerfFile, JSON.stringify(payload, null, 2))
})
