import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissionCount = createMemo(() => {
    if (route.data.type !== "session") return 0
    return sync.data.permission[route.data.sessionID]?.length ?? 0
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

  // Inline <Show> blocks instead of a derived segments array. Previously
  // segments() returned a fresh array of objects with `valueFg` RGBA refs
  // every time any of permissions/lsp/mcp/theme changed; the <For> then
  // re-keyed and remounted every segment cell on each change. With three
  // possible segments the array overhead dwarfs the work and the <For>
  // child closure costs more than the visible content.
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
            <Show when={permissionCount() > 0}>
              <text>
                <span style={{ fg: theme.textMuted }}>warn</span>{" "}
                <span style={{ fg: theme.warning }}>{permissionCount()}</span>
              </text>
              <text fg={theme.border}>│</text>
            </Show>
            <text>
              <span style={{ fg: theme.textMuted }}>lsp</span>{" "}
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>{lsp().length}</span>
            </text>
            <Show when={mcp() > 0}>
              <text fg={theme.border}>│</text>
              <text>
                <span style={{ fg: theme.textMuted }}>mcp</span>{" "}
                <span style={{ fg: mcpError() ? theme.error : theme.success }}>{mcp()}</span>
              </text>
            </Show>
            <text fg={theme.border}>│</text>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
