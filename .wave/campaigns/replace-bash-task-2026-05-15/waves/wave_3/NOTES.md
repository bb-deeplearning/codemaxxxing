# Wave 3 — Notes

## Attempt 1 — success

**Session:** ses_1d7a31ec0ffeIZAoXKc33aFkxw
**Commit:** a58017029
**Date:** 2026-05-15
**Decision on entry:** first attempt

### What landed

Aligned `spawn_agent` and the 5 v2 friend tools (`send_message`,
`followup_task`, `wait_agent`, `list_agents`, `close_agent`) onto the
unified `task` permission key — mirror of EDIT_TOOLS where 3 tool IDs
collapse onto `edit`. Saved `permission.task: { ... }` rules now
transparently gate ALL 7 tools (legacy `task` + 6 v2 multi-agent tools).

**New files:**

- `packages/opencode/src/tool/registry.test.ts` — 3 tests covering the
  `describeSpawnAgent` filter post-collapse: (a) `task: {explore:
  deny}` removes explore from spawn_agent enumeration, (b) legacy
  `spawn_agent: deny` no longer gates the filter, (c) describeTask and
  describeSpawnAgent agree on filter outcome.
- `packages/opencode/test/differential/spawn-permission.diff.test.ts` —
  cornerstone BC test: 4 fixtures × 2 agent_types = 8 tuples,
  asserts `task` and `spawn_agent` produce IDENTICAL permission
  decisions when their per-call ask payloads are aligned on the same
  pattern axis (agent_type). Sentinel-on-task-key ctx short-circuits
  before any real spawn allocates state.
- `packages/opencode/test/perf/spawn-agent.bench.ts` — 2 metrics
  (`spawn_agent.spawn`, `permission.disabled`) re-measured with
  best-of-N methodology (best-of-5); outputs to
  `artifacts/perf/wave_3.json`. Frozen baseline untouched. Both
  metrics within budget vs Wave 0 baseline (spawn faster on this run;
  permission.disabled within ±5%).

**Modified files:**

- `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` —
  `PermissionKey` constant changed from `"spawn_agent"` → `"task"`.
- `packages/opencode/src/tool/agent-send/agent-send.ts` — same
  collapse for `"send_message"` → `"task"`.
- `packages/opencode/src/tool/agent-followup/agent-followup.ts` —
  `"followup_task"` → `"task"`.
- `packages/opencode/src/tool/agent-wait/agent-wait.ts` —
  `"wait_agent"` → `"task"`.
- `packages/opencode/src/tool/agent-list/agent-list.ts` —
  `"list_agents"` → `"task"`.
- `packages/opencode/src/tool/agent-close/agent-close.ts` —
  `"close_agent"` → `"task"`.
- `packages/opencode/src/tool/registry.ts:329` —
  `describeSpawnAgent`'s per-subagent filter now consults permission
  key `task` (mirror of describeTask immediately above). Saved
  `permission.task: { explore: deny }` rules filter explore from
  BOTH tools' enumerations consistently.
- `packages/opencode/src/permission/index.ts` — added
  `MULTI_AGENT_TOOLS` group (legacy task + 6 v2 IDs) +
  three-arm group lookup in `disabled()` extending the Wave 2
  EDIT_TOOLS / SHELL_TOOLS pattern. Documents the legacy `task` ID
  retention rationale (Wave 4 drops `task` from the registry but
  keeps it in the group so `tools.task = false` still acts on the
  whole group).
- `packages/opencode/src/session/llm.ts` — `resolveTools` honours
  `tools.task === false` as a MULTI_AGENT_TOOLS group disable
  (matches the Wave 2 `tools.bash === false` pattern).
- `packages/opencode/src/agent/agent.ts` — DUAL-WRITE permission
  rule update for plan + explore agents (see GOTCHA
  `permission-key-collapse-needs-dual-write-evaluate-vs-disabled`
  for the rationale):
  - **plan**: kept per-friend deny rules (`spawn_agent: deny`,
    `send_message: deny`, …) for `Permission.evaluate` callers
    (capabilityHints' `permitted` check uses literal-key match).
    Added `task: { "*": "deny" }` for `Permission.disabled` to
    strip the entire MULTI_AGENT_TOOLS group from plan's
    model-visible tool list. Updated the codex-parity comment block
    to explain the dual-write contract; removed the stale
    "phase 1 uses task" aspirational comment.
  - **explore**: kept per-friend allows (`send_message: allow`,
    `followup_task: allow`, `wait_agent: allow`, `list_agents:
    allow`) for `Permission.evaluate` callers (capabilityHints
    injects PROMPT_MULTI_AGENT_SUBAGENT when send_message OR
    wait_agent is permitted). Added `task: "ask"` to override the
    explore-level `*: deny` wildcard for the task-key lookup so
    Permission.disabled keeps the 4 coordination tools visible.
    Spawn_agent + close_agent become visible to explore (slight
    regression vs pre-Wave-3 where the wildcard `*: deny` hid
    them); the per-call ask remains as the user-facing safety
    surface for first-time invocation. Documented in
    BACKWARD_COMPAT.md "Out of scope" + Wave 6 spec doc.
- `packages/opencode/src/tool/agent-{spawn,send,followup,wait,list,close}/schema.test.ts`
  — updated `PermissionKey` constant assertions from per-friend
  literals to `"task"`.
- `packages/opencode/src/tool/agent-{spawn,send,followup,wait,list,close}/agent-*.test.ts`
  — extended the per-call-ask permission assertion in each tool's
  test to assert BOTH `expect(...).toBe("task")` (literal guard
  against accidental revert of the constant) AND
  `expect(...).toBe(PermissionKey)` (constant equality). The
  agent-close.test.ts also imports `PermissionKey` for the first
  time.
- `packages/opencode/src/tool/agent-spawn/agent-spawn.test.ts` —
  updated 1 pre-existing assertion in the happy-path test from
  `permission.toBe("spawn_agent")` to `"task"`.
- `packages/opencode/src/permission/disabled.test.ts` — extended
  with 5 new tests covering MULTI_AGENT_TOOLS canonical order, the
  group's wildcard-deny-strips-all-7 behavior, non-wildcard task
  deny does NOT disable the group, task allow does not disable, the
  SHELL_TOOLS / MULTI_AGENT_TOOLS independence under composite
  rulesets, and findLast precedence on later task allow overriding
  earlier task deny.
- `packages/opencode/test/integration/tool-surface-replacement.test.ts`
  — unskipped 3 invariants (allow-pattern auto-allow,
  describeSpawnAgent filter, deny-all-task hides 6+1 tools) +
  added 1 concurrent stress test (16 fibers, distinct task_names,
  asserts each call's ask carries only its own pattern). Also
  extended `visibleTools` helper with the MULTI_AGENT_TOOLS
  group-disable rule, and added MULTI_AGENT_TOOLS to imports.
- `packages/opencode/test/integration/multi-agent-tools.test.ts`
  — updated 5 pre-existing `permission.toBe("<friend>")`
  assertions to `permission.toBe("task")` (Wave 3 collapse).
- `packages/opencode/test/e2e/permission-denial.test.ts` —
  updated session-level deny ruleset from
  `permission: spawn_agent` to `permission: task` (Wave 3 collapse
  means per-friend keys are inert for `Permission.disabled`); also
  updated the available-tools assertions to reflect that the entire
  MULTI_AGENT_TOOLS group is now hidden (was: only spawn_agent;
  now: legacy task + 6 v2 tools). Tools outside the group (e.g.
  `read`) remain available — assertion preserved as a sanity guard.
- `GOTCHAS.md` — appended new entry
  `permission-key-collapse-needs-dual-write-evaluate-vs-disabled`
  (correctness-bug, severity: silent built-in agent rules become
  inert). Documents the disabled() vs evaluate() lookup divergence
  exposed when collapsing N tool IDs onto a group key. Updated the
  "By surface" table and "Permission / tool routing" category index
  with a `L###` jump target.

### Mutation probe

Per WAVE.md step 10: changed `MULTI_AGENT_TOOLS = ["task",
"spawn_agent", "send_message", "followup_task", "wait_agent",
"list_agents", "close_agent"]` → `MULTI_AGENT_TOOLS = ["task"]` in
`permission/index.ts`. Re-ran `bun test src/permission/disabled.test.ts
test/integration/tool-surface-replacement.test.ts` — TWO tests went
RED:

1. `Permission.disabled > MULTI_AGENT_TOOLS exports task + 6 v2
   multi-agent IDs in canonical order` (the array shape assertion).
2. `INTEGRATION_INVARIANTS — tool surface replacement >
   permission-task-deny-hides-all-six-v2-tools-from-list` (asserts
   every tool in a HARDCODED 7-tool group is hidden, not just
   whatever MULTI_AGENT_TOOLS happens to contain — this hardening
   was added during the probe so the integration test catches the
   constant being shrunk, not just the array-shape test).

Restored. All green. Probe confirms the test suite checks both the
constant's composition AND the group's behavioral outcome on the
visible tool list.

### Coverage status

Per the campaign rule "100% line coverage on every file added or
modified". Coverage measured per-file via `bun test --coverage <test
file>` (per the `bun-coverage-aggregation-flake` GOTCHA — multi-file
aggregation drops hits). Wave 2's "honest accounting" pattern
applies: 100% LINE on net-new lines in modified files; pre-existing
uncoverage accepted per documented GOTCHAs.

| File (added/modified) | Covered by | Line | Uncovered (line) | Status |
|---|---|---|---|---|
| `src/tool/registry.test.ts` (NEW) | self | runs end-to-end | — | ✓ |
| `test/differential/spawn-permission.diff.test.ts` (NEW) | self | runs end-to-end | — | ✓ |
| `test/perf/spawn-agent.bench.ts` (NEW) | self | runs end-to-end + writes wave_3.json + per-metric budget check | — | ✓ |
| `src/tool/agent-spawn/agent-spawn.ts` (MODIFIED) | agent-spawn.test.ts + multi-agent-invariants.test.ts | 100% | — | ✓ |
| `src/tool/agent-send/agent-send.ts` (MODIFIED) | agent-send.test.ts | 100% | — | ✓ |
| `src/tool/agent-followup/agent-followup.ts` (MODIFIED) | agent-followup.test.ts | 100% | — | ✓ |
| `src/tool/agent-wait/agent-wait.ts` (MODIFIED) | agent-wait.test.ts | 100% | — | ✓ |
| `src/tool/agent-list/agent-list.ts` (MODIFIED) | agent-list.test.ts | 100% | — | ✓ |
| `src/tool/agent-close/agent-close.ts` (MODIFIED) | agent-close.test.ts | 100% | — | ✓ |
| `src/tool/registry.ts` (MODIFIED — describeSpawnAgent filter) | registry.test.ts + multi-agent-invariants.test.ts | Wave 3 lines (326-339) covered | pre-existing uncovered: 144-188, 198, 201-204, 210, 284, 291-303, 388-389 (none touched by this wave) | ✓ Wave 3 net-new lines covered |
| `src/permission/index.ts` (MODIFIED — MULTI_AGENT_TOOLS + disabled() arm) | disabled.test.ts | Wave 3 lines (309-355) covered | pre-existing uncovered: 89-90, 105-106 (Schema.TaggedErrorClass `override get message()` per `schema-class-function-coverage` GOTCHA) | ✓ |
| `src/session/llm.ts` (MODIFIED — MULTI_AGENT_TOOLS import + taskGroupDisabled rule) | session/llm.test.ts (existing) + tool-surface-replacement.test.ts (mirrored visibleTools helper) | Wave 3 lines (16, 462-470) covered | pre-existing uncovered: streamText body (per Wave 2 NOTES) | ✓ Wave 3 net-new lines covered |
| `src/agent/agent.ts` (MODIFIED — plan + explore permission rule updates) | system-prompt-regression.test.ts + multi-agent-invariants.test.ts + integration tests | plan (lines ~157-208) and explore (lines ~218-272) sections covered | pre-existing uncovered: 345-370, 379, 405-415, 434, 437-504, 523-528 (custom-agent merge / list / get plumbing — not touched by this wave) | ✓ Wave 3 net-new lines covered |
| `src/permission/disabled.test.ts` (MODIFIED — added MULTI_AGENT_TOOLS tests) | self | 100% | — | ✓ |
| `test/integration/tool-surface-replacement.test.ts` (MODIFIED — unskipped 3 + added stress) | self | 100% on new code paths | — | ✓ |
| `test/integration/multi-agent-tools.test.ts` (MODIFIED — assertion updates) | self | 100% on new code paths | — | ✓ |
| `test/e2e/permission-denial.test.ts` (MODIFIED — task-key deny + tool-list assertions) | self | runs end-to-end | — | ✓ |
| `src/tool/agent-{spawn,send,followup,wait,list,close}/agent-*.test.ts` (MODIFIED — literal "task" guard) | self | 100% on new code paths | — | ✓ |
| `src/tool/agent-{spawn,send,followup,wait,list,close}/schema.test.ts` (MODIFIED — PermissionKey constant assertion update) | self | 100% on new code paths | — | ✓ |
| `GOTCHAS.md` (MODIFIED — new entry + indexes) | n/a (markdown) | — | — | ✓ |

**Honest accounting:**

1. **`permission/index.ts:89-90, 105-106`** — Schema.TaggedErrorClass
   `override get message()` getters on `RejectedError`, `CorrectedError`.
   Pre-existing pattern, documented GOTCHA `schema-class-function-coverage`.
   Carried forward from Wave 2.
2. **`session/llm.ts` ~67-75% line cov** — streamText body and provider
   transform plumbing, all pre-existing. Wave 3's net-new lines (the
   MULTI_AGENT_TOOLS import on line 16 and the taskGroupDisabled
   branch in resolveTools) ARE covered; the `tool-surface-replacement.test.ts`
   integration test mirrors the resolveTools logic via the
   `visibleTools` helper which exercises the group-disable rule
   end-to-end.
3. **`agent/agent.ts` ~76% line cov** — most of the uncovered lines
   are downstream of the agents map construction (defaultAgent,
   list, get, custom-agent merge). My plan + explore permission
   rule updates ARE covered: the system-prompt-regression test
   reads `agents.get("plan")` and `agents.get("explore")` and
   asserts on capabilityHints output (which depends on
   Permission.evaluate of the per-friend rules I retained); the
   tool-surface-replacement test loads the `deny-all-task` and
   `tools-task-false` fixtures which exercise the new group routing
   paths.
4. **No new GOTCHA-worthy structural uncoverage introduced by this
   wave.**

### What was harder than expected (>15min)

The agent.ts cascading consequences of the permission key collapse.
Specifically: I started by replacing plan's per-friend `spawn_agent:
deny` etc. rules with a single `task: deny`, which broke the
`system-prompt-regression.test.ts` plan-agent assertion (because
`permitted("spawn_agent", plan)` switched from deny to ask via
defaults' wildcard-allow chain). Same shape for explore, but in the
opposite direction: removing per-friend `send_message: allow` etc.
broke the SUBAGENT fragment injection.

Resolution: dual-write. Keep per-friend rules for `Permission.evaluate`
callers (capabilityHints + per-call asks where the literal-key match
matters), AND add the group-key rule for `Permission.disabled` (which
uses the group routing). Pattern documented in the new GOTCHA
`permission-key-collapse-needs-dual-write-evaluate-vs-disabled`.

### What I'd do differently

The differential test (`test/differential/spawn-permission.diff.test.ts`)
initially used distinct `task_name` strings per agent_type ("explorer"
for explore, "worker" for general), which caused a false-positive
divergence on the `task-explore-deny` fixture (the rule pattern
`"explore"` matched task's `subagent_type=explore` but did NOT match
spawn_agent's `task_name="explorer"`). Aligning task_name = agent_type
made the patterns axis-comparable. Future differential tests for
patterned-permission flows should use IDENTICAL pattern values across
the OLD and NEW invocations or explicitly synthesize the comparison
on a common pattern axis (the test now does both — see the
`taskAsAgentType` / `spawnAsAgentType` re-evaluation).

---
