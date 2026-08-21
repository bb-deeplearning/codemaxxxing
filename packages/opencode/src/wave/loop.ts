import { readFile } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { State } from "./state"
import { Wave } from "./wave"

export interface Interface {
  readonly arm: () => Effect.Effect<void, unknown>
  readonly next: () => Effect.Effect<void, unknown>
  readonly pause: () => Effect.Effect<void, unknown>
  readonly resume: () => Effect.Effect<void, unknown>
  readonly interrupt: () => Effect.Effect<void, unknown>
  readonly stop: () => Effect.Effect<void, unknown>
  readonly clearCancelled: () => Effect.Effect<void, unknown>
  readonly clearQuestion: () => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WaveLoop") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const wave = yield* Wave.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service

    const campaignPath = (directory: string, campaign: string, waveNumber: number) =>
      path.join(directory, ".wave", "campaigns", campaign, "plan", "waves", `wave_${waveNumber}`, "WAVE.md")

    const update = (id: string, fn: (state: State) => State) => wave.update(id, fn)

    const next = Effect.fn("WaveLoop.next")(function* () {
      const active = yield* wave.getActive()
      if (active._tag === "None") return
      const ctx = yield* InstanceState.context
      const state = yield* wave.read(active.value)
      const row = state.waves.find((item) => item.n === state.current_wave)
      if (!row || row.status !== "pending") return
      const promptPath = campaignPath(ctx.directory, state.campaign_id, row.n)
      const instructions = yield* Effect.promise(() => readFile(promptPath, "utf8"))
      const session = yield* sessions.create({
        title: `Wave ${row.n}: ${state.campaign_id}`,
        agent: state.executor_agent || undefined,
      })
      yield* update(state.campaign_id, (current) =>
        new State({
          ...current,
          wave_status: "running",
          loop_state: "armed",
          active_session_id: session.id,
          active_session_kind: "executor",
          session_count: current.session_count + 1,
          last_updated: new Date().toISOString(),
          waves: current.waves.map((item) => (item.n === row.n ? { ...item, status: "running", session_id: session.id } : item)),
        }),
      )
      yield* prompt.prompt({
        sessionID: session.id,
        agent: state.executor_agent || undefined,
        parts: [{ type: "text", text: instructions }],
      })
      yield* update(state.campaign_id, (current) =>
        new State({
          ...current,
          current_wave: current.current_wave + 1,
          wave_status: current.current_wave >= current.total_waves ? "all_complete" : "complete",
          loop_state: "idle",
          active_session_id: null,
          active_session_kind: "",
          last_updated: new Date().toISOString(),
          waves: current.waves.map((item) => (item.n === row.n ? { ...item, status: "complete" } : item)),
        }),
      )
    })

    const arm = Effect.fn("WaveLoop.arm")(function* () {
      yield* next()
    })

    const pause = Effect.fn("WaveLoop.pause")(function* () {
      const active = yield* wave.getActive()
      if (active._tag === "None") return
      yield* update(active.value, (state) => new State({ ...state, loop_state: "paused", last_updated: new Date().toISOString() }))
    })

    const resume = Effect.fn("WaveLoop.resume")(function* () {
      const active = yield* wave.getActive()
      if (active._tag === "None") return
      yield* update(active.value, (state) => new State({ ...state, loop_state: "armed", last_updated: new Date().toISOString() }))
      yield* next()
    })

    const stop = Effect.fn("WaveLoop.stop")(function* () {
      const active = yield* wave.getActive()
      if (active._tag === "None") return
      const state = yield* wave.read(active.value)
      if (state.active_session_id) yield* prompt.cancel(state.active_session_id as SessionID)
      yield* update(active.value, (current) =>
        new State({ ...current, loop_state: "idle", active_session_id: null, active_session_kind: "", last_updated: new Date().toISOString() }),
      )
    })

    const interrupt = stop
    const clearCancelled = () => Effect.void
    const clearQuestion = () => Effect.void

    return { arm, next, pause, resume, interrupt, stop, clearCancelled, clearQuestion }
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Wave.node, Session.node, SessionPrompt.node] })

export const defaultLayer = layer

export * as WaveLoop from "./loop"
