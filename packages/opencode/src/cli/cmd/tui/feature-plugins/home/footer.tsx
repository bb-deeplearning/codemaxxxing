import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Match, Show, Switch } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { useWave } from "@tui/context/wave"
import { useRoute } from "@tui/context/route"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dir = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const branch = props.api.state.vcs?.branch
    if (branch) return out + ":" + branch
    return out
  })

  return <text fg={theme().textMuted}>{dir()}</text>
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function WavePill(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const wave = useWave()
  const route = useRoute()
  const state = createMemo(() => wave.data.state)
  const onClick = () => route.navigate({ type: "wave" })

  return (
    <Show when={state()}>
      {(s) => (
        <Switch>
          <Match when={s().wave_status === "failed" || s().wave_status === "running"}>
            <Switch>
              <Match when={s().wave_status === "failed"}>
                <text fg={theme().error} onMouseDown={onClick}>
                  ✗ wave {s().current_wave} failed
                </text>
              </Match>
              <Match when={s().loop_state === "paused"}>
                <text fg={theme().warning} onMouseDown={onClick}>
                  ⏸ wave {s().current_wave}
                </text>
              </Match>
              <Match when={true}>
                <text fg={theme().primary} onMouseDown={onClick}>
                  ▸ wave {s().current_wave}/{s().total_waves}
                </text>
              </Match>
            </Switch>
          </Match>
          <Match when={s().wave_status === "all_complete"}>
            <text fg={theme().success} onMouseDown={onClick}>
              ✓ all waves done
            </text>
          </Match>
          <Match when={s().loop_state !== "idle"}>
            <text fg={theme().textMuted} onMouseDown={onClick}>
              ○ wave {s().current_wave}/{s().total_waves} {s().loop_state}
            </text>
          </Match>
          <Match when={true}>
            <text fg={theme().textMuted} onMouseDown={onClick}>
              wave {s().current_wave}/{s().total_waves}
            </text>
          </Match>
        </Switch>
      )}
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>by clauseo</text>
    </box>
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
      gap={2}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <WavePill api={props.api} />
      <box flexGrow={1} />
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
