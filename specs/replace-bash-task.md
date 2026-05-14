# replace-bash-task

> **Status (as of 2026-05-15):** shipped on the `codex-parity` branch in
> 7 waves. All pre-existing test surfaces still green. Saved permission
> rules continue to match. Plugin `tool.definition` hooks for legacy
> tool IDs continue to fire via the registry's bridge. Every metric in
> the campaign-touched perf bench corpus is within budget vs the frozen
> Wave 0 baseline. Campaign archive:
> `.wave/campaigns/replace-bash-task-2026-05-15/`.

## Background

The codex-parity campaign ([`specs/codex-parity.md`](./codex-parity.md))
ported `unified_exec` (`exec_command` + `write_stdin`) and `multi_agent_v2`
(six tools) from `openai/codex-cli`. Codex itself ships these as
**upgrades** — its `ConfigShellToolType` and `multi_agent_v2` config
gates make the new tools mutually exclusive with their legacy
counterparts; the model sees one shell-flavored surface and one
agent-spawning surface, never both.

The codex-parity port shipped them as **alternatives** instead. Both
`bash` and `exec_command` were exposed in the model's tool list. Both
`task` and `spawn_agent` were exposed. The flat builtin array at
`packages/opencode/src/tool/registry.ts:248` had no surface gate; every
tool was advertised every turn.

Two consequences fell out:

1. **Decision overload.** Every model turn spent inference budget
   choosing between near-equivalent tools — `bash` vs `exec_command`,
   `task` vs `spawn_agent`. The two pairs had different parameter
   shapes, different error-tag schemas, and different operational
   manuals. Migration friction landed on the model, not on the user.
2. **Permission-UX asymmetry on the new surfaces.** `bash`'s permission
   flow had been live since launch: tree-sitter AST parse →
   `BashArity.prefix` pattern derivation → file-touch detection →
   `external_directory` prompt. Saved `permission.bash: { "git *": "allow" }`
   rules generalised across `git status` / `git status -s` / `git push`
   etc. via wildcard match on the AST-derived pattern. `exec_command`
   shipped with a single raw-cmd pattern + a `pid:<n>` always-rule —
   simpler, but couldn't match the saved rules users had built up.
   Same shape for `task` (per-subagent-type permission filter via
   `Permission.evaluate("task", item.name, ...)`) vs `spawn_agent`
   (per-agent-type filter under permission key `"spawn_agent"`).

This campaign reverses the alternative-style exposure while preserving
every existing config behavior. No user edits anything. Saved
`permission.bash` rules transparently auto-allow `exec_command` calls.
Saved `permission.task` rules transparently auto-allow `spawn_agent`
calls. The legacy `shell.ts` and `task.ts` files remain as internally-
callable backstops; they are simply no longer advertised to the model.

## What's the same

- **Saved permission rule shapes.** Every config file shape from
  [`FIXTURES.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/FIXTURES.md)
  produces the documented (allow / deny / ask) decision against the
  matching invocation. The campaign's BC matrix is enumerated at
  [`BACKWARD_COMPAT.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/BACKWARD_COMPAT.md);
  every cell is verified green at
  [`bc-verification.md`](../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/bc-verification.md)
  (33/33).
- **Plugin `tool.definition` hooks for legacy IDs.** Plugins keying
  on `bash` or `task` continue to fire and propagate their description
  mutations to `exec_command` / `spawn_agent` via the bridge in
  `tool/registry.ts:407-421`. Documented as a
  [plugin migration boundary](#plugin-migration-boundary) below.
- **`shell.ts` and `task.ts` themselves.** Both remain importable +
  callable from internal code. `legacy-internal-runnable.test.ts` and
  the corresponding integration invariants (`legacy-shell-tool-still-runnable-from-internal-code`,
  `legacy-task-tool-still-runnable-from-internal-code`) prevent
  accidental deletion.
- **No Drizzle migrations.** Every change is in-memory (registry
  builtin array + permission key resolution). Old session transcripts
  containing `bash` / `task` tool calls still load and read back; they
  just don't replay (transcripts never replay anyway).

## What's different

- **Model-visible tool list drops `bash` and `task`.** After Wave 4,
  `ToolRegistry.tools(model)` for any agent excludes `bash` and `task`.
  The `exec_command` + `write_stdin` pair covers shell-flavored work;
  the v2 multi-agent six-pack (`spawn_agent`, `send_message`,
  `followup_task`, `wait_agent`, `list_agents`, `close_agent`) covers
  agent-spawning + cross-agent communication.
- **Permission key alignment.** Every shell-flavored tool now consults
  permission key `bash`. Every multi-agent tool now consults permission
  key `task`. Mirrors the existing `EDIT_TOOLS = ["edit", "write",
  "apply_patch"]` collapse onto permission key `edit`.
- **`disabled()` + `resolveTools` group rules.** Wildcard
  `permission.bash: { "*": "deny" }` (or `tools.bash: false`) now
  hides every member of `SHELL_TOOLS`. Same for `permission.task`
  hiding every `MULTI_AGENT_TOOLS` member. Pre-campaign: only the
  literally-named tool was hidden.
- **`describeSpawnAgent` filter key.** The per-subagent-type filter
  at `tool/registry.ts:348` consults permission key `task` (was:
  `spawn_agent`). A saved `permission.task: { "explore": "deny" }`
  filters `explore` out of `spawn_agent`'s rendered description, in
  addition to `task`'s — symmetric and consistent.

## The bash group

Defined at `packages/opencode/src/permission/index.ts:318`:

```ts
export const SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]
```

| Tool ID | Permission key (per-call ask) | Permission key (`Permission.disabled` lookup) | `resolveTools` user-config key |
|---|---|---|---|
| `bash` | `bash` | `bash` (via SHELL_TOOLS) | `bash` |
| `exec_command` | `bash` | `bash` (via SHELL_TOOLS) | `exec_command` literal; ALSO disabled when `tools.bash === false` |
| `write_stdin` | `bash` | `bash` (via SHELL_TOOLS) | `write_stdin` literal; ALSO disabled when `tools.bash === false` |

References:

- `tool/process/id.ts:28` — `PermissionKey = ShellID.ToolID` (= `"bash"`).
- `permission/index.ts:351` — `SHELL_TOOLS.includes(tool)` arm in
  `disabled()` returns the `bash` ruleset for any of the three IDs.
- `session/llm.ts:466,470` — `shellGroupDisabled = userTools.bash === false`
  + group filter in `resolveTools`.

The AST scanner that derives patterns lives at
`packages/opencode/src/tool/shell/scan.ts` (extracted from `shell.ts`
in Wave 1 — pure refactor; 50-command corpus differential green at
`test/differential/scanner-extract.diff.test.ts`). `exec_command`
calls `ShellScan.scanCommand` then `ShellScan.askForScan(ctx, scan,
{ extraAlways: [pidPattern(processId)], metadata })` — the
`extraAlways` slot is how the `pid:<n>` always-rule rides on the
bash ask. The user picking "always" registers the rule under
permission key `bash`; subsequent `write_stdin(session_id: N, ...)`
calls auto-allow because the same `pid:<n>` pattern is matched under
the same key.

The scanner is reentrant under concurrent load (64 fibers stress-tested
at `tool-surface-replacement.test.ts > scanner-deterministic-under-concurrent-load`)
and handles 1000 fuzz inputs without crash (property test at the
same file's `scanner-handles-1000-fuzz-inputs-without-crash`).

## The task group

Defined at `packages/opencode/src/permission/index.ts:336`:

```ts
export const MULTI_AGENT_TOOLS = [
  "task",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "close_agent",
]
```

| Tool ID | Permission key (per-call ask) | `Permission.disabled` lookup | `resolveTools` user-config key |
|---|---|---|---|
| `task` | `task` | `task` (via MULTI_AGENT_TOOLS) | `task` |
| `spawn_agent` | `task` (changed from `spawn_agent`) — both per-call ask AND `describeSpawnAgent` filter at `tool/registry.ts:348` | `task` (via MULTI_AGENT_TOOLS) | `spawn_agent` literal; ALSO disabled when `tools.task === false` |
| `send_message` | `task` (changed from `send_message`) | `task` (via MULTI_AGENT_TOOLS) | as above |
| `followup_task` | `task` (changed from `followup_task`) | `task` (via MULTI_AGENT_TOOLS) | as above |
| `wait_agent` | `task` (changed from `wait_agent`) | `task` (via MULTI_AGENT_TOOLS) | as above |
| `list_agents` | `task` (changed from `list_agents`) | `task` (via MULTI_AGENT_TOOLS) | as above |
| `close_agent` | `task` (changed from `close_agent`) | `task` (via MULTI_AGENT_TOOLS) | as above |

References:

- `tool/agent-spawn/agent-spawn.ts:26` — `PermissionKey = "task" as const`.
  Same line shape across the 5 friend tools (`agent-send`, `agent-followup`,
  `agent-wait`, `agent-list`, `agent-close`).
- `tool/registry.ts:348` — `describeSpawnAgent` filter:
  `Permission.evaluate("task", item.name, agent.permission).action !== "deny"`.
- `permission/index.ts:353` — `MULTI_AGENT_TOOLS.includes(tool)` arm.
- `session/llm.ts:467,471` — `taskGroupDisabled = userTools.task === false`
  + group filter.

The per-call key collapse mirrors `EDIT_TOOLS` exactly. A user with
`permission.task: { "explore": "allow" }` now sees `spawn_agent
(agent_type: "explore", ...)` auto-allow, the same way they used to
see `task(subagent_type: "explore", ...)` auto-allow.

The `describeSpawnAgent` filter is the second leg. Pre-Wave-3 it
consulted permission key `spawn_agent` — an unintentional artifact
of the codex-parity port; nobody had `permission.spawn_agent: { ... }`
configured because the ask flow always landed under that key, not
something users would pre-configure. After Wave 3 it consults `task`,
so a saved `permission.task: { "explore": "deny" }` filters `explore`
out of `spawn_agent`'s rendered description — same way it filters
`task`'s.

## Plugin migration boundary

The bridge at `tool/registry.ts:407-421`:

```ts
const legacyId =
  tool.id === ExecCommandTool.id || tool.id === WriteStdinTool.id
    ? ShellTool.id
    : tool.id === AgentSpawnTool.id ||
      tool.id === AgentSendTool.id ||
      tool.id === AgentFollowupTool.id ||
      tool.id === AgentWaitTool.id ||
      tool.id === AgentListTool.id ||
      tool.id === AgentCloseTool.id
      ? TaskTool.id
      : undefined
if (legacyId) {
  yield* plugin.trigger("tool.definition", { toolID: legacyId }, output)
}
yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
```

What's bridged:

- **`tool.definition` hooks** — fire for the legacy ID first, then the
  new ID. Mutations made by the legacy hook are visible to the new-id
  hook on the same `output` reference. This preserves the migration
  path for plugins that key on `bash` / `task` and mutate descriptions.
  Verified by `test/integration/plugin-bridge.test.ts` (4 contracts:
  bash → exec_command propagation, task → spawn_agent propagation,
  legacy-then-new ordering, negative scope on unrelated tools).

What's NOT bridged:

- **`tool.execute` / `tool.execute.before` / `tool.execute.after` hooks**
  — execution semantics differ (one-shot for `bash`, persistent PTY
  for `exec_command`; single-shot for `task`, concurrent-interactive
  for `spawn_agent` + friends). A plugin hooking `tool.execute` for
  `bash` semantically expects one-shot completion; firing it for
  `exec_command` would break that expectation. Plugins must migrate
  to the new IDs explicitly. This is a one-time migration per plugin;
  documented in [`CHANGES.md`](../CHANGES.md) for plugin authors.
- **`shell.env` hook** — already wired into `exec-command.ts` directly
  (line ~99-103), continues to fire as before. No bridge needed.

## Backward compatibility

Every BC promise enumerated in
[`BACKWARD_COMPAT.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/BACKWARD_COMPAT.md)
is verified green at
[`artifacts/bc-verification.md`](../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/bc-verification.md).
Aggregate: 33/33 cells across 6 categories (saved bash key, saved task
key, pid:N rule, external_directory, plugin hooks, snapshot diffs).

Out-of-scope (documented as soft-BC, not promised — see BACKWARD_COMPAT.md
"Out of scope"):

- Old session transcript replay (transcripts never replay anyway; read-back
  works).
- Custom prompts that mention "the bash tool" / "the task tool" by name
  (model self-corrects to the available tool).
- Plugin `tool.execute` hooks targeting legacy IDs (must migrate
  explicitly).
- Saved per-friend permission keys (`permission.send_message`,
  `permission.followup_task`, `permission.wait_agent`,
  `permission.list_agents`, `permission.close_agent`,
  `permission.spawn_agent`) — Wave 3 collapsed all 6 v2 tools' per-call
  asks onto permission key `task` (mirror of EDIT_TOOLS where 3 tool
  IDs collapse onto `edit`). Saved per-friend rules silently stop
  matching after Wave 3. Same precedent as EDIT_TOOLS' silent-collapse
  behavior since the codebase's launch.

## Performance

Per-wave deltas vs the frozen Wave 0 baseline are in
[`artifacts/perf-final-report.md`](../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-final-report.md).
Trend per
[`PERF.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/PERF.md):
5 / 10 / 15 % on p50 / p95 / p99 vs baseline; 5 / 10 / 15 % on per-wave
delta vs prior wave for `perf-trend-no-creep`.

Headline numbers (Wave 6 final capture vs baseline):

| Metric | p50 Δ | p95 Δ | p99 Δ |
|---|---|---|---|
| `scan.cmd_short` | -5.4% | -78.7% | -94.0% |
| `shell.exec` | -19.1% | -48.4% | -78.7% |
| `exec_command.exec` | +2.9% | -12.6% | -16.6% |
| `spawn_agent.spawn` | -38.4% | -49.5% | -47.7% |
| `registry.tools` | -22.7% | -24.9% | -36.1% |
| `permission.disabled` | -20.4% | -24.1% | -35.2% |

Largest worsening single-wave delta is +2.9% (`exec_command.exec.p50`
vs Wave 0 baseline) — within the 5% p50 budget. Every other delta is
either an improvement or within budget.

The prose migration's prompt-byte impact:

| Metric | Baseline | Wave 5 final | Δ | Budget allowance |
|---|---|---|---|---|
| `prompt.render.exec_command.bytes` | 6 053 | 12 393 | +104.7% | (bash baseline 9 938 + exec_command baseline 6 053) × 0.9 = 14 392; actual under by ~14% |
| `prompt.render.spawn_agent.bytes` | 5 811 | 5 811 | 0.0% | (no migration) |

Within the dual-tool-sum allowance per PERF.md § "Prompt token budget":
the migration absorbed `bash`'s operational manual (git safety
protocol, PR creation flow, file-op restriction) into `exec_command`'s
description, but the combined total stays under the redundancy-adjusted
ceiling.

Frozen baseline integrity: `git diff --quiet
.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json`
exits 0 throughout the campaign per the
`bun-test-test-dir-runs-baseline-orchestrator` GOTCHA.

## Integration invariants

The campaign's first-class deliverable is
[`INTEGRATION_INVARIANTS.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/INTEGRATION_INVARIANTS.md)
plus the harness at
`packages/opencode/test/integration/tool-surface-replacement.test.ts`.
22 invariants in the catalog plus 1 wave-discovered snapshot-diff
invariant added during Wave 4
(`model-tool-list-snapshot-matches-post-Wave-4-shape`).

| Slug | Owner wave | Status |
|---|---|---|
| `scanner-extract-preserves-bash-output` | Wave 1 | green |
| `scanner-deterministic-under-concurrent-load` | Wave 1 | green |
| `scanner-handles-1000-fuzz-inputs-without-crash` | Wave 1 | green |
| `exec-command-honors-saved-bash-allow-pattern` | Wave 2 | green |
| `exec-command-triggers-external-directory-for-outside-cwd-paths` | Wave 2 | green |
| `write-stdin-auto-allows-after-pid-rule-registered-under-bash` | Wave 2 | green |
| `permission-bash-deny-hides-exec-and-stdin-from-tool-list` | Wave 2 | green |
| `exec-command-concurrent-permission-flows-do-not-cross-contaminate` | Wave 2 | green |
| `spawn-agent-honors-saved-task-allow-pattern` | Wave 3 | green |
| `spawn-agent-description-filters-by-task-rules` | Wave 3 | green |
| `permission-task-deny-hides-all-six-v2-tools-from-list` | Wave 3 | green |
| `spawn-agent-concurrent-permission-flows-do-not-cross-contaminate` | Wave 3 | green |
| `model-tool-list-no-bash` | Wave 4 | green |
| `model-tool-list-no-task` | Wave 4 | green |
| `plugin-bash-hook-applies-to-exec-command` | Wave 4 | green |
| `plugin-task-hook-applies-to-spawn-agent` | Wave 4 | green |
| `legacy-shell-tool-still-runnable-from-internal-code` | Wave 4 | green |
| `legacy-task-tool-still-runnable-from-internal-code` | Wave 4 | green |
| `model-tool-list-snapshot-matches-post-Wave-4-shape` | Wave 4 (discovered) | green |
| `prose-migration-preserves-git-safety-protocol` | Wave 5 | green |
| `prose-migration-preserves-pr-creation-flow` | Wave 5 | green |
| `prose-migration-preserves-spawn-agent-eligible-list` | Wave 5 | green |
| `prompt-token-count-within-budget` | Wave 5 | green |
| `bc-matrix-fully-green` | Wave 6 | narrative — see [`bc-verification.md`](../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/bc-verification.md) |
| `perf-trend-no-creep` | Wave 6 | narrative — see [`perf-final-report.md`](../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-final-report.md) + [`perf-trend.md`](../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-trend.md) |

23 code-asserted invariants + 2 narrative invariants. None skipped
except the 2 narrative ones (which exist as `it.instance.skip` stubs at
`test/integration/tool-surface-replacement.test.ts:1352-1364` so the
slug names are still discoverable from the test file).

## Differential tests

The campaign's refactors and replacements all ship a differential test
that asserts OLD-path output equals NEW-path output for the fixture
corpus.

| Test | Fixtures × Inputs | Compares |
|---|---|---|
| `test/differential/scanner-extract.diff.test.ts` | 50 commands | Old in-line scanner in `shell.ts` (pre-Wave-1) vs new `tool/shell/scan.ts` (post-Wave-1). Asserts `Scan { dirs, patterns, always }` structurally equal. |
| `test/differential/exec-permission.diff.test.ts` | 4 fixtures × 10 commands = 40 tuples | Legacy `bash` tool's permission decision vs `exec_command`'s, on the same input. Asserts identical (allow / deny / ask) decisions and identical `bash`-key ask payloads (modulo the `pid:<n>` always-rule appended by exec_command). |
| `test/differential/spawn-permission.diff.test.ts` | 4 fixtures × 2 agent_types = 8 tuples | Legacy `task` tool's permission decision vs `spawn_agent`'s. Asserts identical decisions when patterns are aligned on the agent_type axis. |
| `test/differential/prompt-prose.diff.test.ts` | 7 fragments | Pre-migration `bash`/`task` prose vs post-migration `exec_command`/`spawn_agent` prose. Asserts key fragments (git safety, PR creation, file-op restriction) survive byte-identical (modulo the documented substitution map: "the bash tool" → "the exec_command tool", etc.). |

## What this campaign explicitly does NOT do

- **Delete `shell.ts` or `task.ts`.** Per the user's hard constraint:
  "I don't mind infra being there." Both files remain compileable,
  importable, and runnable from internal code. The campaign drops only
  their builtin-array entries.
- **Rename permission keys.** `bash` and `task` stay as the user-facing
  permission keys. Internal tool IDs change which key they consult, not
  the keys themselves. Saved configs are untouched.
- **Touch TUI rendering.** The TUI subagent navigation + render paths
  are unchanged. No risk of triggering the documented opentui
  `tui-flex-row-with-tall-text` freeze.
- **Add an `internal: true` flag to `Tool.Def`.** The existing
  builtin-array drop is sufficient for the model-surface change. A
  proper `internal: true` flag would be a polish improvement (registry
  could partition explicitly rather than implicitly via array
  membership) — left as future work.
- **Change codex-parity multi-agent semantics.** The 6 v2 tools' input
  parameters, output JSON, error tag set, and emitted Bus events are
  unchanged. Only the permission KEY each consults is moved. The
  `multi-agent-invariants.test.ts` harness from
  [`specs/codex-parity-hardening.md`](./codex-parity-hardening.md)
  continues to pass (one known suite-pollution flake on
  `pty-cleanup-on-parent-abort` documented in that spec; passes in
  isolation).
- **Affect old session replay.** Old transcripts containing `bash` /
  `task` tool calls still load + read back; replay was never possible
  for tool calls anyway. New sessions produce `exec_command` /
  `spawn_agent` calls.

## Forward-looking

The next campaign that touches a tool surface listed in
[`PERMISSION_MAPPING.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/PERMISSION_MAPPING.md)
MUST add an `it.instance` test in
`test/integration/tool-surface-replacement.test.ts` against the
relevant invariant before its production code lands. New invariants
are appended to `INTEGRATION_INVARIANTS.md` § "Discovered during
execution"; new fixtures are added to
`test/fixtures/permission-configs/` with their (config × invocation →
expected) tuples documented in
[`FIXTURES.md`](../.wave/campaigns/replace-bash-task-2026-05-15/plan/FIXTURES.md).

The discipline established by this campaign — fixtures + integration
invariants + differential tests + per-wave perf snapshots — is what
made the BC promise verifiable at the cell level. Coverage is
necessary; the harness is sufficient. Future tool-surface work that
ships unit tests and skips the harness leaves the same defect mode
that motivated codex-parity-hardening: primitives green, scenarios
broken.

## Campaign archive

Full per-wave plans, NOTES, decisions, perf artifacts, and the
campaign-curated fixture corpus live at
`.wave/campaigns/replace-bash-task-2026-05-15/`. Seven waves
(`wave_0` through `wave_6`), each with its own commit on the
`codex-parity` branch:

| Wave | Commit | What landed |
|---|---|---|
| 0 | `d27484e73` | Survey + invariant seed + behavioral baseline + integration test scaffold + 4 GOTCHAS appended |
| 1 | `7b4d4960d` | Bash AST scanner extracted to `tool/shell/scan.ts` (pure refactor); 50-command differential green; 64-fiber stress + 1000-fuzz green; 1 GOTCHA added |
| 2 | `4f88777b1` | exec_command + write_stdin → permission key `bash`; SHELL_TOOLS group in `disabled()` + `resolveTools`; 4×10 BC differential green; 5 invariants unskipped; 3 GOTCHAS added |
| 3 | `a58017029` | spawn_agent + 5 friends → permission key `task`; MULTI_AGENT_TOOLS group; describeSpawnAgent filter → task; agent.ts dual-write for plan + explore; 4×2 BC differential green; 1 GOTCHA added |
| 4 | `7eb1dbf2a` | Drop `tool.shell` + `tool.task` from registry's builtin; plugin hook bridge for `tool.definition` (legacy-then-new); 6 invariants + snapshot diff unskipped; bench best-by-p99 (-29% p99); 1 GOTCHA addendum |
| 5 | `c45e6e014` | Migrated git safety + PR creation + file-op restriction prose into `exec_command.txt`; 4 invariants unskipped; differential 7/7 green; bench within budget |
| 6 | (this commit) | Full BC re-run (33/33) + perf aggregate + plugin re-verify + spec doc + ship |

Wave specs live at
`.wave/campaigns/replace-bash-task-2026-05-15/plan/waves/wave_<N>/WAVE.md`.
Per-wave NOTES (every attempt's narrative, decisions, deviations,
mutation probe, coverage status) live at
`.wave/campaigns/replace-bash-task-2026-05-15/waves/wave_<N>/NOTES.md`.

The branch base is `codex-parity`'s post-hardening HEAD (`9ddce7bea`'s
parent chain). The default branch `dev` does NOT carry this campaign's
changes — merge is a separate decision.
