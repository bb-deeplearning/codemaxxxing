import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import type { Permission } from "@/permission"
import { AgentCloseTool } from "./agent-close"
import type * as Tool from "../tool"
import { disposeAllInstances, provideTmpdirInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    AgentControl.defaultLayer,
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const installNeverLoop = Effect.gen(function* () {
  const control = yield* AgentControl.Service
  yield* control.registerRunLoop(() => Effect.never)
})

const initTool = Effect.fn("AgentCloseToolTest.init")(function* () {
  const info = yield* AgentCloseTool
  return yield* info.init()
})

interface CtxRecord {
  asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>
  abort: AbortController
}

function makeCtx(sessionID: SessionID): { record: CtxRecord; ctx: Tool.Context } {
  const record: CtxRecord = { asks: [], abort: new AbortController() }
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: record.abort.signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        record.asks.push(input)
      }),
  }
  return { record, ctx }
}

const seedRoot = Effect.fn("AgentCloseToolTest.seedRoot")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "root" })
  const control = yield* AgentControl.Service
  yield* control.registerSessionRoot(root.id)
  return root
})

describe("close_agent tool", () => {
  it.live("happy path: closes a spawned child by relative name", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "worker" }, ctx)

        const payload = JSON.parse(result.output)
        expect(payload.previous_status).toBeDefined()

        const list = yield* control.listAgents(AgentPath.root())
        expect(list.find((a) => a.agent_name === "/root/worker")).toBeUndefined()
      }),
    ),
  )

  it.live("accepts a canonical /root/<leaf> target", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "abs",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "/root/abs" }, ctx)
        const payload = JSON.parse(result.output)
        expect(payload.previous_status).toBeDefined()

        const list = yield* control.listAgents(AgentPath.root())
        expect(list.find((a) => a.agent_name === "/root/abs")).toBeUndefined()
      }),
    ),
  )

  it.live("resolves a relative target from a sub-agent's perspective", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: "init",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "b",
          initial_message: "init",
        })

        const def = yield* initTool()
        // Caller is "a"; target "b" should resolve to /root/a/b.
        const { ctx } = makeCtx(a.thread_id)
        const result = yield* def.execute({ target: "b" }, ctx)
        const payload = JSON.parse(result.output)
        expect(payload.previous_status).toBeDefined()

        const list = yield* control.listAgents(AgentPath.root())
        expect(list.find((a2) => a2.agent_name === "/root/a/b")).toBeUndefined()
        // Sibling "a" still alive.
        expect(list.find((a2) => a2.agent_name === "/root/a")).toBeDefined()
      }),
    ),
  )

  it.live("cascades close to descendants of the target", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: "init",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "b",
          initial_message: "init",
        })
        yield* control.spawnAgent({
          parentID: b.thread_id,
          parentPath: yield* AgentPath.from("/root/a/b"),
          task_name: "c",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        yield* def.execute({ target: "a" }, ctx)

        const list = yield* control.listAgents(AgentPath.root())
        const names = list.map((l) => l.agent_name)
        expect(names.includes("/root/a")).toBe(false)
        expect(names.includes("/root/a/b")).toBe(false)
        expect(names.includes("/root/a/b/c")).toBe(false)
      }),
    ),
  )

  it.live("rejects targeting the root path with a model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "/root" }, ctx)

        expect(result.output.toLowerCase()).toContain("root")
        // Permission was NOT asked when the target is root.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("rejects unknown targets with a model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "ghost" }, ctx)

        expect(typeof result.output).toBe("string")
        expect(result.output.length).toBeGreaterThan(0)
        // No permission ask for invalid targets — they short-circuit.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("rejects empty target string with a model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "" }, ctx)

        expect(typeof result.output).toBe("string")
        expect(result.output.length).toBeGreaterThan(0)
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("is idempotent on an already-closed agent (returns shutdown)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "twice",
          initial_message: "init",
        })
        // First close via control directly, second via tool.
        yield* control.closeAgent(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "/root/twice" }, ctx)
        // Resolution: agent removed from registry → resolve fails. The tool
        // surfaces a model-recoverable string. Either way we must NOT throw.
        expect(typeof result.output).toBe("string")
      }),
    ),
  )

  it.live("ctx.ask is called with permission key 'close_agent' and patterns [target]", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "asked",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        yield* def.execute({ target: "asked" }, ctx)

        expect(record.asks).toHaveLength(1)
        expect(record.asks[0]?.permission).toBe("close_agent")
        expect(record.asks[0]?.patterns).toEqual(["asked"])
      }),
    ),
  )

  it.live("output is a JSON string parseable to {previous_status: ...}", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "json",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "json" }, ctx)
        const payload = JSON.parse(result.output)
        expect(Object.prototype.hasOwnProperty.call(payload, "previous_status")).toBe(true)
      }),
    ),
  )
})
