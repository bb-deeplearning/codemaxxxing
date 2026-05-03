import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { Rule } from "../component/border"

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

  return (
    <box>
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          keybinds
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <Rule color={theme.borderActive} />
      </box>
      {/* Body */}
      <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted} wrapMode="word">
          Press <span style={{ fg: theme.text, bold: true }}>{keybind.print("command_list")}</span> to see all available
          actions and commands in any context.
        </text>
      </box>
      <Rule color={theme.borderActive} />
      {/* Footer */}
      <box
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="row"
        justifyContent="flex-end"
        onMouseUp={() => dialog.clear()}
      >
        <text>
          <span style={{ fg: theme.text, bold: true }}>enter</span> <span style={{ fg: theme.textMuted }}>ok</span>
        </text>
      </box>
    </box>
  )
}
