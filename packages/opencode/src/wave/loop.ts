import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { Cause, Context, DateTime, Effect, Layer, Option, Scope, Stream } from "effect"
import { Bus } from "@/bus"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { State, WaveRow } from "./state"
import { Wave } from "./wave"

// Wave auto-loop — drives the campaign forward without user intervention.
//
// Triggered by the user via TUI (arm / pause / resume / interrupt / stop / next).
// Watches the active session's status events and spawns the next pending wave
// when the current one settles, unless the loop is paused.
//
// Coordination with the executor agent:
//   - TUI writes STATE.md only when wave_status is pending|complete (between waves).
//   - Agent writes STATE.md only during its turn (when wave_status is running).
//   - Spawn flow: TUI sets wave_status=running + active_session_id, then sends prompt.
//   - Settle flow: agent updates STATE (advances current_wave, sets status pending
//     or failed, clears active_session_id), then turn ends. Loop sees session.idle,
//     re-reads STATE, decides what to do next.
//
// If a session settles without the agent having updated STATE (crash, network,
// agent didn't commit), the loop marks the wave failed and disarms.

const log = EffectLogger.create({ service: "wave.loop" })

const promptTemplate = (campaignId: string) =>
  `Execute the next wave per @.wave/campaigns/${campaignId}/plan/AGENT_INSTRUCTIONS.md`

export interface Interface {
  readonly arm: () => Effect.Effect<void>
  readonly pause: () => Effect.Effect<void>
  readonly resume: () => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly next: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WaveLoop") {}

const updateRow = (state: State, n: number, patch: Partial<WaveRow>): State =>
  new State({
    ...state,
    waves: state.waves.map((row) => (row.n === n ? new WaveRow({ ...row, ...patch }) : row)),
  })

const today = Effect.map(DateTime.nowAsDate, (d) => d.toISOString().slice(0, 10))

const swallow = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
  fx.pipe(Effect.catchCause((cause) => log.warn("wave action failed", { cause: Cause.pretty(cause) })))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const wave = yield* Wave.Service
    const sessions = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    const spawnNext = Effect.fnUntraced(function* () {
      const opt = yield* wave.readActive()
      if (Option.isNone(opt)) return
      const current = opt.value
      if (current.wave_status === "all_complete" || current.wave_status === "running") return

      const parts = yield* sessionPrompt.resolvePromptParts(promptTemplate(current.campaign_id))
      const { providerID, modelID } = Provider.parseModel(current.executor_model)
      const variant = current.executor_variant || undefined

      const session = yield* sessions.create({
        title: `${current.campaign_id} : wave ${current.current_wave}`,
        agent: current.executor_agent,
        model: { id: modelID, providerID, ...(variant ? { variant } : {}) },
      })

      const stamp = yield* today
      yield* wave.update(current.campaign_id, (s) =>
        updateRow(
          new State({
            ...s,
            wave_status: "running",
            active_session_id: session.id,
            last_updated: stamp,
          }),
          s.current_wave,
          { status: "running", session_id: session.id },
        ),
      )

      // Fork into the layer scope — the prompt's lifetime is the wave duration.
      // Awaiting here would block until the wave finishes; we react via the
      // session.status bus event in the background fiber below.
      yield* sessionPrompt
        .prompt({
          sessionID: session.id,
          agent: current.executor_agent,
          ...(variant ? { variant } : {}),
          model: { providerID, modelID },
          parts,
        })
        .pipe(
          Effect.catchCause((cause) =>
            log.warn("wave prompt failed", { campaign: current.campaign_id, cause: Cause.pretty(cause) }),
          ),
          Effect.forkIn(scope),
        )
    })

    const arm = Effect.fn("WaveLoop.arm")(function* () {
      yield* swallow(
        Effect.gen(function* () {
          const opt = yield* wave.readActive()
          if (Option.isNone(opt)) return
          const current = opt.value
          if (current.wave_status === "all_complete") return
          const stamp = yield* today
          yield* wave.update(current.campaign_id, (s) =>
            new State({ ...s, loop_state: "armed", last_updated: stamp }),
          )
          if (current.wave_status === "pending") yield* spawnNext()
        }),
      )
    })

    const pause = Effect.fn("WaveLoop.pause")(function* () {
      yield* swallow(
        Effect.gen(function* () {
          const opt = yield* wave.readActive()
          if (Option.isNone(opt)) return
          const stamp = yield* today
          yield* wave.update(opt.value.campaign_id, (s) =>
            new State({ ...s, loop_state: "paused", last_updated: stamp }),
          )
        }),
      )
    })

    const interrupt = Effect.fn("WaveLoop.interrupt")(function* () {
      yield* swallow(
        Effect.gen(function* () {
          const opt = yield* wave.readActive()
          if (Option.isNone(opt)) return
          const current = opt.value
          if (current.active_session_id) {
            yield* sessionPrompt
              .cancel(SessionID.make(current.active_session_id))
              .pipe(Effect.catch(() => Effect.void))
          }
          const stamp = yield* today
          const previous = current.waves.find((r) => r.n === current.current_wave)?.notes ?? ""
          yield* wave.update(current.campaign_id, (s) =>
            updateRow(
              new State({
                ...s,
                wave_status: "failed",
                loop_state: "idle",
                active_session_id: null,
                last_updated: stamp,
              }),
              s.current_wave,
              { status: "cancelled", notes: previous ? `${previous} (interrupted by user)` : "interrupted by user" },
            ),
          )
        }),
      )
    })

    const next = Effect.fn("WaveLoop.next")(function* () {
      yield* swallow(spawnNext())
    })

    // Background: react to session settle for the active session of the active
    // campaign. Re-reads STATE.md (the agent may have updated it during its
    // turn), then decides the next action.
    yield* Effect.forkScoped(
      bus.subscribe(SessionStatus.Event.Status).pipe(
        Stream.runForEach((evt) =>
          Effect.gen(function* () {
            if (evt.properties.status.type !== "idle") return
            const opt = yield* wave.readActive()
            if (Option.isNone(opt)) return
            const state = opt.value
            if (state.active_session_id !== evt.properties.sessionID) return

            // Settle. The agent should have updated STATE.md; if not, treat as
            // failure (turn ended without the expected state advance).
            if (state.wave_status === "running") {
              const stamp = yield* today
              yield* wave.update(state.campaign_id, (s) =>
                updateRow(
                  new State({
                    ...s,
                    wave_status: "failed",
                    loop_state: "idle",
                    active_session_id: null,
                    last_updated: stamp,
                  }),
                  s.current_wave,
                  { status: "failed", notes: "session ended without state update" },
                ),
              )
              return
            }

            if (state.wave_status === "failed" || state.wave_status === "all_complete") {
              yield* wave.update(state.campaign_id, (s) =>
                new State({ ...s, loop_state: "idle", active_session_id: null }),
              )
              return
            }

            if (state.loop_state === "armed" && state.wave_status === "pending") {
              yield* spawnNext()
            }
          }).pipe(Effect.catchCause((cause) => log.warn("loop reaction failed", { cause: Cause.pretty(cause) }))),
        ),
      ),
    )

    return Service.of({ arm, pause, resume: arm, interrupt, stop: interrupt, next })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(Wave.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export * as WaveLoop from "./loop"
