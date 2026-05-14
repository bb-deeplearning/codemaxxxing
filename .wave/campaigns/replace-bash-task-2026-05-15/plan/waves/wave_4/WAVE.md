# Wave 4 — Drop `tool.shell` and `tool.task` from registry's builtin array + plugin hook bridge

<!--
Previous waves: 0, 1, 2, 3.
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../INTEGRATION_INVARIANTS.md (focus: model-tool-list-no-bash, model-tool-list-no-task, plugin-bash-hook-applies-to-exec-command, plugin-task-hook-applies-to-spawn-agent, legacy-shell-tool-still-runnable-from-internal-code, legacy-task-tool-still-runnable-from-internal-code)
- ../../BACKWARD_COMPAT.md § "Plugin hook compatibility", "Snapshot diffs"
- ../../FIXTURES.md (focus: every fixture; their tool-list assertions all become live now)
- packages/opencode/src/tool/registry.ts (lines 250-269 builtin array; 341-381 tools() function)
- packages/opencode/src/plugin/index.ts (Plugin.trigger contract)
- The Wave 0 snapshots in artifacts/snapshots/tool-list-*.json
-->

## Goal

Remove `tool.shell` and `tool.task` from the model-facing `builtin` array in `tool/registry.ts:250-269`. Add a plugin-hook bridge in `tools()` so plugins keying `tool.definition` on the legacy IDs (`bash`, `task`) continue to fire and propagate to the new tools (`exec_command`, `spawn_agent`).

After this wave: the model's tool list no longer contains `bash` or `task`. Plugin hooks for `bash`'s description still affect `exec_command`'s description. Saved permission rules — already wired by Waves 2 and 3 — remain functional. The legacy tool files compile and are runnable from internal code (test harness verifies).

## Tasks

Sequential. One sub-agent. Mostly small surgical edits gated by extensive tests.

### 1. Tests first

Five test files, written and run RED before implementation.

#### `tool/registry.test.ts` — model-tool-list assertions

```ts
it.live("registry.tools() for build agent does NOT include bash or task", () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry.Service
    const tools = yield* reg.tools({ providerID, modelID, agent: buildAgent })
    const ids = tools.map((t) => t.id)
    expect(ids).not.toContain("bash")
    expect(ids).not.toContain("task")
    expect(ids).toContain("exec_command")
    expect(ids).toContain("spawn_agent")
  }),
)

it.live("registry.tools() for caveman agent does NOT include bash or task", ...)
it.live("registry.tools() for explore subagent does NOT include bash or task", ...)
it.live("registry.tools() for general subagent does NOT include bash or task", ...)
it.live("registry.tools() for plan agent does NOT include bash or task", ...)
```

#### `test/integration/plugin-bridge.test.ts` — new file

```ts
it.instance("plugin tool.definition hook for 'bash' fires AND mutates exec_command's description", () =>
  Effect.gen(function* () {
    let bashHookFired = false
    yield* Plugin.register({
      "tool.definition": ({ toolID }, output) => Effect.sync(() => {
        if (toolID === "bash") {
          bashHookFired = true
          output.description = output.description + "\n[plugin appended]"
        }
      }),
    })
    const reg = yield* ToolRegistry.Service
    const tools = yield* reg.tools({ providerID, modelID, agent: buildAgent })
    const exec = tools.find((t) => t.id === "exec_command")
    expect(bashHookFired).toBe(true)
    expect(exec?.description).toContain("[plugin appended]")
  }),
)

it.instance("plugin tool.definition hook for 'task' fires AND mutates spawn_agent's description", ...)
```

#### `test/integration/legacy-internal-runnable.test.ts` — new file

```ts
it.instance("ShellTool.execute still works when invoked directly (not via model)", () =>
  Effect.gen(function* () {
    // Build a Tool.Context manually, call ShellTool's execute with a simple cmd.
    // Assert the output is the expected shell tool envelope.
    const result = yield* invokeShellToolDirectly({ command: "echo hello" })
    expect(result.output).toContain("hello")
  }),
)

it.instance("TaskTool.execute still works when invoked directly", () => ...)
```

#### `test/integration/tool-surface-replacement.test.ts` — unskip 6 invariants

- `model-tool-list-no-bash`
- `model-tool-list-no-task`
- `plugin-bash-hook-applies-to-exec-command`
- `plugin-task-hook-applies-to-spawn-agent`
- `legacy-shell-tool-still-runnable-from-internal-code`
- `legacy-task-tool-still-runnable-from-internal-code`

Bodies similar to the test snippets above; consolidate or cross-reference.

Run all red.

### 2. Modify `tool/registry.ts:250-269` — drop legacy tools from builtin array

Current shape (paraphrased from `OVERVIEW.md`):

```ts
return {
  custom,
  builtin: [
    tool.invalid,
    ...(questionEnabled ? [tool.question] : []),
    tool.shell,        // ← REMOVE
    tool.read,
    tool.glob,
    tool.grep,
    tool.edit,
    tool.write,
    tool.task,         // ← REMOVE
    tool.fetch,
    tool.todo,
    tool.search,
    tool.skill,
    tool.patch,
    tool.execcommand,
    tool.writestdin,
    tool.agentspawn,
    tool.agentsend,
    tool.agentfollowup,
    tool.agentwait,
    tool.agentlist,
    tool.agentclose,
    ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
    ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [tool.plan] : []),
  ],
  task: tool.task,        // ← KEEP — internal callers (legacy code paths) still resolve via `named()`
  read: tool.read,
}
```

Drop `tool.shell` and `tool.task` from `builtin`. KEEP the `tool.shell` binding (line 220) and `tool.task` binding (line 226) so the file still compiles and `named.task` resolves to the legacy tool. The `task: tool.task` line at the end (line 273) is the internal-resolution route.

Comment the removal explicitly:

```ts
return {
  custom,
  builtin: [
    tool.invalid,
    ...(questionEnabled ? [tool.question] : []),
    // tool.shell — model surface dropped Wave 4 of replace-bash-task-2026-05-15;
    // exec_command + write_stdin replace it. Internal callers can still resolve
    // via named().task or import ShellTool directly.
    tool.read,
    tool.glob,
    tool.grep,
    tool.edit,
    tool.write,
    // tool.task — model surface dropped Wave 4 of replace-bash-task-2026-05-15;
    // spawn_agent + 5 friends replace it.
    tool.fetch,
    // ... rest
  ],
  // ...
}
```

### 3. Modify `tool/registry.ts:341` — `tools()` plugin bridge

Current shape (around lines 355-380):

```ts
return yield* Effect.forEach(
  filtered,
  Effect.fnUntraced(function* (tool: Tool.Def) {
    const output = { description: tool.description, parameters: tool.parameters }
    yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
    return { id: tool.id, description: ..., parameters: output.parameters, execute: tool.execute, ... }
  }),
)
```

Add a bridge: when the tool being processed is `exec_command`, ALSO dispatch the legacy `bash` hook so plugins targeting the old ID still apply. Same for `spawn_agent` ↔ `task`.

```ts
return yield* Effect.forEach(
  filtered,
  Effect.fnUntraced(function* (tool: Tool.Def) {
    const output = { description: tool.description, parameters: tool.parameters }
    
    // Plugin hook bridge: legacy IDs continue to receive tool.definition events
    // for BC. Hooks fire in legacy-then-new order so legacy mutations land first
    // and the new-ID hook (if any) sees them. tool.execute is NOT bridged
    // (different semantics; one-shot vs persistent).
    const legacyId = tool.id === "exec_command" ? "bash"
                   : tool.id === "spawn_agent" ? "task"
                   : null
    if (legacyId) {
      yield* plugin.trigger("tool.definition", { toolID: legacyId }, output)
    }
    
    yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
    
    return {
      id: tool.id,
      description: [
        output.description,
        tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
        tool.id === AgentSpawnTool.id ? yield* describeSpawnAgent(input.agent) : undefined,
        tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
      ].filter(Boolean).join("\n"),
      parameters: output.parameters,
      execute: tool.execute,
      formatValidationError: tool.formatValidationError,
    }
  }),
  { concurrency: "unbounded" },
)
```

The `TaskTool.id === "task"` describeTask line stays — `TaskTool` is still imported and still has its describe function; it just won't run because `tool.task` isn't in `builtin` anymore, so `filtered` won't contain a tool with `id === "task"`. The branch is dead code, harmless. Wave 4 leaves it for code-archaeology readability; a future cleanup can remove.

### 4. Snapshot diff — assert tool list against Wave 0 baseline

`test/integration/tool-surface-replacement.test.ts` adds:

```ts
it.live("tool-list snapshot matches expected post-Wave-4 shape", () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry.Service
    for (const agentName of ["build", "caveman", "explore", "general", "plan"]) {
      const agent = yield* loadAgent(agentName)
      const tools = yield* reg.tools({ providerID, modelID, agent })
      const ids = tools.map((t) => t.id).sort()
      const baseline = JSON.parse(
        await Bun.file(
          `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/tool-list-${agentName}.json`
        ).text()
      ).map((e: any) => e.id).sort()
      const expectedRemovals = ["bash", "task"]
      const expectedPostList = baseline.filter((id: string) => !expectedRemovals.includes(id)).sort()
      expect(ids).toEqual(expectedPostList)
    }
  }),
)
```

This test asserts the EXACT diff against Wave 0 baseline: only `bash` and `task` are removed, nothing else changes.

### 5. Plugin contract test extension

`test/integration/plugin-bridge.test.ts` covers the four critical contracts:

- `tool.definition` hook for `bash` fires when `tools()` processes `exec_command`. ✓
- `tool.definition` hook for `task` fires when `tools()` processes `spawn_agent`. ✓
- `tool.execute` hook for `bash` does NOT fire when model calls `exec_command` (different semantics). ✓ (assert by registering a hook and confirming it never runs over a sample workflow).
- `shell.env` hook continues to fire for `exec_command` (already wired in `exec-command.ts:99-103`). ✓

### 6. Mutation probe

After tests green:
1. In `registry.ts:tools()`, change the bridge `if (legacyId)` to `if (false)`.
2. Run `bun test test/integration/plugin-bridge.test.ts`.
3. Assert at least one bridge test goes RED.
4. Restore. Re-run; all green.
5. Document in NOTES.md.

### 7. Bench

`test/perf/registry-tools.bench.ts` (extend or create). Re-measure `registry.tools` (the per-turn filter + plugin dispatch). With 2 fewer tools to filter but a per-tool plugin bridge dispatch, net should be within ±5%.

Output to `artifacts/perf/wave_4.json`. Compare against baseline. If +bridge dominates and exceeds budget, optimize: skip the bridge dispatch when no plugin has registered a hook for the legacy ID (cache the no-hook result via `Plugin.hasHookFor(toolID)`, if such an API exists; else surface a USER QUESTION asking whether to add one).

## Test pyramid quota for Wave 4

- Unit: 5+ tests in registry.test.ts (per-agent tool-list assertions).
- Integration: 6 invariants unskipped + 1 snapshot diff.
- Differential: 0.
- Property: 0.
- Concurrent stress: 0.
- Plugin contract: 4 contracts asserted in plugin-bridge.test.ts.
- Fixtures: load + verify mixed-permissions, agent-overrides-deny-bash with the new tool list shape.
- Bench: 1 metric (registry.tools).

## Gotchas

1. **DO NOT delete `tool.shell` or `tool.task` bindings.** They stay at `registry.ts:220`, `tool.task` stays at `registry.ts:226`. Only `builtin` array entries drop. The `task: tool.task` self-reference at the end stays for `named().task` resolution.

2. **The `tool.id === TaskTool.id` describe branch in `tools()` becomes dead code.** Don't remove it. Future-proof for plugins or experimental flags that might reintroduce the tool. Add a comment: `// dead branch after replace-bash-task-2026-05-15 wave 4 — left for plugin reactivation`.

3. **Plugin bridge order matters.** Legacy hook fires FIRST, then new-id hook. So a plugin that mutates description via the legacy `bash` hook can be observed-and-mutated-further by a different plugin hooking the new `exec_command` ID. Don't reverse the order — that creates a footgun where the legacy hook clobbers the new one.

4. **`tool.execute` is NOT bridged.** Execute semantics differ between `bash` (one-shot) and `exec_command` (persistent PTY). A plugin that tries to "wrap shell execution" via the legacy execute hook would be very confused if it accidentally ran on `exec_command` calls. Documented as a plugin migration boundary.

5. **`Plugin.trigger` may fail.** Wrap each bridge dispatch in error handling per the existing `tools()` pattern. A failing plugin shouldn't block tool-list construction.

6. **`Tool.Def` has no `internal: true` flag today.** The earlier mention in the plan of an `internal: true` flag is OPTIONAL polish, not required. Skip unless you have time. The bare drop from the `builtin` array is sufficient — the tool isn't in the model's list, end of story.

7. **`Permission.disabled` no longer needs to special-case `bash` and `task` IDs in the SHELL_TOOLS / MULTI_AGENT_TOOLS groups (since those tools aren't in the list anymore).** But removing them would break the BC promise that `tools.bash = false` continues to work for users who set it. KEEP `bash` and `task` in their respective groups. The groups exist precisely so the user-facing config keys keep gating the right set after the registry change.

8. **`fetch`, `todo`, `search`, `skill`, `patch` remain unchanged.** Don't accidentally drop them while editing the array. Eyeballing the `builtin` array and removing two specific lines is error-prone — write the test FIRST asserting the post-change shape, then edit the array, then re-run the test.

9. **Plugin test snippets in this WAVE.md are illustrative — `Plugin.register(...)` does not exist.** The actual `Plugin.Service` API in `packages/opencode/src/plugin/index.ts:258-271` exposes `trigger(name, input, output)` and `list()`; hooks are populated from `InstanceState` by the plugin loader during initialization (`PluginLoader.Loaded`). To inject a hook for a contract test, you have two practical paths: (a) write a real plugin file into a tmpdir-bound `.opencode/plugin/` directory before binding the test instance, so `applyPlugin` picks it up; (b) build a thin layer that wraps `Plugin.layer` and pushes a hook directly into the `InstanceState` after init. Pick (b) for hermetic tests; (a) for end-to-end discovery tests. There are NO existing tests today that exercise the `tool.definition` hook, so this wave is the first — expect to invent the test harness. Document the choice in NOTES.md.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# unit + integration
bun test src/tool/registry.test.ts
bun test test/integration/tool-surface-replacement.test.ts
bun test test/integration/plugin-bridge.test.ts
bun test test/integration/legacy-internal-runnable.test.ts

# legacy tools' own tests still green (file-level)
bun test src/tool/shell.test.ts
bun test src/tool/task.test.ts

# coverage 100% on touched
bun test --coverage src/tool/registry.ts

# perf within budget
bun test ./test/perf/registry-tools.bench.ts
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_4.json

# manual: confirm legacy task tool callers (existing internal code paths) still build
rg "tool\.task|named\(\)\.task|TaskTool\." packages/opencode/src/   # eyeball-verify nothing references a removed export
```

All exit 0.

## Files

New:
- `packages/opencode/test/integration/plugin-bridge.test.ts`
- `packages/opencode/test/integration/legacy-internal-runnable.test.ts`
- `packages/opencode/test/perf/registry-tools.bench.ts` (if not extending)
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_4.json`

Modified:
- `packages/opencode/src/tool/registry.ts` (drop bash/task from builtin; add plugin bridge)
- `packages/opencode/src/tool/registry.test.ts` (per-agent tool-list assertions)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts` (6 invariants unskipped + snapshot diff)
