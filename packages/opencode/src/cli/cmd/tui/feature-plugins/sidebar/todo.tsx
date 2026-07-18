import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { SidebarSection } from "../../component/sidebar-section"

const id = "internal:sidebar-todo"

// afterglow: rows come from TodoItem (in-progress bold, pending dim,
// completed sunk — temperature, not glyphs). the header is the collapse
// click target; collapsed state is a dim open-count whisper.
function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))
  const remaining = createMemo(() => list().filter((item) => item.status !== "completed").length)
  const collapsible = createMemo(() => list().length > 2)
  const expanded = createMemo(() => !collapsible() || open())

  return (
    <Show when={show()}>
      <box>
        <SidebarSection
          t={theme()}
          label="todo"
          whisper={expanded() ? undefined : `· ${remaining()} open`}
          onMouseDown={() => collapsible() && setOpen((x) => !x)}
        />
        <Show when={expanded()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
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
