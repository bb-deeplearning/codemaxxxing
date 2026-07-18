import { createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { DialogHeader, useDialog, type DialogContext } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { Spans, type GlowSpan } from "@tui/ui/glow"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

// the afterglow alert: bold lowercase title over a dissolving primary rule,
// body at +2, then the keyed action whisper. no borders — fades and air.
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

  const actionSpans = createMemo<GlowSpan[]>(() => [
    { text: "enter", fg: theme.success, bold: true },
    { text: " ok · ", fg: theme.textMuted },
    { text: "esc", fg: theme.error, bold: true },
    { text: " close", fg: theme.textMuted },
  ])

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <DialogHeader title={props.title} />
      <box height={1} flexShrink={0} />
      <box paddingLeft={2}>
        <text fg={theme.text} wrapMode="word">
          {props.message}
        </text>
      </box>
      <box height={1} flexShrink={0} />
      <text
        wrapMode="none"
        flexShrink={0}
        onMouseUp={() => {
          props.onConfirm?.()
          dialog.clear()
        }}
      >
        <Spans spans={actionSpans()} />
      </text>
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
