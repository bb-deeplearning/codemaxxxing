# Integration invariants — tool surface replacement

This file is the campaign's first-class deliverable. Every wave that touches a code surface listed in `OVERVIEW.md` § "Existing infrastructure" MUST add at least one `it.instance` test in `packages/opencode/test/integration/tool-surface-replacement.test.ts` against the relevant invariant before its production code lands.

## Why this exists

The codex-parity campaign tested every primitive at 100% coverage. Two structural bugs survived because no test composed primitives into a real-world scenario. The hardening campaign added integration-first as a discipline and caught those bugs. Three more bugs slipped through the post-campaign window (`d205e5a90`) because no test asserted the model-visible output of `exec_command`, no test composed completion-watch with subagent body delivery, and no test composed mailbox send with fiber revival.

This campaign extends the integration-first discipline to the tool replacement surface. Every BC invariant in `BACKWARD_COMPAT.md` has a corresponding scenario invariant here, plus invariants that catch the new failure modes specific to this campaign.

## How to use this file

For every wave:

1. Read this file end-to-end.
2. Identify which invariants the wave's changes affect.
3. For each affected invariant, locate (or add) the corresponding `it.instance` test in `test/integration/tool-surface-replacement.test.ts`. The test name MUST match the invariant slug.
4. Make the test pass before the wave commits.
5. If you discover a new sharp edge mid-wave, append it under "Discovered during execution" at the bottom and write the green test for it. Future waves treat new entries the same as seeded ones.

## Invariant catalog

Each invariant has a stable slug (used as the test name), a behavioral description, and the wave that owns its first green pass.

### `scanner-extract-preserves-bash-output` (Wave 1)

After lifting `parse`/`collect`/`ask`/helpers from `tool/shell.ts` into `tool/shell/scan.ts`, calling the legacy `bash` tool with each fixture command produces a `Scan { dirs, patterns, always }` byte-identical to the pre-extract output AND a `ctx.ask` payload byte-identical to the pre-extract payload. Test loops over the 50-command corpus and asserts on every entry.

### `scanner-deterministic-under-concurrent-load` (Wave 1)

64 concurrent invocations of `scanCommand` against varied inputs each return the result that matches their own input. No cross-contamination from shared parser state. Each result deterministic across re-runs.

### `scanner-handles-1000-fuzz-inputs-without-crash` (Wave 1)

Property test: 1000 generated bash commands fed to `scanCommand`. None crash, all return a `Scan`, all are deterministic on re-parse. Seed printed on failure.

### `exec-command-honors-saved-bash-allow-pattern` (Wave 2)

Saved `permission.bash: { "git *": "allow" }` config + `exec_command(cmd: "git status")` → permission decision is `allow`, no prompt fires, `Permission.Event.Asked` does NOT publish. The `BashArity.prefix(["git","status"]).join(" ") + " *"` derivation produces `"git *"` which matches the saved rule under permission key `bash`.

### `exec-command-triggers-external-directory-for-outside-cwd-paths` (Wave 2)

`exec_command(cmd: "rm /tmp/foo")` from a workspace whose cwd is `/Users/rohan/proj` produces TWO `Permission.Event.Asked` events in order: first `external_directory` for `/tmp`, then `bash` for `rm *`. Same shape and order as the legacy `bash` tool produces today (verified by Wave 0 snapshot).

### `write-stdin-auto-allows-after-pid-rule-registered-under-bash` (Wave 2)

Sequence: `exec_command(cmd: "node repl", tty: true)` → user picks "always" in the dialog → `pid:<N>` rule registers under permission key `bash` → `write_stdin(session_id: N, chars: "1+1\n")` → permission decision is `allow` automatically. No second prompt. The `pid:<N>` lookup happens under `bash` (not `exec_command`) because Wave 2 changed both tools' `PermissionKey`.

### `permission-bash-deny-hides-exec-and-stdin-from-tool-list` (Wave 2)

Agent or user config with `permission.bash: { "*": "deny" }` (or `tools: { bash: false }`) results in `tools(model)` not containing `exec_command` OR `write_stdin`. The `SHELL_TOOLS` category in `Permission.disabled` and the `resolveTools` mapping in `session/llm.ts` group the three IDs together.

### `exec-command-concurrent-permission-flows-do-not-cross-contaminate` (Wave 2)

32 concurrent `exec_command` calls with varied commands and a permission ruleset that asks for some, allows others. Each call's `ctx.ask` (when fired) carries only its own command's patterns. No call receives another's `pid:<N>` always-rule.

### `spawn-agent-honors-saved-task-allow-pattern` (Wave 3)

Saved `permission.task: { "explore": "allow" }` config + `spawn_agent(agent_type: "explore", ...)` → permission decision is `allow`, no prompt. The lookup happens under permission key `task` (not `spawn_agent`) because Wave 3 changed `spawn_agent`'s permission key.

### `spawn-agent-description-filters-by-task-rules` (Wave 3)

Saved `permission.task: { "explore": "deny", "general": "allow" }` config → `spawn_agent`'s description (rendered via `describeSpawnAgent` at `registry.ts:329`) lists `general` as eligible but does NOT list `explore`. The filter at `registry.ts:329` consults permission key `task`, not `spawn_agent`.

### `permission-task-deny-hides-all-six-v2-tools-from-list` (Wave 3)

Agent or user config with `permission.task: { "*": "deny" }` (or `tools: { task: false }`) results in `tools(model)` not containing `spawn_agent` OR `send_message` OR `followup_task` OR `wait_agent` OR `list_agents` OR `close_agent`. The `MULTI_AGENT_TOOLS` category groups all six.

### `model-tool-list-no-bash` (Wave 4)

After Wave 4 ships, calling `ToolRegistry.tools(model)` for any agent (build, caveman, explore, general, plan) returns a list whose tool IDs do not include `bash`. Verified by snapshot diff against Wave 0 capture.

### `model-tool-list-no-task` (Wave 4)

Same as above for `task`.

### `plugin-bash-hook-applies-to-exec-command` (Wave 4)

A plugin that hooks `tool.definition` for tool ID `bash` and mutates the description (e.g. appends a string) sees its mutation reflected in `exec_command`'s rendered description. The bridge in `tools()` dispatches the legacy hook for the new tool ID.

### `plugin-task-hook-applies-to-spawn-agent` (Wave 4)

Same as above for `task` → `spawn_agent`.

### `legacy-shell-tool-still-runnable-from-internal-code` (Wave 4)

`shell.ts` is no longer in the model-facing builtin array, but importing `ShellTool` from `@/tool/shell` still works AND a direct call to its `execute` (wired through a test harness, not the model) still produces the expected output. Confirms the file isn't broken — just not advertised.

### `legacy-task-tool-still-runnable-from-internal-code` (Wave 4)

Same as above for `task.ts`.

### `prose-migration-preserves-git-safety-protocol` (Wave 5)

The git safety protocol fragment from `shell.txt` (lines 13-51 currently) appears verbatim in `exec_command.txt` after migration. Differential test loads both files, diffs the fragment.

### `prose-migration-preserves-pr-creation-flow` (Wave 5)

Same as above for the PR creation flow fragment (lines 53-77 currently).

### `prose-migration-preserves-spawn-agent-eligible-list` (Wave 5)

The per-subagent-type listing rendered by `describeSpawnAgent` (`registry.ts:322-339`) survives Wave 5's prompt prose changes — the model still sees an enumerated list of available subagent types.

### `prompt-token-count-within-budget` (Wave 5)

After prose migration, `exec_command` description token count is within ±5% of (`bash`'s pre-migration token count + `exec_command`'s pre-migration token count) — see PERF.md § "Prompt token budget". Same for `spawn_agent`.

### `bc-matrix-fully-green` (Wave 6)

Aggregate test: every fixture × every invocation tuple in `BACKWARD_COMPAT.md` produces the expected outcome. Single mismatched cell = test failure.

### `perf-trend-no-creep` (Wave 6)

Aggregated trend table in `artifacts/perf-trend.md` shows no metric drifting upward across waves beyond the per-wave budget. Each wave's delta vs the previous wave's snapshot is bounded by the same 5/10/15% budget.

## Discovered during execution

(Empty at campaign start. Each wave that finds a new invariant worth asserting appends a section here following the same shape: slug + behavioral description + owning wave.)
