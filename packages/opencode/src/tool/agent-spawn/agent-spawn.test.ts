import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
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
import { AgentSpawnTool, errorTagFor, Parameters } from "./agent-spawn"
import { disposeAllInstances, provideTmpdirInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"
import { ProviderTest } from "../../../test/fake/provider"

afterEach(async () => {
  await disposeAllInstances()
})

// Bug 3 fix wiring — AgentSpawnTool now resolves Provider.Service to
// validate the `model` / `reasoning_effort` params. The fake provider
// exposes exactly one model (openai/gpt-5.2) with two reasoning variants
// so the tests below can exercise the valid / unknown / invalid paths.
const providerFake = ProviderTest.fake({
  model: ProviderTest.model({ variants: { low: {}, high: {} } }),
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
    providerFake.layer,
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

  it.live("fork_turns='all' passes through (explicit opt-in)", () =>
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

  // D12 (actor-discipline-2026-05-20 Wave 5) — supervision-strategy params.
  // Each test asserts the new on_failure / pool_strategy enum value passes
  // through the Schema layer and reaches `control.spawnAgent` without
  // surfacing an error. Cascading behavior (respawn loop, ignore swallow,
  // pool semantics) is covered by control.test.ts (T1) + invariants (T3).

  it.live("agent_type='nonexistent' returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "nope", agent_type: "build" },
          ctx,
        )
        expect(result.metadata.error).toBe("agent_type_invalid")
        expect(result.output.toLowerCase()).toMatch(/spawnable subagent|available/)
      }),
    ),
  )

  it.live("on_failure='respawn' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "ofr", agent_type: "explore", on_failure: "respawn" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/ofr")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("on_failure='escalate' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "ofe", agent_type: "explore", on_failure: "escalate" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/ofe")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("on_failure='ignore' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "ofi", agent_type: "explore", on_failure: "ignore" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/ofi")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("on_failure='kill_pool' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "ofk", agent_type: "explore", on_failure: "kill_pool" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/ofk")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("pool_strategy='one_for_one' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "ps1", agent_type: "explore", pool_strategy: "one_for_one" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/ps1")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("pool_strategy='one_for_all' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "psa", agent_type: "explore", pool_strategy: "one_for_all" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/psa")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("pool_strategy='rest_for_one' passes through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "psr", agent_type: "explore", pool_strategy: "rest_for_one" },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/psr")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("on_failure + pool_strategy combined pass through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            message: "x",
            task_name: "combo",
            agent_type: "explore",
            on_failure: "respawn",
            pool_strategy: "one_for_all",
          },
          ctx,
        )
        expect(result.metadata.task_name).toBe("/root/combo")
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  // Bug 3 fix (specs/tui-redesign.md known bugs) — model / reasoning_effort
  // were declared but never forwarded. The tests below assert the wire-through
  // path: params → SpawnAgentInput.model → sessions.create (Session.Info.model,
  // whose field is `id`, not `modelID`) — plus the validation guards.

  it.live("model override lands on the created child session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "modeled", agent_type: "explore", model: "openai/gpt-5.2" },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        const child = yield* sessions.get(result.metadata.child_session_id as SessionID)
        expect(String(child.model?.providerID)).toBe("openai")
        expect(String(child.model?.id)).toBe("gpt-5.2")
        expect(child.model?.variant).toBeUndefined()
      }),
    ),
  )

  it.live("model + reasoning_effort forward the variant onto the child session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            message: "x",
            task_name: "modeled_hi",
            agent_type: "explore",
            model: "openai/gpt-5.2",
            reasoning_effort: "high",
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        const child = yield* sessions.get(result.metadata.child_session_id as SessionID)
        expect(String(child.model?.providerID)).toBe("openai")
        expect(String(child.model?.id)).toBe("gpt-5.2")
        expect(child.model?.variant).toBe("high")
      }),
    ),
  )

  it.live("no model param → child session created without a model override", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute({ message: "x", task_name: "nomodel", agent_type: "explore" }, ctx)
        expect(result.metadata.error).toBeUndefined()
        const child = yield* sessions.get(result.metadata.child_session_id as SessionID)
        expect(child.model).toBeUndefined()
      }),
    ),
  )

  it.live("unknown model returns model_unknown and spawns nothing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "badmodel", agent_type: "explore", model: "openai/nope" },
          ctx,
        )
        expect(result.metadata.error).toBe("model_unknown")
        expect(result.output.toLowerCase()).toMatch(/unknown model/)
        // Fails before the permission ask and before any spawn.
        expect(record.asks.length).toBe(0)
      }),
    ),
  )

  it.live("model without a provider/model separator returns model_invalid", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "noslash", agent_type: "explore", model: "claude-x" },
          ctx,
        )
        expect(result.metadata.error).toBe("model_invalid")
        expect(result.output).toMatch(/provider\/model/)
      }),
    ),
  )

  it.live("invalid reasoning_effort fails and lists the valid variants", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            message: "x",
            task_name: "badeffort",
            agent_type: "explore",
            model: "openai/gpt-5.2",
            reasoning_effort: "maximum",
          },
          ctx,
        )
        expect(result.metadata.error).toBe("reasoning_effort_invalid")
        expect(result.output).toContain("low")
        expect(result.output).toContain("high")
      }),
    ),
  )

  it.live("reasoning_effort without model returns reasoning_effort_invalid", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { message: "x", task_name: "effortonly", agent_type: "explore", reasoning_effort: "high" },
          ctx,
        )
        expect(result.metadata.error).toBe("reasoning_effort_invalid")
        expect(result.output.toLowerCase()).toMatch(/requires model/)
      }),
    ),
  )

  it.live("Schema rejects invalid on_failure / pool_strategy literal values", () =>
    Effect.sync(() => {
      const bogusOnFailure = Schema.decodeUnknownExit(Parameters)({
        message: "x",
        task_name: "bad",
        agent_type: "explore",
        on_failure: "bogus",
      } as never)
      expect(bogusOnFailure._tag).toBe("Failure")
      const bogusPoolStrategy = Schema.decodeUnknownExit(Parameters)({
        message: "x",
        task_name: "bad",
        agent_type: "explore",
        pool_strategy: "round_robin",
      } as never)
      expect(bogusPoolStrategy._tag).toBe("Failure")
    }),
  )
})
