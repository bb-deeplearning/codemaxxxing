// Wave 1 — scan extract perf re-measurement. Pure refactor: every `scan.*`
// metric should be within ±2% of the Wave 0 baseline. Writes to
// `artifacts/perf/wave_1.json` (trend tracking) and compares against
// `artifacts/baseline-perf.json` (frozen). Does NOT overwrite the baseline.
//
// Pattern: embedded `test()` + `afterAll` writer (per GOTCHA
// `bench-file-pattern-split`). Run via:
//   bun test ./test/perf/scan.bench.ts

import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { AgentControl } from "../../src/agent/control"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session/session"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { ShellTool } from "../../src/tool/shell"
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
  "wave_1.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const SENTINEL = new Error("scan-bench: stop after first ctx.ask")

function captureCtx(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () =>
      Effect.sync(() => {
        throw SENTINEL
      }),
  }
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

const benchLayer = Layer.mergeAll(
  AgentControl.defaultLayer,
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Plugin.defaultLayer,
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

const SHORT_CMD = "git status"
const PIPE_CMD = "git status | grep foo"
const CHAIN_CMD = "npm test && npm run build"
const LONG_CMD = "echo " + "a".repeat(190)

const swallow = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.catchCause(eff, () => Effect.void)

const toolDef = (toolID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const tools = yield* registry.tools({ ...STUB_MODEL, agent: build })
    const found = tools.find((t) => t.id === toolID)
    if (found) return found
    // Wave 4 dropped `bash` (and `task`) from the registry's model-facing
    // builtin array. ShellTool stays internally importable per the
    // `legacy-shell-tool-still-runnable-from-internal-code` invariant — yield
    // it directly so this Wave 1 bench keeps measuring the legacy path.
    // Methodology delta vs the wave_1.json snapshot: skips the registry's
    // Plugin.trigger("tool.definition") wrapper. Same execute fn underneath.
    if (toolID === "bash") {
      const shell = yield* ShellTool
      return yield* shell.init()
    }
    throw new Error(`tool ${toolID} not present`)
  })

const benchShellScan = (label: string, cmd: string, samples: number) =>
  Effect.gen(function* () {
    const def = yield* toolDef("bash")
    const ctx = captureCtx(SessionID.make("ses_bench"))
    const op = async () => {
      await Effect.runPromise(swallow(def.execute({ command: cmd, description: "scan bench" }, ctx)))
    }
    return yield* Effect.promise(() => bench({ samples, warmup: 50, label }, op))
  })

test(
  "bench: scan.cmd_short",
  async () => {
    const result = await runWithInstance(benchShellScan("scan.cmd_short", SHORT_CMD, 500))
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

test(
  "bench: scan.cmd_pipe",
  async () => {
    const result = await runWithInstance(benchShellScan("scan.cmd_pipe", PIPE_CMD, 500))
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

test(
  "bench: scan.cmd_chain",
  async () => {
    const result = await runWithInstance(benchShellScan("scan.cmd_chain", CHAIN_CMD, 500))
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

test(
  "bench: scan.cmd_long",
  async () => {
    const result = await runWithInstance(benchShellScan("scan.cmd_long", LONG_CMD, 500))
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

const NOOP_CMD = `${process.execPath} -e "process.exit(0)"`

test(
  "bench: shell.exec",
  async () => {
    const result = await runWithInstance(
      Effect.gen(function* () {
        const def = yield* toolDef("bash")
        const ctx = recordCtx(SessionID.make("ses_bench"))
        const op = async () => {
          await Effect.runPromise(swallow(def.execute({ command: NOOP_CMD, description: "noop" }, ctx)))
        }
        return yield* Effect.promise(() => bench({ samples: 20, warmup: 3, label: "shell.exec" }, op))
      }),
    )
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  180_000,
)

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

  // Per-metric regression check vs frozen baseline. Pure refactor — expect
  // ±2%; the harness's default budget is 5/10/15. If a metric regresses
  // beyond 5/10/15, the wave fails. Document any 2-5% drift in NOTES.md.
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
