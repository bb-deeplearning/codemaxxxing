import { Effect, Option } from "effect"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import * as Log from "@opencode-ai/core/util/log"
import { AppRuntime } from "@/effect/app-runtime"
import { Wave } from "@/wave/wave"
import { WaveLoop } from "@/wave/loop"
import type { State } from "@/wave/state"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"

const log = Log.create({ service: "tui.wave" })

const REFRESH_INTERVAL_MS = 2_000

export interface WaveStore {
  campaigns: ReadonlyArray<string>
  active: string | null
  state: State | null
}

const empty: WaveStore = { campaigns: [], active: null, state: null }

const loadProgram = Effect.gen(function* () {
  const wave = yield* Wave.Service
  const campaigns = yield* wave.listCampaigns()
  const activeOpt = yield* wave.getActive()
  const stateOpt = yield* wave.readActive()
  return {
    campaigns,
    active: Option.getOrNull(activeOpt),
    state: Option.getOrNull(stateOpt),
  } satisfies WaveStore
})

const loopAction = (fn: (s: WaveLoop.Interface) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const loop = yield* WaveLoop.Service
    yield* fn(loop)
  }).pipe(Effect.catch(() => Effect.void))

const waveAction = (fn: (s: Wave.Interface) => Effect.Effect<unknown, unknown>) =>
  Effect.gen(function* () {
    const wave = yield* Wave.Service
    return yield* fn(wave)
  }).pipe(Effect.catch(() => Effect.void))

export const { use: useWave, provider: WaveProvider } = createSimpleContext({
  name: "Wave",
  init: () => {
    const [store, setStore] = createStore<WaveStore>(empty)
    const [available, setAvailable] = createSignal(true)
    const event = useEvent()

    const load = async () => {
      try {
        const next = await AppRuntime.runPromise(loadProgram)
        batch(() => {
          setStore(reconcile(next, { merge: true }))
          setAvailable(true)
        })
      } catch (err) {
        log.warn("wave load failed", { err })
        setAvailable(false)
      }
    }

    let timer: ReturnType<typeof setInterval> | undefined
    let unsubEvents: (() => void) | undefined

    onMount(() => {
      void load()
      timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
      // Bus events flow over SSE; SDK type union doesn't include wave.* (no
      // SDK regen). Subscribe loosely and runtime-check the type string.
      unsubEvents = event.subscribe((evt) => {
        const type = evt.type as string
        if (type === "wave.updated" || type === "wave.active_changed") void load()
      })
    })

    onCleanup(() => {
      if (timer) clearInterval(timer)
      unsubEvents?.()
    })

    return {
      get data() {
        return store
      },
      available,
      refresh: load,
      arm: () => AppRuntime.runPromise(loopAction((s) => s.arm())),
      pause: () => AppRuntime.runPromise(loopAction((s) => s.pause())),
      resume: () => AppRuntime.runPromise(loopAction((s) => s.resume())),
      interrupt: () => AppRuntime.runPromise(loopAction((s) => s.interrupt())),
      stop: () => AppRuntime.runPromise(loopAction((s) => s.stop())),
      next: () => AppRuntime.runPromise(loopAction((s) => s.next())),
      switchTo: (id: string) => AppRuntime.runPromise(waveAction((s) => s.setActive(id))),
      archive: () => AppRuntime.runPromise(waveAction((s) => s.setActive(null))),
    }
  },
})

export type WaveContext = ReturnType<typeof useWave>
