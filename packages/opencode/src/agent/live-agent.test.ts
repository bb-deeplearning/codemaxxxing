import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { SessionID } from "@/session/schema"
import { AgentPath } from "./agent-path"
import { AgentMetadata } from "./metadata"
import { LiveAgent } from "./live-agent"

const root = AgentPath.root()
const worker = Effect.runSync(AgentPath.from("/root/worker"))
const id = SessionID.descending()

describe("LiveAgent construction", () => {
  test("constructs from a thread_id, metadata, and a literal status", () => {
    const live = new LiveAgent({
      thread_id: id,
      metadata: new AgentMetadata({ agent_id: id, agent_path: worker, agent_nickname: "Plato" }),
      status: "running",
    })
    expect(live.thread_id).toBe(id)
    expect(live.status).toBe("running")
    expect(live.metadata.agent_nickname).toBe("Plato")
    expect(String(live.metadata.agent_path)).toBe("/root/worker")
  })

  test("accepts a struct status (completed)", () => {
    const live = new LiveAgent({
      thread_id: id,
      metadata: new AgentMetadata({ agent_id: id }),
      status: { completed: "done" },
    })
    expect(live.status).toEqual({ completed: "done" })
  })

  test("accepts a struct status (errored)", () => {
    const live = new LiveAgent({
      thread_id: id,
      metadata: new AgentMetadata({ agent_id: id }),
      status: { errored: "exit 1" },
    })
    expect(live.status).toEqual({ errored: "exit 1" })
  })

  test("accepts metadata with no fields populated (early-stage agent)", () => {
    const live = new LiveAgent({
      thread_id: id,
      metadata: new AgentMetadata({}),
      status: "pending_init",
    })
    expect(live.metadata.agent_id).toBeUndefined()
    expect(live.status).toBe("pending_init")
  })
})

describe("LiveAgent schema decode", () => {
  test("decodes a payload with a literal status", () => {
    const decoded = Schema.decodeUnknownSync(LiveAgent)({
      thread_id: id,
      metadata: { agent_id: id, agent_path: "/root", agent_nickname: "Hypatia" },
      status: "shutdown",
    })
    expect(decoded.thread_id).toBe(id)
    expect(decoded.status).toBe("shutdown")
    expect(decoded.metadata.agent_nickname).toBe("Hypatia")
  })

  test("decodes a payload with a struct status", () => {
    const decoded = Schema.decodeUnknownSync(LiveAgent)({
      thread_id: id,
      metadata: { agent_id: id, agent_path: String(root) },
      status: { completed: null },
    })
    expect(decoded.status).toEqual({ completed: null })
  })

  test("rejects a payload missing thread_id", () => {
    const result = Schema.decodeUnknownResult(LiveAgent)({
      metadata: {},
      status: "running",
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects an unknown status literal", () => {
    const result = Schema.decodeUnknownResult(LiveAgent)({
      thread_id: id,
      metadata: {},
      status: "wat",
    })
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("LiveAgent JSON roundtrip", () => {
  test("encodes and decodes back to an equivalent value", () => {
    const original = new LiveAgent({
      thread_id: id,
      metadata: new AgentMetadata({
        agent_id: id,
        agent_path: worker,
        agent_nickname: "Lovelace",
        agent_role: "implementer",
        last_task_message: "wrote the bench",
      }),
      status: { completed: "shipped" },
    })
    const encoded = Schema.encodeUnknownSync(LiveAgent)(original)
    const json = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(LiveAgent)(json)
    expect(decoded.thread_id).toBe(original.thread_id)
    expect(decoded.status).toEqual(original.status)
    expect(String(decoded.metadata.agent_path)).toBe(String(original.metadata.agent_path))
    expect(decoded.metadata.agent_nickname).toBe(original.metadata.agent_nickname)
  })
})
