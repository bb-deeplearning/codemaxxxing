import type { AssistantMessage, Message, SessionStatus } from "@opencode-ai/sdk/v2"

// Wave 11: derive a four-state user-facing status for a subagent session
// from the existing sync data. We deliberately do NOT thread AgentControl's
// richer per-agent status (running / interrupted / shutdown / not_found /
// completed / errored / pending_init) through the sync pipeline — codex's
// AgentStatus is rich because the model-facing tools (list_agents,
// wait_agent) need it; the TUI footer needs only "is this sibling busy or
// done, and did it succeed". Reusing the existing session_status (busy /
// retry / idle) plus the latest assistant's `finish` and `error` fields
// keeps this wave additive: no new server endpoint, no new event, no sync
// schema change.
//
// Mapping:
//   busy | retry          -> "running"
//   idle + last asst err  -> "errored"   (any error, including aborts)
//   idle + last asst done -> "completed" (finish set, no error)
//   idle + anything else  -> "waiting"   (no completion landed yet)
export type SubagentStatus = "running" | "waiting" | "completed" | "errored"

export function deriveSubagentStatus(
  status: SessionStatus | undefined,
  messages: readonly Message[],
): SubagentStatus {
  const type = status?.type ?? "idle"
  if (type === "busy" || type === "retry") return "running"
  // Walk backward — the latest assistant determines the outcome label. A
  // mid-stream pause where session_status flipped idle but the assistant
  // hasn't landed `finish` yet reports "waiting" so the user doesn't see a
  // false "completed" between turns.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const asst = msg as AssistantMessage
    if (asst.error) return "errored"
    if (asst.finish) return "completed"
    return "waiting"
  }
  return "waiting"
}

export function formatSubagentStatus(status: SubagentStatus): string {
  return status
}
