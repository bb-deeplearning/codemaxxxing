import { createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme, tint } from "@tui/context/theme"
import { Rule } from "@tui/component/border"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import { useTerminalDimensions } from "@opentui/solid"

// Module-scope so we don't recompile per render. Title format is set by
// the orchestrator and stable for the lifetime of a session.
const AGENT_TITLE_RE = /@(\w+) subagent/

// Module-scope formatter. Was previously allocated INSIDE the usage memo
// → fresh Intl.NumberFormat per streaming delta.
const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

// Frozen empty messages sentinel — keeps reference identity stable when
// no messages exist yet so downstream memos don't see a fresh `[]` per call.
const EMPTY_MESSAGES: readonly Message[] = Object.freeze([]) as readonly Message[]

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const local = useLocal()
  const session = createMemo(() => sync.session.get(route.sessionID))

  // Title-derived agent name. Single regex, cached against title identity
  // (titles never change in normal operation, and even when they do the
  // regex is O(title-length).)
  const agentName = createMemo<string | undefined>(() => {
    const t = session()?.title
    if (!t) return undefined
    const m = t.match(AGENT_TITLE_RE)
    return m?.[1]
  })

  // Subagent positional info. Filter+sort runs only when sync.data.session
  // OR session() reference changes — both stable across streaming deltas
  // (deltas update messages/parts, not the session list). The cost is
  // amortized across the lifetime of the subagent surface, not per delta.
  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "subagent", index: 0, total: 0 }
    const name = agentName()
    const label = name ? Locale.titlecase(name) : "Subagent"
    if (!s.parentID) return { label, index: 0, total: 0 }
    let total = 0
    let index = 0
    // Single pass — count siblings and rank-by-creation-time without an
    // intermediate filtered+sorted array.
    for (const x of sync.data.session) {
      if (x.parentID !== s.parentID) continue
      total++
      if (x.time.created < s.time.created) index++
    }
    return { label, index: index + 1, total }
  })

  // Usage strip — split per-field like the prompt's main usage strip so a
  // streaming delta only invalidates the field that actually moved. Single
  // walk source produces primitives; per-field memos format and short-
  // circuit on equality. Walks BACKWARD and breaks on first assistant with
  // tokens — O(1) at the tail (the common case during streaming and
  // immediately post-turn). cost still requires a forward sum but that's a
  // single arithmetic pass with no allocation.
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? (EMPTY_MESSAGES as Message[]))
  const usageSource = createMemo(() => {
    const list = messages()
    if (list.length === 0) return undefined
    let last: AssistantMessage | undefined
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (item.role === "assistant" && item.tokens.output > 0) {
        last = item as AssistantMessage
        break
      }
    }
    if (!last) return undefined
    let cost = 0
    for (const item of list) {
      if (item.role === "assistant") cost += item.cost
    }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    return { tokens, providerID: last.providerID, modelID: last.modelID, cost }
  })

  const usagePctNum = createMemo<number | undefined>(() => {
    const s = usageSource()
    if (!s) return undefined
    const limit = sync.data.provider.find((p) => p.id === s.providerID)?.models[s.modelID]?.limit.context
    if (!limit) return undefined
    return Math.round((s.tokens / limit) * 100)
  })

  const usageContext = createMemo<string | undefined>(() => {
    const s = usageSource()
    if (!s || s.tokens <= 0) return undefined
    const f = Locale.number(s.tokens)
    const p = usagePctNum()
    return p !== undefined ? `${f} (${p}%)` : f
  })

  const usageCost = createMemo<string | undefined>(() => {
    const c = usageSource()?.cost ?? 0
    return c > 0 ? MONEY.format(c) : undefined
  })

  const hasUsage = createMemo(() => usageContext() !== undefined)

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
            <Show when={hasUsage()}>
              <text fg={theme.border}>│</text>
              <text fg={theme.textMuted} wrapMode="none">
                <span style={{ fg: theme.textMuted }}>tokens</span>{" "}
                <span style={{ fg: theme.text }}>{usageContext()}</span>
                <Show when={usageCost()}>
                  <span style={{ fg: theme.textMuted }}> · </span>
                  <span style={{ fg: theme.text }}>{usageCost()}</span>
                </Show>
              </text>
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
