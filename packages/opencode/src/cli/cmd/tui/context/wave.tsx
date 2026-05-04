import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import * as Log from "@opencode-ai/core/util/log"
import type { State } from "@/wave/state"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"
import { useSDK } from "./sdk"

const log = Log.create({ service: "tui.wave" })

const REFRESH_INTERVAL_MS = 2_000

export interface WaveStore {
  campaigns: ReadonlyArray<string>
  active: string | null
  state: State | null
}

const empty: WaveStore = { campaigns: [], active: null, state: null }

export const { use: useWave, provider: WaveProvider } = createSimpleContext({
  name: "Wave",
  init: () => {
    const [store, setStore] = createStore<WaveStore>(empty)
    const [available, setAvailable] = createSignal(true)
    const event = useEvent()
    const sdk = useSDK()

    const headers = (): HeadersInit => {
      const out: Record<string, string> = { "content-type": "application/json" }
      if (sdk.directory) out["x-opencode-directory"] = encodeURIComponent(sdk.directory)
      return out
    }

    const get = async <T,>(path: string): Promise<T> => {
      const res = await sdk.fetch(`${sdk.url}${path}`, { headers: headers() })
      if (!res.ok) throw new Error(`${path} → ${res.status}`)
      return (await res.json()) as T
    }

    const post = async (path: string, body?: unknown): Promise<void> => {
      const res = await sdk.fetch(`${sdk.url}${path}`, {
        method: "POST",
        headers: headers(),
        body: body === undefined ? "{}" : JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`${path} → ${res.status}`)
    }

    const load = async () => {
      try {
        const [campaigns, active, stateRes] = await Promise.all([
          get<{ campaigns: string[] }>("/wave/campaigns"),
          get<{ campaign_id: string | null }>("/wave/active"),
          get<{ state: State | null }>("/wave/active/state"),
        ])
        batch(() => {
          setStore(
            reconcile(
              {
                campaigns: campaigns.campaigns,
                active: active.campaign_id,
                state: stateRes.state,
              },
              { merge: true },
            ),
          )
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
      // Bus events flow over SSE; SDK type union doesn't include wave.* events
      // (no SDK regen). Subscribe loosely and runtime-check the type string.
      unsubEvents = event.subscribe((evt) => {
        const type = evt.type as string
        if (type === "wave.updated" || type === "wave.active_changed") void load()
      })
    })

    onCleanup(() => {
      if (timer) clearInterval(timer)
      unsubEvents?.()
    })

    const swallow = (p: Promise<unknown>) =>
      p.catch((err) => {
        log.warn("wave action failed", { err })
      }) as Promise<void>

    return {
      get data() {
        return store
      },
      available,
      refresh: load,
      arm: () => swallow(post("/wave/loop/arm")),
      pause: () => swallow(post("/wave/loop/pause")),
      resume: () => swallow(post("/wave/loop/resume")),
      interrupt: () => swallow(post("/wave/loop/interrupt")),
      stop: () => swallow(post("/wave/loop/stop")),
      next: () => swallow(post("/wave/loop/next")),
      switchTo: (id: string) => swallow(post("/wave/active", { campaign_id: id })),
      archive: () => swallow(post("/wave/active", { campaign_id: null })),
    }
  },
})

export type WaveContext = ReturnType<typeof useWave>
