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
import { AgentSpawnTool, errorTagFor } from "./agent-spawn"
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

const initTool = Effect.fn("AgentSpawnToolTest.init")(function* () {
  const info = yield* AgentSpawnTool
  return yield* info.init()
})

describe("errorTagFor maps every typed SpawnError tag", () => {
  it.live("AgentDepthExceededError → depth_exceeded", () =>
    Effect.sync(() => {
      expect(errorTagFor({ _tag: "AgentDepthExceededError" })).toBe("depth_exceeded")
    }),
  )
  it.live("AgentLimitReachedError → limit_reached", () =>
    Effect.sync(() => {
      expect(errorTagFor({ _tag: "AgentLimitReachedError" })).toBe("limit_reached")
    }),
  )
  it.live("AgentPathInvalidError → path_invalid", () =>
    Effect.sync(() => {
      expect(errorTagFor({ _tag: "AgentPathInvalidError" })).toBe("path_invalid")
    }),
  )
  it.live("PathAlreadyExistsError → path_exists", () =>
    Effect.sync(() => {
      expect(errorTagFor({ _tag: "PathAlreadyExistsError" })).toBe("path_exists")
    }),
  )
  it.live("NoNicknameAvailableError → no_nickname", () =>
    Effect.sync(() => {
      expect(errorTagFor({ _tag: "NoNicknameAvailableError" })).toBe("no_nickname")
    }),
  )
})

describe("tool.spawn_agent", () => {
  it.live("happy path: spawn from root returns canonical task_name + nickname; child registered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "do x", task_name: "worker", agent_type: "explore" },
          ctx,
        )

        expect(result.metadata.task_name).toBe("/root/worker")
        expect(typeof result.metadata.nickname).toBe("string")
        expect(typeof result.metadata.child_session_id).toBe("string")
        // Output is JSON of {task_name, nickname}.
        const parsed = JSON.parse(result.output) as { task_name: string; nickname?: string }
        expect(parsed.task_name).toBe("/root/worker")
        expect(typeof parsed.nickname).toBe("string")
        // ctx.ask was called once with the right shape.
        expect(record.asks.length).toBe(1)
        // Wave 3 collapse: PermissionKey moved from "spawn_agent" → "task"
        // (mirror of EDIT_TOOLS where edit/write/apply_patch all consult
        // "edit"). Saved `permission.task: { ... }` rules now gate this
        // surface. Literal-string assertion guards revert.
        expect(record.asks[0].permission).toBe("task")
        expect(Array.from(record.asks[0].patterns)).toEqual(["worker"])
        expect(Array.from(record.asks[0].always)).toEqual(["*"])

        // Registry now has the child — resolve canonical path back to the SessionID.
        const sid = yield* control.resolveAgentReference(AgentPath.root(), "/root/worker", root.id)
        expect(sid).toBe(result.metadata.child_session_id)
      }),
    ),
  )

  it.live("nested spawn: spawn from root, then from child, child has /root/worker/sub", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()

        const first = yield* def.execute(
          { message: "first", task_name: "worker", agent_type: "explore" },
          makeCtx(root.id).ctx,
        )
        const childSessionID = first.metadata.child_session_id as SessionID
        const second = yield* def.execute(
          { message: "second", task_name: "sub", agent_type: "explore" },
          makeCtx(childSessionID).ctx,
        )
        expect(second.metadata.task_name).toBe("/root/worker/sub")
      }),
    ),
  )

  it.live("invalid task_name (uppercase) returns model-recoverable error string in output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({ message: "do x", task_name: "BadName", agent_type: "explore" }, ctx)
        expect(typeof result.output).toBe("string")
        expect(result.output.toLowerCase()).toMatch(/invalid|segment|lowercase|reserved|underscore/)
        expect(result.metadata.error).toBeDefined()
      }),
    ),
  )

  it.live("invalid task_name (empty) returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({ message: "do x", task_name: "", agent_type: "explore" }, ctx)
        expect(result.metadata.error).toBeDefined()
      }),
    ),
  )

  it.live("invalid task_name (slash) returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({ message: "do x", task_name: "a/b", agent_type: "explore" }, ctx)
        expect(result.metadata.error).toBeDefined()
      }),
    ),
  )

  it.live("invalid task_name (dot) returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({ message: "do x", task_name: ".", agent_type: "explore" }, ctx)
        expect(result.metadata.error).toBeDefined()
      }),
    ),
  )

  it.live("duplicate path: spawn 'worker' twice returns model-recoverable error on second call", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()

        const first = yield* def.execute({ message: "first", task_name: "dup", agent_type: "explore" }, makeCtx(root.id).ctx)
        expect(first.metadata.task_name).toBe("/root/dup")

        const second = yield* def.execute({ message: "second", task_name: "dup", agent_type: "explore" }, makeCtx(root.id).ctx)
        expect(second.metadata.error).toBeDefined()
        expect(second.output.toLowerCase()).toMatch(/already|exists/)
      }),
    ),
  )

  it.live("depth limit: 4 levels succeed; 5th level returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()

        const lvl1 = yield* def.execute({ message: ".", task_name: "l1", agent_type: "explore" }, makeCtx(root.id).ctx)
        expect(lvl1.metadata.task_name).toBe("/root/l1")
        const lvl2 = yield* def.execute(
          { message: ".", task_name: "l2", agent_type: "explore" },
          makeCtx(lvl1.metadata.child_session_id as SessionID).ctx,
        )
        const lvl3 = yield* def.execute(
          { message: ".", task_name: "l3", agent_type: "explore" },
          makeCtx(lvl2.metadata.child_session_id as SessionID).ctx,
        )
        const lvl4 = yield* def.execute(
          { message: ".", task_name: "l4", agent_type: "explore" },
          makeCtx(lvl3.metadata.child_session_id as SessionID).ctx,
        )
        expect(lvl4.metadata.task_name).toBe("/root/l1/l2/l3/l4")

        const lvl5 = yield* def.execute(
          { message: ".", task_name: "l5", agent_type: "explore" },
          makeCtx(lvl4.metadata.child_session_id as SessionID).ctx,
        )
        expect(lvl5.metadata.error).toBeDefined()
        expect(lvl5.output.toLowerCase()).toMatch(/depth|exceed/)
      }),
    ),
  )

  it.live("agent_type='explore' lands as agent_role on the spawned LiveAgent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "do x", task_name: "scout", agent_type: "explore" },
          ctx,
        )
        const sid = result.metadata.child_session_id as SessionID
        const meta = yield* control.getAgentMetadata(sid)
        expect(meta?.agent_role).toBe("explore")
      }),
    ),
  )

  it.live("fork_turns='none' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "fn1", fork_turns: "none", agent_type: "explore" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/fn1")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("fork_turns='all' (default-equivalent) passes through", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "fa", fork_turns: "all", agent_type: "explore" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/fa")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("fork_turns='3' parses as integer and passes through", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "f3", fork_turns: "3", agent_type: "explore" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/f3")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("fork_turns='0' returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "f0", fork_turns: "0", agent_type: "explore" },
          ctx,
        )
        expect(result.metadata.error).toBeDefined()
        expect(result.output.toLowerCase()).toMatch(/fork_turns/)
      }),
    ),
  )

  it.live("fork_turns='abc' returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "fbad", fork_turns: "abc", agent_type: "explore" },
          ctx,
        )
        expect(result.metadata.error).toBeDefined()
        expect(result.output.toLowerCase()).toMatch(/fork_turns/)
      }),
    ),
  )

  it.live("output is a JSON string parseable to {task_name, nickname}", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({ message: "x", task_name: "shape", agent_type: "explore" }, ctx)
        const parsed = JSON.parse(result.output) as { task_name: string; nickname?: string }
        expect(parsed.task_name).toBe("/root/shape")
        expect(typeof parsed.nickname).toBe("string")
        // Title contains the canonical path.
        expect(result.title).toContain("/root/shape")
      }),
    ),
  )
})
