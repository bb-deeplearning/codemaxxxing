// Wave 14 e2e — persistent REPL through exec_command + write_stdin.
//
// Scenario: spawn a node REPL-style process via `exec_command tty:true`,
// then issue 3 sequential `write_stdin` calls that mutate state in the
// REPL. Verifies that the same session_id remains valid across calls
// (the persistent process model from codex's unified_exec) and that
// state survives between writes.
//
// Hermetic per WAVE.md: uses `bun -e` for the spawned child — no system
// python, no system node, no external deps. Same shape the
// integration/process-tool.test.ts test uses.

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

// Lightweight layer — the persistent process tools don't need
// SessionPrompt or LLM. Use the integration-test composition.
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
    sessionID: SessionID.make("ses_e2e_persistent_repl"),
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

describe("e2e: persistent REPL (exec_command tty + sequential write_stdin)", () => {
  it.instance(
    "node REPL state (counter) survives 3 sequential write_stdin calls",
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

        // A self-contained line-oriented REPL: read lines, evaluate
        // a tiny grammar (`set X`, `inc`, `read`), echo results.
        const replCmd = `${process.execPath} -e "let x = 0; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { for (const line of d.split('\\n')) { if (line === 'q') process.exit(0); else if (line.startsWith('set ')) { x = Number(line.slice(4)); process.stdout.write('ok\\n') } else if (line === 'inc') { x = x + 1; process.stdout.write('inc:' + x + '\\n') } else if (line === 'read') { process.stdout.write('val:' + x + '\\n') } }})"`

        const spawnResult = yield* exec!.execute(
          { cmd: replCmd, tty: true, yield_time_ms: 250 },
          ctx,
        )
        const sid = spawnResult.metadata.session_id as number
        expect(typeof sid).toBe("number")
        expect(spawnResult.metadata.exit_code).toBeUndefined()

        // 1. set 5
        const set = yield* writeStdin!.execute(
          { session_id: sid, chars: "set 5\n", yield_time_ms: 1500 },
          ctx,
        )
        expect(set.metadata.session_id).toBe(sid)
        expect(set.output).toContain("ok")

        // 2. inc — value should become 6
        const inc = yield* writeStdin!.execute(
          { session_id: sid, chars: "inc\n", yield_time_ms: 1500 },
          ctx,
        )
        expect(inc.metadata.session_id).toBe(sid)
        expect(inc.output).toContain("inc:6")

        // 3. read — value should still be 6 (state persisted across calls)
        const read = yield* writeStdin!.execute(
          { session_id: sid, chars: "read\n", yield_time_ms: 1500 },
          ctx,
        )
        expect(read.metadata.session_id).toBe(sid)
        expect(read.output).toContain("val:6")

        // 4. q — exit cleanly. session_id is no longer returned because
        // the process exited.
        const exit = yield* writeStdin!.execute(
          { session_id: sid, chars: "q\n", yield_time_ms: 2000 },
          ctx,
        )
        expect(exit.metadata.exit_code).toBe(0)
        expect(exit.metadata.session_id).toBeUndefined()
      }),
  )
})
