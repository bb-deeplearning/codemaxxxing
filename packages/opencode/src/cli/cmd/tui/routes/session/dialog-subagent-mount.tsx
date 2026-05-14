import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"
import type { Message } from "@opencode-ai/sdk/v2"
import { buildDialogSubagentOptions, type DialogSubagentDeps } from "./dialog-subagent"

// Wave 11 production wrapper. Wires the heavy context hooks → the pure
// `buildDialogSubagentOptions` helper. Lives in a separate file from the
// helper so the helper can be unit-tested without mounting the dialog
// under all of its provider dependencies.
//
// Currently no caller wires this dialog into a click handler — the
// drafting-table redesign moved the Task tool to InlineTool with a
// direct navigate. The dialog stands ready for a future
// re-wiring (e.g. a `subagent_actions` keybind or a multi-action
// sidebar entry) without forcing a TUI redesign in this wave.

const EMPTY_MESSAGES: readonly Message[] = Object.freeze([]) as readonly Message[]

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()
  const sdk = useSDK()
  const sync = useSync()

  const deps = createMemo<DialogSubagentDeps>(() => ({
    sessionID: props.sessionID,
    status: sync.data.session_status?.[props.sessionID],
    messages: sync.data.message[props.sessionID] ?? EMPTY_MESSAGES,
    navigate: (r) => route.navigate(r),
    abort: async (id) => {
      await sdk.client.session.abort({ sessionID: id })
    },
  }))

  return <DialogSelect title="subagent actions" options={buildDialogSubagentOptions(deps())} />
}
