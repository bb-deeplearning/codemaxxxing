import { createMemo } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { DialogHeader, useDialog } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { Spans, type GlowSpan } from "@tui/ui/glow"

// the afterglow help card: title over a dissolving primary rule, one quiet
// sentence at +2, keyed action whisper. all lowercase, no borders.
export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      dialog.clear()
    }
  })

  const actionSpans = createMemo<GlowSpan[]>(() => [
    { text: "enter", fg: theme.success, bold: true },
    { text: " ok · ", fg: theme.textMuted },
    { text: "esc", fg: theme.error, bold: true },
    { text: " close", fg: theme.textMuted },
  ])

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <DialogHeader title="keybinds" />
      <box height={1} flexShrink={0} />
      <box paddingLeft={2}>
        <text fg={theme.textMuted} wrapMode="word">
          press <span style={{ fg: theme.text, bold: true }}>{keybind.print("command_list")}</span> to see all available
          actions and commands in any context.
        </text>
      </box>
      <box height={1} flexShrink={0} />
      <text wrapMode="none" flexShrink={0} onMouseUp={() => dialog.clear()}>
        <Spans spans={actionSpans()} />
      </text>
    </box>
  )
}
