import { createSignal, Show, type JSX } from "solid-js"
import type { AssistantMessage, Message, Provider, Session } from "@opencode-ai/sdk/v2"
import type { RGBA } from "@opentui/core"
import { Locale } from "@/util/locale"
import { formatSubagentStatus, type SubagentStatus } from "./subagent-status"

// Inlined horizontal-rule border chars. Mirrors the Rule primitive in
// component/border.tsx but without the useTheme() dependency — the view
// must mount without any TUI context provider, so we can't use Rule here.
// Module-scope so opentui can identity-compare the chars object across
// renders for its internal cell cache.
const RULE_BORDER_CHARS = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: "─",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
} as const

// Module-scope so we don't recompile per render. Title format is set by
// the orchestrator and stable for the lifetime of a session.
const AGENT_TITLE_RE = /@(\w+) subagent/

// Module-scope formatter. Was previously allocated INSIDE the usage memo
// → fresh Intl.NumberFormat per streaming delta.
const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

// Pure: extract the "@<slug> subagent" agent name out of a session title,
// or undefined when the title doesn't match the orchestrator's format. Used
// by the footer to color-tint the rule and label by agent identity.
export function agentNameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const m = title.match(AGENT_TITLE_RE)
  return m?.[1]
}

// Pure: count siblings under the same parent and compute the 1-based index
// of `current` among them by creation time. Returns the user-facing label
// titlecased from the agent name (or "Subagent" / "subagent" sentinels).
export function computeSubagentInfo(
  sessions: readonly Session[],
  current: Session | undefined,
  agentName: string | undefined,
): { label: string; index: number; total: number } {
  if (!current) return { label: "subagent", index: 0, total: 0 }
  const label = agentName ? Locale.titlecase(agentName) : "Subagent"
  if (!current.parentID) return { label, index: 0, total: 0 }
  let total = 0
  let index = 0
  for (const x of sessions) {
    if (x.parentID !== current.parentID) continue
    total++
    if (x.time.created < current.time.created) index++
  }
  return { label, index: index + 1, total }
}

export interface UsageSource {
  readonly tokens: number
  readonly providerID: string
  readonly modelID: string
  readonly cost: number
}

// Pure: walks backward to find the latest assistant with output, then sums
// cost across all assistants in the list. Mirrors the prompt's main usage
// strip so a streaming delta only invalidates what actually moved.
export function computeUsageSource(messages: readonly Message[]): UsageSource | undefined {
  if (messages.length === 0) return undefined
  let last: AssistantMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (item.role === "assistant" && item.tokens.output > 0) {
      last = item as AssistantMessage
      break
    }
  }
  if (!last) return undefined
  let cost = 0
  for (const item of messages) {
    if (item.role === "assistant") cost += item.cost
  }
  const tokens =
    last.tokens.input +
    last.tokens.output +
    last.tokens.reasoning +
    last.tokens.cache.read +
    last.tokens.cache.write
  return { tokens, providerID: last.providerID, modelID: last.modelID, cost }
}

// Pure: compute the percentage-of-context-limit for a usage source, given
// the available providers list. undefined when the provider/model is not
// found (the limit can't be computed).
export function computeUsagePctNum(source: UsageSource, providers: readonly Provider[]): number | undefined {
  const limit = providers.find((p) => p.id === source.providerID)?.models[source.modelID]?.limit.context
  if (!limit) return undefined
  return Math.round((source.tokens / limit) * 100)
}

// Pure: render the context-tokens display string with optional pct suffix.
// undefined when source is missing or token count is zero (no display).
export function formatUsageContext(source: UsageSource | undefined, pct: number | undefined): string | undefined {
  if (!source || source.tokens <= 0) return undefined
  const f = Locale.number(source.tokens)
  return pct !== undefined ? `${f} (${pct}%)` : f
}

// Pure: format a positive cost as USD currency, undefined for non-positive.
export function formatUsageCost(cost: number | undefined): string | undefined {
  if (!cost || cost <= 0) return undefined
  return MONEY.format(cost)
}

export interface SubagentFooterTheme {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly border: RGBA
}

export interface SubagentFooterViewProps {
  readonly label: string
  readonly index: number
  readonly total: number
  readonly status: SubagentStatus
  readonly ruleColor: RGBA
  readonly hasUsage: boolean
  readonly usageContext?: string
  readonly usageCost?: string
  readonly theme: SubagentFooterTheme
  readonly keybindParent: string
  readonly keybindPrev: string
  readonly keybindNext: string
  readonly onParent: () => void
  readonly onPrev: () => void
  readonly onNext: () => void
}

// Pure-prop view. Used by the production wrapper below AND by tests that
// mount it without any context provider. Same testability pattern as
// process-tool.tsx — components that take theme + raw data as props can be
// rendered in isolation.
export function SubagentFooterView(props: SubagentFooterViewProps): JSX.Element {
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  return (
    <box flexShrink={0} flexDirection="column">
      <box
        flexShrink={0}
        flexGrow={1}
        height={1}
        border={["bottom"]}
        customBorderChars={RULE_BORDER_CHARS}
        borderColor={props.ruleColor}
      />
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1} flexShrink={0}>
        <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <box flexDirection="row" alignItems="center" gap={1}>
            <text fg={props.theme.text}>
              <b>{props.label}</b>
            </text>
            <Show when={props.total > 0}>
              <text fg={props.theme.textMuted}>
                ({props.index} of {props.total})
              </text>
            </Show>
            <text fg={props.theme.border}>│</text>
            <text fg={props.theme.textMuted} wrapMode="none">
              <span style={{ fg: props.theme.textMuted }}>status</span>{" "}
              <span style={{ fg: props.theme.text }}>{formatSubagentStatus(props.status)}</span>
            </text>
            <Show when={props.hasUsage && props.usageContext}>
              <text fg={props.theme.border}>│</text>
              <text fg={props.theme.textMuted} wrapMode="none">
                <span style={{ fg: props.theme.textMuted }}>tokens</span>{" "}
                <span style={{ fg: props.theme.text }}>{props.usageContext}</span>
                <Show when={props.usageCost}>
                  <span style={{ fg: props.theme.textMuted }}> · </span>
                  <span style={{ fg: props.theme.text }}>{props.usageCost}</span>
                </Show>
              </text>
            </Show>
          </box>
          <box flexDirection="row" alignItems="center" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={props.onParent}
            >
              <text>
                <span
                  style={{ fg: hover() === "parent" ? props.theme.text : props.theme.textMuted, bold: hover() === "parent" }}
                >
                  parent
                </span>{" "}
                <span style={{ fg: props.theme.textMuted }}>{props.keybindParent}</span>
              </text>
            </box>
            <text fg={props.theme.border}>│</text>
            <box onMouseOver={() => setHover("prev")} onMouseOut={() => setHover(null)} onMouseUp={props.onPrev}>
              <text>
                <span
                  style={{ fg: hover() === "prev" ? props.theme.text : props.theme.textMuted, bold: hover() === "prev" }}
                >
                  prev
                </span>{" "}
                <span style={{ fg: props.theme.textMuted }}>{props.keybindPrev}</span>
              </text>
            </box>
            <box onMouseOver={() => setHover("next")} onMouseOut={() => setHover(null)} onMouseUp={props.onNext}>
              <text>
                <span
                  style={{ fg: hover() === "next" ? props.theme.text : props.theme.textMuted, bold: hover() === "next" }}
                >
                  next
                </span>{" "}
                <span style={{ fg: props.theme.textMuted }}>{props.keybindNext}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}

// Production wrapper that wires the heavy context hooks → derived signals
// → SubagentFooterView lives in `subagent-footer-mount.tsx`. Kept separate
// so this file (helpers + view) is unit-testable without provider mounting
// and reaches 100% line coverage from `subagent-footer.test.tsx` alone.

