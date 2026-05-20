# Orchestrator Protocol

You (the wave executor, `caveman`) are the supervisor of a three-role subagent team for orchestrated waves. This file is the per-wave runbook.

Skip this entire file if your wave is marked `executor-solo` in STATE.md or in the wave's WAVE.md header. Solo waves do the work directly with your own tool calls — no subagents.

## The three roles

All three roles use `agent_type: "general"`. Role differentiation lives entirely in the spawn message body. We deliberately do NOT add custom agent types because:

1. Adding custom agents is itself a campaign change (would need to land in Wave 0 or 1).
2. The role discipline lives in the message, where it's auditable per spawn.
3. Future iterations can promote roles to custom types once the discipline is stable; for now, keep the primitive surface small.

| Role | What it does | Set-phrases it emits |
|---|---|---|
| **Planner** | Reads WAVE.md + INTEGRATION_INVARIANTS.md + RUBRIC.json. Breaks wave into PLAN.json tasks. One task = one file or one tight bundle. Each task is independently buildable. | `PLAN READY` / `PLAN UNDOABLE` / `ABORT(<reason>)` |
| **Generator** | Per-task. Negotiates CONTRACT.json with evaluator. Builds per criterion. Commits per criterion. Sends evaluator on each criterion completion. | `CONTRACT PROPOSED` / `CONTRACT AGREED` / `CRITERION READY <id>` / `WAVE TASK DONE` / `ABORT(<reason>)` |
| **Evaluator** | Per-task. Reads PLAN.json + RUBRIC.json. Negotiates CONTRACT.json with generator. Grades each criterion via running the verify recipe (tests, type-checks, file-greps, prose-greps). Pushes back via followup_task on rejected criteria. | `CONTRACT REVIEWED` / `CONTRACT AGREED` / `CRITERION PASSED <id>` / `CRITERION FAILED <id>: <reason>` / `WAVE TASK GREEN` / `ABORT(<reason>)` |

You (orchestrator) emit the wave-level set-phrases: `WAVE COMPLETE` / `WAVE FAILED` / `PLAN UNDOABLE` / `USER QUESTION`. These are pattern-matched by the loop. Your subagents' set-phrases (CONTRACT AGREED etc.) are NOT pattern-matched by the loop; they're a discipline you use to know when a subagent is done. Read them from the subagent's last assistant message via the auto-extractor (Wave 0's safety net catches any missing).

## Sequence

```
A. PLAN
   1. Spawn planner subagent (one shot per wave).
   2. Wait. Read PLAN.json when planner emits PLAN READY.
   3. If planner emits PLAN UNDOABLE or ABORT(spec_wrong) → emit PLAN UNDOABLE,
      commit + STATE update, stop.

B. PER TASK (loop over PLAN.json)
   For each task in PLAN.json, in dependency order:

   1. NEGOTIATE.
      - Spawn generator with task spec + role prompt.
      - Spawn evaluator with task spec + RUBRIC.json subset + role prompt.
      - Send both: their canonical paths AND each other's canonical paths
        (so they can address each other).
      - Both proceed to negotiate via send_message / followup_task. They emit
        CONTRACT AGREED when CONTRACT.json is written and both signed.
      - You poll with list_agents until both emit CONTRACT AGREED, or either
        emits ABORT.

   2. PIVOT (if either ABORTs during negotiation).
      - Read the ABORT reason from the failing subagent's last message.
      - close_agent both subagents.
      - Refine the spawn prompt for the next attempt (incorporate the ABORT
        reason as a constraint).
      - Goto B.1 for this task. Track pivot count in NOTES.md.
      - If pivot count for this task >= 3 → escalate (emit WAVE FAILED for
        the wave; verifier picks up).

   3. BUILD.
      - followup_task(generator, "Contract signed. Build per CONTRACT.json.
        Commit per criterion. send_message(evaluator) on each criterion
        completion.")
      - Loop: poll list_agents.
        * generator emits CRITERION READY <id> → evaluator runs the verify
          recipe, writes status to CONTRACT.json, emits CRITERION PASSED
          or CRITERION FAILED.
        * On CRITERION FAILED 3x for same id → evaluator emits
          ABORT(approach_failed). You pivot per B.2.
        * When all criteria in CONTRACT.json show passed → generator emits
          WAVE TASK DONE, evaluator emits WAVE TASK GREEN.

   4. CLOSE.
      - close_agent both subagents using canonical paths.
      - If close_agent returns already_terminated, that's success (self-close
        is the legit path; D9 distinguishes this from path_invalid).

C. WAVE SETTLE.
   1. After all tasks pass, YOU run wave-level verification (typecheck, lint,
      integration invariants — never delegate this to a subagent; the
      executor is the only one with full wave context).
   2. If green → emit WAVE COMPLETE, commit, STATE update per AGENT_INSTRUCTIONS.
   3. If red → diagnose: own bug (fix in your context if cheap, else WAVE
      FAILED) vs spec issue (PLAN UNDOABLE) vs need user (USER QUESTION).
```

## Spawn messages — required content

Every spawn message MUST include these sections, in this order, with verbatim WAVE.md content pasted (not summarized):

```
ROLE: <PLANNER | GENERATOR <task-id> | EVALUATOR <task-id>>

YOUR CANONICAL PATH: /root/<task_name>
(Inject this exactly. Subagent uses it for close_agent(self).)

PEER PATHS:
- Generator: /root/<gen_task_name>  (only for evaluator)
- Evaluator: /root/<eval_task_name>  (only for generator)
- Spawner (me): /root  (for both)

DELIVERY CONTRACT:
You MUST deliver your result via send_message(target: "/root", message: <body>)
to me before close_agent. Your text alone may not reach me — the harness has
a safety net that catches missing deliveries with a warning, but the contract
is the primary mechanism. After delivering, in a SEPARATE next step, call
close_agent (omit target → closes you). Do not pile text + close_agent in one
turn — the extractor handles it now but the message is the contract.

WAVE.md CONTENT (paste verbatim):
<paste the relevant section here>

REFERENCE DOCS YOU MUST READ:
- <absolute path 1>
- <absolute path 2>
- ...

YOUR TASK:
<role-specific instructions; see below>

ABORT REASONS YOU MAY USE:
- spec_wrong: WAVE.md or RUBRIC.json contains an impossible / contradictory ask
- transient_tool_error: tool failure you tried to retry and couldn't
- out_of_scope: the task as scoped requires capabilities you don't have
- context_full: you've hit context-window pressure
- approach_failed: (evaluator only) generator has failed criterion N for K
  consecutive attempts; recommend reset + alternative approach
- user_question: needs user judgment (you should rarely emit this; bubble to me
  instead)

EMIT EXACTLY ONE OF YOUR SET-PHRASES AS THE LAST LINE.
```

### Role-specific spawn message bodies

**Planner.**
```
YOUR TASK:
Read WAVE.md fully. Read INTEGRATION_INVARIANTS.md for the invariants this
wave owns (named in WAVE.md). Read RUBRIC.json if present at
waves/wave_N/RUBRIC.json — if absent, draft one inline in PLAN.json under a
top-level `rubric_seed` field so the evaluator can grade against it
(wave_verify will refine on its next pass).

Output: write waves/wave_N/PLAN.json with this shape:

{
  "wave_id": <N>,
  "tasks": [
    {
      "id": "T1",
      "title": "<short>",
      "files": ["<absolute path>", ...],
      "writes": ["<absolute path>", ...],   // strict subset of `files`
      "depends_on": []                      // ids of earlier tasks
    },
    ...
  ],
  "rubric_seed": { ... }   // omitted if RUBRIC.json exists
}

Constraints:
- Tasks must have disjoint write sets (no two tasks can `writes` the same path).
- Each task is independently buildable once its `depends_on` are satisfied.
- Task count: aim for 3-7. More = thrash; fewer = each task is too big.

Emit PLAN READY when waves/wave_N/PLAN.json exists and lints (jq parse).
Emit PLAN UNDOABLE if WAVE.md is internally inconsistent or asks for
something the codebase cannot support.
```

**Generator (per task).**
```
YOUR TASK:
Negotiate CONTRACT.json with evaluator, then build the task per the agreed
criteria.

Phase 1 — Negotiation:
  send_message(evaluator, {
    "kind": "contract_proposal",
    "task_id": "<id>",
    "criteria": [
      { "id": "C1", "assertion": "<testable>", "weight": <0..1>,
        "verify_recipe": "<exact shell or grep command evaluator can run>" },
      ...
    ]
  })

  Evaluator pushes back via followup_task with critique. Iterate until
  evaluator emits CONTRACT AGREED in their last message. Then YOU write
  CONTRACT.json to waves/wave_N/CONTRACT.json (or extend the existing file
  with your task_id keyed entry) and emit CONTRACT AGREED.

Phase 2 — Build:
  For each criterion in dependency order:
    1. Implement the code/prose for that criterion.
    2. git commit (per AGENT_INSTRUCTIONS commit protocol — your spawner is
       the orchestrator, you commit to its branch).
    3. send_message(evaluator, {
         "kind": "criterion_ready",
         "task_id": "<id>",
         "criterion_id": "C<n>",
         "commit_sha": "<short SHA>"
       })
    4. Wait for evaluator's CRITERION PASSED <id> or CRITERION FAILED <id>.
    5. On PASSED: continue.
    6. On FAILED 3x consecutively for the same criterion:
         emit ABORT(approach_failed): "C<n> failing across 3 attempts; <details>"

  When all criteria passed: emit WAVE TASK DONE, then send_message to
  orchestrator with summary.
```

**Evaluator (per task).**
```
YOUR TASK:
Negotiate CONTRACT.json with generator, then grade each criterion as
generator marks it ready.

Phase 1 — Negotiation:
  Read generator's contract_proposal. Push back via followup_task on:
    - Criteria too vague to grade (the talk's "vague criteria → vague
      critiques → generator shrugs" rule)
    - Missing edge cases the WAVE.md gotchas section flags
    - Weights mis-distributed (e.g. design heavy on a code-only wave)
    - verify_recipe is not actually runnable as written
  Iterate until you can grade every criterion deterministically.
  Emit CONTRACT AGREED in your last message of this phase. Generator writes
  CONTRACT.json.

Phase 2 — Grading:
  For each criterion_ready message from generator:
    1. Read the commit_sha. git show <sha> to inspect the diff.
    2. Run the criterion's verify_recipe.
    3. Score against the rubric criterion's assertion.
    4. Update waves/wave_N/CONTRACT.json:
       criteria[criterion_id].status = "passed" or "failed"
       criteria[criterion_id].evidence = <command output excerpt>
    5. Emit CRITERION PASSED <id> or CRITERION FAILED <id>: <reason>.
    6. On FAILED: send_message(generator, { kind: "rejection",
       criterion_id, reason, suggested_fix }).
  When all criteria passed: emit WAVE TASK GREEN.
  After 3 consecutive failures of the same criterion across generator's
  attempts: emit ABORT(approach_failed): "<details>" recommending reset.
```

## Anti-patterns

The Anthropic talk and the diagnostic sessions both surface these. Do not commit them:

1. **Self-evaluation.** Generator evaluates its own output. Sycophantic, gives up early, declares done when not done. Always use the evaluator role. (Talk: "self-evaluation = trap.")
2. **Muddied contexts.** Sending the generator's reasoning trace to the evaluator. The talk explicitly says: "much more effective to just let it judge the output... otherwise it's very easy for the model to kid itself." Evaluator sees only generator's output (diffs, commits, verify recipe results) — NOT the generator's reasoning.
3. **Vague criteria.** "Tests pass" vs "all 8 invariants in INTEGRATION_INVARIANTS.md § 'INV-D-01..08' assert green when `bun test ./test/integration/multi-agent-invariants.test.ts -t INV-D-` exits 0." The latter is actionable; the former isn't.
4. **Continue when the model wants to reset.** If the evaluator emits ABORT(approach_failed) and you respawn-and-continue (build on partial work), you're fighting the model's own judgment. Reset. The talk reported Opus 4.6+ is "very willing to throw away even 10 passes if it can't hill-climb" — respect that.
5. **Broadcast assumptions.** Don't tell the generator "send to evaluator AND wait for evaluator response" then forget that send_message doesn't wake. Use followup_task when you want the recipient to act on the message. (See `multi-agent-root.txt` § "Sibling coordination" after Wave 1 lands D7.)
6. **Subagent grades subagent.** The orchestrator is the supervisor. Evaluator grades generator; both report to orchestrator. Do not chain another evaluator behind the evaluator — that's the discriminator-of-discriminator regress.
7. **Run global verification inside a subagent.** Subagents run their task's verify_recipe ONLY. The orchestrator runs `bun typecheck`, `bun lint`, the full integration invariant suite — once, at the wave-settle phase.

## State files written during orchestration

Per wave, the following files appear under `waves/wave_N/`:

- `PLAN.json` — written by planner, read by orchestrator + generators + evaluators.
- `CONTRACT.json` — written by generators (negotiation phase), updated by evaluators (grading phase). One top-level key per task.
- `RUBRIC.json` — drafted by `wave_plan` during decomposition (may be a stub the planner subagent fills via `rubric_seed`); refined by `wave_verify` if needed.
- `NOTES.md` — orchestrator writes on non-success outcomes. Includes orchestration line: "Orchestration: planner+gen+eval, pivot count: K".

Commit these along with code/prose. The CONTRACT.json + NOTES.md trail is the audit log for "what did the orchestrator and its pair actually do."

## Cost discipline

Every subagent spawn is an LLM session. Cost is multiplicative. For a wave with 5 tasks:

- 1 planner session
- 5 generator sessions (one per task)
- 5 evaluator sessions (one per task)
- Negotiation rounds + grading rounds add turns to each

Roughly 11 sessions per wave. The talk normalized 6-hour campaigns at hundreds of dollars; we are running a 10-wave campaign that's structurally similar.

Mitigations:
- Tasks with no inter-criterion dependency can run their gen+eval pair sequentially in the same negotiation/grading cycle (one pair handles 5 criteria for one task).
- Generator and evaluator share the rubric — don't re-state it across turns; ref by criterion id.
- Pivots are expensive. The 3-pivot ceiling per task is a hard limit; past that, escalate.
- If you're tempted to spawn a 4th role (e.g. a "fixer" subagent to apply the evaluator's suggested fix), don't. The generator does the fix. The evaluator grades the fix. That's the contract.

## When the orchestrator panics

If you (orchestrator) find yourself unable to make progress:

- Repeated subagent ABORTs across pivots → WAVE FAILED. Loop will retry; verifier will pick up at 3 transient failures.
- Subagent emits set-phrase you don't recognize → likely contract violation. close_agent the subagent, respawn with refined prompt. Bump pivot count.
- list_agents shows subagents alive but idle for >5 minutes (no progress) → possible deadlock. Send each a `followup_task` asking for status. If still idle → close_agent and respawn.
- Safety net warning (Wave 0 D5) fires on a subagent's mailbox → that subagent violated the delivery contract. Read its last assistant text from the warning. Re-spawn that subagent's task with a stronger contract reminder.
- You hit context-window pressure (Opus 4.7 still shows context anxiety on heavy days) → emit USER QUESTION with the partial work summary; the user picks "retry fresh" or "continue."

The orchestrator's superpower is that it never holds task context — only orchestration state (which tasks are done, which subagents are alive, which pivots have burned). Stay disciplined about that. Read PLAN.json, CONTRACT.json, NOTES.md to remember; do not try to keep task internals in your head.
