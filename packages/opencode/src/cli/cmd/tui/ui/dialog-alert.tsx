import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { Rule } from "../component/border"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onConfirm?.()
      dialog.clear()
    }
  })

  return (
    <box>
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
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
        <text fg={theme.text} wrapMode="word">
          {props.message}
        </text>
      </box>
      <Rule color={theme.borderActive} />
      {/* Footer hint */}
      <box
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="row"
        justifyContent="flex-end"
        onMouseUp={() => {
          props.onConfirm?.()
          dialog.clear()
        }}
      >
        <text>
          <span style={{ fg: theme.text, bold: true }}>enter</span> <span style={{ fg: theme.textMuted }}>ok</span>
        </text>
      </box>
    </box>
  )
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
