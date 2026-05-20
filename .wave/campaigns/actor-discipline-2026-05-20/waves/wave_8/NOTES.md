# Wave 8 — Notes

## Attempt 1 — success (WAVE COMPLETE)

**Session:** ses_1ba7ba7abffe9x81BFYn2ATwNQ
**Settle commit:** 93b3f7867
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** pre-agreed contracts (PLAN.json + CONTRACT.json drafted by /root before subagent dispatch) + sequential T1 → parallel T2+T3+T4 → sequential T5 gen+eval pairs. 0 pivots.

## Pattern: pre-agreed-contract + 3-way parallelization (T2+T3+T4)

Wave 5/6/7 NOTES.md established the pre-agreed-contract pattern (orchestrator drafts CONTRACT.json criteria with deterministic verify recipes; gen+eval skip negotiation, run straight to build+grade). Wave 7 added the first cross-task parallelization (T2+T3). Wave 8 attempt 1 extended to 3-way parallelization: T2 (agent.ts), T3 (control.ts + control.test.ts), and T4 (multi-agent-subagent.txt + prose tests) all have disjoint writes AND only depend on T1. After T1 landed, 6 subagents (gen+eval × 3) ran concurrently. Net effect: wall-clock saving of ~2 full task cycles; 0 pivots across 10 subagent sessions for T1+T2+T3+T4+T5.

## Orchestration trace

| Subagent | Path | Role | Outcome | Commits | Pivots |
|---|---|---|---|---|---|
| einstein | `/root/t1_gen` | generator | WAVE TASK DONE (T1 behaviors.ts + InterAgentCommunication.behavior_violation) | 6a38dbd12 | 0 |
| euler | `/root/t1_eval` | evaluator | WAVE TASK GREEN 13/13 | 97a96d040 (contract) | 0 |
| darwin | `/root/t2_gen` | generator | WAVE TASK DONE (T2 agent.ts behaviors registration + behaviorContractFor) | 25f1e2bf8 | 0 |
| gauss | `/root/t2_eval` | evaluator | WAVE TASK GREEN 7/7 | d180fd34d (contract) | 0 |
| ramanujan | `/root/t3_gen` | generator | WAVE TASK DONE (T3 control.ts D16 runtime validation + 7 D16 unit tests) | 8465cfca7 | 0 |
| feynman | `/root/t3_eval` | evaluator | WAVE TASK GREEN 11/11 | 0f247f911 (contract) | 0 |
| plato | `/root/t4_gen` | generator | WAVE TASK DONE (T4 multi-agent-subagent.txt "Your behavior contract" + prose tests) | f1b9b98a9 | 0 |
| bohr | `/root/t4_eval` | evaluator | WAVE TASK GREEN 8/8 | 13926a1f2 (contract) | 0 |
| pasteur | `/root/t5_gen` | generator | WAVE TASK DONE (T5 INV-D-24..26 integration invariants) | 674027786 | 0 |
| lovelace | `/root/t5_eval` | evaluator | WAVE TASK GREEN 9/9 | 2d03caa45 (contract) | 0 |

## Verification results (orchestrator-run at settle)

| Surface | Result |
|---|---|
| `bun typecheck` | exit 0 (tsgo --noEmit clean) |
| `bun lint` (repo root, oxlint) | 0 errors / 3148 pre-existing warnings (+1 drift from Wave 7's 3147 — pre-existing, unrelated to Wave 8 surfaces) |
| `bun test src/agent/behaviors.test.ts src/agent/inter-agent-communication.test.ts src/agent/control.test.ts src/tool/agent-pool/agent-pool.test.ts src/tool/agent-spawn/agent-spawn.test.ts src/tool/agent-followup/agent-followup.test.ts src/tool/agent-send/agent-send.test.ts src/tool/agent-link/agent-link.test.ts src/tool/registry.test.ts` | 280 pass / 0 fail / 702 expects in 12.62s |
| `bun test --coverage src/agent/behaviors.test.ts` → behaviors.ts | 66.67% functions / 100.00% lines (function% gap = Schema.Class GOTCHA for BehaviorContract + BehaviorViolation) |
| `bun test --coverage src/agent/inter-agent-communication.test.ts` → inter-agent-communication.ts | 0.00% functions / 100.00% lines (function% gap = Schema.Class GOTCHA for InterAgentCommunication; file is a pure Schema.Class with no functions to count) |
| `bun test --coverage src/agent/control.test.ts` → control.ts | 93.20% functions / 100.00% lines (function% gap = pre-existing Schema.TaggedErrorClass GOTCHA baseline) |
| `bun test ./test/integration/multi-agent-invariants.test.ts` | 43 pass / 0 fail / 223 expects (was 40, +3 for INV-D-24/25/26) |
| `bun test ./test/prose/subagent-prompts.test.ts` | 54 pass / 0 fail / 55 expects (was 48, +6 for D16 prose assertions) |
| PLAN.json + CONTRACT.json artefacts | present at `waves/wave_8/` |
| CONTRACT.json totals | T1: 13/13 signed at 6a38dbd12; T2: 7/7 signed at 25f1e2bf8; T3: 11/11 signed at 8465cfca7; T4: 8/8 signed at f1b9b98a9; T5: 9/9 signed at 674027786 |

## What shipped (Wave 8 — Phase 3D: declared per-agent_type behavior contracts)

- **T1 — NEW behaviors.ts + InterAgentCommunication.behavior_violation (6a38dbd12):**
  - **D16 behaviors.ts schema:** `ABORT_REASONS` readonly tuple of 6 reasons exported. Schema unions: `BehaviorVersion` (subagent_v1 / subagent_v2), `DeliveryRequirement` (send_message_required / send_message_optional / no_delivery), `TerminationRequirement` (self_close / spawner_close / either), `ViolationKind` (missing_delivery / undeclared_failure_mode / invalid_termination / output_shape_mismatch). `class BehaviorContract extends Schema.Class<BehaviorContract>` with version + delivery + termination + declared_failure_modes + optional expected_outputs + optional exempt fields. `class BehaviorViolation extends Schema.Class<BehaviorViolation>` with kind + detail.
  - **D16 default contracts:** `generalSubagentV1` (delivery=required, termination=self_close, all 6 ABORT_REASONS as declared modes), `generalSubagentV2` (delivery=required, termination=either, all 6 + expected_outputs.kind=free_text), `exploreSubagentV1` (delivery=required, termination=self_close, 5 reasons EXCLUDING approach_failed per WAVE.md item 2).
  - **D16 registry + lookup:** `DEFAULT_CONTRACTS` keyed by "general" (default_version=subagent_v1, both versions) and "explore" (default_version=subagent_v1, v1 only). `resolveContract(agent_type?, version?)` returns undefined for undefined/unknown agent_type; otherwise looks up named version or default.
  - **D16 validator:** `computeViolations(contract, observed)` — exempt contract → []; delivery=required + !delivered → missing_delivery violation; abortReason.reason not in declared_failure_modes → undeclared_failure_mode violation. Pure function; no Effect runtime needed.
  - **D16 InterAgentCommunication schema extension:** `behavior_violation: Schema.optional(Schema.Struct({ contract_version: Schema.String, violations: Schema.Array(Schema.Struct({ kind: Schema.String, detail: Schema.String })) }))` field added AFTER abort_reason. Additive — pre-existing rows continue to validate.
  - **Tests:** behaviors.test.ts (40+ tests across 6 describe blocks: schema decode, defaults structure, resolveContract 5 cases, computeViolations 8 cases, ABORT_REASONS constant); inter-agent-communication.test.ts gains 3 new behavior_violation tests (construction + decode + JSON roundtrip). 43 pass / 0 fail. Per-file 100% line coverage on both files.

- **T2 — agent.ts behavior contract registration (25f1e2bf8):**
  - **D16 import:** `import { Behaviors } from "./behaviors"` near existing prompt imports.
  - **D16 attachment:** `general.options = { behaviors: Behaviors.DEFAULT_CONTRACTS["general"] }` AND `explore.options = { behaviors: Behaviors.DEFAULT_CONTRACTS["explore"] }`. Doc comments above each block reference D16 + the multi-agent-subagent.txt "Your behavior contract" section.
  - **D16 helper:** `export const behaviorContractFor = (agent_type, version?) => Behaviors.resolveContract(agent_type, version)` — straight passthrough for non-Agent.Service consumers (today's control.ts uses Behaviors.resolveContract directly; future iterations can route through Agent.Service for user-config overrides).
  - **Constraint:** ONLY general AND explore native subagent agent_types get behaviors. build / plan / compaction / title / summary records unchanged.
  - **Regression check:** registry.test.ts (7/0), agent-pool + agent-spawn (51/0) all green. Additive behavior_violation field does not regress existing assertions.

- **T3 — control.ts D16 runtime validation (8465cfca7):**
  - **D16 import + types:** `import { Behaviors, BehaviorContract } from "./behaviors"`. SpawnAgentInput extended with optional `behavior_version?: "subagent_v1" | "subagent_v2"`. PerRootData extended with `readonly behaviorOf: Map<SessionID, BehaviorContract>` — initialized via `behaviorOf: new Map()` in ensureRootSlot; cleared via `.behaviorOf.clear()` in BOTH the Session.Event.Deleted subscriber AND the disposal finalizer (>=2 .clear() call sites per per-root scoping invariant).
  - **D16 spawnAgent storage:** AFTER `slot.statuses.set(child.id, status)` and BEFORE the completion-watcher fork — `Behaviors.resolveContract(input.agent_type, input.behavior_version)` looks up the contract; when defined, stored on `slot.behaviorOf` keyed by child SessionID. Undefined contracts (unknown/unregistered agent_types) skip storage — no validation fires.
  - **D16 completion-watcher validation:** AFTER `effectiveAbortReason` is computed but BEFORE constructing the InterAgentCommunication for the parent notification — `Behaviors.computeViolations(contract, { delivered: childDelivered, abortReason: effectiveAbortReason })` runs. When violations exist, `behavior_violation = { contract_version, violations[] }` is attached to the parent notification's InterAgentCommunication. Additive to D5's prose warning; both can fire on the same case (D5 = prose; D16 = machine-readable structured payload). Validation is observer-only — spawn already returned cleanly; the orchestrator decides whether to pivot / retry / ignore.
  - **Tests:** control.test.ts gains a new `describe("AgentControl D16 behavior contract validation")` block with 7 it.live tests: undefined agent_type → no contract attached / no violation; unknown agent_type → same; general + no delivery → missing_delivery violation with subagent_v1; general + explicit sendInterAgentCommunication delivery → no violation; explore + ABORT(approach_failed) → undeclared_failure_mode violation (since explore excludes approach_failed); subagent_v2 explicit version → contract_version="subagent_v2" on notification; spawn returns LiveAgent successfully even when subsequent runtime violates contract (INV-D-26 unit). 100+ tests pass total. Per-file 100% line coverage on control.ts.

- **T4 — multi-agent-subagent.txt "Your behavior contract" section + prose tests (f1b9b98a9):**
  - **D16 prose:** New `## Your behavior contract` section appended to multi-agent-subagent.txt (AFTER `## ABORT` section). Caveman voice. Covers: every subagent has a declared behavior contract attached to its agent_type; the contract names delivery shape + termination mode + declared failure modes + optional expected output shape; `general` accepts all 6 ABORT reasons, `explore` accepts 5 (excludes approach_failed since explore doesn't iterate); runtime validates at terminal-status time and surfaces structured `behavior_violation` payloads; simple rule for staying inside the contract (deliver + only emit declared ABORT reasons); pointer back to ## Delivery contract + ## ABORT sections.
  - **D16 prose test extension:** prose/subagent-prompts.test.ts adds a new describe block with 6 grep assertions on the new section + required phrases. 54 pass / 0 fail.
  - **Constraint:** ONLY multi-agent-subagent.txt in prompt/ dir modified. No other prompt files touched per PROMPT_SURFACES ownership map — D16 prose lives in multi-agent-subagent.txt ONLY.

- **T5 — INV-D-24..26 integration invariants (674027786):**
  - **INV-D-24-agent-type-behavior-contract-validated-at-spawn:** spawn /root/g24 with agent_type='general'; runLoop writes one assistant text (no send_message); parent notification carries `behavior_violation.contract_version='subagent_v1'` AND `violations[0].kind='missing_delivery'`. Validates D16's missing_delivery detection end-to-end.
  - **INV-D-25-behavior-contract-version-bump-coexists-with-prior-version:** spawn /root/v1child (general + behavior_version=subagent_v1) AND /root/v2child (general + behavior_version=subagent_v2); both runLoops emit assistant text + declared ABORT (spec_wrong is in both versions' declared_failure_modes); both get missing_delivery violations under their own version's contract; no cross-contamination (v1child's notification carries "subagent_v1" only, v2child's "subagent_v2" only).
  - **INV-D-26-behavior-contract-violation-fails-orchestrated-wave-not-spawn:** spawnAgent wrapped in Effect.result; expects Result.isSuccess. Then runLoop terminates without delivery → parent's mailbox notification carries the violation. Validates that spawn-time contract registration does NOT prevent the spawn — the violation is observed AFTER spawn via mailbox notification (the orchestrator chooses what to do with it).
  - multi-agent-invariants.test.ts: 40 → 43 (+3 INV-D-24..26).

## Observations for future waves

- **Pre-agreed-contract pattern at scale (4 consecutive waves).** Wave 4 attempt 2 introduced it; Waves 5, 6, 7, 8 used it end-to-end. Net: 0 pivots across 10 subagent sessions for T1..T5 in Wave 8 — every task one commit-grade cycle. Recommendation: continue for Wave 9 (executor-solo though).
- **3-way parallelization works (Wave 8 T2+T3+T4).** Wave 7 demonstrated 2-way (T2+T3); Wave 8 extended to T2+T3+T4 — 6 subagents concurrent. Disjoint writes precondition trivially verified from PLAN.json's `writes` arrays (T2→agent.ts; T3→control.ts/control.test.ts; T4→multi-agent-subagent.txt/prose-tests). Recommendation: future waves should fan out wherever T-dependencies allow.
- **STAY ALIVE doctrine continues to prevent premature self-close.** All 5 evaluators stayed alive through all criteria. No mid-grade self-close incidents requiring orchestrator inline-adjudication.
- **No recipe-shape adjustments needed.** Wave 7 surfaced `--stat=200` for git show truncation and `sed -n LINE,LINEp` for awk-range bugs; Wave 8's CONTRACT.json recipes incorporated those lessons upfront. All 48 verify recipes passed on first run.
- **Schema.Class function% baseline propagates predictably.** behaviors.ts (BehaviorContract + BehaviorViolation extend Schema.Class) settles at 66.67% funcs / 100% lines; inter-agent-communication.ts (Schema.Class entirely) at 0% funcs / 100% lines; control.ts (multiple Schema.TaggedErrorClass instances) holds at 93.20% funcs / 100% lines. All documented under GOTCHA `schema-class-function-coverage` — no new GOTCHA needed.
- **No new GOTCHAs discovered.** Existing entries covered everything: `agentcontrol-providerref-must-live-in-layer-not-instancestate` (per-root slot pattern for the new behaviorOf map), `schema-class-function-coverage` (function% drift on three files), `bun-test-coverage-source-file-arg-runs-zero-tests` + `bun-coverage-aggregation-flake` (single-file coverage discipline preserved end-to-end).
- **Total Wave 8 contract criteria: 48/48 passed.** T1: 13; T2: 7; T3: 11; T4: 8; T5: 9. Comparable to Wave 7's 47/47 across 4 tasks.
- **Campaign progress: 8 of 10 waves complete.** Wave 9 (observability + audit) is the final orchestrated wave (executor-solo per WAVE.md header).
