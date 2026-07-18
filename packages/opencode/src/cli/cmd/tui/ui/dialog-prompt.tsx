import { TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { DialogHeader, useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createMemo, onMount, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Spans, type GlowSpan } from "@tui/ui/glow"

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

// the afterglow prompt: title over a dissolving primary rule, the input at
// +2 with the primary cursor, and a keyed action whisper. while busy the
// input cools and a static dim "working…" sits under it — no spinners.
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

  const actionSpans = createMemo<GlowSpan[]>(() =>
    props.busy
      ? [
          { text: "esc", fg: theme.error, bold: true },
          { text: " cancel", fg: theme.textMuted },
        ]
      : [
          { text: "enter", fg: theme.success, bold: true },
          { text: " submit · ", fg: theme.textMuted },
          { text: "esc", fg: theme.error, bold: true },
          { text: " cancel", fg: theme.textMuted },
        ],
  )

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <DialogHeader title={props.title} />
      <box height={1} flexShrink={0} />
      <box paddingLeft={2} gap={1}>
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
          cursorColor={props.busy ? theme.backgroundElement : theme.primary}
        />
        <Show when={props.busy}>
          {/* static dim working line — motion budget stays with the deck's
              cursor; nothing in a dialog animates. */}
          <text fg={theme.textMuted}>{props.busyText ?? "working…"}</text>
        </Show>
      </box>
      <box height={1} flexShrink={0} />
      <text wrapMode="none" flexShrink={0}>
        <Spans spans={actionSpans()} />
      </text>
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
