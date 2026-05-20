# Anthropic Harness Learnings

Distilled from Anthropic's AI Engineer conference talk on long-running agents (Ash + Andrew, applied AI team, May 2026). Watch / re-read the talk if a wave introduces a new orchestration shape; otherwise this file is the operational summary.

These principles inform `ORCHESTRATOR_PROTOCOL.md`. Read this once at campaign start; refer back when designing a new orchestration variant.

## The five takeaways

1. **Self-evaluation is a trap.** Use an adversarial evaluator. The model judging its own output is sycophantic: finds a bug, suggests "fix later," moves on. A standalone critic with a separate context window can be tuned harsh; tuning a builder to be self-critical is much harder. Exploits the asymmetry: critique is easier than creation for both humans and LLMs.
2. **Compaction ≠ coherence.** Lossy summaries drift. Don't lean on compaction to span a long-running build. Use fresh subagent context per task; pass state via files on disk (JSON), not via summarized prose handoffs.
3. **Structured handoffs + clean context.** Files on disk (JSON, not Markdown — models overwrite markdown more readily) are the inter-agent state. Each subagent reads its inputs, writes its outputs, terminates. The orchestrator reads the trail.
4. **Subjective quality IS gradable** if you write down what good looks like. The talk's RUBRIC: design, originality, craft, functionality — each weighted, with a few-shot calibration against reference examples. We use the same pattern: per-wave RUBRIC.json with weighted criteria + few-shot examples in the verify_recipe.
5. **Sit with the model, read the traces.** Primary debugging loop is reading subagent traces by hand, not running more experiments. Wave 9 of this campaign makes this systematic — a cross-wave NOTES.md audit at campaign close-out.

## The planner / generator / evaluator triad

Three roles, three context windows, three system prompts.

**Planner.** Takes vague intent, breaks into deliberately HIGH-LEVEL spec. Not granular technical details — those cascade errors across the build. Output is a sprint list / task list. Talk's word: "deliberately under-specified."

**Generator.** Builds. Has the most context. Commits per atomic unit. Sends evaluator on completion.

**Evaluator.** Harsh critic. Reads only the OUTPUT, never the generator's reasoning trace. Uses tools (playwright, grep, bun test) to verify behavior, not just inspect code. Scores against rubric. Pushes back on weak proposals.

**Asymmetry to exploit:** the evaluator can be tuned harsh in a way the generator can't. Same as humans — easy to critique a meal, hard to cook one.

## The negotiation phase

Before generator writes a single line, generator and evaluator negotiate the contract. Generator proposes criteria; evaluator pushes back on scope, missing edge cases, weak verifies. They iterate via files on disk + send_message until both sign.

The evaluator grades against the NEGOTIATED CONTRACT, not the original spec. Why: bridges user-story-style vague spec to testable assertions, without the planner over-specifying upfront. The planner sets the outer lines; gen+eval fill in the testable interior.

The talk's number: 27 contract criteria for a single feature was the granularity required to make findings actionable. Vague criteria → vague critiques → generator shrugs. Granular criteria → "fix this exact line."

## The pivot

If generator can't hill-climb against the rubric (criterion failing repeatedly), the harness throws everything out and restarts the pair with the evaluator's recommendation as constraint. Single-loop / Ralph just keeps patching the same thing; the harness pivots.

Opus 4.6+ models are "very willing to throw away even 10 passes" if they can't hill-climb. The pivot is the model's preferred mode when stuck — respect it; don't try to push through.

In our terms: evaluator emits `ABORT(approach_failed)`; orchestrator reverts the task's commits, refines the spawn prompt, respawns the pair.

## What the talk evolves away

As models get better, parts of the harness become unnecessary:

- Opus 4.5 needed context resetting between sessions (context anxiety). Opus 4.6 doesn't — the harness now runs continuous sessions with compaction for some workloads. (Not us — we use fresh sessions per wave by design, FSM on disk.)
- Opus 4.5 needed sprint decomposition (forced one-feature-at-a-time). Opus 4.6 can hold a 2-hour continuous build. (Not us — we still decompose into waves for the audit trail.)
- Evaluator-cadence dropped from per-sprint to per-oneshot-generation.

The lesson: re-evaluate the harness with every model release. Strip what the model handles natively now.

## What we keep that the talk's harness doesn't have

- **FSM on disk with always-commit.** The talk has progress.json; we have STATE.md + per-commit audit. Stronger.
- **Integration invariants discipline (Iteration 8).** Talk uses subjective rubrics; we add testable invariants per multi-agent change. Complementary — rubrics for the *what*, invariants for the *how it composes*.
- **Conversational user pause.** Talk's harness is "set off and walk away"; we have USER QUESTION → same session resume. Better for iterative work.
- **Set-phrase exits.** Talk implies them; we already have WAVE COMPLETE / WAVE FAILED / PLAN UNDOABLE / USER QUESTION at the wave layer. ADR-009 Phase 2 generalizes the set-phrase ladder to subagent ABORT reasons.

## Operational shape we adopted

Our orchestration shape (per ORCHESTRATOR_PROTOCOL.md):

- Planner role uses `agent_type: "general"` with planner-specific spawn message. Outputs PLAN.json.
- Per task: generator + evaluator pair, both `general`, role-differentiated by spawn message.
- Contract negotiation phase ends when both emit `CONTRACT AGREED`. CONTRACT.json is the agreement.
- Build phase: generator commits per criterion, evaluator grades per criterion.
- Pivot on ABORT(approach_failed); cap at 3 pivots per task.
- Orchestrator runs wave-level verification at the end. Subagents only run their task's verify recipe.
- All file artefacts (PLAN.json, CONTRACT.json) committed for audit.

## What we deliberately don't import

- **Their cost profile.** The talk normalized $200+ / 6-hour runs. We don't have a budget conversation yet; the campaign is structured for incremental cost (10 waves, each ~11 subagent sessions, no continuous-run).
- **Their app-building rubric (design taste, originality).** Our rubric is code/prose correctness + integration-test passage + invariant catalogue green. Different domain, different rubric. RUBRIC_GUIDE.md captures our rubric shape.
- **Their use of playwright for UI testing.** No UI in this campaign. Evaluator's verify recipes are `bun test`, grep over prompts, file existence checks. No browser.
- **Their auto-mode.** That's a Claude Code primitive for opt-in autonomous loops; we use the wave loop instead, which has stronger commit / state semantics.

## Quotes that shaped specific decisions

- "Most people say you can't grade taste. We think you can if you have a strong enough opinion on it and write it down." → RUBRIC.json (D24-D26 will refine per-agent_type rubrics).
- "Tuning a standalone critic to be harsh is tractable. Tuning a builder to be self-critical is not." → Generator and evaluator are separate subagents, always.
- "The reason it pivots is because the harness sees it stuck on a criterion and throws everything out." → Pivot mechanism in ORCHESTRATOR_PROTOCOL.md.
- "Reading the traces was the primary debugging loop, not running more experiments." → Wave 9 audit.
- "Models will overwrite markdown more readily than JSON." → PLAN.json / CONTRACT.json / RUBRIC.json are JSON.

## What to do if you find yourself improvising

If your wave introduces a shape that doesn't match planner/gen+eval/orchestrator:

1. Pause. Re-read the five takeaways above.
2. Ask: am I trying to bypass an evaluator? Am I asking a single agent to grade itself? Am I sending the generator's reasoning to the evaluator? Those are the three classic anti-patterns.
3. If your shape genuinely needs an extension (e.g. a researcher role separate from the planner), document the extension in the wave's NOTES.md. Future iterations can promote it.
4. If you can't make the orchestrator pattern work for your wave → emit USER QUESTION with the shape you tried and what failed. The user picks "force orchestration" or "executor-solo override."
