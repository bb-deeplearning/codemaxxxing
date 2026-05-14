# Wave 3 — Align spawn_agent + 5 friends to `task` permission key + MULTI_AGENT_TOOLS group

<!--
Previous waves: 0, 1, 2.
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../INTEGRATION_INVARIANTS.md (focus: spawn-agent-honors-saved-task-allow-pattern, spawn-agent-description-filters-by-task-rules, permission-task-deny-hides-all-six-v2-tools-from-list)
- ../../BACKWARD_COMPAT.md § "Saved permission rules — task key"
- ../../FIXTURES.md (focus: task-explore-allow, task-explore-deny, deny-all-task, mixed-permissions, tools-task-false)
- ../../PERMISSION_MAPPING.md § "Post-Wave-3 mapping (task group)"
- packages/opencode/src/tool/agent-spawn/agent-spawn.ts (the file you're modifying)
- packages/opencode/src/tool/agent-{send,followup,wait,list,close}/ (the 5 friends — read for context)
- packages/opencode/src/tool/registry.ts (lines 322-339 — describeSpawnAgent filter)
- packages/opencode/src/permission/index.ts (extend Wave 2's SHELL_TOOLS pattern with MULTI_AGENT_TOOLS)
- packages/opencode/src/session/llm.ts (extend Wave 2's resolveTools)
-->

## Goal

Make `spawn_agent` and the 5 v2 friends consult permission key `task` instead of `spawn_agent`. Add `MULTI_AGENT_TOOLS` group to `Permission.disabled` and `resolveTools` so config rules targeting `task` transparently gate all 6 v2 tools.

After this wave, every BC row in `BACKWARD_COMPAT.md` § "Saved permission rules — task key" must be green.

## Tasks

Sequential. One sub-agent. Same shape as Wave 2 but for the task surface.

### 1. Tests first

Three test files, written and run RED before implementation.

#### `tool/agent-spawn/agent-spawn.test.ts` — extend

```ts
it.live("spawn_agent honors saved permission.task: { explore: allow }", () =>
  Effect.gen(function* () {
    const cfg = loadPermissionConfig("task-explore-allow")
    const captured: any[] = []
    yield* Bus.subscribe(Permission.Event.Asked, (e) => Effect.sync(() => captured.push(e)))
    yield* runSpawnAgent({ agent_type: "explore", task: "find auth" }, cfg)
    // Allow path → no ask fires
    expect(captured.find((e) => e.permission === "task")).toBeUndefined()
  }),
)

it.live("spawn_agent description filters by permission.task rules (deny → omit)", () =>
  Effect.gen(function* () {
    const cfg = loadPermissionConfig("task-explore-deny")
    const desc = yield* renderSpawnAgentDescription(cfg)
    expect(desc).not.toContain("explore")
    expect(desc).toContain("general")
  }),
)
```

#### `permission/disabled.test.ts` — extend with MULTI_AGENT_TOOLS

```ts
it("Permission.disabled groups MULTI_AGENT_TOOLS under task key", () => {
  const result = Permission.disabled(
    ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent", "read"],
    [{ permission: "task", pattern: "*", action: "deny" }],
  )
  for (const k of ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent"]) {
    expect(result.has(k)).toBe(true)
  }
  expect(result.has("read")).toBe(false)
})
```

#### `tool/registry.test.ts` (or extend) — describeSpawnAgent filter uses task key

```ts
it("describeSpawnAgent filters subagents by permission.task rule, not permission.spawn_agent", () => {
  // Provide an agent whose permission has spawn_agent: deny but task: allow.
  // The filter at registry.ts:329 should consult `task` after Wave 3 — so the subagents are listed.
  const agent = makeAgent({
    permission: [
      { permission: "spawn_agent", pattern: "*", action: "deny" },
      { permission: "task", pattern: "explore", action: "allow" },
    ],
  })
  const desc = describeSpawnAgent(agent)
  expect(desc).toContain("explore")  // task: allow wins
})
```

Run all three red.

### 2. `tool/agent-spawn/agent-spawn.ts` — change PermissionKey

Find where the tool calls `ctx.ask({ permission: "spawn_agent", ... })`. Change to `permission: "task"`. The pattern argument (likely `agent_type`) stays the same.

If the file uses a constant for the key (mirror of `tool/process/id.ts`'s pattern), change the constant. Otherwise consider extracting one for symmetry — but only if the pattern would clarify the file. Don't refactor for refactor's sake.

### 3. `tool/registry.ts:329` — change `describeSpawnAgent` filter

Current:
```ts
(item) => Permission.evaluate("spawn_agent", item.name, agent.permission).action !== "deny"
```

After Wave 3:
```ts
(item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny"
```

This is symmetric with `describeTask` at `registry.ts:310` which already uses `"task"`. After the change, both `task` and `spawn_agent` filters consult the same key.

### 4. `permission/index.ts` — add MULTI_AGENT_TOOLS

```ts
const EDIT_TOOLS = ["edit", "write", "apply_patch"]
const SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]
const MULTI_AGENT_TOOLS = ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit"
                     : SHELL_TOOLS.includes(tool) ? "bash"
                     : MULTI_AGENT_TOOLS.includes(tool) ? "task"
                     : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}
```

Export `MULTI_AGENT_TOOLS` for use in `session/llm.ts`.

### 5. `session/llm.ts` — extend `resolveTools` with MULTI_AGENT_TOOLS

```ts
import { Permission, SHELL_TOOLS, MULTI_AGENT_TOOLS } from "@/permission"

function resolveTools(input: ...) {
  const disabled = Permission.disabled(...)
  const userTools = input.user.tools ?? {}
  const shellGroupDisabled = userTools.bash === false
  const taskGroupDisabled = userTools.task === false
  return Record.filter(input.tools, (_, k) => {
    if (userTools[k] === false) return false
    if (shellGroupDisabled && SHELL_TOOLS.includes(k)) return false
    if (taskGroupDisabled && MULTI_AGENT_TOOLS.includes(k)) return false
    return !disabled.has(k)
  })
}
```

### 6. The 5 v2 friends — change their per-call PermissionKey too

Reality (verified by `rg "PermissionKey" packages/opencode/src/tool/agent-{send,followup,wait,list,close}/`): each of the 5 friend tools has its OWN `PermissionKey` constant and calls `ctx.ask({ permission: PermissionKey, ... })` per invocation. Current state:

| File | Current `PermissionKey` | Per-call ask site | Patterns shape |
|---|---|---|---|
| `agent-send/agent-send.ts:28` | `"send_message"` | `agent-send.ts:91-99` | `[params.target]`, `always: ["*"]` |
| `agent-followup/agent-followup.ts:19` | `"followup_task"` | `agent-followup.ts:95-103` | `[params.target]`, `always: ["*"]` |
| `agent-wait/agent-wait.ts:33` | `"wait_agent"` | `agent-wait.ts:78-83` | `[`timeout:${ms}`]`, `always: ["*"]` |
| `agent-list/agent-list.ts:29` | `"list_agents"` | `agent-list.ts:51-56` | `[params.path_prefix ?? "*"]`, `always: ["*"]` |
| `agent-close/agent-close.ts:29` | `"close_agent"` | `agent-close.ts:80-85` | `[params.target]`, `always: ["*"]` |

Wave 3 changes the `PermissionKey` constant in EACH of the 5 files from its current value to `"task"`. The per-call ask sites are already keyed via `permission: PermissionKey`, so changing the constant is the only edit needed in each file (mirror of Wave 2's `tool/process/id.ts` change, which propagated to both `exec-command.ts` and `write-stdin.ts` automatically).

After the change, all 6 v2 multi-agent tools' per-call asks consult permission key `task` — structurally identical to how `EDIT_TOOLS = ["edit", "write", "apply_patch"]` all consult `edit`. The `MULTI_AGENT_TOOLS` group rule then handles tool-list visibility on top.

BC implication (documented in `BACKWARD_COMPAT.md` § "Out of scope"): saved `permission.send_message: ...` / `permission.followup_task: ...` / etc. rules silently stop matching after this wave. This is the deliberate per-call key collapse, consistent with EDIT_TOOLS. Wave 6 spec doc reiterates the migration: users with such rules must restate them under `permission.task`.

Tests: extend step 1 above with one assertion per friend tool that proves the per-call ask now uses `"task"`:

```ts
it.live("send_message uses task permission key (was send_message pre-Wave-3)", () =>
  Effect.gen(function* () {
    const captured: any[] = []
    yield* Bus.subscribe(Permission.Event.Asked, (e) => Effect.sync(() => captured.push(e)))
    yield* runSendMessage({ target: "sibling", message: "hi" })
    const ask = captured.find((e) => e.patterns.includes("sibling"))
    expect(ask?.permission).toBe("task")
  }),
)
// repeat for followup_task, wait_agent, list_agents, close_agent
```

Confirm by grep that no remaining `"send_message"` / `"followup_task"` / `"wait_agent"` / `"list_agents"` / `"close_agent"` literal strings appear as permission keys in the friend tool files (constants now hold `"task"`):

```bash
rg "permission:\s*\"(send_message|followup_task|wait_agent|list_agents|close_agent)\"" packages/opencode/src/tool/agent-{send,followup,wait,list,close}/
# expect zero hits
```

### 7. Differential test — `test/differential/spawn-permission.diff.test.ts`

For every combination of (permission-config fixture × agent_type):

```ts
import { loadPermissionConfig } from "../fixtures/load-config"

const fixtures = ["empty-config", "task-explore-allow", "task-explore-deny", "mixed-permissions"]
const agentTypes = ["explore", "general"]  // built-in subagents

for (const fixtureName of fixtures) {
  for (const agentType of agentTypes) {
    it.live(`task and spawn_agent produce same permission decision for ${fixtureName} × ${agentType}`, () =>
      Effect.gen(function* () {
        const cfg = loadPermissionConfig(fixtureName)
        const taskDecision = yield* runTaskTool({ subagent_type: agentType, ... }, cfg)
        const spawnDecision = yield* runSpawnAgent({ agent_type: agentType, ... }, cfg)
        expect(spawnDecision.permissionAction).toBe(taskDecision.permissionAction)
      }),
    )
  }
}
```

OLD (`task` tool) vs NEW (`spawn_agent` tool) on the same input. Resulting permission decisions equal.

### 8. Integration invariants — unskip

- `spawn-agent-honors-saved-task-allow-pattern` — see step 1 test snippet.
- `spawn-agent-description-filters-by-task-rules` — see step 1 test snippet.
- `permission-task-deny-hides-all-six-v2-tools-from-list` — load `deny-all-task.json` AND `tools-task-false.json`, call `tools(model)`, assert all 6 v2 tools (and the legacy `task`) are excluded.

### 9. Concurrent stress

Add to the integration suite:

```ts
it.instance("spawn-agent-concurrent-permission-flows-do-not-cross-contaminate", () =>
  Effect.gen(function* () {
    // 16 concurrent spawn_agent calls with varied agent_type and varied configs
    // Assert each call's permission decision matches its own config (no cross-contamination)
  }),
)
```

### 10. Mutation probe

After tests green:
1. Change `MULTI_AGENT_TOOLS` to `["task"]` in `permission/index.ts`.
2. Run `bun test src/permission/disabled.test.ts` and `permission-task-deny-hides-all-six-v2-tools-from-list`.
3. Assert at least one goes RED.
4. Restore. Re-run; all green.
5. Document in NOTES.md.

### 11. Bench

`test/perf/spawn-agent.bench.ts` (extend or create). Re-measure `spawn_agent.spawn`, `permission.disabled`. Output to `artifacts/perf/wave_3.json`. Compare against baseline. Expect within ±2% — the change is permission-key resolution only, no new computation.

## Test pyramid quota for Wave 3

- Unit: 3-5 tests (extend agent-spawn.test.ts, disabled.test.ts, registry.test.ts).
- Integration: 3 invariants unskipped + 1 stress.
- Differential: 1 large file (4 fixtures × 2 agent_types = 8 cases).
- Property: 0.
- Concurrent stress: 1 (N=16, integration).
- Plugin contract: 0.
- Fixtures: load + verify task-group fixtures.
- Bench: 2 metrics.

## Gotchas

1. **`describeSpawnAgent` is dispatched per turn.** It runs every time the model gets its tool list, not just at session start. The filter change at `registry.ts:329` runs hot. Bench `registry.tools` to confirm the change is constant-factor.

2. **Permission.evaluate is `findLast`.** The `task-explore-deny` fixture has `{ explore: deny, general: allow }`. The filter at `describeSpawnAgent` walks every available subagent (`explore`, `general`) and tests `Permission.evaluate("task", item.name, ...).action !== "deny"`. For `explore`, the rule that matches is `{ permission: "task", pattern: "explore", action: "deny" }` → action is "deny" → filtered out. Per `evaluate.ts:11-14`, last match wins; the fixture order matters.

3. **Existing `task` tool tests stay green.** This wave does not modify `task.ts`. It only changes `spawn_agent`'s key and adds the group rule. `task` still consults `task` permission key (it always did). Differential test asserts NEW `spawn_agent` matches OLD `task`.

4. **`agent_type` validation from `c86c58f94`.** The post-port fix asserts `spawn_agent` rejects `agent_type` values that aren't real subagent registry entries (the bug-3 fix from the hardening campaign). Don't undo this. Wave 3 changes the permission KEY, not the eligible-set logic.

5. **`MULTI_AGENT_TOOLS` includes the legacy `task` ID.** This is intentional. After Wave 4 drops `task` from the registry's builtin array, the legacy ID is still in MULTI_AGENT_TOOLS so any user-config or agent-config rule that says `tools.task = false` continues to disable EVERY tool in the group (including the still-listed v2 tools). Without `task` in the group, a user-config saying `tools.task = false` would only hide the (already-hidden) legacy `task`, defeating the BC promise.

6. **The 5 friend tools have per-call ctx.ask today.** Don't repeat the original plan's mistake of treating them as silent. Each defines its own `PermissionKey` constant and asks per-call (see step 6 table). Wave 3 changes ALL SIX (`spawn_agent` + 5 friends) per-call keys to `"task"` — analogous to EDIT_TOOLS collapsing 3 IDs onto `"edit"`. Do not introduce per-call gating or remove their existing per-call asks; only the constant value changes.

7. **Saved per-friend permission rules silently break.** A user who has `permission.send_message: { "*": "deny" }` (or any of the 4 other friend keys) saved before the campaign will see the rule stop matching after Wave 3, because the per-call ask now consults `"task"` instead of `"send_message"`. This matches EDIT_TOOLS precedent (`permission.write` rules don't gate `write.ts`'s per-call ask either) and is documented as a plugin-migration boundary in `BACKWARD_COMPAT.md` § "Out of scope". No fixture in `FIXTURES.md` asserts pre-campaign per-friend gating because the pre-campaign behavior is itself an unintentional artifact, not a feature to preserve.

7. **Verify the agent-spawn permission key change doesn't conflict with describeSpawnAgent.** Both the `ctx.ask` site (per-call) and the `describeSpawnAgent` filter (per-turn) consult the SAME key. Wave 3 changes both to `"task"`. If you only change one, integration tests fail.

8. **Plan-mode agent.** Plan mode disables edit tools and (likely) `task`. Verify plan mode's permission rules continue to disable the v2 tools too — the MULTI_AGENT_TOOLS group should make this automatic, but assert explicitly with a fixture-loaded plan-mode test.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# unit + integration
bun test src/tool/agent-spawn/
bun test src/tool/agent-send/
bun test src/tool/agent-followup/
bun test src/tool/agent-wait/
bun test src/tool/agent-list/
bun test src/tool/agent-close/
bun test src/tool/task.test.ts                                     # legacy still green
bun test src/permission/disabled.test.ts
bun test src/tool/registry.test.ts
bun test test/integration/tool-surface-replacement.test.ts         # new invariants green

# differential
bun test test/differential/spawn-permission.diff.test.ts

# coverage 100% on touched
bun test --coverage src/tool/agent-spawn/agent-spawn.ts
bun test --coverage src/tool/agent-send/agent-send.ts
bun test --coverage src/tool/agent-followup/agent-followup.ts
bun test --coverage src/tool/agent-wait/agent-wait.ts
bun test --coverage src/tool/agent-list/agent-list.ts
bun test --coverage src/tool/agent-close/agent-close.ts
bun test --coverage src/permission/index.ts
bun test --coverage src/session/llm.ts
bun test --coverage src/tool/registry.ts

# perf within budget
bun test ./test/perf/spawn-agent.bench.ts
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_3.json
```

All exit 0.

## Files

New:
- `packages/opencode/test/differential/spawn-permission.diff.test.ts`
- `packages/opencode/test/perf/spawn-agent.bench.ts` (if not extending existing)
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_3.json`

Modified:
- `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` (PermissionKey → "task")
- `packages/opencode/src/tool/agent-send/agent-send.ts` (PermissionKey → "task")
- `packages/opencode/src/tool/agent-followup/agent-followup.ts` (PermissionKey → "task")
- `packages/opencode/src/tool/agent-wait/agent-wait.ts` (PermissionKey → "task")
- `packages/opencode/src/tool/agent-list/agent-list.ts` (PermissionKey → "task")
- `packages/opencode/src/tool/agent-close/agent-close.ts` (PermissionKey → "task")
- `packages/opencode/src/tool/registry.ts:329` (describeSpawnAgent filter → "task")
- `packages/opencode/src/permission/index.ts` (MULTI_AGENT_TOOLS category)
- `packages/opencode/src/session/llm.ts` (resolveTools task-group rule)
- `packages/opencode/src/tool/agent-spawn/agent-spawn.test.ts` (new tests)
- `packages/opencode/src/tool/agent-send/agent-send.test.ts` (new test asserting per-call key now `"task"`)
- `packages/opencode/src/tool/agent-followup/agent-followup.test.ts` (same)
- `packages/opencode/src/tool/agent-wait/agent-wait.test.ts` (same)
- `packages/opencode/src/tool/agent-list/agent-list.test.ts` (same)
- `packages/opencode/src/tool/agent-close/agent-close.test.ts` (same)
- `packages/opencode/src/permission/disabled.test.ts` (extend with MULTI_AGENT_TOOLS)
- `packages/opencode/src/tool/registry.test.ts` (new test for describeSpawnAgent filter)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts` (3 invariants unskipped + 1 stress)
