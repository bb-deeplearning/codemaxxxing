import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { Global } from "@opencode-ai/core/global"

const id = "internal:sidebar-footer"

// afterglow footer: all-lowercase whispers, zero glyphs. the getting-started
// note is a quiet surface (backgroundElement fill only when the token is
// opaque — transparent themes degrade to air), dismissed by a word, not a glyph.
function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const has = createMemo(() =>
    props.api.state.provider.some(
      (item) => item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
    ),
  )
  const done = createMemo(() => props.api.kv.get("dismissed_getting_started", false))
  const show = createMemo(() => !has() && !done())
  const path = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const text = props.api.state.vcs?.branch ? out + ":" + props.api.state.vcs.branch : out
    const list = text.split("/")
    return {
      parent: list.slice(0, -1).join("/"),
      name: list.at(-1) ?? "",
    }
  })

  return (
    <box gap={1}>
      <Show when={show()}>
        {/* column box, never flex-row: the copy wraps to several lines and
            tall children inside a flex-row trip opentui's layout budget
            (specs/tui-render-freeze.md). */}
        <box
          backgroundColor={theme().backgroundElement.a > 0 ? theme().backgroundElement : undefined}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          gap={1}
        >
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={theme().text} wrapMode="none" flexShrink={1}>
              <b>getting started</b>
            </text>
            <text
              fg={theme().textMuted}
              wrapMode="none"
              flexShrink={0}
              onMouseDown={() => props.api.kv.set("dismissed_getting_started", true)}
            >
              dismiss
            </text>
          </box>
          <text fg={theme().textMuted}>opencode includes free models so you can start immediately.</text>
          <text fg={theme().textMuted}>
            connect from 75+ providers to use other models, including claude, gpt, gemini etc
          </text>
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={theme().textMuted} wrapMode="none" flexShrink={1}>
              connect a provider
            </text>
            <text fg={theme().text} wrapMode="none" flexShrink={0}>
              /connect
            </text>
          </box>
        </box>
      </Show>
      <text>
        <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
        <span style={{ fg: theme().text }}>{path().name}</span>
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        <b>codema</b>
        <span style={{ fg: theme().text }}>
          <b>xxx</b>
        </span>
        <b>ing</b> <span>for clauseo</span>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_footer() {
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
