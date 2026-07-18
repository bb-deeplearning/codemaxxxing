import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"
import { sinkColor } from "@tui/ui/glow"
import { SidebarSection } from "../../component/sidebar-section"
import { inlineSafe } from "../../util/inline-safe"

const id = "internal:sidebar-mcp"

// afterglow: no status dots — a server's temperature is its words. healthy
// servers are dim chatter (name muted, "connected" sunk); failures burn
// (name and error message in theme.error); asks for attention sit in
// warning. the header is the collapse click target; collapsed state is a
// dim words-only summary, not a chevron.
function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )
  const collapsible = createMemo(() => list().length > 2)
  const expanded = createMemo(() => !collapsible() || open())

  // failed and unregistered servers burn; auth asks warm up; the rest is
  // dim chatter.
  const nameColor = (status: string) => {
    if (status === "failed" || status === "needs_client_registration") return theme().error
    if (status === "needs_auth") return theme().warning
    return theme().textMuted
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <SidebarSection
          t={theme()}
          label="mcp"
          whisper={expanded() ? undefined : `· ${on()} on${bad() > 0 ? ` · ${bad()} failing` : ""}`}
          onMouseDown={() => collapsible() && setOpen((x) => !x)}
        />
        <Show when={expanded()}>
          <box paddingLeft={2}>
            <For each={list()}>
              {(item) => (
                // one single-line text per row (wrapMode none): server error
                // strings are unbounded and can hold newlines, so they get
                // inlineSafe'd and truncate at the sidebar edge instead of
                // wrapping (specs/tui-render-freeze.md).
                <text wrapMode="none" flexShrink={0}>
                  <span style={{ fg: nameColor(item.status) }}>{item.name}</span>
                  <Switch fallback={<span style={{ fg: sinkColor(theme(), 2) }}> {item.status}</span>}>
                    <Match when={item.status === "connected"}>
                      <span style={{ fg: sinkColor(theme(), 2) }}> connected</span>
                    </Match>
                    <Match when={item.status === "failed"}>
                      <span style={{ fg: theme().error }}> {inlineSafe(item.error) || "failed"}</span>
                    </Match>
                    <Match when={item.status === "disabled"}>
                      <span style={{ fg: sinkColor(theme(), 2) }}> disabled</span>
                    </Match>
                    <Match when={item.status === "needs_auth"}>
                      <span style={{ fg: theme().warning }}> needs auth</span>
                    </Match>
                    <Match when={item.status === "needs_client_registration"}>
                      <span style={{ fg: theme().error }}> needs client id</span>
                    </Match>
                  </Switch>
                </text>
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
    order: 200,
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
