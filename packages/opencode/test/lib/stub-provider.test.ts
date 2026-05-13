import { describe, expect, test } from "bun:test"
import { Cause, Effect, Stream } from "effect"
import { LLM } from "@/session/llm"
import {
  assertNoNetworkCalls,
  installNoNetworkGuard,
  NetworkCalledError,
  stubProvider,
} from "./stub-provider"

const asEvent = (value: unknown): LLM.Event => value as unknown as LLM.Event

const dummyInput = (): LLM.StreamInput =>
  ({
    user: undefined,
    sessionID: "ses_test",
    model: { providerID: "test", id: "test-model" },
    agent: { name: "build", mode: "build" },
    system: [],
    messages: [],
    tools: {},
  }) as unknown as LLM.StreamInput

describe("stubProvider", () => {
  test("emits the configured events in order", async () => {
    const events = [
      asEvent({ type: "text-start", id: "t1" }),
      asEvent({ type: "text-delta", id: "t1", text: "hello" }),
      asEvent({ type: "text-end", id: "t1" }),
    ]
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LLM.Service
        return yield* Stream.runCollect(llm.stream(dummyInput()))
      }).pipe(Effect.provide(stubProvider({ events }))),
    )
    expect(result).toEqual(events)
  })

  test("emits a default finish-step and finish event when no script is provided", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LLM.Service
        return yield* Stream.runCollect(llm.stream(dummyInput()))
      }).pipe(Effect.provide(stubProvider())),
    )
    expect(result).toHaveLength(2)
    expect((result[0] as unknown as { type: string }).type).toBe("finish-step")
    expect((result[1] as unknown as { type: string }).type).toBe("finish")
  })

  test("respects latencyMs by sleeping between events", async () => {
    const events = [
      asEvent({ type: "text-start", id: "t1" }),
      asEvent({ type: "text-end", id: "t1" }),
    ]
    const start = Bun.nanoseconds()
    await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LLM.Service
        return yield* Stream.runDrain(llm.stream(dummyInput()))
      }).pipe(Effect.provide(stubProvider({ events, latencyMs: 25 }))),
    )
    const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000
    // 2 events × 25ms each = 50ms minimum. Use a slight buffer for jitter.
    expect(elapsedMs).toBeGreaterThanOrEqual(45)
  })

  test("does not call fetch", async () => {
    const guard = installNoNetworkGuard()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LLM.Service
          yield* Stream.runDrain(llm.stream(dummyInput()))
          yield* assertNoNetworkCalls()
        }).pipe(Effect.provide(stubProvider())),
      )
      expect(guard.count()).toBe(0)
    } finally {
      guard.restore()
    }
  })
})

const fakeFetch = () => Promise.resolve(new Response("ok"))

describe("network guard", () => {
  test("counts intercepted fetch calls", async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch
    const guard = installNoNetworkGuard()
    try {
      await fetch("http://127.0.0.1/whatever")
      expect(guard.count()).toBe(1)
    } finally {
      guard.restore()
      globalThis.fetch = original
    }
  })

  test("assertNoNetworkCalls fails with NetworkCalledError when a fetch occurred", async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch
    const guard = installNoNetworkGuard()
    try {
      await fetch("http://127.0.0.1/leak")
      const exit = await Effect.runPromiseExit(assertNoNetworkCalls())
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const fails = exit.cause.reasons.filter(Cause.isFailReason)
        expect(fails).toHaveLength(1)
        const err = fails[0].error
        expect(err).toBeInstanceOf(NetworkCalledError)
        expect(err.count).toBe(1)
        expect(err.sample).toContain("/leak")
        expect(err.message).toContain("/leak")
        expect(err.message).toContain("1 unexpected")
      }
    } finally {
      guard.restore()
      globalThis.fetch = original
    }
  })

  test("assertNoNetworkCalls succeeds when no guard is installed", async () => {
    await Effect.runPromise(assertNoNetworkCalls())
  })

  test("installNoNetworkGuard returns the same handle when called twice", () => {
    const a = installNoNetworkGuard()
    const b = installNoNetworkGuard()
    try {
      expect(a.count()).toBe(b.count())
    } finally {
      a.restore()
    }
  })

  test("restore swaps fetch back to the original implementation", () => {
    const original = globalThis.fetch
    const guard = installNoNetworkGuard()
    expect(globalThis.fetch).not.toBe(original)
    guard.restore()
    expect(globalThis.fetch).toBe(original)
  })
})
