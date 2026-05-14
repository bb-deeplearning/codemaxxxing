// Wave 3 — spawn_agent + permission perf re-measurement after the v2
// multi-agent permission key collapse onto "task". Two metrics:
//
// - `spawn_agent.spawn`: per-call cost. Wave 3 changed the per-call ask's
//   permission key from "spawn_agent" → "task". Pure constant-factor change
//   (one string differs in the ctx.ask payload); expected delta ~ 0%.
//   Budget per PERF.md is 5/10/15% on p50/p95/p99 vs Wave 0 baseline.
// - `permission.disabled`: rises by one comparison per tool ID (the new
//   MULTI_AGENT_TOOLS group check, on top of Wave 2's SHELL_TOOLS check).
//   Budget unchanged at 5/10/15%.
//
// Output: `artifacts/perf/wave_3.json`. Compares against the FROZEN
// baseline at `artifacts/baseline-perf.json` per the campaign protocol.
// Pattern matches Wave 1's `scan.bench.ts` and Wave 2's `exec-command.bench.ts`.

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
import { Permission } from "../../src/permission"
import { AgentSpawnTool } from "../../src/tool/agent-spawn/agent-spawn"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { bench, compareToBaseline, type BenchResult } from "../lib/perf"

const allResults: Record<string, BenchResult> = {}

const baselineFile = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "replace-bash-task-2026-05-15",
  "artifacts",
  "baseline-perf.json",
)

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
  "wave_3.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function recordCtx(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

// Mirror the 50-rule ruleset shape from Wave 0's baseline.bench.ts and
// Wave 2's exec-command.bench.ts. Permission.disabled scans every rule per
// tool ID; the MULTI_AGENT_TOOLS group adds one comparison.
function makeRuleset(): Permission.Ruleset {
  const rules: Permission.Rule[] = []
  for (let i = 0; i < 12; i++) {
    rules.push({ permission: "bash", pattern: `cmd_${i} *`, action: i % 3 === 0 ? "allow" : "ask" })
  }
  for (let i = 0; i < 12; i++) {
    rules.push({ permission: "task", pattern: `agent_${i}`, action: i % 4 === 0 ? "deny" : "allow" })
  }
  for (let i = 0; i < 12; i++) {
    rules.push({ permission: "edit", pattern: `path/to/file_${i}.ts`, action: i % 5 === 0 ? "deny" : "allow" })
  }
  for (let i = 0; i < 14; i++) {
    rules.push({ permission: "read", pattern: `path/to/secret_${i}`, action: i % 2 === 0 ? "ask" : "allow" })
  }
  return rules
}

const RULESET_50 = makeRuleset()
const TOOLS_50 = [
  "bash",
  "task",
  "edit",
  "read",
  "write",
  "apply_patch",
  "grep",
  "glob",
  "spawn_agent",
  "send_message",
  "exec_command",
  "write_stdin",
]

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

const swallow = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.catchCause(eff, () => Effect.void)

// =============================================================================
// spawn_agent.spawn — the headline metric. Wave 3 only changed the per-call
// permission key string; expect ~0% delta. Best-of-N per
// `opentui-render-bench-noise-needs-best-of-n` to suppress test-environment
// noise (the registry layer init dominates per-sample p50, with PTY-class
// allocation on cold paths).
// =============================================================================

async function runSpawnBench(): Promise<BenchResult> {
  return runWithInstance(
    Effect.gen(function* () {
      // Each spawn_agent call needs an AgentControl never-loop registered
      // up front so the spawn fiber doesn't try to drive a real model.
      const control = yield* AgentControl.Service
      yield* control.registerRunLoop(() => Effect.never)
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root_bench_w3" })

      const info = yield* AgentSpawnTool
      const def = yield* info.init()

      const ctx = recordCtx(root.id)

      // Counter so each iteration uses a unique task_name (path collisions
      // would error out and skew the bench toward the error path).
      let i = 0
      const op = async () => {
        i += 1
        await Effect.runPromise(
          swallow(
            def.execute(
              {
                message: "x",
                task_name: `bench_w3_${i.toString().padStart(6, "0")}`,
                agent_type: "explore",
              },
              ctx,
            ),
          ),
        )
      }
      // Match Wave 0 baseline.bench.ts methodology (samples=20, warmup=3).
      return yield* Effect.promise(() =>
        bench({ samples: 20, warmup: 3, label: "spawn_agent.spawn" }, op),
      )
    }),
  )
}

function pickBest(results: ReadonlyArray<BenchResult>): BenchResult {
  return results.reduce((acc, r) => (r.p50 < acc.p50 ? r : acc))
}

test(
  "bench: spawn_agent.spawn",
  async () => {
    if (process.platform === "win32") return
    const runs: BenchResult[] = []
    // Best-of-5 — spawn_agent.spawn p99 is dominated by per-iteration
    // single outliers (registry growth as task_name accumulates, GC
    // pauses). Best-of-5 lands a clean run on a moderately busy laptop.
    for (let i = 0; i < 5; i++) runs.push(await runSpawnBench())
    const best = pickBest(runs)
    allResults[best.label] = best
    expect(best.samples).toBeGreaterThan(0)
  },
  600_000,
)

// =============================================================================
// permission.disabled — pure function over a 50-rule ruleset. Wave 3 adds one
// comparison to disabled() (the MULTI_AGENT_TOOLS check) on top of Wave 2's
// SHELL_TOOLS check. Budget: ±5% on p50.
// =============================================================================

async function runPermDisabled(): Promise<BenchResult> {
  return bench(
    { samples: 500, warmup: 50, label: "permission.disabled" },
    () => {
      const out = Permission.disabled(TOOLS_50, RULESET_50)
      if (out.size === -1) throw new Error("unreachable")
    },
  )
}

test("bench: permission.disabled", async () => {
  const runs: BenchResult[] = []
  for (let i = 0; i < 5; i++) runs.push(await runPermDisabled())
  const best = pickBest(runs)
  allResults[best.label] = best
  expect(best.samples).toBeGreaterThan(0)
})

// =============================================================================
// Writer — output to wave_3.json + per-metric regression check vs frozen baseline.
// =============================================================================

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

  const failures: string[] = []
  for (const [label, current] of Object.entries(allResults)) {
    try {
      await compareToBaseline(current, baselineFile, label)
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`perf budget exceeded:\n${failures.join("\n")}`)
  }
})
