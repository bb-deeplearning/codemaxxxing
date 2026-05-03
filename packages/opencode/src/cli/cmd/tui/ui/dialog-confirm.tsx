import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Rule } from "../component/border"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
}

export type DialogConfirmResult = boolean | undefined

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

  return (
    <box>
      {/* Header strip */}
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
      {/* Footer: action buttons with ▸ marker */}
      <box
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="row"
        justifyContent="flex-end"
        gap={3}
      >
        <For each={["cancel", "confirm"] as const}>
          {(key) => {
            const labelText = key === "cancel" ? (props.label ?? "cancel") : "confirm"
            return (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={(_evt) => {
                  if (key === "confirm") props.onConfirm?.()
                  if (key === "cancel") props.onCancel?.()
                  dialog.clear()
                }}
                onMouseOver={() => setStore("active", key)}
              >
                <text fg={key === store.active ? theme.text : theme.textMuted}>{key === store.active ? "▸" : " "}</text>
                <text
                  fg={key === store.active ? theme.text : theme.textMuted}
                  attributes={key === store.active ? TextAttributes.BOLD : undefined}
                >
                  {labelText}
                </text>
              </box>
            )
          }}
        </For>
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
