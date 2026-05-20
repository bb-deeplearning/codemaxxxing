import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Result, Stream, SubscriptionRef } from "effect"
import { testEffect } from "../../test/lib/effect"
import { AgentPath } from "./agent-path"
import { InterAgentCommunication } from "./inter-agent-communication"
import { Mailbox, MAILBOX_DEFAULT_CAPACITY, MailboxFullError } from "./mailbox"

const it = testEffect(Layer.empty)

const root = AgentPath.root()
const worker = Effect.runSync(AgentPath.from("/root/worker"))

const mail = (content: string, trigger_turn = false) =>
  new InterAgentCommunication({
    author: root,
    recipient: worker,
    content,
    trigger_turn,
    sent_at: 0,
  })

describe("Mailbox.make initial state", () => {
  it.live("new mailbox reports zero pending and zero pending trigger turns", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      expect(yield* mb.hasPending()).toBe(false)
      expect(yield* mb.hasPendingTriggerTurn()).toBe(false)
    }),
  )

  it.live("subscribe returns a SubscriptionRef whose initial value is 0", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const ref = yield* mb.subscribe()
      const initial = yield* SubscriptionRef.get(ref)
      expect(initial).toBe(0)
    }),
  )

  it.live("drain on a fresh mailbox returns an empty array", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const out = yield* mb.drain()
      expect(out).toEqual([])
    }),
  )
})

describe("Mailbox.send sequencing", () => {
  it.live("returns monotonically increasing seq numbers starting at 1", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const a = yield* mb.send(mail("a"))
      const b = yield* mb.send(mail("b"))
      const c = yield* mb.send(mail("c"))
      expect(a).toBe(1)
      expect(b).toBe(2)
      expect(c).toBe(3)
    }),
  )

  it.live("send with trigger_turn=false leaves hasPendingTriggerTurn false", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      yield* mb.send(mail("queued", false))
      expect(yield* mb.hasPending()).toBe(true)
      expect(yield* mb.hasPendingTriggerTurn()).toBe(false)
    }),
  )

  it.live("send with trigger_turn=true sets hasPendingTriggerTurn", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      yield* mb.send(mail("wake", true))
      expect(yield* mb.hasPendingTriggerTurn()).toBe(true)
    }),
  )

  it.live("a mix of queued and trigger_turn messages still reports trigger pending", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      yield* mb.send(mail("q1", false))
      yield* mb.send(mail("q2", false))
      yield* mb.send(mail("wake", true))
      yield* mb.send(mail("q3", false))
      expect(yield* mb.hasPendingTriggerTurn()).toBe(true)
    }),
  )
})

describe("Mailbox.drain", () => {
  it.live("returns messages in delivery order then leaves the mailbox empty", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const m1 = mail("one")
      const m2 = mail("two")
      const m3 = mail("three", true)
      yield* mb.send(m1)
      yield* mb.send(m2)
      yield* mb.send(m3)
      const out = yield* mb.drain()
      expect(out.map((m) => m.content)).toEqual(["one", "two", "three"])
      expect(yield* mb.hasPending()).toBe(false)
      expect(yield* mb.hasPendingTriggerTurn()).toBe(false)
      expect(yield* mb.drain()).toEqual([])
    }),
  )

  it.live("drain after a notify-and-wait clears the trigger_turn flag for already-drained messages", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const ref = yield* mb.subscribe()
      // Fork a waiter that resumes once the subscription advances past 0.
      const waiter = yield* SubscriptionRef.changes(ref).pipe(
        Stream.dropWhile((c) => c <= 0),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("200 millis"),
        Effect.forkScoped,
      )
      yield* mb.send(mail("wake", true))
      yield* Fiber.join(waiter)

      // The trigger_turn message is still pending until we drain.
      expect(yield* mb.hasPendingTriggerTurn()).toBe(true)
      const out = yield* mb.drain()
      expect(out.length).toBe(1)
      expect(out[0].trigger_turn).toBe(true)
      expect(yield* mb.hasPendingTriggerTurn()).toBe(false)
    }),
  )
})

describe("Mailbox subscribe wakeup", () => {
  it.live("a subscriber waiting on changes wakes up when send fires", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const ref = yield* mb.subscribe()

      const start = Date.now()
      const waiter = yield* SubscriptionRef.changes(ref).pipe(
        Stream.dropWhile((c) => c <= 0),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("100 millis"),
        Effect.forkScoped,
      )

      yield* mb.send(mail("hello"))
      yield* Fiber.join(waiter)

      const elapsed = Date.now() - start
      // Generous bound — under heavy CI we still expect well under 100ms.
      expect(elapsed).toBeLessThan(100)
    }),
  )

  it.live("subscribe survives multiple sends — each advances the seq", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const ref = yield* mb.subscribe()

      yield* mb.send(mail("a"))
      yield* mb.send(mail("b"))
      yield* mb.send(mail("c"))

      const seq = yield* SubscriptionRef.get(ref)
      expect(seq).toBe(3)
    }),
  )
})

describe("Mailbox.peek (Wave 3 D10)", () => {
  it.live("returns the current messages snapshot without draining", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      yield* mb.send(mail("first"))
      yield* mb.send(mail("second"))

      const peeked = yield* mb.peek()
      expect(peeked.map((m) => m.content)).toEqual(["first", "second"])

      // peek MUST NOT drain — a subsequent drain still returns everything.
      const drained = yield* mb.drain()
      expect(drained.map((m) => m.content)).toEqual(["first", "second"])
      // After drain the peek snapshot reflects the empty mailbox.
      expect(yield* mb.peek()).toEqual([])
    }),
  )

  it.live("peek on a fresh mailbox returns an empty array", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      expect(yield* mb.peek()).toEqual([])
    }),
  )
})

describe("Mailbox concurrency", () => {
  it.live("concurrent sends from N fibers each get a unique seq covering 1..N", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      const N = 10
      const seqs = yield* Effect.all(
        Array.from({ length: N }, (_, i) => mb.send(mail(`m${i}`))),
        { concurrency: "unbounded" },
      )
      const sorted = [...seqs].sort((a, b) => a - b)
      expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1))
      // Mailbox state contains all N messages, regardless of arrival order.
      const drained = yield* mb.drain()
      expect(drained.length).toBe(N)
    }),
  )
})

// D15 (actor-discipline-2026-05-20 Wave 7) — bounded mailbox + backpressure.
// `send` enforces a capacity cap (default MAILBOX_DEFAULT_CAPACITY=32);
// crossing the cap fails with MailboxFullError rather than queueing
// indefinitely. `sendSystem` bypasses the cap so the completion watcher's
// lifecycle notifications still reach the parent even under user-mailbox
// backpressure (WAVE.md gotcha 5 option (a) — the "reserved system slot"
// implemented as an uncapped fast-path on the same underlying queue).
describe("Mailbox D15 bounded capacity", () => {
  it.live("MAILBOX_DEFAULT_CAPACITY is 32", () =>
    Effect.sync(() => {
      expect(MAILBOX_DEFAULT_CAPACITY).toBe(32)
    }),
  )

  it.live("default capacity rejects the 33rd user send with MailboxFullError", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make()
      for (let i = 0; i < MAILBOX_DEFAULT_CAPACITY; i++) {
        yield* mb.send(mail(`m${i}`))
      }
      const overflow = yield* Effect.result(mb.send(mail("overflow")))
      expect(Result.isFailure(overflow)).toBe(true)
      if (Result.isFailure(overflow)) {
        expect(overflow.failure).toBeInstanceOf(MailboxFullError)
        expect((overflow.failure as MailboxFullError).capacity).toBe(
          MAILBOX_DEFAULT_CAPACITY,
        )
      }
      // Queue stays at capacity — overflow was rejected BEFORE any append.
      expect((yield* mb.peek()).length).toBe(MAILBOX_DEFAULT_CAPACITY)
    }),
  )

  it.live("explicit capacity=4 caps user sends; 5th rejects + message text matches", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make(4)
      yield* mb.send(mail("a"))
      yield* mb.send(mail("b"))
      yield* mb.send(mail("c"))
      yield* mb.send(mail("d"))
      const overflow = yield* Effect.result(mb.send(mail("e")))
      expect(Result.isFailure(overflow)).toBe(true)
      if (Result.isFailure(overflow)) {
        const err = overflow.failure as MailboxFullError
        expect(err).toBeInstanceOf(MailboxFullError)
        expect(err.capacity).toBe(4)
        expect(err.message).toContain("capacity=4")
      }
    }),
  )

  it.live("sendSystem bypasses the cap — succeeds even when mailbox is full", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make(2)
      yield* mb.send(mail("u1"))
      yield* mb.send(mail("u2"))
      // User send rejects.
      const overflow = yield* Effect.result(mb.send(mail("u3")))
      expect(Result.isFailure(overflow)).toBe(true)
      // System send still lands.
      const sysSeq = yield* mb.sendSystem(mail("system notification"))
      expect(sysSeq).toBe(3)
      const peeked = yield* mb.peek()
      expect(peeked.length).toBe(3)
      expect(peeked[2]?.content).toBe("system notification")
    }),
  )

  it.live("drain frees capacity — subsequent sends succeed after drain", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make(2)
      yield* mb.send(mail("a"))
      yield* mb.send(mail("b"))
      const firstOverflow = yield* Effect.result(mb.send(mail("c")))
      expect(Result.isFailure(firstOverflow)).toBe(true)

      // Drain frees the slots.
      const drained = yield* mb.drain()
      expect(drained.length).toBe(2)

      // Capacity is freed; new sends succeed.
      yield* mb.send(mail("d"))
      yield* mb.send(mail("e"))
      // And the cap still applies after recovery.
      const overflowAgain = yield* Effect.result(mb.send(mail("f")))
      expect(Result.isFailure(overflowAgain)).toBe(true)
    }),
  )

  it.live("concurrent sends past cap interleave between success and MailboxFullError", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make(3)
      const N = 10
      const results = yield* Effect.all(
        Array.from({ length: N }, (_, i) => Effect.result(mb.send(mail(`m${i}`)))),
        { concurrency: "unbounded" },
      )
      const successes = results.filter((r) => Result.isSuccess(r))
      const failures = results.filter((r) => Result.isFailure(r))
      // Exactly 3 succeed (the cap); the remaining 7 fail.
      expect(successes.length).toBe(3)
      expect(failures.length).toBe(N - 3)
      for (const f of failures) {
        if (Result.isFailure(f)) {
          expect(f.failure).toBeInstanceOf(MailboxFullError)
        }
      }
      expect((yield* mb.peek()).length).toBe(3)
    }),
  )

  it.live("sendSystem advances seq and wakes subscribers like send does", () =>
    Effect.gen(function* () {
      const mb = yield* Mailbox.make(1)
      const ref = yield* mb.subscribe()
      const waiter = yield* SubscriptionRef.changes(ref).pipe(
        Stream.dropWhile((c) => c <= 0),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("200 millis"),
        Effect.forkScoped,
      )
      yield* mb.sendSystem(mail("system wakeup"))
      yield* Fiber.join(waiter)
      const seq = yield* SubscriptionRef.get(ref)
      expect(seq).toBe(1)
    }),
  )
})
