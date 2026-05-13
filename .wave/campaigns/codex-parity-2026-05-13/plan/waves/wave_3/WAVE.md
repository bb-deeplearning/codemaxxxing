# Wave 3 — tool/process.ts (exec_command + write_stdin)

**Prior waves:** 0, 1 (head/tail buffer), 2 (Pty.read + extensions).
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`, `MESSAGE_SHAPES.md`, `TOOL_SCHEMAS.md`, `PROMPT_ENGINEERING.md`, `BACKWARD_COMPAT.md`, `REFERENCES.md`.
**Codex source to mirror:**
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs` (353 lines)
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs` (110 lines)
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/tools/handlers/shell_spec.rs:28-154, 319-351` — JSON schemas

Permission key for both tools: `exec_command` (shared — see `MESSAGE_SHAPES.md` § "Permission keys"). The per-PID always-pattern is `pid:<process_id>`.

## Goal

Build the model-facing tool surface for unified_exec: two tools (`exec_command`, `write_stdin`) with codex-quality prompts, exact semantic parity, full TDD, registered into the agent toolset.

## Tasks

Sequential.

### 1. Add unified_exec constants module

File: `packages/opencode/src/tool/process/constants.ts`

Export every constant from `CONSTANTS.md` § "unified_exec", "Tool defaults", "Environment variables". Use Effect Schema brands for type safety where useful (e.g. `ProcessID = Schema.Number.pipe(Schema.brand("ProcessID"))`).

### 2. Tool ID module

File: `packages/opencode/src/tool/process/id.ts`

```ts
export const ExecCommandID = { ToolID: "exec_command" as const }
export const WriteStdinID = { ToolID: "write_stdin" as const }
```

Mirror the pattern from `packages/opencode/src/tool/shell/id.ts`. The ToolID strings match codex exactly.

### 3. Tests first — schema and prompt

File: `packages/opencode/src/tool/process/schema.test.ts`

Cover:
- `exec_command schema includes cmd as required, all other params optional`
- `exec_command schema marks cmd, workdir, shell, tty, yield_time_ms, max_output_tokens with descriptions`
- `exec_command schema additionalProperties === false`
- `exec_command output schema includes wall_time_seconds and output as required, session_id/exit_code/chunk_id as optional`
- `write_stdin schema includes session_id as required`
- `write_stdin defaults yield_time_ms to 250`
- `exec_command description text contains operational guidance keywords` (snapshot or contains-checks for: "persistent", "REPL", "tty", "session_id round-trip", "5000ms minimum poll" or equivalents — verify the prose teaches the operational decisions per `PROMPT_ENGINEERING.md`)
- `write_stdin description text covers empty-poll discipline, tty requirement, session_id semantics`

The description tests check for substantive content. They DON'T snapshot the entire prose (that would over-fixate). They check that key operational decisions are addressed.

### 4. Tests first — exec_command behavior

File: `packages/opencode/src/tool/process/exec-command.test.ts`

Use `it.live` for tests that spawn real child processes. Use a portable child program: `bun -e '<inline JS>'` instead of system commands.

Cover:

- `exec_command with simple short-running command returns exit_code, no session_id` — `bun -e "process.exit(0)"`, no tty, default yield
- `exec_command with long-running command returns session_id, no exit_code` — `bun -e "setInterval(()=>{},1000)"`, tty:true, yield 250ms; verify session_id is a positive integer in [1000, 100000]
- `exec_command output is returned as text (head+tail truncated when over max_output_tokens)` — spawn a script that prints 100k bytes, set max_output_tokens=1000, verify head+tail are present (look for both "start" and "end" markers in the output)
- `exec_command yields after yield_time_ms even if process is still running` — verify `wall_time_seconds * 1000` ≈ yield_time_ms within ±100ms tolerance
- `exec_command emits Pty Created event on spawn` — Bus subscribe and verify
- `exec_command emits Pty Exited event on early exit` — verify
- `exec_command first-time spawn requests permission with key "exec_command" and pattern from the command head` — assert `Permission.Event.Asked` published with `permission: "exec_command"`
- `exec_command second invocation against the same already-spawned process_id (via write_stdin) does NOT request permission again` — the always-pattern `pid:<id>` from the first approve covers it
- `exec_command at MAX_UNIFIED_EXEC_PROCESSES (64) prunes the LRU non-protected one and succeeds` — match Wave 2's pruning behavior. Spawning the 65th does NOT reject; it prunes and continues. The model warning was emitted at WARNING_UNIFIED_EXEC_PROCESSES (60+) per Wave 2.
- `exec_command with workdir relative to turn cwd resolves correctly`
- `exec_command sets the unified_exec env vars (NO_COLOR=1, TERM=dumb, ...)` — spawn `bun -e "console.log(process.env.NO_COLOR, process.env.TERM)"` and verify
- `exec_command on aborted ctx.abort kills the spawned process` — start a long-running process, abort, verify it dies (check `Pty.list` no longer has it)

### 5. Tests first — write_stdin behavior

File: `packages/opencode/src/tool/process/write-stdin.test.ts`

- `write_stdin with empty chars and yield_time_ms < 5000 clamps to 5000` — verify wall_time ≈ 5s
- `write_stdin with empty chars and yield_time_ms > 30000 caps at max_write_stdin_yield_time_ms (300000)` — too slow to test fully; use a smaller cap injection or test the clamp logic in isolation
- `write_stdin with non-empty chars on a non-tty session returns StdinClosed error message` — spawn `exec_command tty:false`, write_stdin "hello", expect error
- `write_stdin with non-empty chars on a tty session writes and returns new output` — spawn `bun -e "process.stdin.on('data', d => process.stdout.write('echo:' + d.toString()))"` with tty:true, write "hi\\n", expect output to contain "echo:hi"
- `write_stdin with empty chars is a pure poll, returns new output since cursor` — interactive: spawn, wait, send some output via writes from another fiber (or use a process that emits periodically), poll
- `write_stdin sleeps 100ms after writing before polling` — verify timing has at least 100ms between write and read
- `write_stdin on unknown session_id returns "Unknown process id N" error`
- `write_stdin returns exit_code and drops session_id when process exits during the call` — write "exit\\n" to a process that exits on input; verify return shape
- `write_stdin yield_time_ms below MIN_YIELD_TIME_MS clamps to 250 for non-empty input`

### 6. Implement exec_command

File: `packages/opencode/src/tool/process/exec-command.ts`

Shape:
```ts
import { Tool } from "@/tool/tool"
// ... imports

export const Parameters = Schema.Struct({
  cmd: Schema.String.annotate({ description: "..." }),
  workdir: Schema.optional(Schema.String).annotate({ description: "..." }),
  // ... per TOOL_SCHEMAS.md
})

export const ExecCommandTool = Tool.define(
  ExecCommandID.ToolID,
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    // ...

    return () => Effect.gen(function* () {
      return {
        description: EXEC_COMMAND_PROMPT,  // import from prompt.ts
        parameters: Parameters,
        execute: (params, ctx) => Effect.gen(function* () {
          // 1. Resolve cwd, env (apply UNIFIED_EXEC_ENV)
          // 2. Pty.create({ command, args, cwd, env, origin: "model" }) — allocates the PtyID internally;
          //    spawning is cheap enough to do before permission since `pid:${id}` is the always-pattern
          //    discriminator and only exists post-allocation. See Gotcha #1.
          // 3. ctx.ask({ permission: "exec_command", patterns: [<command head>], always: [`pid:${id}`], metadata: {...} })
          //    — if rejected, Pty.remove(id) and surface error. If user picks "always" the `pid:${id}`
          //    pattern is registered for subsequent write_stdin (see permission/index.ts:250).
          // 4. Wait yield_time_ms via Pty.read with sinceCursor=0
          // 5. Build response: { output, wall_time_seconds, session_id?, exit_code?, ... }
          //    (session_id present iff still alive)
          // 6. ctx.abort handler → Pty.remove on abort
        }),
      }
    })
  }),
)
```

### 7. Implement write_stdin

File: `packages/opencode/src/tool/process/write-stdin.ts`

Same pattern. The clamp logic mirrors codex `process_manager.rs:643-652`. The 100ms post-write sleep mirrors `process_manager.rs:626`.

### 8. Implement prompts

File: `packages/opencode/src/tool/process/prompt.ts`

Two exports:
- `EXEC_COMMAND_PROMPT: string` — full description per `PROMPT_ENGINEERING.md` § "Description must teach the model" for exec_command
- `WRITE_STDIN_PROMPT: string` — same for write_stdin

Codemaxxxing voice: terse, second-person where useful, no marketing prose, covers operational decisions, failure modes, cost. Length floor per PROMPT_ENGINEERING.md.

Also produce `packages/opencode/src/tool/process/exec-command.txt` and `write-stdin.txt` as backing markdown files for the prompts (mirror the `task.txt`/`shell.txt` pattern; `prompt.ts` re-exports from these).

### 9. Register the tools

Modify `packages/opencode/src/tool/registry.ts` (read it first to understand the registry pattern).

Add `ExecCommandTool` and `WriteStdinTool` to the registry. Both should be available to agents whose permission ruleset allows `exec_command`.

### 10. Add `exec_command` permission to defaults

Modify `packages/opencode/src/agent/agent.ts`:
- The `defaults` ruleset (around line 92) — add `exec_command: "ask"` so first spawn requires user approval

**Per-built-in permission overrides happen in Wave 12, not here.** Wave 3 only sets the default. This way Wave 3's tests run against the default `ask` policy and exercise the approval flow.

### 11. Bench

File: `packages/opencode/test/perf/process-tool.bench.ts`

- `process.exec_command.short_command` — measure end-to-end time for `exec_command bun -e "process.exit(0)"`; should be dominated by spawn latency, not our overhead
- `process.write_stdin.poll_with_data` — write 1KB, poll, measure return latency

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_3.json`. No baseline metric to compare directly (this is new); just record numbers.

### 12. Integration test

File: `packages/opencode/test/integration/process-tool.test.ts`

End-to-end through the registry and a real Effect runtime:
- Get the tool from the registry
- Run `exec_command` with `bun -e "process.stdin.on('data', d => { if (d.toString().trim() === 'q') process.exit(0); else process.stdout.write('got:' + d) })"` tty:true
- Verify session_id returned
- Run `write_stdin` with that session_id, chars: "hello\\n"
- Verify output contains "got:hello"
- Run `write_stdin` with chars: "q\\n"
- Verify exit_code: 0 returned, no session_id

This validates the full round trip including approval caching, env vars, cursor tracking.

## Gotchas

1. **Approval caching via permission patterns.** When you call `ctx.ask`, the user can pick "once" or "always". The "always" patterns get added to `state.approved` in `permission/index.ts:250`. To cache per-PID: set the always-pattern to `pid:<process_id>` and the permission key to `exec_command`. Subsequent `write_stdin` calls evaluate `exec_command` permission with pattern `pid:<id>` and find an always-allow rule. **Important:** `pid:${id}` only becomes meaningful once `Pty.create` has allocated the id (line 180 of `pty/index.ts` does this internally — there is no API to pre-supply an id, and Wave 2 does not add one). So the operating order in this wave is: `Pty.create` → `ctx.ask({ permission: "exec_command", patterns: ["cmd-head"], always: [`pid:${id}`], metadata: {...} })` → on rejection, `Pty.remove(id)`; on approval, the `pid:${id}` always-pattern is registered. Spawning before asking is cheap (PTY spawn is microseconds; if denied we tear down immediately) and is the simplest way to keep `pid:${id}` consistent end-to-end.

2. **Permission key naming.** Both tools share permission key `exec_command` (per `MESSAGE_SHAPES.md` § "Permission keys"). Match this string everywhere — agents enable/deny it as `exec_command`.

3. **Env vars.** `UNIFIED_EXEC_ENV` from CONSTANTS.md gets applied OVER the spawn env (override existing). Use `OPENCODE_CI` not `CODEX_CI`.

4. **`Pty.create` already takes an `env` parameter.** Pass the merged env (process env + plugin shell.env + UNIFIED_EXEC_ENV).

5. **`Pty.create` returns `Info`. To get the `PtyID`, use `info.id`.** Wave 2's `Pty.read` takes a `PtyID`.

6. **Permission's "always" lifetime is per-instance.** When opencode restarts, the always-pattern is gone (it's stored in `PermissionTable` though — read `permission/index.ts:158` to confirm). For cross-restart, the user re-approves on first spawn after restart. Document this in the description.

7. **`ctx.abort` semantics.** Tool execution can be aborted by the user (Cmd-C in TUI). On abort, your tool should: terminate the spawned PTY, return whatever output was collected so far, and surface "User aborted the command" in the metadata.

8. **Tool registry registration.** Don't break existing tools. Add to registry without removing anything.

9. **Permission for explore agent.** Wave 12 handles per-built-in permission policy. Wave 3 only sets the default at `"ask"`. Don't override per-agent in this wave — leave it for Wave 12.

10. **Description prose quality.** Re-read `PROMPT_ENGINEERING.md` before writing prompts. Junior-tier prose ("This tool runs commands. Use it when needed.") fails the wave. Write the operational manual — when, when-not, failure modes, cost.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/tool/process/

# coverage on every new file
bun test --coverage src/tool/process/exec-command.ts
bun test --coverage src/tool/process/write-stdin.ts
bun test --coverage src/tool/process/constants.ts
bun test --coverage src/tool/process/id.ts
bun test --coverage src/tool/process/prompt.ts

# integration test passes (uses real PTYs)
bun test test/integration/process-tool.test.ts

# perf bench produced output
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_3.json

# legacy shell tool still works
bun test src/tool/shell.test.ts  # if it exists; otherwise rely on wider tests

# typecheck again to verify registry changes are consistent
bun typecheck
```

All exit 0.

## Files

New:
- `packages/opencode/src/tool/process/constants.ts`
- `packages/opencode/src/tool/process/id.ts`
- `packages/opencode/src/tool/process/exec-command.ts`
- `packages/opencode/src/tool/process/exec-command.txt`
- `packages/opencode/src/tool/process/write-stdin.ts`
- `packages/opencode/src/tool/process/write-stdin.txt`
- `packages/opencode/src/tool/process/prompt.ts`
- `packages/opencode/src/tool/process/schema.test.ts`
- `packages/opencode/src/tool/process/exec-command.test.ts`
- `packages/opencode/src/tool/process/write-stdin.test.ts`
- `packages/opencode/test/integration/process-tool.test.ts`
- `packages/opencode/test/perf/process-tool.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_3.json`

Modified:
- `packages/opencode/src/tool/registry.ts` — register exec_command + write_stdin
- `packages/opencode/src/agent/agent.ts` — add `exec_command: "ask"` to defaults only (per-built-in overrides happen in Wave 12)
