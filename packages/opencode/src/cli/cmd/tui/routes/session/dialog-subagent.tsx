import type { DialogSelectOption } from "@tui/ui/dialog-select"
import type { Route } from "@tui/context/route"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2"
import type { RGBA } from "@opentui/core"
import type { DialogContext } from "@tui/ui/dialog"
import { deriveSubagentStatus, type SubagentStatus } from "./subagent-status"

// Wave 11: subagent action dialog — option-builder helper.
//
// The production wrapper that wires this helper to the dialog/route/sdk
// providers lives in `dialog-subagent-mount.tsx`. Splitting keeps this
// file pure (helpers + types) so unit tests reach 100% line coverage
// without mounting the dialog under all of its provider dependencies.

export interface DialogSubagentTheme {
  readonly text: RGBA
  readonly textMuted: RGBA
}

export interface DialogSubagentDeps {
  readonly sessionID: string
  readonly status: SessionStatus | undefined
  readonly messages: readonly Message[]
  readonly navigate: (route: Route) => void
  readonly abort: (sessionID: string) => Promise<void>
}

// Pure: build the dialog's option list from the resolved deps. The two
// actions are "open" (always available) and "close" (disabled once the
// agent reaches a final state — completed or errored). The close action's
// description carries the live status so the user can see what they're
// acting on without leaving the dialog.
//
// Codex parity note: the close action mirrors the model-facing
// `close_agent` tool (Wave 8) — same intent (terminate the sibling), but
// invoked from the TUI by the human operator instead of by another model.
// We route through `sdk.client.session.abort` (the existing primitive) in
// the production wrapper rather than calling close_agent directly,
// because abort is already plumbed through the runtime cancellation
// pathway that AgentControl observes — a separate close_agent endpoint
// would duplicate that wiring without behavioral change.
//
// We use the literal "session.abort" string in the description so that
// `[from <author>]: ...` and other surface labels stay consistent with
// the keybind name registered by index.tsx.
export function buildDialogSubagentOptions(deps: DialogSubagentDeps): DialogSelectOption<string>[] {
  const status: SubagentStatus = deriveSubagentStatus(deps.status, deps.messages)
  const isFinal = status === "completed" || status === "errored"
  return [
    {
      title: "open",
      value: "subagent.view",
      description: "the subagent's session",
      onSelect: (dialog: DialogContext) => {
        deps.navigate({ type: "session", sessionID: deps.sessionID })
        dialog.clear()
      },
    },
    {
      title: "close",
      value: "subagent.close",
      description: `the subagent (currently ${status})`,
      disabled: isFinal,
      onSelect: async (dialog: DialogContext) => {
        // Swallow abort failures — the user clicked close, they want the
        // dialog gone. The session-status pipeline will surface any
        // server-side failure separately. Same swallow pattern as
        // `messages_undo`'s session.abort call (see index.tsx ≈ line 784).
        await deps.abort(deps.sessionID).catch(() => {})
        dialog.clear()
      },
    },
  ]
}
