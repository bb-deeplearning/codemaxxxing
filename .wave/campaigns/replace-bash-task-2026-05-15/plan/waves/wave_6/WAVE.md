# Wave 6 — Full BC re-run, perf aggregate, plugin re-verify, spec doc + ship

<!--
Previous waves: 0, 1, 2, 3, 4, 5.
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../INTEGRATION_INVARIANTS.md (focus: bc-matrix-fully-green, perf-trend-no-creep)
- ../../BACKWARD_COMPAT.md (the entire matrix)
- ../../FIXTURES.md (every fixture)
- ../../PERMISSION_MAPPING.md (the post-campaign mapping table)
- All prior wave NOTES.md (for the spec doc)
- specs/codex-parity.md and specs/codex-parity-hardening.md (for voice/structure of the new spec doc)
-->

## Goal

Final wave. No production code changes. Three deliverables:

1. **Full BC re-run** — every fixture × every invocation tuple in `BACKWARD_COMPAT.md` produces the expected outcome. Aggregate across the entire integration + differential + fixture suite. Single mismatched cell = wave failure.
2. **Perf aggregate** — re-run every metric the campaign touched. Compute deltas vs Wave 0 baseline AND vs each prior wave. Aggregate into `artifacts/perf-final-report.md`. Assert no metric exceeds budget; assert no metric drifted upward across waves beyond per-wave budget.
3. **Spec doc + ship** — produce `specs/replace-bash-task.md` with the campaign's narrative: what changed, what stayed, fixture-table for BC, perf report, plugin migration boundary. Voice matches `specs/codex-parity.md` and `specs/codex-parity-hardening.md`.

## Tasks

Sequential. One sub-agent. No parallelism — verification must be deterministic and the spec doc absorbs all prior wave outcomes.

### 1. Full BC re-run

```bash
cd packages/opencode

# Every test in the integration suite, every differential test, every fixture loop
bun test test/integration/tool-surface-replacement.test.ts
bun test test/integration/plugin-bridge.test.ts
bun test test/integration/legacy-internal-runnable.test.ts
bun test test/differential/scanner-extract.diff.test.ts
bun test test/differential/exec-permission.diff.test.ts
bun test test/differential/spawn-permission.diff.test.ts
bun test test/differential/prompt-prose.diff.test.ts

# Existing test suites for surfaces this campaign touched
bun test src/tool/shell/
bun test src/tool/shell.test.ts
bun test src/tool/process/
bun test src/tool/agent-spawn/
bun test src/tool/agent-send/
bun test src/tool/agent-followup/
bun test src/tool/agent-wait/
bun test src/tool/agent-list/
bun test src/tool/agent-close/
bun test src/tool/task.test.ts
bun test src/tool/registry.test.ts
bun test src/permission/

# Pre-existing test suite per the team's invocation
bun test --timeout 30000
```

Aggregate the pass count and any failures. If any test fails (excluding known pre-existing flakes documented in repo-root GOTCHAS.md), surface as USER QUESTION with the failure details.

Write the BC verification table to `artifacts/bc-verification.md`. One row per (fixture × invocation) tuple from `BACKWARD_COMPAT.md`, with the actual decision/outcome captured during the test run.

### 2. Snapshot diff

Compare current snapshots to Wave 0 baseline:

```ts
// In a verification script or a final integration test
for (const agentName of ["build", "caveman", "explore", "general", "plan"]) {
  const baseline = JSON.parse(await Bun.file(`.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/tool-list-${agentName}.json`).text())
  const current = await captureToolList(agentName)
  const baselineIds = baseline.map((e: any) => e.id).sort()
  const currentIds = current.map((e: any) => e.id).sort()
  const expectedRemovals = ["bash", "task"]
  const expectedRemainder = baselineIds.filter((id: string) => !expectedRemovals.includes(id)).sort()
  expect(currentIds).toEqual(expectedRemainder)
}
```

Permission-prompt snapshots: compare current `exec_command(cmd: "git status")` rendered prompt against Wave 0's `bash-git-status.json` (with the `pid:<n>` substituted to a placeholder). Per `BACKWARD_COMPAT.md`, the same patterns + same metadata except for tty/workdir-shape differences.

If any snapshot diverges beyond the campaign's documented expected changes, surface as USER QUESTION.

### 3. Perf aggregate

Re-run every campaign-touched bench:

```bash
bun test ./test/perf/baseline.bench.ts
bun test ./test/perf/scan.bench.ts                # if exists
bun test ./test/perf/exec-command.bench.ts
bun test ./test/perf/spawn-agent.bench.ts
bun test ./test/perf/registry-tools.bench.ts
bun test ./test/perf/prompt-render.bench.ts
```

Aggregate the per-wave snapshots from `artifacts/perf/wave_0.json` through `artifacts/perf/wave_5.json` into a trend table. For each metric:

```
| Metric                          | Baseline | W1 | W2 | W3 | W4 | W5 | Final | Delta vs baseline |
|---------------------------------|----------|----|----|----|----|----|-------|-------------------|
| scan.cmd_short.p50              | 50µs     | 51µs (+2%) | ... |    |    |    | 52µs | +4% (within 5%) |
| exec_command.exec.p50           | 1.2ms    | -  | 1.3ms (+8%)... | | | | 1.31ms | +9% (FAIL: budget 5%) |
| ...                             |          |    |    |    |    |    |       |                   |
```

Write to `artifacts/perf-final-report.md`. The trend column shows whether any metric drifted upward across waves beyond budget. Per `INTEGRATION_INVARIANTS.md` § `perf-trend-no-creep`, no metric may drift by more than the per-wave budget across any single-wave delta.

If a metric exceeds budget at any point in the trend, surface as USER QUESTION with the specifics.

### 4. Plugin contract re-verification

Re-run `bun test test/integration/plugin-bridge.test.ts`. If any plugin contract test goes red, surface as USER QUESTION.

Also: scan for plugin hook IDs that touch `bash` or `task`:

```bash
rg "tool\.definition.*bash|tool\.execute.*bash|tool\.definition.*task|tool\.execute.*task" packages/opencode/src/plugin/
```

Cross-reference against the bridge in `tool/registry.ts:tools()`. Confirm every hook the codebase ships with continues to work post-campaign.

### 5. Spec doc — `specs/replace-bash-task.md`

Voice: terse, technical, present-tense, file:line references. Match `specs/codex-parity.md` and `specs/codex-parity-hardening.md`. Length: 300-450 lines.

Required sections:

1. **Header / Status** — `Status (as of YYYY-MM-DD): shipped on the <branch> branch in 7 waves. Pre-existing test suite still passes. Saved permission rules continue to match. Campaign archive: .wave/campaigns/replace-bash-task-2026-05-15/.`
2. **Background** — codex ports were upgrades, not alternatives; opencode shipped them as alternatives by mistake; decision overload + permission-UX-asymmetry; what this campaign reverses.
3. **What's the same** — saved permission rule shapes, tool-by-tool BC matrix, plugin hook bridge for `tool.definition`.
4. **What's different** — model-visible tool list (drops `bash`, `task`); permission key alignment (`bash` for SHELL_TOOLS, `task` for MULTI_AGENT_TOOLS); `disabled()` + `resolveTools` group rules; `describeSpawnAgent` filter key change.
5. **The bash group** — `SHELL_TOOLS = [bash, exec_command, write_stdin]`; permission key is `bash` for all three; `pid:<n>` always-rule lives under `bash` now; AST scanner extracted to `tool/shell/scan.ts`; `exec_command`'s permission flow produces `BashArity.prefix`-derived patterns; saved `bash: { "git *": "allow" }` auto-allows `exec_command(cmd: "git status")`.
6. **The task group** — `MULTI_AGENT_TOOLS = [task, spawn_agent, send_message, followup_task, wait_agent, list_agents, close_agent]`; `spawn_agent`'s permission key is `task`; `describeSpawnAgent` filter consults `task`; saved `permission.task: { "explore": "allow" }` auto-allows `spawn_agent(agent_type: "explore")`.
7. **Plugin migration boundary** — `tool.definition` hooks for legacy IDs fire via the bridge; `tool.execute` hooks for legacy IDs do NOT bridge (different semantics).
8. **Backward compatibility** — link to `BACKWARD_COMPAT.md`, summarize the matrix, link to `bc-verification.md`.
9. **Performance** — link to `artifacts/perf-final-report.md`, summarize: every metric within 5/10/15% budget; trend tracking shows no upward creep beyond per-wave budget.
10. **Integration invariants** — link to `INTEGRATION_INVARIANTS.md`, list the 21 invariants the campaign asserts, mark each green.
11. **What this campaign explicitly does NOT do** — delete `shell.ts` or `task.ts` files; rename permission keys; touch TUI rendering; add `internal: true` flag (left as future polish); change codex-parity multi-agent semantics; affect old session replay.
12. **Forward-looking** — the next campaign that touches a tool surface MUST add an integration invariant before its production code lands; no new tools should be exposed in the model's list without the corresponding fixture-suite + integration test pattern this campaign establishes.

File paths and line numbers must be live (not stale). Use the `file_path:line_number` format consistently.

### 6. CHANGES entry

Update the project's CHANGES file (likely `CHANGES.md` or `packages/opencode/CHANGES.md` per the existing pattern):

```
## (date) — replace-bash-task

**Removed from model surface:** `bash` and `task` tools no longer appear in the
model's tool list. `exec_command` + `write_stdin` and the v2 multi-agent tools
(`spawn_agent`/`send_message`/`followup_task`/`wait_agent`/`list_agents`/`close_agent`)
are now the only shell-flavored and agent-spawning surfaces.

**Saved permissions still work.** Rules under `permission.bash:*` continue to gate
`exec_command` + `write_stdin`. Rules under `permission.task:*` continue to gate
the v2 tools. No config migration required.

**Plugin migration:** plugins hooking `tool.definition` for legacy IDs `bash` or
`task` continue to fire via a bridge in the registry. Plugins hooking
`tool.execute` for those IDs must migrate to the new IDs (semantics differ —
one-shot vs persistent for shell; single-shot vs concurrent-interactive for
agents).

**Custom prompts:** if your custom agent prompts mention "the bash tool" or
"the task tool" by name, update them to reference `exec_command` /
`spawn_agent`. The model self-corrects in most cases.

Spec: specs/replace-bash-task.md
```

### 7. Update `STATE.md` to all_complete

Per `AGENT_INSTRUCTIONS.md` § "After a SUCCESSFUL wave" with `current_wave = 7` (out of `total_waves = 7`) sets `wave_status: all_complete`.

## Test pyramid quota for Wave 6

- Unit: 0 (no production change).
- Integration: full suite re-run (no new tests).
- Differential: full suite re-run.
- Property: 0.
- Concurrent stress: 0.
- Plugin contract: re-run.
- Fixtures: every fixture × every invocation from `BACKWARD_COMPAT.md`.
- Bench: every campaign-touched metric re-run + trend aggregation.

## Gotchas

1. **Wave 0 baselines are immutable.** Do NOT regenerate `artifacts/baseline-perf.json` or `artifacts/snapshots/*`. Comparison only. If you accidentally regenerate, restore via `git checkout artifacts/`.

2. **The trend table requires ALL prior wave snapshots.** If `artifacts/perf/wave_3.json` is missing because Wave 3 forgot to capture, this wave can either (a) re-run Wave 3's bench against current code (which won't be the wave_3 commit) — be explicit in the report that the metric is "current vs baseline" rather than "wave_3 vs wave_2"; or (b) surface as USER QUESTION with a request to back-fill.

3. **Snapshot comparison handling for `pid:<n>`.** Wave 0 captured permission-prompt JSON with a placeholder for the PID. Wave 6's comparison must apply the same substitution. If the substitution is missing, the snapshot diff falsely shows a difference.

4. **Pre-existing test suite includes flakes.** The hardening campaign's spec doc notes the `mailbox seq-watch wakeup p99` test is a known suite-pollution flake. Re-running here should NOT block — confirm against the GOTCHAS.md list and document in NOTES.md if encountered.

5. **The CHANGES entry's date** is today's date; the spec doc's status date is today's date. Both should be the SHA-bearing date of the wave 6 commit, not the campaign-creation date.

6. **The spec doc's "21 invariants" count** depends on whether any "Discovered during execution" entries were appended to `INTEGRATION_INVARIANTS.md` during prior waves. Count the actual current entries before writing the spec doc.

7. **`bun test` from package dirs only.** Per the `do-not-run-tests-from-root` GOTCHA. The verification commands above all `cd packages/opencode` first. The spec doc's commands should match.

8. **Don't merge the verifier's `bc-verification.md` with the spec doc.** They serve different audiences: the verification table is a compliance artifact (machine-readable, exhaustive); the spec doc is a human-readable narrative. Cross-link, don't inline.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# Full re-run
bun test test/integration/
bun test test/differential/
bun test src/tool/
bun test src/permission/
bun test src/session/llm.test.ts                                   # if exists
bun test --timeout 30000                                           # team's standard invocation

# Perf re-run + trend
bun test ./test/perf/                                              # all bench files
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-final-report.md
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/bc-verification.md

# Spec doc shipped
test -f ../../specs/replace-bash-task.md

# CHANGES entry present
rg "replace-bash-task" ../../CHANGES.md ../../packages/opencode/CHANGES.md 2>/dev/null
```

All exit 0.

## Files

New:
- `specs/replace-bash-task.md`
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-final-report.md`
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/bc-verification.md`
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-trend.md` (per PERF.md trend tracking)

Modified:
- `CHANGES.md` (or `packages/opencode/CHANGES.md`) — campaign entry
- `.wave/campaigns/replace-bash-task-2026-05-15/STATE.md` — `wave_status: all_complete`

Unchanged but consumed:
- All `artifacts/snapshots/*` from Wave 0 (comparison only)
- All `artifacts/perf/wave_<N>.json` from Waves 0-5 (aggregation only)
- All `artifacts/perf/baseline-perf.json` (comparison only)
