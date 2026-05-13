import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
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

afterEach(async () => {
  await disposeAllInstances()
})

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
    sessionID: SessionID.make("ses_integration_process"),
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

describe("integration: process tools (exec_command + write_stdin via registry)", () => {
  it.instance("end-to-end round trip: spawn echo process, write stdin, exit cleanly", () =>
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
      const echoCmd = `${process.execPath} -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { for (const line of d.split('\\n')) { if (line === 'q') process.exit(0); else if (line) process.stdout.write('got:' + line + '\\n') } })"`

      const spawnResult = yield* exec!.execute(
        {
          cmd: echoCmd,
          tty: true,
          yield_time_ms: 250,
        },
        ctx,
      )
      const sid = spawnResult.metadata.session_id as number
      expect(typeof sid).toBe("number")
      expect(spawnResult.metadata.exit_code).toBeUndefined()

      const writeResult = yield* writeStdin!.execute(
        { session_id: sid, chars: "hello\n", yield_time_ms: 1500 },
        ctx,
      )
      expect(writeResult.output).toContain("got:hello")
      expect(writeResult.metadata.session_id).toBe(sid)

      const exitResult = yield* writeStdin!.execute(
        { session_id: sid, chars: "q\n", yield_time_ms: 2000 },
        ctx,
      )
      expect(exitResult.metadata.exit_code).toBe(0)
      expect(exitResult.metadata.session_id).toBeUndefined()
    }),
  )

  it.instance("exec_command + write_stdin tools are registered for the build agent", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const ids = tools.map((t) => t.id)
      expect(ids).toContain("exec_command")
      expect(ids).toContain("write_stdin")
    }),
  )

  it.instance("exec_command tool description teaches the operational decisions (rendered through registry)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const exec = tools.find((t) => t.id === "exec_command")
      expect(exec).toBeDefined()
      expect(exec!.description.toLowerCase()).toContain("persistent")
      expect(exec!.description).toContain("session_id")
      expect(exec!.description).toContain("write_stdin")
    }),
  )
})
