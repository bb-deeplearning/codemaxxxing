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
import { AgentFollowupTool, PermissionKey } from "./agent-followup"
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

const initTool = Effect.fn("AgentFollowupToolTest.init")(function* () {
  const info = yield* AgentFollowupTool
  return yield* info.init()
})

describe("tool.followup_task", () => {
  it.live("happy path: queues message into target's mailbox with trigger_turn=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })
        // Drain the seed message so the followup is the only thing left.
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "worker", message: "do next" }, ctx)

        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("do next")
        expect(drained[0]?.trigger_turn).toBe(true)
        expect(String(drained[0]?.recipient)).toBe("/root/worker")
        expect(String(drained[0]?.author)).toBe("/root")

        // Result shape: title contains target, metadata records target/queued.
        expect(result.title).toContain("worker")
        expect(result.metadata.target).toBe("worker")
        expect(result.metadata.queued).toBe(true)
        expect(result.metadata.trigger_turn).toBe(true)
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("canonical absolute path target: target='/root/worker' resolves and delivers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target: "/root/worker", message: "absolute go" },
          ctx,
        )

        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("absolute go")
        expect(drained[0]?.trigger_turn).toBe(true)
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("relative target from sub-agent: from /root/A, target='B' resolves to /root/A/B", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: "init a",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "b",
          initial_message: "init b",
        })
        yield* control.drainMailbox(b.thread_id)

        const def = yield* initTool()
        // ctx.sessionID = a's session — currentPath resolves to /root/a;
        // target "b" resolves to /root/a/b.
        const { ctx } = makeCtx(a.thread_id)
        const result = yield* def.execute({ target: "b", message: "relative go" }, ctx)

        const drained = yield* control.drainMailbox(b.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("relative go")
        expect(drained[0]?.trigger_turn).toBe(true)
        expect(String(drained[0]?.author)).toBe("/root/a")
        expect(String(drained[0]?.recipient)).toBe("/root/a/b")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("empty message returns model-recoverable error in output, no exception", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "worker", message: "" }, ctx)

        expect(result.metadata.error).toBeDefined()
        expect(result.output.toLowerCase()).toMatch(/empty/)
        // No mailbox delivery happened.
        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(0)
        // No permission ask was issued for an invalid input.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("whitespace-only message returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target: "worker", message: "   \t\n  " },
          ctx,
        )

        expect(result.metadata.error).toBeDefined()
        expect(result.output.toLowerCase()).toMatch(/empty/)
        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(0)
      }),
    ),
  )

  it.live("unknown target returns model-recoverable error (no exception)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute(
          { target: "ghost", message: "anyone home?" },
          ctx,
        )

        expect(result.metadata.error).toBeDefined()
        // No permission ask for a target that can't be resolved.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("targeting /root returns a model-recoverable error mentioning root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        // Spawn one child so the caller (root) can still execute the tool.
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute(
          { target: "/root", message: "do thing" },
          ctx,
        )

        expect(result.metadata.error).toBe("root_target")
        expect(result.output.toLowerCase()).toContain("root")
        // Reject BEFORE asking permission.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("targeting empty string returns reference-invalid error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "", message: "hi" }, ctx)

        expect(result.metadata.error).toBeDefined()
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("ctx.ask is called with permission key 'task' (Wave 3 collapsed) and patterns=[target]", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        yield* def.execute({ target: "worker", message: "go" }, ctx)

        expect(record.asks).toHaveLength(1)
        // Wave 3: per-call key collapsed onto "task". Saved `permission.task`
        // rules gate followup_task. Literal assertion guards revert.
        expect(record.asks[0].permission).toBe("task")
        expect(record.asks[0].permission).toBe(PermissionKey)
        expect(Array.from(record.asks[0].patterns)).toEqual(["worker"])
        expect(Array.from(record.asks[0].always)).toEqual(["*"])
      }),
    ),
  )
})
