# Wave 5 — Notes

## Attempt 1 — success (WAVE COMPLETE)

**Session:** ses_1baf41a10ffeZ422LtQm8VsmkF
**Settle commit:** 209ce3e63
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** orchestrator pre-agreed contracts (PLAN.json + CONTRACT.json drafted by /root before subagent dispatch) + sequential per-task gen+eval pairs for T1, T2, T3. 0 pivots.

### Pattern: pre-agreed-contract carried forward from Wave 4 attempt 2

Wave 4 NOTES.md recommended the pre-agreed-contract pattern: orchestrator drafts CONTRACT.json criteria with deterministic verify recipes; generator + evaluator skip negotiation and run straight to build + grade. Wave 5 attempt 1 applied this end-to-end. Each task collapsed to a single commit-grade cycle with 0 pivots.

### Orchestration trace

| Subagent | Path | Role | Outcome | Commits | Pivots |
|---|---|---|---|---|---|
| feynman | `/root/t1_gen` | generator | WAVE TASK DONE (T1 plumbing+tests) | b7b55941c (plumbing A-H), 927ffd6d4 (D12 tests I) | 0 |
| newton | `/root/t1_eval` | evaluator | self-closed after grading C1-C7; orchestrator inline-adjudicated C8-C12 + 2 recipe-shape adjustments | 9703e08a3 (contract) | 0 |
| lovelace | `/root/t2_gen` | generator | WAVE TASK DONE (T2 schema+tests) | f51b57c52 | 0 |
| linnaeus | `/root/t2_eval` | evaluator | WAVE TASK GREEN 8/8 | d30441f23 (contract) | 0 |
| ramanujan | `/root/t3_gen` | generator | WAVE TASK DONE (T3 invariants+prose) | 98d2abf4c | 0 |
| turing | `/root/t3_eval` | evaluator | WAVE TASK GREEN 10/10 | e5f50c444 (contract) | 0 |

### T1 evaluator self-close — inline adjudication

`/root/t1_eval` self-closed after grading the plumbing commit (C1-C7). C8-C12 were inline-adjudicated by the orchestrator per the Wave 4 T2 NOTES.md precedent ("verify recipes re-run literally, no interpretation"). Two minor recipe-shape adjustments documented on the respective criteria:

- **C8 (`>=5 D12 it.live tests`)**: Original recipe used `grep -cE 'it\.live\(.*(on_failure|...)' ...` which requires the keyword on the SAME line as `it.live(`. The generator used multi-line title formatting (title on its own line) for long titles, so only 2 inline matches counted vs the actual 6 tests inside the D12 describe block. Revised recipe scopes the count to the describe block boundary via awk: `awk '/^describe\("AgentControl D12/,/^}\)$/' control.test.ts | grep -cE '^\s*it\.live\('` → 6 matches → PASS.
- **C11 (`100% lines coverage on control.ts`)**: Original recipe greps `control\.ts.*100\.00\s*\|\s*[0-9-]` which over-anchors on the uncovered-lines column (empty when coverage is 100%). Actual coverage `93.16% functions / 100.00% lines` (function% gap is the pre-existing Schema.TaggedErrorClass quirk per GOTCHA `schema-class-function-coverage`). Revised recipe matches the lines column only: `grep -E 'control\.ts.*100\.00'` → PASS.

Both adjustments are documented in CONTRACT.json T1 evidence. The ORCHESTRATOR_NOTE pseudo-criterion records the self-close + inline-adjudication trail (mirrors Wave 4 T2 precedent).

### Verification results (orchestrator-run at settle)

| Surface | Result |
|---|---|
| `bun typecheck` | exit 0 (tsgo --noEmit clean) |
| `bun lint` (repo root, oxlint) | 0 errors / 3110 pre-existing warnings |
| `bun test src/agent/control.test.ts src/tool/agent-spawn/agent-spawn.test.ts` | 124 pass / 0 fail / 275 expects in 7.85s |
| `bun test --coverage src/agent/control.test.ts` → control.ts | 93.16% functions / 100.00% lines (function% gap is pre-existing Schema.TaggedErrorClass quirk per GOTCHA `schema-class-function-coverage`) |
| `bun test --coverage src/tool/agent-spawn/agent-spawn.test.ts` → agent-spawn.ts | 100.00% functions / 100.00% lines |
| `bun test ./test/integration/multi-agent-invariants.test.ts` | 34 pass / 0 fail / 156 expects in 6.63s (was 31; +3 for INV-D-15/16/17) |
| `bun test -t 'INV-D-15-spawn-agent-with-on-failure-respawn-restarts-on-crash'` | 1 pass / 33 filtered / 0 fail / 5 expects |
| `bun test -t 'INV-D-16-pool-strategy-one-for-all-kills-pair-on-single-failure'` | 1 pass / 33 filtered / 0 fail / 5 expects |
| `bun test -t 'INV-D-17-pool-strategy-one-for-one-isolates-failures'` | 1 pass / 33 filtered / 0 fail / 6 expects |
| PLAN.json + CONTRACT.json artefacts | present at `waves/wave_5/` |
| CONTRACT.json totals | T1: 13/13 signed at 927ffd6d4; T2: 8/8 signed at f51b57c52; T3: 10/10 signed at 98d2abf4c |

### What shipped (Wave 5 — Phase 3A: supervision strategies)

- **D12 control.ts runtime (T1, b7b55941c + 927ffd6d4):**
  - Top-level type aliases `OnFailureStrategy` (`"respawn" | "escalate" | "ignore" | "kill_pool"`) and `PoolStrategy` (`"one_for_one" | "one_for_all" | "rest_for_one"`) exported.
  - `SpawnAgentInput` extended with optional `on_failure` and `pool_strategy`. Defaults preserve pre-D12 behavior (`escalate` / `one_for_one`).
  - `PerRootData` gains 4 new Map fields: `onFailureOf` (per-child policy), `poolStrategyOf` (per-child policy stub), `respawnCountByPath` (per-task counter), `respawnInputByPath` (cached input for replay).
  - `ensureRootSlot` initializes all 4 maps; teardown subscriber + disposal finalizer clear them (mirrors existing skipCompletionNotification pattern).
  - `spawnAgent` stores policy + caches input + initializes counter on slot.
  - Completion-watcher dispatches on terminal-errored status:
    - `respawn` + count<3: notification with `abort_reason: { reason: "transient_tool_error", details: "respawned after crash; attempt N/3" }`, increment counter, release old child state, re-call `spawnAgent(cachedInput)` (path is now free), self-interrupt.
    - `respawn` + count>=3: falls through to existing notification with overridden `abort_reason: { reason: "transient_tool_error", details: "respawn cap exceeded after 3 attempts" }`.
    - `ignore`: skip notification entirely (mirrors `skipCompletionNotification` flow).
    - `escalate` (default) + `kill_pool`: pre-D12 behavior unchanged (policy stored only).
  - 6 new D12 it.live tests in control.test.ts (default-escalate, respawn x2, ignore, kill_pool, pool_strategy stub). Full file: 94 pass / 0 fail.
- **D12 agent-spawn.ts tool (T2, f51b57c52):**
  - `Parameters` Schema.Struct gains `on_failure` and `pool_strategy` as `Schema.optional(Schema.Union([Schema.Literal(...), ...]))`. Used Union+Literal pattern (Effect v4 beta Schema.Literal takes single literal only; same shape as `src/agent/status.ts` AgentStatus).
  - `execute` body passes both params through to `control.spawnAgent({...})`. Undefined cascades into the runtime's defaults.
  - 9 new it.live tests in agent-spawn.test.ts (4 on_failure + 3 pool_strategy + 1 combined + 1 Schema-decode rejection) + 1 extra `agent_type='build'` test to push coverage to 100%. Full file: 30 pass / 0 fail; per-file coverage 100% lines / 100% functions.
- **D12 invariants + tool description (T3, 98d2abf4c):**
  - INV-D-15 (respawn restarts crashed child with new session id; abort_reason carries `transient_tool_error` + attempt N/3 details).
  - INV-D-16 (pool_strategy=one_for_all stored on spawn; full sibling-teardown lands Wave 6 — STUB form per WAVE.md).
  - INV-D-17 (pool_strategy=one_for_one stored on spawn; isolation default preserved — STUB form per WAVE.md).
  - `## Supervision strategies (D12)` section appended to agent-spawn.txt with all 7 enum literals + closing line referencing Wave 6.

### Observations for future waves

- **Pre-agreed-contract pattern continues to scale.** Wave 4 attempt 2 introduced it for T3/T4; Wave 5 attempt 1 used it for all 3 tasks end-to-end. Net effect: 0 pivots across 6 subagent sessions, each task one commit-grade cycle. Recommendation: continue this pattern for Wave 6 (spawn_pool wiring) — the criteria are mechanically verifiable (file-greps + Schema introspection + integration invariants).
- **Evaluator self-close risk persists.** T1's evaluator self-closed after grading the plumbing commit, before the tests commit landed. Orchestrator caught this via `list_agents` polling + inline-adjudicated C8-C12. The evaluator spawn message for T2 + T3 added an explicit "STAY ALIVE UNTIL WAVE TASK GREEN" instruction; both T2 and T3 evaluators stayed alive through all criteria. Recommendation: keep the "stay alive" instruction in every evaluator spawn message for Wave 6+.
- **Recipe shape vs reality.** Two T1 verify recipes (C8 multi-line it.live counting; C11 over-anchored coverage regex) needed orchestrator-side adjustments. Both adjustments preserve the criterion's intent. For Wave 6, prefer recipes that (a) scope by describe-block boundary via awk when counting tests inside a specific block; (b) match only the lines column on coverage (not the trailing uncovered-lines column).
- **Schema.Literal Effect v4 beta API.** `Schema.Literal` in Effect v4 beta takes a single literal arg. For multi-value enums, use `Schema.Union([Schema.Literal("a"), Schema.Literal("b"), ...])`. The generator discovered this against `src/agent/status.ts` AgentStatus as a reference. Worth a GOTCHAS entry IF this surfaces again in Wave 6+ (spawn_pool may add similar enums).
- **No new GOTCHAs discovered.** Existing entries covered everything: `agentcontrol-providerref-must-live-in-layer-not-instancestate` (per-root slot pattern for the 4 new maps), `agentcontrol-d11-abort-line-parser-last-line-only` (sibling completion-watcher invariant — preserved), `bun-test-coverage-source-file-arg-runs-zero-tests` + `bun-coverage-aggregation-flake` (single-file coverage discipline), `schema-class-function-coverage` (the 93.16% function% gap on control.ts is the pre-existing TaggedErrorClass quirk).
