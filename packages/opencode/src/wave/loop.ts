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
// Set-phrase contract for the loop's settle inference:
//   - Executor outcomes: pending (success — current_wave advanced), failed
//     (transient), plan_undoable (spec broken), awaiting_user, all_complete.
//   - Verifier outcomes: pending (PATCHED / REWRITTEN / OK-in-post-exec),
//     awaiting_user (USER QUESTION).
//   - Either kind can crash, leaving wave_status unchanged. Detected by:
//     executor crash → wave_status still "running"; verifier crash →
//     wave_status still "failed"/"plan_undoable" with active session being a
//     verifier (per session.agent lookup).
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
    const provider = yield* Provider.Service
    const git = yield* Git.Service
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
      // The settle handler clears active_session_id when a session truly ends;
      // until then, no second spawn.
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

    const spawnVerifier = Effect.fnUntraced(function* () {
      const opt = yield* wave.readActive()
      if (Option.isNone(opt)) return
      const current = opt.value

      // Bug 3 guard: don't double-spawn while a session is in flight.
      if (current.active_session_id !== null) return
      // Bug 2 guard: cancelled waves are user-controlled, not auto-fixable.
      if (current.failure_kind === "cancelled") return

      // Hard cap on verifier sessions per campaign. The verifier's own prompt
      // also enforces a per-session cap via verify_count, but we double-check
      // here to defend against the verifier failing to honor it.
      if (current.verify_count >= VERIFY_CAP) {
        const stamp = yield* today
        yield* wave.update(current.campaign_id, (s) =>
          new State({
            ...s,
            wave_status: "awaiting_user",
            user_question: `Verifier cap (${VERIFY_CAP}) exhausted. Please review .wave/ manually.`,
            loop_state: "idle",
            active_session_id: null,
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

    // Decides which agent to spawn based on current state. Used by arm() and
    // by the settle handler. Caller is responsible for ensuring loop_state is
    // already armed (or that this is a one-shot manual /wave next).
    const spawnPerState = Effect.fnUntraced(function* (state: State) {
      // First-arm post-decompose verify pass.
      if (state.verify_count === 0 && state.wave_status === "pending" && state.current_wave === 0) {
        yield* spawnVerifier()
        return
      }
      if (state.wave_status === "pending") {
        yield* spawnNext()
        return
      }
      if (state.wave_status === "failed") {
        if (state.retry_count < RETRY_CAP) yield* spawnNext()
        else yield* spawnVerifier()
        return
      }
      if (state.wave_status === "plan_undoable") {
        yield* spawnVerifier()
        return
      }
      // running / awaiting_user / all_complete / complete: no spawn.
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
          // Bug 2 fix: user cancellation is "user wants to stop", not "the
          // plan is broken". Mark with failure_kind: cancelled and leave
          // retry_count alone — the spawn paths refuse cancelled waves, so
          // re-arming requires the user to explicitly clear the cancelled
          // status (which signals "actually, try again").
          yield* wave.update(current.campaign_id, (s) =>
            updateRow(
              new State({
                ...s,
                wave_status: "failed",
                failure_kind: "cancelled",
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

    // Background: react to session settle for the active session of the
    // active campaign. Re-reads STATE.md, decides next action.
    yield* Effect.forkScoped(
      bus.subscribe(SessionStatus.Event.Status).pipe(
        Stream.runForEach((evt) =>
          Effect.gen(function* () {
            if (evt.properties.status.type !== "idle") return
            const opt = yield* wave.readActive()
            if (Option.isNone(opt)) return
            const state = opt.value
            if (state.active_session_id !== evt.properties.sessionID) return

            // Session paused awaiting user input. The agent has emitted USER
            // QUESTION and stopped its turn, but the session is still alive —
            // user will reply in chat and the same session will resume as a
            // new turn. Don't clear active_session_id, don't disarm, just wait
            // for the next settle.
            if (state.wave_status === "awaiting_user") return

            // Detect whether the settled session was a verifier or executor by
            // inspecting the session record's agent name. Persists across TUI
            // restart (unlike an in-memory Ref).
            const sid = SessionID.make(evt.properties.sessionID)
            const isVerifier = yield* sessions
              .get(sid)
              .pipe(
                Effect.map((info) => info.agent === "wave_verify"),
                Effect.catch(() => Effect.succeed(false)),
              )

            const stamp = yield* today
            const cwd = yield* InstanceState.directory

            // Crash case 1: executor session ended without updating state.
            if (state.wave_status === "running" && !isVerifier) {
              const sha = yield* commitOnCrash(cwd, state.current_wave)
              yield* wave.update(state.campaign_id, (s) =>
                updateRow(
                  new State({
                    ...s,
                    wave_status: "failed",
                    failure_kind: "crash",
                    retry_count: s.retry_count + 1,
                    active_session_id: null,
                    last_updated: stamp,
                  }),
                  s.current_wave,
                  {
                    status: "failed",
                    commit_sha: sha ?? s.waves.find((r) => r.n === s.current_wave)?.commit_sha ?? null,
                    notes: `crashed: session ended without state update${sha ? ` (commit ${sha})` : ""}`,
                  },
                ),
              )
            }
            // Crash case 2: verifier session ended without progressing state.
            // Bug 1 fix: also bump verify_count to cap so subsequent re-arms
            // (e.g. user toggles wave_status back to failed manually) don't
            // re-spawn the verifier — without this, the loop could churn
            // verifier crash → escalate → user retries → crash → escalate
            // forever. With the cap bumped, future spawn attempts will hit
            // the verify-cap branch and re-escalate to a clearer message.
            else if (isVerifier && (state.wave_status === "failed" || state.wave_status === "plan_undoable")) {
              yield* wave.update(state.campaign_id, (s) =>
                new State({
                  ...s,
                  wave_status: "awaiting_user",
                  user_question:
                    "Verifier session ended without progressing the wave. Options: A) edit .wave/ manually and clear failure_kind / wave_status to retry, B) interrupt to mark cancelled.",
                  verify_count: VERIFY_CAP,
                  active_session_id: null,
                  last_updated: stamp,
                }),
              )
              return
            }
            // Normal settle: agent already updated wave_status to its outcome.
            // Clear active_session_id (session is done).
            else {
              yield* wave.update(state.campaign_id, (s) =>
                new State({ ...s, active_session_id: null, last_updated: stamp }),
              )
            }

            const fresh = yield* wave.readActive()
            if (Option.isNone(fresh)) return
            const f = fresh.value

            if (f.wave_status === "all_complete") {
              yield* wave.update(f.campaign_id, (s) => new State({ ...s, loop_state: "idle" }))
              return
            }
            // awaiting_user shouldn't reach here (short-circuited above), but
            // defensively: don't auto-spawn into it.
            if (f.wave_status === "awaiting_user") return
            if (f.loop_state !== "armed") return
            yield* spawnPerState(f)
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
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Git.defaultLayer),
)

export * as WaveLoop from "./loop"
