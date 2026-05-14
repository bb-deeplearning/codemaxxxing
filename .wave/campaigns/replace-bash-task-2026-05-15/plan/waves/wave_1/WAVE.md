# Wave 1 — Extract bash scanner to `tool/shell/scan.ts` (pure refactor)

<!--
Previous waves: 0 (fixture suite + scanner-corpus.json + integration scaffold + baseline).
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../INTEGRATION_INVARIANTS.md (focus: scanner-extract-preserves-bash-output, scanner-deterministic-under-concurrent-load, scanner-handles-1000-fuzz-inputs-without-crash)
- ../../FIXTURES.md (focus: scanner-corpus.json)
- ../../REFERENCES.md
- packages/opencode/src/tool/shell.ts (the entire file — you're refactoring it)
- packages/opencode/src/tool/shell/id.ts, prompt.ts (touch sites)
-->

## Goal

Lift the bash AST scan + permission-derivation logic out of `tool/shell.ts` into a new shared module `tool/shell/scan.ts`. `shell.ts` becomes a thin consumer of the new module. **No behavior change.** No other tool starts using the new module yet — that's Wave 2.

The differential test is the headline gate: byte-identical `Scan` output for every command in `scanner-corpus.json`.

## Tasks

Sequential. One sub-agent. The work is interdependent — extraction touches one file, the consumer is the same file.

### 1. Tests first — `tool/shell/scan.test.ts`

Write the unit test file for the to-be-extracted module BEFORE writing the module. Cover:

- `scanCommand("git status") returns Scan with patterns ["git status"], always ["git *"], dirs []`
- `scanCommand("rm /tmp/foo") returns Scan with always ["rm *"], dirs containing "/tmp"` (assuming cwd inside workspace)
- `scanCommand("git status | grep foo") returns Scan with patterns from both pipeline stages`
- `scanCommand("npm test && npm run build") returns Scan with patterns from both chain stages`
- `scanCommand("") returns empty Scan`
- `scanCommand("cd /home/user") triggers external_directory branch via dirs`
- `askForScan with empty Scan does not call ctx.ask at all`
- `askForScan with non-empty patterns calls ctx.ask once with permission "bash"`
- `askForScan with non-empty dirs calls ctx.ask twice — external_directory then bash, in that order`
- `askForScan with extraAlways appends to the bash ask's always array`
- Each helper that's worth testing in isolation: `commandHead`, `pathArgs`, `argPath`, `home`, `unquote`, `prefix`, `dynamic`, `provider`, `expand`, `source`, `cygpath` — one happy + one edge per helper. (Helpers that are pure pass-throughs of tree-sitter API don't need their own tests; covered transitively by `scanCommand` tests.)

Run red:
```bash
cd packages/opencode
bun test src/tool/shell/scan.test.ts   # all fail because scan.ts doesn't exist yet
```

### 2. Implement `tool/shell/scan.ts`

Move from `tool/shell.ts` verbatim:
- Constants: `MAX_METADATA_LENGTH`, `DEFAULT_TIMEOUT` (only ones actually used by the scan? if not, leave in shell.ts), `CWD`, `FILES`, `CMD_FILES`, `FLAGS`, `SWITCHES`
- Types: `Part`, `Scan`
- Functions: `parser` (lazy WASM loader at lines 308-333), `parse` (line 261-265), `commands`, `parts`, `pathArgs`, `argPath`, `resolvePath`, `home`, `unquote`, `prefix`, `dynamic`, `provider`, `expand`, `source`, `cygpath`
- `collect` (line 373-409)
- `ask` (line 267-288) — rename to `askForScan`, signature change: takes `extra?: { extraAlways?: string[]; metadata?: Record<string, unknown> }` so Wave 2 can append the `pid:<n>` always-rule.

Add the public `scanCommand`:

```ts
export const scanCommand = Effect.fn("ShellScan.scan")(function* (input: {
  command: string
  shell: string
  cwd: string
  instance: InstanceContext
}) {
  const ps = Shell.ps(input.shell)
  const tree = yield* Effect.acquireRelease(
    parse(input.command, ps),
    (t) => Effect.sync(() => t.delete()),
  )
  const scan = yield* collect(tree.rootNode, input.cwd, ps, input.shell, input.instance)
  if (!containsPath(input.cwd, input.instance)) scan.dirs.add(input.cwd)
  return scan
})
```

`askForScan` mirrors the current `ask` (lines 267-288) but accepts the `extra` param. The `permission: ShellID.ToolID` (= `"bash"`) line is unchanged — single permission key for all shell-flavored surfaces.

Module shape per `STYLE.md`:
```ts
// at end of file
export * as ShellScan from "./scan"
```

The Effect service deps (`Plugin.Service`, `AppFileSystem.Service`, etc.) used by `argPath`/`resolvePath` need to be threaded explicitly — `scanCommand` and `askForScan` are `Effect.fn` returning `Effect.Effect<..., ..., R>` where R is the union of those service tags. Don't widen requirements unnecessarily.

### 3. Refactor `tool/shell.ts` to consume the new module

Replace lines 261-288 (parse + ask defs) and 373-409 (collect) with imports from `./shell/scan`. Replace lines 605-614 (the `parse` + `collect` + `ask` call sequence) with:

```ts
const scan = yield* ShellScan.scanCommand({
  command: params.command,
  shell,
  cwd,
  instance: executeInstance,
})
yield* ShellScan.askForScan(ctx, scan)
```

Drop the now-unused imports (`web-tree-sitter`, `lazy`, `BashArity`, `containsPath`, `AppFileSystem` if no other uses, etc.). `bun typecheck` will surface anything you missed.

### 4. Differential test — `test/differential/scanner-extract.diff.test.ts`

This is the headline test. For every entry in `scanner-corpus.json`:

```ts
import corpus from "../fixtures/scanner-corpus.json"

it.live("scanner-extract: every corpus command produces matching Scan", () =>
  Effect.gen(function* () {
    for (const entry of corpus) {
      const scan = yield* ShellScan.scanCommand({
        command: entry.cmd,
        shell: defaultShell,
        cwd: workspaceRoot,
        instance,
      })
      expect(Array.from(scan.patterns).sort()).toEqual(entry.expected_patterns.sort())
      expect(Array.from(scan.always).sort()).toEqual(entry.expected_always.sort())
      expect(Array.from(scan.dirs).sort()).toEqual(entry.expected_dirs.sort())
    }
  }),
)
```

Single failure on any entry = wave failure. The corpus is the oracle Wave 0 generated from the pre-extract `shell.ts` scanner.

### 5. Property test — `test/integration/tool-surface-replacement.test.ts`

Unskip `scanner-handles-1000-fuzz-inputs-without-crash`. Generate 1000 random bash commands from a small grammar (use `Math.random` seeded from `Bun.nanoseconds()`; print seed on failure). Per-input assertions:

- `scanCommand` returns without throwing
- Re-running on the same input produces the same `Scan` (deterministic)
- `BashArity.prefix(tokens).length <= tokens.length`

```ts
it.instance("scanner-handles-1000-fuzz-inputs-without-crash", () =>
  Effect.gen(function* () {
    const seed = Bun.nanoseconds()
    const rng = makeRng(seed)
    for (let i = 0; i < 1000; i++) {
      const cmd = generateCommand(rng)
      const a = yield* ShellScan.scanCommand({ command: cmd, ... }).pipe(
        Effect.catch((e) => {
          throw new Error(`fuzz failure at i=${i} seed=${seed} cmd=${cmd} err=${e}`)
        }),
      )
      const b = yield* ShellScan.scanCommand({ command: cmd, ... })
      expect(scanEqual(a, b)).toBe(true)
    }
  }),
)
```

`generateCommand(rng)` lives in `test/fixtures/fuzz.ts`. Grammar: command (1-3 tokens) + optional flags + optional pipe to second command + optional && chain. Categories drawn from `FIXTURES.md` § "Scanner command corpus".

### 6. Concurrent stress — `test/integration/tool-surface-replacement.test.ts`

Unskip `scanner-deterministic-under-concurrent-load`. N=64 concurrent invocations:

```ts
it.instance("scanner-deterministic-under-concurrent-load", () =>
  Effect.gen(function* () {
    const inputs = Array.from({ length: 64 }, (_, i) => corpus[i % corpus.length])
    const results = yield* Effect.forEach(
      inputs,
      (e) => ShellScan.scanCommand({ command: e.cmd, ... }).pipe(
        Effect.map((scan) => ({ cmd: e.cmd, scan, expected: e })),
      ),
      { concurrency: 64 },
    )
    for (const r of results) {
      expect(Array.from(r.scan.patterns).sort()).toEqual(r.expected.expected_patterns.sort())
      expect(Array.from(r.scan.always).sort()).toEqual(r.expected.expected_always.sort())
    }
  }),
)
```

Each result must match its input. If any cross-contamination from shared parser state happens, this test reveals it.

### 7. Integration invariant — `scanner-extract-preserves-bash-output`

Unskip the third invariant. Tests the COMPOSED behavior: legacy `bash` tool, after refactor, still produces identical `Scan` (asserted via the corpus oracle) AND identical `ctx.ask` payload.

```ts
it.instance("scanner-extract-preserves-bash-output", () =>
  Effect.gen(function* () {
    const captured: Permission.AskRequest[] = []
    yield* Bus.subscribe(Permission.Event.Asked, (e) => Effect.sync(() => captured.push(e)))
    for (const entry of corpus) {
      yield* runShellTool({ command: entry.cmd })
      const ask = captured.pop()!
      expect(ask.permission).toBe("bash")
      expect(ask.always.sort()).toEqual(entry.expected_always.sort())
    }
  }),
)
```

### 8. Mutation probe (post-implementation)

After the wave's tests are green:

1. Open `tool/shell/scan.ts`, find the `BashArity.prefix(tokens).join(" ") + " *"` line in `collect`.
2. Change `" *"` to `""` (delete the wildcard suffix).
3. Run `bun test src/tool/shell/scan.test.ts` and `bun test test/differential/scanner-extract.diff.test.ts`.
4. Assert at least one test goes RED.
5. Restore the line. Re-run; all green.
6. Document the probe in NOTES.md.

### 9. Bench

Extend `test/perf/baseline.bench.ts` (or create `test/perf/scan.bench.ts`) to re-measure `scan.cmd_short`, `scan.cmd_pipe`, `scan.cmd_chain`, `scan.cmd_long`, `shell.exec`. Output to `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_1.json`. Compare against `baseline-perf.json` (Wave 0). Pure refactor — expect ±2%, fail anything beyond ±5%.

## Test pyramid quota for Wave 1

- Unit: 10-15 tests in `scan.test.ts` (per helper + happy path).
- Integration: 3 invariants unskipped (scanner-extract-preserves-bash-output, scanner-deterministic-under-concurrent-load, scanner-handles-1000-fuzz-inputs-without-crash).
- Differential: 1 (`scanner-extract.diff.test.ts`, every corpus entry).
- Property: 1 (the fuzz test, 1000 inputs).
- Concurrent stress: 1 (N=64).
- Plugin contract: 0.
- Bench: 4-5 metrics re-measured.

## Gotchas

1. **`Effect.acquireRelease` for the parsed tree.** The current `shell.ts:607-609` uses `Effect.acquireRelease(parse(...), (tree) => Effect.sync(() => tree.delete()))`. Mirror this in `scanCommand`. Tree-sitter parser nodes leak memory if not deleted. Property test will surface this if the per-call cost spirals upward as the WASM heap fills.

2. **`Shell.ps(shell)` sniff.** The `ps` boolean (PowerShell vs bash) is currently derived inside `shell.ts:604` and passed to `parse` and `collect`. `scanCommand` does the same internally — caller doesn't need to pre-compute. `Shell.acceptable(cfg.shell)` is the canonical default (used by `shell.ts:585`); preserve that as the call-site default for both `bash` (Wave 1, unchanged) and `exec_command` (Wave 2).

3. **`containsPath(cwd, instance)` workspace check.** Currently at `shell.ts:611`. Move INSIDE `scanCommand` so the cwd-out-of-workspace branch fires consistently. Test: a fixture with cwd outside workspace must produce `dirs` containing the cwd.

4. **`web-tree-sitter` WASM is loaded once globally.** Per the lazy loader at `shell.ts:308-333`. Moving the loader to `scan.ts` means it loads on first `scan.ts` import. The first-load latency (~10-20ms loading bash + powershell WASM blobs) is paid once per process. Bench's warmup phase absorbs it.

5. **Single-permission-key invariant.** `askForScan` MUST use `permission: ShellID.ToolID` (= `"bash"`) for the patterns ask. Don't introduce a new permission key here. Wave 2 relies on this.

6. **`extraAlways` is appended, not replaced.** When Wave 2 calls `askForScan(..., { extraAlways: [pidPattern(N)] })`, the `pid:<N>` rule is appended to whatever the AST scan produced. Don't substitute. Test:
   ```ts
   expect(askPayload.always.sort()).toEqual([...scan.always, "pid:42"].sort())
   ```

7. **Don't change the `ctx.ask` order.** Today `external_directory` fires before `bash`. The `bash` invariant test in step 7 asserts this. If you reorder, snapshot tests in Wave 6 fail.

8. **No new dependencies.** `web-tree-sitter`, `tree-sitter-bash`, `tree-sitter-powershell` are already in `package.json`. Don't add anything.

9. **`argPath` / `resolvePath` / `cygpath` / `collect` / `shellEnv` are defined INSIDE the `Tool.define` closure today** (`shell.ts:335` onwards), not at top level. They yield services from the enclosing `Effect.gen` (`config`, `spawner`, `fs`, `trunc`, `plugin`). Lifting them into `tool/shell/scan.ts` means each one becomes either (a) a top-level `Effect.fn` that `yield*`s the service it needs (so its R-channel includes that service), or (b) a curried factory that takes the resolved service handles. Pick (a) — it matches the rest of the codebase. The resulting `scanCommand` and `askForScan` will have an R-channel union of `AppFileSystem.Service | ChildProcessSpawner | Plugin.Service` (depending on which sub-functions they call). The two consumers — `shell.ts` (Wave 1) and `exec-command.ts` (Wave 2) — already provide all those services in their own layer construction, so no new layer plumbing. Verify by attempting the typecheck after extraction; tsc will error if any service slipped your `R` declaration.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# tests
bun test src/tool/shell/scan.test.ts
bun test src/tool/shell.test.ts                                    # legacy tests still green
bun test test/differential/scanner-extract.diff.test.ts            # corpus matches
bun test test/integration/tool-surface-replacement.test.ts         # 3 invariants unskipped + scaffold

# coverage 100% on new files
bun test --coverage src/tool/shell/scan.ts
bun test --coverage src/tool/shell.ts                              # touched (consumer change)
bun test --coverage test/differential/scanner-extract.diff.test.ts

# perf within budget vs baseline
bun test ./test/perf/baseline.bench.ts                             # or scan.bench.ts
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_1.json

# corpus is unchanged (Wave 1 must not regenerate)
git diff --quiet test/fixtures/scanner-corpus.json
```

All exit 0.

## Files

New:
- `packages/opencode/src/tool/shell/scan.ts`
- `packages/opencode/src/tool/shell/scan.test.ts`
- `packages/opencode/test/differential/scanner-extract.diff.test.ts`
- `packages/opencode/test/fixtures/fuzz.ts` (helper for property test)
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_1.json`

Modified:
- `packages/opencode/src/tool/shell.ts` (remove extracted code, add imports)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts` (unskip 3 invariants)
- `packages/opencode/test/perf/baseline.bench.ts` (or new `scan.bench.ts`) — extend metrics

Unchanged but referenced:
- `packages/opencode/test/fixtures/scanner-corpus.json` (consumed; do NOT regenerate)
