// End-to-end walk through every Wave 8 multi-agent v2 tool, exercised
// through the live ToolRegistry so the test asserts both the per-tool
// behavior AND the registry wiring (each tool is registered, each tool's
// description renders, each tool calls AgentControl correctly).
//
// Sequence: spawn_agent → send_message → list_agents → wait_agent →
// followup_task → close_agent. Mirrors the realistic root-agent workflow
// codex traces exhibit.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
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
    AgentControl.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

// Stub the run-loop so spawned agents stay alive in the registry without
// trying to drive a real session. Wave 9 wires the production loop.
const installNeverLoop = Effect.gen(function* () {
  const control = yield* AgentControl.Service
  yield* control.registerRunLoop(() => Effect.never)
})

interface CtxRecord {
  asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>
}

function makeCtx(sessionID: SessionID): { record: CtxRecord; ctx: Tool.Context } {
  const record: CtxRecord = { asks: [] }
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        record.asks.push(input)
      }),
  }
  return { record, ctx }
}

const findTool = (tools: ReadonlyArray<{ id: string }>, id: string) => {
  const tool = tools.find((t) => t.id === id)
  if (!tool) throw new Error(`tool ${id} not registered`)
  return tool as unknown as Tool.Def
}

describe("integration: multi-agent v2 tools (spawn/send/list/wait/followup/close)", () => {
  it.instance("registry registers all six multi-agent tools for the build agent", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const ids = tools.map((t) => t.id)
      expect(ids).toContain("spawn_agent")
      expect(ids).toContain("send_message")
      expect(ids).toContain("followup_task")
      expect(ids).toContain("wait_agent")
      expect(ids).toContain("list_agents")
      expect(ids).toContain("close_agent")
    }),
  )

  it.instance(
    "walks all six tools in sequence: spawn → send → list → wait → followup → close",
    () =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const control = yield* AgentControl.Service
        const build = yield* agents.get("build")
        const tools = yield* registry.tools({ ...ref, agent: build })

        const spawn = findTool(tools, "spawn_agent")
        const send = findTool(tools, "send_message")
        const list = findTool(tools, "list_agents")
        const wait = findTool(tools, "wait_agent")
        const followup = findTool(tools, "followup_task")
        const close = findTool(tools, "close_agent")

        const root = yield* sessions.create({ title: "root" })
        const { ctx: rootCtx, record: rootRecord } = makeCtx(root.id)

        // 1. spawn_agent: root spawns child "worker_a"
        const spawnRes = yield* spawn.execute(
          { message: "do work", task_name: "worker_a", agent_type: "explore" },
          rootCtx,
        )
        expect(rootRecord.asks.at(-1)?.permission).toBe("spawn_agent")
        const spawnPayload = JSON.parse(spawnRes.output)
        expect(spawnPayload.task_name).toBe("/root/worker_a")
        const childID = spawnRes.metadata.child_session_id as SessionID
        expect(typeof childID).toBe("string")
        // The child receives the initial message in its mailbox via spawn.
        const seedDrain = yield* control.drainMailbox(childID)
        expect(seedDrain).toHaveLength(1)
        expect(seedDrain[0]?.content).toBe("do work")
        expect(seedDrain[0]?.trigger_turn).toBe(true)

        // 2. send_message: root queues an FYI in worker_a's mailbox
        const sendRes = yield* send.execute(
          { target: "worker_a", message: "fyi: data file landed" },
          rootCtx,
        )
        expect(rootRecord.asks.at(-1)?.permission).toBe("send_message")
        expect(sendRes.metadata.queued).toBe(true)
        const afterSendDrain = yield* control.drainMailbox(childID)
        expect(afterSendDrain).toHaveLength(1)
        expect(afterSendDrain[0]?.content).toBe("fyi: data file landed")
        expect(afterSendDrain[0]?.trigger_turn).toBe(false)
        expect(String(afterSendDrain[0]?.author)).toBe("/root")

        // 3. list_agents: root sees itself + worker_a
        const listRes = yield* list.execute({}, rootCtx)
        expect(rootRecord.asks.at(-1)?.permission).toBe("list_agents")
        const listPayload = JSON.parse(listRes.output)
        const names = listPayload.agents.map((a: { agent_name: string }) => a.agent_name)
        expect(names).toContain("/root")
        expect(names).toContain("/root/worker_a")
        expect(listRes.metadata.agent_count).toBe(2)

        // 4. wait_agent: from the child, mailbox is now empty after the two
        //    drains above. Use a tiny clamp (gets bumped to 1000ms by the
        //    floor) and assert timed_out=true.
        const { ctx: childCtx } = makeCtx(childID)
        const waitRes = yield* wait.execute({ timeout_ms: 100 }, childCtx)
        const waitPayload = JSON.parse(waitRes.output)
        expect(waitPayload.timed_out).toBe(true)
        expect(waitPayload.message).toBe("Wait timed out.")
        expect(waitRes.metadata.timeout_ms).toBe(1000) // clamped to MIN

        // 5. followup_task: root assigns next work to worker_a (trigger_turn=true)
        const followupRes = yield* followup.execute(
          { target: "worker_a", message: "next: summarise the file" },
          rootCtx,
        )
        expect(rootRecord.asks.at(-1)?.permission).toBe("followup_task")
        expect(followupRes.metadata.trigger_turn).toBe(true)
        const afterFollowupDrain = yield* control.drainMailbox(childID)
        expect(afterFollowupDrain).toHaveLength(1)
        expect(afterFollowupDrain[0]?.content).toBe("next: summarise the file")
        expect(afterFollowupDrain[0]?.trigger_turn).toBe(true)

        // 6. close_agent: root shuts worker_a down
        const closeRes = yield* close.execute({ target: "worker_a" }, rootCtx)
        expect(rootRecord.asks.at(-1)?.permission).toBe("close_agent")
        const closePayload = JSON.parse(closeRes.output)
        expect(closePayload.previous_status).toBeDefined()
        // After close, listAgents no longer reports the child.
        const rootMeta = yield* control.getAgentMetadata(root.id)
        const rootPath = rootMeta?.agent_path ?? AgentPath.root()
        const finalList = yield* control.listAgents(rootPath, root.id)
        expect(finalList.find((a) => a.agent_name === "/root/worker_a")).toBeUndefined()
      }),
    20_000,
  )

  it.instance("followup_task targeting root is rejected as model-recoverable", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const followup = findTool(tools, "followup_task")
      const root = yield* sessions.create({ title: "root" })
      const { ctx } = makeCtx(root.id)
      const res = yield* followup.execute({ target: "/root", message: "hi" }, ctx)
      expect(res.metadata.error).toBe("root_target")
      expect(res.output.toLowerCase()).toContain("root")
    }),
  )

  it.instance("close_agent targeting root is rejected as model-recoverable", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const close = findTool(tools, "close_agent")
      const root = yield* sessions.create({ title: "root" })
      const { ctx } = makeCtx(root.id)
      const res = yield* close.execute({ target: "/root" }, ctx)
      expect(res.metadata.error).toBe("root_target")
      expect(res.output.toLowerCase()).toContain("root")
    }),
  )
})
