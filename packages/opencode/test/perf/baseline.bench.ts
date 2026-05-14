// Wave 0 sub-agent C — performance baseline. Captures the 13 metrics listed
// in PERF.md § "Required metrics in baseline" and writes the result to BOTH
// `artifacts/baseline-perf.json` (FROZEN baseline for the campaign) AND
// `artifacts/perf/wave_0.json` (trend-tracking series start point).
//
// Token-count proxy: for `prompt.render.*` metrics the bench reports
// `bytes = description.length` and `tokens = description.length`. Real
// tokenization will land later if a tokenizer wrapper appears in the repo;
// the proxy stays stable across waves.
//
// Pattern: embedded `test()` + `afterAll` writer (per GOTCHA
// `bench-file-pattern-split`). Run with the `./` prefix per
// `bun-test-bench-file-path` GOTCHA:
//   bun test ./test/perf/baseline.bench.ts

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
import { Permission, evaluate } from "../../src/permission"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { bench, type BenchResult } from "../lib/perf"

const allResults: Record<string, BenchResult & { bytes?: number; tokens?: number }> = {}

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
  "wave_0.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const SENTINEL = new Error("baseline-bench: stop after first ctx.ask")

// Ctx whose ask throws the sentinel after recording — short-circuits the
// shell scan so we benchmark the AST parse + scan path WITHOUT actually
// spawning a child process. Same idea as test/tool/shell.test.ts:123.
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

// Ctx that just records (no throw) — used for actual execs.
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

// Build a 50-rule ruleset spanning bash / task / edit / read so
// permission.disabled and permission.evaluate both have realistic input.
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

// Layer for benches that don't need an Instance — just pure registry + agent
// services for permission.disabled / evaluate / registry.tools. The pure
// permission helpers don't need any layer at all, but registry.tools does.
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

// =============================================================================
// scan.* — bash tool's AST scan, captured by short-circuiting before spawn.
// =============================================================================

const SHORT_CMD = "git status"
const PIPE_CMD = "git status | grep foo"
const CHAIN_CMD = "npm test && npm run build"
const LONG_CMD = "echo " + "a".repeat(190) // 200ish chars total

// Swallow both typed errors and defects so the bench loop measures the
// happy-path Effect cost without aborting on the SENTINEL throw. v4 names:
// `Effect.catchCause` covers the error+defect arms in one call.
const swallow = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.catchCause(eff, () => Effect.void)

// Route every Tool resolution through ToolRegistry.tools() so each tool's
// internal Effect (which needs Pty / ChildProcessSpawner / AppFileSystem
// etc.) gets layered through the registry's defaultLayer. Yielding e.g.
// `ShellTool` directly here would leave AppFileSystem.Service unsatisfied
// because benchLayer doesn't provide it at the top level.
const toolDef = (toolID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const tools = yield* registry.tools({ ...STUB_MODEL, agent: build })
    const found = tools.find((t) => t.id === toolID)
    if (!found) throw new Error(`tool ${toolID} not present`)
    return found
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

// =============================================================================
// shell.exec / exec_command.exec — real spawn end-to-end, exits immediately.
// =============================================================================

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

test(
  "bench: exec_command.exec",
  async () => {
    if (process.platform === "win32") return
    const result = await runWithInstance(
      Effect.gen(function* () {
        const def = yield* toolDef("exec_command")
        const ctx = recordCtx(SessionID.make("ses_bench"))
        const op = async () => {
          await Effect.runPromise(swallow(def.execute({ cmd: NOOP_CMD, yield_time_ms: 1_000 }, ctx)))
        }
        return yield* Effect.promise(() =>
          bench({ samples: 20, warmup: 3, label: "exec_command.exec" }, op),
        )
      }),
    )
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  180_000,
)

// =============================================================================
// task.spawn / spawn_agent.spawn — spawn end-to-end with stub run-loop.
// =============================================================================

test(
  "bench: spawn_agent.spawn",
  async () => {
    const result = await runWithInstance(
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        // Stub run-loop so the spawn returns without driving inference.
        // Same pattern as agent-spawn.test.ts:36 and agent-control.bench.ts:94.
        yield* control.registerRunLoop(() => Effect.never)
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const def = yield* toolDef("spawn_agent")

        let i = 0
        const op = async () => {
          const taskName = `s${i++}`
          const ctx = recordCtx(root.id)
          await Effect.runPromise(
            swallow(def.execute({ message: ".", task_name: taskName, agent_type: "explore" }, ctx)),
          )
        }
        return yield* Effect.promise(() =>
          bench({ samples: 10, warmup: 2, label: "spawn_agent.spawn" }, op),
        )
      }),
    )
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

test(
  "bench: task.spawn",
  async () => {
    // Legacy `task` tool would normally call sessions.create + session.prompt.
    // To capture only the per-spawn setup overhead (comparable to spawn_agent
    // which has registerRunLoop stubbing inference), we throw the SENTINEL
    // inside ctx.ask BEFORE the create branch (task.ts:44-53). The result
    // measures the validation + permission-prompt wiring cost.
    const result = await runWithInstance(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* toolDef("task")
        const ctx = captureCtx(root.id)
        const op = async () => {
          await Effect.runPromise(
            swallow(
              def.execute(
                { description: "noop", prompt: "noop", subagent_type: "explore" },
                ctx,
              ),
            ),
          )
        }
        return yield* Effect.promise(() => bench({ samples: 10, warmup: 2, label: "task.spawn" }, op))
      }),
    )
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

// =============================================================================
// registry.tools — filtered list construction for the build agent.
// =============================================================================

test(
  "bench: registry.tools",
  async () => {
    const result = await runWithInstance(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const op = async () => {
          await Effect.runPromise(registry.tools({ ...STUB_MODEL, agent: build }))
        }
        return yield* Effect.promise(() =>
          bench({ samples: 500, warmup: 50, label: "registry.tools" }, op),
        )
      }),
    )
    allResults[result.label] = result
    expect(result.samples).toBeGreaterThan(0)
  },
  120_000,
)

// =============================================================================
// permission.disabled / permission.evaluate — pure fns over a 50-rule ruleset.
// =============================================================================

test("bench: permission.disabled", async () => {
  const result = await bench(
    { samples: 500, warmup: 50, label: "permission.disabled" },
    () => {
      const out = Permission.disabled(TOOLS_50, RULESET_50)
      if (out.size === -1) throw new Error("unreachable")
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

test("bench: permission.evaluate", async () => {
  const result = await bench(
    { samples: 500, warmup: 50, label: "permission.evaluate" },
    () => {
      // Evaluate one rule per sample across all 50 — covers the loop cost.
      const r = evaluate("bash", "cmd_5 status", RULESET_50)
      if (!r.action) throw new Error("unreachable")
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

// =============================================================================
// prompt.render.* — rendered description byte length + token count proxy.
// One-shot; the percentile fields are 0 — bytes/tokens are the actual signal.
// =============================================================================

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

const renderMetric = (label: string, description: string) => ({
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

// =============================================================================
// Writer — emit identical content to BOTH baseline and trend files.
// =============================================================================

afterAll(async () => {
  if (Object.keys(allResults).length === 0) return
  const payload = {
    captured_at: new Date().toISOString(),
    git_sha: gitSha(),
    bun_version: Bun.version,
    metrics: allResults,
  }
  const json = JSON.stringify(payload, null, 2)
  await fs.mkdir(path.dirname(baselineFile), { recursive: true })
  await fs.mkdir(path.dirname(wavePerfFile), { recursive: true })
  await Bun.write(baselineFile, json)
  await Bun.write(wavePerfFile, json)
})
