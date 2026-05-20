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
import { AgentCloseTool, PermissionKey } from "./agent-close"
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

        const list = yield* control.listAgents(AgentPath.root(), root.id)
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

        const list = yield* control.listAgents(AgentPath.root(), root.id)
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

        const list = yield* control.listAgents(AgentPath.root(), root.id)
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

        const list = yield* control.listAgents(AgentPath.root(), root.id)
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

  it.live("ctx.ask is called with permission key 'task' (Wave 3 collapsed) and patterns [target]", () =>
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
        // Wave 3 collapse: was "close_agent", now "task".
        expect(record.asks[0]?.permission).toBe("task")
        expect(record.asks[0]?.permission).toBe(PermissionKey)
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

  // D3 (actor-discipline-2026-05-20) — target is optional. Omitting it
  // resolves to the caller's canonical path. Used by the self-close form
  // a subagent reaches for when it knows it wants to close itself but
  // doesn't know its own canonical path (the model's perennial problem).
  it.live("D3: close_agent with omitted target closes the caller (self-close)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "selfcloser",
          initial_message: "init",
        })

        const def = yield* initTool()
        // Caller IS the child. target omitted → resolves to /root/selfcloser.
        const { ctx } = makeCtx(child.thread_id)
        const result = yield* def.execute({}, ctx)
        const payload = JSON.parse(result.output)
        expect(payload.previous_status).toBeDefined()

        const list = yield* control.listAgents(AgentPath.root(), root.id)
        expect(list.find((a) => a.agent_name === "/root/selfcloser")).toBeUndefined()
      }),
    ),
  )

  it.live("D3: target=undefined behaves the same as omitted target", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "explicit_undef",
          initial_message: "init",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        const result = yield* def.execute({ target: undefined }, ctx)
        const payload = JSON.parse(result.output)
        expect(payload.previous_status).toBeDefined()
        const list = yield* control.listAgents(AgentPath.root(), root.id)
        expect(list.find((a) => a.agent_name === "/root/explicit_undef")).toBeUndefined()
      }),
    ),
  )

  // D9 (actor-discipline-2026-05-20) — failed resolution splits into
  // `already_terminated` (path was once registered, now released → success
  // case) vs `path_invalid` (typo / wrong root → real error). The model's
  // re-close after self-termination must look like a no-op, not an error.
  it.live("D9: close_agent on a path that was registered then released returns already_terminated", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "doomed",
          initial_message: "init",
        })
        // Self-close directly via control to remove the path from the
        // registry. The path STAYS in slot.knownPaths (D9 invariant).
        yield* control.closeAgent(child.thread_id, child.thread_id)

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "/root/doomed" }, ctx)

        const meta = (result as { metadata: { error?: string; previous_status?: string } }).metadata
        expect(meta.error).toBe("already_terminated")
        expect(meta.previous_status).toBe("shutdown")
        const payload = JSON.parse(result.output)
        expect(payload.error).toBe("already_terminated")
        // No permission ask — the path is already gone; no need to gate.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("D9: close_agent on a path that was never registered returns path_invalid", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ target: "/root/nonexistent" }, ctx)

        const meta = (result as { metadata: { error?: string } }).metadata
        expect(meta.error).toBe("path_invalid")
        expect(meta.error).not.toBe("already_terminated")
        // No permission ask either — bad path; nothing to do.
        expect(record.asks).toHaveLength(0)
      }),
    ),
  )

  it.live("D9: relative target that was-once-known still resolves to already_terminated", () =>
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
        yield* control.closeAgent(b.thread_id, b.thread_id)

        const def = yield* initTool()
        // Caller is "a"; target "b" relative resolves to /root/a/b — that
        // path is in knownPaths but no longer live.
        const { ctx } = makeCtx(a.thread_id)
        const result = yield* def.execute({ target: "b" }, ctx)
        const meta = (result as { metadata: { error?: string } }).metadata
        expect(meta.error).toBe("already_terminated")
      }),
    ),
  )
})
