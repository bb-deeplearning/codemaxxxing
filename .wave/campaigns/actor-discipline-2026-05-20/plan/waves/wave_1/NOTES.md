## Attempt 1 — WAVE COMPLETE

**Session:** ses_1bb62be9dffe9x2YUajNk80YsK
**Commit:** 1278d48be (settle commit; full sequence below in "Commit shas")
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** planner + per-task gen+eval pairs (6 tasks), pivot count: 1 (T5 negotiation stall → respawn)

### What happened

First orchestrated wave per ORCHESTRATOR_PROTOCOL.md. Spawned `wave_1_planner` (`general`) which wrote PLAN.json with 6 tasks (T1..T6) + inline rubric_seed. Tasks dispatched in two rounds:

- Round 1 (parallel): T1 (multi-agent-subagent.txt D1), T3 (general/anthropic.txt + gemini.txt D4), T4 (explore.txt D4). All landed clean.
- Round 2 (parallel): T2 (multi-agent-root.txt D7+D8), T5 (prose grep harness), T6 (INV-D-06 + INV-D-08). T2 + T6 landed clean.

T5 stalled in Phase 1 negotiation. Generator never sent the revised proposal after the evaluator's critique. Closed both T5 subagents and respawned `wave_1_t5_genb` + `wave_1_t5_evalb` with a PRE-AGREED 10-criterion contract (skipped negotiation entirely). New pair completed in one round.

Wave-settle verification (orchestrator-run):
- `bun typecheck` (packages/opencode): PASS
- `bun lint` (repo root, oxlint): PASS (3099 pre-existing warnings, 0 errors)
- `bun test ./test/integration/multi-agent-invariants.test.ts`: 23 pass / 0 fail / 99 expects
- `bun test ./test/prose/subagent-prompts.test.ts`: 15 pass / 0 fail / 18 expects
- INV-D-06 isolated: 1 pass / 0 fail / 3 expects
- INV-D-08 isolated: 1 pass / 0 fail / 7 expects
- Orchestrator artefacts: PLAN.json + CONTRACT.json (aggregated 6 task contracts) present; all 6 tasks signed=true; all 59 criteria status=passed

### Findings / lessons (feed into future waves)

1. **Eval lifecycle discipline matters even in Phase 1.** Both the original T1 eval and T5 eval terminated after sending their Phase 1 critiques because they did not enter a wait_agent loop in the same turn. T1 recovered automatically (followup_task from gen wakes a "completed" eval). T5 stalled because gen never sent the followup. Future wave spawn messages MUST instruct evaluators to use `wait_agent(timeout_ms: 300000)` immediately after sending any critique or grade reply, regardless of phase.

2. **Concurrent `git add -A` sweeps sibling work.** T3 generator's `git add -A` swept T4 generator's in-flight explore.txt edits into the T3 commit. The T4 evaluator handled it gracefully (graded T4 against the same SHA), but the audit trail is muddled. Round 2 spawn messages explicitly required `git add <specific files>` only — this worked. Bake into all future orchestrated-wave generator spawn templates.

3. **CONTRACT.json schema drift.** Per-task contracts shipped with three different `signed` schemas: `signed: true` (T1/T2/T3/T5), `signed_by: ["generator","evaluator"]` (T4), `signed: { generator: true, evaluator: true }` (T6). The orchestrator settle step had to normalize to `signed: true` for the aggregate. Future waves: pre-agree a single contract envelope schema.

4. **Pre-agreed contracts save a round-trip on simple tasks.** T5 respawn skipped negotiation entirely (orchestrator pasted the contract). One round of build + grade. ~3x faster than the failed first attempt. For prose-only / single-file tasks with clear acceptance criteria, the negotiation phase adds cost without proportional value. Consider an "executor-pre-agreed" track in ORCHESTRATOR_PROTOCOL.md.

5. **Role swap is recoverable.** T3 evaluator drafted the contract and sent it to the generator (reversing the spec'd order). The generator accepted, both wrote contracts/T3.json, all 16 criteria graded GREEN. The negotiation is converged-on-contract; who proposes first matters less than that both sign before build.

### Commit shas (Wave 1)

- 17f7b1513 — T1: rewrite multi-agent-subagent.txt (Delivery contract)
- 00c22f0ce — T1: contract signed, all 12 criteria passed
- 7f4546ebc — T3: defer-edit general/anthropic.txt + gemini.txt (also swept T4 explore.txt edits)
- 1399fa7af — T3: mark all 16 criteria passed
- 842458a0e — T4: contract signed, all 8 criteria passed at 7f4546ebc
- 168b47c57 — T2: add Sibling coordination + Limits sections
- 70d7f4281 — T2: mark all 13 criteria passed
- f2cf4c807 — T6: add INV-D-06 + INV-D-08
- 56576a1a2 — T5 (respawn): add prose grep harness
- c78b4a61a — T5 (respawn): mark all 10 criteria passed
- 1278d48be — wave 1 settle: aggregate CONTRACT.json, polish prose harness, STATE.md, NOTES.md

---
