// Integration invariants — every tool-surface-replacement scenario in this
// campaign asserts observable behavior against the scenarios listed in
// .wave/campaigns/replace-bash-task-2026-05-15/plan/INTEGRATION_INVARIANTS.md.
//
// Every invariant in the doc has exactly one `it.instance` block here. Wave 0
// seeds the file with skipped stubs (TODO comments name the wave that
// unskips). Each later wave unskips and implements the relevant ones.
//
// Test names MATCH the invariant slugs in the doc so the wave's verification
// can grep for them.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncate"
import { ShellScan } from "@/tool/shell/scan"
import { ToolRegistry } from "@/tool/registry"
import * as Tool from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { loadScannerCorpus } from "../fixtures/load-config"
import { generateCommand, makeRng, scanEqual } from "../fixtures/fuzz"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    AppFileSystem.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const defaultShell = Shell.acceptable()

type CapturedRequest = Omit<Permission.Request, "id" | "sessionID" | "tool">

const SENTINEL = new Error("__invariant_stop__")

function captureCtx(opts?: { stopOnFirst?: boolean }): {
  requests: CapturedRequest[]
  ctx: Tool.Context
} {
  const requests: CapturedRequest[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_inv"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
        if (opts?.stopOnFirst) throw SENTINEL
      }),
  }
  return { requests, ctx }
}

const sortedUnique = (arr: ReadonlyArray<string>) => Array.from(new Set(arr)).sort()
const dirFromGlob = (g: string) => g.replace(/[/\\]\*$/, "")

describe("INTEGRATION_INVARIANTS — tool surface replacement", () => {
  // Wave 1 — extract preserves bash-output: every corpus entry produces the
  // same captured ask payloads as the legacy scanner did at Wave 0.
  it.instance("scanner-extract-preserves-bash-output", () =>
    Effect.gen(function* () {
      const corpus = yield* Effect.promise(() => loadScannerCorpus())
      const instance = yield* InstanceState.context

      const failures: string[] = []
      for (const entry of corpus) {
        const scan = yield* ShellScan.scanCommand({
          command: entry.cmd,
          shell: defaultShell,
          cwd: instance.directory,
          instance,
        })
        const { requests, ctx } = captureCtx({ stopOnFirst: true })
        yield* ShellScan.askForScan(ctx, scan).pipe(Effect.catchCause(() => Effect.void))

        const bashReq = requests.find((r) => r.permission === "bash")
        const extReq = requests.find((r) => r.permission === "external_directory")

        const got = {
          patterns: bashReq ? sortedUnique([...bashReq.patterns]) : [],
          always: bashReq ? sortedUnique([...bashReq.always]) : [],
          dirs: extReq ? sortedUnique([...extReq.patterns].map(dirFromGlob)) : [],
        }
        const expected = {
          patterns: [...entry.expected_patterns].sort(),
          always: [...entry.expected_always].sort(),
          dirs: [...entry.expected_dirs].sort(),
        }

        if (
          JSON.stringify(got.patterns) !== JSON.stringify(expected.patterns) ||
          JSON.stringify(got.always) !== JSON.stringify(expected.always) ||
          JSON.stringify(got.dirs) !== JSON.stringify(expected.dirs)
        ) {
          failures.push(
            `cmd=${JSON.stringify(entry.cmd)}\n  expected=${JSON.stringify(expected)}\n  got=${JSON.stringify(got)}`,
          )
        }
      }
      if (failures.length > 0) throw new Error(`corpus diverged:\n${failures.join("\n")}`)
      expect(failures.length).toBe(0)
    }),
  )

  // Wave 1 — concurrent stress: 64 invocations against varied corpus inputs
  // must each return the result that matches their own input. Catches cross
  // contamination from shared parser state.
  it.instance("scanner-deterministic-under-concurrent-load", () =>
    Effect.gen(function* () {
      const corpus = yield* Effect.promise(() => loadScannerCorpus())
      const instance = yield* InstanceState.context
      const inputs = Array.from({ length: 64 }, (_, i) => corpus[i % corpus.length])

      const results = yield* Effect.forEach(
        inputs,
        (entry) =>
          ShellScan.scanCommand({
            command: entry.cmd,
            shell: defaultShell,
            cwd: instance.directory,
            instance,
          }).pipe(Effect.map((scan) => ({ entry, scan }))),
        { concurrency: 64 },
      )

      const failures: string[] = []
      for (const { entry, scan } of results) {
        const { requests, ctx } = captureCtx({ stopOnFirst: true })
        yield* ShellScan.askForScan(ctx, scan).pipe(Effect.catchCause(() => Effect.void))
        const bashReq = requests.find((r) => r.permission === "bash")
        const extReq = requests.find((r) => r.permission === "external_directory")
        const got = {
          patterns: bashReq ? sortedUnique([...bashReq.patterns]) : [],
          always: bashReq ? sortedUnique([...bashReq.always]) : [],
          dirs: extReq ? sortedUnique([...extReq.patterns].map(dirFromGlob)) : [],
        }
        const expected = {
          patterns: [...entry.expected_patterns].sort(),
          always: [...entry.expected_always].sort(),
          dirs: [...entry.expected_dirs].sort(),
        }
        if (
          JSON.stringify(got.patterns) !== JSON.stringify(expected.patterns) ||
          JSON.stringify(got.always) !== JSON.stringify(expected.always) ||
          JSON.stringify(got.dirs) !== JSON.stringify(expected.dirs)
        ) {
          failures.push(`cmd=${entry.cmd}: ${JSON.stringify({ got, expected })}`)
        }
      }
      if (failures.length > 0) throw new Error(`concurrent diverged:\n${failures.join("\n")}`)
      expect(failures.length).toBe(0)
    }),
  )

  // Wave 1 — fuzz: 1000 generated commands. None crash, all are
  // deterministic on rerun. Seed printed in the failure path so a flaky
  // failure can be reproduced.
  it.instance(
    "scanner-handles-1000-fuzz-inputs-without-crash",
    () =>
      Effect.gen(function* () {
        const seed = Number(BigInt(Bun.nanoseconds()) & 0xffffffffn)
        const rng = makeRng(seed)
        const instance = yield* InstanceState.context
        for (let i = 0; i < 1000; i++) {
          const cmd = generateCommand(rng)
          const a = yield* ShellScan.scanCommand({
            command: cmd,
            shell: defaultShell,
            cwd: instance.directory,
            instance,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                throw new Error(`fuzz crash i=${i} seed=${seed} cmd=${JSON.stringify(cmd)}: ${cause}`)
              }),
            ),
          )
          const b = yield* ShellScan.scanCommand({
            command: cmd,
            shell: defaultShell,
            cwd: instance.directory,
            instance,
          })
          if (!scanEqual(a, b)) {
            throw new Error(`non-deterministic i=${i} seed=${seed} cmd=${JSON.stringify(cmd)}`)
          }
        }
        expect(true).toBe(true)
      }),
    60_000,
  )

  // TODO(wave_2): unskip when exec_command honors saved permission.bash allow patterns.
  it.instance.skip("exec-command-honors-saved-bash-allow-pattern", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when exec_command triggers external_directory before bash for outside-cwd paths.
  it.instance.skip("exec-command-triggers-external-directory-for-outside-cwd-paths", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when write_stdin auto-allows after a pid:<N> rule registers under permission key bash.
  it.instance.skip("write-stdin-auto-allows-after-pid-rule-registered-under-bash", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when permission.bash deny hides exec_command and write_stdin from the model tool list.
  it.instance.skip("permission-bash-deny-hides-exec-and-stdin-from-tool-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when 32 concurrent exec_command flows do not cross-contaminate permission state.
  it.instance.skip("exec-command-concurrent-permission-flows-do-not-cross-contaminate", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): unskip when spawn_agent honors saved permission.task allow patterns.
  it.instance.skip("spawn-agent-honors-saved-task-allow-pattern", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): unskip when spawn_agent description filters its eligible list by permission.task rules.
  it.instance.skip("spawn-agent-description-filters-by-task-rules", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): unskip when permission.task deny hides all six v2 multi-agent tools from the list.
  it.instance.skip("permission-task-deny-hides-all-six-v2-tools-from-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when bash is dropped from the model-visible tool list.
  it.instance.skip("model-tool-list-no-bash", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when task is dropped from the model-visible tool list.
  it.instance.skip("model-tool-list-no-task", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when plugin tool.definition hooks for bash apply to exec_command.
  it.instance.skip("plugin-bash-hook-applies-to-exec-command", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when plugin tool.definition hooks for task apply to spawn_agent.
  it.instance.skip("plugin-task-hook-applies-to-spawn-agent", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when ShellTool stays importable + executable from internal code despite being unadvertised.
  it.instance.skip("legacy-shell-tool-still-runnable-from-internal-code", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when TaskTool stays importable + executable from internal code despite being unadvertised.
  it.instance.skip("legacy-task-tool-still-runnable-from-internal-code", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the git safety protocol fragment verbatim in exec_command.txt.
  it.instance.skip("prose-migration-preserves-git-safety-protocol", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the PR creation flow fragment verbatim in exec_command.txt.
  it.instance.skip("prose-migration-preserves-pr-creation-flow", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the spawn_agent eligible-subagent-types listing.
  it.instance.skip("prose-migration-preserves-spawn-agent-eligible-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when migrated exec_command + spawn_agent descriptions stay within the prompt token budget.
  it.instance.skip("prompt-token-count-within-budget", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_6): unskip when every BACKWARD_COMPAT.md fixture × invocation tuple produces the expected outcome.
  it.instance.skip("bc-matrix-fully-green", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_6): unskip when the aggregated perf trend table shows no metric drifting beyond the per-wave budget.
  it.instance.skip("perf-trend-no-creep", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )
})
