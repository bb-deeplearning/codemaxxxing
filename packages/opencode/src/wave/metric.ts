import { Schema } from "effect"
import { AgentPath } from "@/agent/agent-path"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { NonNegativeInt } from "@/util/schema"

// Wave 9 (actor-discipline-2026-05-20) — observability metrics for the
// multi-agent surface. Each metric is a bus event emitted at the moment
// the relevant transition happens; downstream consumers (TUI dashboard,
// future Wave 10's dashboard, plugins, log scrapers) aggregate over
// rolling windows to derive the four "rates" the campaign exists to
// improve:
//
//   - deliverable_arrival_rate — fraction of subagent completions whose
//     deliverable reached the spawner via explicit send_message vs
//     auto-extraction vs safety-net warning. Pre-D1/D5 baseline was
//     diagnostic — one of two sampled sessions delivered explicitly;
//     post-D5 should hit ~1.0 (every completion delivers something the
//     spawner can use).
//   - safety_net_firing_rate — count of safety-net warnings per
//     completion. A hot rate means prompts aren't teaching the delivery
//     contract correctly.
//   - sibling_deadlock_rate — count of wait_agent / wait_for_reply calls
//     that exited via timeout (vs woke on mailbox event). High rate
//     means siblings are blocked on messages that never arrive — the
//     ses_1d84f236bffe Demo 2 sibling-deadlock shape.
//   - subagent_tool_error_rate — count of multi-agent tool calls that
//     returned a tool-recoverable error (mailbox_full, target_not_found,
//     send_failed, etc.). High rate is "context rot" canary per
//     Cursor's harness post — the subagent's tool environment is
//     degrading and the supervisor should pivot or close-and-respawn.
//
// Emission is fire-and-forget at every call site (`.pipe(Effect.ignore)`).
// PubSub failures during instance disposal MUST NOT crash callers — the
// completion-watcher fork can race the disposal finalizer; absorbing the
// failure keeps the lifecycle clean.
//
// The events live under the `agent.metric.*` bus prefix — distinct from
// `agent.*` lifecycle events (spawn/wait/closed/message.sent) so consumers
// can subscribe narrowly without filtering. Per GOTCHA
// `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`, no EventV2
// counterpart is registered: these are in-process observability signals
// only, not persisted to the sourced log. Wave 10's dashboard (if shipped)
// reads them; failure to attach a consumer is silent and safe — events
// simply have no subscribers.

/**
 * How the deliverable reached the spawner. Three buckets matched to D5's
 * completion-watcher behavior:
 *  - `explicit_send` — child called send_message / followup_task with the
 *    spawner as recipient at least once before terminating. Happy path.
 *  - `extracted` — child did not deliver explicitly; auto-extraction
 *    walked the child's assistant messages and returned a substantive
 *    body that the spawner consumed via the completion notification.
 *  - `safety_net` — child neither delivered explicitly nor produced a
 *    substantive body; the completion notification was prepended with
 *    the D5 ⚠️ warning so the spawner sees the gap loudly.
 */
export const DeliverableSource = Schema.Literals(["explicit_send", "extracted", "safety_net"])
export type DeliverableSource = Schema.Schema.Type<typeof DeliverableSource>

export const Event = {
  /**
   * Emitted once per subagent completion-watcher notification. `source`
   * names HOW the deliverable arrived; aggregators derive both
   * `deliverable_arrival_rate` and `safety_net_firing_rate` from the same
   * stream so consumers that care about either metric only subscribe to
   * this one event. `body_length` records the extracted body byte count
   * — useful for "are subagents over- or under-delivering" diagnostics
   * downstream.
   */
  DeliverableArrived: BusEvent.define(
    "agent.metric.deliverable_arrived",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      child_path: AgentPath,
      child_session_id: SessionID,
      source: DeliverableSource,
      body_length: NonNegativeInt,
    }),
  ),

  /**
   * Emitted whenever the D5 safety-net warning is prepended to a parent
   * notification. A strict subset of
   * `DeliverableArrived(source=safety_net)`, exposed as a separate event
   * so consumers that only care about the alarm canary can subscribe
   * narrowly without filtering. The two events fire in tandem; consumers
   * pick whichever shape matches their aggregation strategy.
   */
  SafetyNetFired: BusEvent.define(
    "agent.metric.safety_net_fired",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      child_path: AgentPath,
      child_session_id: SessionID,
    }),
  ),

  /**
   * Emitted when `wait_agent` / `wait_for_reply` exits via timeout (no
   * mailbox event arrived within the clamp). Carries the `tool_id`
   * ("wait_agent" or "wait_for_reply") so the rate can be split by
   * call shape — `wait_for_reply` timing out is more diagnostic of
   * unicast contract violation than vanilla `wait_agent`. High rate
   * means siblings are waiting on broadcasts they never receive —
   * exactly the ses_1d84f236bffe Demo 2 sibling-deadlock shape.
   */
  SiblingDeadlock: BusEvent.define(
    "agent.metric.sibling_deadlock",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      timeout_ms: NonNegativeInt,
      tool_id: Schema.String,
    }),
  ),

  /**
   * Emitted when a multi-agent tool call returns a tool-recoverable
   * error. `tool_id` names the tool (send_message / followup_task /
   * wait_agent / etc.); `error_kind` tags the failure ("mailbox_full",
   * "target_not_found", "send_failed", "invalid_timeout", etc.). High
   * rate is "context rot" canary per Cursor's harness post — the
   * subagent's tool environment is degrading and the supervisor should
   * pivot or close-and-respawn.
   */
  SubagentToolError: BusEvent.define(
    "agent.metric.subagent_tool_error",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      tool_id: Schema.String,
      error_kind: Schema.String,
    }),
  ),
}

// ============================================================================
// Rate helpers
// ============================================================================
//
// Pure functions for aggregating observation arrays into the four rates the
// campaign tracks. Each rate is a fraction in [0, 1]; empty input returns 0
// so consumers don't have to guard divide-by-zero at every call site.
//
// The observation shapes are intentionally minimal — consumers can adapt
// their internal stores (e.g. a rolling-window deque or a per-session map)
// without implementing every event field. The helpers compose cleanly with
// `Array.prototype.filter` / `slice` to scope by time window or session.

/**
 * Fraction of subagent completions whose deliverable reached the spawner
 * via explicit `send_message` OR auto-extraction (i.e. NOT via the safety
 * net). A rate of 1.0 means every subagent delivered something the
 * spawner could use; closer to 0 means subagents are silently failing to
 * deliver. Healthy post-D5 baseline in tests is ~1.0; production target
 * is similar.
 */
export const deliverableArrivalRate = (
  events: ReadonlyArray<{ source: DeliverableSource }>,
): number => {
  if (events.length === 0) return 0
  const ok = events.filter((e) => e.source !== "safety_net").length
  return ok / events.length
}

/**
 * Fraction of subagent completions where the D5 safety-net warning fired.
 * A rate of 0 means every subagent delivered something substantive;
 * elevated rate (e.g. >0.1 over a rolling window of 20+ completions) is
 * the canary that prompts aren't teaching the delivery contract
 * correctly. Inverse-shaped twin of `deliverableArrivalRate`; consumers
 * pick whichever framing fits their dashboard.
 */
export const safetyNetFiringRate = (
  events: ReadonlyArray<{ source: DeliverableSource }>,
): number => {
  if (events.length === 0) return 0
  const fired = events.filter((e) => e.source === "safety_net").length
  return fired / events.length
}

/**
 * Fraction of `wait_agent` / `wait_for_reply` calls that exited via
 * timeout. `{ timed_out: boolean }` per observation. A rate close to 1
 * means siblings are blocked waiting on messages that never arrive —
 * the ses_1d84f236bffe Demo 2 shape. Pre-D7/D8 prose: high; post-prose:
 * low. Useful split by `tool_id` (wait_agent vs wait_for_reply) at the
 * call site.
 */
export const siblingDeadlockRate = (
  waits: ReadonlyArray<{ timed_out: boolean }>,
): number => {
  if (waits.length === 0) return 0
  return waits.filter((w) => w.timed_out).length / waits.length
}

/**
 * Fraction of subagent tool calls that returned a tool-recoverable
 * error. `{ ok: boolean }` per observation — `ok=false` flags an error
 * result (mailbox_full, target_not_found, schema-decode failure, etc.).
 * High rate is "context rot" per Cursor's harness post — the subagent's
 * tool environment is degrading and the supervisor should pivot or
 * close-and-respawn rather than keep feeding the same context window.
 */
export const subagentToolErrorRate = (
  toolCalls: ReadonlyArray<{ ok: boolean }>,
): number => {
  if (toolCalls.length === 0) return 0
  return toolCalls.filter((t) => !t.ok).length / toolCalls.length
}

export * as Metric from "./metric"
