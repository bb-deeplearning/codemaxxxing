import { createMemo } from "solid-js"
import type { Message } from "@opencode-ai/sdk/v2"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme, tint } from "@tui/context/theme"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useLocal } from "@tui/context/local"
import { useTerminalDimensions } from "@opentui/solid"
import {
  agentNameFromTitle,
  computeSubagentInfo,
  computeUsageSource,
  computeUsagePctNum,
  formatUsageContext,
  formatUsageCost,
  SubagentFooterView,
} from "./subagent-footer"
import { deriveSubagentStatus, type SubagentStatus } from "./subagent-status"
import { modelWord } from "@tui/ui/glow"

// Frozen empty messages sentinel — keeps reference identity stable when no
// messages exist yet so downstream memos don't see a fresh `[]` per call.
const EMPTY_MESSAGES: readonly Message[] = Object.freeze([]) as readonly Message[]

// Production wrapper. Wires the heavy context hooks → derived signals → the
// pure SubagentFooterView. Lives in a separate file from the view so the
// view + helpers in `subagent-footer.tsx` can be unit-tested without
// mounting any TUI provider stack.
export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const local = useLocal()
  const session = createMemo(() => sync.session.get(route.sessionID))

  const agentName = createMemo<string | undefined>(() => agentNameFromTitle(session()?.title))

  const subagentInfo = createMemo(() => computeSubagentInfo(sync.data.session, session(), agentName()))

  const messages = createMemo(() => sync.data.message[route.sessionID] ?? (EMPTY_MESSAGES as Message[]))

  // Wave 11: derive a four-state user-facing status (running / waiting /
  // completed / errored) from session_status + the latest assistant. See
  // subagent-status.ts for the mapping rationale.
  const status = createMemo<SubagentStatus>(() =>
    deriveSubagentStatus(sync.data.session_status?.[route.sessionID], messages()),
  )

  const usageSource = createMemo(() => computeUsageSource(messages()))

  const usagePctNum = createMemo<number | undefined>(() => {
    const s = usageSource()
    if (!s) return undefined
    return computeUsagePctNum(s, sync.data.provider)
  })

  const usageContext = createMemo<string | undefined>(() => formatUsageContext(usageSource(), usagePctNum()))
  const usageCost = createMemo<string | undefined>(() => formatUsageCost(usageSource()?.cost))
  const hasUsage = createMemo(() => usageContext() !== undefined)

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const dimensions = useTerminalDimensions()

  // the facts whisper: model from the child's latest assistant message
  // (falls back to a per-spawn model override on the session), variant
  // from the session's model ref when set.
  const model = createMemo<string | undefined>(() => {
    const source = usageSource()
    if (source?.modelID) return modelWord(source.modelID)
    const override = session()?.model
    return override ? modelWord(override.id) : undefined
  })
  const variant = createMemo<string | undefined>(() => session()?.model?.variant)

  // Top rule reflects which agent owns this subagent. When we know the
  // agent, tint the rule toward that color (subtly — half-blend with
  // theme.border so it's still chrome, not body) so this surface carries
  // identity even before reading the label.
  //
  // Color lookup keys on the agent TYPE: session().agent is the real
  // agent_type (set by control.ts at spawn). The title-parsed name is only
  // a fallback — for v2 titles it is a NICKNAME, and local.agent.color
  // silently returns the first palette color for any name that isn't a
  // registered agent type, which would flatten every subagent to one
  // color. The label keeps using the parsed name (nickname or type).
  const ruleColor = createMemo(() => {
    const key = session()?.agent ?? agentName()
    if (!key) return theme.border
    return tint(theme.border, local.agent.color(key), 0.6)
  })

  return (
    <SubagentFooterView
      label={subagentInfo().label}
      index={subagentInfo().index}
      total={subagentInfo().total}
      status={status()}
      ruleColor={ruleColor()}
      hasUsage={hasUsage()}
      usageContext={usageContext()}
      usageCost={usageCost()}
      model={model()}
      variant={variant()}
      width={Math.max(0, dimensions().width - 4)}
      theme={theme}
      keybindParent={keybind.print("session_parent")}
      keybindPrev={keybind.print("session_child_cycle_reverse")}
      keybindNext={keybind.print("session_child_cycle")}
      onParent={() => command.trigger("session.parent")}
      onPrev={() => command.trigger("session.child.previous")}
      onNext={() => command.trigger("session.child.next")}
    />
  )
}
