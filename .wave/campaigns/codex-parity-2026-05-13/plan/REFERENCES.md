# References

Absolute paths to every source file you may need. Use these — do not search.

## Spec source (this repo)

- `/Users/rohan/Documents/Personal/codemaxxxing/specs/codex-parity-handoff.html` — original handoff doc
- `/Users/rohan/Documents/Personal/codemaxxxing/AGENTS.md` — repo-root style guide
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/AGENTS.md` — package conventions, Effect rules, runtime vs InstanceState

## Codex reference (READ-ONLY — never modify)

Repo root: `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex`

### unified_exec subsystem

- `codex-rs/core/src/unified_exec/mod.rs` (183 lines) — types, constants, public surface
- `codex-rs/core/src/unified_exec/process_manager.rs` (1277 lines) — `UnifiedExecProcessManager`, `ProcessStore`, `exec_command`, `write_stdin`, `open_session_with_exec_env`, `terminate_all_processes`. Contains `collect_output_until_deadline` (1071-1158), `prune_processes_if_needed` (1196-1241)
- `codex-rs/core/src/unified_exec/process.rs` (507 lines) — `UnifiedExecProcess` PTY lifecycle, output buffer, exit watcher
- `codex-rs/core/src/unified_exec/process_state.rs` (24 lines) — `ProcessState` exit/failure
- `codex-rs/core/src/unified_exec/head_tail_buffer.rs` (183 lines) — symmetric 50/50 head+tail buffer
- `codex-rs/core/src/unified_exec/head_tail_buffer_tests.rs` — port these tests
- `codex-rs/core/src/unified_exec/async_watcher.rs` (334 lines) — output streaming, exit watcher, UTF-8 splitter
- `codex-rs/core/src/unified_exec/errors.rs` (40 lines) — `UnifiedExecError` variants
- `codex-rs/core/src/tools/handlers/unified_exec.rs` (141 lines) — handler dispatch, args parsing
- `codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs` (353 lines) — `ExecCommandHandler`
- `codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs` (110 lines) — `WriteStdinHandler`
- `codex-rs/core/src/tools/handlers/shell_spec.rs` (453 lines) — JSON tool surfaces. Specifically:
  - `create_exec_command_tool_with_environment_id` (lines 28-110)
  - `create_write_stdin_tool` (lines 112-154)
  - `unified_exec_output_schema` (lines 319-351)

### multi_agents_v2 subsystem

- `codex-rs/core/src/agent/mod.rs` (14 lines) — module exports
- `codex-rs/core/src/agent/control.rs` (1258 lines) — `AgentControl` orchestration
- `codex-rs/core/src/agent/mailbox.rs` (161 lines) — `Mailbox` + `MailboxReceiver`
- `codex-rs/core/src/agent/registry.rs` (344 lines) — `AgentRegistry`, `SpawnReservation`, depth limits
- `codex-rs/core/src/agent/role.rs` (433 lines) — role system, built-in role descriptions (lines 357-414 — verbatim text matters)
- `codex-rs/core/src/agent/status.rs` (28 lines) — `AgentStatus` derivation from events
- `codex-rs/core/src/agent/agent_resolver.rs` (36 lines) — `resolve_agent_target`
- `codex-rs/core/src/agent/builtins/explorer.toml` (empty in current revision)
- `codex-rs/core/src/agent/builtins/awaiter.toml` — awaiter prompt (commented out in role.rs but kept in tree)
- `codex-rs/core/src/session_prefix.rs` (25 lines) — `format_subagent_context_line`, `format_subagent_notification_message`
- `codex-rs/core/src/session/multi_agents.rs` (27 lines) — `usage_hint_text` selector
- `codex-rs/core/src/tools/handlers/multi_agents_v2.rs` (43 lines) — module dispatch
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` (308 lines) — `spawn_agent` handler
- `codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs` (41 lines) — `send_message` handler
- `codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs` (41 lines) — `followup_task` handler
- `codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs` (160 lines) — `wait_agent` handler
- `codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs` (78 lines) — `list_agents` handler
- `codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs` (148 lines) — `close_agent` handler
- `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs` (143 lines) — shared `handle_message_string_tool` for send_message + followup_task
- `codex-rs/core/src/tools/handlers/multi_agents_common.rs` (379 lines) — shared helpers, constants, error mapping
- `codex-rs/core/src/tools/handlers/multi_agents_spec.rs` (773 lines) — JSON tool surfaces. Specifically:
  - `create_spawn_agent_tool_v2` (lines 64-98)
  - `spawn_agent_tool_description_v2` (lines 659-697) — full description text
  - `create_send_message_tool` (lines 134-163)
  - `create_followup_task_tool` (lines 165-190)
  - `create_wait_agent_tool_v2` (lines 222-232)
  - `create_list_agents_tool` (lines 234-253)
  - `create_close_agent_tool_v2` (lines 271-287)
  - All output schemas (lines 289-477)

## Opencode files you will TOUCH

### Pty / unified_exec target

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/pty/index.ts` (368 lines) — extend in Wave 2
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/pty/schema.ts` (16 lines) — extend in Wave 2
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/pty/pty.ts` (25 lines) — platform interface, do not change
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/tool/registry.ts` — register new tools

### Session / runLoop target

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/session/prompt.ts` (1931 lines) — modify integration site at `1485-1488`, mailbox drain at `1521`
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/session/processor.ts` (761 lines) — read for context
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/session/session.ts` (935 lines) — interface reference
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/session/run-state.ts` (110 lines) — Runner pattern (one per session — concurrent siblings each get one)
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/session/message-v2.ts` (1262 lines) — Part schema; `synthetic` flag at line 116
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/session/session.sql.ts` (131 lines) — DB schema, `parent_id` exists

### Agent target

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/agent/agent.ts` (428 lines) — built-in agents, permission rulesets
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/agent/prompt/` — prompt fragments dir

### Permission

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/permission/index.ts` (324 lines) — `Permission.ask`, "always" patterns at line 250
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/permission/evaluate.ts` (15 lines)
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/permission/schema.ts`

### Tool surface

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/tool/tool.ts` (162 lines) — `Tool.define` pattern
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/tool/shell.ts` (631 lines) — reference for one-shot exec tool shape
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/tool/task.ts` (180 lines) — legacy task tool, KEEP working
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/tool/truncate.ts` — output truncation service

### Bus / Events

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/bus/index.ts` (203 lines) — Bus.Service, publish, subscribe
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/bus/bus-event.ts` (51 lines) — `BusEvent.define`
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/v2/event.ts` (53 lines) — `EventV2.define`, `EventV2.run`
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/v2/session-event.ts` (397 lines) — extend with `Agent.*` namespace in Wave 10. The `All` union at line 352 must be updated.

### Effect plumbing

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/effect/instance-state.ts` (83 lines) — per-directory state pattern
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/effect/run-service.ts` (57 lines) — `makeRuntime`
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/effect/bridge.ts` (78 lines) — `EffectBridge.make`
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/effect/runner.ts` (222 lines) — Runner pattern (one per session)

### TUI (touched in Wave 4 + Wave 11)

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` (2915 lines) — main session route. Tool renderers around lines 1995-2025; descendants memo at 197-238; `function Task` at 2556. Adding renderers here is high-risk for perf — read the comments at lines 134-154, 163-170, 240-242 first.
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` (201 lines) — subagent navigation footer
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/cli/cmd/tui/routes/session/dialog-subagent.tsx` (26 lines) — subagent action dialog
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/cli/cmd/tui/context/sync.tsx` (543 lines) — sync store, all per-session fields keyed by sessionID
- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/cli/cmd/tui/util/inline-safe.ts` — read for the render-freeze antipattern background

### Test infrastructure

- `/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/test/lib/effect.ts` — `testEffect` helper (use for Effect-based tests)
- Existing benchmark test patterns — search `**/*.bench.ts` (none today; we are creating the pattern)
