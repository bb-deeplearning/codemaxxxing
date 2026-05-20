# Wave 1 — Prose: delivery contract + sibling patterns (orchestrated)

<!--
Previous waves: Wave 0 (bootstrap; D2/D3/D5/D6/D9 code changes landed).
Orchestration: FULL — planner + per-task generator + evaluator subagents.
This is the first orchestrated wave. Adopts ORCHESTRATOR_PROTOCOL.md end-to-end.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md (REQUIRED — your operational runbook)
- ../../ANTHROPIC_HARNESS_LEARNINGS.md (REQUIRED on first orchestrated wave)
- ../../PROMPT_SURFACES.md (ownership map for the five prompt files)
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-06, INV-D-08)
- ../../RUBRIC_GUIDE.md (your planner subagent reads this)
- ../../REFERENCES.md
- repo-root GOTCHAS.md (indexes first)
- packages/opencode/test/AGENTS.md (testEffect / it.instance patterns; your evaluator runs these tests)
-->

## Goal

Update the five subagent prose surfaces to state the delivery contract literally, add the sibling-coordination + limits sections, and adapt for Opus 4.7 literalism. After this wave, every subagent spawned anywhere in the codebase reads prompts that explicitly state the contract.

This is the first wave that orchestrates per ORCHESTRATOR_PROTOCOL.md. Use planner + generator + evaluator subagents. The executor (you) is the supervisor — never grade prose changes directly.

Deliverables:

1. **D1 delivery contract** in `multi-agent-subagent.txt` — rewrite "Final answer" section (current lines 35-37) into "Delivery contract" with literal tool-call sequence. Bake in canonical-path reminder pointing at the per-spawn injection from D2.
2. **D7 sibling coordination** in `multi-agent-root.txt` — add full "Sibling coordination" section with unicast doctrine + three working patterns (CC / coordinator / followup_task) + anti-pattern (wait-on-routed-elsewhere). Mirror one sentence into `multi-agent-subagent.txt`.
3. **D8 limits-of-actor-model** in `multi-agent-root.txt` — add "Limits" section enumerating no-broadcast / no-sibling-introspection / no-deadlock-detection / idle-not-alive.
4. **D4 defer-edits** in three base prompts:
   - `general/anthropic.txt` lines 1 and 46-53.
   - `general/gemini.txt` (same shape).
   - `explore.txt` lines 1 and 47-56.
   Replace implicit "text is deliverable" framing with explicit pointers to the capability-hint delivery contract. Preserve caveman output rules + absolute-paths + code-references rules.
5. **Forbidden-prose / required-phrases test harness** — new file `packages/opencode/test/prose/subagent-prompts.test.ts`. Grep-asserts the rules in PROMPT_SURFACES.md (forbidden phrases absent; required-phrase present in every file).

Integration invariants to land green:
- INV-D-06: `send-message-is-unicast-not-broadcast` (requires the sibling-coordination prose so the test can assert the doctrine is documented; the runtime behavior was always unicast, this just locks it in via a regression-resistant test)
- INV-D-08: `coordinator-fan-out-delivers-single-consolidated-message` (locks in Demo 1 success pattern)

## Tasks (orchestrated)

Spawn planner first. Planner outputs PLAN.json with 4-6 tasks. Recommended task shape:

- T1: `multi-agent-subagent.txt` rewrite (D1 + D7 mirror sentence + D4-style framing) — generator+evaluator pair
- T2: `multi-agent-root.txt` extensions (D7 sibling-coord + D8 limits) — generator+evaluator pair
- T3: `general/anthropic.txt` + `general/gemini.txt` defer-edits (D4) — single generator+evaluator pair (the two files have parallel content)
- T4: `explore.txt` defer-edits (D4) — generator+evaluator pair
- T5: `test/prose/subagent-prompts.test.ts` — generator+evaluator pair
- T6: INV-D-06 + INV-D-08 in `test/integration/multi-agent-invariants.test.ts` — generator+evaluator pair

Planner may consolidate or split per its judgment. Constraint: disjoint write sets per task (no two tasks `writes` the same file).

For each task, the orchestrator (you):

1. Spawn the planner subagent at the wave start. Wait for `PLAN READY`. Read PLAN.json.
2. Spawn generator + evaluator pair per task (sequentially is fine — running 6 pairs in parallel risks pool exhaustion; 2-3 in parallel is the sweet spot per the depth cap and 64-process pool).
3. Pair negotiates contract → builds → grades.
4. On `WAVE TASK GREEN` for all tasks → settle (run wave-level verification yourself).

### Reading the rubric

RUBRIC.json may not exist yet for this wave (depends on whether wave_plan drafted one during decomposition). Your planner subagent's first task is:

- If `waves/wave_1/RUBRIC.json` exists, read it.
- If not, inline a `rubric_seed` field in PLAN.json based on RUBRIC_GUIDE.md's "Example: Wave 1 (prose) rubric sketch" section.

The evaluator subagent for each task uses RUBRIC.json (or PLAN.json's rubric_seed) to instantiate CONTRACT.json criteria.

### Spawn message template — planner subagent for Wave 1

(Copy this verbatim into your `spawn_agent` call's `message` field; substitute placeholders.)

```
ROLE: PLANNER for Wave 1

YOUR CANONICAL PATH: /root/wave_1_planner

PEER PATHS:
- Spawner (me, orchestrator): /root

DELIVERY CONTRACT:
You MUST deliver your result via send_message(target: "/root", message: <body>)
before close_agent. After delivering, in a SEPARATE next step, call close_agent
(omit target → closes you). Do not pile text + close_agent in one turn.

WAVE.md CONTENT (paste verbatim):
[paste the full Wave 1 WAVE.md content from .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/WAVE.md]

REFERENCE DOCS YOU MUST READ:
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/PROMPT_SURFACES.md
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/RUBRIC_GUIDE.md
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/INTEGRATION_INVARIANTS.md
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/OVERVIEW.md

YOUR TASK:
Read WAVE.md fully (already pasted above). Read the four reference docs.
Output: write /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/PLAN.json per the shape in ORCHESTRATOR_PROTOCOL.md § "Planner".

Constraints:
- 4-6 tasks. Disjoint write sets.
- If RUBRIC.json doesn't exist at /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/RUBRIC.json, inline a rubric_seed field in PLAN.json based on RUBRIC_GUIDE.md § "Example: Wave 1 (prose) rubric sketch".
- Every task's `files` and `writes` lists must use absolute paths.

ABORT REASONS YOU MAY USE:
- spec_wrong: WAVE.md or referenced docs contradict each other
- out_of_scope: a task as specified requires capabilities not available

When PLAN.json is written and parses (test with `jq . PLAN.json`):
1. send_message(target: "/root", message: "PLAN READY at <absolute path>. Tasks: T1..TN. Brief summary: ...")
2. In a separate next step: close_agent (omit target)

EMIT 'PLAN READY' or 'PLAN UNDOABLE: <reason>' as the last line.
```

### Spawn message template — generator subagent per task

(Use as starting point; customize per task.)

```
ROLE: GENERATOR for Wave 1 task <task_id>

YOUR CANONICAL PATH: /root/wave_1_<task_id>_gen

PEER PATHS:
- Evaluator: /root/wave_1_<task_id>_eval
- Spawner (me, orchestrator): /root

DELIVERY CONTRACT:
You MUST deliver your result via send_message(target: "/root", message: <body>)
before close_agent. After delivering, in a SEPARATE next step, call close_agent.

WAVE.md SECTION FOR YOUR TASK (paste from PLAN.json):
[paste the task entry from PLAN.json]

REFERENCE DOCS YOU MUST READ:
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/PROMPT_SURFACES.md
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/OVERVIEW.md (§ "Existing infrastructure")
- (any wave-specific files the task touches; list them absolutely)

YOUR TASK:
Per ORCHESTRATOR_PROTOCOL.md § "Generator (per task)":

Phase 1 - Negotiate CONTRACT.json with evaluator. Propose 5-15 criteria covering correctness, integration, convention, discipline. Use RUBRIC.json (at waves/wave_1/RUBRIC.json) or PLAN.json's rubric_seed as your template source.

Phase 2 - Build per criterion. Commit per criterion. send_message(evaluator) on each criterion completion.

CONTRACT FILE: /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/CONTRACT.json — extend the existing JSON object with your task_id keyed entry.

When all criteria pass:
1. send_message(target: "/root", message: "WAVE TASK DONE for <task_id>. Commit shas: ...")
2. In a separate next step: close_agent (omit target)

EMIT 'WAVE TASK DONE' or 'ABORT(<reason>): <details>' as the last line.
```

### Spawn message template — evaluator subagent per task

```
ROLE: EVALUATOR for Wave 1 task <task_id>

YOUR CANONICAL PATH: /root/wave_1_<task_id>_eval

PEER PATHS:
- Generator: /root/wave_1_<task_id>_gen
- Spawner (me, orchestrator): /root

DELIVERY CONTRACT:
You MUST deliver your result via send_message(target: "/root", message: <body>)
before close_agent.

WAVE.md SECTION FOR YOUR TASK (paste from PLAN.json):
[paste the task entry from PLAN.json]

REFERENCE DOCS YOU MUST READ:
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/RUBRIC_GUIDE.md
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/PROMPT_SURFACES.md
- /Users/rohan/Documents/Personal/codemaxxxing/.wave/campaigns/actor-discipline-2026-05-20/plan/INTEGRATION_INVARIANTS.md
- The RUBRIC.json or PLAN.json's rubric_seed for criteria templates

YOUR TASK:
Per ORCHESTRATOR_PROTOCOL.md § "Evaluator (per task)":

Phase 1 - Negotiate CONTRACT.json with generator. Push back on vague criteria, missing edge cases (consult INTEGRATION_INVARIANTS.md § applicable invariants), weak verify recipes. The talk's "27 contract criteria" granularity is the standard.

Phase 2 - For each criterion_ready message from generator, run the verify recipe, score, update CONTRACT.json. send_message back with PASSED or FAILED.

CRITICAL anti-patterns:
- Do NOT read the generator's reasoning trace. Read only the output (diff via git show <sha>, file contents).
- Do NOT be sycophantic. If a criterion is half-done, FAIL it. Generator will retry or pivot.
- After 3 consecutive failures of same criterion: emit ABORT(approach_failed).

When all criteria passed:
1. send_message(target: "/root", message: "WAVE TASK GREEN for <task_id>. All N criteria passed.")
2. In a separate next step: close_agent (omit target)

EMIT 'WAVE TASK GREEN' or 'ABORT(<reason>): <details>' as the last line.
```

## Gotchas

1. **The first orchestrated wave is the riskiest.** You're using a multi-agent surface whose bugs Wave 0 partially fixed. The safety net (D5) catches missing deliverables; the canonical-path injection (D2) prevents the wrong-path close. If you observe a subagent emitting "I delivered the report" without an actual send_message, the safety net warning will fire on that subagent's mailbox notification — read it, refine spawn prompt, respawn.
2. **Avoid touching subagent prompt files directly as the orchestrator.** Your generator subagents do the edits. The orchestrator's role is supervision: read PLAN.json, spawn pairs, watch for set-phrases, settle.
3. **Forbidden-prose test is harsh.** If you (or a generator) accidentally leave a forbidden phrase in a base prompt, the integration suite fails. Run the forbidden-prose test EARLY (you can run it before any prose edits to confirm baseline) and after each task to catch immediately.
4. **Caveman style is mandatory.** The base prompts (general/*.txt, explore.txt) have "Caveman output rules" sections. Defer-edits MUST preserve those sections verbatim. RUBRIC_GUIDE.md's example rubric has the `C-style-{path-slug}` criterion for this.
5. **Mutual exclusion of root vs subagent hints.** multi-agent-root.txt is NEVER rendered alongside multi-agent-subagent.txt for the same session. Your D7 sibling-coordination section in the root file does NOT need to be duplicated in the subagent file beyond the one-sentence mirror. PROMPT_SURFACES.md § "Mutual exclusion" is the authority.
6. **Capability hint is appended LAST.** The base prompt edits (D4) need to defer to the contract that comes AFTER them in the assembly. Phrase like "See the delivery contract in your multi-agent coordination guidance (capability hints appended below)."
7. **The general/gemini.txt edit should follow the same shape as general/anthropic.txt.** Iteration 3 LEARNINGS Observation 27 notes Gemini benefits from slightly more prescriptive framing, but the delivery contract content is identical. Generator should produce parallel text.
8. **GOTCHAS to consult:**
   - `bun-coverage-aggregation-flake` — single-file coverage runs are source of truth.
   - `bun-test-coverage-source-file-arg-runs-zero-tests` — pass test file paths to `bun test --coverage`, NOT source paths (silent false-pass).
   - Test runner guidance (NOT a GOTCHA slug; see repo-root `AGENTS.md` and `package.json`): always `cd packages/opencode` before `bun test`.
   - `word-boundary-regex-vs-prose-collisions` — IMPORTANT for the forbidden-prose test. Use `grep -P '\bforbidden\b'` (word boundaries) to avoid matching substrings inside legitimate words.
9. **Pivot count discipline.** If a generator hits ABORT(approach_failed) for a prose task, the pivot is usually because the criterion was vague. Refine the criterion, not the prose. NOTES.md should record "pivot 1 reason: rubric criterion C3 didn't have a runnable verify_recipe."

## Verification

```bash
cd packages/opencode

# Typecheck + lint
bun typecheck
bun lint

# New prose-test file
bun test test/prose/subagent-prompts.test.ts
bun test --coverage test/prose/subagent-prompts.test.ts

# Integration invariants for Wave 1 (and regression check on Wave 0's)
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-06'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-08'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-0'   # regression on INV-D-01..05, 07

# Full multi-agent invariant suite (regression)
bun test ./test/integration/multi-agent-invariants.test.ts

# Orchestrator artefact checks
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/CONTRACT.json
jq -e '. | all(.signed == true)' .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_1/CONTRACT.json
```

All must exit 0. Commit on success per AGENT_INSTRUCTIONS.md commit protocol.
