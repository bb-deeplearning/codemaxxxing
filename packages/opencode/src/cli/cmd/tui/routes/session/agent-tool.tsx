/** @jsxImportSource @opentui/solid */
import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import type { Tool } from "@/tool/tool"
import type { AgentSpawnTool } from "@/tool/agent-spawn/agent-spawn"
import type { AgentWaitTool } from "@/tool/agent-wait/agent-wait"
import type { AgentSendTool } from "@/tool/agent-send/agent-send"
import type { AgentFollowupTool } from "@/tool/agent-followup/agent-followup"
import type { AgentListTool } from "@/tool/agent-list/agent-list"
import type { AgentCloseTool } from "@/tool/agent-close/agent-close"
import { inlineSafe } from "@tui/util/inline-safe"
import { Locale } from "@/util/locale"
import {
  formatAgentIdentity,
  displayNickname,
  displayPath,
  type AgentIdentity,
} from "./agent-identity"
import type { SubagentStatus } from "./subagent-status"

// Pure-view renderers for the wave-8 multi-agent v2 tools. Live in their
// own file (mirroring process-tool.tsx) so the views can be unit-rendered
// in isolation without mounting the Theme/Sync/Session provider stack.
// The production wrapper that wires hooks → derived signals → these views
// lives in `agent-tool-mount.tsx`.
//
// Layout antipatterns to AVOID (specs/tui-render-freeze.md, GOTCHAS L957
// `tui-flex-row-with-tall-text`):
//   - No <box flexDirection="row"> wrapping a child whose content can grow
//     tall. Tall children (the model's initial spawn message, list_agents
//     output rows) are rendered as a SINGLE <text> with `\n`-joined lines
//     so opentui's flex-measure pass stays cheap. The Task renderer in
//     index.tsx uses the same pattern (content.join("\n")).
//   - No N sibling <text> nodes for the header chrome; one <text> with
//     <span> children. Per GOTCHAS L535 (`opentui-multi-text-node-vs-
//     single-baseline-cap`), N text nodes scale ~1.5× a single text node
//     even at N=2.
//   - All user/model strings interpolated into the header are
//     pre-sanitized via inlineSafe so a multi-KB / multi-line input
//     can't blow the row's measurement budget.
//
// Mosh-on-iPad checklist (mosh diffs cells; minimize churn):
//   - Static structure (label, target, body) is the same shape across
//     pending → running → complete; only the text inside swaps. This
//     lets mosh's predictive engine update one logical line per state
//     change instead of remounting the row.
//   - All derived strings memoized; no per-render allocations.

// Header strings (label, target, message preview) are capped via
// inlineSafe. Keeps the row to one logical line on narrow terminals and
// defends against multi-KB model inputs blowing the row's flex budget.
const HEADER_TARGET_MAX = 80
const HEADER_MESSAGE_MAX = 200

export interface AgentToolTheme {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly accent: RGBA
  readonly success: RGBA
  readonly warning: RGBA
  readonly error: RGBA
}

// ─── shared helpers ───────────────────────────────────────────────────

// Pure: detect failure by the presence of metadata.error. Every wave-8
// agent tool sets metadata.error to a stable string tag on the failure
// branches (spawn: path_invalid / depth_exceeded / etc; wait:
// invalid_timeout; send: empty_message / target_not_found / send_failed;
// etc). Absent → success.
export function isErrorMetadata(metadata: { error?: unknown }): metadata is { error: string; reason?: string } {
  return typeof metadata.error === "string"
}

// Pure: detect a part that's still pending model invocation. Distinct
// from "running" (tool is mid-execution) — pending is "about to start".
function isPending(part: ToolPart): boolean {
  return part.state.status === "pending"
}

// Pure: detect a part that's currently executing. Used to spinner the
// wait_agent header (the only agent tool with a meaningful running phase).
function isRunning(part: ToolPart): boolean {
  return part.state.status === "running"
}

// Pure: pull state.error string if the part errored at the runtime level
// (vs the tool returning a metadata.error). A runtime error is e.g. a
// permission rejection that bypassed the tool's own error path.
function statusError(part: ToolPart): string | undefined {
  return part.state.status === "error" ? part.state.error : undefined
}

// Pure: identify denied-permission errors so we can strikethrough rather
// than show an alarming red error. Mirrors the InlineTool denial check
// in routes/session/index.tsx.
const DENY_PATTERNS = [
  "QuestionRejectedError",
  "rejected permission",
  "specified a rule",
  "user dismissed",
] as const
function isDenied(error: string | undefined): boolean {
  if (!error) return false
  for (const p of DENY_PATTERNS) if (error.includes(p)) return true
  return false
}

// Pure: format milliseconds to a compact display ("4s", "12s", "350ms").
// Used by the spawn back-link footer. Uses Locale.duration for >= 1s, and
// raw ms for sub-second so micro-spawns don't all read "0s".
export function formatDuration(durationMs: number): string {
  if (durationMs < 0) return "0s"
  if (durationMs < 1000) return `${durationMs}ms`
  return Locale.duration(durationMs)
}

// Pure: format a timeout in ms to a human-readable seconds value
// ("30s", "1500ms" for sub-second). Used by the wait_agent header.
export function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 1000) return `${timeoutMs}ms`
  // Drop trailing .0 for whole seconds.
  const seconds = timeoutMs / 1000
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
}

// Pure: shorten a long body to a one-line preview suitable for inline
// display. Strips newlines (renders as a space), trims, caps via
// inlineSafe. Returns "" for empty input so callers can short-circuit.
//
// STREAMING PERF: this fires per delta on the model's streaming tool
// input (spawn's `message`, send's `message`, etc). The naive shape —
// regex over the full body, then truncate — is O(body length) per delta,
// which compounds to O(N²) over the full stream when body length grows
// linearly with delta count. The mosh-on-iPad target makes this a real
// regression. We pre-truncate to `max * 2` BEFORE the regex so the
// regex always operates on a bounded buffer (≤2× the display cap).
// The ×2 slack absorbs the case where the chosen truncation point sits
// inside a newline run that would have collapsed to a single space.
export function previewMessage(body: string | undefined, max: number = HEADER_MESSAGE_MAX): string {
  if (!body) return ""
  // Pre-truncate. The full body still lives in props.input.message for
  // any consumer that wants the original; this string is display-only.
  const bounded = body.length > max * 2 ? body.slice(0, max * 2) : body
  // Replace newlines with a single space first so inlineSafe doesn't see
  // multi-line content (its primary safety net is for multi-line input).
  const flat = bounded.replace(/\r?\n+/g, " ").trim()
  return inlineSafe(flat, max)
}

// Pure: parse list_agents output JSON into a typed array. Returns []
// when output is missing / not parseable / wrong shape — defensive,
// because output is just a string from the tool.
export interface ListedAgent {
  readonly agent_name: string
  readonly agent_status: string
  readonly last_task_message: string | null
}
export function parseListAgentsOutput(output: string | undefined): readonly ListedAgent[] {
  if (!output) return EMPTY_AGENTS
  try {
    const parsed = JSON.parse(output)
    const arr = parsed?.agents
    if (!Array.isArray(arr)) return EMPTY_AGENTS
    return arr
      .filter((a) => a && typeof a === "object")
      .map((a) => ({
        agent_name: typeof a.agent_name === "string" ? a.agent_name : "",
        agent_status: agentStatusToLabel(a.agent_status),
        last_task_message: typeof a.last_task_message === "string" ? a.last_task_message : null,
      }))
  } catch {
    return EMPTY_AGENTS
  }
}
const EMPTY_AGENTS: readonly ListedAgent[] = Object.freeze([])

// Pure: collapse codex's rich AgentStatus union to a one-word label.
// codex shape examples:
//   "running" / "interrupted" / "pending_init" / "shutdown" / "not_found"
//   { completed: "...last message..." | null }
//   { errored: "..." }
function agentStatusToLabel(status: unknown): string {
  if (typeof status === "string") return status
  if (status && typeof status === "object") {
    if ("completed" in status) return "completed"
    if ("errored" in status) return "errored"
  }
  return "unknown"
}

// Pure: map a status label to the theme color for emphasis. Used by
// chrome and back-link footers across views.
export function statusColor(theme: AgentToolTheme, status: SubagentStatus | string): RGBA {
  switch (status) {
    case "running":
      return theme.accent
    case "completed":
    case "done":
      return theme.success
    case "errored":
    case "failed":
    case "interrupted":
      return theme.error
    case "waiting":
    case "pending_init":
    case "shutdown":
    default:
      return theme.textMuted
  }
}

// ─── shared chrome row ────────────────────────────────────────────────

// One-line tool header. Always a SINGLE <text> with <span> children —
// never multiple sibling <text> nodes — to honor GOTCHAS L535. The
// `body` slot below is rendered as a vertically-stacked <text> sibling
// so tall content (multi-line previews, list rows) doesn't sit inside a
// flex-row.
function ToolRow(props: {
  theme: AgentToolTheme
  // The leading verb: "spawn", "wait", etc.
  label: string
  // Optional middle slot rendered as `· <chrome>`. The chrome is its own
  // span fragment so it can carry inline color emphasis (e.g. nickname
  // bold + colored, type muted).
  chrome?: JSX.Element
  // Trailing slot rendered as `· <suffix>`. Same pattern as chrome but
  // muted by default.
  suffix?: string
  // Multi-line body block (preview, list rows, back-link footer). Renders
  // as ONE text node with `\n` joined lines — vertical sibling to the
  // header, NOT inside a row.
  body?: string
  // Optional click handler — typically the back-link toggle or a navigate
  // into the spawned child's session.
  onClick?: () => void
  part: ToolPart
  // When true, render the header with strikethrough (denied permission).
  denied?: boolean
  // When true, render with a yellow tint (a permission prompt is open
  // for this call). Mirrors InlineTool's permission highlight.
  permissionPending?: boolean
  // When true, show a leading spinner glyph before the label. Used only
  // by the wait_agent renderer during its actual blocking phase.
  spinner?: boolean
}) {
  const error = createMemo(() => statusError(props.part))
  const denied = createMemo(() => props.denied ?? isDenied(error()))

  // Single fg memo. Mirrors InlineTool's permission-then-hover-then-state
  // logic. We don't drive hover here — the agent tool views are mostly
  // status-bearing, not navigable, so hover is reserved for the click-
  // handler case where it matters.
  const fg = createMemo(() => {
    if (props.permissionPending) return props.theme.warning
    if (props.part.state.status === "completed") return props.theme.textMuted
    return props.theme.text
  })

  return (
    <box marginTop={1} flexShrink={0} flexDirection="column" onMouseUp={props.onClick}>
      {/* Header — single text node with span children. */}
      <text fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show when={props.spinner}>
          <span style={{ fg: props.theme.accent }}>… </span>
        </Show>
        <span>{props.label}</span>
        <Show when={props.chrome}>
          <span style={{ fg: props.theme.textMuted }}> · </span>
          {props.chrome}
        </Show>
        <Show when={props.suffix}>
          <span style={{ fg: props.theme.textMuted }}> · {props.suffix}</span>
        </Show>
      </text>
      {/* Body — vertical sibling. Char-wrap (default), no flex-row. */}
      <Show when={props.body}>
        <text fg={props.theme.textMuted}>{props.body}</text>
      </Show>
      {/* Runtime errors (permission rejections etc) shown below the body. */}
      <Show when={error() && !denied()}>
        <text fg={props.theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

// ─── per-tool views ───────────────────────────────────────────────────

// Spawn back-link, computed by the mount wrapper from
// sync.data.session_status[child_session_id] + sync.data.message[child_session_id].
// Same shape as the SubagentFooter status derivation. Only present for
// successful spawns where the child session is now visible in sync data.
export interface SpawnBackLink {
  readonly status: SubagentStatus
  readonly toolCount: number
  readonly durationMs: number
}

// Pure: format the back-link footer string. Examples:
//   "└ done · 4 tools · 8s"
//   "└ failed · 2 tools · 2s"
//   "└ running · 1 tool · 4s"
//   "└ waiting"  (no tools yet, no duration)
export function formatBackLink(b: SpawnBackLink): string {
  const verb =
    b.status === "completed"
      ? "done"
      : b.status === "errored"
        ? "failed"
        : b.status
  const parts: string[] = [verb]
  if (b.toolCount > 0) parts.push(`${b.toolCount} ${b.toolCount === 1 ? "tool" : "tools"}`)
  if (b.durationMs > 0) parts.push(formatDuration(b.durationMs))
  return `└ ${parts.join(" · ")}`
}

export interface SpawnViewProps {
  readonly theme: AgentToolTheme
  readonly part: ToolPart
  readonly input: Partial<Tool.InferParameters<typeof AgentSpawnTool>>
  readonly metadata: Partial<Tool.InferMetadata<typeof AgentSpawnTool>>
  readonly nicknameColor?: RGBA
  readonly backlink?: SpawnBackLink
  // True when a permission prompt is currently open for this call.
  readonly permissionPending?: boolean
  // Click handler — navigates into the spawned child's session. Only set
  // by the mount wrapper when metadata.child_session_id is known.
  readonly onOpenChild?: () => void
}

// spawn_agent renderer.
//
// Pending:           spawn · …
// Success:           spawn · Lovelace explore · /root/git_historian
//                    ↳ "Use the shell tool to run `git log --oneline -5`..."
// Success + done:    [...above...]
//                    └ done · 1 tool · 4s   (or failed/running/waiting)
// Failure (e.g.      spawn · git_historian explore · path_invalid
//   path_invalid):   └ failed · segment must use only lowercase letters...
export function SpawnView(props: SpawnViewProps): JSX.Element {
  const errored = createMemo(() => isErrorMetadata(props.metadata))

  const identity = createMemo<AgentIdentity>(() => {
    const meta = props.metadata as { task_name?: string; nickname?: string }
    return {
      nickname: meta.nickname,
      agent_type: props.input.agent_type,
      // Failed spawns: surface the requested task_name as the path so the
      // user sees what the model TRIED to call it. Successful spawns:
      // metadata.task_name is the canonical /root/<leaf> form.
      path: meta.task_name ?? props.input.task_name,
    }
  })

  const messagePreview = createMemo(() => previewMessage(props.input.message))

  const body = createMemo(() => {
    const lines: string[] = []
    if (!errored() && messagePreview()) lines.push(`↳ "${messagePreview()}"`)
    if (errored()) {
      const reason = (props.metadata as { reason?: string }).reason
      if (reason) lines.push(`└ failed · ${inlineSafe(reason, HEADER_MESSAGE_MAX)}`)
    }
    if (!errored() && props.backlink) lines.push(formatBackLink(props.backlink))
    return lines.length > 0 ? lines.join("\n") : undefined
  })

  // Suffix carries either the canonical path (success) or the error tag
  // (failure). Either is one short token.
  const suffix = createMemo(() => {
    if (errored()) return (props.metadata as { error?: string }).error
    const path = (props.metadata as { task_name?: string }).task_name
    return path
  })

  // Identity chrome: nickname (bold + colored) + agent_type (muted), or
  // the requested task_name when the spawn failed and we have no nickname.
  const chrome = createMemo(() => {
    const id = identity()
    const nick = displayNickname(id.nickname)
    const fallback = displayPath(id.path) ?? id.path
    const label = nick ?? fallback ?? "agent"
    return (
      <>
        <span
          style={{
            fg: props.nicknameColor ?? props.theme.text,
            bold: true,
          }}
        >
          {label}
        </span>
        <Show when={id.agent_type}>
          <span style={{ fg: props.theme.textMuted }}> {id.agent_type}</span>
        </Show>
      </>
    )
  })

  return (
    <ToolRow
      theme={props.theme}
      label="spawn"
      chrome={chrome()}
      suffix={suffix()}
      body={body()}
      part={props.part}
      permissionPending={props.permissionPending}
      onClick={!errored() && props.onOpenChild ? props.onOpenChild : undefined}
    />
  )
}

// wait_agent renderer.
//
// Pending / running:  wait · 30s          (with leading spinner glyph)
// Completed (got msg):wait · 30s
//                     └ completed
// Timed out:          wait · 30s
//                     └ timed out
// Invalid timeout:    wait · 0ms
//                     └ failed · timeout_ms must be greater than zero
export interface WaitViewProps {
  readonly theme: AgentToolTheme
  readonly part: ToolPart
  readonly input: Partial<Tool.InferParameters<typeof AgentWaitTool>>
  readonly metadata: Partial<Tool.InferMetadata<typeof AgentWaitTool>>
  readonly permissionPending?: boolean
}

export function WaitView(props: WaitViewProps): JSX.Element {
  const timeoutMs = createMemo(() => {
    // Prefer metadata.timeout_ms (clamped server-side) over input.timeout_ms
    // (raw model value) so the displayed value matches what actually fired.
    const meta = props.metadata as { timeout_ms?: number }
    if (typeof meta.timeout_ms === "number") return meta.timeout_ms
    if (typeof props.input.timeout_ms === "number") return props.input.timeout_ms
    return 30000
  })

  const errored = createMemo(() => isErrorMetadata(props.metadata))
  const meta = createMemo(() => props.metadata as { timed_out?: boolean; error?: string; reason?: string })

  const body = createMemo(() => {
    if (errored()) {
      const reason = meta().reason ?? "invalid timeout"
      return `└ failed · ${inlineSafe(reason, HEADER_MESSAGE_MAX)}`
    }
    if (meta().timed_out === true) return "└ timed out"
    if (meta().timed_out === false) return "└ completed"
    return undefined
  })

  return (
    <ToolRow
      theme={props.theme}
      label="wait"
      suffix={formatTimeout(timeoutMs())}
      body={body()}
      part={props.part}
      permissionPending={props.permissionPending}
      spinner={isPending(props.part) || isRunning(props.part)}
    />
  )
}

// send_message renderer.
//
// Pending / sending:  send → newton
// Sent:               send → newton · "results look good, integrate them"
// Error:              send → newton
//                     └ failed · target not found: ...
export interface SendViewProps {
  readonly theme: AgentToolTheme
  readonly part: ToolPart
  readonly input: Partial<Tool.InferParameters<typeof AgentSendTool>>
  readonly metadata: Partial<Tool.InferMetadata<typeof AgentSendTool>>
  readonly permissionPending?: boolean
}

export function SendView(props: SendViewProps): JSX.Element {
  const target = createMemo(() => inlineSafe(props.input.target ?? "", HEADER_TARGET_MAX))
  const errored = createMemo(() => isErrorMetadata(props.metadata))
  const messagePreview = createMemo(() => previewMessage(props.input.message))

  const body = createMemo(() => {
    if (errored()) {
      const reason = (props.metadata as { reason?: string; error?: string }).reason
        ?? (props.metadata as { error?: string }).error
        ?? "send failed"
      return `└ failed · ${inlineSafe(reason, HEADER_MESSAGE_MAX)}`
    }
    if (messagePreview()) return `"${messagePreview()}"`
    return undefined
  })

  return (
    <ToolRow
      theme={props.theme}
      label="send"
      chrome={
        <>
          <span style={{ fg: props.theme.textMuted }}>→ </span>
          <span style={{ fg: props.theme.text }}>{target()}</span>
        </>
      }
      body={body()}
      part={props.part}
      permissionPending={props.permissionPending}
    />
  )
}

// followup_task renderer.
//
// Pending:    followup ↯ newton
// Sent:       followup ↯ newton · "now review the wave 6 changes"
//             └ will trigger next turn
// Error:      followup ↯ newton
//             └ failed · ...
//
// The ↯ glyph is the same wake-mark already used by mailbox-message.tsx
// for trigger_turn parts. Keeps the wake semantics visually consistent.
export interface FollowupViewProps {
  readonly theme: AgentToolTheme
  readonly part: ToolPart
  readonly input: Partial<Tool.InferParameters<typeof AgentFollowupTool>>
  readonly metadata: Partial<Tool.InferMetadata<typeof AgentFollowupTool>>
  readonly permissionPending?: boolean
}

export function FollowupView(props: FollowupViewProps): JSX.Element {
  const target = createMemo(() => inlineSafe(props.input.target ?? "", HEADER_TARGET_MAX))
  const errored = createMemo(() => isErrorMetadata(props.metadata))
  const messagePreview = createMemo(() => previewMessage(props.input.message))

  const body = createMemo(() => {
    const lines: string[] = []
    if (errored()) {
      const reason = (props.metadata as { reason?: string; error?: string }).reason
        ?? (props.metadata as { error?: string }).error
        ?? "followup failed"
      lines.push(`└ failed · ${inlineSafe(reason, HEADER_MESSAGE_MAX)}`)
    } else {
      if (messagePreview()) lines.push(`"${messagePreview()}"`)
      // Only flag the "will trigger next turn" footer when the queue
      // succeeded — the meta carries trigger_turn:true on the success path.
      if ((props.metadata as { trigger_turn?: boolean }).trigger_turn === true) {
        lines.push("└ will trigger next turn")
      }
    }
    return lines.length > 0 ? lines.join("\n") : undefined
  })

  return (
    <ToolRow
      theme={props.theme}
      label="followup"
      chrome={
        <>
          <span style={{ fg: props.theme.textMuted }}>↯ </span>
          <span style={{ fg: props.theme.text }}>{target()}</span>
        </>
      }
      body={body()}
      part={props.part}
      permissionPending={props.permissionPending}
    />
  )
}

// list_agents renderer.
//
// Pending:           list
// Success (3 live):  list · 3 live
//                    ↳ root/git_historian   explore   running     scanning git log
//                    ↳ root/wave_review     general   waiting     drafting summary
//                    ↳ root/test_audit      review    completed
// Error:             list
//                    └ failed · invalid prefix
//
// Each child row is a fixed-width column layout joined into a SINGLE
// text node (no <For>, no per-row text node) so render cost scales with
// total bytes, not row count.
export interface ListViewProps {
  readonly theme: AgentToolTheme
  readonly part: ToolPart
  readonly input: Partial<Tool.InferParameters<typeof AgentListTool>>
  readonly metadata: Partial<Tool.InferMetadata<typeof AgentListTool>>
  readonly output?: string
  readonly permissionPending?: boolean
}

// Width caps for the columnar list_agents body. Each row is built as a
// single line by padding the name and status columns; the last_task_message
// column wraps as a separate visual hint by being shown after a couple of
// spaces. Fixed widths keep the body visually tabular without measuring.
const LIST_NAME_WIDTH = 28
const LIST_STATUS_WIDTH = 12

function padRight(s: string, width: number): string {
  if (s.length >= width) return s
  return s + " ".repeat(width - s.length)
}

// Pure: build the joined-rows string for the list body. Exported for unit
// testing. Returns "" when there are no rows.
export function buildListBody(agents: readonly ListedAgent[]): string {
  if (agents.length === 0) return ""
  const lines: string[] = []
  for (const a of agents) {
    const name = padRight(displayPath(a.agent_name) ?? a.agent_name, LIST_NAME_WIDTH)
    const status = padRight(a.agent_status, LIST_STATUS_WIDTH)
    const tail = a.last_task_message ? `  ${inlineSafe(a.last_task_message, 120)}` : ""
    lines.push(`↳ ${name}${status}${tail}`)
  }
  return lines.join("\n")
}

export function ListView(props: ListViewProps): JSX.Element {
  const errored = createMemo(() => isErrorMetadata(props.metadata))
  const agents = createMemo(() => parseListAgentsOutput(props.output))
  const count = createMemo(() => {
    const meta = props.metadata as { agent_count?: number }
    if (typeof meta.agent_count === "number") return meta.agent_count
    return agents().length
  })

  const suffix = createMemo(() => {
    if (errored()) return undefined
    if (count() === 0) return undefined
    return `${count()} live`
  })

  const body = createMemo(() => {
    if (errored()) {
      const reason = (props.metadata as { reason?: string }).reason ?? "list failed"
      return `└ failed · ${inlineSafe(reason, HEADER_MESSAGE_MAX)}`
    }
    return buildListBody(agents()) || undefined
  })

  return (
    <ToolRow
      theme={props.theme}
      label="list"
      suffix={suffix()}
      body={body()}
      part={props.part}
      permissionPending={props.permissionPending}
    />
  )
}

// close_agent renderer.
//
// Pending:    close → newton
// Success:    close → newton · was running
// Error:      close → /root
//             └ failed · root is not a spawned agent
export interface CloseViewProps {
  readonly theme: AgentToolTheme
  readonly part: ToolPart
  readonly input: Partial<Tool.InferParameters<typeof AgentCloseTool>>
  readonly metadata: Partial<Tool.InferMetadata<typeof AgentCloseTool>>
  readonly permissionPending?: boolean
}

export function CloseView(props: CloseViewProps): JSX.Element {
  const target = createMemo(() => inlineSafe(props.input.target ?? "", HEADER_TARGET_MAX))
  const errored = createMemo(() => isErrorMetadata(props.metadata))

  const suffix = createMemo(() => {
    if (errored()) return undefined
    const prev = (props.metadata as { previous_status?: unknown }).previous_status
    if (typeof prev === "string") return `was ${prev}`
    if (prev && typeof prev === "object") {
      if ("completed" in prev) return "was completed"
      if ("errored" in prev) return "was errored"
    }
    return undefined
  })

  const body = createMemo(() => {
    if (errored()) {
      const reason = (props.metadata as { reason?: string; error?: string }).reason
        ?? (props.metadata as { error?: string }).error
        ?? "close failed"
      return `└ failed · ${inlineSafe(reason, HEADER_MESSAGE_MAX)}`
    }
    return undefined
  })

  return (
    <ToolRow
      theme={props.theme}
      label="close"
      chrome={
        <>
          <span style={{ fg: props.theme.textMuted }}>→ </span>
          <span style={{ fg: props.theme.text }}>{target()}</span>
        </>
      }
      suffix={suffix()}
      body={body()}
      part={props.part}
      permissionPending={props.permissionPending}
    />
  )
}

export * as AgentTool from "./agent-tool"
