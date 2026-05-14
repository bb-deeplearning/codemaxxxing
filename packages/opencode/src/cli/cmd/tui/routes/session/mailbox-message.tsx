import { createMemo, createSignal, type JSX } from "solid-js"
import { Show } from "solid-js"
import type { TextPart } from "@opencode-ai/sdk/v2"
import type { RGBA } from "@opentui/core"
import stripAnsi from "strip-ansi"
import { inlineSafe } from "../../util/inline-safe"

// Wave 11: render a synthetic UserPart that originated from another agent's
// mailbox send. Wave 9's `injectMailboxMessages` produces these parts with:
//
//   - type: "text"
//   - synthetic: true
//   - metadata.from = AgentPath of the sender (e.g. "/root/explorers/worker_1")
//   - metadata.sent_at = sender-side timestamp
//   - metadata.trigger_turn = whether this message woke the recipient or
//                              just queued
//   - text = "[from <author>]: <content>"
//
// The body's "[from ...]: " prefix is for the model's text channel — the
// model sees the source even when it can't read TUI chrome. The TUI's job
// is to make the source obvious to the human reader via explicit chrome
// (an arrow + author label) and then strip the prefix from the displayed
// body so the user doesn't see it twice.
//
// codemaxxxing addition: when the inbound message was synthesized by the
// AgentControl spawn-watcher (control.ts:701-702) on a child's final
// status transition, the body starts with an orchestration header like
// "Agent /root/git_historian reached status: completed\n\n". The header is
// model-meta — the chrome already conveys "from X" and the user doesn't
// need to read the path again. We strip the header from the displayed
// body and fold the status word into the chrome so the user reads:
//     ← from <author> · completed
//     <agent's actual answer>
// instead of the three-layer onion (chrome + framing + payload).
//
// Layout note: this component MUST NOT wrap a body whose content can grow
// tall in `flexDirection="row"`. Sibling messages can carry forwarded tool
// output (multi-KB realistic). The chrome line is short and inline-safe;
// the body stacks vertically as a sibling text node so opentui's flex
// pass never measures a tall flex-row child. See
// `specs/tui-render-freeze.md` and the [tui-flex-row-with-tall-text]
// gotcha for the four prior regressions of this exact antipattern.
//
// Click-to-expand: bodies longer than MAILBOX_BODY_LINE_CAP collapse to
// the first N lines + an ellipsis + a "Click to expand" affordance.
// Multi-KB tool output forwarded between siblings would otherwise
// dominate the message stream visually. Mirrors the Shell renderer's
// truncation pattern (index.tsx ≈ line 2293). The line split is
// memoized off the body string so it only re-runs when the body
// actually changes — important on mosh-over-iPad where every cell diff
// costs latency.

export interface MailboxMessageTheme {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly border: RGBA
  // Status emphasis colors. Optional so existing tests that don't pass a
  // full theme still work — the chrome falls back to textMuted when an
  // emphasis color is absent.
  readonly success?: RGBA
  readonly error?: RGBA
}

// Type guard: returns true when a part is a synthetic mailbox-injected
// text part (Wave 9 shape). Used by the UserMessage renderer to pluck
// these out and route them to MailboxMessage instead of the body text.
export function isMailboxPart(part: { type?: string; synthetic?: boolean; metadata?: { from?: unknown } }): boolean {
  if (part.type !== "text") return false
  if (part.synthetic !== true) return false
  if (typeof part.metadata?.from !== "string") return false
  return true
}

// Strip the leading "[from <author>]: " prefix from a mailbox body. We
// match a generic "[from <anything>]: " rather than only the exact author
// so the boilerplate is removed even when fields drift between sender
// and metadata.
const PREFIX_RE = /^\[from [^\]]+\]:\s?/
export function stripMailboxPrefix(text: string, _author: string): string {
  return text.replace(PREFIX_RE, "")
}

// Strip the orchestration status header that the AgentControl spawn-watcher
// prepends on a child's final status transition. The header is a fixed
// shape from control.ts:701-702:
//   "Agent <path> reached status: <label>\n\n<body>"
// or just the header alone when the child produced no assistant output:
//   "Agent <path> reached status: <label>"
// Returns { status, body } where status is undefined when no header was
// present. The label set is bounded by AgentStatus's terminal labels
// (completed / errored / interrupted / shutdown), but we accept any
// trailing word to stay robust if the orchestrator adds more.
const STATUS_HEADER_RE = /^Agent\s+\S+\s+reached status:\s+(\w+)(?:\n\n?|$)/
export function extractStatusHeader(text: string): { status: string | undefined; body: string } {
  const match = text.match(STATUS_HEADER_RE)
  if (!match) return { status: undefined, body: text }
  return { status: match[1], body: text.slice(match[0].length) }
}

// Pure: format the AgentPath for display. Strips the leading slash so the
// path reads as a hierarchy (root/explorers/worker_1) rather than absolute,
// then sanitizes via inlineSafe so a pathological author can never blow
// the chrome row's layout budget.
export function formatMailboxAuthor(author: string | undefined): string {
  if (!author) return "sibling"
  const trimmed = author.startsWith("/") ? author.slice(1) : author
  return inlineSafe(trimmed, 120)
}

// Pure: pick the chrome color for a status label. Falls back to muted
// when the theme doesn't supply emphasis colors (older tests, themes that
// haven't been updated). Kept as a pure helper so tests can verify the
// mapping without mounting the component.
export function statusChromeColor(theme: MailboxMessageTheme, status: string | undefined): RGBA | undefined {
  if (!status) return undefined
  if (status === "completed") return theme.success ?? theme.textMuted
  if (status === "errored" || status === "interrupted" || status === "shutdown") return theme.error ?? theme.textMuted
  return theme.textMuted
}

// Cap on the number of body lines shown before the click-to-expand
// truncation kicks in. Picked to fit a paragraph-length reply without
// scrolling, while still folding multi-KB tool-output forwards. Same
// shape as Shell's MAX_OUTPUT_LINES (10), tightened for mailbox bodies
// because they're rendered as plain text (not inside a bordered code
// block, so they read taller per line on the page).
export const MAILBOX_BODY_LINE_CAP = 8

// Pure: split a body into lines and return either the full body (when
// under the cap) or a truncated version with an ellipsis. Kept pure so
// tests can verify the truncation without mounting.
export function truncateBody(body: string, expanded: boolean, cap: number = MAILBOX_BODY_LINE_CAP): {
  readonly display: string
  readonly overflow: boolean
} {
  // Fast path: avoid allocating the lines array when the body is clearly
  // short. Counting newline chars is O(N) but allocates nothing.
  let newlines = 0
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) === 10) newlines++
    if (newlines > cap) break
  }
  if (newlines < cap) return { display: body, overflow: false }
  if (expanded) return { display: body, overflow: true }
  // Slow path only when we genuinely need to truncate.
  const lines = body.split("\n")
  return { display: [...lines.slice(0, cap), "…"].join("\n"), overflow: true }
}

export interface MailboxMessageProps {
  readonly part: TextPart
  readonly theme: MailboxMessageTheme
  readonly agentColor: RGBA
  // True when the message woke the recipient (followup_task). Rendered with
  // a subtle wake-mark so the user can spot trigger-turn vs queue-only at
  // a glance. The actual chrome difference is small intentionally — the
  // signal is "did this advance the recipient's turn", not a high-priority
  // alert.
  readonly triggerTurn?: boolean
  // Optional override for the expand state. Tests inject a controlled
  // value; production owns the signal locally.
  readonly expanded?: boolean
  readonly onToggleExpand?: () => void
}

export function MailboxMessage(props: MailboxMessageProps): JSX.Element {
  const author = (props.part.metadata?.["from"] as string | undefined) ?? undefined

  // Single-pass body normalization. ANSI strip + prefix strip happen on
  // the raw text; status header strip happens after so the regex sees
  // clean text. Memoized off the part text so the heavy work only runs
  // when the underlying message body actually changes — this matters for
  // streaming sessions where the user message containing this mailbox
  // part may re-render multiple times before settling.
  const normalized = createMemo(() => {
    const stripped = stripAnsi(stripMailboxPrefix(props.part.text, author ?? ""))
    return extractStatusHeader(stripped)
  })

  // Local expand state with optional prop override. Tests can pass
  // `expanded` + `onToggleExpand` to drive the truncation UX without
  // simulating a click event.
  const [localExpanded, setLocalExpanded] = createSignal(false)
  const expanded = createMemo(() => props.expanded ?? localExpanded())
  const toggle = () => (props.onToggleExpand ? props.onToggleExpand() : setLocalExpanded((v) => !v))

  // Truncation result. Memoized off (body, expanded) so a re-render that
  // doesn't change either is a free reference comparison downstream.
  const truncated = createMemo(() => truncateBody(normalized().body, expanded()))

  const statusFg = createMemo(() => statusChromeColor(props.theme, normalized().status))

  // Render nothing when the body is empty AFTER stripping (e.g. a child
  // that finished with no assistant output — control.ts:702 sends just
  // the header in that case). The chrome alone with no body is a row
  // with status info but no payload, which we still want to show so the
  // user knows the agent reached terminal state.
  const hasBody = createMemo(() => truncated().display.length > 0)

  return (
    <box
      marginTop={1}
      flexShrink={0}
      flexDirection="column"
      onMouseUp={truncated().overflow ? toggle : undefined}
    >
      <text fg={props.theme.textMuted}>
        <span style={{ fg: props.theme.textMuted }}>← from </span>
        <span style={{ fg: props.agentColor, bold: true }}>{formatMailboxAuthor(author)}</span>
        <Show when={normalized().status}>
          <span style={{ fg: props.theme.textMuted }}> · </span>
          <span style={{ fg: statusFg() ?? props.theme.textMuted }}>{normalized().status}</span>
        </Show>
        <Show when={props.triggerTurn}>
          <span style={{ fg: props.theme.textMuted }}> · ↯ wake</span>
        </Show>
      </text>
      <Show when={hasBody()}>
        <text fg={props.theme.text}>{truncated().display}</text>
      </Show>
      <Show when={truncated().overflow}>
        <text fg={props.theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
      </Show>
    </box>
  )
}
