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
import * as Tool from "../tool"
import { disposeAllInstances, provideTmpdirInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"
import { AgentListTool, PermissionKey } from "./agent-list"

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

const initTool = Effect.fn("AgentListToolTest.init")(function* () {
  const info = yield* AgentListTool
  return yield* info.init()
})

const seedRoot = Effect.fn("AgentListToolTest.seedRoot")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "root" })
  const control = yield* AgentControl.Service
  yield* control.registerSessionRoot(root.id)
  return root
})

interface AgentEntry {
  agent_name: string
  agent_status: unknown
  last_task_message: string | null
}

interface ListPayload {
  agents: AgentEntry[]
}

describe("tool.list_agents", () => {
  it.live("empty tree returns just the root entry, running, last_task_message='Main thread'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        expect(payload.agents.length).toBe(1)
        expect(payload.agents[0].agent_name).toBe("/root")
        expect(payload.agents[0].agent_status).toBe("running")
        expect(payload.agents[0].last_task_message).toBe("Main thread")
      }),
    ),
  )

  it.live("after spawning child A, result includes /root and /root/a", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: "do A",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        const names = payload.agents.map((a) => a.agent_name).sort()
        expect(names).toEqual(["/root", "/root/a"])
      }),
    ),
  )

  it.live("with two siblings, result includes root + both in path-sorted order", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        const names = payload.agents.map((a) => a.agent_name)
        expect(names).toEqual(["/root", "/root/a", "/root/b"])
      }),
    ),
  )

  it.live("nested spawn: spawn A then B (child of A); result includes root, A, A/B", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        const names = payload.agents.map((a) => a.agent_name).sort()
        expect(names).toEqual(["/root", "/root/a", "/root/a/b"])
      }),
    ),
  )

  it.live("path_prefix '/root/a' returns only A and its descendants (no root, no siblings)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "x",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ path_prefix: "/root/a" }, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        const names = payload.agents.map((a) => a.agent_name).sort()
        expect(names).toEqual(["/root/a", "/root/a/x"])
      }),
    ),
  )

  it.live("relative path_prefix 'worker_a' from root resolves to '/root/worker_a'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker_a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker_b",
          initial_message: ".",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ path_prefix: "worker_a" }, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        const names = payload.agents.map((a) => a.agent_name)
        expect(names).toEqual(["/root/worker_a"])
      }),
    ),
  )

  it.live("invalid path_prefix returns model-recoverable error in output (no exception)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        // Uppercase letters fail the AgentPath segment validator.
        const result = yield* def.execute({ path_prefix: "INVALID" }, ctx)
        expect(typeof result.output).toBe("string")
        expect(result.output.toLowerCase()).toMatch(/invalid|reserved|lowercase/)
        expect(result.metadata.error).toBe("invalid_prefix")
      }),
    ),
  )

  it.live("output JSON has every entry with agent_name, agent_status, last_task_message (null when missing)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "tracked",
          initial_message: "do thing X",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        for (const entry of payload.agents) {
          expect(typeof entry.agent_name).toBe("string")
          expect(entry.agent_status).toBeDefined()
          // last_task_message is either a string OR null — never undefined
          // (codex spec marks it as required: ["..., last_task_message"]).
          expect(entry.last_task_message === null || typeof entry.last_task_message === "string").toBe(true)
        }
        const tracked = payload.agents.find((a) => a.agent_name === "/root/tracked")
        expect(tracked?.last_task_message).toBe("do thing X")
      }),
    ),
  )

  it.live("ctx.ask is invoked with permission key 'list_agents'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        yield* def.execute({}, ctx)
        expect(record.asks.length).toBe(1)
        expect(record.asks[0].permission).toBe(PermissionKey)
      }),
    ),
  )

  it.live("ctx.ask pattern reflects path_prefix (or '*' when absent)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        yield* def.execute({}, ctx)
        expect(record.asks[0].patterns).toEqual(["*"])

        const { ctx: ctx2, record: record2 } = makeCtx(root.id)
        yield* def.execute({ path_prefix: "/root/a" }, ctx2)
        expect(record2.asks[0].patterns).toEqual(["/root/a"])
      }),
    ),
  )

  it.live("metadata.agent_count matches the returned agents length", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "x",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "y",
          initial_message: ".",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output) as ListPayload
        expect(result.metadata.agent_count).toBe(payload.agents.length)
        expect(result.metadata.agent_count).toBe(3)
      }),
    ),
  )

  it.live("metadata.path_prefix is null when absent and the literal string when set", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        expect(result.metadata.path_prefix).toBeNull()

        const { ctx: ctx2 } = makeCtx(root.id)
        const result2 = yield* def.execute({ path_prefix: "/root" }, ctx2)
        expect(result2.metadata.path_prefix).toBe("/root")
      }),
    ),
  )

  it.live("title encodes the agent count for transcript readability", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({}, ctx)
        expect(result.title.toLowerCase()).toContain("list_agents")
        expect(result.title).toMatch(/\(1\)/)
      }),
    ),
  )
})
