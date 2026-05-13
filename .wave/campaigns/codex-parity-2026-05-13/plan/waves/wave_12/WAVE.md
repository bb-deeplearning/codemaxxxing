# Wave 12 — Permission integration + agent system prompt fragments

**Prior waves:** 0-11. All eight tools live; lifecycle events flow; TUI surfaces siblings.

**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `MESSAGE_SHAPES.md`, `PROMPT_ENGINEERING.md`, `BACKWARD_COMPAT.md`.

**Permission keys are fixed in `MESSAGE_SHAPES.md` § "Permission keys":** `exec_command` (covers both unified_exec tools), `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`. Match these exactly.

**Touch points:**
- `packages/opencode/src/agent/agent.ts` (428 lines) — built-in agent definitions and their permission rulesets (lines 113-238)
- `packages/opencode/src/session/system.ts` — system prompt assembly (read first; not yet read in detail)
- `packages/opencode/src/agent/prompt/` — per-agent prompt fragments
- `packages/opencode/src/permission/...` — permission registry

## Goal

Two things:

1. Lock down per-built-in-agent permissions for all eight new tools (`exec_command` for unified_exec; `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent` for multi-agent v2).
2. Inject system prompt fragments that teach agents about the new capabilities — the equivalent of codex's `multi_agent_v2.root_agent_usage_hint_text` and `subagent_usage_hint_text` from `session/multi_agents.rs`.

The prompts are the higher-stakes deliverable. See `PROMPT_ENGINEERING.md` § "Agent system prompts — making the agents themselves aware".

## Tasks

### 1. Permission audit per built-in

For each built-in agent in `agent/agent.ts:113-238`, decide and implement the permission for each new key. Defaults below; revise per role:

| Permission | build | plan | general | explore | compaction/title/summary |
|---|---|---|---|---|---|
| `exec_command` | allow | deny (read-only mode) | allow | deny (read-only role) | deny |
| `spawn_agent` | allow | deny (plan must use plan_exit) | allow | deny (subagents don't recurse by default) | deny |
| `send_message` | allow | deny | allow | allow (can coordinate with siblings) | deny |
| `followup_task` | allow | deny | allow | allow | deny |
| `wait_agent` | allow | deny | allow | allow | deny |
| `list_agents` | allow | deny | allow | allow | deny |
| `close_agent` | allow | deny | allow | deny | deny |

**Note**: for the `compaction`, `title`, `summary` agents, the existing `*: deny` rule (`agent.ts:201, 217, 233`) already covers all new permissions — no explicit per-key entries needed. For `plan`, the existing `*: deny` on edit + selective allows means plan also implicitly denies the new keys; no change needed unless we want to explicitly allow some.

Wave 3 already added `exec_command: "ask"` to defaults. This wave adds the per-built-in overrides on top.

User can override via config (the existing `permission` config block). Tests verify each built-in's effective ruleset.

### 2. System prompt fragments

Three new fragments per `PROMPT_ENGINEERING.md`:

**Fragment A — Persistent processes guidance** (injected when agent has `exec_command` permission)

Covers: distinction from one-shot `bash` (the existing shell tool); when to reach for persistent processes (REPLs, dev servers, watchers, db shells, ssh); when to stick with `bash`; pure-poll discipline; session_id tracking; processes die when opencode restarts.

**Fragment B — Multi-agent root-agent guidance** (injected when agent is in `primary` mode AND has `spawn_agent` permission)

Covers: mental model (root with concurrent siblings); decision protocol BEFORE spawning (blocking vs sidecar); don't delegate the immediate critical path; common patterns (parallel research, disjoint codebase slices, debate, observer/worker); mailbox semantics (mail appears in next turn's context); don't sit on `wait_agent`; role system selection (default vs explorer vs worker).

**Fragment C — Multi-agent subagent guidance** (injected when agent is in `subagent` mode AND has `send_message` or `wait_agent` permission)

Covers: you're a subagent with bounded task; your path and role; you can spawn (with depth limit) and message peers; close yourself when done; final assistant message goes to spawner.

### 3. Wire fragment injection

The injection point is the system prompt assembly at `prompt.ts:1591-1597`. Existing assembly:

```ts
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
```

Add a fourth layer for capability hints. The hints come from a new helper in `session/system.ts` that takes the agent's permission set and returns the relevant fragment strings.

Tests verify each fragment is injected for the right agent modes and NOT injected for agents lacking the relevant permissions.

### 4. Built-in agent prompt updates

For agents that have a custom `prompt` field (e.g. `explore`, `general`), append a small subagent-aware addendum if appropriate. Don't rewrite the existing prompts — extend.

### 5. Tests

Cover:
- each built-in has the expected ruleset for each new permission (matches the table above)
- Fragment A injected iff `exec_command` is allowed
- Fragment B injected iff agent is `primary` mode with `spawn_agent` allowed
- Fragment C injected iff agent is `subagent` mode with `send_message` or `wait_agent` allowed
- a session's system prompt contains the expected fragments for the assigned agent
- backward compat: a session's system prompt for an agent WITHOUT new permissions matches the pre-wave-12 output exactly

## Gotchas

1. **Permissions are additive in `Permission.merge`.** Order matters: `defaults`, then user config, then per-agent overrides. Match the existing pattern at `agent.ts:118-125`.

2. **Fragment quality is the wave's signal.** Re-read `PROMPT_ENGINEERING.md`. These fragments are the cross-cutting operational manual the model gets. Junior tone here breaks product UX.

3. **Don't break the `plan` agent's existing flow.** Plan currently uses `task` to spawn explorers in phase 1. Wave 9 left legacy task working. Plan stays on legacy task for now; do NOT silently switch plan to v2 spawn. (A future campaign can do that intentionally.)

4. **Fragment injection is gated on permission, not agent name.** A user-defined custom agent that enables `spawn_agent` should also get Fragment B. Drive injection from the permission check, not a hardcoded list.

5. **Backward compat — system prompt regression test.** A session with `agent: "build"` and no new permissions enabled (per user config) produces a system prompt identical to pre-wave-12. Test this with a snapshot — if the snapshot diff shows new fragments injected for an agent that shouldn't get them, the wave fails.

6. **No new Drizzle migrations.** All new agent metadata (nicknames, roles) lives in `Agent.Info` (in-memory). Permission additions are config-driven; existing JSON ruleset accepts new permission keys.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/agent/agent.test.ts
bun test src/session/system.test.ts  # if exists, otherwise create
bun test --coverage src/agent/agent.ts        # 100% on touched code
bun test --coverage src/session/system.ts

# Backward compat snapshot
bun test src/session/system-backward-compat.test.ts  # asserts pre-wave-12 prompts unchanged
```

All exit 0.

## Files

New: tests + new prompt fragment text files (e.g. `packages/opencode/src/agent/prompt/multi-agent-root.txt`, `multi-agent-subagent.txt`, `persistent-processes.txt`).

Modified:
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/session/system.ts`
- (possibly) `packages/opencode/src/permission/...` if a new permission key needs registration
