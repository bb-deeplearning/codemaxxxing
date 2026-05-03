import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Rule } from "./border"

export function DialogSessionDeleteFailed(props: {
  session: string
  workspace: string
  onDelete?: () => boolean | void | Promise<boolean | void>
  onRestore?: () => boolean | void | Promise<boolean | void>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "delete" as "delete" | "restore",
  })

  const options = [
    {
      id: "delete" as const,
      title: "delete workspace",
      description: "delete the workspace and all sessions attached to it.",
      run: props.onDelete,
    },
    {
      id: "restore" as const,
      title: "restore to new workspace",
      description: "try to restore this session into a new workspace.",
      run: props.onRestore,
    },
  ]

  async function confirm() {
    const result = await options.find((item) => item.id === store.active)?.run?.()
    if (result === false) return
    props.onDone?.()
    if (!props.onDone) dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      void confirm()
    }
    if (evt.name === "left" || evt.name === "up") {
      setStore("active", "delete")
    }
    if (evt.name === "right" || evt.name === "down") {
      setStore("active", "restore")
    }
  })

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          delete failed
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <Rule color={theme.error} />
      </box>
      <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1} gap={1}>
        <text fg={theme.textMuted} wrapMode="word">
          {`session "${props.session}" could not be deleted because workspace "${props.workspace}" is not available.`}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          choose how you want to recover this broken workspace session.
        </text>
        <box paddingTop={1} gap={1}>
          <For each={options}>
            {(item) => {
              const active = () => item.id === store.active
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseOver={() => setStore("active", item.id)}
                  onMouseUp={() => {
                    setStore("active", item.id)
                    void confirm()
                  }}
                >
                  <text flexShrink={0} fg={active() ? theme.borderActive : theme.borderSubtle}>
                    {active() ? "▸" : " "}
                  </text>
                  <box flexGrow={1}>
                    <text
                      attributes={active() ? TextAttributes.BOLD : undefined}
                      fg={active() ? theme.text : theme.textMuted}
                    >
                      {item.title}
                    </text>
                    <text fg={theme.textMuted} wrapMode="word">
                      {item.description}
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </box>
      <Rule color={theme.error} />
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={theme.text}>
          ↑↓ <span style={{ fg: theme.textMuted }}>choose</span>
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>cancel</span>
          </text>
        </box>
      </box>
    </box>
  )
}
