import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { useWave } from "@tui/context/wave"
import { useRoute } from "@tui/context/route"

const id = "internal:home-footer"

// afterglow footer: one dim lowercase sentence, no glyphs — status is
// words-in-color (specs/tui-redesign.md typography). segments are short
// single-line texts in a flex row with gap; each conditional segment
// carries its own "· " separator span so the sentence stays coherent as
// segments come and go.

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dir = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const branch = props.api.state.vcs?.branch
    if (branch) return out + ":" + branch
    return out
  })

  return (
    <text fg={theme().textMuted} wrapMode="none" flexShrink={1}>
      {dir()}
    </text>
  )
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <text flexShrink={0}>
        <span style={{ fg: theme().textMuted }}>· </span>
        <span style={{ fg: err() ? theme().error : theme().textMuted }}>{count()} mcp</span>
      </text>
    </Show>
  )
}

function Wave(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const wave = useWave()
  const route = useRoute()
  // Engage the (otherwise inert) wave context only when the home footer
  // is mounted and we want to show wave state. One discovery fetch +
  // arms polling for live updates while home is open. release() on
  // cleanup stops polling when leaving home — sessions never need wave
  // traffic competing with streaming deltas.
  onMount(() => {
    void wave.refresh()
  })
  onCleanup(() => {
    wave.release()
  })
  const state = createMemo(() => wave.data.state)
  const onClick = () => route.navigate({ type: "wave" })

  return (
    <Show when={state()}>
      {(s) => (
        <text flexShrink={0} onMouseDown={onClick}>
          <span style={{ fg: theme().textMuted }}>· </span>
          <Switch>
            <Match when={s().wave_status === "failed"}>
              <span style={{ fg: theme().error }}>wave {s().current_wave} failed</span>
            </Match>
            <Match when={s().wave_status === "running" && s().loop_state === "paused"}>
              <span style={{ fg: theme().warning }}>wave {s().current_wave} paused</span>
            </Match>
            <Match when={s().wave_status === "running"}>
              <span style={{ fg: theme().primary }}>
                wave {s().current_wave}/{s().total_waves}
              </span>
            </Match>
            <Match when={s().wave_status === "all_complete"}>
              <span style={{ fg: theme().success }}>waves done</span>
            </Match>
            <Match when={s().loop_state !== "idle"}>
              <span style={{ fg: theme().textMuted }}>
                wave {s().current_wave}/{s().total_waves} {s().loop_state}
              </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: theme().textMuted }}>
                wave {s().current_wave}/{s().total_waves}
              </span>
            </Match>
          </Switch>
        </text>
      )}
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <text fg={theme().textMuted} flexShrink={0}>
      · by clauseo
    </text>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={1}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <Wave api={props.api} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
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
