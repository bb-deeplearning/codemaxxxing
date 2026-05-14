# Overview

## What this campaign does

Removes the legacy `shell` (id `bash`) and `task` tools from the **model-facing tool list** while preserving every BC affordance their callers depend on. The codex-ported `exec_command`/`write_stdin` and the v2 multi-agent tools (`spawn_agent`/`send_message`/`followup_task`/`wait_agent`/`list_agents`/`close_agent`) become the only model-visible surfaces in their respective categories.

The codex ports were intended as **upgrades, not alternatives**. Opencode shipped them as alternatives by mistake (flat builtin list with everything exposed). Two consequences:

1. **Decision overload.** Model spends inference budget choosing between `bash` and `exec_command`, between `task` and `spawn_agent`. Codex itself avoids this — it picks one shell-flavored surface and one agent-spawning surface via config (`ConfigShellToolType`, `multi_agent_v2`) and exposes only the chosen one.
2. **Uneven permission UX on the new tools.** `exec_command`'s permission flow is a single raw-cmd pattern + `pid:<n>` always-rule. `bash`'s flow is bash AST → `BashArity.prefix(...)`-derived patterns + file-touch-detection → `external_directory` prompt. The richer flow has been live for months and shapes every saved permission users have built up.

This campaign reverses the alternative-style exposure while preserving every existing config behavior. No user edits anything. Every saved `permission.bash: { "git *": "allow" }` rule transparently auto-allows `exec_command(cmd: "git status")`. Every `permission.task: { "explore": "allow" }` auto-allows `spawn_agent(agent_type: "explore")`.

## Existing infrastructure (current state)

Tool surface (`packages/opencode/src/tool/`):
- `shell.ts` (631 lines) — exposed to model as id `"bash"` (`shell/id.ts:14-16` keeps the ID for "compatibility with existing plugins, users, and saved permissions"). Tree-sitter bash AST parse, `BashArity.prefix` pattern derivation, file-touch detection (`FILES`, `CWD`, `CMD_FILES` sets), CWD-change tracking, `external_directory` prompt.
- `process/exec-command.ts` (243 lines) + `process/write-stdin.ts` — codex-ported persistent PTY tools. Permission key currently `"exec_command"`. Single raw-cmd pattern in `ctx.ask`. `pid:<n>` per-process always-rule.
- `task.ts` — exposed to model as id `"task"`. Single-shot subagent spawn, blocks until done, returns `<task_result>` envelope. Per-subagent-type permission filter via `Permission.evaluate("task", item.name, ...)` at `registry.ts:310`.
- `agent-spawn/agent-spawn.ts` + `agent-send/`, `agent-followup/`, `agent-wait/`, `agent-list/`, `agent-close/` — six v2 multi-agent tools. `spawn_agent`'s permission filter uses `Permission.evaluate("spawn_agent", item.name, ...)` at `registry.ts:329`. **All six tools call `ctx.ask` per invocation today**, each under its own per-tool permission key (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`) — see e.g. `agent-send.ts:28,92`, `agent-wait.ts:33,79`. The 5 friends' patterns are usually `[params.target]` or `[params.path_prefix ?? "*"]` or `[`timeout:${ms}`]` with `always: ["*"]`. After Wave 3, all 6 tools' per-call asks consult permission key `task` (mirroring `EDIT_TOOLS` collapsing 3 IDs onto key `edit`).
- `registry.ts:250-269` — flat builtin array. Currently includes BOTH legacy and new tools.

Permission system (`packages/opencode/src/permission/`):
- `index.ts:309-320` — `disabled()` walks each tool ID, looks up its permission rule. Special-cases `EDIT_TOOLS = ["edit", "write", "apply_patch"]` → all three map to permission key `"edit"`. This is the lever for our `SHELL_TOOLS` and `MULTI_AGENT_TOOLS` extensions.
- `evaluate.ts` — single function: walk ruleset by `Wildcard.match` on (permission, pattern). `findLast` wins.
- `index.ts:283-303` — `fromConfig(permission)` parses user/agent config into a `Ruleset`. Per-key map of `{ pattern: action }` plus shorthand string-action.

Session/agent integration:
- `session/llm.ts:450-456` — `resolveTools` filters builtin list by user `tools.bash !== false` and `Permission.disabled` rules.
- `agent/agent.ts` — `defaults` ruleset (around line 92) holds per-tool default actions: `bash: "ask"`, `exec_command: "ask"`, `task: "ask"`, `spawn_agent: "ask"`, etc. Plan mode (line 159+) overrides per-tool to deny edits; this campaign extends those overrides to keep parity for the new keys.

## Hard constraints

- **No deletions of `shell.ts` or `task.ts`.** Per user instruction: "I don't mind infra being there." The campaign drops their entries from the registry's builtin array; the files remain.
- **No permission key migration.** `bash` and `task` stay as the user-facing permission keys. Internal tool IDs change which key they consult, not the keys themselves. Saved configs are untouched.
- **No Drizzle migrations.** All change is in-memory (registry + permission key resolution).
- **Plugin hooks for tool IDs `bash` and `task` continue to fire.** Wave 4 adds a bridge so plugins that mutate `bash`'s description still affect `exec_command`'s, and similarly for `task` → `spawn_agent`. The bridge is documented; plugins MAY migrate to keying on the new IDs but are not required to.
- **No regressions on the legacy paths.** `shell.ts` and `task.ts` remain compileable, importable, and runnable from internal code. Their tests stay green.

## Campaign hot paths

The hot paths this campaign touches:

1. **`tool/shell.ts` permission scan** — runs once per shell tool call. AST parse + walk + pattern derivation. Will move to `tool/shell/scan.ts` (Wave 1) and start running for every `exec_command` call (Wave 2). New per-call cost.
2. **`tool/process/exec-command.ts`** — its `ctx.ask` payload changes shape (Wave 2: now includes AST patterns + dirs).
3. **`tool/registry.ts:341` `tools()`** — runs once per agent turn to filter the model's tool list. Wave 4 changes the filter to drop legacy IDs. Hot.
4. **`session/llm.ts:450` `resolveTools`** — runs once per turn. Adds SHELL_TOOLS/MULTI_AGENT_TOOLS group handling (Wave 2/3).
5. **`permission/index.ts:309` `disabled`** — runs once per turn. Adds two more category mappings (Wave 2/3).

Bench coverage in `PERF.md`. Frozen baseline lives at `artifacts/baseline-perf.json` (Wave 0 captures).

## Cross-cutting reference docs

Read on every relevant wave (the WAVE.md tells you which):

- `OVERVIEW.md` (this file) — every wave reads this.
- `STYLE.md` — codebase idioms (Effect v4, InstanceState, module shape).
- `TDD.md` — test-first discipline + integration-first + differential + property + fixtures + mutation probe.
- `PERF.md` — bench harness + budget + frozen baseline + trend tracking.
- `BACKWARD_COMPAT.md` — the BC matrix this campaign exists to preserve. Headline document.
- `INTEGRATION_INVARIANTS.md` — scenario invariants every wave's tests must satisfy.
- `PERMISSION_MAPPING.md` — single source of truth for which tool ID consults which permission key, before and after each wave.
- `FIXTURES.md` — concrete user-config fixtures used as golden inputs across waves.
- `REFERENCES.md` — codex source paths, prior campaign artifacts, repo file:line references.

## Sequencing

Sequential. Each wave depends on prior waves' artifacts:

- Wave 0 captures the behavioral + perf baseline. Every later wave compares against Wave 0's outputs.
- Wave 1 extracts the scanner. Wave 2 wires it into exec_command. Wave 3 mirrors the pattern for spawn_agent.
- Wave 4 drops the registry entries. Wave 5 migrates prose. Wave 6 verifies + ships.

No internal parallelism within a wave unless explicitly authorized by that wave's WAVE.md (mostly Wave 0 and Wave 5 use sub-agent parallelism).

## Glossary

- **Permission key** — the string passed to `ctx.ask({ permission })` and matched in `evaluate(permission, pattern, ...)`. Stable and user-facing. `bash`, `task`, `edit`, `external_directory` are the four that matter here.
- **Tool ID** — the registry key. `tool.shell.id === "bash"`, `tool.task.id === "task"`, `tool.execcommand.id === "exec_command"`, `tool.agentspawn.id === "spawn_agent"`. The model sees these in its tool list.
- **Pattern** — the second axis of permission lookup. `git status` matches `git *`. AST-derived patterns (e.g. `BashArity.prefix(["git","status"]).join(" ") + " *"` → `"git *"`) generalize across flag variations.
- **`pid:<n>` rule** — a synthetic always-pattern registered by `exec_command` so `write_stdin` against the same process auto-allows. Currently keyed under `exec_command`; Wave 2 moves to `bash`.
- **Differential test** — runs the OLD and NEW code paths on the same input fixture, asserts identical output. Used as primary verification for refactors.
- **Behavioral baseline** — Wave 0's snapshot of pre-change observable artifacts (model tool list per agent, rendered permission prompts, prompt token counts, Bus event sequences). Later waves diff against this.
