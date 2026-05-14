# Agent Entry Point — Wave Executor

You are executing a wave for the `replace-bash-task-2026-05-15` campaign. Read this entire file first; no skipping.

## Start Here

1. Read `STATE.md` (one level up: `.wave/campaigns/replace-bash-task-2026-05-15/STATE.md`).
2. If `wave_status: all_complete` → print `WAVES DONE` and stop.
3. If `wave_status: awaiting_user` AND `user_question` is non-empty AND this is the FIRST turn of your session → defensive bail. The previous session of this wave is paused awaiting user input; you should not have been spawned. Print `UNEXPECTED RESPAWN: campaign is awaiting user; previous session must resolve first.` and stop. (If this is a resume turn — i.e. there is a recent user message in your context — see "Handling user replies" below; do not bail.)
4. Check for `waves/wave_<current_wave>/NOTES.md`. If it exists, this is a retry. Read it in full (every prior attempt section). At the top of your new attempt section in NOTES.md (later in this protocol), record your decision:
   - **reset** — `git revert --no-commit <sha>` for each prior failure commit of this wave (find them via `git log --oneline | grep "wave <N> ("`), commit nothing yet, restart the wave from the WAVE.md spec.
   - **continue** — leave the working tree as-is from the prior attempt, build on top.
   Choose based on whether the prior partial work is salvageable.
5. Read `OVERVIEW.md` in full.
6. **Read `GOTCHAS.md` at the repo root** — the indexes at the top (`Read GOTCHAS.md limit=200`) tell you which slugs apply to your wave's surfaces. Don't relearn anything that's already an entry. Load specific entries via `Read GOTCHAS.md offset=<L> limit=30` per the file's index.
7. Read every cross-cutting reference doc your wave needs (named in WAVE.md's header). At minimum: `STYLE.md`, `TDD.md`, `PERF.md`. The wave names the rest.
8. Read `waves/wave_<current_wave>/WAVE.md` in full.
9. Read every other reference doc the WAVE.md tells you to read.
10. Execute every task in the wave. Use parallel sub-agents per the dispatch protocol below.
11. **If you discovered a sharp edge (>15 min to figure out, non-obvious quirk, perf landmine, BC trap), append it to the repo-root `GOTCHAS.md`** before committing. Follow the file's existing format.
12. Run verification per the protocol below.
13. Decide outcome and emit one of the four set phrases (see "Failure handling"). Always commit before stopping.

## Hard rules

These apply to every wave. Violating any of them fails the wave.

- **TDD is non-negotiable.** Tests first → run red → implement → run green → typecheck → lint → perf bench (when applicable) → commit. Implementation before tests = wave failure; revert and restart.
- **100% line coverage on every file added or modified in this campaign.** Verify with single-file `bun test --coverage <path>` per the `bun-coverage-aggregation-flake` GOTCHA. Multi-file aggregation drops hit counts; the source of truth is the single-file run.
- **Integration-first.** Every wave that touches a code surface listed in `INTEGRATION_INVARIANTS.md` MUST add at least one `it.instance` test against the relevant invariant. Test name = invariant slug. Test MUST run RED against the pre-fix code and GREEN against the post-fix code; if it passes against the broken code, the test is checking the wrong thing — rewrite it.
- **Differential testing where applicable.** When a wave refactors or replaces a code path, run the OLD and NEW paths against the SAME inputs from `FIXTURES.md` and assert byte-identical (or surgically-explained) outputs. Wave 1 (scanner extract), Wave 2 (exec_command wire), Wave 3 (spawn_agent wire), Wave 5 (prose migrate) all carry differential tests as primary verification.
- **No mocks except where TDD.md authorizes.** Real services. The only exceptions: `stubProvider` for runLoop tests, time mocks for clamp/timeout behavior. If you reach for a mock, your test is testing the mock; use the real service.
- **No perf regressions.** Every wave that touches a hot path runs its bench against the campaign's frozen baseline (`artifacts/baseline-perf.json`, established in Wave 0). Budget: 5/10/15 % on p50/p95/p99. Exceeding fails the wave unless surfaced as USER QUESTION with the regression details.
- **Backward compat is the campaign's headline.** Every saved permission rule shape in `BACKWARD_COMPAT.md` and every fixture in `FIXTURES.md` MUST stay green. A wave that breaks a single fixture is failed. No "the user can re-approve" — the whole point is they don't have to.
- **Effect v4 conventions.** `Effect.gen`, `Effect.fn(...)`, no `Effect.fork` (use `forkIn`), `InstanceState` for per-directory, `makeRuntime` for service runtimes. See `STYLE.md` and the repo-root `AGENTS.md`.
- **Module shape.** Flat exports + self-reexport (`export * as Foo from "./foo"`). No barrel `index.ts` in multi-sibling directories. See `packages/opencode/AGENTS.md` § "Module shape".
- **Idiomatic code only.** This codebase is hand-tuned (TUI render budget, Effect v4 services, InstanceState scoping, opentui flex-row antipatterns). Code that ignores these conventions or that an experienced reviewer would flag as amateur fails the wave. If unsure, mirror the surrounding file's pattern.
- **Tool descriptions are prompts, not labels.** Codex-quality, codemaxxxing voice. Operational manual: when, when-not, failure modes, cost. Junior-tier prose ("This tool runs commands. Use it when needed.") fails the wave.
- **Working tree is clean between waves.** Commit on every outcome (success, failure, undoable, paused). Failure commits are local audit trail.
- **Codex source is read-only reference.** Path: `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/`. Reference, never modify.

## Dispatch protocol

Some waves have independent tasks that can run in parallel sub-agents. WAVE.md says when. When parallelism is allowed:

- Send sub-agent dispatches in a SINGLE message (multiple Task tool calls in one block).
- Each sub-agent prompt MUST include:
  - The exact section of WAVE.md describing their task (paste it verbatim).
  - The full list of reference docs they must read (absolute paths).
  - The TDD rule for their task (tests first; commands to run).
  - The constraint: sub-agents MUST NOT run global verification (`bun typecheck`, `bun lint`, full test suite) themselves UNLESS the WAVE.md task explicitly says so.
- Sub-agents have ZERO context from your reading. Be explicit. Paste, don't summarize.
- After all sub-agents complete, YOU run global verification and resolve outcome.

## Verification protocol

Each wave's WAVE.md has a `Verification` section with the exact commands. The standard set:

```bash
cd packages/opencode
bun typecheck
bun lint
bun test <wave-test-files>
bun test --coverage <each-touched-file>     # 100% line coverage assertion
bun test ./test/integration/tool-surface-replacement.test.ts   # invariants green
bun test ./test/perf/<wave>.bench.ts        # within budget (when applicable)
```

All must exit 0. The perf bench compares against `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json` (created in Wave 0). If you see a budget failure, the wave fails.

For tests: per the `do-not-run-tests-from-root` GOTCHA, run from package directories, never from repo root. For benches: per `bun-test-bench-file-path` use the `./` prefix.

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
- If nothing changed in the working tree (e.g. PLAN UNDOABLE detected before any sub-agent ran), skip `git add` and commit. STATE.md / NOTES.md edits in `.wave/` should themselves be staged and committed.

## NOTES.md protocol

Location: `waves/wave_<current_wave>/NOTES.md`. Append-only across attempts. Each attempt adds a new section.

Required for every NON-success outcome (failed / undoable / user_question). Optional but recommended for success when something non-obvious happened.

Format for each attempt section:

```markdown
## Attempt <N> — <outcome>

**Session:** <session_id>
**Commit:** <short SHA>
**Date:** <YYYY-MM-DD>
**Decision on entry:** <reset | continue | first attempt>

### What happened
<narrative>

### What failed
<exact commands, exit codes, error output>

### Diagnosis
<root cause: transient vs spec issue vs your own bug>

### Tried in-session
<fix attempts you made before giving up>

### Recommendation
<for the next attempt, the verifier, or the user>

---
```

If outcome is success and a prior attempt failed, append a brief success section noting what changed since the last attempt.

## State update protocol

Edit `.wave/campaigns/replace-bash-task-2026-05-15/STATE.md` after every wave turn.

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

After PLAN UNDOABLE (the spec itself is wrong, no number of retries will help):

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

- **reset** — find each prior failure commit for this wave: `git log --oneline | grep -E "wave <N> \\("`. Revert each in reverse chronological order: `git revert --no-commit <sha>`. Stage nothing yet — these reverts will be folded into your eventual outcome commit. Then proceed with the wave from scratch.
- **continue** — do nothing special. The working tree already has the partial work from the prior attempt.

If `retry_count` is 0 in STATE.md (first attempt), there is no NOTES.md and no prior commits — proceed normally.

## Failure handling

Decide your outcome HONESTLY. Do not pretend a wave succeeded.

- **WAVE COMPLETE** — verification passed (typecheck + lint + per-file 100% coverage + integration invariant tests green + perf within budget where applicable + GOTCHAS updated if you found one), you committed, you updated STATE.md per "After a SUCCESSFUL wave". Print `WAVE COMPLETE` as the last line. Stop.
- **WAVE FAILED** — your own bug, retryable. You tried to fix in-session and couldn't. The spec is fine; a fresh session might do better. Write NOTES.md, commit (`wave N (failed): ...`), update STATE.md per "After a TRANSIENT FAILURE". Print `WAVE FAILED` as the last line. Stop.
- **PLAN UNDOABLE** — the spec is wrong. Examples: a verification command is impossible to satisfy as written, an INTEGRATION_INVARIANT contradicts itself, a gotcha is hallucinated, a fixture asserts something that turned out to be wrong. Write NOTES.md with specifics on WHAT in the spec is wrong, commit (`wave N (undoable): ...`), update STATE.md. Print `PLAN UNDOABLE` as the last line. Stop.
- **USER QUESTION** — you need user judgment. Pauses YOUR session, not ends it. Write NOTES.md with what you tried and what you need answered. Then write the FULL question in your chat output (preceding the set phrase): the context that led to it, what you've already tried, the 2-3 concrete options the user can choose from, and any constraints. Commit (`wave N (paused): user question`). Update STATE.md per "After USER QUESTION" (the `user_question` field gets the SHORT one-line summary used by the dashboard). Print `USER QUESTION: <one-line summary>` as the last line. Stop your turn.

The four set phrases are pattern-matched by the loop. Print exactly one as your final line. No prose after.

## Handling user replies

When you previously emitted `USER QUESTION` and stopped, your session paused. The user has now replied — you are resuming the SAME session. Read the user's reply at the top of your incoming context.

1. Parse the user's answer.
2. Take action: execute the implied work, do what they asked differently, or re-emit USER QUESTION if you need clarification.
3. Update STATE.md: clear `user_question: ""`, set `wave_status` to truth (`pending` if resolved and the wave can advance; `running` if you'll keep working in this turn; `awaiting_user` again if you have another question). Update wave row Notes to reflect the resolution.
4. Append a new attempt section to NOTES.md if appropriate.
5. Commit if you modified anything: `wave N: resumed after user reply (<short summary>)` for in-progress, or the standard outcome commit format if finishing.
6. Emit the appropriate set phrase as the last line.

## The bar

Two campaigns and 22 waves shipped 100% line coverage and still introduced two structural bugs because the tests asserted primitives, not scenarios. Recent post-campaign work caught three more bugs in the model-visible output, subagent body delivery, and fiber revival paths — all integration-shaped, none caught by unit tests.

The bar for this campaign:

1. Every change ships with at least one integration test that walks the failure scenario the change exists to prevent.
2. Every refactor ships with a differential test that proves the OLD and NEW paths produce identical observable behavior on the fixture corpus.
3. Every saved-permission shape in `FIXTURES.md` stays green from Wave 0 to Wave 6.
4. No "shitty unidiomatic regression-causing amateur-tier code" — match the codebase's existing patterns, or your code does not land.

If a wave passes coverage and perf but adds no integration test for the surface it touched, the wave is incomplete. Coverage is necessary; it is not sufficient. The whole point of the campaign is to make the missing tests exist alongside the surface change.
