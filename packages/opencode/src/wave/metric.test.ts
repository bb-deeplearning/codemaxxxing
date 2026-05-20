import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Bus } from "@/bus"
import { Metric } from "./metric"
import { AgentPath } from "@/agent/agent-path"
import { SessionID } from "@/session/schema"
import { testEffect } from "../../test/lib/effect"

// Wave 9 (actor-discipline-2026-05-20) — unit tests for D18 observability
// metrics. Three surfaces:
//
//   1. Schema decode for every event type (caller can't pass invalid shapes).
//   2. Rate helper math (the four `*Rate` pure functions).
//   3. Bus end-to-end (publish via `Bus.Service`, observe via callback;
//      verifies the BusEvent definitions are registered and routable).

const SAMPLE_SESSION = SessionID.descending("ses_test_metric")
const SAMPLE_CHILD = SessionID.descending("ses_test_child")
const SAMPLE_PATH = AgentPath.root()

describe("Metric.DeliverableSource", () => {
  test("decodes the three known literals", () => {
    expect(Schema.decodeUnknownSync(Metric.DeliverableSource)("explicit_send")).toBe(
      "explicit_send",
    )
    expect(Schema.decodeUnknownSync(Metric.DeliverableSource)("extracted")).toBe("extracted")
    expect(Schema.decodeUnknownSync(Metric.DeliverableSource)("safety_net")).toBe("safety_net")
  })

  test("rejects unknown source values", () => {
    expect(() => Schema.decodeUnknownSync(Metric.DeliverableSource)("garbage")).toThrow()
  })
})

describe("Metric.Event schemas", () => {
  test("DeliverableArrived round-trips through its schema", () => {
    const payload = {
      sessionID: SAMPLE_SESSION,
      timestamp: 1_700_000_000_000,
      child_path: SAMPLE_PATH,
      child_session_id: SAMPLE_CHILD,
      source: "explicit_send" as const,
      body_length: 1234,
    }
    const decoded = Schema.decodeUnknownSync(Metric.Event.DeliverableArrived.properties)(payload)
    expect(decoded.source).toBe("explicit_send")
    expect(decoded.body_length).toBe(1234)
  })

  test("DeliverableArrived rejects negative body_length", () => {
    expect(() =>
      Schema.decodeUnknownSync(Metric.Event.DeliverableArrived.properties)({
        sessionID: SAMPLE_SESSION,
        timestamp: 1,
        child_path: SAMPLE_PATH,
        child_session_id: SAMPLE_CHILD,
        source: "explicit_send",
        body_length: -1,
      }),
    ).toThrow()
  })

  test("SafetyNetFired round-trips through its schema", () => {
    const decoded = Schema.decodeUnknownSync(Metric.Event.SafetyNetFired.properties)({
      sessionID: SAMPLE_SESSION,
      timestamp: 1,
      child_path: SAMPLE_PATH,
      child_session_id: SAMPLE_CHILD,
    })
    expect(decoded.sessionID).toBe(SAMPLE_SESSION)
  })

  test("SiblingDeadlock carries tool_id discriminator", () => {
    const decoded = Schema.decodeUnknownSync(Metric.Event.SiblingDeadlock.properties)({
      sessionID: SAMPLE_SESSION,
      timestamp: 1,
      timeout_ms: 30_000,
      tool_id: "wait_for_reply",
    })
    expect(decoded.tool_id).toBe("wait_for_reply")
    expect(decoded.timeout_ms).toBe(30_000)
  })

  test("SubagentToolError carries tool_id + error_kind", () => {
    const decoded = Schema.decodeUnknownSync(Metric.Event.SubagentToolError.properties)({
      sessionID: SAMPLE_SESSION,
      timestamp: 1,
      tool_id: "send_message",
      error_kind: "mailbox_full",
    })
    expect(decoded.tool_id).toBe("send_message")
    expect(decoded.error_kind).toBe("mailbox_full")
  })

  test("event types use the agent.metric.* prefix", () => {
    expect(Metric.Event.DeliverableArrived.type).toBe("agent.metric.deliverable_arrived")
    expect(Metric.Event.SafetyNetFired.type).toBe("agent.metric.safety_net_fired")
    expect(Metric.Event.SiblingDeadlock.type).toBe("agent.metric.sibling_deadlock")
    expect(Metric.Event.SubagentToolError.type).toBe("agent.metric.subagent_tool_error")
  })
})

describe("Metric.deliverableArrivalRate", () => {
  test("returns 0 for empty input", () => {
    expect(Metric.deliverableArrivalRate([])).toBe(0)
  })

  test("returns 1 when every event delivered substantively", () => {
    expect(
      Metric.deliverableArrivalRate([
        { source: "explicit_send" },
        { source: "extracted" },
        { source: "explicit_send" },
      ]),
    ).toBe(1)
  })

  test("returns 0 when every event tripped the safety net", () => {
    expect(
      Metric.deliverableArrivalRate([{ source: "safety_net" }, { source: "safety_net" }]),
    ).toBe(0)
  })

  test("mixed input returns the fraction (non-safety / total)", () => {
    expect(
      Metric.deliverableArrivalRate([
        { source: "explicit_send" },
        { source: "safety_net" },
        { source: "extracted" },
        { source: "safety_net" },
      ]),
    ).toBe(0.5)
  })
})

describe("Metric.safetyNetFiringRate", () => {
  test("returns 0 for empty input", () => {
    expect(Metric.safetyNetFiringRate([])).toBe(0)
  })

  test("returns 1 when every event tripped the safety net", () => {
    expect(
      Metric.safetyNetFiringRate([{ source: "safety_net" }, { source: "safety_net" }]),
    ).toBe(1)
  })

  test("returns 0 when no event tripped the safety net", () => {
    expect(
      Metric.safetyNetFiringRate([{ source: "explicit_send" }, { source: "extracted" }]),
    ).toBe(0)
  })

  test("returns the safety_net fraction across mixed events", () => {
    expect(
      Metric.safetyNetFiringRate([
        { source: "explicit_send" },
        { source: "safety_net" },
        { source: "extracted" },
        { source: "safety_net" },
      ]),
    ).toBe(0.5)
  })

  test("is the inverse of deliverableArrivalRate across the same input", () => {
    const events = [
      { source: "explicit_send" as const },
      { source: "safety_net" as const },
      { source: "extracted" as const },
    ]
    expect(
      Metric.deliverableArrivalRate(events) + Metric.safetyNetFiringRate(events),
    ).toBeCloseTo(1)
  })
})

describe("Metric.siblingDeadlockRate", () => {
  test("returns 0 for empty input", () => {
    expect(Metric.siblingDeadlockRate([])).toBe(0)
  })

  test("returns 1 when every wait timed out", () => {
    expect(
      Metric.siblingDeadlockRate([{ timed_out: true }, { timed_out: true }, { timed_out: true }]),
    ).toBe(1)
  })

  test("returns 0 when every wait succeeded", () => {
    expect(
      Metric.siblingDeadlockRate([{ timed_out: false }, { timed_out: false }]),
    ).toBe(0)
  })

  test("returns the timed-out fraction across mixed waits", () => {
    expect(
      Metric.siblingDeadlockRate([
        { timed_out: true },
        { timed_out: false },
        { timed_out: false },
        { timed_out: true },
      ]),
    ).toBe(0.5)
  })
})

describe("Metric.subagentToolErrorRate", () => {
  test("returns 0 for empty input", () => {
    expect(Metric.subagentToolErrorRate([])).toBe(0)
  })

  test("returns 0 when every tool call succeeded", () => {
    expect(
      Metric.subagentToolErrorRate([{ ok: true }, { ok: true }, { ok: true }]),
    ).toBe(0)
  })

  test("returns 1 when every tool call errored", () => {
    expect(
      Metric.subagentToolErrorRate([{ ok: false }, { ok: false }]),
    ).toBe(1)
  })

  test("returns the error fraction across mixed calls", () => {
    expect(
      Metric.subagentToolErrorRate([
        { ok: true },
        { ok: false },
        { ok: true },
        { ok: false },
      ]),
    ).toBe(0.5)
  })
})

// Bus end-to-end — verifies the four event definitions are wired correctly
// against `Bus.Service`. The subscribe-then-publish dance follows the
// `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch` GOTCHA
// (in-effect Service method, not the top-level helper).
const it = testEffect(Layer.mergeAll(Bus.defaultLayer))

describe("Metric.Event bus emission", () => {
  it.instance("DeliverableArrived publishes and is observable via Bus.Service", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const collected: Array<{ source: string; body_length: number }> = []
      const unsubscribe = yield* bus.subscribeCallback(
        Metric.Event.DeliverableArrived,
        (evt) =>
          collected.push({ source: evt.properties.source, body_length: evt.properties.body_length }),
      )
      yield* bus.publish(Metric.Event.DeliverableArrived, {
        sessionID: SAMPLE_SESSION,
        timestamp: Date.now(),
        child_path: SAMPLE_PATH,
        child_session_id: SAMPLE_CHILD,
        source: "explicit_send",
        body_length: 42,
      })
      // Bus.publish → PubSub.publish → subscriber callback fires on the next
      // tick. Yield once before asserting.
      yield* Effect.sleep("20 millis")
      expect(collected.length).toBeGreaterThanOrEqual(1)
      expect(collected[0]?.source).toBe("explicit_send")
      expect(collected[0]?.body_length).toBe(42)
      unsubscribe()
    }),
  )

  it.instance("SafetyNetFired publishes and is observable via Bus.Service", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const collected: Array<{ child_path: string }> = []
      const unsubscribe = yield* bus.subscribeCallback(
        Metric.Event.SafetyNetFired,
        (evt) => collected.push({ child_path: String(evt.properties.child_path) }),
      )
      yield* bus.publish(Metric.Event.SafetyNetFired, {
        sessionID: SAMPLE_SESSION,
        timestamp: Date.now(),
        child_path: SAMPLE_PATH,
        child_session_id: SAMPLE_CHILD,
      })
      yield* Effect.sleep("20 millis")
      expect(collected.length).toBeGreaterThanOrEqual(1)
      expect(collected[0]?.child_path).toBe(String(SAMPLE_PATH))
      unsubscribe()
    }),
  )

  it.instance("SiblingDeadlock publishes with tool_id discriminator", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const collected: Array<{ tool_id: string; timeout_ms: number }> = []
      const unsubscribe = yield* bus.subscribeCallback(
        Metric.Event.SiblingDeadlock,
        (evt) =>
          collected.push({
            tool_id: evt.properties.tool_id,
            timeout_ms: evt.properties.timeout_ms,
          }),
      )
      yield* bus.publish(Metric.Event.SiblingDeadlock, {
        sessionID: SAMPLE_SESSION,
        timestamp: Date.now(),
        timeout_ms: 30_000,
        tool_id: "wait_for_reply",
      })
      yield* Effect.sleep("20 millis")
      expect(collected.length).toBeGreaterThanOrEqual(1)
      expect(collected[0]?.tool_id).toBe("wait_for_reply")
      expect(collected[0]?.timeout_ms).toBe(30_000)
      unsubscribe()
    }),
  )

  it.instance("SubagentToolError publishes with tool_id + error_kind", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const collected: Array<{ tool_id: string; error_kind: string }> = []
      const unsubscribe = yield* bus.subscribeCallback(
        Metric.Event.SubagentToolError,
        (evt) =>
          collected.push({
            tool_id: evt.properties.tool_id,
            error_kind: evt.properties.error_kind,
          }),
      )
      yield* bus.publish(Metric.Event.SubagentToolError, {
        sessionID: SAMPLE_SESSION,
        timestamp: Date.now(),
        tool_id: "send_message",
        error_kind: "mailbox_full",
      })
      yield* Effect.sleep("20 millis")
      expect(collected.length).toBeGreaterThanOrEqual(1)
      expect(collected[0]?.tool_id).toBe("send_message")
      expect(collected[0]?.error_kind).toBe("mailbox_full")
      unsubscribe()
    }),
  )

  it.instance("Stream-based subscribe also routes Metric.Event payloads", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const fiber = yield* bus
        .subscribe(Metric.Event.DeliverableArrived)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.sleep("20 millis")
      yield* bus.publish(Metric.Event.DeliverableArrived, {
        sessionID: SAMPLE_SESSION,
        timestamp: Date.now(),
        child_path: SAMPLE_PATH,
        child_session_id: SAMPLE_CHILD,
        source: "extracted",
        body_length: 7,
      })
      const collected = yield* Fiber.await(fiber)
      expect(collected._tag).toBe("Success")
    }),
  )
})
