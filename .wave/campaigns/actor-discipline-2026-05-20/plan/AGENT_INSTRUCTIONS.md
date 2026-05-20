# Agent Entry Point — Wave Executor

You are executing a wave for the `actor-discipline-2026-05-20` campaign. Read this entire file first; no skipping.

## Start Here

1. Read `STATE.md` (one level up: `.wave/campaigns/actor-discipline-2026-05-20/STATE.md`).
2. If `wave_status: all_complete` → print `WAVES DONE` and stop.
3. If `wave_status: awaiting_user` AND `user_question` is non-empty AND this is the FIRST turn of your session → defensive bail. The previous session of this wave is paused awaiting user input; you should not have been spawned. Print `UNEXPECTED RESPAWN: campaign is awaiting user; previous session must resolve first.` and stop. (If this is a resume turn — recent user message in your context — see "Handling user replies" below; do not bail.)
4. Check for `waves/wave_<current_wave>/NOTES.md`. If it exists, this is a retry. Read it in full. At the top of your new attempt section in NOTES.md (per the NOTES.md protocol below), record your decision:
   - **reset** — `git revert --no-commit <sha>` for each prior failure commit of this wave (find them via `git log --oneline | grep "wave <N> ("`), commit nothing yet, restart the wave from the WAVE.md spec.
   - **continue** — leave the working tree as-is from the prior attempt, build on top.
   Choose based on whether the prior partial work is salvageable.
5. Read `OVERVIEW.md` in full.
6. Read `ORCHESTRATOR_PROTOCOL.md` in full unless your wave is marked `executor-solo` in STATE.md (Waves 0 and 9 are solo). Orchestrated waves spawn subagents per this protocol.
7. Read `ANTHROPIC_HARNESS_LEARNINGS.md` once per campaign — the principles informing the orchestrator pattern. Re-read only if your wave introduces a new orchestration shape.
8. **Read `GOTCHAS.md` at the repo root** — the indexes at the top (`Read GOTCHAS.md limit=200`) tell you which slugs apply to your wave's surfaces. Don't relearn anything that's already an entry. Load specific entries via `Read GOTCHAS.md offset=<L> limit=30` per the file's index.
9. Read every cross-cutting reference doc your wave needs (named in WAVE.md's header). At minimum: `INTEGRATION_INVARIANTS.md`, `PROMPT_SURFACES.md`, `REFERENCES.md`. The wave names the rest.
10. Read `waves/wave_<current_wave>/WAVE.md` in full.
11. Read every other reference doc the WAVE.md tells you to read.
12. Execute the wave. Orchestrated waves dispatch via ORCHESTRATOR_PROTOCOL.md. Solo waves do the work directly.
13. **If you discovered a sharp edge (>15 min to figure out, non-obvious quirk, perf landmine, BC trap), append it to the repo-root `GOTCHAS.md`** before committing. Follow the file's existing format.
14. Run verification per the protocol below.
15. Decide outcome and emit one of the four set phrases (see "Failure handling"). Always commit before stopping.

## Hard rules

These apply to every wave. Violating any of them fails the wave.

- **Subagent delivery contract is law.** Subagents you spawn MUST deliver via `send_message` or `followup_task` to you. Your text-extraction safety net catches violations, but the contract is the primary mechanism. (D1 — Wave 1 lands the prose; Wave 0 lands the safety net.)
- **Canonical paths everywhere.** Your subagents know their `/root/<task_name>` path because Wave 0 injects it. When you `close_agent`, use the canonical path or omit `target` for self-close. Never address a subagent by its `agent_type` value. (D2/D3.)
- **TDD for code waves.** Tests first → run red → implement → run green → typecheck → lint → commit. Implementation before tests = wave failure; revert and restart. Prose waves are exempt; their "test" is the integration invariant that the prose enables.
- **100% line coverage on every file added or modified.** Verify with single-file `bun test --coverage <path>` per the `bun-coverage-aggregation-flake` GOTCHA. Multi-file aggregation drops hit counts; the source of truth is the single-file run.
- **Integration-first.** Every wave that touches a code surface listed in `INTEGRATION_INVARIANTS.md` MUST add at least one `it.instance` test in `packages/opencode/test/integration/multi-agent-invariants.test.ts` against the relevant invariant. Test name = invariant slug. Test MUST run RED against pre-fix code and GREEN against post-fix code; if it passes against the broken code, the test is checking the wrong thing — rewrite it.
- **No mocks for the surfaces under test.** Real `AgentControl`, real mailbox, real `Session`. Stub provider for runLoop only (see `multi-agent-invariants.test.ts` for the pattern). If you reach for a mock of the multi-agent surface, your test is testing the mock; use the real service.
- **Effect v4 conventions.** `Effect.gen`, `Effect.fn(...)`, no `Effect.fork` (use `forkIn`), `InstanceState` for per-directory, per-root slots for AgentControl (Iteration 8 hardening invariant — see `agentcontrol-providerref-must-live-in-layer-not-instancestate` GOTCHA). See repo-root `AGENTS.md` and `packages/opencode/AGENTS.md`.
- **Module shape.** Flat exports + self-reexport (`export * as Foo from "./foo"`). No barrel `index.ts` in multi-sibling directories.
- **Idiomatic code only.** Hand-tuned codebase. Code that ignores conventions or that an experienced reviewer would flag as amateur fails the wave. Mirror the surrounding file's pattern.
- **Tool descriptions are prompts, not labels.** Codex-quality, codemaxxxing voice. Operational manual: when, when-not, failure modes, cost.
- **Working tree clean between waves.** Commit on every outcome (success, failure, undoable, paused). Failure commits are local audit trail.
- **Run tests from package dirs, never repo root.** The repo-root `package.json` `"test"` script intentionally errors with "do not run tests from root"; see repo-root `AGENTS.md`. Use `cd packages/opencode && bun test ...`.
- **Per-root AgentControl scoping is law.** Any new AgentControl method must accept the caller's session id and resolve the caller's root. Do NOT add operations that walk every root. See `multi-root-isolation` invariant.

## Dispatch protocol (orchestrated waves)

Orchestrated waves spawn a planner subagent first, then for each task the planner enumerates, a generator + evaluator pair. Full mechanics in `ORCHESTRATOR_PROTOCOL.md`. Summary of the dispatch contract:

- Use `spawn_agent` with `agent_type: "general"` for all three roles (planner, generator, evaluator). Role differentiation is in the spawn `message` body, not in `agent_type`.
- Each spawn message MUST include: role identifier (`PLANNER` / `GENERATOR <task-id>` / `EVALUATOR <task-id>`), the exact section of WAVE.md describing the work (paste verbatim), the full list of reference docs the subagent must read (absolute paths), the delivery contract reminder ("send_message to me when done; ABORT(reason) if stuck"), the rubric criteria if evaluator.
- Subagents have ZERO context from your reading. Be explicit. Paste, don't summarize.
- Generator and evaluator coordinate via `send_message` (FYI: criterion ready, criterion graded) and `followup_task` (action: re-grade, fix-and-retry). Both reach you via `send_message` on terminal events (CONTRACT AGREED, WAVE PASS, ABORT).
- After all subagents settle, YOU run global verification (typecheck, lint, integration invariants) and resolve outcome.

## Verification protocol

Each wave's WAVE.md has a `Verification` section with the exact commands. The standard set:

```bash
cd packages/opencode
bun typecheck
bun lint
bun test <wave-test-files>
# Per-file 100% line coverage assertion. PASS THE TEST FILE PATH, NOT THE SOURCE PATH.
# Passing a source file (e.g. `src/agent/control.ts`) runs ZERO tests and exits 0 —
# silent false-pass. See GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`.
# Correct form: `bun test --coverage src/agent/control.test.ts` (test file path) or
# `bun test --coverage control.test` (substring; matches every `*control.test*`).
bun test --coverage <test-file-path-or-substring>
bun test ./test/integration/multi-agent-invariants.test.ts   # invariants green
```

All must exit 0. Tests must run from `packages/opencode/` — the repo-root `package.json` `"test"` script intentionally errors with "do not run tests from root" (see repo-root `AGENTS.md`). For benches: per the `bun-test-bench-file-path` GOTCHA use the `./` prefix.

For waves that touch prompt files only (Wave 1), verification is: integration invariants green, and the `behavioural-prose-snapshot` differential test (Wave 1 adds it) shows the prose change matches the expected delta.

## Commit protocol

You commit on EVERY outcome. The working tree is always clean between sessions.

- Stage: `git add -A`.
- Commit message format depends on outcome:
  - Success → `wave N: <short description>`
  - Transient failure → `wave N (failed): <one-line reason>`
  - Plan undoable → `wave N (undoable): <one-line reason>`
  - User question → `wave N (paused): user question`
- Single line. NEVER `--no-verify`. NEVER force push. NEVER amend. NEVER push.
- After committing, capture the SHA: `git rev-parse --short HEAD`. Write into the wave row's Commit column AND into the NOTES.md attempt section.
- If nothing changed in the working tree (e.g. PLAN UNDOABLE detected before any subagent ran), skip `git add` and commit — STATE.md / NOTES.md edits in `.wave/` should themselves be staged and committed.

## NOTES.md protocol

Location: `waves/wave_<current_wave>/NOTES.md`. Append-only across attempts. Each attempt adds a new section.

Required for every NON-success outcome (failed / undoable / user_question). Optional but recommended for success when something non-obvious happened, OR when orchestration burned a pivot.

Format for each attempt section:

```markdown
## Attempt <N> — <outcome>

**Session:** <session_id>
**Commit:** <short SHA>
**Date:** <YYYY-MM-DD>
**Decision on entry:** <reset | continue | first attempt>
**Orchestration:** <solo | planner+gen+eval | pivot count: K>

### What happened
<narrative>

### What failed
<exact commands, exit codes, error output, ABORT reasons from subagents>

### Diagnosis
<root cause: transient vs spec issue vs your own bug vs subagent contract violation>

### Tried in-session
<fix attempts, including any subagent pivots>

### Recommendation
<for the next attempt, the verifier, or the user>

---
```

If outcome is success and a prior attempt failed, append a brief success section noting what changed since the last attempt AND what (if anything) the pivot taught you.

## State update protocol

Edit `.wave/campaigns/actor-discipline-2026-05-20/STATE.md` after every wave turn.

**`active_session_id` and `active_session_kind` are loop-managed. Never touch them.** The loop sets these when it spawns your session and clears them from its settle handler when your session truly ends. If you write `null` to `active_session_id` while your session is still emitting events, the loop's settle handler sees the mismatch and skips the auto-spawn for the next wave. The campaign appears stuck. **No outcome below changes these fields.**

After a SUCCESSFUL wave:

1. YAML block:
   - `current_wave: <N+1>`
   - `wave_status: pending` (or `all_complete` if N was the final wave)
   - `session_count: <session_count + 1>`
   - `retry_count: 0`
   - `failure_kind: ""`
   - `last_updated: <today YYYY-MM-DD>`
2. Wave row N: `Status: complete`, `Commit: <SHA>`, `Notes: <outcome summary>`.

After a TRANSIENT FAILURE (your own bug, not a spec issue):

1. YAML block:
   - `wave_status: failed`
   - `failure_kind: transient`
   - `retry_count: <retry_count + 1>`
   - `loop_state: idle` only if `retry_count` is now >= 3 (loop will then trigger verifier); otherwise leave loop_state as it was.
   - `last_updated: <today>`
2. Wave row N: `Status: failed`, `Commit: <SHA>`, `Notes: <one-line reason; see NOTES.md>`.

After PLAN UNDOABLE (the spec is wrong, no number of retries will help):

1. YAML block:
   - `wave_status: plan_undoable`
   - `failure_kind: undoable`
   - `loop_state: idle`
   - `last_updated: <today>`
2. Wave row N: `Status: undoable`, `Commit: <SHA>`, `Notes: <one-line reason; see NOTES.md>`.

After USER QUESTION:

1. YAML block:
   - `wave_status: awaiting_user`
   - `user_question: "<one-line summary>"`
   - `last_updated: <today>`
   - DO NOT change `loop_state`. Your session is paused, not ended; preserve loop_state so the user reply resumes the same session without requiring a re-arm.
2. Wave row N: `Status: paused`, `Commit: <SHA>`, `Notes: see user_question`.

## Retry handling on entry

The retry decision (reset vs continue) is recorded in NOTES.md at the top of your attempt section. Recipes:

- **reset** — find each prior failure commit for this wave: `git log --oneline | grep -E "wave <N> \\("`. Revert each in reverse chronological order: `git revert --no-commit <sha>`. Stage nothing yet — these reverts fold into your eventual outcome commit. Then proceed with the wave from scratch.
- **continue** — do nothing special. The working tree already has the partial work from the prior attempt.

If `retry_count` is 0 in STATE.md (first attempt), there is no NOTES.md and no prior commits — proceed normally.

## Failure handling

Decide your outcome HONESTLY. Do not pretend a wave succeeded.

- **WAVE COMPLETE** — verification passed (typecheck + lint + per-file 100% coverage + integration invariants green + orchestrator artefacts complete + GOTCHAS updated if applicable), you committed, you updated STATE.md per "After a SUCCESSFUL wave". Print `WAVE COMPLETE` as the last line. Stop.
- **WAVE FAILED** — your own bug, retryable. You tried to fix in-session and couldn't. The spec is fine; a fresh session might do better. Write NOTES.md, commit (`wave N (failed): ...`), update STATE.md per "After a TRANSIENT FAILURE". Print `WAVE FAILED` as the last line. Stop.
- **PLAN UNDOABLE** — the spec is wrong. Examples: an INTEGRATION_INVARIANT contradicts itself, a referenced line:col no longer exists, a gotcha is hallucinated, an orchestration prescription requires a capability the harness doesn't expose. Write NOTES.md with specifics on WHAT in the spec is wrong, commit (`wave N (undoable): ...`), update STATE.md. Print `PLAN UNDOABLE` as the last line. Stop.
- **USER QUESTION** — you need user judgment. Pauses YOUR session, not ends it. Write NOTES.md with what you tried and what you need answered. Then write the FULL question in your chat output (preceding the set phrase): the context that led to it, what you've already tried, the 2-3 concrete options the user can choose from, and any constraints. Commit (`wave N (paused): user question`). Update STATE.md per "After USER QUESTION" (the `user_question` field gets the SHORT one-line summary used by the dashboard). Print `USER QUESTION: <one-line summary>` as the last line. Stop your turn.

The four set phrases are pattern-matched by the loop. Print exactly one as your final line. No prose after.

## Handling user replies

When you previously emitted `USER QUESTION` and stopped, your session paused. The user has now replied — you are resuming the SAME session. Read the user's reply at the top of your incoming context.

1. Parse the user's answer.
2. Take action: execute the implied work, do what they asked differently, or re-emit USER QUESTION if you need clarification.
3. Update STATE.md: clear `user_question: ""`, set `wave_status` to truth (`pending` if resolved and the wave can advance; `running` if you'll keep working in this turn; `awaiting_user` again if you have another question). Update wave row Notes to reflect the resolution.
4. Append a new attempt section to NOTES.md if appropriate (you are continuing the same attempt — the user's reply is part of it).
5. Commit if you modified anything: `wave N: resumed after user reply (<short summary>)` for in-progress, or the standard outcome commit format if finishing.
6. Emit the appropriate set phrase as the last line.

## The bar

Three campaigns and 22 waves shipped 100% line coverage and still introduced structural bugs because the tests asserted primitives, not scenarios. The diagnostic session `ses_1c2e8d84affeZ7t5g5LKveGDTo` (multi-agent delivery failure) and `ses_1d84f236bffeEWmrmOhp6SoLma` (sibling-deadlock during the "hot dog as sandwich" debate) are the two bugs THIS campaign exists to prevent.

The bar:

1. Every change ships with at least one integration test that walks the failure scenario the change exists to prevent.
2. Every orchestrated wave uses planner + generator + evaluator subagents — the executor itself never grades its own work. Self-evaluation is the trap the Anthropic talk warns against; see `ANTHROPIC_HARNESS_LEARNINGS.md`.
3. Every wave's CONTRACT.json criteria are granular enough to be actionable. Vague criteria → vague critiques → generator shrugs. The talk's "27 contract criteria" is the standard.
4. No "shitty unidiomatic regression-causing amateur-tier code" — match the codebase's existing patterns, or your code does not land.

If a wave passes coverage and lint but adds no integration test for the surface it touched, the wave is incomplete. Coverage is necessary; it is not sufficient. The whole point of the campaign is to make the missing tests exist alongside the surface change.
