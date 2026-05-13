# Agent Entry Point — Wave Executor

You are executing a wave for the codex-parity campaign. Read the protocol below in full. No skipping.

## Start Here

1. Read `STATE.md` (one level up: `.wave/campaigns/codex-parity-2026-05-13/STATE.md`).
2. If `wave_status: all_complete` → print `WAVES DONE` and stop.
3. If `wave_status: awaiting_user` AND `user_question` is non-empty AND this is the FIRST turn of your session → defensive bail. Print `UNEXPECTED RESPAWN: campaign is awaiting user; previous session must resolve first.` and stop. (If this is a resume turn — recent user message in your context — see "Handling user replies" below; do not bail.)
4. Check for `waves/wave_<current_wave>/NOTES.md`. If it exists, this is a retry. Read it in full. At the top of your new attempt section in NOTES.md (later in this protocol), record your decision:
   - **reset** — `git revert --no-commit <sha>` for each prior failure commit of this wave (find them via `git log --oneline | grep "wave <N> ("`), commit nothing yet, restart the wave from the WAVE.md spec
   - **continue** — leave the working tree as-is from the prior attempt, build on top
   Choose based on whether the prior partial work is salvageable.
5. Read `OVERVIEW.md` in full.
6. **Read `GOTCHAS.md` in full.** Append-only knowledge base of sharp edges discovered by prior waves. If any entry applies to surfaces your wave touches, the entry IS your work — don't relearn it. Most entries link to a primary-source doc; follow those links if your wave directly touches the affected surface.
7. Read every cross-cutting reference doc your wave needs (named in the WAVE.md). At minimum: `STYLE.md`, `TDD.md`. The wave names the rest.
8. Read `waves/wave_<current_wave>/WAVE.md` in full.
9. Read every other reference doc the WAVE.md tells you to read.
10. Execute every task in the wave. Use parallel sub-agents per the dispatch protocol below.
11. **Append any new gotchas you discovered to `GOTCHAS.md` BEFORE finishing the wave.** See the format in that file. Threshold: any sharp edge that took >15 minutes to figure out, any non-obvious framework quirk, any perf landmine, any backward-compat trap. The next executor reads the file on entry; what you record there saves them the same cost. Don't restate; link to the long-form source if there is one.
12. Run verification per the protocol below.
13. Decide outcome and emit one of the four set phrases (see "Failure handling"). Always commit before stopping.

## Hard rules

These apply to every wave. Violating any of them fails the wave.

- **TDD is mandatory.** Tests first. Run them red. Then implement. Then green. Then commit. If you wrote implementation before tests, the wave is failed; revert and restart.
- **100% coverage on added/modified code.** Every wave's verification asserts this. Use `bun test --coverage <files>`.
- **No perf regressions.** Every wave that touches a hot path runs its bench against the Wave 0 baseline. Budget: 5% on p50, 10% on p95, 15% on p99. Exceeding fails the wave.
- **Backward compat.** Existing `task` tool, existing Pty surface, existing TUI sessions all keep working. See `BACKWARD_COMPAT.md`.
- **No new Drizzle migrations in this campaign.** All new state is in-memory (InstanceState). If you think you need a migration, stop and surface a USER QUESTION.
- **Effect v4 conventions.** `Effect.gen`, `Effect.fn(...)`, no `Effect.fork` (use `forkIn`), `InstanceState` for per-directory, `makeRuntime` for service runtimes. Read `STYLE.md`.
- **Module shape.** Flat exports + self-reexport (`export * as Foo from "./foo"`). No barrel `index.ts` in multi-sibling directories.
- **No mocks except where TDD.md authorizes.** Test the real implementation.
- **Tool descriptions are prompts, not labels.** Codex-quality, codemaxxxing voice. See `PROMPT_ENGINEERING.md`. Junior-tier descriptions fail the wave.
- **Codex source is read-only.** Path: `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/`. Reference, never modify.
- **Working tree is clean between waves.** Commit on every outcome (success, failure, undoable, paused). Failure commits are local audit trail.

## Dispatch protocol

Some waves have independent tasks that can run in parallel sub-agents. WAVE.md says when. When parallelism is allowed:

- Send sub-agent dispatches in a SINGLE message (multiple Task tool calls in one block).
- Each sub-agent prompt MUST include:
  - The exact section of WAVE.md describing their task (paste it verbatim)
  - The full list of reference docs they must read (absolute paths)
  - The TDD rule for their task (tests first; commands to run)
  - The constraint: sub-agents MUST NOT run global verification (`bun typecheck`, `bun lint`, full test suite) themselves UNLESS the WAVE.md task explicitly says so
- Sub-agents have ZERO context from your reading. Be explicit. Paste, don't summarize.
- After all sub-agents complete, YOU run the global verification and resolve outcome.

## Verification protocol

Each wave's WAVE.md has a `Verification` section with the exact commands. The standard set:

```bash
cd packages/opencode
bun typecheck
bun lint
bun test <wave-test-files>
bun test <wave-perf-bench-files>
```

All must exit 0. The perf bench compares against `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` (created in Wave 0). The bench harness asserts the regression budget itself; if you see a budget failure, the wave fails.

Coverage check:

```bash
bun test --coverage <wave-touched-files>
# Verify 100% line + branch on the listed files
```

Wave-specific extras (integration tests, e2e tests, snapshot tests) listed in each WAVE.md.

## Commit protocol

You commit on EVERY outcome. The working tree is always clean between sessions.

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

Required for every NON-success outcome (failed / undoable / user_question). Optional for success.

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

<your analysis of root cause: transient vs spec issue vs your own bug>

### Tried in-session

<fix attempts you made before giving up>

### Recommendation

<for the next attempt, the verifier, or the user>

---
```

If outcome is success and a prior attempt failed, still append a brief success section noting what changed since the last attempt.

## State update protocol

Edit `.wave/campaigns/codex-parity-2026-05-13/STATE.md` after every wave turn.

**`active_session_id` is loop-managed. Never touch it.** The loop sets this field when it spawns your session and clears it from its settle handler when your session truly ends. If you write `null` to it while your session is still emitting events (which is the case when you commit STATE.md and emit your set phrase — your turn ends but the session stays alive for a moment longer), the loop's settle handler will see `state.active_session_id !== <your session id>` and skip the auto-spawn for the next wave. The campaign will appear stuck. **No outcome below changes `active_session_id`.**

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

After PLAN UNDOABLE (the spec itself is wrong):

1. YAML block:
   - `wave_status: plan_undoable`
   - `failure_kind: undoable`
   - `loop_state: idle`
   - `last_updated: <today>`
2. Wave row N: `Status: undoable`, `Commit: <SHA>`, `Notes: <one-line reason; see NOTES.md>`.

After USER QUESTION:

1. YAML block:
   - `wave_status: awaiting_user`
   - `user_question: "<one-line summary of the question>"` (full context goes in chat output)
   - `last_updated: <today>`
   - DO NOT change `loop_state`.
2. Wave row N: `Status: paused`, `Commit: <SHA>`, `Notes: see user_question`.

## Retry handling on entry

The retry decision (reset vs continue) is recorded in NOTES.md at the top of your attempt section.

- **reset** — find each prior failure commit for this wave: `git log --oneline | grep -E "wave <N> \\("`. Revert each in reverse chronological order: `git revert --no-commit <sha>`. Stage nothing yet — these reverts will be folded into your eventual outcome commit. Then proceed with the wave from scratch.
- **continue** — do nothing special. The working tree already has the partial work from the prior attempt.

If `retry_count` is 0 in STATE.md (first attempt), there is no NOTES.md and no prior commits — proceed normally.

## Failure handling

Decide your outcome HONESTLY. Do not pretend a wave succeeded.

- **WAVE COMPLETE** — verification passed, you committed, you updated STATE.md per "After a SUCCESSFUL wave". Print `WAVE COMPLETE` as the last line. Stop.
- **WAVE FAILED** — your own bug, retryable. You tried to fix in-session and couldn't. The spec is fine; a fresh session might do better. Write NOTES.md, commit (`wave N (failed): ...`), update STATE.md. Print `WAVE FAILED` as the last line. Stop.
- **PLAN UNDOABLE** — the spec is wrong. No retry will help. Write NOTES.md with specifics, commit (`wave N (undoable): ...`), update STATE.md. Print `PLAN UNDOABLE` as the last line. Stop.
- **USER QUESTION** — you need user judgment. Write NOTES.md with what you tried and what you need. Then write the FULL question in chat output (above the set phrase): context, what you tried, the 2-3 concrete options, constraints. The user opens this same session in chat to read this and reply. Commit (`wave N (paused): user question`), update STATE.md. Print `USER QUESTION: <one-line summary>` as the last line. Stop.

The four set phrases (`WAVE COMPLETE`, `WAVE FAILED`, `PLAN UNDOABLE`, `USER QUESTION: ...`) are pattern-matched by the loop. Print exactly one as your final line. No prose after the signal.

For `USER QUESTION`: chat output above the set phrase line is for the user — write a rich, contextual question. The set phrase summary is for the dashboard. Don't duplicate effort.

## Handling user replies

When you previously emitted `USER QUESTION` and stopped, your session paused. The user has now replied to you in chat — you are resuming the SAME session as a new turn. Read the user's reply at the top of your incoming context.

Your job on resume:

1. Parse the user's answer.
2. Take action: execute the implied work; do something different; or ask for clarification.
3. Update STATE.md:
   - Clear `user_question: ""`.
   - Set `wave_status` to whatever now reflects the truth (`pending` if resolved and the wave can advance; `running` if continuing; `awaiting_user` if you have another question).
   - Update the wave row Notes.
4. Append a new attempt section to NOTES.md if appropriate.
5. Commit changes if you modified anything: `wave N: resumed after user reply (<short summary>)` for in-progress work, or the standard outcome commit format if you're now finishing.
6. Emit the appropriate set phrase as the last line:
   - Wave done → `WAVE COMPLETE`
   - Transient failure → `WAVE FAILED`
   - Spec broken → `PLAN UNDOABLE`
   - Need more user input → `USER QUESTION: <new summary>`

## How to read WAVE.md

WAVE.md is **scope + constraints + verification**, not a recipe. Some waves (especially the earlier ones — wave_0 through wave_7) include suggested code shapes and API sketches inline; treat those as one valid path, not the only one. You are as capable of designing the code as the planner. If a different shape is cleaner and meets the same constraints (TDD, coverage, perf, backward compat, code quality), do it that way and document the reasoning briefly in the commit message.

The non-negotiables are the **constraints** (TDD, 100% coverage, no perf regressions, backward compat, no new migrations, no live LLM in perf), the **verification commands** (which tests must pass and which budgets must be met), and the **references** (which codex source files define the semantics you're matching). Everything else — file shapes, internal API surfaces, helper extraction, naming choices within house style — is yours.

## The bar

This campaign produces code that ships permanently in codemaxxxing. The fork diverges meaningfully from upstream after this lands. That means:

- Code quality: every line is reviewable. No dead code, no commented-out blocks, no debug prints. Effect-idiomatic. Names that read as what they are.
- Test quality: tests verify observable behavior, not implementation details. They survive refactors. They cover edge cases the spec describes — empty inputs, max inputs, concurrency, cancellation, failure modes.
- Perf: hot paths measured before and after. No regressions outside budget. Concurrent siblings don't blow up the TUI render path.
- Prompts: the model-facing tool descriptions teach the model how to use these tools — when to spawn, when not to delegate, how to scope, how to coordinate. Junior tone here breaks product quality even if the code works.
- Backward compat: existing users open codemaxxxing after these waves land and notice no breakage. Old sessions load. The `task` tool works. The TUI feels unchanged for non-multi-agent sessions.

If a wave's verification passes but you know the work isn't actually at this bar — say so via NOTES.md and `WAVE FAILED`. Padding the wave count by shipping junior code defeats the campaign.
