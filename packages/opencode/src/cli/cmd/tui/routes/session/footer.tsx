import { createMemo, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import type { RGBA } from "@opentui/core"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  // Each segment is a labeled field in the status strip. Visible only when
  // its data is meaningful (e.g. mcp segment hides when mcp count is 0).
  const segments = createMemo(() => {
    const out: { label: string; value: string; valueFg?: RGBA }[] = []
    if (permissions().length > 0) {
      out.push({
        label: "warn",
        value: String(permissions().length),
        valueFg: theme.warning,
      })
    }
    out.push({
      label: "lsp",
      value: String(lsp().length),
      valueFg: lsp().length > 0 ? theme.success : theme.textMuted,
    })
    if (mcp() > 0) {
      out.push({
        label: "mcp",
        value: String(mcp()),
        valueFg: mcpError() ? theme.error : theme.success,
      })
    }
    return out
  })

  return (
    <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.textMuted }}>cwd</span> <span style={{ fg: theme.text }}>{directory()}</span>
      </text>
      <box gap={1} flexDirection="row" alignItems="center" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              <span style={{ fg: theme.textMuted }}>get started</span> /connect
            </text>
          </Match>
          <Match when={connected()}>
            <For each={segments()}>
              {(seg, i) => (
                <>
                  <Show when={i() > 0}>
                    <text fg={theme.border}>│</text>
                  </Show>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{seg.label}</span>{" "}
                    <span style={{ fg: seg.valueFg ?? theme.text }}>{seg.value}</span>
                  </text>
                </>
              )}
            </For>
            <text fg={theme.border}>│</text>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
