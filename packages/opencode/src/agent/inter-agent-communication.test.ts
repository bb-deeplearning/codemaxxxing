import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { AgentPath } from "./agent-path"
import { InterAgentCommunication } from "./inter-agent-communication"

const root = AgentPath.root()
const worker = Effect.runSync(AgentPath.from("/root/worker"))

describe("InterAgentCommunication construction", () => {
  test("constructs with required fields and trigger_turn=false", () => {
    const msg = new InterAgentCommunication({
      author: root,
      recipient: worker,
      content: "hello",
      trigger_turn: false,
      sent_at: 0,
    })
    expect(String(msg.author)).toBe("/root")
    expect(String(msg.recipient)).toBe("/root/worker")
    expect(msg.content).toBe("hello")
    expect(msg.trigger_turn).toBe(false)
    expect(msg.sent_at).toBe(0)
    expect(msg.items).toBeUndefined()
  })

  test("trigger_turn=true is preserved", () => {
    const msg = new InterAgentCommunication({
      author: root,
      recipient: worker,
      content: "wake",
      trigger_turn: true,
      sent_at: 7,
    })
    expect(msg.trigger_turn).toBe(true)
    expect(msg.sent_at).toBe(7)
  })

  test("optional items array is preserved when supplied", () => {
    const msg = new InterAgentCommunication({
      author: root,
      recipient: worker,
      content: "with items",
      trigger_turn: false,
      sent_at: 1,
      items: [{ kind: "image", url: "https://example/x.png" }],
    })
    expect(msg.items).toEqual([{ kind: "image", url: "https://example/x.png" }])
  })

  test("optional abort_reason struct is preserved when supplied (D11 Wave 4)", () => {
    const msg = new InterAgentCommunication({
      author: worker,
      recipient: root,
      content: "ABORT(spec_wrong): bad spec.",
      trigger_turn: true,
      sent_at: 9,
      abort_reason: { reason: "spec_wrong", details: "bad spec." },
    })
    expect(msg.abort_reason?.reason).toBe("spec_wrong")
    expect(msg.abort_reason?.details).toBe("bad spec.")
  })
})

describe("InterAgentCommunication schema validation", () => {
  test("decodes a valid payload", () => {
    const decoded = Schema.decodeUnknownSync(InterAgentCommunication)({
      author: "/root",
      recipient: "/root/worker",
      content: "hi",
      trigger_turn: false,
      sent_at: 3,
    })
    expect(decoded.content).toBe("hi")
    expect(String(decoded.author)).toBe("/root")
    expect(String(decoded.recipient)).toBe("/root/worker")
  })

  test("rejects an invalid agent path", () => {
    const result = Schema.decodeUnknownResult(InterAgentCommunication)({
      author: "/foo",
      recipient: "/root/worker",
      content: "hi",
      trigger_turn: false,
      sent_at: 1,
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects negative sent_at", () => {
    const result = Schema.decodeUnknownResult(InterAgentCommunication)({
      author: "/root",
      recipient: "/root/worker",
      content: "hi",
      trigger_turn: false,
      sent_at: -1,
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects non-boolean trigger_turn", () => {
    const result = Schema.decodeUnknownResult(InterAgentCommunication)({
      author: "/root",
      recipient: "/root/worker",
      content: "hi",
      trigger_turn: "yes",
      sent_at: 1,
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects missing required field", () => {
    const result = Schema.decodeUnknownResult(InterAgentCommunication)({
      author: "/root",
      recipient: "/root/worker",
      trigger_turn: false,
      sent_at: 1,
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("decodes a payload carrying abort_reason (D11 Wave 4)", () => {
    const decoded = Schema.decodeUnknownSync(InterAgentCommunication)({
      author: "/root/worker",
      recipient: "/root",
      content: "ABORT(approach_failed): tried 3x.",
      trigger_turn: true,
      sent_at: 5,
      abort_reason: { reason: "approach_failed", details: "tried 3x." },
    })
    expect(decoded.abort_reason?.reason).toBe("approach_failed")
    expect(decoded.abort_reason?.details).toBe("tried 3x.")
  })
})

describe("InterAgentCommunication JSON roundtrip", () => {
  test("encodes and decodes a message without items", () => {
    const original = new InterAgentCommunication({
      author: root,
      recipient: worker,
      content: "ping",
      trigger_turn: true,
      sent_at: 12,
    })
    const encoded = Schema.encodeUnknownSync(InterAgentCommunication)(original)
    const json = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(InterAgentCommunication)(json)
    expect(String(decoded.author)).toBe(String(original.author))
    expect(String(decoded.recipient)).toBe(String(original.recipient))
    expect(decoded.content).toBe(original.content)
    expect(decoded.trigger_turn).toBe(original.trigger_turn)
    expect(decoded.sent_at).toBe(original.sent_at)
  })

  test("preserves items through a JSON roundtrip", () => {
    const original = new InterAgentCommunication({
      author: worker,
      recipient: root,
      content: "structured",
      trigger_turn: false,
      sent_at: 4,
      items: [{ kind: "text", value: "extra" }],
    })
    const encoded = Schema.encodeUnknownSync(InterAgentCommunication)(original)
    const json = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(InterAgentCommunication)(json)
    expect(decoded.items).toEqual([{ kind: "text", value: "extra" }])
  })

  test("preserves abort_reason through a JSON roundtrip (D11 Wave 4)", () => {
    const original = new InterAgentCommunication({
      author: worker,
      recipient: root,
      content: "ABORT(context_full): hit cap.",
      trigger_turn: true,
      sent_at: 11,
      abort_reason: { reason: "context_full", details: "hit cap." },
    })
    const encoded = Schema.encodeUnknownSync(InterAgentCommunication)(original)
    const json = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(InterAgentCommunication)(json)
    expect(decoded.abort_reason?.reason).toBe("context_full")
    expect(decoded.abort_reason?.details).toBe("hit cap.")
  })
})
