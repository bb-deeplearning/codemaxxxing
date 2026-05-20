# Wave 8 — Declared agent_type behaviors (orchestrated)

<!--
Previous waves: 0-7.
Orchestration: FULL.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-24..26)
- ../../REFERENCES.md (Erlang gen_server behaviors; OTP behaviour callbacks)
- packages/opencode/test/AGENTS.md
-->

## Goal

Phase 3D. Each `agent_type` declares its behavior contract: delivery requirement, termination condition, declared failure modes, expected output shape. Runtime validates the contract at terminal status time and surfaces violations as structured warnings (additive to D5's safety net).

Deliverables:

1. **D16 behavior contract schema** — new `packages/opencode/src/agent/behaviors.ts`. Defines `BehaviorContract` Schema with fields:
   - `version: "subagent_v1" | "subagent_v2"` (extensible)
   - `delivery: "send_message_required" | "send_message_optional" | "no_delivery"` (no_delivery for fire-and-forget patterns)
   - `termination: "self_close" | "spawner_close" | "either"`
   - `declared_failure_modes: ABORT_REASON[]`
   - `expected_outputs?: { kind: "json_schema" | "free_text", schema?: ... }`
2. **D16 per-agent_type registration** — `agent/agent.ts` extends each registered agent_type with a default BehaviorContract. `general` gets `subagent_v1` with `send_message_required` + `self_close` + all six ABORT reasons. `explore` gets a similar v1 with adjusted failure modes (no `approach_failed` — explore doesn't iterate).
3. **D16 runtime validation** — `agent/control.ts` on terminal status: validate against the child's declared contract. Violations surface as structured notification (separate from D5 safety net's prose warning; this is machine-readable).
4. **D16 version coexistence** — `subagent_v1` and `subagent_v2` declared simultaneously; each child uses its declared version's contract (passed at spawn time, default = agent_type's declared default).
5. **D16 prose** — `multi-agent-subagent.txt` adds a "Your behavior contract" section pointing to the declared version's requirements.

Integration invariants:
- INV-D-24: `agent-type-behavior-contract-validated-at-spawn`
- INV-D-25: `behavior-contract-version-bump-coexists-with-prior-version`
- INV-D-26: `behavior-contract-violation-fails-orchestrated-wave-not-spawn`

## Tasks (orchestrated)

Planner outputs PLAN.json with ~5 tasks:

- T1: `agent/behaviors.ts` (NEW) Schema + default contracts
- T2: `agent/agent.ts` per-agent_type contract registration
- T3: `agent/control.ts` runtime validation at terminal time
- T4: Prose updates in `multi-agent-subagent.txt`
- T5: INV-D-24..26 tests

## Gotchas

1. **Validation runs at terminal time, not spawn time.** Per INV-D-26: a spawn must succeed even if the agent later violates its contract. The validation observes the deliverable + closure pattern after the fact and surfaces a structured warning. The orchestrator decides what to do with the warning (pivot, retry, ignore).
2. **`subagent_v1` default for ALL existing agents** must NOT break existing tests. Audit the hardening campaign's tests; their stub runLoops likely don't call send_message but ARE expected to work. The `general` agent's default should be lenient enough to not flag the existing test patterns as violations — or, mark the existing test patterns with `BehaviorContract.exempt: true` (an escape hatch for tests).
3. **Version field is forward-compatible.** Adding `subagent_v3` later doesn't break v1 or v2 children. The runtime validation key is `child_contract.version`.
4. **Don't conflate behavior validation with safety net.** D5's safety net (Wave 0) fires when delivery seems missing AND extracted body looks like a status string. D16's behavior validation is a separate check tied to the declared contract. Both can fire on the same case; document the relationship.
5. **`expected_outputs` JSON schema validation** is optional. If declared, attempt to parse the deliverable (most recent send_message body) as JSON against the schema. Validation failure → structured warning. Most v1 contracts will NOT declare an output schema; defer to subagent_v2 for that strictness.
6. **GOTCHAS to consult:**
   - `agentcontrol-providerref-must-live-in-layer-not-instancestate` — contract registry state.
   - `tool-execute-needs-explicit-result-type-disjoint-metadata` — if validation surface needs explicit result types.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/agent/behaviors.test.ts                   # NEW
bun test src/agent/agent.test.ts                       # extend (per-agent_type contract registration)
bun test src/agent/control.test.ts                     # extend (runtime validation)

# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/agent/behaviors.test.ts
bun test --coverage src/agent/agent.test.ts
bun test --coverage src/agent/control.test.ts

bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-24'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-25'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-26'

bun test ./test/integration/multi-agent-invariants.test.ts

test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_8/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_8/CONTRACT.json
```

All must exit 0.
