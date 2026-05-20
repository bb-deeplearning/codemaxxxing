# Wave 4 — Notes

## Attempt 2 — success (WAVE COMPLETE)

**Session:** ses_1bb04b0daffeSUR0CnF29k7wGI
**Settle commit:** 8c16cbc7d
**Date:** 2026-05-20
**Decision on entry:** continue
**Orchestration:** planner-skipped (PLAN.json + CONTRACT.json already authored by attempt 1) + sequential per-task gen+eval for T3 then T4. 0 pivots.

### Why continue (not reset)

Attempt 1 landed two clean commits before crashing:

- `f0591a5c0` — `wave 4 T1: add abort_reason to InterAgentCommunication schema (additive)`
- `8edbca4ca` — `wave 4 T1: contract — all criteria passed`
- `bbce94f51` — `wave 4 T2: parse ABORT set-phrase in completion-watcher + structured abort_reason payload`

T1 + T2 were graded green in `waves/wave_4/CONTRACT.json` (in-tree, uncommitted). Reverting would have discarded 257 lines of working, test-covered code + GOTCHAS entry that the T4 invariants depend on.

No `wave 4 (failed):` commits existed (`git log --oneline | grep "wave 4 ("` empty), so no reverts were required.

T1 + T2 grading evidence from attempt 1 rolled forward into the T3 generator's initial `git add -A` and landed as `e0592d9e6 wave 4 T2: contract — all 9 criteria passed (orchestrator-adjudicated; evaluator subagent reaped pre-commit)`.

### Crash context (attempt 1)

STATE.md said `crashed: session ended without state update`. Likely an unrelated `opencode` exit; no recorded ABORT or stack. T3/T4 were never dispatched.

### Orchestration trace

| Subagent | Path | Role | Outcome | Pivots |
|---|---|---|---|---|
| noether | `/root/t3_gen` | generator | WAVE TASK DONE T3 → commit `4f890b5c4` | 0 |
| newton | `/root/t3_eval` | evaluator | WAVE TASK GREEN T3 (12/12) → commit `d5ba4df93` | 0 |
| curie | `/root/t4_gen` | generator | WAVE TASK DONE T4 → commit `389d14d2e` | 0 |
| bohr | `/root/t4_eval` | evaluator | WAVE TASK GREEN T4 (10/10) → commit `dd0a9bf7f` | 0 |

T3 + T4 each ran their own gen+eval pair; both pairs landed on first attempt. No criterion failed; no ABORT emitted; no pivot burned. The pre-agreed contract pattern (contract signed at decomposition time) collapsed each task to a single commit-then-grade cycle.

### Verification results (orchestrator-run at settle)

| Surface | Result |
|---|---|
| `bun typecheck` | clean (tsgo --noEmit exit 0) |
| `bun lint` (oxlint, repo root) | 0 errors / 3102 pre-existing warnings |
| `bun test src/agent/control.test.ts` | 88 pass / 0 fail / 196 expects |
| `bun test src/agent/inter-agent-communication.test.ts` | 13 pass / 0 fail / 28 expects |
| `bun test --coverage src/agent/control.test.ts` | `src/agent/control.ts` 100.00% lines / 94.78% functions (the function% gap is the pre-existing Schema.TaggedErrorClass quirk per GOTCHA `schema-class-function-coverage`) |
| `bun test --coverage src/agent/inter-agent-communication.test.ts` | `src/agent/inter-agent-communication.ts` 100.00% lines |
| `bun test ./test/integration/multi-agent-invariants.test.ts` | 31 pass / 0 fail / 140 expects (was 28; +3 for INV-D-12/13/14) |
| `bun test test/prose/subagent-prompts.test.ts` | 38 pass / 0 fail / 38 expects (was 27; +11 for Wave 4 ABORT prose grep) |
| `bun test -t 'INV-D-12-abort-reason-delivered-as-structured-payload'` | 1 pass / 30 filtered |
| `bun test -t 'INV-D-13-orchestrator-pivots-on-abort-approach-failed'` | 1 pass / 30 filtered |
| `bun test -t 'INV-D-14-set-phrase-ladder-extended-to-all-subagent-types'` | 1 pass / 30 filtered |
| PLAN.json + CONTRACT.json artefacts | present at `waves/wave_4/` |

### What shipped (Wave 4 — Phase 2B: ABORT protocol)

- **D11 schema (T1, f0591a5c0):** `abort_reason: Schema.optional(Schema.Struct({ reason: Schema.String, details: Schema.String }))` on `InterAgentCommunication` (additive). 3 new test cases (constructor, schema-decode, JSON roundtrip).
- **D11 runtime parser (T2, bbce94f51):** `parseAbortReason` helper at `control.ts:221-227` (line-anchored `^ABORT\(([a-z_]+)\):\s*(.+?)\s*$` against the last non-empty line of the extracted body). Completion-watcher populates `abort_reason:` on the InterAgentCommunication construction (`control.ts:916,928`). 9 new control.test.ts tests. GOTCHAS entry `agentcontrol-d11-abort-line-parser-last-line-only` registered.
- **D11 prose (T3, 4f890b5c4):** New `## ABORT — structured failure exits` section in `multi-agent-subagent.txt` enumerating the six reasons + format + last-line constraint + non-auto-close clarification. Brief ABORT refs added to `general/anthropic.txt`, `general/gemini.txt`, `explore.txt` (one line each pointing at the multi-agent coordination guidance). One-line Wave 4 cross-reference note in `ORCHESTRATOR_PROTOCOL.md` near the existing ABORT REASONS block.
- **D11 invariants + prose tests (T4, 389d14d2e):** INV-D-12 (structured payload delivery), INV-D-13 (stub-orchestrator pivot pattern), INV-D-14 (runtime is agent-type-agnostic) added to `multi-agent-invariants.test.ts`. New `Wave 4 — ABORT protocol prose` describe block in `subagent-prompts.test.ts` covering section header + format string + six reason tags + three base-prompt refs.

### Observations for future waves

- The pre-agreed-contract pattern (contract signed at decomposition time, generator + evaluator skip negotiation) collapses each task to a single commit-grade cycle. Both T3 and T4 landed on first attempt with no pivot. Recommend this pattern for Wave 5+ when the contract criteria are mechanically verifiable.
- The `git add -A` quirk: a subagent's `git add -A` will pick up any uncommitted modifications in the working tree (including prior session's leftovers). The T3 generator handled this gracefully by isolating the leftover T2 contract edits into a separate commit (`e0592d9e6`) before its own work. Future executors should be aware that `git add -A` is not scoped to the subagent's changes alone.
- No new GOTCHAs discovered this wave — the existing `agentcontrol-d11-abort-line-parser-last-line-only` (added by T2 in attempt 1) covered the regex-anchoring trap for ABORT parsing.
