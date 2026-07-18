import { useTheme } from "../context/theme"
import { sinkColor } from "../ui/glow"

export interface TodoItemProps {
  status: string
  content: string
}

// afterglow: status is temperature, not glyphs. the in-progress todo is
// the live one (bold, full text color); pending items are dim chatter;
// completed items cool into the dark (sink). no marker gutter — the ✓/▸/·
// glyph column is banned chrome (specs/tui-redesign.md, typography).
export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  const fg = () => {
    if (props.status === "in_progress") return theme.text
    if (props.status === "completed") return sinkColor(theme, 1)
    return theme.textMuted
  }

  return (
    // Column box, no flex-row: LLM-generated todo content is unbounded
    // length and can contain newlines; multi-line text in a flex-row
    // primary cell trips opentui's flex layout-budget freeze (see
    // specs/tui-render-freeze.md).
    <box paddingLeft={2}>
      <text fg={fg()}>{props.status === "in_progress" ? <b>{props.content}</b> : props.content}</text>
    </box>
  )
}
