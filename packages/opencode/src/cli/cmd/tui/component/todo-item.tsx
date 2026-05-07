import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  const marker = () => {
    if (props.status === "completed") return "✓"
    if (props.status === "in_progress") return "▸"
    return "·"
  }

  const markerFg = () => {
    if (props.status === "completed") return theme.success
    if (props.status === "in_progress") return theme.text
    return theme.textMuted
  }

  const labelFg = () => {
    if (props.status === "in_progress") return theme.text
    if (props.status === "completed") return theme.textMuted
    return theme.textMuted
  }

  return (
    // Marker as an absolute overlay in a 2-col gutter; body text in the
    // column itself. Previously this was `<box flexDirection="row">` with
    // the body `<text>` carrying `wrapMode="word"` — TWO antipatterns
    // stacked. LLM-generated todo content is unbounded length and can
    // contain newlines; multi-line text in a flex-row primary cell trips
    // opentui's flex layout-budget freeze (see specs/tui-render-freeze.md),
    // and `wrapMode="word"` adds a per-render word-boundary scan on top.
    //
    // Same fix shape as the AssistantMessage marginalia in commit
    // 23e0e84f6: absolute-position the gutter content so it doesn't
    // participate in flex flow, let the body text wrap naturally in
    // default char-wrap inside a column box.
    <box paddingLeft={2}>
      <text position="absolute" left={0} top={0} flexShrink={0} fg={markerFg()}>
        {marker()}
      </text>
      <text fg={labelFg()}>{props.status === "in_progress" ? <b>{props.content}</b> : props.content}</text>
    </box>
  )
}
