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
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} fg={markerFg()}>
        {marker()}
      </text>
      <text flexGrow={1} wrapMode="word" fg={labelFg()}>
        {props.status === "in_progress" ? <b>{props.content}</b> : props.content}
      </text>
    </box>
  )
}
