import type { JSX } from "solid-js"
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
// Layout note: this component MUST NOT wrap a body whose content can grow
// tall in `flexDirection="row"`. Sibling messages can carry forwarded tool
// output (multi-KB realistic). The chrome line is short and inline-safe;
// the body stacks vertically as a sibling text node so opentui's flex
// pass never measures a tall flex-row child. See
// `specs/tui-render-freeze.md` and the [tui-flex-row-with-tall-text]
// gotcha for the four prior regressions of this exact antipattern.

export interface MailboxMessageTheme {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly border: RGBA
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

// Pure: format the AgentPath for display. Strips the leading slash so the
// path reads as a hierarchy (root/explorers/worker_1) rather than absolute,
// then sanitizes via inlineSafe so a pathological author can never blow
// the chrome row's layout budget.
export function formatMailboxAuthor(author: string | undefined): string {
  if (!author) return "sibling"
  const trimmed = author.startsWith("/") ? author.slice(1) : author
  return inlineSafe(trimmed, 120)
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
}

export function MailboxMessage(props: MailboxMessageProps): JSX.Element {
  const author = (props.part.metadata?.["from"] as string | undefined) ?? undefined
  const body = stripAnsi(stripMailboxPrefix(props.part.text, author ?? ""))
  return (
    <box marginTop={1} flexShrink={0} flexDirection="column">
      <text fg={props.theme.textMuted}>
        <span style={{ fg: props.theme.textMuted }}>← from </span>
        <span style={{ fg: props.agentColor, bold: true }}>{formatMailboxAuthor(author)}</span>
        <Show when={props.triggerTurn}>
          <span style={{ fg: props.theme.textMuted }}> · ↯ wake</span>
        </Show>
      </text>
      <text fg={props.theme.text}>{body}</text>
    </box>
  )
}
