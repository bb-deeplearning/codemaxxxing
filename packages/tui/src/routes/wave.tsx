import { For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useWave } from "../context/wave"
import { useRoute } from "../context/route"

export function Wave() {
  const wave = useWave()
  const route = useRoute()
  const { theme } = useTheme()

  useKeyboard((event) => {
    if (event.name === "escape") {
      route.navigate({ type: "home" })
      return
    }
    if (event.name === "r") void wave.arm()
    if (event.name === "n") void wave.next()
    if (event.name === "space") void wave.pause()
    if (event.name === "i") void wave.interrupt()
    if (event.name === "s") void wave.stop()
  })

  return (
    <box flexDirection="column" padding={2} gap={1}>
      <text fg={theme.primary}>Wave campaigns</text>
      <Show when={!wave.data.loading} fallback={<text fg={theme.textMuted}>Loading campaigns...</text>}>
        <Show when={wave.data.state} fallback={<text fg={theme.textMuted}>No active wave campaign.</text>}>
          {(state) => (
            <box flexDirection="column" gap={1}>
              <text fg={theme.text}>Campaign: {state().campaign_id}</text>
              <text fg={theme.textMuted}>
                {state().wave_status} · wave {state().current_wave}/{state().total_waves}
              </text>
              <For each={state().waves}>
                {(row) => (
                  <text fg={row.status === "complete" ? theme.success : row.status === "failed" ? theme.error : theme.text}>
                    {row.n}. {row.status} {row.notes}
                  </text>
                )}
              </For>
            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}
