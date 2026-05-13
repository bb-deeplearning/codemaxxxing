import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
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

export interface Interface {
  /** Append a message; returns its monotonic seq number. Concurrent senders each get a unique seq. */
  readonly send: (msg: InterAgentCommunication) => Effect.Effect<number>
  /** The seq notification channel. Subscribers `Stream.changes` to react. */
  readonly subscribe: () => Effect.Effect<SubscriptionRef.SubscriptionRef<number>>
  /** Take all queued messages in delivery order; leaves the mailbox empty. */
  readonly drain: () => Effect.Effect<readonly InterAgentCommunication[]>
  /** True when at least one message is queued. */
  readonly hasPending: () => Effect.Effect<boolean>
  /** True when at least one queued message has trigger_turn set. */
  readonly hasPendingTriggerTurn: () => Effect.Effect<boolean>
}

interface State {
  seq: number
  messages: readonly InterAgentCommunication[]
}

const initialState: State = { seq: 0, messages: [] }

export const make = (): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState)
    const notify = yield* SubscriptionRef.make(0)

    const send = (msg: InterAgentCommunication): Effect.Effect<number> =>
      Effect.gen(function* () {
        // Atomic seq increment + push. Two concurrent fibers each see their own
        // monotonic seq because Ref.modify is uninterruptible per fiber step.
        const seq = yield* Ref.modify(state, (s) => {
          const next = s.seq + 1
          return [next, { seq: next, messages: [...s.messages, msg] }]
        })
        // Broadcast after the append so any subscriber waking on this notify
        // sees the message via drain(). Codex equivalent at mailbox.rs:46.
        yield* SubscriptionRef.set(notify, seq)
        return seq
      })

    const subscribe = (): Effect.Effect<SubscriptionRef.SubscriptionRef<number>> =>
      Effect.succeed(notify)

    const drain = (): Effect.Effect<readonly InterAgentCommunication[]> =>
      Ref.modify(state, (s) => [s.messages, { ...s, messages: [] }])

    const hasPending = (): Effect.Effect<boolean> =>
      Effect.map(Ref.get(state), (s) => s.messages.length > 0)

    const hasPendingTriggerTurn = (): Effect.Effect<boolean> =>
      Effect.map(Ref.get(state), (s) => s.messages.some((m) => m.trigger_turn))

    return { send, subscribe, drain, hasPending, hasPendingTriggerTurn }
  })

export * as Mailbox from "./mailbox"
