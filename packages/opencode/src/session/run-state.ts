import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const flock = yield* EffectFlock.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) throw new Session.BusyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      /* the run lock: at most ONE runLoop per session across every
         instance and process on this host. the sqlite is host-global, so
         the busy truth must be too — the in-memory runner map only covers
         THIS instance (the dual-lap scar: a prompt routed to a different
         instance used to start a second concurrent loop for the same
         session; two laps interleave one transcript until the provider
         rejects it). parked acquisition doubles as the backup consumer:
         if the holder exits just as a prompt lands, the parked loop
         acquires, re-reads storage, and answers; if everything is already
         answered, its first iteration hits the exit condition and returns
         without an LLM call. */
      const locked = flock.withLock(work, `session-run:${sessionID}`).pipe(
        Effect.catchTag("LockTimeoutError", () =>
          /* a LIVE holder ran for the entire park window — its loop
             re-reads storage every iteration and will consume whatever
             prompted us. surface the established busy signal, not a lock
             internals error. */
          Effect.die(new Session.BusyError(sessionID)),
        ),
        Effect.catchTag("LockCompromisedError", (e) => Effect.die(e)),
      )
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(locked)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).startShell(work, ready)
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
)

export * as SessionRunState from "./run-state"
