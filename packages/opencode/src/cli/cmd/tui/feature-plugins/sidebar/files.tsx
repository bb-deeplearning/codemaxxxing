import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { SidebarSection } from "../../component/sidebar-section"
import { inlineSafe } from "../../util/inline-safe"

const id = "internal:sidebar-files"

// afterglow: file rows are name in text with a right-edge diff whisper —
// +N in diffAdded, −N (U+2212) in diffRemoved. no chevrons: the collapse
// toggle lives on the section header (click) and the collapsed state reads
// as a dim count whisper after the word.
function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  const collapsible = createMemo(() => list().length > 2)
  const expanded = createMemo(() => !collapsible() || open())

  return (
    <Show when={list().length > 0}>
      <box>
        <SidebarSection
          t={theme()}
          label="files"
          whisper={expanded() ? undefined : `· ${list().length}`}
          onMouseDown={() => collapsible() && setOpen((x) => !x)}
        />
        <Show when={expanded()}>
          <box paddingLeft={2}>
            <For each={list()}>
              {(item) => (
                <box flexDirection="row" justifyContent="space-between" gap={1}>
                  <text fg={theme().text} wrapMode="none" flexShrink={1}>
                    {inlineSafe(item.file)}
                  </text>
                  <text wrapMode="none" flexShrink={0}>
                    <Show when={item.additions}>
                      <span style={{ fg: theme().diffAdded }}>+{item.additions}</span>
                    </Show>
                    <Show when={item.additions && item.deletions}>
                      <span> </span>
                    </Show>
                    <Show when={item.deletions}>
                      <span style={{ fg: theme().diffRemoved }}>−{item.deletions}</span>
                    </Show>
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
