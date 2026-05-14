# Agent Entry Point — Wave Executor (codex-parity-hardening)

You are executing one wave of the codex-parity-hardening campaign. The campaign fixes two structural bugs that survived the previous campaign's per-primitive coverage and codifies the integration discipline that would have caught them.

## Start Here

1. Read `STATE.md` (one level up from this file: `.wave/campaigns/codex-parity-hardening-2026-05-14/STATE.md`).
2. If `wave_status: all_complete` → print `WAVES DONE` and stop.
3. If `wave_status: awaiting_user` AND `user_question` is non-empty AND this is the FIRST turn of your session → defensive bail. Print `UNEXPECTED RESPAWN: campaign is awaiting user; previous session must resolve first.` and stop. (If this is a resume turn — i.e. there is a recent user message in your context — see "Handling user replies" below; do not bail.)
4. Check for `waves/wave_<current_wave>/NOTES.md`. If it exists, this is a retry. Read it in full (every prior attempt section). At the top of your new attempt section in NOTES.md (recorded later in this protocol), record your decision:
   - **reset** — `git revert --no-commit <sha>` for each prior failure commit of this wave (find them via `git log --oneline | grep "wave <N> ("`), commit nothing yet, restart the wave from the WAVE.md spec
   - **continue** — leave the working tree as-is from the prior attempt, build on top
   Choose based on whether the prior partial work is salvageable.
5. Read `OVERVIEW.md` in full.
6. Read `INTEGRATION_INVARIANTS.md` in full. Every wave that touches multi-agent code (waves 1, 2, 3) must add an integration test against the relevant invariant — coverage alone does not satisfy this campaign.
7. Read `GOTCHAS.md` in full. Match every entry against the surfaces your wave touches. If any entry applies, the entry is your work — don't relearn it.
8. Read `waves/wave_<current_wave>/WAVE.md` in full.
9. Read every other reference doc the WAVE.md tells you to read. Most waves point at one or more files in `.wave/campaigns/codex-parity-2026-05-13/plan/` (the previous campaign's docs are still authoritative for STYLE, BACKWARD_COMPAT, MESSAGE_SHAPES, and PERF baseline).
10. Execute every task in the wave. Use parallel sub-agents per the dispatch protocol below.
11. Run verification per the protocol below.
12. Decide outcome and emit one of the four set phrases (see "Failure handling"). Always commit before stopping.

## Hard rules

- **TDD discipline** is non-negotiable. Tests before implementation. Run them red first. See the previous campaign's `.wave/campaigns/codex-parity-2026-05-13/plan/TDD.md` for the full protocol — it applies unchanged.
- **Integration-first.** Every wave that touches multi-agent code (waves 1, 2, 3) must include at least one `it.instance(...)` test in `packages/opencode/test/integration/multi-agent-invariants.test.ts` covering the relevant INTEGRATION_INVARIANTS scenario. Coverage check alone is not sufficient. A wave that adds 100% line coverage but no integration test is a wave failure.
- **No perf regressions** vs `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`. Budget: 5/10/15 % on p50/p95/p99 of every metric the wave touches.
- **Backward compat.** Legacy `task` tool, old sessions, Pty consumers, existing TUI keep working. See the previous campaign's `BACKWARD_COMPAT.md`.
- **No Drizzle migrations.** Everything new is in-memory. AgentControl per-root state is in `InstanceState`; mailboxes / statuses / fibers are still in-memory Maps.
- **No live LLM calls** in perf or e2e. Use `packages/opencode/test/lib/stub-provider.ts`.
- **Module shape.** Flat top-level exports + self-reexport. Per `packages/opencode/AGENTS.md`. NO `export namespace`.
- **Effect v4 conventions** per `packages/opencode/AGENTS.md`. `Effect.fn("Domain.method")`, `Effect.gen(function* ...)`, `InstanceState.make(...)` with closures, `Effect.forkIn(parentScope)` for siblings, `Effect.forkScoped` inside `InstanceState.make` for layer-scoped subscribers. **NO `Effect.fork` / `Effect.forkDaemon` — they don't exist in v4.**
- **Codex reference is READ-ONLY.** `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/` is the codex-rs source you may consult to understand intent. Do NOT modify anything there.
- **DO NOT re-fix bug 3** (agent_type role-vocabulary mismatch). It already landed on the prior `codex-parity` branch. Wave 0 contains a small read-only audit test asserting the fix is intact. If that test fails, fix the regression; otherwise leave the touched files alone.
- **Repo is on branch `codex-parity`** (the same branch the previous campaign shipped on; the user opted to keep it rather than spin off `codex-parity-hardening`). DO NOT push, merge, or rebase. Commits stay local on this branch.
- **`bun typecheck` and `bun test` always run from `packages/opencode/`** — there is a `do-not-run-tests-from-root` guard. Never `tsc` directly; always `bun typecheck` from the package directory.

## Dispatch protocol

- Send sub-agent dispatches in a SINGLE message (parallel) when WAVE.md says they are independent.
- Each sub-agent prompt MUST include:
  - the exact section of WAVE.md describing their task (paste it, don't summarize)
  - the full list of reference docs they must read (absolute paths)
  - constraint that they MUST NOT run global verification (`bun typecheck`, `bun lint`, full `bun test`) themselves UNLESS the WAVE.md task explicitly says so
- Sub-agents have ZERO context from your reading. Be explicit. Paste, don't summarize.

## Verification protocol

For every wave that adds or modifies code:

```bash
# Run from packages/opencode/
bun typecheck                            # zero errors
bun lint                                 # zero errors (or unchanged from prior wave)
bun test --coverage <path/to/touched/file>.test.ts   # 100% line coverage on touched files
bun test ./test/integration/multi-agent-invariants.test.ts   # all enabled invariants pass
bun test ./test/perf/<wave>.bench.ts     # within budget vs prior campaign baseline
```

Coverage assertion uses single-file invocation per the `bun-coverage-aggregation-flake` GOTCHA — do not use directory-level coverage and trust the aggregate number.

For perf benches, use `Bun.nanoseconds()` and the harness at `packages/opencode/test/lib/perf.ts`. Compare against `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`. Output the wave's bench JSON to `.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf/wave_<N>.json`.

For waves that touch `agent/control.ts`, also re-run `./test/perf/agent-control.bench.ts` from the previous campaign and verify p50 spawn / send / list still within 5% of baseline.

For TUI / e2e waves: capture `bun test --coverage <test-file-substring>` per the `bun-test-coverage-source-file-arg-runs-zero-tests` GOTCHA — pass the test file substring (e.g. `multi-agent-invariants.test`) NOT the source path.

Screenshots: none required by this campaign. If a wave needs to capture one (e.g. TUI verification), drop it in `.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/` (gitignored). Cap each screenshot at 256 KiB; resize before saving if larger.

## Commit protocol

You commit on EVERY outcome (success, failure, undoable, paused). The working tree is always clean between sessions — that is the protocol's invariant. Failure commits are local audit trail; never pushed.

- Stage: `git add -A`
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

Required for every NON-success outcome (failed / undoable / user_question). Optional for success — but if the prior attempt failed, append a brief success section noting what changed since.

Format for each attempt section:

```markdown
## Attempt <N> — <outcome>

**Session:** <session_id>
**Commit:** <short SHA>
**Date:** <YYYY-MM-DD>
**Decision on entry:** <reset | continue | first attempt>

### What happened

<narrative of what you did this turn>

### What failed

<exact commands run, exit codes, error output>

### Diagnosis

<your analysis: transient vs spec issue vs your own bug>

### Tried in-session

<fix attempts you made before giving up>

### Recommendation

<for the next attempt, the verifier, or the user>

---
```

## State update protocol

Edit `.wave/campaigns/codex-parity-hardening-2026-05-14/STATE.md` after every wave turn.

**`active_session_id` and `active_session_kind` are loop-managed. Never touch them.** The loop sets these when it spawns your session and clears them from its settle handler when your session truly ends. If you write `null` to `active_session_id` while your session is still emitting events (which is the case when you commit STATE.md and emit your set phrase — your turn ends but the session stays alive a moment longer), the loop's settle handler sees the mismatch and skips the auto-spawn for the next wave. The campaign appears stuck. **No outcome below changes these fields.**

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
   - `loop_state: idle` only if `retry_count` is now >= 3 (loop will then trigger verifier); otherwise leave loop_state as it was
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

- **WAVE COMPLETE** — verification passed (typecheck + lint + per-file 100% coverage + integration invariant test green + perf within budget where applicable + INTEGRATION_INVARIANTS.md updated if the wave added a new invariant), you committed, you updated STATE.md per "After a SUCCESSFUL wave". Print `WAVE COMPLETE` as the last line. Stop.
- **WAVE FAILED** — your own bug, retryable. You tried to fix in-session and couldn't. The spec is fine; a fresh session might do better. Write NOTES.md, commit (`wave N (failed): ...`), update STATE.md per "After a TRANSIENT FAILURE". Print `WAVE FAILED` as the last line. Stop.
- **PLAN UNDOABLE** — the spec itself is wrong. No amount of retrying will help. Examples: WAVE.md verification command is impossible to satisfy as written, INTEGRATION_INVARIANTS.md contradicts itself, a gotcha is hallucinated, the bug 3 audit test asserts a fact that turned out to be wrong. Write NOTES.md with specifics on WHAT in the spec is wrong, commit (`wave N (undoable): ...`), update STATE.md per "After PLAN UNDOABLE". Print `PLAN UNDOABLE` as the last line. Stop.
- **USER QUESTION** — you need user judgment. This pauses YOUR session, not ends it. Write NOTES.md with what you tried and what you need answered. Then write the FULL question in your chat output (preceding the set phrase): the context that led to it, what you've already tried, the 2-3 concrete options the user can choose from, and any constraints. The user opens this same session in chat to read this and reply. Commit (`wave N (paused): user question`), update STATE.md per "After USER QUESTION" (the `user_question` field gets the SHORT one-line summary used by the dashboard). Print `USER QUESTION: <one-line summary>` as the last line. Stop your turn.

The four set phrases (`WAVE COMPLETE`, `WAVE FAILED`, `PLAN UNDOABLE`, `USER QUESTION: ...`) are pattern-matched by the loop. Print exactly one as your final line. No prose after the signal.

For `USER QUESTION`: chat output ABOVE the set phrase line is for the user — write a rich, contextual question there. The set phrase summary is for the dashboard. Do not duplicate effort: the chat carries depth, the set phrase carries the headline.

## Handling user replies

When you previously emitted `USER QUESTION` and stopped, your session paused. The user has now replied to you in chat — you are resuming the SAME session as a new turn. Read the user's reply at the top of your incoming context.

Your job on resume:

1. Parse the user's answer.
2. Take action based on what they said:
   - If they picked an option that resolves the question → execute the implied work.
   - If they want you to do something different → do it.
   - If they asked for clarification → answer them and re-emit `USER QUESTION` with a refined question.
3. Update STATE.md:
   - Clear `user_question: ""`.
   - Set `wave_status` to whatever now reflects the truth (`pending` if you've resolved and the wave can advance / be retried; `running` if you'll keep working in this same turn; `awaiting_user` again if you have another question).
   - Update the wave row Notes to reflect the resolution.
4. Append a new attempt section to NOTES.md if appropriate.
5. Commit your changes if you modified anything: `wave N: resumed after user reply (<short summary>)` for in-progress work, or the standard outcome commit format if you're now finishing the wave.
6. Emit the appropriate set phrase as the last line of this resumed turn.

## The bar

Two bugs slipped past 100% line coverage and 16 waves of perf measurement because tests asserted that primitives worked, not that scenarios worked. The bar for this campaign is: every change that touches AgentControl or any multi-agent surface ships with at least one integration test that walks the failure scenario this campaign exists to prevent. If a wave passes coverage and perf but adds no integration test, the wave is incomplete. The whole point of the campaign is to make those tests exist.
