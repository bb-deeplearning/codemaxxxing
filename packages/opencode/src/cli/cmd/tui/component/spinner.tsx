import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import "opentui-spinner/solid"

// Standard small inline spinner: classic braille dots. Used in dialogs,
// todo items, tool-call "loading" states. Tiny footprint, calm rotation.
// The big "hero" spinner in the prompt uses spark-advance instead — see
// ui/spinner.ts createSparkFrames / createSparkColors.
export const SP_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const SP_INTERVAL = 80
export const SP_FALLBACK = "⋯"

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show
      when={kv.get("animations_enabled", true)}
      fallback={
        <text fg={color()}>
          {SP_FALLBACK} {props.children}
        </text>
      }
    >
      <box flexDirection="row" gap={1}>
        <spinner frames={SP_FRAMES} interval={SP_INTERVAL} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
