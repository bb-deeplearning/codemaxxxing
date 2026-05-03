import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For, onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Rule } from "../component/border"

export type DialogExportOptionsProps = {
  defaultFilename: string
  defaultThinking: boolean
  defaultToolDetails: boolean
  defaultAssistantMetadata: boolean
  defaultOpenWithoutSaving: boolean
  onConfirm?: (options: {
    filename: string
    thinking: boolean
    toolDetails: boolean
    assistantMetadata: boolean
    openWithoutSaving: boolean
  }) => void
  onCancel?: () => void
}

type Field = "filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving"

const TOGGLES: { key: Exclude<Field, "filename">; label: string }[] = [
  { key: "thinking", label: "include thinking" },
  { key: "toolDetails", label: "include tool details" },
  { key: "assistantMetadata", label: "include assistant metadata" },
  { key: "openWithoutSaving", label: "open without saving" },
]

export function DialogExportOptions(props: DialogExportOptionsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable
  const [store, setStore] = createStore({
    thinking: props.defaultThinking,
    toolDetails: props.defaultToolDetails,
    assistantMetadata: props.defaultAssistantMetadata,
    openWithoutSaving: props.defaultOpenWithoutSaving,
    active: "filename" as Field,
  })

  function submit() {
    props.onConfirm?.({
      filename: textarea.plainText,
      thinking: store.thinking,
      toolDetails: store.toolDetails,
      assistantMetadata: store.assistantMetadata,
      openWithoutSaving: store.openWithoutSaving,
    })
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      submit()
    }
    if (evt.name === "tab") {
      const order: Field[] = ["filename", "thinking", "toolDetails", "assistantMetadata", "openWithoutSaving"]
      const currentIndex = order.indexOf(store.active)
      const nextIndex = (currentIndex + 1) % order.length
      setStore("active", order[nextIndex])
      evt.preventDefault()
    }
    if (evt.name === "space" || evt.name === " ") {
      if (store.active === "thinking") setStore("thinking", !store.thinking)
      if (store.active === "toolDetails") setStore("toolDetails", !store.toolDetails)
      if (store.active === "assistantMetadata") setStore("assistantMetadata", !store.assistantMetadata)
      if (store.active === "openWithoutSaving") setStore("openWithoutSaving", !store.openWithoutSaving)
      evt.preventDefault()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box>
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          export options
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <Rule color={theme.borderActive} />
      </box>
      {/* Body: filename + toggles */}
      <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1} gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={store.active === "filename" ? theme.text : theme.textMuted}>
            {store.active === "filename" ? "▸" : " "}
          </text>
          <text fg={theme.textMuted}>filename</text>
        </box>
        <textarea
          onSubmit={() => submit()}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => {
            textarea = val
            val.traits = { status: "FILENAME" }
          }}
          initialValue={props.defaultFilename}
          placeholder="enter filename"
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
        <box>
          <For each={TOGGLES}>
            {(toggle) => {
              const checked = () => store[toggle.key]
              const active = () => store.active === toggle.key
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={0}
                  onMouseUp={() => {
                    setStore("active", toggle.key)
                    setStore(toggle.key, !store[toggle.key])
                  }}
                  onMouseOver={() => setStore("active", toggle.key)}
                >
                  <text fg={active() ? theme.text : theme.textMuted}>{active() ? "▸" : " "}</text>
                  <text fg={active() ? theme.text : theme.textMuted}>{checked() ? "[x]" : "[ ]"}</text>
                  <text
                    fg={active() ? theme.text : theme.textMuted}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                  >
                    {toggle.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
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
        <box flexDirection="row" gap={2}>
          <text>
            <span style={{ fg: theme.text, bold: true }}>enter</span>{" "}
            <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
          <text>
            <span style={{ fg: theme.text, bold: true }}>tab</span>{" "}
            <span style={{ fg: theme.textMuted }}>next field</span>
          </text>
          <Show when={store.active !== "filename"}>
            <text>
              <span style={{ fg: theme.text, bold: true }}>space</span>{" "}
              <span style={{ fg: theme.textMuted }}>toggle</span>
            </text>
          </Show>
        </box>
        <text>
          <span style={{ fg: theme.text, bold: true }}>esc</span> <span style={{ fg: theme.textMuted }}>cancel</span>
        </text>
      </box>
    </box>
  )
}

DialogExportOptions.show = (
  dialog: DialogContext,
  defaultFilename: string,
  defaultThinking: boolean,
  defaultToolDetails: boolean,
  defaultAssistantMetadata: boolean,
  defaultOpenWithoutSaving: boolean,
) => {
  return new Promise<{
    filename: string
    thinking: boolean
    toolDetails: boolean
    assistantMetadata: boolean
    openWithoutSaving: boolean
  } | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogExportOptions
          defaultFilename={defaultFilename}
          defaultThinking={defaultThinking}
          defaultToolDetails={defaultToolDetails}
          defaultAssistantMetadata={defaultAssistantMetadata}
          defaultOpenWithoutSaving={defaultOpenWithoutSaving}
          onConfirm={(options) => resolve(options)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
