## Attempt 1 — WAVE COMPLETE

**Session:** ses_1bb308ef6ffeA3UiI4m70jbr9i
**Commit:** 39ffe0e2f (settle commit; per-task SHAs in Commit shas section)
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** planner + per-task gen+eval pairs (4 tasks), pivot count: 0 (one C6 orchestrator-adjudication on T3 — see below)

### What happened

Phase 2A. Four tasks dispatched T1 → T2 → T3 → T4 in dependency order, each with a generator + evaluator pair and pre-agreed contract (mirroring Wave 2's pattern). Every task closed in one round; no negotiation phase.

- **T1** added optional `correlation_id: Schema.optional(Schema.String)` to InterAgentCommunication. Two-line additive schema change. Commit `0facbc871`.
- **T2** added optional `correlation_id` Parameters field + execute pass-through to both `send_message` and `followup_task`, plus prose + round-trip test extensions. 8-file commit `fe856de8d`.
- **T3** added `wait_for_reply` as a second `Tool.define(WaitForReplyID, ...)` in agent-wait.ts, supported by `Mailbox.peek()` (snapshot without drain) and `AgentControl.findMailboxByCorrelationId(id, correlation_id)` (per-root scoped peek). Also added structured `metadata.warning` to `wait_agent` for `missing_timeout` / `timeout_clamped`, agent-wait.txt doctrine section, registry.ts wiring (import / yield / Tool.init / builtin / legacy-id bridge), full test coverage in agent-wait.test.ts + schema.test.ts. Commit `c6b1f563a`.
- **T4** added the prose `## Wait timeouts` section to multi-agent-root.txt + mirror bullet in multi-agent-subagent.txt, three integration invariants `INV-D-09-correlation-id-pairs-reply-to-request`, `INV-D-10-wait-for-reply-times-out-without-matching-correlation`, `INV-D-11-missing-timeout-on-wait-emits-warning`, and a Wave 3 prose describe block in subagent-prompts.test.ts. Commit `53dc82de0`.

### Verification (wave-settle, orchestrator-run)

- `bun typecheck` (packages/opencode) — PASS (tsgo --noEmit, exit 0)
- `bun lint` (repo root, oxlint) — PASS (3102 warnings, 0 errors; +1 vs Wave 2 from non-wave work)
- `bun test ./test/integration/multi-agent-invariants.test.ts` — 28 pass / 0 fail / 123 expects (5.9s) — 25 pre-existing + 3 new (INV-D-09/10/11)
- `bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-09|INV-D-10|INV-D-11'` — each pass when filtered individually
- `bun test test/prose/subagent-prompts.test.ts` — 27 pass / 0 fail (897ms; Wave 1+2+3 prose additions)
- Per-file 100% line coverage (single-file source-of-truth runs):
  - `src/agent/inter-agent-communication.ts` — 0% functions / 100% lines (Schema.Class quirk per GOTCHA `schema-class-function-coverage`)
  - `src/agent/mailbox.ts` — 100% / 100% (via mailbox.test.ts, post peek test addition)
  - `src/agent/control.ts` — 94.74% / 100% (via control.test.ts, post findMailboxByCorrelationId test addition)
  - `src/tool/agent-send/agent-send.ts` — 100% / 91.43% (pre-existing send_failed branch uncovered — predates this wave at commit 813cf9ac4f from codex-parity-2026-05-13; not introduced by Wave 3)
  - `src/tool/agent-followup/agent-followup.ts` — 100% / 100%
  - `src/tool/agent-wait/agent-wait.ts` — 100% / 100% (via agent-wait.test.ts, post no-mailbox-fallback test additions)
  - `src/tool/registry.ts` — pre-existing factory-bridge gaps; T3 wiring lives in covered branches
- Orchestrator artefacts: PLAN.json + contracts/T1..T4.json + aggregated CONTRACT.json + NOTES.md present; all 4 tasks signed; 41/41 criteria status=passed (T3 C6 orchestrator-adjudicated to passed — see below).

### Per-task criteria + commit shas

| Task | Commit | Criteria | Notes |
|---|---|---|---|
| T1 | 0facbc871 | 5/5 passed | InterAgentCommunication schema +5 lines (correlation_id optional field + D10 comment). |
| T2 | fe856de8d | 10/10 passed | send_message + followup_task each gained Parameters.correlation_id + execute pass-through + .txt section + round-trip test + 2 schema tests. |
| T3 | c6b1f563a | 13/13 passed (12 verified + 1 orchestrator-adjudicated — see below) | Wait_for_reply tool + Mailbox.peek + AgentControl.findMailboxByCorrelationId + wait_agent warning + agent-wait.txt doctrine + registry wiring + 22 new tests. |
| T4 | 53dc82de0 | 13/13 passed | Wait timeouts prose section + wait_for_reply subagent bullet + INV-D-09/10/11 integration invariants + 6 Wave 3 prose grep tests. |

### Drift / orchestrator adjudications

**T3 C6 — registry-wiring literal-grep recipe too strict for established convention.**
Contract C6 required `grep -F 'AgentWaitForReplyTool' packages/opencode/src/tool/registry.ts | wc -l >= 4`. Generator's wiring is structurally complete (5 wiring points: import L21, yield L136, Tool.init via local var L242, builtin via tool.* L287, legacy-id bridge L417) but only THREE of those use the literal `AgentWaitForReplyTool` substring — the other two use the local variable name (`agentwaitforreply`) and the object property (`tool.agentwaitforreply`). This mirrors the existing `AgentWaitTool` wiring EXACTLY (the pre-existing tools also produce only 3 literal occurrences each).

Asking the generator to inline the literal would violate the "no shitty unidiomatic regression-causing amateur-tier code — match the codebase's existing patterns" bar. Adjudicated as **passed**: structural correctness verified by C11 (typecheck clean), C12 (47/0 agent-wait suite), C13 (multi-agent-invariants 25/0 unchanged). Evidence recorded in `contracts/T3.json` C6 entry. Recipe authoring lesson recorded below.

**Inline coverage hardening (orchestrator pre-settle).**
T3's added code introduced two new defensive branches (mirror of pre-existing wait_agent fallback) and a new peek() method that the generator's tests didn't fully cover. Per AGENT_INSTRUCTIONS bar (100% line coverage on every modified file), orchestrator added three small tests inline pre-settle:
- `Mailbox.peek` describe block in mailbox.test.ts (2 tests) → mailbox.ts now 100%/100%.
- `wait_for_reply falls back to sleep-then-timeout when calling session is unknown` in agent-wait.test.ts → covers L248-250.
- `wait_agent — calling session is unknown to AgentControl` describe in agent-wait.test.ts → covers PRE-EXISTING L123-125 dead branch (improvement on legacy gap).
- `AgentControl.findMailboxByCorrelationId` describe in control.test.ts (3 tests) → control.ts now 100% lines via control.test.ts single-file run.

This is the Wave-2-lesson-#1 pattern: small inline completions inside the wave's spirit are valid; reserve PLAN UNDOABLE for structural gaps.

**Generator pattern: contract slices swept into NEXT task's commit.**
Each evaluator wrote its contracts/T<N>.json AFTER the generator's commit. The NEXT generator's `git add -A` swept the prior eval's slice into its commit. Harmless (orchestrator metadata, no production impact) but worth noting. Future waves: consider having evaluators commit their slices directly (per-eval commits) OR having the orchestrator stage + commit them at wave-settle.

### Phase 2A surface delivered

| Capability | Lives at | Notes |
|---|---|---|
| `correlation_id` field on InterAgentCommunication | inter-agent-communication.ts | Optional, additive — pre-existing rows still validate. |
| `correlation_id` parameter on send_message + followup_task | agent-send.ts L34-42, agent-followup.ts L29-34 | Optional, pass-through to InterAgentCommunication. |
| Mailbox snapshot (without drain) | mailbox.ts `peek()` | Peer to `drain()`; used by wait_for_reply filter. |
| Correlation lookup on a session's mailbox | control.ts `findMailboxByCorrelationId(id, correlation_id)` | Per-root scoped via slotFor; returns undefined when slot/mailbox missing. |
| `wait_for_reply(correlation_id, timeout_ms)` tool | agent-wait.ts `AgentWaitForReplyTool` | Second tool ID in same file; reuses PermissionKey 'task'. Fast-path on already-queued match; races mailbox-seq watch vs timeout otherwise; matched message stays in mailbox for turn-boundary drain (idempotent). |
| `wait_agent` mandatory-timeout warning | agent-wait.ts execute body | `metadata.warning = "missing_timeout" | "timeout_clamped"`. Call still completes; warning is informational. |
| Mandatory-timeout doctrine prose | multi-agent-root.txt §Wait timeouts | Mentions wait_for_reply for ask pattern; explains warning semantics. Mirror sentence in multi-agent-subagent.txt §Cross-agent messaging. |

### Recommendations for Phase 2B (Wave 4)

1. **ABORT recognition surface.** Wave 4's D11 adds ABORT(reason) recognition in control.ts. The structured `metadata.warning` shape T3 landed (string tag like "missing_timeout") is a good precedent for ABORT's structured payload shape (`metadata.abort_reason = "spec_wrong"` etc.). Wave 4 should follow the same pattern for INV-D-12 (`abort-reason-delivered-as-structured-payload`).
2. **D6 (root-hold for in-flight mail) — still open.** Wave 0 deferred D6 per WAVE.md §6 allowance. Phase 2A's correlation_id + wait_for_reply do NOT obviate D6: the race is between completion notification and a pending parent send, which correlation_id can't pair (no upstream request to correlate against). Consider re-evaluating D6 once Phase 2B/3A lands — ABORT and supervision may surface the same race differently.
3. **Evaluator contract slice commit strategy.** As noted in drift section, evaluator's contracts/T<N>.json slices get swept into the NEXT generator's commit. Consider in Wave 4 having the orchestrator atomically stage + commit each task's slice immediately after the evaluator's grade, before dispatching the next task. Reduces commit-noise and makes the per-task audit trail cleaner.
4. **Contract recipe authoring discipline.** T3 C6 was authored as a brittle literal-count grep that conflicted with the existing module-local-variable convention. Future recipes for "tool wiring complete" should either (a) check structural correctness via a more targeted regex (e.g. `^(?:.*const|.*: Tool\.init\(|.*tool\.)<id>$`), or (b) defer to the downstream `bun test` + `bun typecheck` passes which functionally verify the same property. Add to RUBRIC_GUIDE.md authoring rules: "for wiring criteria, prefer functional verification (compile + test) over literal-grep count thresholds."

### Commit shas (Wave 3)

- 0facbc871 — T1: add correlation_id to InterAgentCommunication schema (additive)
- fe856de8d — T2: add correlation_id to send_message + followup_task tools (pass-through)
- c6b1f563a — T3: wait_for_reply variant + wait_agent timeout warning (D10)
- 53dc82de0 — T4: mandatory-timeout doctrine + INV-D-09..11 invariants (Phase 2A)
- 39ffe0e2f — wave 3 settle: aggregate CONTRACT.json + orchestrator inline coverage hardening (mailbox.peek + findMailboxByCorrelationId + wait_for_reply orphan tests) + STATE.md → wave 4 pending + NOTES.md

### Findings / lessons (feed into future waves)

1. **Pre-agreed contracts continue to be effective.** All 4 T1..T4 tasks dispatched without negotiation phase; gen+eval each completed in one round. Total wall time per task ~3-8 minutes. Validation-mechanical work benefits from pre-agreement (Wave 2 lesson #2 reconfirmed).
2. **Generator delivery contract held with one tweak.** Generators each emit `WAVE TASK DONE` before close (per delivery contract) and self-close in next turn. No safety-net warnings fired this wave — D5 didn't have to catch anything.
3. **Evaluators correctly escalated borderline failures rather than approving silently.** T3 evaluator caught C6's failure and forwarded to orchestrator for adjudication, exactly the harshness the talk's principle calls for. Refusing to silently waive a strict-recipe failure is good evaluator discipline.
4. **Orchestrator inline coverage hardening is now a recognized pattern.** Wave 2 used it for D5b production fix. Wave 3 uses it for test-coverage gap closure. Both are "small, in-spirit, single-commit" adjustments. The bar holds: only structural gaps escalate to PLAN UNDOABLE.

---
