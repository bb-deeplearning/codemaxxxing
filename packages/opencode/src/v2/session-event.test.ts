// Wave 10: shape-level coverage for the new Agent namespace events. Behavior
// (emission ordering, payload contents) is exercised in the AgentControl and
// agent-wait test files; this file just locks in:
//   - each new event def builds a Schema.Struct over { id, type, data }
//   - the type literal matches the codex parity prefix
//   - the SessionEvent.All union accepts decoding round-trips for each
//   - the SessionEvent.All.match exhaustiveness check accepts the new types
//
// These checks live alongside the schema so any drift in the union surface
// (a missing entry, a wrong literal) fails before more expensive integration
// tests run.

import { Effect, Schema } from "effect"
import { describe, expect, test } from "bun:test"
import { AgentPath } from "@/agent/agent-path"
import { SessionID } from "@/session/schema"
import { SessionEvent } from "./session-event"
import { SessionMessageUpdater } from "./session-message-updater"

const decodeAll = Schema.decodeUnknownSync(SessionEvent.All)

const sid = SessionID.descending()
const samplePath = (s: string) => Effect.runSync(AgentPath.from(s))

const baseSpawnPayload = {
  id: "evt_spawn_test_1",
  type: "session.next.agent.spawn.started" as const,
  data: {
    timestamp: 1_700_000_000_000,
    sessionID: sid,
    call_id: "call_abc",
    task_name: "worker_a",
    child_path: samplePath("/root/worker_a"),
    prompt: "do the thing",
  },
}

describe("SessionEvent Agent namespace types", () => {
  test("Agent.Spawn.Started has the expected literal type", () => {
    expect(SessionEvent.Agent.Spawn.Started.Sync.type).toBe("session.next.agent.spawn.started")
    expect(SessionEvent.Agent.Spawn.Started.Sync.aggregate).toBe("sessionID")
  })

  test("Agent.Spawn.Ended has the expected literal type", () => {
    expect(SessionEvent.Agent.Spawn.Ended.Sync.type).toBe("session.next.agent.spawn.ended")
  })

  test("Agent.Closed has the expected literal type", () => {
    expect(SessionEvent.Agent.Closed.Sync.type).toBe("session.next.agent.closed")
  })

  test("Agent.Wait.Started / Wait.Ended have the expected literal types", () => {
    expect(SessionEvent.Agent.Wait.Started.Sync.type).toBe("session.next.agent.wait.started")
    expect(SessionEvent.Agent.Wait.Ended.Sync.type).toBe("session.next.agent.wait.ended")
  })

  test("Agent.Message.Sent has the expected literal type", () => {
    expect(SessionEvent.Agent.Message.Sent.Sync.type).toBe("session.next.agent.message.sent")
  })
})

describe("SessionEvent.All union accepts each new event", () => {
  test("Spawn.Started", () => {
    const decoded = decodeAll(baseSpawnPayload)
    expect(decoded.type).toBe("session.next.agent.spawn.started")
  })

  test("Spawn.Ended (success path with child_session_id and nickname)", () => {
    const decoded = decodeAll({
      id: "evt_spawn_end_1",
      type: "session.next.agent.spawn.ended",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "call_abc",
        task_name: "worker_a",
        child_path: samplePath("/root/worker_a"),
        child_session_id: SessionID.descending(),
        child_nickname: "plato",
        status: "running",
      },
    })
    expect(decoded.type).toBe("session.next.agent.spawn.ended")
  })

  test("Spawn.Ended (failure path with error tag)", () => {
    const decoded = decodeAll({
      id: "evt_spawn_end_2",
      type: "session.next.agent.spawn.ended",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "call_abc",
        task_name: "dup",
        child_path: samplePath("/root/dup"),
        status: "not_found",
        error: "path_exists",
      },
    })
    expect(decoded.type).toBe("session.next.agent.spawn.ended")
  })

  test("Closed", () => {
    const decoded = decodeAll({
      id: "evt_close_1",
      type: "session.next.agent.closed",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        agent_path: samplePath("/root/done"),
        previous_status: "running",
      },
    })
    expect(decoded.type).toBe("session.next.agent.closed")
  })

  test("Wait.Started", () => {
    const decoded = decodeAll({
      id: "evt_wait_1",
      type: "session.next.agent.wait.started",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "call_w1",
        timeout_ms: 30_000,
      },
    })
    expect(decoded.type).toBe("session.next.agent.wait.started")
  })

  test("Wait.Ended", () => {
    const decoded = decodeAll({
      id: "evt_wait_2",
      type: "session.next.agent.wait.ended",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "call_w1",
        timed_out: true,
      },
    })
    expect(decoded.type).toBe("session.next.agent.wait.ended")
  })

  test("Message.Sent", () => {
    const decoded = decodeAll({
      id: "evt_msg_1",
      type: "session.next.agent.message.sent",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        sender_path: samplePath("/root"),
        target_session_id: SessionID.descending(),
        target_path: samplePath("/root/worker_a"),
        message_length: 12,
        trigger_turn: false,
      },
    })
    expect(decoded.type).toBe("session.next.agent.message.sent")
  })
})

describe("SessionEvent.All.match accepts the new types", () => {
  test("matching Spawn.Started routes to its handler", () => {
    const event = decodeAll(baseSpawnPayload)
    let routed: string | undefined
    SessionEvent.All.match(event, {
      "session.next.agent.switched": () => {},
      "session.next.model.switched": () => {},
      "session.next.prompted": () => {},
      "session.next.synthetic": () => {},
      "session.next.shell.started": () => {},
      "session.next.shell.ended": () => {},
      "session.next.step.started": () => {},
      "session.next.step.ended": () => {},
      "session.next.text.started": () => {},
      "session.next.text.delta": () => {},
      "session.next.text.ended": () => {},
      "session.next.tool.input.started": () => {},
      "session.next.tool.input.delta": () => {},
      "session.next.tool.input.ended": () => {},
      "session.next.tool.called": () => {},
      "session.next.tool.progress": () => {},
      "session.next.tool.success": () => {},
      "session.next.tool.error": () => {},
      "session.next.reasoning.started": () => {},
      "session.next.reasoning.delta": () => {},
      "session.next.reasoning.ended": () => {},
      "session.next.retried": () => {},
      "session.next.compaction.started": () => {},
      "session.next.compaction.delta": () => {},
      "session.next.compaction.ended": () => {},
      "session.next.agent.spawn.started": () => {
        routed = "spawn.started"
      },
      "session.next.agent.spawn.ended": () => {},
      "session.next.agent.closed": () => {},
      "session.next.agent.wait.started": () => {},
      "session.next.agent.wait.ended": () => {},
      "session.next.agent.message.sent": () => {},
    })
    expect(routed).toBe("spawn.started")
  })
})

describe("SessionMessageUpdater no-op handlers for Agent.* events", () => {
  // Wave 10: agent lifecycle events do not produce SessionMessage entries
  // (no chat-visible content). The updater's match block must still include
  // arms for them so the exhaustiveness check passes; these tests drive
  // each arm so the no-op body counts as covered. Behavior assertion:
  // running the updater for each event type leaves the message timeline
  // unchanged.
  const samples = [
    {
      id: "evt_a1",
      type: "session.next.agent.spawn.started" as const,
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "c",
        task_name: "x",
        child_path: samplePath("/root/x"),
        prompt: ".",
      },
    },
    {
      id: "evt_a2",
      type: "session.next.agent.spawn.ended" as const,
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "c",
        task_name: "x",
        child_path: samplePath("/root/x"),
        status: "running" as const,
      },
    },
    {
      id: "evt_a3",
      type: "session.next.agent.closed" as const,
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        agent_path: samplePath("/root/x"),
        previous_status: "running" as const,
      },
    },
    {
      id: "evt_a4",
      type: "session.next.agent.wait.started" as const,
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "c",
        timeout_ms: 30_000,
      },
    },
    {
      id: "evt_a5",
      type: "session.next.agent.wait.ended" as const,
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        call_id: "c",
        timed_out: false,
      },
    },
    {
      id: "evt_a6",
      type: "session.next.agent.message.sent" as const,
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: sid,
        sender_path: samplePath("/root"),
        target_session_id: SessionID.descending(),
        target_path: samplePath("/root/x"),
        message_length: 3,
        trigger_turn: false,
      },
    },
  ]

  for (const sample of samples) {
    test(`${sample.type} leaves the message list unchanged`, () => {
      const state: SessionMessageUpdater.MemoryState = { messages: [] }
      const adapter = SessionMessageUpdater.memory(state)
      const event = decodeAll(sample)
      const after = SessionMessageUpdater.update(adapter, event)
      expect(after.messages).toEqual([])
    })
  }
})
