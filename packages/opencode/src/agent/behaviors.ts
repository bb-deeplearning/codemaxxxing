import * as Schema from "effect/Schema"

// Canonical ABORT reasons — the set-phrase ladder D11 parses from a
// subagent's last assistant line. Tuple is `as const` so the type
// narrows to the literal union when downstream code projects it.
export const ABORT_REASONS = [
  "spec_wrong",
  "transient_tool_error",
  "out_of_scope",
  "context_full",
  "approach_failed",
  "user_question",
] as const

// D16 (actor-discipline-2026-05-20 Wave 8) — declared per-agent_type
// behavior contracts. Every native subagent_type (general / explore) ships
// with a default `BehaviorContract` that names:
//
//   - delivery: what shape the supervisor expects the deliverable in
//     (typically `send_message_required` — without an explicit
//     send_message to the spawner the child's work is invisible).
//   - termination: who is responsible for closing the child
//     (typically `self_close`; `either` and `spawner_close` are forward
//     compat slots, schema-only this wave per CONTRACT.json T1).
//   - declared_failure_modes: the canonical ABORT reasons appropriate for
//     the agent_type. `general` accepts all six; `explore` accepts five
//     (no `approach_failed` — explore does not iterate on a rubric per
//     WAVE.md item 2).
//   - expected_outputs: optional shape (free_text | json_schema). Wave 8
//     ships schema-only; runtime enforcement of the shape lives in a
//     later wave.
//   - exempt: escape hatch for stub run-loops used by existing tests
//     (WAVE.md gotcha 2) — when true, `computeViolations` returns [].

/**
 * Wire-format version label. `subagent_v1` is today's contract;
 * `subagent_v2` is the forward-compat slot that lets us bump expected
 * outputs / termination semantics WITHOUT breaking v1 children
 * (INV-D-25). Adding `subagent_v3` later is additive — the runtime
 * validation key is `contract.version`.
 */
export const BehaviorVersion = Schema.Literals(["subagent_v1", "subagent_v2"])

/**
 * What the supervisor expects the deliverable shape to be.
 *
 *   - `send_message_required` — child MUST call `send_message` (or
 *     `followup_task`) to its spawner before close_agent. Missing
 *     delivery surfaces a `missing_delivery` ViolationKind.
 *   - `send_message_optional` — explicit send is preferred but not
 *     mandatory. Missing delivery does NOT raise a violation; the D5
 *     safety net's prose warning still fires when the body looks
 *     terse.
 *   - `no_delivery` — fire-and-forget pattern. Validation never
 *     raises `missing_delivery`.
 */
export const DeliveryRequirement = Schema.Literals(["send_message_required", "send_message_optional", "no_delivery"])

/**
 * Who is responsible for closing the child agent. Schema-only this
 * wave; runtime enforcement of termination mode is deferred per
 * CONTRACT.json T1 rubric_seed.anti_patterns_to_flag.
 */
export const TerminationRequirement = Schema.Literals(["self_close", "spawner_close", "either"])

/**
 * Discrete machine-readable violation labels surfaced on the parent's
 * notification via the `behavior_violation` field. Wave 8 raises
 * `missing_delivery` and `undeclared_failure_mode`;
 * `invalid_termination` and `output_shape_mismatch` are schema-only
 * slots (runtime enforcement deferred).
 */
export const ViolationKind = Schema.Literals([
  "missing_delivery",
  "undeclared_failure_mode",
  "invalid_termination",
  "output_shape_mismatch",
])

/**
 * The full per-agent_type contract record. Stored on
 * `PerRootData.behaviorOf` keyed by the child's session id at spawn
 * time (T3); read at terminal-status time by the completion-watcher.
 */
export class BehaviorContract extends Schema.Class<BehaviorContract>("BehaviorContract")({
  version: BehaviorVersion,
  delivery: DeliveryRequirement,
  termination: TerminationRequirement,
  declared_failure_modes: Schema.Array(Schema.String),
  expected_outputs: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["json_schema", "free_text"]),
      schema: Schema.optional(Schema.Unknown),
    }),
  ),
  exempt: Schema.optional(Schema.Boolean),
}) {}

/**
 * One row of the `behavior_violation.violations` list on the parent's
 * notification. `kind` is the machine label; `detail` is the
 * human-readable expansion the supervisor model reads.
 */
export class BehaviorViolation extends Schema.Class<BehaviorViolation>("BehaviorViolation")({
  kind: ViolationKind,
  detail: Schema.String,
}) {}

/**
 * `general` subagent contract, v1 — the default for all
 * non-orchestrated general agents. Send_message required, self-close,
 * all six ABORT reasons declared (general iterates on a rubric so
 * `approach_failed` is allowed).
 */
export const generalSubagentV1 = new BehaviorContract({
  version: "subagent_v1",
  delivery: "send_message_required",
  termination: "self_close",
  declared_failure_modes: [...ABORT_REASONS],
})

/**
 * `general` subagent contract, v2 — forward-compat. Loosens
 * termination to `either` (the spawner may close the child instead of
 * the child closing itself) and declares an optional free-text output
 * shape so future runtime enforcement has a hook. Coexists with v1
 * per INV-D-25.
 */
export const generalSubagentV2 = new BehaviorContract({
  version: "subagent_v2",
  delivery: "send_message_required",
  termination: "either",
  declared_failure_modes: [...ABORT_REASONS],
  expected_outputs: { kind: "free_text" },
})

/**
 * `explore` subagent contract, v1 — five declared failure modes (no
 * `approach_failed` per WAVE.md item 2; explore does not iterate on a
 * rubric, so an explore that emits `ABORT(approach_failed)` is OUT of
 * its declared set and surfaces an `undeclared_failure_mode`
 * violation).
 */
export const exploreSubagentV1 = new BehaviorContract({
  version: "subagent_v1",
  delivery: "send_message_required",
  termination: "self_close",
  declared_failure_modes: [
    "spec_wrong",
    "transient_tool_error",
    "out_of_scope",
    "context_full",
    "user_question",
  ],
})

/**
 * Per-agent_type contract registry. `default_version` is the version
 * used when the spawn call does not pass an explicit `behavior_version`
 * override. `versions` carries every supported version simultaneously
 * (INV-D-25 — v1 and v2 coexist).
 */
export const DEFAULT_CONTRACTS: Record<
  string,
  { default_version: typeof BehaviorVersion.Type; versions: Record<string, BehaviorContract> }
> = {
  general: {
    default_version: "subagent_v1",
    versions: {
      subagent_v1: generalSubagentV1,
      subagent_v2: generalSubagentV2,
    },
  },
  explore: {
    default_version: "subagent_v1",
    versions: {
      subagent_v1: exploreSubagentV1,
    },
  },
}

/**
 * Lookup the contract for an agent_type + optional version. Returns
 * `undefined` for:
 *
 *   - `agent_type === undefined` (the spawn never declared a type),
 *   - an `agent_type` not in `DEFAULT_CONTRACTS` (unregistered — no
 *     contract, no validation; this is the correct behavior per
 *     WAVE.md gotcha 1),
 *   - an explicit `version` that the registry does not carry for the
 *     agent_type.
 *
 * The undefined return is the caller's signal to skip
 * `computeViolations` entirely.
 */
export const resolveContract = (agent_type?: string, version?: string): BehaviorContract | undefined => {
  if (agent_type === undefined) return undefined
  const entry = DEFAULT_CONTRACTS[agent_type]
  if (entry === undefined) return undefined
  const key = version ?? entry.default_version
  return entry.versions[key]
}

/**
 * Pure validator. Runs at terminal-status time (T3) against the
 * observed deliverable + (optional) parsed ABORT reason.
 *
 *   - `contract === undefined` → no contract, no violations.
 *   - `contract.exempt === true` → escape hatch, empty array (used by
 *     stub run-loops in existing tests per WAVE.md gotcha 2).
 *   - `delivery === "send_message_required"` AND `!observed.delivered`
 *     → `missing_delivery` violation.
 *   - `observed.abortReason.reason` NOT in `declared_failure_modes`
 *     → `undeclared_failure_mode` violation.
 *
 * The two checks are independent — both can fire on the same case.
 * Runtime enforcement of `termination` and `expected_outputs` is
 * deferred (CONTRACT.json T1 rubric_seed.anti_patterns_to_flag).
 */
export const computeViolations = (
  contract: BehaviorContract | undefined,
  observed: { delivered: boolean; abortReason?: { reason: string; details: string } },
): BehaviorViolation[] => {
  if (contract === undefined) return []
  if (contract.exempt === true) return []
  const out: BehaviorViolation[] = []
  if (contract.delivery === "send_message_required" && observed.delivered === false) {
    out.push(
      new BehaviorViolation({
        kind: "missing_delivery",
        detail: "Child did not call send_message/followup_task to its spawner before terminating.",
      }),
    )
  }
  if (observed.abortReason !== undefined) {
    const reason = observed.abortReason.reason
    if (!contract.declared_failure_modes.includes(reason)) {
      out.push(
        new BehaviorViolation({
          kind: "undeclared_failure_mode",
          detail: `ABORT reason '${reason}' is not in the agent_type's declared_failure_modes.`,
        }),
      )
    }
  }
  return out
}

export * as Behaviors from "./behaviors"
