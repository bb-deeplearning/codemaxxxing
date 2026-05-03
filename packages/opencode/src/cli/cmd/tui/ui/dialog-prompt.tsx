import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, onMount, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Spinner } from "../component/spinner"
import { Rule } from "../component/border"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable

  useKeyboard((evt) => {
    if (props.busy) {
      if (evt.name === "escape") return
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onConfirm?.(textarea.plainText)
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
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
      <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1} gap={1}>
        <Show when={props.description}>{props.description!()}</Show>
        <textarea
          onSubmit={() => {
            if (props.busy) return
            props.onConfirm?.(textarea.plainText)
          }}
          height={3}
          keyBindings={props.busy ? [] : [{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => {
            textarea = val
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "enter text"}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "working..."}</Spinner>
        </Show>
      </box>
      <Rule color={theme.borderActive} />
      {/* Footer hints */}
      <box
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing...</text>}>
          <box flexDirection="row" gap={2}>
            <text>
              <span style={{ fg: theme.text, bold: true }}>enter</span>{" "}
              <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
            <text>
              <span style={{ fg: theme.text, bold: true }}>esc</span>{" "}
              <span style={{ fg: theme.textMuted }}>cancel</span>
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
