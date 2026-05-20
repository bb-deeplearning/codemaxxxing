// agent-link.test.ts — D14 (actor-discipline-2026-05-20 Wave 7) — tests
// for link_agents + unlink_agents. Real AgentControl + Session; no mocks
// of the multi-agent surface. Mirrors agent-pool.test.ts and
// agent-close.test.ts patterns.

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
import {
  LinkAgentsTool,
  UnlinkAgentsTool,
  LINK_ID,
  UNLINK_ID,
  PermissionKey,
  Parameters,
} from "./agent-link"
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

const initLinkTool = Effect.fn("AgentLinkToolTest.initLink")(function* () {
  const info = yield* LinkAgentsTool
  return yield* info.init()
})

const initUnlinkTool = Effect.fn("AgentLinkToolTest.initUnlink")(function* () {
  const info = yield* UnlinkAgentsTool
  return yield* info.init()
})

const ROOT = AgentPath.root()

describe("tool.link_agents / unlink_agents — constants", () => {
  it.live("LINK_ID, UNLINK_ID, PermissionKey are canonical", () =>
    Effect.sync(() => {
      expect(LINK_ID).toBe("link_agents")
      expect(UNLINK_ID).toBe("unlink_agents")
      expect(PermissionKey).toBe("task")
    }),
  )

  it.live("Parameters Schema decodes a minimal valid input", () =>
    Effect.sync(() => {
      const decoded = Schema.decodeUnknownExit(Parameters)({
        target_a: "worker_a",
        target_b: "worker_b",
      })
      expect(decoded._tag).toBe("Success")
    }),
  )

  it.live("Parameters Schema rejects missing target_b", () =>
    Effect.sync(() => {
      const decoded = Schema.decodeUnknownExit(Parameters)({
        target_a: "worker_a",
      } as never)
      expect(decoded._tag).toBe("Failure")
    }),
  )
})

describe("tool.link_agents — happy path + rejections", () => {
  it.live("link two siblings via absolute paths — ctx.ask consulted, linked=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        const b = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initLinkTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.linked).toBe(true)
        expect(result.metadata.target_a_session_id).toBe(a.thread_id)
        expect(result.metadata.target_b_session_id).toBe(b.thread_id)
        expect(result.output).toBe("Linked")
        // ctx.ask consulted permission key "task" exactly once.
        expect(record.asks.length).toBe(1)
        expect(record.asks[0].permission).toBe("task")
        expect(Array.from(record.asks[0].always)).toEqual(["*"])
        // The control-plane adjacency reflects the edge symmetrically.
        const aLinks = yield* control.agentLinks(a.thread_id, root.id)
        const bLinks = yield* control.agentLinks(b.thread_id, root.id)
        expect(aLinks).toContain(b.thread_id)
        expect(bLinks).toContain(a.thread_id)
      }),
    ),
  )

  it.live("self-link rejected with tag self_link before any ctx.ask", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })

        const def = yield* initLinkTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/a" },
          ctx,
        )
        expect(result.metadata.error).toBe("self_link")
        expect(result.output.toLowerCase()).toMatch(/itself/)
        // ctx.ask MUST NOT have fired — rejection lands before permission.
        expect(record.asks.length).toBe(0)
      }),
    ),
  )

  it.live("target_a unresolvable returns target_not_found", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initLinkTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/ghost", target_b: "/root/b" },
          ctx,
        )
        expect(result.metadata.error).toBe("target_not_found")
        expect(result.metadata.target_a).toBe("/root/ghost")
      }),
    ),
  )

  it.live("target_b unresolvable returns target_not_found", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })

        const def = yield* initLinkTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/phantom" },
          ctx,
        )
        expect(result.metadata.error).toBe("target_not_found")
        expect(result.metadata.target_b).toBe("/root/phantom")
      }),
    ),
  )

  it.live("cross-root link rejected with tag cross_root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const rootA = yield* sessions.create({ title: "rootA" })
        const rootB = yield* sessions.create({ title: "rootB" })
        yield* control.registerSessionRoot(rootA.id)
        yield* control.registerSessionRoot(rootB.id)
        yield* control.spawnAgent({
          parentID: rootA.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: rootB.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        // Use rootA as caller; reference rootB's child via an absolute
        // path that does not exist in rootA's slot. resolveAgentReference
        // is per-root scoped, so /root/b under rootA returns target_not_found.
        const def = yield* initLinkTool()
        const { ctx } = makeCtx(rootA.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        // The cross-root attempt surfaces as target_not_found at the
        // resolver layer because resolveAgentReference is scoped to the
        // caller's root. The cross_root tag is reachable only when the
        // model bypasses path resolution (impossible from the tool
        // surface). This test pins the practical behavior.
        expect(result.metadata.error).toBe("target_not_found")
      }),
    ),
  )

  it.live("idempotent — second link of the same pair still returns linked=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initLinkTool()
        const { ctx } = makeCtx(root.id)
        const first = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        expect(first.metadata.linked).toBe(true)
        const second = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        expect(second.metadata.linked).toBe(true)
        // Re-link should not duplicate the edge.
        const aLinks = yield* control.agentLinks(a.thread_id, root.id)
        expect(aLinks.length).toBe(1)
      }),
    ),
  )
})

describe("tool.unlink_agents — happy path + idempotent", () => {
  it.live("unlink previously-linked pair — linked=false; control-plane edge dropped", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        const b = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })
        yield* control.linkAgents(a.thread_id, b.thread_id, root.id)

        const def = yield* initUnlinkTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.linked).toBe(false)
        expect(result.output).toBe("Unlinked")
        expect(record.asks.length).toBe(1)
        expect(record.asks[0].permission).toBe("task")
        const aLinks = yield* control.agentLinks(a.thread_id, root.id)
        const bLinks = yield* control.agentLinks(b.thread_id, root.id)
        expect(aLinks).toEqual([])
        expect(bLinks).toEqual([])
      }),
    ),
  )

  it.live("unlink on never-linked pair is a no-op success", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initUnlinkTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        expect(result.metadata.error).toBeUndefined()
        expect(result.metadata.linked).toBe(false)
      }),
    ),
  )

  it.live("unlink target_a unresolvable returns target_not_found", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initUnlinkTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/ghost", target_b: "/root/b" },
          ctx,
        )
        expect(result.metadata.error).toBe("target_not_found")
        expect(result.metadata.target_a).toBe("/root/ghost")
      }),
    ),
  )

  it.live("unlink target_b unresolvable returns target_not_found", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })

        const def = yield* initUnlinkTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/phantom" },
          ctx,
        )
        expect(result.metadata.error).toBe("target_not_found")
        expect(result.metadata.target_b).toBe("/root/phantom")
      }),
    ),
  )

  it.live("unlink cross-root attempt surfaces as target_not_found (per-root scoped resolver)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const rootA = yield* sessions.create({ title: "rootA" })
        const rootB = yield* sessions.create({ title: "rootB" })
        yield* control.registerSessionRoot(rootA.id)
        yield* control.registerSessionRoot(rootB.id)
        yield* control.spawnAgent({
          parentID: rootA.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: rootB.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const def = yield* initUnlinkTool()
        const { ctx } = makeCtx(rootA.id)
        const result = yield* def.execute(
          { target_a: "/root/a", target_b: "/root/b" },
          ctx,
        )
        // /root/b is registered under rootB, not rootA; the per-root
        // resolver returns target_not_found rather than letting the
        // cross-root primitive silently no-op.
        expect(result.metadata.error).toBe("target_not_found")
      }),
    ),
  )
})
