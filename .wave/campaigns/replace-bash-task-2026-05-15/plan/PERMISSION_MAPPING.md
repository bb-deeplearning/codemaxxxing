# Permission mapping — single source of truth

Lists which tool ID consults which permission key, before and after each wave. The reader maintains this mental model; deviations from this table = wave failure.

## Permission key vs tool ID — fundamentals

A permission key is the first axis of `evaluate(permission, pattern, ruleset)`. Stable, user-facing, written into user/agent configs. Examples: `bash`, `task`, `edit`, `external_directory`, `webfetch`, `read`.

A tool ID is the second-axis registry key the model sees in its tool list. Examples: `bash`, `task`, `read`, `edit`, `webfetch`, `exec_command`, `write_stdin`, `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`.

The two coincide for most tools (tool `read` consults permission `read`). The exceptions matter:

- `EDIT_TOOLS = ["edit", "write", "apply_patch"]` all consult permission key `edit` (per `permission/index.ts:309`).
- After this campaign: `SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]` all consult permission key `bash`. `MULTI_AGENT_TOOLS = ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent"]` all consult permission key `task`.

## Pre-campaign mapping

| Tool ID | `ctx.ask` permission key | `Permission.disabled` lookup key | `resolveTools` user-config key |
|---|---|---|---|
| `bash` | `bash` | `bash` | `bash` |
| `task` | `task` (per-subagent-type via `Permission.evaluate("task", item.name, ...)` filter at `registry.ts:310`) | `task` | `task` |
| `read` | `read` | `read` | `read` |
| `edit` | `edit` | `edit` (via EDIT_TOOLS group) | `edit` |
| `write` | `edit` | `edit` (via EDIT_TOOLS group) | `write` |
| `apply_patch` | `edit` | `edit` (via EDIT_TOOLS group) | `apply_patch` |
| `webfetch` | `webfetch` | `webfetch` | `webfetch` |
| `websearch` | `websearch` | `websearch` | `websearch` |
| `exec_command` | `exec_command` (per `tool/process/id.ts:PermissionKey`) | `exec_command` | `exec_command` |
| `write_stdin` | `exec_command` (shared with above) | `write_stdin` (per its own ID) | `write_stdin` |
| `spawn_agent` | `spawn_agent` (per-agent-type via `Permission.evaluate("spawn_agent", item.name, ...)` filter at `registry.ts:329`) | `spawn_agent` | `spawn_agent` |
| `send_message` | `send_message` (per-call ask at `agent-send.ts:91-99`, patterns: `[params.target]`, always: `["*"]`) | `send_message` | `send_message` |
| `followup_task` | `followup_task` (per-call ask at `agent-followup.ts:95-103`, patterns: `[params.target]`, always: `["*"]`) | `followup_task` | `followup_task` |
| `wait_agent` | `wait_agent` (per-call ask at `agent-wait.ts:78-83`, patterns: `[`timeout:${timeoutMs}`]`, always: `["*"]`) | `wait_agent` | `wait_agent` |
| `list_agents` | `list_agents` (per-call ask at `agent-list.ts:51-56`, patterns: `[params.path_prefix ?? "*"]`, always: `["*"]`) | `list_agents` | `list_agents` |
| `close_agent` | `close_agent` (per-call ask at `agent-close.ts:80-85`, patterns: `[params.target]`, always: `["*"]`) | `close_agent` | `close_agent` |

Visible problems with the current state:
- `exec_command` and `write_stdin` consult `exec_command` for asks but `write_stdin` is its own key in `Permission.disabled`. Asymmetric.
- `bash` saved patterns don't apply to `exec_command` even though they cover the same operational shape.
- `task` saved per-subagent-type patterns don't apply to `spawn_agent` even though they cover the same operational shape.
- The 6 v2 multi-agent tools have no group treatment in `Permission.disabled`, so a config saying "deny task" hides only `task` and not `spawn_agent`/etc.
- Each of the 6 v2 multi-agent tools consults its own per-call permission key. A user-config saying "deny `permission.task`" does not gate the per-call asks of `spawn_agent`/`send_message`/etc., only their tool-list visibility (and only after Wave 3 adds the group). Consistency with the EDIT_TOOLS pattern (3 tools, 1 key) requires collapsing all 6 v2 multi-agent tools' per-call asks onto the `task` key — what Wave 3 does.

## Post-Wave-2 mapping (bash group)

| Tool ID | `ctx.ask` permission key | `Permission.disabled` lookup key | `resolveTools` user-config key |
|---|---|---|---|
| `bash` | `bash` (unchanged) | `bash` (via SHELL_TOOLS group, unchanged effect) | `bash` |
| `exec_command` | **`bash`** (changed) | **`bash`** (via SHELL_TOOLS group, changed) | `exec_command` (literal lookup); ALSO disabled when `tools.bash === false` (Wave 2 adds the group rule) |
| `write_stdin` | **`bash`** (changed) | **`bash`** (via SHELL_TOOLS group, changed) | `write_stdin` (literal lookup); ALSO disabled when `tools.bash === false` |

Defines `SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]` in `permission/index.ts`. Both `Permission.disabled` and `resolveTools` (`session/llm.ts`) consult this set.

## Post-Wave-3 mapping (task group)

| Tool ID | `ctx.ask` permission key | `Permission.disabled` lookup key | `resolveTools` user-config key |
|---|---|---|---|
| `task` | `task` (unchanged) | `task` (via MULTI_AGENT_TOOLS, unchanged effect) | `task` |
| `spawn_agent` | **`task`** (changed from `spawn_agent`) — both for the per-call ask AND for the `describeSpawnAgent` filter at `registry.ts:329` (changed from `spawn_agent` to `task`) | **`task`** (via MULTI_AGENT_TOOLS, changed) | `spawn_agent` literal; ALSO disabled when `tools.task === false` |
| `send_message` | **`task`** (changed from `send_message`; per-call ask at `agent-send.ts:91-99` keeps its patterns/always shape) | **`task`** (via MULTI_AGENT_TOOLS, changed) | as above |
| `followup_task` | **`task`** (changed from `followup_task`; per-call ask at `agent-followup.ts:95-103`) | **`task`** (via MULTI_AGENT_TOOLS, changed) | as above |
| `wait_agent` | **`task`** (changed from `wait_agent`; per-call ask at `agent-wait.ts:78-83`) | **`task`** (via MULTI_AGENT_TOOLS, changed) | as above |
| `list_agents` | **`task`** (changed from `list_agents`; per-call ask at `agent-list.ts:51-56`) | **`task`** (via MULTI_AGENT_TOOLS, changed) | as above |
| `close_agent` | **`task`** (changed from `close_agent`; per-call ask at `agent-close.ts:80-85`) | **`task`** (via MULTI_AGENT_TOOLS, changed) | as above |

Per-call key collapse (all 6 → `task`) is structurally analogous to EDIT_TOOLS (`edit`, `write`, `apply_patch` → `edit`). Each friend tool's `PermissionKey` constant in its own `.ts` file changes from its current value to `"task"`. The `pidPattern`-style ask metadata (patterns + always) does NOT change shape — only the permission KEY moves.

BC implication of the per-call key collapse: a user who today has `permission.send_message: { "*": "deny" }` (or any of the other 4 friend keys) saved in their config will see the rule silently stop matching. This matches the existing EDIT_TOOLS pattern — saved `permission.write: { "*": "deny" }` rules don't gate `write.ts`'s per-call ask either (which has used `permission: "edit"` since launch). Documented as a plugin-migration boundary in BACKWARD_COMPAT.md "Out of scope" + Wave 6 spec doc.

Defines `MULTI_AGENT_TOOLS = ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent"]` in `permission/index.ts`. Both `Permission.disabled` and `resolveTools` consult this set.

## Post-Wave-4 mapping (registry visibility)

No further key changes. Only the model-visible tool list changes:

| Agent | Pre-Wave-4 builtin list | Post-Wave-4 builtin list |
|---|---|---|
| `build` | includes `bash`, `task`, `exec_command`, `write_stdin`, `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`, ... | excludes `bash`, `task`; includes the rest |
| `caveman` | (per its config) | (same minus bash/task) |
| `explore` | (per its config) | (same minus bash/task) |
| `general` | (per its config) | (same minus bash/task) |
| `plan` | (per its config) | (same minus bash/task; edit tools still excluded by plan's existing filter) |

Internally, `tool.shell` and `tool.task` are still bound in `registry.ts:220-226` (so internal callers like the legacy `task` tool's invocation path continue to work). They are dropped only from the `builtin` array on `registry.ts:250-269`.

## Plugin hook bridge (Wave 4)

Plugin hooks for `tool.definition` keyed by tool ID `bash` continue to fire. The bridge in `tools()` dispatches them as if they were keyed by `exec_command`. Same for `task` → `spawn_agent`.

This is one-directional: hooks targeting the new IDs do NOT bridge backward to the legacy ones (no point — the legacy tools aren't model-facing anymore).

The `tool.execute` hook for `bash`/`task` does NOT bridge — execution semantics differ (one-shot vs persistent). Plugins that hook execute must migrate to the new IDs explicitly. Documented as a plugin-migration boundary in Wave 6's spec doc.

## Verification

The mapping above is asserted by:

- Wave 2 — integration tests `exec-command-honors-saved-bash-allow-pattern`, `permission-bash-deny-hides-exec-and-stdin-from-tool-list`, `write-stdin-auto-allows-after-pid-rule-registered-under-bash`.
- Wave 3 — integration tests `spawn-agent-honors-saved-task-allow-pattern`, `spawn-agent-description-filters-by-task-rules`, `permission-task-deny-hides-all-six-v2-tools-from-list`.
- Wave 4 — integration tests `model-tool-list-no-bash`, `model-tool-list-no-task`, `legacy-shell-tool-still-runnable-from-internal-code`, `legacy-task-tool-still-runnable-from-internal-code`, plugin bridge tests.

If a future wave changes any cell in the post-campaign mapping, that wave MUST update this doc as part of its delivery and add the corresponding integration test.
