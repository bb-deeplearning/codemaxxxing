## Attempt 1 — WAVE COMPLETE

**Session:** ses_wave2_orchestrator
**Commit:** <settle commit; orchestrator fills post-commit>
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** planner + per-task gen+eval pairs (3 tasks), pivot count: 1 (T1 ABORT(spec_wrong) → orchestrator landed D5b two-pass hardening inline → T1 generator resumed and committed atomically)

### What happened

Planner wrote PLAN.json with 3 tasks (T1 INV-D-01 regression, T2 INV-D-06 regression, T3 audit). T1 generator's initial pass uncovered a production gap in D5: the extractor walked newest-first via `findMessage`, which shadowed the real deliverable (the `FULL REPORT BODY` from the `finish=tool-calls` turn) behind a terse `Done.` follow-up in the Cidoo two-message shape (ses_1c2e8d84affeZ7t5g5LKveGDTo). T1 generator emitted ABORT(spec_wrong). Orchestrator landed inline D5b two-pass hardening (~15 LOC in `control.ts:820-859` — pass 1 looks for substantive bodies via `!looksLikeMissingDeliverable(text)`, pass 2 falls back to the original newest-first walk) plus a GOTCHAS entry (`agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line`). T1 generator resumed and committed both `multi-agent-invariants.test.ts` + `control.ts` + `GOTCHAS.md` atomically (42fc76207). T2 rebased on T1, added the runtime sibling-deadlock test + prose mirror-sentence grep, landed clean (12e42f932). T3 wrote this audit.

### Verification (wave-settle, orchestrator-run)

- `bun typecheck` (packages/opencode) — PASS (tsgo --noEmit, exit 0)
- `bun lint` (repo root, oxlint) — PASS (3101 warnings, 0 errors; +2 vs Wave 1 from non-T3 work)
- `bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-0'` — 10 pass / 0 fail / 36 expects / 15 filtered out (8 INV-D-0[1-8] + 2 regression slugs)
- `bun test ./test/integration/multi-agent-invariants.test.ts` — 25 pass / 0 fail / 105 expects (5.4s; full file regression clean)
- `bun test test/prose/subagent-prompts.test.ts` — 21 pass / 0 fail / 21 expects (697ms; Wave 1 + Wave 2 prose additions)
- Orchestrator artefacts: PLAN.json + contracts/T1.json + contracts/T2.json + contracts/T3.json + NOTES.md present; T1 + T2 signed=true; T3 pending sign post-eval.

### Invariant → wave → fix table

| Invariant slug | Wave | Fix description |
|---|---|---|
| INV-D-01 (extractor returns text from finish=tool-calls) | Wave 0 | D5 extractor narrowing (`control.ts:820` — accept assistant with non-empty extracted text instead of skipping finish=tool-calls). |
| INV-D-02 (explicit send delivers + completion notifies) | Wave 0 | D5 outgoingToSpawner tracking + D3 close_agent self-close path. |
| INV-D-03 (safety-net warning on silent exit) | Wave 0 | D5 safety net + `looksLikeMissingDeliverable` heuristic. |
| INV-D-04 (close_agent without target resolves to caller) | Wave 0 | D3 made `target` optional in agent-close.ts. |
| INV-D-05 (subagent prompt contains canonical path) | Wave 0 | D2 per-spawn path injection in `capabilityHints` (session/system.ts). |
| INV-D-06 (send_message unicast not broadcast) | Wave 1 | D7 sibling-coordination prose in multi-agent-root.txt; runtime was always unicast. |
| INV-D-07 (close_agent already_terminated vs path_invalid) | Wave 0 | D9 error-tag split in `control.wasKnownPath` + agent-close.ts metadata. |
| INV-D-08 (coordinator fan-out → ONE consolidated message) | Wave 1 | No new production code; integration test locks in Demo 1 success shape. |
| INV-D-01-regression-ses_1c2e8d84affe (Cidoo two-message shape) | Wave 2 | D5b two-pass extractor hardening in `control.ts:820-859` (orchestrator inline fix after T1 gen ABORT(spec_wrong)). |
| INV-D-06-regression-ses_1d84f236bffe (Demo 2 prosecutor/defense unicast) | Wave 2 | No new production code; regression test pins runtime unicast + prose unicast-doctrine presence in both root + subagent prompts. |

### Drift observed

- T1 INV-D-01 regression failed on first build (before D5b). Root cause: `findMessage` walked newest-first, picked up the `Done.` follow-up; the safety net's `looksLikeMissingDeliverable` heuristic correctly flagged it as status-like, but only the safety-net `<no text emitted>` warning shipped — the actual `FULL REPORT BODY` from the prior `finish=tool-calls` turn was never extracted. Post-D5b: stable green across 3 verification runs (slug-targeted, full file, full filter).
- Wave 1's INV-D-06 (runtime unicast) stayed green across the wave; the Wave 2 regression slug is an additive pin on the Demo 2 cast (`prosecutor` / `defense`), not a fix.
- Lint warning count drifted +2 (3099 → 3101) from non-T3 / non-wave work in the repo; flagged for visibility, not a regression of this wave.

### Recommendations for Phase 2 (Waves 3-4)

1. **D5 safety-net heuristic adequacy.** `looksLikeMissingDeliverable` triggers on `length < 200` + single-line + status-line word regex. D5b's two-pass walk addresses the Cidoo shape (pass 1 looks for substantive body, pass 2 falls back). Worth tightening: pass-1 may still pick a body that is long-ish but information-poor (e.g. a 250-char "I have completed the task. The files have been updated. Let me know if you need anything else."). Consider a token-count threshold (e.g. `< N` semantic tokens), or a structured-content signal (presence of file paths, code blocks, line refs). Promote to a Wave 3 invariant: "extractor prefers bodies containing structured artefacts over prose-only status bodies of similar length."
2. **D6 (root-hold for in-flight mail) status.** Wave 0 explicitly deferred D6 per WAVE.md §6 allowance — the safety net catches the race observably. Confirm in Phase 2 whether D6 is needed once correlation_id (D10) + `wait_for_reply` land, or whether the ask-pattern obviates the runLoop break-point hack. If D6 is still wanted, give it a focused wave so the runLoop "model says stop → root settles" contract gets explicit test coverage.
3. **INV-D-06 ask-pattern follow-up.** Demo 2 deadlock root cause was prose (no instruction to address peers directly), not runtime. Wave 2's regression test pins both. With Wave 3's correlation_id + `wait_for_reply`, the prosecutor/defense pattern could be re-tested with explicit request/reply pairing. Add INV-D-09 (ask-pattern variant) driving the prosecutor/defense scenario through a `wait_for_reply` call; verify the deadlock dissolves without prose changes.

### Commit shas (Wave 2)

- 42fc76207 — T1: add INV-D-01-regression-ses_1c2e8d84affe + D5b two-pass extractor hardening (Cidoo shape)
- 12e42f932 — T2: add INV-D-06-regression-ses_1d84f236bffe (Demo 2 sibling-deadlock — runtime + prose)
- <T3 commit sha — orchestrator fills after committing>

---
