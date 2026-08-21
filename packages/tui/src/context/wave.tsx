import { createStore, reconcile } from "solid-js/store"
import { onCleanup, onMount } from "solid-js"
import type { OpencodeWaveState } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

export const { use: useWave, provider: WaveProvider } = createSimpleContext({
  name: "Wave",
  init: () => {
    const sdk = useSDK()
    const [store, setStore] = createStore<{ campaigns: string[]; state: OpencodeWaveState | null; loading: boolean }>({
      campaigns: [],
      state: null,
      loading: false,
    })
    let timer: ReturnType<typeof setInterval> | undefined

    const refresh = async () => {
      setStore("loading", true)
      try {
        const [campaigns, active] = await Promise.all([sdk.client.wave.list(), sdk.client.wave.active()])
        setStore("campaigns", reconcile(campaigns.data ?? []))
        setStore("state", reconcile(active.data ?? null))
      } finally {
        setStore("loading", false)
      }
    }

    onMount(() => {
      void refresh()
      timer = setInterval(() => void refresh(), 2000)
    })
    onCleanup(() => {
      if (timer) clearInterval(timer)
    })

    return {
      get data() {
        return store
      },
      refresh,
      async select(id: string | null) {
        await sdk.client.wave.setActive({ id: id ?? undefined })
        await refresh()
      },
      async notes(campaignID: string, wave: number) {
        const result = await sdk.client.wave.notes({ campaignID, wave: String(wave) })
        return result.data ?? null
      },
    }
  },
})
