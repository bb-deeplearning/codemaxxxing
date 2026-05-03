import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Rule } from "./border"

export function DialogWorkspaceUnavailable(props: { onRestore?: () => boolean | void | Promise<boolean | void> }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "restore" as "cancel" | "restore",
  })

  const options = ["cancel", "restore"] as const

  async function confirm() {
    if (store.active === "cancel") {
      dialog.clear()
      return
    }
    const result = await props.onRestore?.()
    if (result === false) return
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      void confirm()
      return
    }
    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("active", "cancel")
      return
    }
    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("active", "restore")
    }
  })

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          workspace unavailable
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <Rule color={theme.warning} />
      </box>
      <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1} gap={1}>
        <text fg={theme.textMuted} wrapMode="word">
          this session is attached to a workspace that is no longer available.
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          would you like to restore this session into a new workspace?
        </text>
      </box>
      <Rule color={theme.warning} />
      <box
        flexDirection="row"
        justifyContent="flex-end"
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        gap={3}
      >
        <For each={options}>
          {(item) => {
            const active = () => item === store.active
            return (
              <box
                flexDirection="row"
                gap={1}
                onMouseOver={() => setStore("active", item)}
                onMouseUp={() => {
                  setStore("active", item)
                  void confirm()
                }}
              >
                <text fg={active() ? theme.borderActive : theme.borderSubtle}>{active() ? "▸" : " "}</text>
                <text
                  fg={active() ? theme.text : theme.textMuted}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                >
                  {item}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}
