import { describe, expect } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { testEffect } from "../../test/lib/effect"
import { AgentStatus, type StatusEvent } from "./status"

const it = testEffect(Layer.empty)

const decode = (input: unknown) => Schema.decodeUnknownResult(AgentStatus)(input)

describe("AgentStatus schema", () => {
  it.live("decodes the literal 'pending_init'", () =>
    Effect.sync(() => {
      const r = decode("pending_init")
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toBe("pending_init")
    }),
  )

  it.live("decodes the literal 'running'", () =>
    Effect.sync(() => {
      const r = decode("running")
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toBe("running")
    }),
  )

  it.live("decodes the literal 'interrupted'", () =>
    Effect.sync(() => {
      const r = decode("interrupted")
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toBe("interrupted")
    }),
  )

  it.live("decodes the literal 'shutdown'", () =>
    Effect.sync(() => {
      const r = decode("shutdown")
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toBe("shutdown")
    }),
  )

  it.live("decodes the literal 'not_found'", () =>
    Effect.sync(() => {
      const r = decode("not_found")
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toBe("not_found")
    }),
  )

  it.live("decodes a completed variant carrying a message", () =>
    Effect.sync(() => {
      const r = decode({ completed: "all done" })
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toEqual({ completed: "all done" })
    }),
  )

  it.live("decodes a completed variant with a null message", () =>
    Effect.sync(() => {
      const r = decode({ completed: null })
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toEqual({ completed: null })
    }),
  )

  it.live("decodes an errored variant carrying a reason", () =>
    Effect.sync(() => {
      const r = decode({ errored: "boom" })
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect(r.success).toEqual({ errored: "boom" })
    }),
  )

  it.live("rejects an unknown literal", () =>
    Effect.sync(() => {
      expect(Result.isFailure(decode("running_not_real"))).toBe(true)
    }),
  )

  it.live("rejects a struct with an unknown discriminator", () =>
    Effect.sync(() => {
      expect(Result.isFailure(decode({ wat: "no" }))).toBe(true)
    }),
  )
})

describe("AgentStatus.isFinal", () => {
  it.live("returns false for pending_init", () =>
    Effect.sync(() => expect(AgentStatus.isFinal("pending_init")).toBe(false)),
  )

  it.live("returns false for running", () =>
    Effect.sync(() => expect(AgentStatus.isFinal("running")).toBe(false)),
  )

  it.live("returns false for interrupted (matches codex — interrupt is recoverable)", () =>
    Effect.sync(() => expect(AgentStatus.isFinal("interrupted")).toBe(false)),
  )

  it.live("returns true for shutdown", () =>
    Effect.sync(() => expect(AgentStatus.isFinal("shutdown")).toBe(true)),
  )

  it.live("returns true for not_found", () =>
    Effect.sync(() => expect(AgentStatus.isFinal("not_found")).toBe(true)),
  )

  it.live("returns true for any completed variant", () =>
    Effect.sync(() => {
      expect(AgentStatus.isFinal({ completed: "msg" })).toBe(true)
      expect(AgentStatus.isFinal({ completed: null })).toBe(true)
    }),
  )

  it.live("returns true for any errored variant", () =>
    Effect.sync(() => expect(AgentStatus.isFinal({ errored: "kaboom" })).toBe(true)),
  )
})

describe("AgentStatus.fromSessionEvent", () => {
  const turnStarted = { type: "turn_started" } as const satisfies StatusEvent
  const turnComplete = (msg?: string) =>
    ({ type: "turn_complete", last_agent_message: msg }) as const satisfies StatusEvent
  const turnAborted = (reason: "interrupted" | "budget_limited" | "errored", message?: string) =>
    ({ type: "turn_aborted", reason, message }) as const satisfies StatusEvent
  const errorEvent = (message: string) =>
    ({ type: "error", message }) as const satisfies StatusEvent
  const shutdownComplete = { type: "shutdown_complete" } as const satisfies StatusEvent

  it.live("turn_started maps to running", () =>
    Effect.sync(() => expect(AgentStatus.fromSessionEvent(turnStarted)).toBe("running")),
  )

  it.live("turn_complete with a last message maps to completed(<msg>)", () =>
    Effect.sync(() => {
      expect(AgentStatus.fromSessionEvent(turnComplete("final answer"))).toEqual({ completed: "final answer" })
    }),
  )

  it.live("turn_complete without a last message maps to completed(null)", () =>
    Effect.sync(() => {
      expect(AgentStatus.fromSessionEvent(turnComplete())).toEqual({ completed: null })
    }),
  )

  it.live("turn_aborted with interrupted maps to interrupted", () =>
    Effect.sync(() => expect(AgentStatus.fromSessionEvent(turnAborted("interrupted"))).toBe("interrupted")),
  )

  it.live("turn_aborted with budget_limited maps to interrupted (codex parity)", () =>
    Effect.sync(() => expect(AgentStatus.fromSessionEvent(turnAborted("budget_limited"))).toBe("interrupted")),
  )

  it.live("turn_aborted with errored maps to errored carrying the reason text", () =>
    Effect.sync(() => {
      const status = AgentStatus.fromSessionEvent(turnAborted("errored", "spec violation"))
      expect(status).toEqual({ errored: "spec violation" })
    }),
  )

  it.live("turn_aborted with errored and no message falls back to the reason name", () =>
    Effect.sync(() => {
      const status = AgentStatus.fromSessionEvent(turnAborted("errored"))
      expect(status).toEqual({ errored: "errored" })
    }),
  )

  it.live("error event maps to errored carrying the message", () =>
    Effect.sync(() => {
      expect(AgentStatus.fromSessionEvent(errorEvent("upstream blew up"))).toEqual({ errored: "upstream blew up" })
    }),
  )

  it.live("shutdown_complete maps to shutdown", () =>
    Effect.sync(() => expect(AgentStatus.fromSessionEvent(shutdownComplete)).toBe("shutdown")),
  )

  it.live("an unknown event type returns null (no change)", () =>
    Effect.sync(() => {
      // Cast through unknown — the function's contract is to return null for
      // any event whose `type` is outside the supported set; constructing
      // such a value requires escaping the typed union.
      const r = AgentStatus.fromSessionEvent({ type: "unknown_event" } as unknown as StatusEvent)
      expect(r).toBeNull()
    }),
  )
})
