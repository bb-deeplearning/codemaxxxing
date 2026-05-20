# Rubric Guide

Per-wave `RUBRIC.json` files are the evaluator's grading reference. This file describes the rubric shape and the authoring discipline.

## Where rubrics live

```
.wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_N/RUBRIC.json
```

One per wave. Drafted by `wave_plan` (at campaign decomposition time) and refined by `wave_verify` (post-decompose sanity check + any post-execution amendments). The wave executor (orchestrator) does NOT author rubrics — it consumes them.

If a wave's RUBRIC.json is missing when the orchestrator's planner subagent runs, the planner inlines a `rubric_seed` field in PLAN.json (per ORCHESTRATOR_PROTOCOL.md). The evaluator uses that seed; wave_verify may promote it to a standalone RUBRIC.json on its next pass.

## Rubric shape

```json
{
  "wave_id": <N>,
  "wave_kind": "code | prose | mixed | validation | observability | audit",
  "criteria_categories": [
    {
      "id": "correctness",
      "weight": 0.4,
      "description": "<one line>",
      "default_criteria": [
        {
          "assertion_template": "<assertion shape with {placeholders}>",
          "verify_template": "<command shape>"
        }
      ]
    },
    ...
  ],
  "guidance": {
    "few_shot_pass": [<example of what good looks like — file:line refs or short prose>],
    "few_shot_fail": [<example of what NOT to ship — anti-pattern>],
    "anti_patterns": ["<one-line description>", ...]
  },
  "stuck_threshold": 3
}
```

`criteria_categories[].default_criteria` are templates. The generator and evaluator instantiate concrete criteria in CONTRACT.json by substituting placeholders with task-specific values.

`stuck_threshold` is the pivot trigger. If the generator fails the same criterion `stuck_threshold` times, the evaluator emits `ABORT(approach_failed)` and the orchestrator pivots.

## Categories (campaign defaults)

These categories appear in most waves. wave_plan picks the relevant subset + weights per wave.

| Category | Description | Default weight |
|---|---|---|
| `correctness` | The code/prose does what the WAVE.md goal says. Test passes, prose matches required-phrases, etc. | 0.4 |
| `integration` | The change holds the integration invariants listed in INTEGRATION_INVARIANTS.md for this wave. | 0.3 |
| `convention` | Effect v4, module shape, file structure, no banned phrases — codemaxxxing house style. | 0.15 |
| `bc_preservation` | Existing tests stay green; no regression to multi-agent-invariants.test.ts. | 0.1 |
| `discipline` | Did the executor follow the orchestrator protocol? PLAN.json present, CONTRACT.json signed, NOTES.md filled on non-success. | 0.05 |

For prose-only waves (Wave 1): drop `bc_preservation` → 0.05, raise `correctness` → 0.45.

For validation waves (Wave 2): drop `correctness` → 0.1, raise `integration` → 0.6. The wave IS the integration test.

For observability waves (Wave 9): use `correctness` 0.5 + `convention` 0.3 + `discipline` 0.2. No integration test needed; the audit IS the deliverable.

## Per-criterion template fields

Inside `default_criteria`:

```json
{
  "id_template": "C{n}",
  "category": "correctness",
  "assertion_template": "File {path} contains the substring '{required_phrase}' at line {line_range}.",
  "verify_template": "grep -n '{required_phrase}' {path} | awk -F: '$1 >= {line_min} && $1 <= {line_max}'",
  "weight": 0.1
}
```

Placeholders are substituted by the generator+evaluator pair during contract negotiation. The CONTRACT.json instantiation looks like:

```json
{
  "task_id": "T1",
  "criteria": [
    {
      "id": "C1",
      "category": "correctness",
      "assertion": "File /abs/path/multi-agent-subagent.txt contains 'send_message' at lines 35-50.",
      "verify": "grep -n 'send_message' /abs/path/multi-agent-subagent.txt | awk -F: '$1 >= 35 && $1 <= 50'",
      "weight": 0.1,
      "status": "pending"
    },
    ...
  ]
}
```

## Authoring rules for `wave_plan`

When drafting RUBRIC.json:

1. Read the wave's WAVE.md goal + tasks.
2. Pick categories per the table above (drop irrelevant ones, adjust weights).
3. For each category, write 2-5 `default_criteria` templates that map to the wave's tasks.
4. Templates must be GRANULAR enough that an evaluator can run the verify_template and get a yes/no. Vague templates fail the talk's "vague criteria → vague critiques" rule.
5. `few_shot_pass` and `few_shot_fail` are mandatory. Pick examples from the wave's own scope (existing file refs, existing prose, existing tests). If you can't find examples from this campaign, point to a prior campaign's artefact.
6. `anti_patterns` enumerates ways the generator might "succeed" that aren't actually success. Examples: "wave passes typecheck but no integration test added"; "prose change matches required-phrases but contradicts the limits section"; "code change adds a feature flag instead of removing the alternative."
7. `stuck_threshold` defaults to 3. Tighter (2) for prose waves where convergence should be fast; looser (4) for validation waves where multiple invariants need separate green passes.

## Authoring rules for `wave_verify`

When reviewing or amending RUBRIC.json:

1. Read what wave_plan drafted.
2. Probe reality on at least 3 randomly-chosen verify_templates: `instantiate placeholders with plausible task values, run the command, confirm it returns a usable yes/no signal`.
3. If a template can't be made to work, mark the criterion as `seeded_unverifiable: true` and document why. The evaluator will skip it; wave_plan should revisit.
4. Verify weights sum to 1.0 across categories.
5. Verify few-shot examples are reachable file paths or runnable commands. Stale references = automatic amend.
6. If amendments are needed, re-decompose just the rubric (don't touch PLAN.json or CONTRACT.json which are runtime artefacts).

## Authoring rules for evaluator subagent

When instantiating CONTRACT.json from RUBRIC.json templates:

1. Read RUBRIC.json end-to-end.
2. For each `default_criteria` template, instantiate ONE concrete criterion per task in PLAN.json (or none, if the template doesn't apply).
3. Substitute placeholders with the task's concrete values (file paths, line numbers, required phrases).
4. Verify the instantiated `verify` command runs (dry-run; doesn't matter if it returns pass or fail, just that it RUNS).
5. Push back via followup_task to generator on:
   - Criteria that can't be instantiated (template doesn't fit the task)
   - verify commands that don't actually run
   - Weight distribution that under-weights a category the wave's gotchas flag as risky
6. After both sign, write CONTRACT.json. Both emit CONTRACT AGREED.

## Anti-patterns in rubric authoring

Don't ship rubrics that:

- Have a single criterion per category (no granularity → no actionable feedback).
- Use prose-only assertions ("the code is well-written") — must be testable.
- Have verify commands that depend on services not available in the wave context (e.g. a network call to a live API).
- Score `discipline` higher than `correctness` (process > outcome is the wrong default).
- Have circular dependencies between criteria (C2 depends on C1 passing AND C1 depends on C2 — neither passes).
- Include criteria that can only be evaluated by the orchestrator (e.g. "wave-level typecheck"). Those go in the wave-settle phase, not CONTRACT.json.

## Example: Wave 1 (prose) rubric sketch

```json
{
  "wave_id": 1,
  "wave_kind": "prose",
  "criteria_categories": [
    {
      "id": "correctness",
      "weight": 0.45,
      "description": "Delivery contract is stated literally in multi-agent-subagent.txt; required phrases present; forbidden phrases absent.",
      "default_criteria": [
        {
          "id_template": "C-corr-{n}",
          "assertion_template": "File {path} contains required phrase '{phrase}'.",
          "verify_template": "grep -q '{phrase}' {path}",
          "weight": 0.1
        },
        {
          "id_template": "C-forb-{n}",
          "assertion_template": "File {path} does NOT contain forbidden phrase '{phrase}'.",
          "verify_template": "! grep -q '{phrase}' {path}",
          "weight": 0.05
        }
      ]
    },
    {
      "id": "integration",
      "weight": 0.4,
      "description": "INV-D-04..08 pass.",
      "default_criteria": [
        {
          "id_template": "C-inv-{slug}",
          "assertion_template": "Integration invariant '{slug}' green.",
          "verify_template": "cd packages/opencode && bun test ./test/integration/multi-agent-invariants.test.ts -t '{slug}'",
          "weight": 0.08
        }
      ]
    },
    {
      "id": "convention",
      "weight": 0.1,
      "description": "Caveman style preserved; no banned phrases from STYLE.md.",
      "default_criteria": [
        {
          "id_template": "C-style-{path-slug}",
          "assertion_template": "File {path} preserves caveman output rules section verbatim.",
          "verify_template": "grep -c 'Caveman output rules' {path}"
        }
      ]
    },
    {
      "id": "discipline",
      "weight": 0.05,
      "description": "Orchestrator artefacts present.",
      "default_criteria": [
        {
          "id_template": "C-disc-plan",
          "assertion_template": "waves/wave_1/PLAN.json exists and parses.",
          "verify_template": "test -f waves/wave_1/PLAN.json && jq . waves/wave_1/PLAN.json"
        },
        {
          "id_template": "C-disc-contract",
          "assertion_template": "waves/wave_1/CONTRACT.json exists, all task criteria signed.",
          "verify_template": "jq '.[] | select(.signed != true) | .task_id' waves/wave_1/CONTRACT.json | wc -l | xargs -I{} test {} -eq 0"
        }
      ]
    }
  ],
  "guidance": {
    "few_shot_pass": [
      "packages/opencode/src/agent/prompt/multi-agent-subagent.txt:35-50 — clean delivery contract rewrite",
      "Wave 1 NOTES.md from a successful first-attempt session shows orchestration: planner+gen+eval, pivot count: 0"
    ],
    "few_shot_fail": [
      "Prose rewrite that says 'deliver via send_message' but also keeps 'your text response is the deliverable' elsewhere in same file",
      "Rewrite that breaks the caveman output rules block"
    ],
    "anti_patterns": [
      "wave passes typecheck but no integration test added — covered by INV-D-* criteria",
      "prose change matches required-phrases but contradicts the limits-of-actor-model section",
      "executor edits the prompt files directly without orchestrating"
    ]
  },
  "stuck_threshold": 2
}
```

(This is a sketch; wave_plan instantiates the real version during decomposition.)
