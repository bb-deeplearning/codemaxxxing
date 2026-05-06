import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { Cause, Context, DateTime, Effect, Layer, Option, Scope, Stream } from "effect"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import * as InstanceState from "@/effect/instance-state"
import { State, WaveRow } from "./state"
import { Wave } from "./wave"

// Wave auto-loop — drives the campaign forward without user intervention.
//
// Triggered by the user via TUI (arm / pause / resume / interrupt / stop / next).
// Watches the active session's status events and spawns the next pending wave
// when the current one settles, unless the loop is paused.
//
// Coordination with the executor agent (and now the verifier agent):
//   - Loop spawns either an EXECUTOR session (sets wave_status=running) or a
//     VERIFIER session (does not change wave_status; sets active_session_id).
//   - On settle: loop reads STATE.md and decides next action based on
//     wave_status + retry_count + verify_count.
//   - On `awaiting_user`: loop does nothing on settle. The agent paused its
//     turn; user reply will resume the same session as a new turn, which will
//     fire another settle event with the resolved state.
//
// Verifier-vs-executor disambiguation: looked up via Session.get(id).agent.
// Persists across TUI restart (no in-memory state).
//
// Scope discipline: the bus subscriber and the spawned prompt fibers need a
// permanent scope. The layer's scope can be transient when materialized via
// the HTTP API memoMap (the first /wave/* request seeds the layer in the
// request's scope; subsequent requests get the cached layer with a dead
// fiber inside). So everything long-running lives inside InstanceState.make
// — its ScopedCache binds the fiber to the directory's lifetime, not the
// request's. WaveLoop.init() must be called during InstanceBootstrap so the
// state is materialized before any HTTP request triggers it.
//
// On executor crash, loop auto-commits the dirty working tree (if any) so the
// retry session starts from a clean state, and bumps retry_count.

const log = EffectLogger.create({ service: "wave.loop" })

const promptTemplate = (campaignId: string) =>
  `Execute the next wave per @.wave/campaigns/${campaignId}/plan/AGENT_INSTRUCTIONS.md`

const VERIFY_PROMPT =
  "Verify the active wave campaign per your protocol. Infer your mode (post-decompose vs post-execution) from STATE.md."

const RETRY_CAP = 3
const VERIFY_CAP = 3

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly arm: () => Effect.Effect<void>
  readonly pause: () => Effect.Effect<void>
  readonly resume: () => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly next: () => Effect.Effect<void>
  readonly clearCancelled: () => Effect.Effect<void>
  readonly clearQuestion: () => Effect.Effect<void>
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

interface Methods {
  readonly arm: () => Effect.Effect<void>
  readonly pause: () => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly next: () => Effect.Effect<void>
  readonly clearCancelled: () => Effect.Effect<void>
  readonly clearQuestion: () => Effect.Effect<void>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const wave = yield* Wave.Service
    const sessions = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const git = yield* Git.Service

    // Per-directory state. Materialized by init() during bootstrap. The
    // ScopedCache binds every Effect.forkScoped (and any Effect.forkIn(scope)
    // using the captured scope) to the directory's lifetime, NOT the
    // first-HTTP-request scope. Without this wrapping, the bus subscriber
    // dies when the request that triggered layer materialization ends.
    const state = yield* InstanceState.make(
      Effect.fn("WaveLoop.state")(function* () {
        const scope = yield* Scope.Scope

        const commitOnCrash = Effect.fnUntraced(function* (cwd: string, waveN: number) {
          const status = yield* git.status(cwd)
          if (status.length === 0) return null
          const message = `wave ${waveN} (crashed): session ended without state update`
          const add = yield* git.run(["add", "-A"], { cwd })
          if (add.exitCode !== 0) return null
          const commit = yield* git.run(["commit", "-m", message], { cwd })
          if (commit.exitCode !== 0) return null
          const sha = yield* git.run(["rev-parse", "--short", "HEAD"], { cwd })
          if (sha.exitCode !== 0) return null
          return sha.text().trim() || null
        })

        const spawnNext = Effect.fnUntraced(function* () {
          const opt = yield* wave.readActive()
          if (Option.isNone(opt)) return
          const current = opt.value
          if (current.wave_status === "all_complete" || current.wave_status === "running") return
          // Bug 3 guard: refuse to spawn when a session is already in flight.
          if (current.active_session_id !== null) return
          // Bug 2 guard: user-cancelled waves don't auto-retry.
          if (current.failure_kind === "cancelled") return

          const parts = yield* sessionPrompt.resolvePromptParts(promptTemplate(current.campaign_id))
          const modelStr = current.executor_model.trim()
          const { providerID, modelID } = modelStr
            ? Provider.parseModel(modelStr)
            : yield* provider.defaultModel()
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
                active_session_kind: "executor",
                last_updated: stamp,
              }),
              s.current_wave,
              { status: "running", session_id: session.id },
            ),
          )

          // Fork prompt into the InstanceState scope (directory lifetime).
          // Awaiting here would block the spawn caller for the full wave;
          // we react to completion via the bus subscriber below.
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

        const spawnVerifier = Effect.fnUntraced(function* () {
          const opt = yield* wave.readActive()
          if (Option.isNone(opt)) return
          const current = opt.value

          if (current.active_session_id !== null) return
          if (current.failure_kind === "cancelled") return

          if (current.verify_count >= VERIFY_CAP) {
            const stamp = yield* today
            yield* wave.update(current.campaign_id, (s) =>
              new State({
                ...s,
                wave_status: "awaiting_user",
                user_question: `Verifier cap (${VERIFY_CAP}) exhausted. Please review .wave/ manually.`,
                loop_state: "idle",
                active_session_id: null,
                active_session_kind: "",
                last_updated: stamp,
              }),
            )
            return
          }

          const parts = yield* sessionPrompt.resolvePromptParts(VERIFY_PROMPT)
          const { providerID, modelID } = yield* provider.defaultModel()

          const session = yield* sessions.create({
            title: `${current.campaign_id} : verify`,
            agent: "wave_verify",
            model: { id: modelID, providerID },
          })

          const stamp = yield* today
          yield* wave.update(current.campaign_id, (s) =>
            new State({
              ...s,
              active_session_id: session.id,
              active_session_kind: "verifier",
              last_updated: stamp,
            }),
          )

          yield* sessionPrompt
            .prompt({
              sessionID: session.id,
              agent: "wave_verify",
              model: { providerID, modelID },
              parts,
            })
            .pipe(
              Effect.catchCause((cause) =>
                log.warn("verify prompt failed", { campaign: current.campaign_id, cause: Cause.pretty(cause) }),
              ),
              Effect.forkIn(scope),
            )
        })

        const spawnPerState = Effect.fnUntraced(function* (s: State) {
          if (s.verify_count === 0 && s.wave_status === "pending" && s.current_wave === 0) {
            yield* spawnVerifier()
            return
          }
          if (s.wave_status === "pending") {
            yield* spawnNext()
            return
          }
          if (s.wave_status === "failed") {
            if (s.retry_count < RETRY_CAP) yield* spawnNext()
            else yield* spawnVerifier()
            return
          }
          if (s.wave_status === "plan_undoable") {
            yield* spawnVerifier()
            return
          }
        })

        const arm = Effect.fn("WaveLoop.arm")(function* () {
          yield* swallow(
            Effect.gen(function* () {
              const opt = yield* wave.readActive()
              if (Option.isNone(opt)) return
              const current = opt.value
              if (current.wave_status === "all_complete" || current.wave_status === "awaiting_user") return
              const stamp = yield* today
              const armed = yield* wave.update(current.campaign_id, (s) =>
                new State({ ...s, loop_state: "armed", last_updated: stamp }),
              )
              yield* spawnPerState(armed)
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
                    failure_kind: "cancelled",
                    loop_state: "idle",
                    active_session_id: null,
                    active_session_kind: "",
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

        // User-initiated unstuck actions (from dashboard keybinds).
        // clearCancelled: bring an interrupted wave back to pending so the
        // loop will retry it on next arm. The user pressing `c` semantically
        // means "actually, go ahead and try again".
        const clearCancelled = Effect.fn("WaveLoop.clearCancelled")(function* () {
          yield* swallow(
            Effect.gen(function* () {
              const opt = yield* wave.readActive()
              if (Option.isNone(opt)) return
              const current = opt.value
              if (current.failure_kind !== "cancelled") return
              const stamp = yield* today
              const previous = current.waves.find((r) => r.n === current.current_wave)?.notes ?? ""
              yield* wave.update(current.campaign_id, (s) =>
                updateRow(
                  new State({
                    ...s,
                    wave_status: "pending",
                    failure_kind: "",
                    last_updated: stamp,
                  }),
                  s.current_wave,
                  { status: "pending", notes: previous ? `${previous} (cancellation cleared)` : "cancellation cleared" },
                ),
              )
            }),
          )
        })

        // clearQuestion: dismiss an awaiting_user question and mark the wave
        // as user-cancelled. Used when the user wants to abandon a question
        // without responding in chat (e.g. system-generated escalations).
        const clearQuestion = Effect.fn("WaveLoop.clearQuestion")(function* () {
          yield* swallow(
            Effect.gen(function* () {
              const opt = yield* wave.readActive()
              if (Option.isNone(opt)) return
              const current = opt.value
              if (current.wave_status !== "awaiting_user") return
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
                    failure_kind: "cancelled",
                    user_question: "",
                    loop_state: "idle",
                    active_session_id: null,
                    active_session_kind: "",
                    last_updated: stamp,
                  }),
                  s.current_wave,
                  { status: "cancelled", notes: previous ? `${previous} (question dismissed)` : "question dismissed" },
                ),
              )
            }),
          )
        })

        // Background: react to session settle for the active session of the
        // active campaign. Re-reads STATE.md, decides next action.
        // Bound to InstanceState scope (directory lifetime), not request scope.
        yield* Effect.forkScoped(
          bus.subscribe(SessionStatus.Event.Status).pipe(
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                if (evt.properties.status.type !== "idle") return
                const opt = yield* wave.readActive()
                if (Option.isNone(opt)) return
                const s = opt.value
                if (s.active_session_id !== evt.properties.sessionID) return

                if (s.wave_status === "awaiting_user") return

                const sid = SessionID.make(evt.properties.sessionID)
                const isVerifier = yield* sessions
                  .get(sid)
                  .pipe(
                    Effect.map((info) => info.agent === "wave_verify"),
                    Effect.catch(() => Effect.succeed(false)),
                  )

                const stamp = yield* today
                const cwd = yield* InstanceState.directory

                if (s.wave_status === "running" && !isVerifier) {
                  const sha = yield* commitOnCrash(cwd, s.current_wave)
                  yield* wave.update(s.campaign_id, (cs) =>
                    updateRow(
                      new State({
                        ...cs,
                        wave_status: "failed",
                        failure_kind: "crash",
                        retry_count: cs.retry_count + 1,
                        active_session_id: null,
                        active_session_kind: "",
                        last_updated: stamp,
                      }),
                      cs.current_wave,
                      {
                        status: "failed",
                        commit_sha: sha ?? cs.waves.find((r) => r.n === cs.current_wave)?.commit_sha ?? null,
                        notes: `crashed: session ended without state update${sha ? ` (commit ${sha})` : ""}`,
                      },
                    ),
                  )
                } else if (isVerifier && (s.wave_status === "failed" || s.wave_status === "plan_undoable")) {
                  yield* wave.update(s.campaign_id, (cs) =>
                    new State({
                      ...cs,
                      wave_status: "awaiting_user",
                      user_question:
                        "Verifier session ended without progressing the wave. Options: A) edit .wave/ manually and clear failure_kind / wave_status to retry, B) interrupt to mark cancelled.",
                      verify_count: VERIFY_CAP,
                      active_session_id: null,
                      active_session_kind: "",
                      last_updated: stamp,
                    }),
                  )
                  return
                } else {
                  yield* wave.update(s.campaign_id, (cs) =>
                    new State({ ...cs, active_session_id: null, active_session_kind: "", last_updated: stamp }),
                  )
                }

                const fresh = yield* wave.readActive()
                if (Option.isNone(fresh)) return
                const f = fresh.value

                if (f.wave_status === "all_complete") {
                  yield* wave.update(f.campaign_id, (cs) => new State({ ...cs, loop_state: "idle" }))
                  return
                }
                if (f.wave_status === "awaiting_user") return
                if (f.loop_state !== "armed") return
                yield* spawnPerState(f)
              }).pipe(
                Effect.catchCause((cause) => log.warn("loop reaction failed", { cause: Cause.pretty(cause) })),
              ),
            ),
          ),
        )

        log.info("wave loop subscriber active")

        return { arm, pause, interrupt, next, clearCancelled, clearQuestion } satisfies Methods
      }),
    )

    return Service.of({
      init: Effect.fn("WaveLoop.init")(function* () {
        yield* InstanceState.get(state)
      }),
      arm: Effect.fn("WaveLoop.arm.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.arm()
      }),
      pause: Effect.fn("WaveLoop.pause.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.pause()
      }),
      resume: Effect.fn("WaveLoop.resume.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.arm()
      }),
      interrupt: Effect.fn("WaveLoop.interrupt.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.interrupt()
      }),
      stop: Effect.fn("WaveLoop.stop.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.interrupt()
      }),
      next: Effect.fn("WaveLoop.next.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.next()
      }),
      clearCancelled: Effect.fn("WaveLoop.clearCancelled.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.clearCancelled()
      }),
      clearQuestion: Effect.fn("WaveLoop.clearQuestion.proxy")(function* () {
        const m = yield* InstanceState.get(state)
        yield* m.clearQuestion()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(Wave.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Git.defaultLayer),
)

export * as WaveLoop from "./loop"
