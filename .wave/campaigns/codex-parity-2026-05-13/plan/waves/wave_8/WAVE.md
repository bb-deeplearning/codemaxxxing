# Wave 8 — Six multi-agent v2 tools

**Prior waves:** 0-7. AgentControl service is live with `spawnAgent`, `sendInterAgentCommunication`, `closeAgent`, `listAgents`, `resolveAgentReference`, `subscribeMailboxSeq`, `hasPendingMailboxItems`, `drainMailbox`.

**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`, `MESSAGE_SHAPES.md`, `TOOL_SCHEMAS.md`, `PROMPT_ENGINEERING.md`, `BACKWARD_COMPAT.md`, `REFERENCES.md`.

**Permission keys** (per `MESSAGE_SHAPES.md`): match tool names exactly — `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`. NOT `agent_spawn` etc.

**Codex source for each tool's exact semantics + JSON schema** (you write the prose; semantics match):
- `multi_agents_v2/spawn.rs` (308 lines)
- `multi_agents_v2/send_message.rs` (41 lines) + `message_tool.rs` (143 lines)
- `multi_agents_v2/followup_task.rs` (41 lines) + `message_tool.rs`
- `multi_agents_v2/wait.rs` (160 lines)
- `multi_agents_v2/list_agents.rs` (78 lines)
- `multi_agents_v2/close_agent.rs` (148 lines)
- `multi_agents_spec.rs` (773 lines) — JSON schema source for all six

## Goal

Build six new model-facing tools backed by `AgentControl`. Each tool is independent in code (separate file, separate handler) but shares the same dispatch surface (the registry, the path resolver, the mailbox).

The semantics come from codex; the prose comes from you per `PROMPT_ENGINEERING.md`. **Description quality is the make-or-break signal here** — junior-tier prompts on the multi-agent surface lead to either runaway spawning or zero spawning, both of which destroy product UX.

## Parallelism

Six tools, six independent files, no shared mutable state at the tool layer. Dispatch six parallel sub-agents — one per tool — each owns its tool file + tests + schema + prose. Each runs full TDD on their tool; they do not run global typecheck/lint.

After all six return, you (the parent agent) run global typecheck/lint, run any cross-tool integration tests, register all six in the toolset, and verify.

Standard sub-agent dispatch protocol applies (see AGENT_INSTRUCTIONS.md). Each sub-agent prompt MUST paste the relevant section of TOOL_SCHEMAS.md + PROMPT_ENGINEERING.md verbatim and include the codex source path for their tool.

## Tasks (per tool — same shape for all six)

- Read the codex source for the tool. Internalize: parameter names, defaults, output schema, error mapping, lifecycle event emissions.
- Write tests first. Cover: schema shape, behavior, edge cases, errors. See `TDD.md` § "Edge cases — required" for the floor.
- Implement the tool definition (`Tool.define` per the existing pattern in `tool/shell.ts` and `tool/task.ts`).
- Write the tool description (codex-quality, codemaxxxing voice). Use the per-tool sketch in `TOOL_SCHEMAS.md` as the operational scope to cover.
- Write the param descriptions (each one teaches, not labels — see `PROMPT_ENGINEERING.md`).
- Wire the handler to AgentControl methods.
- Verify schema shape with structural assertions (not full snapshots).

## Cross-cutting tasks (sequential after sub-agents return)

- Register all six tools in `packages/opencode/src/tool/registry.ts`
- Add new permission keys (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`) to default rulesets — Wave 12 handles per-built-in agent overrides; this wave just defaults them to `"ask"` so nothing's silently allowed
- Add an integration test that walks all six in sequence: spawn → send_message → list_agents → wait_agent → followup_task → close_agent

## Gotchas

1. **Tool name strings match codex.** `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`. No renames. Models trained on codex traces use these names.

2. **`task_name` validation.** `[a-z0-9_]+` only. Reject other characters. The validation belongs in `AgentPath.join` (Wave 5) — call it and surface the error to the model.

3. **Path resolution semantics.** Relative names (e.g. `worker_1`) resolve against the calling agent's path. Canonical paths (e.g. `/root/explorers/worker_1`) are absolute. Both must work in `target` params for send/followup/close. Use `AgentControl.resolveAgentReference`.

4. **`followup_task` cannot target root.** Codex enforces this; we must too. Surface as `RespondToModel` error.

5. **`wait_agent` returns SUMMARY not CONTENT.** The model reads actual mail in its next turn (drained by Wave 9's runLoop integration). The `message` field is something like `"mailbox updates available"` or `"timed out"` — short.

6. **`close_agent` cascades.** Closing `/root/a` also closes `/root/a/b`, `/root/a/c`, etc. AgentControl handles the cascade; the tool just calls `closeAgent`.

7. **Description prose floor.** Re-read `PROMPT_ENGINEERING.md` § "Keep length proportional to complexity". `spawn_agent` is the longest (~60-90 lines); the others vary. Junior-tier ("This tool spawns an agent") is a wave failure.

8. **Param descriptions teach, not label.** Every param description is read by the model when it builds the call. See examples in `PROMPT_ENGINEERING.md`.

9. **Output schemas are verbatim.** Field names, nullability, types match codex `multi_agents_spec.rs:289-477`. Tests assert this with structural checks.

10. **Backward compat.** Adding tools is additive. Don't touch `task.ts`. Don't change `Tool.define` or `Tool.Context`.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# Per-tool tests (each sub-agent's coverage)
bun test src/tool/agent-spawn/
bun test src/tool/agent-send/
bun test src/tool/agent-followup/
bun test src/tool/agent-wait/
bun test src/tool/agent-list/
bun test src/tool/agent-close/

# 100% coverage on every new file
bun test --coverage src/tool/agent-spawn/
# ... etc for all six

# Cross-tool integration
bun test test/integration/multi-agent-tools.test.ts

# Existing task tool unaffected
bun test src/tool/task.test.ts  # if it exists
```

All exit 0.

## Files

New (per tool, replace `<name>` with each of `agent-spawn`, `agent-send`, `agent-followup`, `agent-wait`, `agent-list`, `agent-close`):
- `packages/opencode/src/tool/<name>/index.ts` (or `<name>.ts` — pick a consistent shape, file the same as `tool/process/exec-command.ts` or `tool/task.ts`)
- `packages/opencode/src/tool/<name>/prompt.ts` (or `.txt` — match the existing pattern for the rest of the codebase)
- `packages/opencode/src/tool/<name>/<name>.test.ts`
- `packages/opencode/src/tool/<name>/schema.test.ts`

Plus:
- `packages/opencode/test/integration/multi-agent-tools.test.ts`

Modified:
- `packages/opencode/src/tool/registry.ts` — register six new tools
- `packages/opencode/src/agent/agent.ts` — add the six new permission keys to defaults at `"ask"`; per-agent overrides happen in Wave 12

(No perf bench in this wave — the tools are thin wrappers around AgentControl, which Wave 7 benched. Wave 14's E2E suite covers concurrent multi-agent perf.)
