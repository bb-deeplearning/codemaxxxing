import { type RGBA } from "@opentui/core"
import { Show, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"

export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

// Drafting-table primitives.
//
// `Rule` is a horizontal rule that fills available width.
// `LabeledRule` is the same idea with optional inset content on either end.
//
// Implementation: opentui's native `border` style on a 0-content box paints
// exactly one row of the chosen border char at its computed width — no
// string allocation, no measure, no clip. Border rendering happens in the
// opentui paint pass directly without a child text element.

// Module-scope cache. customBorderChars is identity-compared inside opentui
// (changing the object identity would invalidate its internal cell cache),
// and we only ever use a small number of distinct chars in practice.
const HORIZONTAL_CACHE = new Map<string, typeof EmptyBorder>()
function horizontalChars(char: string) {
  let cached = HORIZONTAL_CACHE.get(char)
  if (!cached) {
    cached = { ...EmptyBorder, horizontal: char }
    HORIZONTAL_CACHE.set(char, cached)
  }
  return cached
}
// Pre-warm the default char so the common case is a Map hit at first render.
const DEFAULT_HORIZONTAL = horizontalChars("─")

export function Rule(props: { color?: RGBA; char?: string }) {
  const { theme } = useTheme()
  const chars = props.char ? horizontalChars(props.char) : DEFAULT_HORIZONTAL
  return (
    <box
      flexShrink={0}
      flexGrow={1}
      height={1}
      border={["bottom"]}
      customBorderChars={chars}
      borderColor={props.color ?? theme.border}
    />
  )
}

export function LabeledRule(props: { left?: JSX.Element; right?: JSX.Element; color?: RGBA; char?: string }) {
  const { theme } = useTheme()
  const chars = props.char ? horizontalChars(props.char) : DEFAULT_HORIZONTAL
  return (
    <box flexDirection="row" alignItems="center" flexShrink={0} gap={1}>
      <Show when={props.left}>
        <box flexShrink={0}>{props.left}</box>
      </Show>
      <box
        flexGrow={1}
        flexShrink={1}
        height={1}
        border={["bottom"]}
        customBorderChars={chars}
        borderColor={props.color ?? theme.border}
      />
      <Show when={props.right}>
        <box flexShrink={0}>{props.right}</box>
      </Show>
    </box>
  )
}
