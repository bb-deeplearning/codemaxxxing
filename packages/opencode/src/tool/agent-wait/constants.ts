// Mailbox-wait timeout constants for the wait_agent tool. Codex parity:
// codex-rs/core/src/tools/handlers/multi_agents_common.rs:30-33 +
// the Config defaults for multi_agent_v2 (DEFAULT_MULTI_AGENT_V2_MIN_WAIT_TIMEOUT_MS
// and MAX_MULTI_AGENT_V2_WAIT_TIMEOUT_MS).
//
// These live in their own module per MESSAGE_SHAPES.md § "Constants split" so
// schema tests can import the bare numbers without dragging in the whole
// AgentControl service graph.

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000
export const MIN_WAIT_TIMEOUT_MS = 1_000
export const MAX_WAIT_TIMEOUT_MS = 600_000

// Mirrors codex's `ms.clamp(min_timeout_ms, MAX_WAIT_TIMEOUT_MS)` after the
// `<= 0` rejection branch (wait.rs:57-64). Caller validates the >0 guard
// separately so the model gets a typed error rather than a silent floor.
export function clampWaitTimeout(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS)
}

export * as AgentWaitConstants from "./constants"
