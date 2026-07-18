import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { sinkColor } from "@tui/ui/glow"
import { SidebarSection } from "../../component/sidebar-section"
import { inlineSafe } from "../../util/inline-safe"

const id = "internal:sidebar-lsp"

// afterglow: no status dots — temperature is the word itself. a connected
// server is dim chatter (name muted, root sunk); a broken one burns (name
// in error). the header is the collapse click target; collapsed state is
// a dim count whisper, not a chevron.
function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp())
  const off = createMemo(() => props.api.state.config.lsp === false)
  const collapsible = createMemo(() => list().length > 2)
  const expanded = createMemo(() => !collapsible() || open())

  return (
    <box>
      <SidebarSection
        t={theme()}
        label="lsp"
        whisper={expanded() ? undefined : `· ${list().length}`}
        onMouseDown={() => collapsible() && setOpen((x) => !x)}
      />
      <Show when={expanded()}>
        <box paddingLeft={2}>
          <Show when={list().length === 0}>
            <text fg={theme().textMuted}>
              {off() ? "lsps are disabled in settings" : "lsps activate as files are read"}
            </text>
          </Show>
          <For each={list()}>
            {(item) => (
              // one single-line text per row (wrapMode none): monorepo roots
              // are unbounded strings, so they truncate at the sidebar edge
              // instead of wrapping — and never sit in a flex-row primary
              // cell (specs/tui-render-freeze.md).
              <text wrapMode="none" flexShrink={0}>
                <span style={{ fg: item.status === "connected" ? theme().textMuted : theme().error }}>{item.id}</span>
                <span style={{ fg: sinkColor(theme(), 2) }}> {inlineSafe(item.root)}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
