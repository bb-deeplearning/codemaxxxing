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
// `Rule` is a horizontal rule that fills available width. Use as a structural
// divider terminating a turn or section. Implementation: a flexGrow text node
// containing more dashes than any reasonable terminal width, clipped via
// overflow=hidden — cheaper to push over mosh than computing layout-aware
// repeat counts on every render. 240 covers any 4K terminal width; opentui
// still walks the full string during layout, so don't pad past what's needed.
//
// `LabeledRule` is the same idea with optional inset content on either end.
// Use for tool-call headers (left=tool name, right=target/filename) and for
// the assistant turn's closing summary (right=agent · model · duration).

const FILL_LEN = 240
const FILL = "─".repeat(FILL_LEN)

export function Rule(props: { color?: RGBA; char?: string }) {
  const { theme } = useTheme()
  return (
    <box flexShrink={0} flexGrow={1} overflow="hidden">
      <text fg={props.color ?? theme.border} wrapMode="none">
        {props.char ? props.char.repeat(FILL_LEN) : FILL}
      </text>
    </box>
  )
}

export function LabeledRule(props: { left?: JSX.Element; right?: JSX.Element; color?: RGBA; char?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" alignItems="center" flexShrink={0} gap={1}>
      <Show when={props.left}>
        <box flexShrink={0}>{props.left}</box>
      </Show>
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <text fg={props.color ?? theme.border} wrapMode="none">
          {props.char ? props.char.repeat(FILL_LEN) : FILL}
        </text>
      </box>
      <Show when={props.right}>
        <box flexShrink={0}>{props.right}</box>
      </Show>
    </box>
  )
}
