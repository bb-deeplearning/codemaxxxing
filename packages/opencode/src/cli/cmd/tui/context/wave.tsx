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

    // ── Lifecycle ────────────────────────────────────────────────────────
    // The fork's WaveProvider sits at the root of the App tree (so
    // /wave-* slash commands can invoke arm/pause/stop from anywhere)
    // but MUST cost zero CPU on the streaming hot path for users who
    // don't use wave.
    //
    // States, in order of cost:
    //   inert        — no SSE subscription, no polling, no requests.
    //                  Provider sits in the tree, useWave() returns valid
    //                  handles, store reads return `empty`. This is the
    //                  default at app start and what every session-route
    //                  user pays.
    //   subscribed   — SSE subscriber armed (single ===-compare per event,
    //                  no-op for non-wave events). One discovery load has
    //                  run. No polling. Triggered by the first
    //                  refresh()/arm()/etc call. Permanent for app
    //                  lifetime once entered (it's cheap).
    //   polling      — 2s interval `load()` in addition. Only the wave
    //                  route or home pill armed it. Released on route
    //                  unmount via release() — even when a campaign is
    //                  active, polling stops the moment no surface needs
    //                  it. Wave events still re-load via the SSE
    //                  subscriber.
    let timer: ReturnType<typeof setInterval> | undefined
    let unsubEvents: (() => void) | undefined
    let subscribed = false
    let pollers = 0

    const subscribe = () => {
      if (subscribed) return
      subscribed = true
      // SSE wave events trigger a one-shot load(); they do NOT auto-arm
      // polling (would survive route unmount and create a leak). Routes
      // that want live data call refresh() which engages polling.
      unsubEvents = event.subscribe((evt) => {
        const type = evt.type as string
        if (type !== "wave.updated" && type !== "wave.active_changed") return
        void load()
      })
    }

    const startPolling = () => {
      pollers++
      if (timer) return
      timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
    }

    const stopPolling = () => {
      if (pollers > 0) pollers--
      if (pollers > 0) return
      if (!timer) return
      clearInterval(timer)
      timer = undefined
    }

    onMount(() => {
      // Intentionally empty. No discovery load, no event subscription,
      // no polling. Provider sits inert until something explicitly engages.
    })

    onCleanup(() => {
      pollers = 0
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      unsubEvents?.()
    })

    const swallow = (p: Promise<unknown>) =>
      p.catch((err) => {
        log.warn("wave action failed", { err })
      }) as Promise<void>

    // First-touch helper: subscribe once, then run the action. Subsequent
    // calls skip the subscribe via the `subscribed` flag.
    const withSubscribe = <Args extends unknown[]>(fn: (...args: Args) => Promise<void>) => {
      return (...args: Args) => {
        subscribe()
        return fn(...args)
      }
    }

    return {
      get data() {
        return store
      },
      available,
      // Routes that want passive live state call refresh() on mount and
      // release() on cleanup. refresh() subscribes (idempotent), starts
      // polling (refcounted), and runs an immediate load.
      refresh: () => {
        subscribe()
        startPolling()
        return load()
      },
      // Decrement the polling refcount. When the count hits 0, polling
      // stops; the SSE subscriber stays so wave events still update the
      // store on the rare occasion they fire.
      release: () => {
        stopPolling()
      },
      get isEngaged() {
        return subscribed
      },
      arm: withSubscribe(() => swallow(post("/wave/loop/arm"))),
      pause: withSubscribe(() => swallow(post("/wave/loop/pause"))),
      resume: withSubscribe(() => swallow(post("/wave/loop/resume"))),
      interrupt: withSubscribe(() => swallow(post("/wave/loop/interrupt"))),
      stop: withSubscribe(() => swallow(post("/wave/loop/stop"))),
      next: withSubscribe(() => swallow(post("/wave/loop/next"))),
      clearCancelled: withSubscribe(() => swallow(post("/wave/loop/clear-cancelled"))),
      clearQuestion: withSubscribe(() => swallow(post("/wave/loop/clear-question"))),
      readNotes: async (id: string, n: number): Promise<string | null> => {
        try {
          const res = await get<{ notes: string | null }>(`/wave/campaigns/${encodeURIComponent(id)}/waves/${n}/notes`)
          return res.notes
        } catch (err) {
          log.warn("wave readNotes failed", { err })
          return null
        }
      },
      switchTo: (id: string) => {
        subscribe()
        return swallow(post("/wave/active", { campaign_id: id }))
      },
      archive: withSubscribe(() => swallow(post("/wave/active", { campaign_id: null }))),
    }
  },
})

export type WaveContext = ReturnType<typeof useWave>
