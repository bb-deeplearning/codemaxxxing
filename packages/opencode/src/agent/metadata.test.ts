import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { SessionID } from "@/session/schema"
import { AgentPath } from "./agent-path"
import { AgentMetadata } from "./metadata"

const root = AgentPath.root()
const worker = Effect.runSync(AgentPath.from("/root/worker"))
const id = SessionID.descending()

describe("AgentMetadata construction", () => {
  test("constructs with no fields — all are optional", () => {
    const meta = new AgentMetadata({})
    expect(meta.agent_id).toBeUndefined()
    expect(meta.agent_path).toBeUndefined()
    expect(meta.agent_nickname).toBeUndefined()
    expect(meta.agent_role).toBeUndefined()
    expect(meta.last_task_message).toBeUndefined()
  })

  test("preserves agent_id when set", () => {
    const meta = new AgentMetadata({ agent_id: id })
    expect(meta.agent_id).toBe(id)
  })

  test("preserves agent_path when set", () => {
    const meta = new AgentMetadata({ agent_path: worker })
    expect(String(meta.agent_path)).toBe("/root/worker")
  })

  test("preserves agent_nickname when set", () => {
    const meta = new AgentMetadata({ agent_nickname: "Plato" })
    expect(meta.agent_nickname).toBe("Plato")
  })

  test("preserves agent_role when set", () => {
    const meta = new AgentMetadata({ agent_role: "researcher" })
    expect(meta.agent_role).toBe("researcher")
  })

  test("preserves last_task_message when set", () => {
    const meta = new AgentMetadata({ last_task_message: "doing X" })
    expect(meta.last_task_message).toBe("doing X")
  })

  test("stores a fully populated metadata", () => {
    const meta = new AgentMetadata({
      agent_id: id,
      agent_path: worker,
      agent_nickname: "Newton",
      agent_role: "explorer",
      last_task_message: "scanning the tree",
    })
    expect(meta.agent_id).toBe(id)
    expect(String(meta.agent_path)).toBe("/root/worker")
    expect(meta.agent_nickname).toBe("Newton")
    expect(meta.agent_role).toBe("explorer")
    expect(meta.last_task_message).toBe("scanning the tree")
  })
})

describe("AgentMetadata schema decode", () => {
  test("decodes a minimal payload", () => {
    const decoded = Schema.decodeUnknownSync(AgentMetadata)({})
    expect(decoded.agent_id).toBeUndefined()
    expect(decoded.agent_path).toBeUndefined()
  })

  test("decodes a full payload with paths and ids", () => {
    const decoded = Schema.decodeUnknownSync(AgentMetadata)({
      agent_id: id,
      agent_path: "/root",
      agent_nickname: "Hypatia",
      agent_role: "analyst",
      last_task_message: "running diagnostics",
    })
    expect(decoded.agent_id).toBe(id)
    expect(String(decoded.agent_path)).toBe("/root")
    expect(decoded.agent_nickname).toBe("Hypatia")
  })

  test("rejects an invalid agent_path", () => {
    const result = Schema.decodeUnknownResult(AgentMetadata)({ agent_path: "/foo" })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects a non-string agent_nickname", () => {
    const result = Schema.decodeUnknownResult(AgentMetadata)({ agent_nickname: 42 })
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("AgentMetadata JSON roundtrip", () => {
  test("encodes and decodes back to an equivalent value", () => {
    const original = new AgentMetadata({
      agent_id: id,
      agent_path: root,
      agent_nickname: "Lovelace",
      agent_role: "implementer",
      last_task_message: "wrote the bench",
    })
    const encoded = Schema.encodeUnknownSync(AgentMetadata)(original)
    const json = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(AgentMetadata)(json)
    expect(decoded.agent_id).toBe(original.agent_id)
    expect(String(decoded.agent_path)).toBe(String(original.agent_path))
    expect(decoded.agent_nickname).toBe(original.agent_nickname)
    expect(decoded.agent_role).toBe(original.agent_role)
    expect(decoded.last_task_message).toBe(original.last_task_message)
  })

  test("omits absent optional fields when re-encoded", () => {
    const original = new AgentMetadata({ agent_nickname: "Maxwell" })
    const encoded = Schema.encodeUnknownSync(AgentMetadata)(original) as Record<string, unknown>
    expect(encoded.agent_nickname).toBe("Maxwell")
    // The optional fields should not appear as explicit `undefined` in the
    // encoded form — Schema.optional encodes to "key absent", not "key=undefined".
    expect("agent_id" in encoded ? encoded.agent_id !== undefined : true).toBe(true)
  })
})
