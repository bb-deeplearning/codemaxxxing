// Wave 14 e2e — long-running server attach + repeated polling.
//
// Scenario: spawn a tick-emitting child via `exec_command tty:true`. Poll
// it N times via empty `write_stdin` calls (the codex "drain output"
// pattern). Verify ticks accumulate, the session stays alive across
// every poll, and we can finally close it cleanly.
//
// Maps to codex's "attach to dev server" story — the model spawns
// `bun -e "setInterval..." `, then drains its stdout periodically.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import { ExecCommandID, WriteStdinID } from "@/tool/process/id"
import type * as Tool from "@/tool/tool"
import type { Permission } from "@/permission"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { installSuiteNetworkGuard } from "./lib"

afterEach(async () => {
  await disposeAllInstances()
})

installSuiteNetworkGuard()

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

function makeCtx() {
  const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_e2e_long_running"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asks.push(input)
      }),
  }
  return { ctx, asks }
}

describe("e2e: long-running tick server (poll + attach pattern)", () => {
  it.instance(
    "tick server stays alive across 3 polls; ticks accumulate; final write quits cleanly",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const tools = yield* registry.tools({ ...ref, agent: build })

        const exec = tools.find((t) => t.id === ExecCommandID.ToolID)
        const writeStdin = tools.find((t) => t.id === WriteStdinID.ToolID)
        expect(exec).toBeDefined()
        expect(writeStdin).toBeDefined()

        const { ctx } = makeCtx()

        // Tick every 80ms. Read 'q' to exit cleanly. Using bun's process
        // API keeps the test hermetic — no system tools required.
        const tickCmd = `${process.execPath} -e "let n = 0; const t = setInterval(() => { n += 1; process.stdout.write('tick:' + n + '\\n') }, 80); process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { for (const line of d.split('\\n')) { if (line === 'q') { clearInterval(t); process.exit(0) } } })"`

        const spawnResult = yield* exec!.execute(
          { cmd: tickCmd, tty: true, yield_time_ms: 300 },
          ctx,
        )
        const sid = spawnResult.metadata.session_id as number
        expect(typeof sid).toBe("number")

        // First poll captured ticks emitted during the spawn yield.
        // initial_output must include at least "tick:1".
        expect(spawnResult.output).toContain("tick:")

        // Three drain-only polls. The yield_time gets clamped to the
        // empty-poll floor (5_000 ms) but the read returns early on
        // freshly arrived bytes — see write-stdin clamp behavior.
        const polled: string[] = []
        for (let i = 0; i < 3; i++) {
          const poll = yield* writeStdin!.execute(
            { session_id: sid, chars: "", yield_time_ms: 200 },
            ctx,
          )
          expect(poll.metadata.session_id).toBe(sid)
          expect(poll.metadata.exit_code).toBeUndefined()
          polled.push(poll.output)
        }

        // At least one of the polls saw new ticks beyond the spawn
        // capture. Tolerant assertion — bun -e + macOS scheduler nondet
        // can leave any single poll empty even with 200ms wait.
        const sawTick = polled.some((out) => /tick:\d+/.test(out))
        expect(sawTick).toBe(true)

        // Quit gracefully.
        const exit = yield* writeStdin!.execute(
          { session_id: sid, chars: "q\n", yield_time_ms: 2000 },
          ctx,
        )
        expect(exit.metadata.exit_code).toBe(0)
        expect(exit.metadata.session_id).toBeUndefined()
      }),
    20_000,
  )
})
