import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { Rule } from "./border"

export function PluginRouteMissing(props: { id: string; onHome: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column">
      <box width="100%" maxWidth={75} flexDirection="column">
        <Rule color={theme.warning} />
        <box flexDirection="row" gap={1} paddingTop={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.warning}>△</text>
          <text fg={theme.text}>
            <b>route not found</b>
          </text>
        </box>
        <box paddingLeft={3} paddingTop={1} flexShrink={0}>
          <text>
            <span style={{ fg: theme.textMuted }}>unknown plugin route</span>{" "}
            <span style={{ fg: theme.text }}>{props.id}</span>
          </text>
        </box>
        <box paddingLeft={3} paddingTop={1} flexShrink={0}>
          <box onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)} onMouseUp={props.onHome}>
            <text>
              <span style={{ fg: hover() ? theme.text : theme.textMuted, bold: hover() }}>
                {hover() ? "▸ " : "  "}go home
              </span>
            </text>
          </box>
        </box>
        <box paddingTop={1}>
          <Rule color={theme.warning} />
        </box>
      </box>
    </box>
  )
}
