import { Schema } from "effect"

// AgentStatus is the live state of a spawned agent as observed by AgentControl.
// Ported from codex's `protocol::AgentStatus` (codex-rs/protocol/src/protocol.rs)
// and `agent::status::agent_status_from_event` (codex-rs/core/src/agent/status.rs).
//
// Codex carries this enum end-to-end between the agent runtime and the UI; we
// keep the same set of variants (plus the same finality classification) so the
// model-facing tools (Wave 8 wait_agent / list_agents) match codex's wording.
//
// Wave 7 ships the schema, the finality predicate, and an event→status mapper
// that consumes a small `StatusEvent` discriminated union the AgentControl
// service owns. Wave 10 will adapt SessionEvent / EventV2 emissions into
// `StatusEvent` instances, plug the mapper into a Bus subscriber, and update
// the per-agent SubscriptionRef.

const _AgentStatus = Schema.Union([
  Schema.Literal("pending_init"),
  Schema.Literal("running"),
  Schema.Literal("interrupted"),
  Schema.Literal("shutdown"),
  Schema.Literal("not_found"),
  Schema.Struct({ completed: Schema.NullOr(Schema.String) }),
  Schema.Struct({ errored: Schema.String }),
])

export type AgentStatus = Schema.Schema.Type<typeof _AgentStatus>

// StatusEvent is the AgentControl-internal event shape the run-loop subscriber
// will produce. Modeled after codex `EventMsg` cases that drive status
// transitions in `agent_status_from_event`. Wave 10 builds the adapter from
// EventV2 / SessionEvent to this shape; Wave 7 ships the schema-free union so
// the mapping function can be unit-tested today without owning the event bus.
export type StatusEvent =
  | { readonly type: "turn_started" }
  | { readonly type: "turn_complete"; readonly last_agent_message?: string }
  | {
      readonly type: "turn_aborted"
      readonly reason: "interrupted" | "budget_limited" | "errored"
      readonly message?: string
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "shutdown_complete" }

// Mirrors codex `agent::status::is_final` (status.rs:23-28). The non-final set
// is `{ PendingInit, Running, Interrupted }`; everything else is final.
// Interrupted is non-final because a parent can resume an interrupted child
// with `send_inter_agent_communication { trigger_turn: true }`.
const isFinal = (status: AgentStatus): boolean => {
  if (status === "pending_init" || status === "running" || status === "interrupted") return false
  return true
}

// Pure mapper from a status-relevant event to the next AgentStatus, or null
// when the event does not affect status. Mirrors codex's
// `agent_status_from_event` (status.rs:6-21).
const fromSessionEvent = (event: StatusEvent): AgentStatus | null => {
  switch (event.type) {
    case "turn_started":
      return "running"
    case "turn_complete":
      return { completed: event.last_agent_message ?? null }
    case "turn_aborted":
      // Codex maps Interrupted | BudgetLimited → Interrupted, everything else
      // → Errored(format!("{:?}", reason)). We carry the optional message so
      // Wave 10's subscriber can pass through richer error context.
      if (event.reason === "interrupted" || event.reason === "budget_limited") return "interrupted"
      return { errored: event.message ?? event.reason }
    case "error":
      return { errored: event.message }
    case "shutdown_complete":
      return "shutdown"
    default:
      return null
  }
}

export const AgentStatus = Object.assign(_AgentStatus, {
  isFinal,
  fromSessionEvent,
})
