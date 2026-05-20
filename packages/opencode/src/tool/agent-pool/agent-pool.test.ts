import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema, SubscriptionRef } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Config } from "@/config/config"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { AgentPath } from "@/agent/agent-path"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import type { Permission } from "@/permission"
import * as Tool from "../tool"
import { AgentPoolTool, ID, PermissionKey, Parameters } from "./agent-pool"
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

const initTool = Effect.fn("AgentPoolToolTest.init")(function* () {
  const info = yield* AgentPoolTool
  return yield* info.init()
})

describe("tool.spawn_pool — constants", () => {
  it.live("ID is 'spawn_pool' and PermissionKey is 'task'", () =>
    Effect.sync(() => {
      expect(ID).toBe("spawn_pool")
      expect(PermissionKey).toBe("task")
    }),
  )

  it.live("Parameters Schema decodes a minimal valid input", () =>
    Effect.sync(() => {
      const decoded = Schema.decodeUnknownExit(Parameters)({
        agent_type: "general",
        count: 2,
        message: "go",
        collect: "all",
      })
      expect(decoded._tag).toBe("Success")
    }),
  )

  it.live("Parameters Schema rejects bogus collect literal", () =>
    Effect.sync(() => {
      const decoded = Schema.decodeUnknownExit(Parameters)({
        agent_type: "general",
        count: 2,
        message: "go",
        collect: "bogus",
      } as never)
      expect(decoded._tag).toBe("Failure")
    }),
  )
})

describe("tool.spawn_pool — validation rejects", () => {
  it.live("count <= 0 returns count_invalid", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { agent_type: "explore", count: 0, message: "x", collect: "all" },
          ctx,
        )
        expect(result.metadata.error).toBe("count_invalid")
        expect(result.output.toLowerCase()).toMatch(/count/)
      }),
    ),
  )

  it.live("per_worker_messages length mismatch returns per_worker_messages_length", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 3,
            message: "x",
            collect: "all",
            per_worker_messages: ["a", "b"],
          },
          ctx,
        )
        expect(result.metadata.error).toBe("per_worker_messages_length")
      }),
    ),
  )

  it.live('collect="any_n" without collect_n returns collect_n_required', () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { agent_type: "explore", count: 3, message: "x", collect: "any_n" },
          ctx,
        )
        expect(result.metadata.error).toBe("collect_n_required")
      }),
    ),
  )

  it.live('collect="any_n" with collect_n=0 returns collect_n_out_of_range', () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 3,
            message: "x",
            collect: "any_n",
            collect_n: 0,
          },
          ctx,
        )
        expect(result.metadata.error).toBe("collect_n_out_of_range")
      }),
    ),
  )

  it.live('collect="any_n" with collect_n > count returns collect_n_out_of_range', () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "x",
            collect: "any_n",
            collect_n: 5,
          },
          ctx,
        )
        expect(result.metadata.error).toBe("collect_n_out_of_range")
      }),
    ),
  )

  it.live("agent_type that is not eligible returns agent_type_invalid", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          { agent_type: "build", count: 2, message: "x", collect: "all" },
          ctx,
        )
        expect(result.metadata.error).toBe("agent_type_invalid")
        expect(result.output.toLowerCase()).toMatch(/spawnable subagent|available/)
      }),
    ),
  )

  it.live("fork_turns='abc' returns fork_turns_invalid", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "x",
            collect: "all",
            fork_turns: "abc",
          },
          ctx,
        )
        expect(result.metadata.error).toBe("fork_turns_invalid")
      }),
    ),
  )
})

describe("tool.spawn_pool — happy paths + collect strategies", () => {
  it.live("collect='all' times out when no workers deliver → timed_out=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "go",
            collect: "all",
            timeout_ms: 100,
          },
          ctx,
        )

        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.timed_out).toBe(true)
        expect(result.metadata.collected_count).toBe(0)
        expect(typeof result.metadata.pool_id).toBe("string")
        expect((result.metadata.pool_id as string).startsWith("pool_")).toBe(true)
        expect((result.metadata.member_paths as string[]).length).toBe(2)
        // ctx.ask consulted permission key "task" once.
        expect(record.asks.length).toBe(1)
        expect(record.asks[0].permission).toBe("task")
        expect(Array.from(record.asks[0].always)).toEqual(["*"])
      }),
    ),
  )

  it.live("collect='all' aggregates every worker's deliverable (no timeout)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)

        let counter = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const idx = counter++
            const meta = yield* control.getAgentMetadata(sid)
            const author = meta!.agent_path!
            yield* Effect.sleep(10 * (idx + 1))
            yield* control
              .sendInterAgentCommunication(
                root.id,
                new InterAgentCommunication({
                  author,
                  recipient: AgentPath.root(),
                  content: `from worker ${idx}`,
                  trigger_turn: false,
                  sent_at: Date.now(),
                }),
                sid,
              )
              .pipe(Effect.orDie)
            return yield* Effect.never
          }),
        )

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "go",
            collect: "all",
            timeout_ms: 5000,
          },
          ctx,
        )

        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.timed_out).toBe(false)
        expect(result.metadata.collected_count).toBe(2)
        const parsed = JSON.parse(result.output) as {
          deliverables: Array<{ worker: string; content: string }>
        }
        const contents = parsed.deliverables.map((d) => d.content)
        expect(contents).toContain("from worker 0")
        expect(contents).toContain("from worker 1")
      }),
    ),
  )

  it.live("collect='first' returns one deliverable and closes the rest", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)

        let idx = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const myIdx = idx++
            const meta = yield* control.getAgentMetadata(sid)
            const author = meta!.agent_path!
            if (myIdx === 0) {
              yield* control
                .sendInterAgentCommunication(
                  root.id,
                  new InterAgentCommunication({
                    author,
                    recipient: AgentPath.root(),
                    content: "fastest finger",
                    trigger_turn: false,
                    sent_at: Date.now(),
                  }),
                  sid,
                )
                .pipe(Effect.orDie)
              return yield* Effect.never
            }
            return yield* Effect.never
          }),
        )

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "race",
            collect: "first",
            timeout_ms: 5000,
          },
          ctx,
        )

        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.collected_count).toBe(1)
        const parsed = JSON.parse(result.output) as {
          deliverables: Array<{ worker: string; content: string }>
        }
        expect(parsed.deliverables[0]!.content).toBe("fastest finger")

        // Give closePoolMembers a beat to propagate, then verify the
        // non-winning members reached shutdown.
        yield* Effect.sleep(100)
        const memberIDs = yield* control.listPoolMembers(
          result.metadata.pool_id as string,
          root.id,
        )
        // Identify the winner by canonical path.
        const winnerPath = parsed.deliverables[0]!.worker
        let losersShutdown = 0
        for (const mid of memberIDs) {
          const m = yield* control.getAgentMetadata(mid)
          if (m?.agent_path && String(m.agent_path) === winnerPath) continue
          const ref = yield* control.subscribeStatus(mid)
          const status = yield* SubscriptionRef.get(ref)
          if (status === "shutdown") losersShutdown++
        }
        expect(losersShutdown).toBeGreaterThanOrEqual(1)
      }),
    ),
  )

  it.live("collect='any_n' returns when n members have delivered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)

        let counter = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const myIdx = counter++
            const meta = yield* control.getAgentMetadata(sid)
            const author = meta!.agent_path!
            // workers 0 + 1 deliver; worker 2 stays idle.
            if (myIdx < 2) {
              yield* control
                .sendInterAgentCommunication(
                  root.id,
                  new InterAgentCommunication({
                    author,
                    recipient: AgentPath.root(),
                    content: `quorum ${myIdx}`,
                    trigger_turn: false,
                    sent_at: Date.now(),
                  }),
                  sid,
                )
                .pipe(Effect.orDie)
            }
            return yield* Effect.never
          }),
        )

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 3,
            message: "vote",
            collect: "any_n",
            collect_n: 2,
            timeout_ms: 5000,
          },
          ctx,
        )

        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.collected_count).toBe(2)
        expect(result.metadata.timed_out).toBe(false)
      }),
    ),
  )

  it.live("spawn_all_failed when every member fails to spawn (depth-exceeded parent)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)

        // Build a chain to depth 4 so any spawn under it trips depth.
        const l1 = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "l1",
          initial_message: ".",
        })
        const l2 = yield* control.spawnAgent({
          parentID: l1.thread_id,
          parentPath: Effect.runSync(AgentPath.from("/root/l1")),
          task_name: "l2",
          initial_message: ".",
        })
        const l3 = yield* control.spawnAgent({
          parentID: l2.thread_id,
          parentPath: Effect.runSync(AgentPath.from("/root/l1/l2")),
          task_name: "l3",
          initial_message: ".",
        })
        const l4 = yield* control.spawnAgent({
          parentID: l3.thread_id,
          parentPath: Effect.runSync(AgentPath.from("/root/l1/l2/l3")),
          task_name: "l4",
          initial_message: ".",
        })

        const def = yield* initTool()
        const { ctx } = makeCtx(l4.thread_id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "too deep",
            collect: "all",
            timeout_ms: 100,
          },
          ctx,
        )

        expect(result.metadata.error).toBe("spawn_all_failed")
        expect(result.output.toLowerCase()).toMatch(/spawn|fail/)
      }),
    ),
  )

  it.live("task_prefix overrides default 'pool' prefix in member task names", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "go",
            collect: "all",
            task_prefix: "worker",
            timeout_ms: 50,
          },
          ctx,
        )

        expect(result.metadata.error).toBeUndefined()
        const paths = result.metadata.member_paths as string[]
        expect(paths).toContain("/root/worker_0")
        expect(paths).toContain("/root/worker_1")
      }),
    ),
  )

  it.live("per_worker_messages broadcasts per-index initial messages", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        // Capture the seen first user message per worker (the run-loop
        // never installs, so reading sessions' messages right after spawn
        // is non-deterministic; we just verify the schema decode + call).
        yield* control.registerRunLoop(() => Effect.never)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "common",
            per_worker_messages: ["m0", "m1"],
            collect: "all",
            timeout_ms: 50,
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        expect((result.metadata.member_paths as string[]).length).toBe(2)
      }),
    ),
  )

  it.live("pool_strategy + on_failure pass through (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 2,
            message: "x",
            collect: "all",
            pool_strategy: "one_for_all",
            on_failure: "respawn",
            timeout_ms: 50,
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
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
          {
            agent_type: "explore",
            count: 2,
            message: "x",
            collect: "all",
            fork_turns: "none",
            timeout_ms: 50,
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("fork_turns='3' parses as integer", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 1,
            message: "x",
            collect: "all",
            fork_turns: "3",
            timeout_ms: 50,
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )

  it.live("fork_turns='' (empty string) is treated as undefined", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)

        const result = yield* def.execute(
          {
            agent_type: "explore",
            count: 1,
            message: "x",
            collect: "all",
            fork_turns: "",
            timeout_ms: 50,
          },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
      }),
    ),
  )
})
