// Wave 2 — cornerstone BC differential test. For every (fixture × command)
// tuple, the LEGACY `bash` tool and the NEW `exec_command` tool must produce
// IDENTICAL bash-key ask payloads (modulo `exec_command`'s extra `pid:<N>`
// always-rule) AND therefore identical permission decisions under the same
// ruleset.
//
// This is the headline test that pins the campaign's promise: every saved
// `permission.bash: { ... }` rule transparently auto-allows / asks / denies
// `exec_command` invocations the same way it always has for `bash`.
//
// Approach: drive both tools through their full `execute` body but use a
// sentinel-throwing `ctx.ask` on the bash-key ask so the use block fails
// before spawn. Tool's `acquireUseRelease` release branch tears down any
// allocated PTY. No real shell command runs.
//
// Reference: WAVE.md step 7, FIXTURES.md, BACKWARD_COMPAT.md § "Saved
// permission rules — bash key".

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Pty } from "@/pty"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ProcessSessions } from "@/tool/process/sessions"
import { ExecCommandTool } from "@/tool/process/exec-command"
import { ShellTool } from "@/tool/shell"
import * as Tool from "@/tool/tool"
import type { Permission as PermissionType } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { ConfigPermission } from "@/config/permission"
import { Schema } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { loadPermissionConfig } from "../fixtures/load-config"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    ProcessSessions.defaultLayer,
    Pty.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
  ),
)

type CapturedRequest = Omit<PermissionType.Request, "id" | "sessionID" | "tool">

// Sentinel-on-bash-key ctx: lets external_directory ask succeed (so the
// ask sequence proceeds to the bash ask), throws on bash to short-circuit
// before any real shell command runs through the PTY.
function makeSentinelCtx(): { ctx: Tool.Context; asks: CapturedRequest[] } {
  const asks: CapturedRequest[] = []
  const SENTINEL = new Error("__diff_stop_after_bash__")
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_diff_exec"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        asks.push(req)
        if (req.permission === "bash") throw SENTINEL
      }),
  }
  return { ctx, asks }
}

const initShell = Effect.fn("ExecPermDiff.initShell")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initExec = Effect.fn("ExecPermDiff.initExec")(function* () {
  const info = yield* ExecCommandTool
  return yield* info.init()
})

// Reduce per-pattern evaluations to the same outcome `Permission.ask` would
// take. deny short-circuits; otherwise ask wins over allow if any pattern
// is ask. Source of truth: permission/index.ts:184-194.
function decision(askPayload: CapturedRequest, ruleset: PermissionType.Ruleset): "allow" | "deny" | "ask" {
  let needsAsk = false
  for (const pattern of askPayload.patterns) {
    const action = Permission.evaluate(askPayload.permission, pattern, ruleset).action
    if (action === "deny") return "deny"
    if (action === "ask") needsAsk = true
  }
  return needsAsk ? "ask" : "allow"
}

// Pull the ruleset that the user-config fixture would produce. Mirrors
// session/llm.ts:451-454: `Permission.fromConfig(cfg.permission)`.
async function fixtureRuleset(name: string): Promise<PermissionType.Ruleset> {
  const cfg: { permission?: Record<string, unknown> } = await loadPermissionConfig(name)
  const decoded = Schema.decodeUnknownSync(ConfigPermission.Info)(cfg.permission ?? {})
  return Permission.fromConfig(decoded)
}

// Each (cmd, fixture) tuple pins the BC matrix in BACKWARD_COMPAT.md §
// "Saved permission rules — bash key".
const FIXTURES = ["empty-config", "allow-all-bash", "git-allow-rest-ask", "mixed-permissions"] as const
const COMMANDS = [
  "git status",
  "git status -s",
  "git push origin main",
  "npm install",
  "ls -la",
  "echo hello",
  "pwd",
  "cat README.md",
  "node --version",
  "rm ./tmp.txt",
] as const

describe("differential — exec_command consults bash key with byte-identical payload to ShellTool", () => {
  it.instance(
    "every fixture × command produces matching bash ask + matching permission decision",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const shellDef = yield* initShell()
        const execDef = yield* initExec()

        const failures: string[] = []
        for (const fixtureName of FIXTURES) {
          const ruleset = yield* Effect.promise(() => fixtureRuleset(fixtureName))
          for (const cmd of COMMANDS) {
            const sa = makeSentinelCtx()
            yield* shellDef
              .execute({ command: cmd, description: "diff" }, sa.ctx)
              .pipe(Effect.catchCause(() => Effect.void))
            const sb = makeSentinelCtx()
            yield* execDef
              .execute({ cmd, yield_time_ms: 250 }, sb.ctx)
              .pipe(Effect.catchCause(() => Effect.void))

            const bashA = sa.asks.find((a) => a.permission === "bash")
            const bashB = sb.asks.find((a) => a.permission === "bash")
            if (!bashA || !bashB) {
              failures.push(
                `cmd=${JSON.stringify(cmd)} fixture=${fixtureName}: missing bash ask (shell=${!!bashA}, exec=${!!bashB})`,
              )
              continue
            }

            const patternsA = [...bashA.patterns].sort()
            const patternsB = [...bashB.patterns].sort()
            if (JSON.stringify(patternsA) !== JSON.stringify(patternsB)) {
              failures.push(
                `cmd=${JSON.stringify(cmd)} fixture=${fixtureName}: patterns diverge\n  shell=${JSON.stringify(patternsA)}\n  exec=${JSON.stringify(patternsB)}`,
              )
            }

            // exec adds `pid:<N>` to always — the SET difference must equal
            // exactly one entry of that shape, and shell's always must be a
            // subset of exec's always.
            const alwaysA = new Set(bashA.always)
            const alwaysB = new Set(bashB.always)
            for (const p of alwaysA) {
              if (!alwaysB.has(p)) failures.push(`cmd=${cmd}: shell always '${p}' missing from exec`)
            }
            const extra = [...alwaysB].filter((p) => !alwaysA.has(p))
            if (extra.length !== 1 || !/^pid:\d+$/.test(extra[0])) {
              failures.push(
                `cmd=${JSON.stringify(cmd)} fixture=${fixtureName}: extra always entries diverge from [pid:N]\n  extra=${JSON.stringify(extra)}`,
              )
            }

            const dA = decision(bashA, ruleset)
            const dB = decision(bashB, ruleset)
            if (dA !== dB) {
              failures.push(
                `cmd=${JSON.stringify(cmd)} fixture=${fixtureName}: decision diverges shell=${dA} exec=${dB}`,
              )
            }
          }
        }

        if (failures.length > 0) {
          throw new Error(`${failures.length} differential failures:\n${failures.join("\n")}`)
        }
        expect(failures.length).toBe(0)
      }),
    120_000,
  )
})
