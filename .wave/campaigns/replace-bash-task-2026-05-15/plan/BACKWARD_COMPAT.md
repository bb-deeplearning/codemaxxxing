# Backward compatibility — the BC matrix this campaign exists to preserve

This is the campaign's headline document. Every wave's verification asserts the matrix below holds. A single failed cell = wave failure.

The matrix is enumerated as concrete (input config × invocation × expected outcome) tuples. Each tuple has a corresponding fixture in `FIXTURES.md` and a corresponding integration test in `test/integration/tool-surface-replacement.test.ts`. No hand-waving — if a row isn't covered by a green test, the BC promise isn't real.

## Saved permission rules — bash key

| Saved config | Invocation | Expected decision |
|---|---|---|
| `permission.bash: { "git *": "allow" }` | `exec_command(cmd: "git status")` | `allow` (auto, no prompt) |
| `permission.bash: { "git *": "allow" }` | `exec_command(cmd: "git status -s")` | `allow` (AST normalizes flag variation) |
| `permission.bash: { "git push": "deny" }` | `exec_command(cmd: "git push origin main")` | `deny` |
| `permission.bash: { "rm *": "ask" }` | `exec_command(cmd: "rm /tmp/foo")` | `ask` (prompt; AST scan also adds `/tmp` to `external_directory`) |
| `permission.bash: "allow"` | `exec_command(cmd: "anything")` | `allow` |
| `permission.bash: { "*": "deny" }` | model's tool list | does NOT contain `exec_command` or `write_stdin` |
| `permission.bash: { "*": "deny" }` (agent-level) | model's tool list for that agent | does NOT contain `exec_command` or `write_stdin` |
| `tools: { bash: false }` (user-level) | model's tool list | does NOT contain `exec_command` or `write_stdin` |

## Saved permission rules — task key

| Saved config | Invocation | Expected decision |
|---|---|---|
| `permission.task: { "explore": "allow" }` | `spawn_agent(agent_type: "explore", ...)` | `allow` (auto, no prompt) |
| `permission.task: { "explore": "allow" }` | `spawn_agent(agent_type: "general", ...)` | `ask` (default for unlisted) |
| `permission.task: { "explore": "deny" }` | `spawn_agent` description | does NOT list `explore` as eligible |
| `permission.task: "allow"` | `spawn_agent(agent_type: any)` | `allow` |
| `permission.task: { "*": "deny" }` | model's tool list | does NOT contain `spawn_agent` or `send_message` or `followup_task` or `wait_agent` or `list_agents` or `close_agent` |
| `permission.task: { "*": "deny" }` (agent-level) | model's tool list for that agent | does NOT contain any of the 6 v2 tools |
| `tools: { task: false }` (user-level) | model's tool list | does NOT contain any of the 6 v2 tools |

## Persistent process semantics — pid:N rule

| Sequence | Expected behavior |
|---|---|
| `exec_command(cmd: "node repl")` → user picks "always" → `write_stdin(session_id: N, ...)` | second call auto-allows (no prompt) — `pid:N` always-rule was registered under `bash` key |
| `exec_command(cmd: "node repl")` → user picks "once" → `write_stdin(session_id: N, ...)` | second call prompts again — `pid:N` was not registered |
| `exec_command(cmd: "node repl")` exits → `write_stdin(session_id: N, ...)` | returns "Unknown process id N" error (process gone) |

## File-touch detection (external_directory)

| Invocation | Expected ctx.ask sequence |
|---|---|
| `exec_command(cmd: "rm /tmp/foo")` | TWO asks: `external_directory` for `/tmp` AND `bash` for `rm *` |
| `exec_command(cmd: "rm ./foo")` (cwd = workspace) | ONE ask: `bash` for `rm *` (path inside workspace, no external_directory) |
| `exec_command(cmd: "cd /home/user")` (cwd = workspace) | TWO asks: `external_directory` for `/home/user` AND `bash` for `cd *` |
| `exec_command(cmd: "git status")` | ONE ask: `bash` for `git *` (no file-touch verb) |

The order of the asks must match `bash`'s order today: `external_directory` first, then `bash`. Verified by snapshot in Wave 0 + diff in Wave 2.

## Plugin hook compatibility

| Plugin behavior pre-campaign | Behavior post-campaign |
|---|---|
| Plugin hooks `tool.definition` for tool ID `"bash"` and mutates description | Hook still fires; mutation propagates to `exec_command`'s description (Wave 4 plugin bridge) |
| Plugin hooks `tool.definition` for tool ID `"task"` and mutates description | Hook still fires; mutation propagates to `spawn_agent`'s description |
| Plugin hooks `tool.execute` for tool ID `"bash"` | Hook does NOT fire for `exec_command` (execute is a different surface; execution semantics differ — persistent vs one-shot). Documented as plugin-migration boundary in Wave 4's NOTES. |
| Plugin hooks `shell.env` for cwd | Continues to fire for `exec_command` (already wired in `exec-command.ts:99-103`) |

## Snapshot diffs (Wave 0 captures, Wave 6 verifies)

| Snapshot | Pre-campaign | Post-campaign |
|---|---|---|
| `tools(model)` for `build` agent | includes `bash`, `task`, `exec_command`, `write_stdin`, `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent` | excludes `bash`, `task`; includes the rest |
| `tools(model)` for `caveman` agent | (same as build, with caveman's filtering) | (same minus `bash` and `task`) |
| `tools(model)` for `explore` subagent | (per agent's permission rules) | (per agent's permission rules; subset minus `bash`/`task`) |
| `tools(model)` for `general` subagent | (per agent's permission rules) | (per agent's permission rules; subset minus `bash`/`task`) |
| `tools(model)` for `plan` agent | excludes edit tools | excludes edit tools AND `bash`/`task` |
| Rendered `bash` permission prompt for `git status` | (captured) | rendered as `exec_command` permission prompt for `git status` — same `bash` permission key, same patterns, same metadata except `tty`/`workdir` shape |
| `bash` tool description token count | (captured) | `exec_command` tool description token count must be within ±5% of (`bash` baseline + `exec_command` baseline) per PERF.md |

## Out of scope (NOT promised, document in NOTES if user reports breakage)

- Old session replay where the model previously called `bash` or `task` — those tool calls already exist in transcripts and don't replay anyway. Read-back of the transcript still works; rerun produces the new tool ID.
- Custom agent prompts that explicitly mention "use the bash tool" or "use the task tool" by name — model self-corrects to the available tool. Soft-BC concern. Wave 6's spec doc includes a CHANGES note advising updates.
- Plugin hooks targeting `tool.execute` for `bash`/`task` — execute semantics differ (one-shot vs persistent). Plugins must migrate. Wave 6 spec doc documents this.
- Saved `permission.spawn_agent: ...`, `permission.send_message: ...`, `permission.followup_task: ...`, `permission.wait_agent: ...`, `permission.list_agents: ...`, `permission.close_agent: ...` rules — Wave 3 collapses all six v2 multi-agent tools' per-call asks onto permission key `task`, mirroring EDIT_TOOLS (`edit`/`write`/`apply_patch` all consult `edit`). Saved per-friend rules silently stop matching after Wave 3; the user must restate the intent under `permission.task`. Wave 6 spec doc documents the migration. Same precedent as EDIT_TOOLS — no fixture in `FIXTURES.md` asserts per-friend-key gating because the pre-campaign behavior is itself an unintentional artifact, not a feature to preserve.

## How each wave verifies its slice

- **Wave 0** — captures all snapshots into `artifacts/snapshots/`. No verification yet.
- **Wave 1** — pure refactor of scanner. `bash` tool's behavior must remain identical (its existing tests stay green; differential test asserts `bash`'s `Scan` output is unchanged).
- **Wave 2** — every "bash key" row above becomes a green integration test. Every "external_directory" row green. Every "pid:N" row green. Differential vs `bash`'s permission flow.
- **Wave 3** — every "task key" row green. Differential vs `task`'s permission flow.
- **Wave 4** — every "tool list" row in the snapshot table green. Plugin contract tests green. Snapshot diff matches the table above.
- **Wave 5** — prompt token count rows green. Differential prose test asserts key fragments survive.
- **Wave 6** — re-runs the entire BC matrix. Single failure = wave failure.
