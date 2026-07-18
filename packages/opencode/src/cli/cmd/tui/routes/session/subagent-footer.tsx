import { createMemo, createSignal, Show, type JSX } from "solid-js"
import type { AssistantMessage, Message, Provider, Session } from "@opencode-ai/sdk/v2"
import type { RGBA } from "@opentui/core"
import { Locale } from "@/util/locale"
import { grad, mix, Spans } from "@tui/ui/glow"
import { formatSubagentStatus, type SubagentStatus } from "./subagent-status"

// Module-scope so we don't recompile per render. Title formats are set by
// the orchestrators and stable for the lifetime of a session. Two shapes
// exist in the wild:
//   - legacy v1 (tool/task.ts): "<description> (@<agent_type> subagent)"
//     → the capture is the AGENT TYPE (general, explore, ...).
//   - v2 (agent/control.ts:1031): "<task_name> (@<nickname>)"
//     → the capture is the NICKNAME (plato, newton, ...), NOT a type.
// Legacy is tried first: its parenthetical contains a space before the
// closing paren so the v2 regex can never match it, but keeping the order
// explicit documents the precedence.
const AGENT_TITLE_RE = /@(\w+) subagent/
const AGENT_TITLE_V2_RE = /\(@(\w+)\)$/

// Module-scope formatter. Was previously allocated INSIDE the usage memo
// → fresh Intl.NumberFormat per streaming delta.
const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

// Pure: extract the parenthesized agent name out of a session title, or
// undefined when the title matches neither orchestrator format. Legacy
// titles yield the agent TYPE; v2 titles yield the NICKNAME. The result is
// suitable as a display label; for agent-type lookups (e.g.
// local.agent.color) prefer session.agent — control.ts stores the real
// agent_type there — and only fall back to this parse.
export function agentNameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const legacy = title.match(AGENT_TITLE_RE)
  if (legacy) return legacy[1]
  return title.match(AGENT_TITLE_V2_RE)?.[1]
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
  // afterglow: chrome is lowercase — the label is the nickname/type as-is.
  const label = agentName ? agentName.toLowerCase() : "subagent"
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
  readonly background: RGBA
  readonly primary: RGBA
  readonly success: RGBA
  readonly warning: RGBA
  readonly error: RGBA
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
  readonly model?: string
  readonly variant?: string
  readonly width?: number
  readonly theme: SubagentFooterTheme
  readonly keybindParent: string
  readonly keybindPrev: string
  readonly keybindNext: string
  readonly onParent: () => void
  readonly onPrev: () => void
  readonly onNext: () => void
}

// status is temperature: running glows in primary, waiting holds warning
// heat, completed cools to success, errored burns.
function statusTone(theme: SubagentFooterTheme, status: SubagentStatus): RGBA {
  if (status === "running") return theme.primary
  if (status === "waiting") return theme.warning
  if (status === "errored") return theme.error
  return theme.success
}

// Pure-prop view. Used by the production wrapper below AND by tests that
// mount it without any context provider. Same testability pattern as
// process-tool.tsx — components that take theme + raw data as props can be
// rendered in isolation.
export function SubagentFooterView(props: SubagentFooterViewProps): JSX.Element {
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  // identity-tinted dissolving rule — the deck's fadeRule built against the
  // injected palette so the view stays context-free. transparent themes
  // (background.a === 0) fade toward textMuted.
  const ruleSpans = createMemo(() => {
    const width = Math.max(0, Math.min(56, props.width ?? 56))
    if (width === 0) return []
    const target = props.theme.background.a > 0 ? props.theme.background : props.theme.textMuted
    return grad("─".repeat(width), props.ruleColor, mix(props.ruleColor, target, 0.92))
  })
  return (
    <box flexShrink={0} flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text wrapMode="none" flexShrink={0} selectable={false}>
        <Spans spans={ruleSpans()} />
      </text>
      <box height={1} flexShrink={0} />
      <box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={2} flexShrink={0}>
        <text wrapMode="none" flexShrink={1}>
          <span style={{ fg: props.theme.text, bold: true }}>{props.label}</span>
          <Show when={props.total > 0}>
            <span style={{ fg: props.theme.textMuted }}>
              {" "}
              · {props.index} of {props.total}
            </span>
          </Show>
          <span style={{ fg: props.theme.textMuted }}> · </span>
          <span style={{ fg: statusTone(props.theme, props.status) }}>{formatSubagentStatus(props.status)}</span>
        </text>
        <box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
          <box onMouseOver={() => setHover("parent")} onMouseOut={() => setHover(null)} onMouseUp={props.onParent}>
            <text wrapMode="none">
              <span style={{ fg: hover() === "parent" ? props.theme.text : props.theme.textMuted }}>parent </span>
              <span style={{ fg: props.theme.text }}>{props.keybindParent}</span>
            </text>
          </box>
          <box onMouseOver={() => setHover("prev")} onMouseOut={() => setHover(null)} onMouseUp={props.onPrev}>
            <text wrapMode="none">
              <span style={{ fg: hover() === "prev" ? props.theme.text : props.theme.textMuted }}>prev </span>
              <span style={{ fg: props.theme.text }}>{props.keybindPrev}</span>
            </text>
          </box>
          <box onMouseOver={() => setHover("next")} onMouseOut={() => setHover(null)} onMouseUp={props.onNext}>
            <text wrapMode="none">
              <span style={{ fg: hover() === "next" ? props.theme.text : props.theme.textMuted }}>next </span>
              <span style={{ fg: props.theme.text }}>{props.keybindNext}</span>
            </text>
          </box>
        </box>
      </box>
      {/* the facts whisper: model · variant · context · cost — everything
          you need to know about the child at a glance, one dim line. */}
      <Show when={props.model || (props.hasUsage && props.usageContext)}>
        <text wrapMode="none" flexShrink={0} fg={props.theme.textMuted}>
          <Show when={props.model}>
            <span style={{ fg: props.theme.textMuted }}>{props.model}</span>
          </Show>
          <Show when={props.variant}>
            <span style={{ fg: props.theme.warning, bold: true }}> · {props.variant}</span>
          </Show>
          <Show when={props.hasUsage && props.usageContext}>
            <span style={{ fg: props.theme.textMuted }}>
              {props.model ? " · " : ""}
              {props.usageContext}
            </span>
          </Show>
          <Show when={props.usageCost}>
            <span style={{ fg: props.theme.textMuted }}> · {props.usageCost}</span>
          </Show>
        </text>
      </Show>
    </box>
  )
}

// Production wrapper that wires the heavy context hooks → derived signals
// → SubagentFooterView lives in `subagent-footer-mount.tsx`. Kept separate
// so this file (helpers + view) is unit-testable without provider mounting
// and reaches 100% line coverage from `subagent-footer.test.tsx` alone.

