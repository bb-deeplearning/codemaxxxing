import { createMemo, For } from "solid-js"
import { useTheme } from "../context/theme"
import { DialogHeader, useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { Spans, type GlowSpan } from "@tui/ui/glow"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
}

export type DialogConfirmResult = boolean | undefined

// the afterglow confirm: warning-heat title rule (confirms guard decisions,
// usually destructive ones), body at +2, and two action words at the right —
// the armed one is bold, the other a muted whisper. no markers, no borders.
export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Default to "cancel" — destructive confirmations should not arm the
  // dangerous action by default.
  const [store, setStore] = createStore({
    active: "cancel" as "confirm" | "cancel",
  })

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      if (store.active === "confirm") props.onConfirm?.()
      if (store.active === "cancel") props.onCancel?.()
      dialog.clear()
    }

    if (evt.name === "left" || evt.name === "right" || evt.name === "tab") {
      setStore("active", store.active === "confirm" ? "cancel" : "confirm")
    }
  })

  const hintSpans = createMemo<GlowSpan[]>(() => [
    { text: "←→", fg: theme.text },
    { text: " switch · ", fg: theme.textMuted },
    { text: "enter", fg: theme.text },
    { text: " choose · ", fg: theme.textMuted },
    { text: "esc", fg: theme.text },
    { text: " close", fg: theme.textMuted },
  ])

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <DialogHeader title={props.title} color={theme.warning} />
      <box height={1} flexShrink={0} />
      <box paddingLeft={2}>
        <text fg={theme.text} wrapMode="word">
          {props.message}
        </text>
      </box>
      <box height={1} flexShrink={0} />
      {/* keyed whisper at the left, the two action words at the right —
          the armed word is bold (warning heat when it is the destructive
          one), the other stays a muted whisper. hover arms, click fires. */}
      <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
        <text wrapMode="none" flexShrink={1}>
          <Spans spans={hintSpans()} />
        </text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <For each={["cancel", "confirm"] as const}>
            {(key) => {
              const labelText = () => (key === "cancel" ? (props.label ?? "cancel") : "confirm").toLowerCase()
              const armed = () => key === store.active
              return (
                <text
                  wrapMode="none"
                  flexShrink={0}
                  onMouseUp={() => {
                    if (key === "confirm") props.onConfirm?.()
                    if (key === "cancel") props.onCancel?.()
                    dialog.clear()
                  }}
                  onMouseOver={() => setStore("active", key)}
                >
                  <span
                    style={{
                      fg: armed() ? (key === "confirm" ? theme.warning : theme.text) : theme.textMuted,
                      bold: armed(),
                    }}
                  >
                    {labelText()}
                  </span>
                </text>
              )
            }}
          </For>
        </box>
      </box>
    </box>
  )
}

DialogConfirm.show = (dialog: DialogContext, title: string, message: string, label?: string) => {
  return new Promise<DialogConfirmResult>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
          label={label}
        />
      ),
      () => resolve(undefined),
    )
  })
}
