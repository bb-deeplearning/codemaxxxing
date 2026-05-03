import { createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme, tint } from "@tui/context/theme"
import { Rule } from "@tui/component/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import { useTerminalDimensions } from "@opentui/solid"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const local = useLocal()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  // Parse the agent name out of the title; we use it both for the label
  // and for tinting the top rule so the surface itself signals "you are
  // in a subagent under <agent>".
  const agentMatch = createMemo(() => session()?.title.match(/@(\w+) subagent/))
  const agentName = createMemo(() => agentMatch()?.[1])

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "subagent", index: 0, total: 0 }
    const name = agentName()
    const label = name ? Locale.titlecase(name) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  const usage = createMemo(() => {
    const msg = messages()
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })

    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  useTerminalDimensions()

  // Top rule reflects which agent owns this subagent. When we know the
  // agent name, tint the rule toward that color (subtly — half-blend with
  // theme.border so it's still chrome, not body) so this surface carries
  // identity even before reading the label.
  const ruleColor = createMemo(() => {
    const name = agentName()
    if (!name) return theme.border
    const agentColor = local.agent.color(name)
    return tint(theme.border, agentColor, 0.6)
  })

  return (
    <box flexShrink={0} flexDirection="column">
      <Rule color={ruleColor()} />
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1} flexShrink={0}>
        <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <box flexDirection="row" alignItems="center" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text fg={theme.textMuted}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <>
                  <text fg={theme.border}>│</text>
                  <text fg={theme.textMuted} wrapMode="none">
                    <span style={{ fg: theme.textMuted }}>tokens</span>{" "}
                    <span style={{ fg: theme.text }}>{item().context}</span>
                    <Show when={item().cost}>
                      {(cost) => (
                        <>
                          <span style={{ fg: theme.textMuted }}> · </span>
                          <span style={{ fg: theme.text }}>{cost()}</span>
                        </>
                      )}
                    </Show>
                  </text>
                </>
              )}
            </Show>
          </box>
          <box flexDirection="row" alignItems="center" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.parent")}
            >
              <text>
                <span style={{ fg: hover() === "parent" ? theme.text : theme.textMuted, bold: hover() === "parent" }}>
                  parent
                </span>{" "}
                <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
              </text>
            </box>
            <text fg={theme.border}>│</text>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.child.previous")}
            >
              <text>
                <span style={{ fg: hover() === "prev" ? theme.text : theme.textMuted, bold: hover() === "prev" }}>
                  prev
                </span>{" "}
                <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.child.next")}
            >
              <text>
                <span style={{ fg: hover() === "next" ? theme.text : theme.textMuted, bold: hover() === "next" }}>
                  next
                </span>{" "}
                <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
