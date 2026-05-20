import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { Schema } from "effect"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type { InterAgentCommunication } from "./inter-agent-communication"

// Per-session mailbox primitive ported from codex-rs/core/src/agent/mailbox.rs.
//
// Codex pairs a tokio mpsc channel (storage) with a tokio watch channel
// (notification). MailboxReceiver syncs unread mpsc messages into a local
// VecDeque before answering hasPending / hasPendingTriggerTurn / drain — the
// VecDeque exists because tokio mpsc lacks non-consuming peek.
//
// Effect's `Queue` shares the same limitation. Per the wave's gotcha #1, we
// keep storage in a single `Ref<{ seq, messages }>` and broadcast seq updates
// through a `SubscriptionRef<number>`. The atomic Ref.modify gives every
// concurrent caller a unique seq without a separate counter; the broadcast
// is fire-and-forget, matching codex's `seq_tx.send_replace(seq)` semantics.
//
// Wave 7 (D15 bounded mailbox) — `send` is now bounded by an optional
// per-mailbox `capacity` (default `MAILBOX_DEFAULT_CAPACITY = 32`). Crossing
// the cap fails with `MailboxFullError` rather than queueing indefinitely;
// the caller (agent-send / agent-followup tools) surfaces a structured
// `mailbox_full` retry hint. Per WAVE.md gotcha 5 option (a), a separate
// `sendSystem` path bypasses the cap so the completion watcher's lifecycle
// notifications still reach the parent under backpressure — the conceptual
// "system notification slot" is implemented as the same queue plus an
// uncapped fast-path rather than a literal separate buffer.

/**
 * Default per-mailbox capacity. Cap chosen as a starting number per
 * WAVE.md gotcha 4 — tune from Wave 9 observability.
 */
export const MAILBOX_DEFAULT_CAPACITY = 32

/**
 * Raised by `send` when the mailbox already holds `capacity` messages.
 * The `capacity` field carries the per-mailbox cap so callers can
 * compute a meaningful retry hint (or just print the limit). Internal
 * lifecycle notifications use `sendSystem` and never see this error.
 */
export class MailboxFullError extends Schema.TaggedErrorClass<MailboxFullError>()(
  "MailboxFullError",
  { capacity: Schema.Number },
) {
  override get message(): string {
    return `Mailbox full (capacity=${this.capacity}); retry after backoff or drain.`
  }
}

export interface Interface {
  /**
   * Append a user message; returns its monotonic seq number. Concurrent
   * senders each get a unique seq. Fails with `MailboxFullError` when the
   * mailbox already holds `capacity` messages — the cap is enforced
   * BEFORE the atomic-modify so no half-state lingers.
   */
  readonly send: (msg: InterAgentCommunication) => Effect.Effect<number, MailboxFullError>
  /**
   * Append a SYSTEM message; returns its monotonic seq number. Bypasses
   * the capacity cap — used by control.ts's completion watcher so
   * lifecycle notifications still reach the parent under backpressure.
   * Per WAVE.md gotcha 5 option (a), this is the conceptual reserved
   * "system notification slot" implemented as an uncapped fast-path on
   * the same underlying queue.
   */
  readonly sendSystem: (msg: InterAgentCommunication) => Effect.Effect<number>
  /** The seq notification channel. Subscribers `Stream.changes` to react. */
  readonly subscribe: () => Effect.Effect<SubscriptionRef.SubscriptionRef<number>>
  /** Take all queued messages in delivery order; leaves the mailbox empty. */
  readonly drain: () => Effect.Effect<readonly InterAgentCommunication[]>
  /** True when at least one message is queued. */
  readonly hasPending: () => Effect.Effect<boolean>
  /** True when at least one queued message has trigger_turn set. */
  readonly hasPendingTriggerTurn: () => Effect.Effect<boolean>
  /** Snapshot of current messages without draining. */
  readonly peek: () => Effect.Effect<readonly InterAgentCommunication[]>
}

interface State {
  seq: number
  messages: readonly InterAgentCommunication[]
}

const initialState: State = { seq: 0, messages: [] }

export const make = (capacity: number = MAILBOX_DEFAULT_CAPACITY): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState)
    const notify = yield* SubscriptionRef.make(0)

    // Shared append path. `bypassCap=true` skips the capacity check used
    // by the system-notification surface; user sends go through the
    // capped path. The Ref.modify is the only atomic seq+push site.
    const appendInternal = (msg: InterAgentCommunication) =>
      Effect.gen(function* () {
        const seq = yield* Ref.modify(state, (s) => {
          const next = s.seq + 1
          return [next, { seq: next, messages: [...s.messages, msg] }]
        })
        yield* SubscriptionRef.set(notify, seq)
        return seq
      })

    const send = (msg: InterAgentCommunication): Effect.Effect<number, MailboxFullError> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.messages.length >= capacity) {
          return yield* new MailboxFullError({ capacity })
        }
        return yield* appendInternal(msg)
      })

    const sendSystem = (msg: InterAgentCommunication): Effect.Effect<number> =>
      appendInternal(msg)

    const subscribe = (): Effect.Effect<SubscriptionRef.SubscriptionRef<number>> =>
      Effect.succeed(notify)

    const drain = (): Effect.Effect<readonly InterAgentCommunication[]> =>
      Ref.modify(state, (s) => [s.messages, { ...s, messages: [] }])

    const hasPending = (): Effect.Effect<boolean> =>
      Effect.map(Ref.get(state), (s) => s.messages.length > 0)

    const hasPendingTriggerTurn = (): Effect.Effect<boolean> =>
      Effect.map(Ref.get(state), (s) => s.messages.some((m) => m.trigger_turn))

    const peek = (): Effect.Effect<readonly InterAgentCommunication[]> =>
      Effect.map(Ref.get(state), (s) => s.messages)

    return { send, sendSystem, subscribe, drain, hasPending, hasPendingTriggerTurn, peek }
  })

export * as Mailbox from "./mailbox"
