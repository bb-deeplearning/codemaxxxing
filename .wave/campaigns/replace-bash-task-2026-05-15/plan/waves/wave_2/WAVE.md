# Wave 2 — Wire scanner into `exec_command` + align permission key to `bash` + SHELL_TOOLS group

<!--
Previous waves: 0 (baseline + fixtures), 1 (scanner extracted to tool/shell/scan.ts).
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../INTEGRATION_INVARIANTS.md (focus: exec-command-honors-saved-bash-allow-pattern, exec-command-triggers-external-directory-for-outside-cwd-paths, write-stdin-auto-allows-after-pid-rule-registered-under-bash, permission-bash-deny-hides-exec-and-stdin-from-tool-list, exec-command-concurrent-permission-flows-do-not-cross-contaminate)
- ../../BACKWARD_COMPAT.md § "Saved permission rules — bash key", "Persistent process semantics — pid:N rule", "File-touch detection (external_directory)"
- ../../FIXTURES.md (focus: empty-config, allow-all-bash, deny-all-bash, git-allow-rest-ask, mixed-permissions, tools-bash-false, agent-overrides-deny-bash)
- ../../PERMISSION_MAPPING.md § "Post-Wave-2 mapping (bash group)"
- packages/opencode/src/tool/process/exec-command.ts, write-stdin.ts, id.ts
- packages/opencode/src/permission/index.ts (lines 309-320 — disabled())
- packages/opencode/src/session/llm.ts (lines 450-456 — resolveTools())
-->

## Goal

Make `exec_command` and `write_stdin` consult permission key `bash` instead of `exec_command`. Wire the shared scanner from Wave 1 into `exec_command`'s `ctx.ask` so the permission flow produces the same patterns the legacy `bash` tool produces. Add `SHELL_TOOLS` group to `Permission.disabled` and `resolveTools` so config rules targeting `bash` transparently gate the new tools.

After this wave, every BC row in `BACKWARD_COMPAT.md` § "Saved permission rules — bash key" / "Persistent process semantics" / "File-touch detection" must be green.

## Tasks

Sequential. One sub-agent.

### 1. Tests first

Three test files, written and run RED before any implementation.

#### `tool/process/exec-command.test.ts` — extend existing tests

Add to the existing file (don't replace; the existing assertions on PTY behavior, abort handling, etc. stay):

```ts
it.live("exec_command(cmd: 'git status') uses bash permission key with AST-derived patterns", () =>
  Effect.gen(function* () {
    const captured: any[] = []
    yield* Bus.subscribe(Permission.Event.Asked, (e) => Effect.sync(() => captured.push(e)))
    yield* runExecCommand({ cmd: "git status" })
    const ask = captured.find((e) => e.permission === "bash")
    expect(ask).toBeDefined()
    expect(ask.always).toContain("git *")
    expect(ask.patterns).toContain("git status")
    expect(ask.always.find((p: string) => p.startsWith("pid:"))).toBeDefined()
  }),
)

it.live("exec_command(cmd: 'rm /tmp/foo') triggers external_directory + bash asks in order", () =>
  Effect.gen(function* () {
    const captured: any[] = []
    yield* Bus.subscribe(Permission.Event.Asked, (e) => Effect.sync(() => captured.push(e)))
    yield* runExecCommand({ cmd: "rm /tmp/foo" })
    expect(captured[0].permission).toBe("external_directory")
    expect(captured[0].patterns).toContain("/tmp/*")
    expect(captured[1].permission).toBe("bash")
    expect(captured[1].always).toContain("rm *")
  }),
)
```

#### `tool/process/write-stdin.test.ts` — extend existing tests

```ts
it.live("write_stdin(session_id: N) auto-allows when prior exec_command got always-allow under bash key", () =>
  Effect.gen(function* () {
    // Stub permission reply: always-allow on first ask
    yield* installPermissionReply("always")
    const result1 = yield* runExecCommand({ cmd: "node -e 'setInterval(()=>{},1000)'", tty: true })
    expect(result1.session_id).toBeDefined()

    // Subscribe and assert NO ask fires for write_stdin
    let askedAgain = false
    yield* Bus.subscribe(Permission.Event.Asked, () => Effect.sync(() => { askedAgain = true }))
    yield* runWriteStdin({ session_id: result1.session_id, chars: "" })
    expect(askedAgain).toBe(false)
  }),
)
```

#### `permission/disabled.test.ts` — extend or create

```ts
it("Permission.disabled groups SHELL_TOOLS under bash key", () => {
  const result = Permission.disabled(
    ["bash", "exec_command", "write_stdin", "read"],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("exec_command")).toBe(true)
  expect(result.has("write_stdin")).toBe(true)
  expect(result.has("read")).toBe(false)
})
```

Run all three red:
```bash
bun test src/tool/process/exec-command.test.ts
bun test src/tool/process/write-stdin.test.ts
bun test src/permission/disabled.test.ts   # if new file; else the right path
```

### 2. Change `tool/process/id.ts`

```ts
// Before: export const PermissionKey = "exec_command"
// After:
import { ShellID } from "../shell/id"
export const PermissionKey = ShellID.ToolID  // = "bash"
```

`pidPattern(N)` stays as `pid:${N}` — the pattern shape is unchanged, only the key it lives under changes.

### 3. Wire `tool/process/exec-command.ts` to use `ShellScan`

At the top:
```ts
import { ShellScan } from "../shell/scan"
import { ShellID } from "../shell/id"
import { Shell } from "@/shell/shell"
import { Config } from "@/config/config"
```

In the layer construction (around line 78), add `const config = yield* Config.Service`.

Replace the `ctx.ask` block (lines 127-138) with:

```ts
const cfg = yield* config.get()
const shellBinary = params.shell ?? Shell.acceptable(cfg.shell)

const scan = yield* ShellScan.scanCommand({
  command: params.cmd,
  shell: shellBinary,
  cwd,
  instance: instanceCtx,
})

yield* ShellScan.askForScan(ctx, scan, {
  extraAlways: [pidPattern(session.processId)],
  metadata: { cmd: params.cmd, workdir: cwd, tty },
})
```

The `ShellScan.askForScan` already uses `permission: ShellID.ToolID` (= `"bash"`) per Wave 1. The `pidPattern` always-rule gets appended via `extraAlways`.

The acquire-PTY-then-ask ordering at `exec-command.ts:114-127` stays. The `pid:<n>` always-pattern needs the PTY allocated first per the file's existing comment at lines 4-8.

### 4. `tool/process/write-stdin.ts` — uses the same `PermissionKey`

`write-stdin.ts` already imports `PermissionKey` from `tool/process/id.ts`. Step 2's change in `id.ts` automatically flows through. Double-check no other place hardcodes `"exec_command"` as the permission key in the write-stdin file.

### 5. `permission/index.ts` — add SHELL_TOOLS category

```ts
const EDIT_TOOLS = ["edit", "write", "apply_patch"]
const SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit"
                     : SHELL_TOOLS.includes(tool) ? "bash"
                     : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}
```

Export `SHELL_TOOLS` so `session/llm.ts` can import it.

### 6. `session/llm.ts` — extend `resolveTools` for SHELL_TOOLS user-config grouping

```ts
import { Permission, SHELL_TOOLS } from "@/permission"

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  const userTools = input.user.tools ?? {}
  const shellGroupDisabled = userTools.bash === false
  return Record.filter(input.tools, (_, k) => {
    if (userTools[k] === false) return false
    if (shellGroupDisabled && SHELL_TOOLS.includes(k)) return false
    return !disabled.has(k)
  })
}
```

### 7. Differential test — `test/differential/exec-permission.diff.test.ts`

For every combination of (permission-config fixture × scanner-corpus command):

```ts
import corpus from "../fixtures/scanner-corpus.json"
import { loadPermissionConfig } from "../fixtures/load-config"

const fixtures = ["empty-config", "allow-all-bash", "git-allow-rest-ask", "mixed-permissions"]

for (const fixtureName of fixtures) {
  for (const entry of corpus) {
    it.live(`bash and exec_command produce same permission decision for ${fixtureName} × "${entry.cmd}"`, () =>
      Effect.gen(function* () {
        const cfg = loadPermissionConfig(fixtureName)
        const bashDecision = yield* runShellTool({ command: entry.cmd }, cfg)
        const execDecision = yield* runExecCommand({ cmd: entry.cmd }, cfg)
        expect(execDecision.permissionAction).toBe(bashDecision.permissionAction)
        expect(execDecision.bashAskPatterns?.sort()).toEqual(bashDecision.bashAskPatterns?.sort())
      }),
    )
  }
}
```

OLD (`bash` tool) vs NEW (`exec_command` tool) on the same input. Resulting permission decision must be equal. This is the cornerstone BC test.

### 8. Integration invariants — unskip in `test/integration/tool-surface-replacement.test.ts`

Five blocks unskipped, all with real bodies:

- `exec-command-honors-saved-bash-allow-pattern` — load `git-allow-rest-ask.json`, call `exec_command(cmd: "git status")`, assert no `Permission.Event.Asked` fires (auto-allow path).
- `exec-command-triggers-external-directory-for-outside-cwd-paths` — call `exec_command(cmd: "rm /tmp/foo")`, assert two asks in order.
- `write-stdin-auto-allows-after-pid-rule-registered-under-bash` — see step 1 test snippet.
- `permission-bash-deny-hides-exec-and-stdin-from-tool-list` — load `deny-all-bash.json` AND separately `tools-bash-false.json` AND `agent-overrides-deny-bash.json`, call `tools(model)`, assert none of `bash`/`exec_command`/`write_stdin` appear.
- `exec-command-concurrent-permission-flows-do-not-cross-contaminate` — N=32 concurrent `exec_command` calls (varied commands, varied permission rules), assert each call's `ctx.ask` carries only its own command's patterns. Use a Bus subscriber that keys events by sessionID and asserts no cross-session leakage.

### 9. Mutation probe

After tests green:
1. In `permission/index.ts`, change `SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]` to `SHELL_TOOLS = ["bash"]`.
2. Run `bun test src/permission/disabled.test.ts` and the `permission-bash-deny-hides-exec-and-stdin-from-tool-list` invariant.
3. Assert at least one goes RED.
4. Restore. Re-run; all green.
5. Document in NOTES.md.

### 10. Fixture suite — load + assert

`test/integration/tool-surface-replacement.test.ts` extends with a fixture-loop test:

```ts
it.instance("BC matrix for bash group: every fixture × invocation produces expected outcome", () =>
  Effect.gen(function* () {
    const cases = [
      { fixture: "git-allow-rest-ask", cmd: "git status", expect: "allow" },
      { fixture: "git-allow-rest-ask", cmd: "git push origin main", expect: "deny" },
      { fixture: "git-allow-rest-ask", cmd: "npm install", expect: "ask" },
      { fixture: "deny-all-bash", cmd: "any", expectListExcludes: ["bash", "exec_command", "write_stdin"] },
      // ... per BACKWARD_COMPAT.md § "Saved permission rules — bash key"
    ]
    for (const c of cases) {
      // assert per case shape
    }
  }),
)
```

### 11. Bench

`test/perf/exec-command.bench.ts` (extend or create). Re-measure `exec_command.exec`, `permission.disabled`, `permission.evaluate`, `scan.cmd_short`, `scan.cmd_long`. Output to `artifacts/perf/wave_2.json`. Compare against baseline. Budget: 5/10/15%.

The `exec_command.exec` p50 will rise by the scan cost (~50-200µs). The scan is a new step in the hot path; ensure the rise is within budget. If not, profile and optimize (probably caching the parser instance or memoizing common command parses — see Wave 1's gotcha #4 about WASM init).

## Test pyramid quota for Wave 2

- Unit: 5+ tests (extending exec-command.test.ts, write-stdin.test.ts, disabled.test.ts).
- Integration: 5 invariants unskipped.
- Differential: 1 large file (4 fixtures × 50 corpus = ~200 cases).
- Property: 0.
- Concurrent stress: 1 (N=32, integration invariant).
- Plugin contract: 0.
- Fixtures: load + verify bash-group fixtures.
- Bench: 4-5 metrics.

## Gotchas

1. **`pid:<n>` permission key change is BC-breaking for in-flight `exec_command` sessions.** A user who has an `exec_command` running RIGHT NOW (long REPL, dev server) when this code ships, has a `pid:<n>` rule registered under the OLD `exec_command` key. After deployment, `write_stdin` for that session will look under the NEW `bash` key and miss the old rule, prompting again. Acceptable per `BACKWARD_COMPAT.md § "Out of scope"` — long-running processes don't survive opencode restarts anyway. Document in NOTES if you find a way to bridge gracefully.

2. **Order of `ctx.ask` events for `external_directory` then `bash` matters.** Wave 0's snapshots captured the order. The differential test asserts it. If you reorder accidentally (e.g., by changing how `ShellScan.askForScan` iterates), Wave 6's snapshot diff fails. Don't reorder.

3. **`Shell.acceptable(cfg.shell)` resolves the configured shell binary.** `exec_command` currently passes `params.shell ?? undefined` to PTY (line 117), letting PTY default. The scan needs a real binary string (bash vs powershell sniff). Resolve via `Shell.acceptable(cfg.shell)` if `params.shell` is unset. Test: with no `params.shell`, scanner runs against the configured shell, not undefined.

4. **The exec_command return-shape change at `d205e5a90`** added the `session_id` to model-visible output. Don't accidentally undo that. The wave only changes permission flow, not response shape. Existing tests for the response shape stay green.

5. **`Permission.merge(agent.permission, user.permission)` precedence.** The `findLast` semantics in `evaluate` mean later rules win on tie. `agent.permission` is merged BEFORE `user.permission` per `session/llm.ts:453`, so user-level rules override agent-level. The fixture `agent-overrides-deny-bash.json` exercises the opposite case — agent-level deny that should also hide the tool. Verify the integration test loads the fixture in a way that creates the layered config correctly.

6. **`SHELL_TOOLS` in two places.** Both `permission/index.ts` (for `disabled()`) and `session/llm.ts` (for `resolveTools()`) consult the list. Export from one (`permission/index.ts`) and import into the other so there's a single source of truth. Drift between the two is a wave failure.

7. **Bench differentiating per-stage cost.** When `exec_command.exec` p50 rises, you'll want to know whether the rise is in `scan.cmd_*` or in `pty.create`. Make sure the bench captures both as separate metrics so the source of any regression is visible.

8. **The legacy `bash` tool's tests stay green.** Wave 1 changed `shell.ts` to consume `ShellScan`; Wave 2 doesn't touch `shell.ts` again. If your changes accidentally affect `bash`'s behavior (e.g. by changing `ShellScan.askForScan`'s shape), `bash`'s tests fail and so does the wave.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# unit + integration
bun test src/tool/process/
bun test src/permission/disabled.test.ts
bun test src/tool/shell.test.ts                                    # legacy still green
bun test test/integration/tool-surface-replacement.test.ts         # new invariants green

# differential — every (fixture × command) tuple
bun test test/differential/exec-permission.diff.test.ts

# coverage 100% on touched
bun test --coverage src/tool/process/exec-command.ts
bun test --coverage src/tool/process/write-stdin.ts
bun test --coverage src/tool/process/id.ts
bun test --coverage src/permission/index.ts
bun test --coverage src/session/llm.ts

# perf within budget
bun test ./test/perf/exec-command.bench.ts
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_2.json
```

All exit 0. Per-wave delta versus Wave 1's snapshot logged for trend tracking.

## Files

New:
- `packages/opencode/test/differential/exec-permission.diff.test.ts`
- `packages/opencode/src/permission/disabled.test.ts` (if not already present)
- `packages/opencode/test/perf/exec-command.bench.ts` (if not extending existing)
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_2.json`

Modified:
- `packages/opencode/src/tool/process/id.ts` (PermissionKey → ShellID.ToolID)
- `packages/opencode/src/tool/process/exec-command.ts` (use ShellScan + new ask shape)
- `packages/opencode/src/tool/process/write-stdin.ts` (no logic change; gets the new key transitively via id.ts)
- `packages/opencode/src/permission/index.ts` (SHELL_TOOLS category)
- `packages/opencode/src/session/llm.ts` (resolveTools group rule)
- `packages/opencode/src/tool/process/exec-command.test.ts` (new tests)
- `packages/opencode/src/tool/process/write-stdin.test.ts` (new tests)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts` (5 invariants unskipped)
