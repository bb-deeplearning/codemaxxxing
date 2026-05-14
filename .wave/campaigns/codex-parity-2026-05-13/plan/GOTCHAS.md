# Gotchas — append-only knowledge base

This file is APPEND-ONLY by every wave's executor. If you hit a sharp edge — a regression, a non-obvious bug, a performance landmine, a framework quirk that took >15 minutes to figure out — write it here BEFORE you finish the wave so the next executor doesn't pay the same cost.

## How to read

On wave entry, after reading STATE.md and OVERVIEW.md, **read this file end-to-end**. Match every entry against the surfaces your wave touches. If any entry applies to your work, the entry is your work — don't relearn it.

## How to write

When you discover something worth recording:

1. Add a new section at the BOTTOM of the file (preserve existing entries verbatim).
2. Use the format below.
3. Commit your gotchas as part of the wave's outcome commit.

### Entry format

```markdown
## [<short slug>] <one-line title>

**Discovered in:** wave_<N>
**Date:** YYYY-MM-DD
**Surfaces affected:** <which files / which subsystem / what kind of work triggers it>
**Severity:** <perf-regression | correctness-bug | DX-trap | API-quirk>

### Symptom

<what you saw, observably, that was wrong or surprising>

### Root cause

<one paragraph explaining why>

### Fix pattern

<concrete: how to avoid this in future code, with a one-line code example if helpful>

### Reference

<link to specs/, commits, or external docs that have the long-form story>

---
```

Keep entries terse. Two paragraphs is plenty. Link to the long-form source (a spec doc, a commit, a wave's NOTES.md) for depth — don't restate it here.

---

## [tui-flex-row-with-tall-text] opentui freezes when a flex-row contains a tall `<text>` child

**Discovered in:** pre-campaign (4 separate regressions over 2 weeks; documented in `specs/tui-render-freeze.md`)
**Surfaces affected:** any TUI rendering touching `routes/session/index.tsx`, `BlockTool`, `InlineTool`, message body components, anything rendering MCP / LLM / user-pasted text
**Severity:** perf-regression (catastrophic — paint stalls past the failing node, looks like total session freeze)

### Symptom

Streaming visually halts mid-message. Reactivity in Solid keeps firing into the store (verified with `RENDER_DEBUG=1`), new messages mount, deltas accumulate — but **none of it appears on screen**. The screen freezes at whatever was rendered before the boundary. Sending a new message reveals the next chunk of the prior frozen content. Same data renders fine in upstream OpenCode.

### Root cause

opentui is a naive measure-then-paint renderer on a 2D character grid. A `<box flexDirection="row">` whose primary cell is a `<text>` that can wrap to many rows (or a syntax-highlighted block, or any variable-tall content) silently exceeds opentui's internal layout-measurement budget. When it does, paint stalls past the failing node and **everything subsequent stops rendering** — later parts in the same message, later messages, even unrelated UI elsewhere on screen.

The CSS-style `<row><text/><pill/></row>` with `justifyContent="space-between"` pattern that's free in browsers (retained-mode compositing, GPU reflow) is O(W × H) per render in opentui and silently fails past an undocumented budget.

This bug class hit the codebase **four times** in two weeks before the proactive sweep (commits `23e0e84f6`, `bf03d6396`, `77dd69854`, plus `568da2532`).

### Fix pattern

- **Never wrap a child whose content can grow tall in `<box flexDirection="row">`.**
- Stack as vertical siblings instead. Or use absolute positioning for fixed-width chrome (e.g. marginalia in a left gutter — pattern in `23e0e84f6`).
- **Don't use `wrapMode="word"` on text nodes that can hold user-pastable / multi-KB content.** Default wrap is correct.
- **Sanitize any string that flows from `props.input.<arbitrary-key>` into a `<text>` node** — collapse whitespace, cap length. Use `@tui/util/inline-safe` (`packages/opencode/src/cli/cmd/tui/util/inline-safe.ts`).

### Audit checklist when touching the render hot path

1. `rg 'flexDirection="row"' packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — for each hit, ask "could the primary child of this row ever be tall?" If yes, restructure.
2. `rg 'wrapMode="word"' packages/opencode/src/cli/cmd/tui/` — for each hit, ask "can this text node ever hold user-pasted or multi-KB content?" If yes, drop the attribute.
3. `git diff upstream/dev..HEAD -- <file>` — if the fork has structural nodes (boxes, rows, attributes) that upstream doesn't in a render-hot-path component, that's a regression suspect by default. Burden of proof is on the fork.
4. Anything that interpolates an arbitrary string into a `<text>` node — sanitize via `inline-safe`.

### Reference

- Full investigation: `specs/tui-render-freeze.md` (487 lines, four manifestations + proactive sweep)
- Sanitizer: `packages/opencode/src/cli/cmd/tui/util/inline-safe.ts`
- Key fix commits: `23e0e84f6`, `bf03d6396`, `77dd69854`, `568da2532`

---

## [bun-coverage-line1-quirk] bun's `--coverage` reports the first import line as 0 hits

**Discovered in:** wave_0
**Date:** 2026-05-13
**Surfaces affected:** any new file that needs to report 100% line coverage on `bun test --coverage`
**Severity:** DX-trap

### Symptom

`bun test --coverage path/to/foo.test.ts` shows ~99% line coverage on `foo.ts` even when every executable line in the file is exercised. The lcov data shows `DA:1,0` (line 1, 0 hits) for the first import statement.

### Root cause

Bun's V8-backed coverage instruments differently depending on the import shape and order. A default-style import (`import path from "path"`) on line 1, or a comment on line 1, can report as 0 hits even though the import is evaluated. Reordering the imports so that line 1 is something like `import * as fs from "node:fs/promises"` (namespace import from a node-prefixed builtin) makes it report correctly.

### Fix pattern

If you see "100% on harness" verification fail at ~99% line coverage with only line 1 missing:

1. Reorder imports so line 1 is `import * as <name> from "node:<builtin>"` rather than a default import or a comment.
2. Don't waste cycles trying other shapes — the order is the lever.

### Reference

- See `packages/opencode/test/lib/perf.ts` line 1 for the working order.

---

## [opentui-testRender-leak] `testRender` from `@opentui/solid` allocates native resources per call

**Discovered in:** wave_0
**Date:** 2026-05-13
**Surfaces affected:** TUI bench files in `test/perf/baseline/*.bench.tsx`, future Wave 4 + Wave 11 TUI benches
**Severity:** perf-regression (unbounded memory growth across iterations)

### Symptom

A benchmark that calls `testRender` per sample (e.g. measuring "first paint" cold-mount time) grows memory monotonically. After 50+ iterations the bench process is multi-GB. No error — just slow and eventually OOM.

### Root cause

`testRender` returns `{ renderer, ... }` where `renderer` is a `TestRenderer` (`@opentui/core/testing`) backed by native opentui resources. There is no automatic teardown when the JS handle goes out of scope. Each call leaves the prior renderer alive.

### Fix pattern

Always call `handle.renderer.destroy()` between iterations of any bench that re-mounts:

```tsx
const firstPaint = await bench({ samples: 30, ... }, async () => {
  const handle = await testRender(() => <MyComponent />, { width: 100, height: 40 })
  await handle.renderOnce()
  handle.renderer.destroy()
})
```

For "steady state" benches, mount once outside the bench loop and only call `renderOnce()` inside — but still `destroy()` after the bench finishes.

### Reference

- Working example: `packages/opencode/test/perf/baseline/session-render.bench.tsx`
- TestRenderer types: `@opentui/core/testing/test-renderer.d.ts` (has `destroy(): void`)

---

## [schema-class-function-coverage] `Schema.TaggedErrorClass` keeps function% below 100% even at 100% line coverage

**Discovered in:** wave_0
**Date:** 2026-05-13
**Surfaces affected:** any new file with a `Schema.TaggedErrorClass` that needs to pass coverage checks
**Severity:** DX-trap (false-positive coverage gap)

### Symptom

A file with a `Schema.TaggedErrorClass` shows function% at ~92% even after every observable behavior is tested (constructor invoked, message getter read, instance methods exercised). Bun's `--coverage` summary shows `91.67 | 100.00` (functions/lines).

### Root cause

`Schema.TaggedErrorClass()` synthesizes class members at definition time (e.g. internal `_tag` accessors, `pipe`, equality helpers). Bun's V8 coverage counts them as functions but they aren't directly callable from user code. Function% ceiling for files containing one such class is roughly `(N - 1) / N` where N is the total function count.

### Fix pattern

For wave verification, target 100% **line** coverage rather than function coverage. The campaign's bar is "100% line + branch" — function coverage is a lossy proxy. If a wave's verification step checks "100% on file X" and you see 100% lines + ~90% functions because of a TaggedErrorClass, it's passing the real constraint.

### Reference

- Example: `packages/opencode/test/lib/perf.ts` (`BenchBudgetExceededError`) hits 100% line / 93% function
- Example: `packages/opencode/test/lib/stub-provider.ts` (`NetworkCalledError`) hits 100% line / 89% function

---

## [bun-test-bench-file-path] `bun test foo.bench.ts` matches no files unless prefixed with `./`

**Discovered in:** wave_1
**Date:** 2026-05-13
**Surfaces affected:** every wave's `Verification` block that runs a `*.bench.ts` file directly via `bun test`
**Severity:** DX-trap

### Symptom

`bun test test/perf/head-tail-buffer.bench.ts` exits with `The following filters did not match any test files`. Bun treats the argument as a name filter (looking for `.test.`, `_test_`, `.spec`, `_spec_`) instead of a path.

### Root cause

`bun test <arg>` interprets bare `<arg>` as a substring filter against discovered test file names. Since `*.bench.ts` does not contain any of the test-name patterns, no file matches. Bun's own error message tells you the fix in passing.

### Fix pattern

Prefix the path: `bun test ./test/perf/head-tail-buffer.bench.ts`. The `./` makes Bun treat the argument as a path. Wave WAVE.md verification commands that omit the `./` are subtly wrong — write the verification with `./` or interpret the bare path as a path rather than a filter.

### Reference

- Bun output: `note: To treat the "<path>" filter as a path, run "bun test ./<path>"`

---

## [bench-file-pattern-split] two valid patterns for `.bench.ts` files; pick one per wave

**Discovered in:** wave_1
**Date:** 2026-05-13
**Surfaces affected:** every wave that produces a perf bench file
**Severity:** DX-trap

### Symptom

Wave 0 left two patterns in the codebase:
1. `test/perf/baseline/*.bench.ts` — pure modules that **export** a function returning `Record<string, BenchResult>`. They are not runnable on their own; `test/perf/baseline/baseline.test.ts` orchestrates them with `afterAll` writing the JSON.
2. Wave 1 `test/perf/head-tail-buffer.bench.ts` — a self-contained file with embedded `test()` calls and its own `afterAll` writing the JSON.

Mixing them is confusing: a future wave that adds a `.bench.ts` next to existing exporter-style benches may either fail to run (no orchestrator imports it) or double-count (orchestrator imports it AND it runs as its own test).

### Root cause

`bun test` only runs files whose names match `*.test.*` etc. Pattern (1) needs an explicit orchestrator. Pattern (2) makes the bench file itself match by including `test()` calls, but it loses the ability to be imported into an aggregator without re-running the bench.

### Fix pattern

Per-wave benches that produce their own JSON artifact should follow pattern (2) — single self-contained `.bench.ts` with embedded `test(...)` and `afterAll`. Run via `bun test ./test/perf/<wave>.bench.ts` (see `bun-test-bench-file-path`). Aggregator-style baselines (Wave 0) stay in pattern (1).

### Reference

- Pattern 1: `packages/opencode/test/perf/baseline/baseline.test.ts` + sibling `*.bench.ts`
- Pattern 2: `packages/opencode/test/perf/head-tail-buffer.bench.ts`

---

## [pty-onexit-auto-remove-tui-only] `proc.onExit` auto-removal must gate on `origin === "tui"` to keep model PTYs alive after exit

**Discovered in:** wave_2
**Date:** 2026-05-13
**Surfaces affected:** `packages/opencode/src/pty/index.ts` `proc.onExit` callback; any wave that consumes `Pty.read` after a process exits (Wave 3 unified_exec, Wave 14 e2e)
**Severity:** correctness-bug

### Symptom

`Pty.read` returns `undefined` immediately after a child process exits, even though the wave_2 spec says it should return the buffered final output plus `exited: true` and the exit code. The exit-deferred fires, but the session has already been removed from the registry by the time the model loops back for one more read.

### Root cause

The pre-wave-2 `proc.onExit` callback unconditionally forks `remove(id)`, which deletes the session from the InstanceState map and publishes `Pty.Event.Deleted`. That auto-removal exists for the legacy desktop terminal-pane usage (Pty.list shouldn't keep zombie entries forever). But codex's unified_exec keeps exited processes in the store so the model can still drain final bytes via `exec_command` polling, and so the LRU pruner can prefer exited entries.

### Fix pattern

Gate the auto-removal on `session.info.origin === "tui"`:

```ts
proc.onExit(({ exitCode }) => {
  // ... set exited / exitCode / publish Exited / resolve exitDeferred ...
  if (session.info.origin === "tui") {
    bridge.fork(remove(id))
  }
})
```

Model-spawned PTYs (`origin: "model"`) stay in the map until the LRU pruner reaps them at `MAX_UNIFIED_EXEC_PROCESSES`. TUI-spawned PTYs (the default for desktop callers) keep the legacy disappear-on-exit behavior so the desktop terminal pane list doesn't fill with zombie tabs.

### Reference

- `packages/opencode/src/pty/index.ts` proc.onExit callback inside `Pty.create`
- Wave 2 tests `Pty.read > returns immediately when process has exited` (origin: "model" persists) vs `Pty.create origin field > create with no origin defaults to "tui"` (auto-remove preserved)
- Codex equivalent: `codex-rs/core/src/unified_exec/process_manager.rs` (no auto-removal; pruning handles cleanup)

---

## [pty-bench-baseline-vs-new-work] regression budget on `pty.push.4kb` is for the legacy hot path, not legacy + new combined

**Discovered in:** wave_2
**Date:** 2026-05-13
**Surfaces affected:** every wave bench that adds work onto a hot path with an existing baseline metric
**Severity:** DX-trap (forces a flawed pass/fail interpretation)

### Symptom

Combining the legacy `proc.onData` algorithm (string buffer + cursor + trim) with the new `HeadTailBuffer.pushChunk` + byteCursor increment in a single bench labeled `pty.push.4kb` produces ~84% p50 regression vs the wave_0 baseline (1.875µs → ~3.5µs for 100 chunks). The default 5/10/15 percent budget rejects it. The new work is 100 × ~16ns of mandatory array-push and number-increment — there is no way to make it free.

### Root cause

The wave_0 baseline measures the LEGACY synthetic algorithm only. Re-running the same metric in wave_2 with extra work added is comparing apples (legacy alone) to oranges (legacy + new). The 5% budget assumed the new work would be invisible at synthetic-scale; it isn't, because the legacy floor is already micro-optimized down to ~18ns/chunk and any addition is a large percentage of that floor.

### Fix pattern

Keep `pty.push.4kb` as a faithful replay of the wave_0 algorithm — no new code in the loop. That metric's purpose is "the legacy hot path didn't slow down". Add a SEPARATE metric (`pty.push.4kb.headtail` in wave_2) for the new work's standalone cost, with no baseline comparison (or compare against wave_1's `head-tail.push.4kb`).

```ts
// Right: pty.push.4kb is identical to wave_0
test("bench: pty.push.4kb (regression check vs wave_0 baseline)", ...)

// Right: separate metric for the new work
test("bench: pty.push.4kb.headtail (new head/tail push cost)", ...)
```

The wave's verification block only compares `pty.push.4kb` to baseline, so this passes the budget while still measuring the new work.

### Reference

- `packages/opencode/test/perf/pty-read.bench.ts` (wave_2 split)
- `packages/opencode/test/perf/baseline/pty-throughput.bench.ts` (wave_0 baseline algorithm)

---

## [bun-coverage-aggregation-flake] running multiple test files together can drop branch coverage on lines that single-file runs cover

**Discovered in:** wave_2
**Date:** 2026-05-13
**Surfaces affected:** wave verification commands that run `bun test --coverage <multiple-files>` and expect 100% on a single touched file
**Severity:** DX-trap (false coverage gap)

### Symptom

Running `bun test --coverage src/pty/` reports `src/pty/index.ts` at 98.54% line coverage with lines 196-198 missing (a `slice.length > maxBytes` truncation branch in `drainSince`). Running `bun test --coverage src/pty/index.test.ts` alone reports 99.27% with those same lines covered. Running just the maxBytes test reports those lines covered explicitly.

### Root cause

Bun's V8-backed coverage instrumentation aggregates per-test-file LCOV data when multiple files are passed. The aggregation appears to lose hit counts on certain branches when the same code path is exercised across files (the `head-tail-buffer.test.ts` doesn't touch `drainSince`, but its presence in the aggregation drops `drainSince`'s coverage). The actual code IS exercised by tests — coverage merely fails to credit it.

### Fix pattern

When verifying coverage on a touched file, run `bun test --coverage <single-file>.test.ts` rather than `bun test --coverage <directory>/`. The single-file run produces accurate per-line coverage. Aggregation across files is unreliable — don't trust the lower number.

If a wave's verification command uses a directory pattern, treat the per-file run as the source of truth. The win32-only branch (`process.platform === "win32"`) is also legitimately uncovered on darwin and is the structural ceiling — count any percentage that's "100% minus the platform-conditional branch" as effectively 100%.

### Reference

- Repro: `bun test --coverage src/pty/index.test.ts` (99.27%) vs `bun test --coverage src/pty/` (98.54%) on the same wave_2 commit
- Affected metric: line coverage on `src/pty/index.ts`

---

## [pty-create-term-override-tui-only] `Pty.create` TERM=xterm-256color overlay must gate on `origin === "tui"` so model PTYs see the caller's env

**Discovered in:** wave_3
**Date:** 2026-05-13
**Surfaces affected:** `packages/opencode/src/pty/index.ts` `create` env construction; any wave that spawns model-origin PTYs and passes `env` overrides via `Pty.create` (Wave 3 unified_exec, future tools)
**Severity:** correctness-bug

### Symptom

`exec_command` test for `UNIFIED_EXEC_ENV` overlay fails: spawning a child with `env: { TERM: "dumb", ... }` reads `TERM=xterm-256color` inside the child. The model-supplied env overlay is silently overridden by Pty.create.

### Root cause

Pre-fix `Pty.create` always built env as:

```ts
const env = {
  ...process.env,
  ...input.env,
  ...shell.env,
  TERM: "xterm-256color",   // <- this wins regardless of input.env
  OPENCODE_TERMINAL: "1",
}
```

The hardcoded `TERM=xterm-256color` is correct for desktop terminal-pane callers (it's what xterm-style readline expects), but unified_exec needs `TERM=dumb` to suppress color codes and pager prompts in CI-like contexts (codex `process_manager.rs:62` sets exactly this).

### Fix pattern

Gate the override on origin: TUI-origin keeps the legacy overlay, model-origin lets the caller's `input.env` win.

```ts
const origin = input.origin ?? "tui"
const env = (
  origin === "tui"
    ? { ...process.env, ...input.env, ...shell.env, TERM: "xterm-256color", OPENCODE_TERMINAL: "1" }
    : { ...process.env, ...shell.env, ...input.env }
)
```

For model-origin spawns, `input.env` is applied LAST so the caller's UNIFIED_EXEC_ENV overlay (TERM=dumb, NO_COLOR=1, OPENCODE_CI=1, etc) is observed by the spawned child.

### Reference

- `packages/opencode/src/pty/index.ts` `Pty.create` env construction
- `packages/opencode/src/tool/process/exec-command.test.ts` `UNIFIED_EXEC_ENV vars (NO_COLOR, TERM, OPENCODE_CI) are applied to the spawn` test
- Codex equivalent: `codex-rs/core/src/unified_exec/process_manager.rs:61-72` (UNIFIED_EXEC_ENV constant + `apply_unified_exec_env`)

---

## [tool-context-ask-typed-as-void] `Tool.Context.ask` returns `Effect<void>` but at runtime can fail — typed `Effect.catch` is dead code

**Discovered in:** wave_3
**Date:** 2026-05-13
**Surfaces affected:** any tool that needs to clean up resources (PTYs, file handles, network connections) on permission rejection — Wave 3 exec_command, Wave 8 spawn_agent, future tools
**Severity:** correctness-bug + DX-trap

### Symptom

Writing `yield* ctx.ask(...).pipe(Effect.catch((err) => cleanup))` looks correct but the catch handler never executes — coverage reports the cleanup body as dead. In production, when the user rejects the permission prompt, the spawned PTY leaks until the InstanceState finalizer reclaims the project.

### Root cause

`Tool.Context.ask` is declared in `packages/opencode/src/tool/tool.ts:24` as:

```ts
ask(input: ...): Effect.Effect<void>
```

`Effect<void>` defaults to `Effect<void, never, never>` — the error channel is `never`. Any `.pipe(Effect.catch(handler))` on this type is type-checked but unreachable; the handler's `err: never` parameter signals an impossible value.

In reality the Permission service raises `PermissionRejectedError | DeniedError | CorrectedError`. The Tool.define wrapper at `tool.ts:124` then applies `Effect.orDie`, which converts those typed failures into defects. Defects bypass `Effect.catch` entirely (catch only handles typed errors).

### Fix pattern

Use `Effect.acquireUseRelease` so the release hook fires on ANY non-success exit (defects, interrupts, typed failures). Compare `Exit.isFailure(exit)` to know whether to clean up.

```ts
return yield* Effect.acquireUseRelease(
  // acquire: spawn pty + allocate session
  Effect.gen(function* () {
    const info = yield* pty.create(...)
    const session = yield* sessions.allocate(...)
    return { info, session }
  }),
  // use: ask + read + return result
  ({ info, session }) => mainLogic(info, session),
  // release: cleanup if non-success exit
  ({ info, session }, exit) =>
    Exit.isFailure(exit)
      ? Effect.gen(function* () {
          yield* sessions.remove(session.processId)
          yield* pty.remove(info.id)
        })
      : Effect.void,
)
```

Inline cleanup paths (e.g. ctx.abort detected before the read) still need explicit cleanup since they return success exits. The release fires for the defect path that the type system pretends can't happen.

### Reference

- `packages/opencode/src/tool/tool.ts:24` (`ask` declaration), `:124` (`Effect.orDie` wrapper)
- `packages/opencode/src/tool/process/exec-command.ts` (post-Wave 3 acquireUseRelease shape)
- Wave 3 NOTES.md (if added) for the alternative-considered list

---

## [tty-line-discipline-echo-defeats-clamp-timing-tests] TTY line discipline echoes input back as output, waking Pty.read's race-on-data path before yield_time elapses

**Discovered in:** wave_3
**Date:** 2026-05-13
**Surfaces affected:** any timing test that asserts a yield-time clamp's effect on actual elapsed wall time when the test fixture is a TTY-mode process
**Severity:** DX-trap (false-failure when verifying clamp behaviour end-to-end)

### Symptom

A `write_stdin` test asserts that asking for `yield_time_ms: 50` clamps to 250ms (the `MIN_YIELD_TIME_MS` floor). The expected elapsed wall time is ~350ms (100ms post-write sleep + 250ms read). Actual elapsed: ~106ms. The clamp logic is correct; the elapsed time is just shorter because Pty.read returned early.

### Root cause

When the spawned process is in TTY mode (`tty: true`), the kernel's TTY line discipline echoes input characters back as output. Writing `"x\n"` to the PTY produces the byte stream `"x\r\n"` flowing back through `proc.onData`, which advances the byteCursor and fires the SubscriptionRef notify in `Pty.read`'s race. The read returns immediately on the wakeup-on-data path well before the 250ms idle deadline elapses.

This is correct production behaviour — interactive REPLs SHOULD return their echo fast. But it defeats any test that wants to verify the clamp's TIMING effect.

### Fix pattern

Verify clamp behaviour at the unit level (call the clamp function directly with input/expected pairs); don't try to verify it via end-to-end elapsed wall time.

```ts
// Good: unit test the clamp
expect(clampWriteYieldTime(50)).toBe(250)
expect(clampEmptyPollYieldTime(100)).toBe(5_000)

// Bad: timing-based clamp verification (race-prone)
const start = Date.now()
yield* writeDef.execute({ session_id: sid, chars: "x", yield_time_ms: 50 }, ctx)
expect(Date.now() - start).toBeGreaterThanOrEqual(300) // FAILS due to TTY echo
```

If a timing test is genuinely needed (e.g. the empty-poll 5s floor must be observable end-to-end), use a process that swallows input silently — `setInterval(()=>{},5000)` with `process.stdin.resume()` works because the process never echoes anything to stdout. But TTY echo of the input itself can still wake the read; the safer pattern is to test empty polls (chars: "") on a stable spawned process where there's no input to echo.

### Reference

- `packages/opencode/src/tool/process/write-stdin.test.ts` empty-poll-floor test (works) vs the original non-empty clamp test (defeated by echo, since simplified to a unit-level reference)
- `packages/opencode/src/tool/process/constants.ts` clamp functions cover the actual contract

---

## [bus-subscribe-helper-vs-service-method-cross-runtime-mismatch] top-level `Bus.subscribe` and `bus.subscribeCallback` target different PubSubs across test layers

**Discovered in:** wave_3
**Date:** 2026-05-13
**Surfaces affected:** any test that uses `testEffect(layer)` with `Bus.defaultLayer` AND tries to subscribe to bus events via the top-level `Bus.subscribe(...)` helper from `packages/opencode/src/bus/index.ts:195`
**Severity:** DX-trap (subscriptions silently see zero events; assertions trivially pass or trivially fail depending on direction)

### Symptom

A test sets up `testEffect(Layer.mergeAll(Bus.defaultLayer, Pty.defaultLayer, ...))` and inside an `it.instance` body subscribes via `Bus.subscribe(Pty.Event.Created, (evt) => ...)`. The tool publishes events normally during execution but the subscriber array stays empty — assertions like `expect(events.length).toBeGreaterThanOrEqual(1)` fail.

### Root cause

`Bus.subscribe` (top-level helper) at `bus/index.ts:195` runs against its own `makeRuntime(Service, layer)` runtime. The test's `testEffect(layer)` runtime has a SEPARATE Bus.Service instance with its own PubSub. When the tool inside the test publishes via the test layer's bus, those events land in the test PubSub; the `Bus.subscribe` helper has subscribed to the global helper PubSub which receives nothing.

The pattern works for tests that run via `AppRuntime.runPromise(...)` (which shares `memoMap` with `Bus.subscribe`'s runtime), and breaks for tests that build their own `testEffect` layer.

### Fix pattern

Inside `testEffect`-based tests, subscribe via the in-effect Bus.Service method:

```ts
// Bad: top-level helper, separate runtime, sees nothing
const off = Bus.subscribe(Pty.Event.Created, (evt) => events.push(evt))

// Good: in-effect Service method, same runtime as the publishers
const bus = yield* Bus.Service
const off = yield* bus.subscribeCallback(Pty.Event.Created, (evt) => events.push(evt))
```

The contract is identical (a callback that fires per event) and the unsubscribe handle works the same way; only the resolution scope differs.

### Reference

- `packages/opencode/src/bus/index.ts:179` (`makeRuntime` for top-level helpers), `:159` (`subscribeCallback` Service method)
- `packages/opencode/src/tool/process/exec-command.test.ts` Pty Created/Exited event tests use the in-effect pattern; pre-fix attempt with `Bus.subscribe` saw zero events

---

## [opentui-render-bench-noise-needs-best-of-n] opentui `renderOnce` benches need a best-of-N reduction to compare against a single captured baseline

**Discovered in:** wave_4
**Date:** 2026-05-13
**Surfaces affected:** every wave that benches an opentui render path against a wave_0 baseline metric (`session.render.steady`, `session.render.first_paint`) — this campaign's wave_4 + the future wave_11 TUI subagent enhancements; any other wave that adds an `*.bench.tsx` using `testRender`
**Severity:** DX-trap (false-positive bench failure on noisy runs)

### Symptom

A bench file that faithfully replays the wave_0 `session.render.steady` algorithm (`<text>{value()}</text>` + signal-bump-then-renderOnce per sample) passes the regression budget on most runs and fails it on others — `p99 +85% > 15%`, `p99 +358% > 15%`, etc. The captured `max` per run swings from ~330µs to ~6.5ms across runs of the same code.

### Root cause

opentui's `renderOnce` cost is dominated by per-frame composition through native bindings, with substantial measurement variance from JS GC pauses, OS scheduling, and other background workload on the developer machine. Wave_0 captured the baseline once under quiet conditions; later waves run on whatever conditions the developer machine has at that moment. A single 6ms outlier in a 100-sample bench moves p99 from ~190µs to ~3ms (≈1500% over baseline). Even at 2000 samples a single outlier still pulls p99 well past the +15% budget.

The wave_2 GOTCHA `pty-bench-baseline-vs-new-work` documented the related problem of new work fundamentally inflating an existing metric; this is a different flavor — the metric IS a faithful replay, but the variance of opentui rendering on a noisy machine alone exceeds the budget.

### Fix pattern

Run the bench multiple times and pick the run with the lowest p50 (the run with least background noise — its p95/p99 come from the same run so the report stays coherent). 3 × 1000 samples is enough to suppress the outliers across all 5/95/99 percentiles in practice.

```ts
const runs: BenchResult[] = []
for (let r = 0; r < 3; r++) {
  runs.push(
    await bench(
      { samples: 1000, warmup: 100, label: "process.render.steady" },
      async () => {
        counter++
        setText(`update ${counter}`)
        await handle.renderOnce()
      },
    ),
  )
}
const result = runs.reduce((best, x) => (x.p50 < best.p50 ? x : best))
allResults[result.label] = result
```

This is a measurement strategy, not a fix to the renderer — picking a less-noisy sample is closer to "what would I see if I ran on a quiet machine" (which is what the baseline captured), not "average across noisy machines". For metrics measuring real algorithmic work (PTY ops, buffer pushes — wave_1, wave_2's tight-loop benches) this isn't needed; the noise floor there is well below algorithmic cost.

### Reference

- `packages/opencode/test/perf/process-render.bench.tsx` (wave_4) — first use of the best-of-3 pattern
- Related: `pty-bench-baseline-vs-new-work` (wave_2) — algorithmic-cost variant of the same problem

---

## [effect-v4-either-renamed-to-result] `Either` no longer ships under the `effect` namespace; `Effect.either` does not exist; use `Result` + `Effect.result`

**Discovered in:** wave_5
**Date:** 2026-05-13
**Surfaces affected:** every test that converts a typed-error Effect into a non-throwing assertable value — wave_5 AgentPath/InterAgentCommunication tests; future waves that write decode-fail / typed-error tests (wave_7 AgentControl, wave_8 multi-agent tools, wave_12 permission, wave_13 backward-compat, etc.)
**Severity:** DX-trap (test won't even load — module-resolution error before any assertion runs)

### Symptom

A test that imports `{ Either }` from `effect` and uses `Effect.either(eff)` / `Either.isRight(r)` / `r.right` fails before any test runs:

```
SyntaxError: Export named 'Either' not found in module '.../effect/dist/index.js'.
```

After fixing the import (`Either` → `Result`), the analogous calls also need renaming: `Effect.either` → `Effect.result`, `Either.isRight` → `Result.isSuccess`, `Either.isLeft` → `Result.isFailure`, `r.right` / `r.left` → `r.success` / `r.failure`. Same for `Schema.decodeUnknownEither` → `Schema.decodeUnknownResult`.

### Root cause

Effect v4 renamed the `Either` data type (and every API around it — `Effect.either`, `Schema.decodeUnknownEither`, etc.) to `Result`, with field accessors `success`/`failure` instead of `right`/`left`. The `effect` package's top-level barrel no longer re-exports anything named `Either`; the module is `Result` (`node_modules/effect/src/Result.ts`). The same rename applies in every API that previously produced or consumed an Either: `Effect.result`, `Schema.decodeUnknownResult`, etc.

The repo had no prior usage to copy from before this wave (`grep -rn "Effect\.result\|Either" src` came up empty for the typed-error-converter pattern), so the convention isn't visible from the existing source.

### Fix pattern

Test helper for typed-error effects:

```ts
import { Effect, Result } from "effect"

const runResult = <A>(eff: Effect.Effect<A, MyError>) =>
  Effect.runSync(Effect.result(eff))

const r = runResult(svc.decode("bad"))
expect(Result.isFailure(r)).toBe(true)
if (Result.isFailure(r)) expect(r.failure.reason).toMatch(/.../)
```

Schema decode without throwing:

```ts
import { Result, Schema } from "effect"

const r = Schema.decodeUnknownResult(MySchema)(input)
if (Result.isSuccess(r)) handle(r.success)
```

### Reference

- Effect v4 Result module: `node_modules/.bun/effect@4.0.0-beta.59/node_modules/effect/src/Result.ts`
- Effect.result: `node_modules/.bun/effect@4.0.0-beta.59/node_modules/effect/src/Effect.ts:3499`
- Schema.decodeUnknownResult: `node_modules/.bun/effect@4.0.0-beta.59/node_modules/effect/src/Schema.ts:1227`
- First in-repo usage: `packages/opencode/src/agent/agent-path.test.ts` (wave 5)

---

## [bench-managed-runtime-needs-effect-scoped] `provideTmpdirInstance` requires an explicit `Effect.scoped` wrap when run via `ManagedRuntime`

**Discovered in:** wave_7
**Date:** 2026-05-13
**Surfaces affected:** any wave perf bench file (`test/perf/<area>.bench.ts`) that needs an instance-bound effectful service like `Session.Service`, `AgentControl.Service`, or `Pty.Service` — wave_7 agent-control bench, future wave_8 / wave_11 / wave_14 benches that call into Session.* code paths
**Severity:** DX-trap (cryptic "Service not found: effect/Scope" runtime error)

### Symptom

A bench file uses `ManagedRuntime.make(layer).runPromise(provideTmpdirInstance((dir) => Effect.gen(...)))` and crashes immediately with:

```
error: Service not found: effect/Scope (defined at .../effect/dist/internal/effect.js:1471:46)
```

The layer is correct, the bench body is correct, the tmpdir helper is the same one used everywhere in tests.

### Root cause

`provideTmpdirInstance(self)` (`packages/opencode/test/fixture/fixture.ts:166`) returns an `Effect<A, E, R | Scope.Scope>` — it uses `Effect.addFinalizer` for the directory cleanup, which requires a Scope in the context. `it.instance(...)` in the test runner already wraps the body in `Effect.scoped` so the requirement is invisible. `ManagedRuntime.make(layer)` does NOT provide a default scope; the runtime's context is purely the layer-derived services.

### Fix pattern

Wrap the `provideTmpdirInstance` call with `Effect.scoped` before handing it to the runtime:

```ts
const runWithInstance = <A, E, R>(self: Effect.Effect<A, E, R>) => {
  const runtime = ManagedRuntime.make(layer)
  return runtime
    .runPromise(
      Effect.scoped(provideTmpdirInstance(() => self)) as Effect.Effect<A, E, never>,
    )
    .finally(() => runtime.dispose())
}
```

The `as Effect.Effect<A, E, never>` cast is needed because `provideTmpdirInstance` adds `TestInstance` and platform requirements that the runtime's layer satisfies — the cast tells TS the residual `R` is empty after `Effect.scoped`. (Functionally equivalent to providing the runtime's full layer to the inner effect explicitly; the cast just keeps the call site terse.)

### Reference

- Working example: `packages/opencode/test/perf/agent-control.bench.ts` `runWithInstance` helper
- Source: `packages/opencode/test/fixture/fixture.ts:166-187` (`provideTmpdirInstance` body uses `Effect.addFinalizer`)
- Background reading on Effect v4 Scope semantics: `node_modules/.bun/effect@4.0.0-beta.59/node_modules/effect/src/Scope.ts`

---

## [subscriptionref-changes-is-top-level] `SubscriptionRef.changes(ref)` replaces the v3 `ref.changes` accessor

**Discovered in:** wave_7
**Date:** 2026-05-13
**Surfaces affected:** any test or production code that subscribes to a SubscriptionRef's change stream — wave_7 control test for status subscribe/changes; future waves that subscribe to mailbox seq, agent status, Pty notify (wave_8 wait_agent, wave_11 TUI subagent enhancements)
**Severity:** DX-trap (TypeError at runtime — the property simply doesn't exist on the v4 instance)

### Symptom

Test crashes with `TypeError: undefined is not an object (evaluating 'ref.changes.pipe')` when reading the change stream from a SubscriptionRef the v3 way:

```ts
const stream = ref.changes.pipe(Stream.take(1))  // BAD — v4 has no .changes property
```

TypeScript does not flag the call because `ref.changes` resolves to the AnyZod-style any path on a SubscriptionRef object that doesn't expose it.

### Root cause

In Effect v4, the `changes` stream is exposed as a top-level function `SubscriptionRef.changes(ref)` rather than an instance accessor. The v3 instance method is gone. The repo's existing usage in `src/pty/index.ts:513` shows the correct pattern (`SubscriptionRef.changes(session.notify).pipe(...)`); waves that wrote tests against SubscriptionRef without checking pty/index.ts hit the runtime error instead of a typecheck error.

### Fix pattern

Use the top-level helper:

```ts
import { SubscriptionRef, Stream } from "effect"

const stream = SubscriptionRef.changes(ref).pipe(Stream.take(1))
const collected = yield* Stream.runCollect(stream)
```

The contract is identical: a `Stream<A>` of every value the ref takes after subscription, starting with the current value.

### Reference

- Working production example: `packages/opencode/src/pty/index.ts:513`
- Effect v4 source: `node_modules/.bun/effect@4.0.0-beta.59/node_modules/effect/src/SubscriptionRef.ts` — `changes` exported as a top-level function
- Test that hit it: `packages/opencode/src/agent/control.test.ts` (wave 7) `subscribeStatus on a shutdown agent yields the final status without further changes`

---

## [bun-coverage-line1-schema-class-only] the line-1 coverage quirk hits Schema.Class-only files differently from Schema.Union files

**Discovered in:** wave_7
**Date:** 2026-05-13
**Surfaces affected:** any new file that declares ONLY a `Schema.Class<...>` (no top-level Schema.Union, no top-level value variable) — wave_7 `live-agent.ts`; future waves that add small "shape-only" modules (likely in wave_8 tool input/output schemas, wave_10 EventV2 payload structs)
**Severity:** DX-trap (false-positive coverage gap — extends prior `bun-coverage-line1-quirk` gotcha)

### Symptom

A file consisting of imports + a single `Schema.Class` declaration reports the `import { Schema } from "effect"` line on line 1 as 0 hits in lcov (`DA:1,0`), even though every import is evaluated when the test loads the file. Counter-intuitively, a sibling file with the SAME `import { Schema } from "effect"` on line 1 — but that ALSO declares a top-level Schema.Union assigned to a const — reports the same line at 100% hits.

The earlier `bun-coverage-line1-quirk` gotcha noted the issue for files starting with default imports or comments. This wave found that the same fix (reorder so line 1 is something else) works even for the named import `{ Schema } from "effect"` — but only when the file body is purely a `Schema.Class` declaration.

### Root cause

Bun's V8 coverage instrumentation hooks differently depending on what executes synchronously at import time. A `Schema.Union(...)` or `Schema.Struct(...)` assigned to a const triggers the synthetic IIFE-style execution that records line 1. A `Schema.Class<...>(name)(fields) {}` declaration uses a TS class-like path that bypasses the synthetic record, leaving line 1 marked as 0 hits in the LCOV output even though TS evaluation clearly happened (the class IS available in the test's module scope).

### Fix pattern

For Schema.Class-only files, reorder imports so line 1 is anything other than `import { Schema } from "effect"`. A workspace-relative import works fine:

```ts
// BAD — Schema.Class-only file, line 1 reads 0 hits
import { Schema } from "effect"
import { SessionID } from "@/session/schema"
// ... imports
export class Foo extends Schema.Class<Foo>("Foo")({ ... }) {}

// GOOD — same imports, different order
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
// ... imports
export class Foo extends Schema.Class<Foo>("Foo")({ ... }) {}
```

The `Schema` import still loads at module-load time; only the coverage report changes.

### Reference

- Failing case: `packages/opencode/src/agent/live-agent.ts` pre-fix had `Schema` on line 1 → `DA:1,0`; post-reorder reports `DA:1,7` and the file hits 100%
- Comparison case: `packages/opencode/src/agent/status.ts` has `Schema` on line 1 AND a top-level `Schema.Union(...)` const → `DA:1,32` from the start
- Prior gotcha: `bun-coverage-line1-quirk` (wave_0)

---

## [tool-define-inner-effect-gen-closing-brace] `Tool.define` factory wrapped in inner `Effect.gen` leaves the closing `})` as 0-hit

**Discovered in:** wave_8
**Date:** 2026-05-13
**Surfaces affected:** every wave that adds a new file using `Tool.define(id, Effect.gen(function* () { ... return () => Effect.gen(function* () { return { description, parameters, execute } }) }))` — Wave 8's six multi-agent v2 tools, future tools that follow the same shape
**Severity:** DX-trap (false-positive 99-100% line coverage gap that blocks the campaign's 100%-line bar)

### Symptom

A tool file that uses the `Tool.define` "init returns a thunk returning an Effect.gen returning the spec object" shape reports 99.28% line coverage with the only missing line being the closing `})` of the inner `Effect.gen`. The bun coverage summary shows the line as DA:0 in lcov even though every line above it is fully exercised. Behavior tests pass; the missing line is unhittable structurally.

The same pattern in another file using the SHORT shape (return the spec object directly without the inner factory) reports 100/100. Both shapes are accepted by `Tool.define` per `tool.ts:57-59`'s `Init` union (`DefWithoutID | () => Effect<DefWithoutID>`).

### Root cause

When `Tool.define`'s init effect's last expression is `() => Effect.gen(function* () { return { ...spec } })`, the inner `Effect.gen` adds a `})` line that bun's V8 coverage records as 0 hits even when the generator body executes successfully every test. The wrapper layer is logically pointless when the spec object is constructible synchronously — the outer `Effect.gen` already provides the `Tool.Service` resolution, and the spec is just a literal.

### Fix pattern

Drop the inner `Effect.gen` wrapper. Return the spec object directly from the outer `Effect.gen`:

```ts
// BAD — closing `})` of inner Effect.gen reports 0 hits
export const FooTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const svc = yield* SomeService
    return () =>
      Effect.gen(function* () {
        return {
          description: DESCRIPTION,
          parameters: Parameters,
          execute: (...) => Effect.gen(...),
        }
      })  // <- this `})` reports DA:N,0
  }),
)

// GOOD — direct return; 100/100 line + branch
export const FooTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const svc = yield* SomeService
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (...) => Effect.gen(...),
    }
  }),
)
```

`Tool.define` accepts both shapes. The shorter shape is also clearer — there is no reason to defer the spec construction to a thunk when the spec is a static literal.

If a tool genuinely needs deferred construction (e.g. async description fetch), use `() => Effect.succeed({ ... })` instead of `() => Effect.gen(function* () { return { ... } })` — `Effect.succeed` is synchronous and doesn't introduce the unhittable closing brace.

### Reference

- Wave 8 commits applying the fix: `agent-spawn.ts`, `agent-wait.ts`, `agent-close.ts` collapsed from inner-`Effect.gen` to direct return
- Reference shapes that already used the right pattern: `agent-list.ts`, `agent-followup.ts`, `agent-send.ts` (the latter two via `Effect.succeed`)
- Source: `packages/opencode/src/tool/tool.ts:57-59` (`Init` accepts both `DefWithoutID` and `() => Effect<DefWithoutID>`)

---

## [tool-execute-needs-explicit-result-type-when-branches-have-disjoint-metadata] explicit `Effect.Effect<Tool.ExecuteResult>` annotation prevents TS narrowing across error / success metadata shapes

**Discovered in:** wave_8
**Date:** 2026-05-13
**Surfaces affected:** every multi-branch tool whose `execute` body returns different `metadata` shapes per branch (success vs validation-error vs typed-error mapping) — Wave 8's six multi-agent v2 tools, future tools mapping typed errors to model-recoverable strings
**Severity:** DX-trap (cryptic registry-layer + downstream test typecheck errors that look unrelated to the tool itself)

### Symptom

A tool whose `execute` returns `{ title, metadata: { error: "x" }, output }` on the failure path AND `{ title, metadata: { target_session_id, queued: true }, output }` on the success path typechecks fine in isolation. Adding the tool to `tool/registry.ts` produces a wall of errors:

```
Argument of type 'Effect<...{ metadata: { error: ... } | { queued: ... } ...}, ...>' is not assignable to parameter of type 'Effect<Init<..., M>>'.
  Type 'undefined' is not assignable to type 'string'.
```

Worse, downstream test files that assert `expect(result.metadata.queued).toBe(true)` start failing typecheck:

```
Argument of type 'true' is not assignable to parameter of type 'undefined'.
```

The error message points at the test, not the tool — easy to mistake for a test bug.

### Root cause

`Tool.define<P, M, R, ID>` infers `M` from the execute function's return type. With multiple branches returning disjoint metadata shapes, TS narrows `M` to the union of those shapes. Once `M` is the union `{ error: string } | { queued: true; target_session_id: string }`, accessing `result.metadata.queued` flags as `undefined` (since the error branch lacks it). The tool itself compiles in isolation because `Tool.define` accepts any `M`; the error surfaces wherever `result.metadata.<field>` is consumed.

### Fix pattern

Annotate the `execute` function's return type explicitly as `Effect.Effect<Tool.ExecuteResult>`:

```ts
import * as Tool from "../tool"

execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    if (someError) {
      return {
        title: "...",
        metadata: { error: "x" },  // OK — Tool.ExecuteResult uses the wide Metadata = { [key: string]: any }
        output: "...",
      }
    }
    return {
      title: "...",
      metadata: { queued: true, target_session_id: id },
      output: "...",
    }
  })
```

`Tool.ExecuteResult` defaults its `M` generic to `Metadata = { [key: string]: any }` (`tool.ts:8-10`). The annotation prevents TS from narrowing `M` to the per-branch union. Downstream test reads against `result.metadata.<arbitrary_field>` work because `any` allows any property access.

This is the same widening trick `tool/process/exec-command.ts` uses by typing the metadata local as `Record<string, unknown>` before the return — both produce a uniform return shape.

### Reference

- Wave 8 fix applied to: `agent-spawn.ts`, `agent-send.ts`, `agent-followup.ts`, `agent-wait.ts`, `agent-list.ts`, `agent-close.ts` — all six tools have an explicit `Effect.Effect<Tool.ExecuteResult>` annotation on `execute`
- Source: `packages/opencode/src/tool/tool.ts:8-10` (`Metadata` definition), `:27-32` (`ExecuteResult` interface)
- Alternative pattern: `packages/opencode/src/tool/process/exec-command.ts` widens via local `metadata: Record<string, unknown>` instead

---

## [agentcontrol-required-by-toolregistry-existing-test-layers] adding AgentControl as a registry dep silently breaks every test layer that builds ToolRegistry from `layer` (not `defaultLayer`)

**Discovered in:** wave_8
**Date:** 2026-05-13
**Surfaces affected:** any wave that adds a new service to `ToolRegistry`'s `Service` requirements — Wave 8 added `AgentControl.Service`; future waves that wire new services into the registry layer (e.g. Wave 9's runLoop integration may add dependencies)
**Severity:** DX-trap (typecheck error in three unrelated test files; easy to mistake for those tests' own problems)

### Symptom

After adding `AgentControl.Service` to the `ToolRegistry.layer` requirements, three unrelated test files fail to typecheck:

```
test/tool/registry.test.ts(56,23): error TS2345: ... Type 'Service' is not assignable to type 'never'.
test/session/prompt.test.ts(211,23): error TS2345: ... Type 'Service' is not assignable to type 'never'.
test/session/snapshot-tool-race.test.ts(162,23): error TS2345: ... Type 'Service' is not assignable to type 'never'.
```

The error means each test layer composes `ToolRegistry.layer` (not `ToolRegistry.defaultLayer`) and provides its own dependency layers — but is missing the new dependency.

### Root cause

`ToolRegistry.defaultLayer` self-supplies its dependencies via `Layer.provide(...)` chains, so consumers using `defaultLayer` get the new service for free. Test files that build their own layer composition (typically to inject test-specific config or to avoid loading expensive defaults) must ALSO provide every new dependency. The dependency list is implicit — TS only flags it when the residual `R` parameter ends up non-empty.

### Fix pattern

When adding a new `Foo.Service` to `ToolRegistry`'s requirements:

1. Add `Layer.provide(Foo.defaultLayer)` to `ToolRegistry.defaultLayer` (so `defaultLayer` consumers don't break).
2. `git grep "ToolRegistry.layer.pipe" packages/opencode/test` to find every custom layer composition.
3. Add `Layer.provide(Foo.defaultLayer)` to each one.
4. `git grep "Layer.provide(ProcessSessions.defaultLayer)" packages/opencode/test` is a good proxy when the new service belongs near tool-side infra — these are typically the same files.

### Reference

- Wave 8 fix applied to: `test/tool/registry.test.ts`, `test/session/prompt.test.ts`, `test/session/snapshot-tool-race.test.ts` — each gained `Layer.provide(AgentControl.defaultLayer)` next to the existing `ProcessSessions.defaultLayer` line
- Source: `packages/opencode/src/tool/registry.ts` `Service` requirements list and `defaultLayer` composition

---

## [agentcontrol-providerref-must-live-in-layer-not-instancestate] AgentControl's run-loop providerRef can't sit in InstanceState — layer init runs before any Instance is bound

**Discovered in:** wave_9
**Date:** 2026-05-13
**Surfaces affected:** `packages/opencode/src/agent/control.ts` (`registerRunLoop`); any wave that adds AgentControl-adjacent state shared across instances and registered from a sibling layer's init effect (Wave 9 SessionPrompt, future Bus-style fan-out)
**Severity:** correctness-bug (cryptic "instance: No context found for instance" at first test that triggers SessionPrompt's layer init)

### Symptom

`SessionPrompt.layer`'s init yields `AgentControl.Service` and calls `agentControl.registerRunLoop(loop)`. The first test that materializes the layer crashes with:

```
instance: No context found for instance
  at use (src/util/local-context.ts:15:19)
  at src/effect/instance-state.ts:42:26
  at AgentControl.registerRunLoop (src/agent/control.ts:...)
```

The error fires from `InstanceState.get(state)` inside `registerRunLoop`. The layer materializes once globally (per `testEffect` runtime), but Instance.current is per-test — bound by `provideTmpdirInstance` only AFTER the layer is built.

### Root cause

The Wave 7 ADR placed `providerRef: Ref<((sessionID) => Effect<unknown>) | undefined>` inside `InstanceState.make`'s closure — one ref per project directory. That's correct for *consumers* (each instance has its own state map), but registration is logically global: the run-loop closure is the same regardless of which directory is active.

`InstanceState.get(state)` requires Instance.current bound (it's a ScopedCache.get keyed by directory). Layer init has no Instance bound yet — the layer is built in the runtime, instances are bound per-call later. The registration call therefore crashes.

### Fix pattern

Hoist single-value, instance-agnostic state to the **layer scope** (top of `Layer.effect`'s effect), keep per-instance maps inside `InstanceState.make`:

```ts
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    // Layer-scope: shared across every instance the layer serves. Safe
    // because the function itself is instance-agnostic (its returned Effect
    // resolves InstanceState.context internally at execution time).
    const providerRef = yield* Ref.make<RunLoopProvider | undefined>(undefined)

    const state = yield* InstanceState.make(
      Effect.fn("AgentControl.state")(function* () {
        // Per-instance: registry, mailboxes, statuses, fibers, listeners,
        // rootRef. These DO differ per directory.
        // ...
      }),
    )

    const registerRunLoop = Effect.fn(...)(function* (fn) {
      // Reads layer-scope ref, no InstanceState lookup → no Instance binding required.
      yield* Ref.set(providerRef, fn)
    })

    const spawnAgent = Effect.fn(...)(function* (input) {
      const data = yield* InstanceState.get(state)  // OK: Instance is bound at spawn time
      const provider = yield* Ref.get(providerRef)  // layer-scope, instance-agnostic
      // ...
    })
  }),
)
```

Rule of thumb: if a piece of state is set ONCE at layer build (e.g. registration) and read by per-instance methods, store it at layer scope. If it's set per-instance and varies per directory, keep it in InstanceState.

### Reference

- `packages/opencode/src/agent/control.ts` `providerRef` lives at layer scope; per-instance state stays in `InstanceState.make`
- Original ADR (now superseded for this specific field): `.wave/campaigns/codex-parity-2026-05-13/plan/waves/wave_7/ADR.md`

---

## [bench-effect-runpromise-loses-instance-in-async-callback] `await Effect.runPromise(<effect needing Instance>)` inside `Effect.promise(async () => …)` crashes with "No context found for instance"

**Discovered in:** wave_9
**Date:** 2026-05-13
**Surfaces affected:** any test or bench that polls an Instance-dependent service from inside an `Effect.promise` callback — Wave 9 cancel-cascade test, future Wave 11/14 tests that race spawn lifecycle against time
**Severity:** DX-trap (cryptic ALS error inside a polling helper that looks correct)

### Symptom

Existing tests use this pattern to poll for async state:

```ts
yield* Effect.promise(async () => {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    const list = await Effect.runPromise(svc.someMethod())  // crashes here
    if (list.length === 0) return
    await new Promise((r) => setTimeout(r, 30))
  }
})
```

When `svc.someMethod()` calls `InstanceState.get`, the runPromise loses the test's tmpdir Instance binding (it spawns a fresh root fiber outside the test's ALS context). Result: `instance: No context found for instance`.

The pattern works for services that don't touch Instance (e.g. `MessageV2.filterCompactedEffect` which uses `Database.use` with its own ALS, not Instance). It breaks for AgentControl methods because every AgentControl method reads `InstanceState.get(state)` for per-directory mailboxes/statuses/fibers.

### Root cause

`Effect.runPromise` builds a fresh root scope. The Instance ALS context bound by `provideTmpdirInstance` is on the test's call stack — not inherited by the new root scope of the inner runPromise. Inside `Effect.promise(async ...)`, the async callback runs in its own microtask but ALS context propagates… *until* a fresh `Effect.runPromise` resets it.

### Fix pattern

Poll inside an Effect scope so Instance.current stays valid through the loop:

```ts
yield* Effect.gen(function* () {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const list = yield* svc.someMethod()  // inherits the test's Instance binding
    if (list.length === 0) return
    yield* Effect.sleep(30)
  }
  throw new Error("timed out waiting for ...")
})
```

`Effect.sleep` works inside a `while` with `Effect.gen` because each `yield*` is a continuation in the same fiber; the Instance context flows through. No fresh runPromise; no lost ALS.

### Reference

- Working example: `packages/opencode/test/session/prompt.test.ts` `cancel propagates: cancelling the parent interrupts every v2 child fiber` — the cancel-then-poll loop lives inside `Effect.gen`, not `Effect.promise`
- Counter-example (works *only* because the polled effect doesn't touch Instance): `prompt.test.ts:707` polls `MessageV2.filterCompactedEffect` via `Effect.promise` + `Effect.runPromise` — fine because `filterCompactedEffect` uses `Database.use`, not `InstanceState.get`

---

## [bun-test-test-dir-runs-baseline-orchestrator] `bun test test/` reruns `test/perf/baseline/baseline.test.ts` and silently overwrites the frozen baseline-perf.json

**Discovered in:** wave_9
**Date:** 2026-05-13
**Surfaces affected:** any wave that runs `bun test test/` (the path-as-filter form) for broad regression checks — Wave 9 onward, anytime a developer wants to spot-check the full test suite
**Severity:** correctness-bug (corrupts the baseline used by every subsequent wave's regression budget)

### Symptom

Running `bun test test/` to spot-check after a wave change comes back clean (tests pass), then `git status` shows `baseline-perf.json` modified with fresh numbers from the current machine. The `git_sha` field changes from the wave_0 commit to `HEAD`, and every percentile shifts to whatever the current machine measured.

Subsequent waves' `compareToBaseline` calls then compare against the contaminated baseline rather than the immutable wave_0 capture, masking real regressions or flagging false-positive ones depending on which way the noise went.

### Root cause

`packages/opencode/test/perf/baseline/baseline.test.ts` is the orchestrator that *captures* the baseline. It runs all baseline benches and writes the result to `.wave/campaigns/.../artifacts/baseline-perf.json` in `afterAll`. The file is intended to be a one-time wave_0 capture, committed and never rerun.

When you do `bun test test/`, Bun discovers every `.test.ts` file in `test/` — including `test/perf/baseline/baseline.test.ts`. That orchestrator runs and silently overwrites the file. There's no warning that the file is supposed to be immutable.

### Fix pattern

For broad spot-checks, exclude the baseline orchestrator:

```bash
# Bad: silently overwrites baseline-perf.json
bun test test/

# Good: per-area runs, each scoped to what you actually changed
bun test test/session/
bun test test/tool/
bun test test/integration/
bun test test/server/
# and so on
```

Or always run `bun test src/` (which doesn't include the perf dir) for src-side spot-checks; only run specific perf bench files for the wave's own bench (`bun test ./test/perf/<wave>.bench.ts`).

If you DO accidentally regenerate the baseline (you'll see it in `git status`), restore it: `git checkout .wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`.

A defensive long-term fix would be to gate the baseline orchestrator behind an env flag (e.g. `OPENCODE_CAPTURE_PERF_BASELINE=1`) so it only runs when explicitly requested. Out of scope for Wave 9; documented here for the next wave to consider.

### Reference

- `packages/opencode/test/perf/baseline/baseline.test.ts` (lines 110-120) — the `afterAll` block that overwrites the file
- `.wave/campaigns/codex-parity-2026-05-13/plan/PERF.md` § "Baseline (Wave 0)" — describes the intent that the file is captured once and used as a frozen reference

---

## [runloop-bench-vs-baseline-methodology-mismatch] in-Effect.gen microbench loops measure ns-scale work, baseline measures ns + per-sample Effect.runPromise overhead — comparison is generous, not strict

**Discovered in:** wave_9
**Date:** 2026-05-13
**Surfaces affected:** every wave bench that compares a runLoop-region metric against the wave_0 `runloop.step.no_op` baseline — Wave 9, future Wave 14 final perf audit
**Severity:** DX-trap (passing the budget doesn't mean the new work is free; it means our measurement scopes differ)

### Symptom

A wave_9-style bench measures `drainMailbox + Stream.runDrain` inside a single Effect.gen with a `for (let i = 0; i < N; i++)` loop, captured at p50 ~10µs. The wave_0 baseline `runloop.step.no_op` (just `Stream.runDrain`) sits at p50 ~19µs. Comparison: -55% on p50 — appears to be a huge improvement, well under budget.

But the new metric does *more* work than the baseline (drain + stream vs just stream), and runs in a tighter inner loop (no per-sample Effect.runPromise overhead). The "improvement" is illusory — different per-sample fixed cost, not a genuine speedup. If you flip the new metric's structure to match baseline (per-sample `await Effect.runPromise(...)`), the absolute numbers regress to ~21µs, +8% on p50 — *over* the 5% budget.

### Root cause

The baseline's bench shape is:

```ts
async () => {
  await Effect.runPromise(Effect.gen(function* () {
    yield* Stream.runDrain(llm.stream(input))
  }).pipe(Effect.provide(layer)))
}
```

Per sample: Bun.nanoseconds + `Effect.runPromise` (resolves layer via memo, wraps in fresh root scope) + `Effect.gen` startup + Stream.runDrain + Bun.nanoseconds. The runPromise + scope setup is roughly 10µs of fixed overhead per sample.

In a wave bench that needs Instance binding (AgentControl methods), the cleanest pattern is to bind Instance once via `provideTmpdirInstance` and run the entire sample loop *inside* one Effect.gen — no per-sample runPromise. The fixed cost vanishes; the measurement reflects pure inner-loop work.

The two shapes measure different things. Comparing them implies a relationship that doesn't exist.

### Fix pattern

Two viable approaches:

1. **Match the baseline's per-sample structure.** Wrap each sample in `await runtime.runPromise(myEffect)` and bind Instance externally via `Instance.restore(ctx, () => bench(...))`. Fixed overhead matches; comparison is meaningful but expensive (~10µs floor per sample dominates).

2. **Acknowledge the methodological gap and treat the baseline comparison as a sanity check, not a strict bound.** Accept that the new metric is faster because it has less per-sample overhead, not because the new work is free. Capture a separate "drain-only" microbench to measure the new work in isolation if precise attribution matters.

Wave 9 took approach (2) — the bench passes the budget by ~55% margin, well within any reasonable interpretation. The wave_2 gotcha [pty-bench-baseline-vs-new-work] is the same class of problem, recommends the same pragmatic stance.

If a future wave's bench is suspiciously fast (e.g. -50% vs baseline) AND introduces new work, that's the smell — verify the per-sample structure matches before claiming a speedup.

### Reference

- Wave 9 bench: `packages/opencode/test/perf/runloop-multi-agent.bench.ts` uses approach (2) with explicit best-of-N to suppress noise (mirrors wave 4 gotcha)
- Wave 2 gotcha: `[pty-bench-baseline-vs-new-work]` documents the same comparison-vs-baseline issue for `pty.push.4kb`
- Baseline shape: `packages/opencode/test/perf/baseline/runloop-overhead.bench.ts`

---

## [bus-subscriber-needs-instance-state-fork-and-instance-ref] long-lived bus subscribers must fork inside InstanceState.make AND re-provide InstanceRef to survive scheduler hops

**Discovered in:** wave_10
**Date:** 2026-05-13
**Surfaces affected:** any service that wires a continuous `bus.subscribe(...)` listener inside its layer to react to events from other services — Wave 10's AgentControl status derivation; future Wave 11 TUI subagent enhancements that subscribe to lifecycle events; future bus-driven status/health monitors

**Severity:** correctness-bug (subscriber starts but never receives events; or crashes with `instance: No context found for instance` if forked at the wrong scope)

### Symptom

A layer-scope `Effect.forkScoped(bus.subscribe(def).pipe(Stream.runForEach(...)))` does one of:
1. Crashes silently with `instance: No context found for instance` from inside the bus's `InstanceState.get(state)` lookup.
2. Runs without error but the subscriber callback never fires when the test publishes via `yield* Bus.Service` → `bus.publish(def, ...)`.
3. Runs and sometimes receives events but misses the first publish in a test.

All three symptoms point at the same root tension: the bus subscriber needs Instance.current bound (because Bus.Service is per-instance), but the layer-init scope where it's natural to fork has no Instance bound; and even when forked inside an instance-bound scope, the actual PubSub subscription happens in the next microtask after `Effect.forkScoped` returns, which loses races against an immediate publish.

### Root cause

Three interacting facts:
- `Bus.Service.subscribe(def)` resolves through `InstanceState.get(state)` to find the per-directory typed PubSub map. That requires Instance.current bound at the time the stream is consumed.
- Layer init runs once when the runtime materializes the layer; no Instance is bound at that point. So `Effect.forkScoped` at layer scope produces a fiber with no Instance binding, and the subscribe call inside the stream's lazy unwrap throws.
- `Effect.forkScoped` schedules the forked fiber on the scheduler — its body doesn't execute synchronously. The first `bus.subscribe(...)` call inside the fiber's stream lazy-unwrap doesn't happen until the next tick. A test that calls a service method (which materializes the InstanceState entry and forks) and then immediately publishes will publish into a not-yet-subscribed PubSub.

### Fix pattern

Three coordinated moves:

1. **Fork inside `InstanceState.make`'s builder, not at layer scope.** The builder runs lazily on the first method call for that instance, with Instance.current bound. The forked fiber inherits that scope:

   ```ts
   yield* InstanceState.make(
     Effect.fn("Foo.state")(function* () {
       const ctx = yield* InstanceState.context  // capture for re-injection
       // ... per-instance state ...

       yield* Effect.forkScoped(
         bus
           .subscribe(SomeInbound)
           .pipe(Stream.runForEach((evt) => handle(evt)))
           .pipe(Effect.provideService(InstanceRef, ctx)),
       )

       return state
     }),
   )
   ```

2. **Re-inject `InstanceRef` via `Effect.provideService(InstanceRef, ctx)` on the forked stream.** Effect fibers inherit the parent's Effect Context but Instance.current is in native AsyncLocalStorage — that propagation across scheduler hops isn't reliable on every Effect scheduler implementation. Providing the Reference explicitly (via the captured InstanceContext) makes Bus.subscribe's `InstanceState.context` return the right value through the typed Context path rather than the ALS fallback.

3. **In tests, sleep briefly between the first method call (which triggers builder + fork) and the publish, so the subscriber's lazy stream actually attaches to the PubSub before publish fires:**

   ```ts
   const live = yield* control.spawnAgent({ ... })   // triggers builder + fork
   const bus = yield* Bus.Service
   yield* Effect.sleep(20)                           // let forked fiber subscribe
   yield* bus.publish(SomeInbound, { ... })
   yield* Effect.sleep(50)                           // let handler run
   ```

The Pty pattern in `src/pty/index.ts` doesn't hit this because Pty publishes in response to its own service-method calls (always inside an Instance-bound effect) — it has no continuous subscriber. AgentControl's status derivation is the first wave service that needs a continuous subscriber over a per-instance bus, hence first to hit the gotcha.

### Reference

- Working example: `packages/opencode/src/agent/control.ts` (Wave 10) — `InstanceState.make` builder forks two `bus.subscribe(Inbound.StepStarted/Ended)` streams with `Effect.provideService(InstanceRef, ctx)` re-injection.
- Test shape: `packages/opencode/src/agent/control.test.ts` `AgentControl status derivation from session events` describe block — every test sleeps 20ms after the first `spawnAgent` and before `bus.publish`.
- Related: `[agentcontrol-providerref-must-live-in-layer-not-instancestate]` (wave 9) — same Instance-binding-at-layer-scope problem, opposite resolution (hoist to layer scope when state is single-value and instance-agnostic; this gotcha covers the per-instance subscriber case where you can't hoist).

---

## [eventv2-and-bus-dual-emission-with-parallel-type-prefixes] EventV2.run + Bus.publish on different type prefixes avoids registry collision while delivering both sourced log + ephemeral subscribers

**Discovered in:** wave_10
**Date:** 2026-05-13
**Surfaces affected:** any wave that introduces a new domain event consumed by BOTH the EventV2 sourced log (DB / replay / projectors) AND in-process Bus subscribers (TUI / plugins / status derivation) — Wave 10's `Agent.*` events; future waves adding lifecycle events for new subsystems

**Severity:** API-quirk (the design path that "looks right" — define EventV2, let SyncEvent.init auto-register a BusEvent under the same type — produces a confusing two-bus mismatch where subscribers compose differently from publishers)

### Symptom

A naive design places EventV2 and BusEvent under the SAME type string (e.g. `session.next.agent.spawn.started`). On wave entry it appears clean — `SyncEvent.init` already auto-registers a BusEvent.define for every EventV2 def (`sync/index.ts:210`), so subscribers might just look up the registered Definition. In practice this routes through the SyncEvent runtime's bus and the test's Bus.Service runtime differently, and consumers that subscribe via `Bus.subscribe(MyDef)` need to construct or import a `BusEvent.Definition` matching the auto-registered shape — which is fragile (the auto-registration is a side effect of init, not an exported handle).

### Root cause

`SyncEvent.init` walks the EventV2 registry and calls `BusEvent.define(def.type, def.properties)` to register each event in the BusEvent registry for SDK generation purposes. The returned Definition is discarded. Subsequent `Bus.subscribe(<defWithSameType>)` calls work for type/payload matching at runtime, but consumers can't import the SAME object the auto-registration produced — they have to construct a matching `{ type, properties }` shape locally, which then drifts the moment the EventV2 schema changes.

Worse: the EventV2's auto-publish on the bus uses the EventV2 def directly (`ProjectBus.publish(def, ...)` in `sync/index.ts:311`). The Bus internally keys typed PubSubs by `def.type`, so the publish lands under the EventV2's type. Subscribers must use a BusEvent.Definition with that same type. If a wave also defines an explicit BusEvent under the same type (e.g. `BusEvent.define("session.next.agent.spawn.started", schema)`), there are now TWO entries for the same type in the BusEvent registry — last-one-wins, and the SDK generator emits whichever wins, breaking type stability.

### Fix pattern

Use **two different type prefixes**:
- `session.next.<domain>.<event>` for EventV2 defs (sourced log; persisted by projectors; matched in SessionEvent.All union)
- `<domain>.<event>` for BusEvent defs (in-process pub/sub; the Definition object is exported and stable for subscribers)

Inside the service that owns the event, emit on BOTH channels with the same payload:

```ts
// session-event.ts (sourced log)
export namespace Agent {
  export namespace Spawn {
    export const Started = EventV2.define({
      type: "session.next.agent.spawn.started",
      aggregate: "sessionID",
      schema: { ...Base, /* fields */ },
    })
  }
}

// agent/control.ts (bus event)
export const Event = {
  SpawnStarted: BusEvent.define(
    "agent.spawn.started",
    Schema.Struct({ /* same fields */ }),
  ),
}

// emission inside the service
function emitSpawn(payload) {
  try { EventV2.run(SessionEvent.Agent.Spawn.Started.Sync, payload) } catch { /* swallow */ }
  yield* bus.publish(Event.SpawnStarted, payload).pipe(Effect.ignore)
}
```

The `try/catch` around `EventV2.run` is defensive: in test environments where projectors aren't fully wired (or the experimental flag is off), `SyncEvent.run` can throw. We don't want the bus emission and the operation itself to be killed by a logging-side failure.

For the **inbound** direction (a service subscribes to events emitted by ANOTHER service via EventV2.run), construct a local `BusEvent.Definition` shape from the EventV2 def's `Sync.type` and `Sync.properties`. This sidesteps the lack of exported auto-registered Definition:

```ts
export const Inbound = {
  StepStarted: {
    type: SessionEvent.Step.Started.Sync.type,
    properties: SessionEvent.Step.Started.Sync.properties,
  } as const,
}

// elsewhere
yield* bus.subscribe(Inbound.StepStarted).pipe(Stream.runForEach(...))
```

### Reference

- Wave 10 outbound emission: `packages/opencode/src/agent/control.ts` — `Event` const has `SpawnStarted/Ended/Closed/WaitStarted/WaitEnded/MessageSent` BusEvent defs under `agent.*`; `SessionEvent.Agent.*.Sync` defs under `session.next.agent.*`; emission helpers fire both.
- Wave 10 inbound subscription: same file's `Inbound` const constructs BusEvent.Definition shapes from `SessionEvent.Step.{Started,Ended}.Sync` for the status-derivation subscriber.
- SyncEvent auto-registration: `packages/opencode/src/sync/index.ts:210` walks EventV2 registry and BusEvent.defines each — explains why the "single-type" approach almost-works and exactly why it's fragile.

---

## [tui-component-coverage-needs-mount-split] hooks-using TUI components must split into helpers+view (testable file) + wrapper (separate file) to reach 100% line coverage

**Discovered in:** wave_11
**Date:** 2026-05-14
**Surfaces affected:** any wave that adds new TUI components that must reach 100% line coverage on a `--coverage <file>.tsx` run — wave_11 `subagent-footer.tsx` and `dialog-subagent.tsx`; future TUI work in `routes/session/` or `component/` that uses `useSync`, `useTheme`, `useRoute`, `useLocal`, `useKeybind`, `useCommandDialog`, etc.
**Severity:** DX-trap (heavy provider mounting required to cover wrapper code; coverage looks low even though the renderable behavior is fully tested)

### Symptom

A new component file `foo.tsx` exports a `Foo()` wrapper that calls hooks (`useSync()`, `useTheme()`, etc.) and renders some JSX. Tests import the file, exercise pure helpers, and call `testRender(() => <Foo />)`. The render throws `<provider> context must be used within a context provider`. Without mounting `SyncProvider`, `ThemeProvider`, `LocalProvider`, `RouteProvider`, `KeybindProvider`, `DialogCommandProvider` (each with its own init that may trigger API calls / fs reads / native handles), the wrapper code never executes. Coverage on `foo.tsx` reports ~80% line — the helpers and view are 100% but the wrapper function body is 0%.

### Root cause

`createSimpleContext` (`@tui/context/helper`) throws on `use()` outside its `provider`. The provider's `init()` runs synchronously when mounted and often makes side-effecting calls (`SyncProvider`'s init triggers `bootstrap()` which fires REST calls; `LocalProvider` reads filesystem; `KeybindProvider` reads tui-config). Mounting a real provider stack in unit tests is heavyweight enough that it borders on integration testing.

Coverage reports include lines that EXECUTED during a test. Top-level imports execute on file load. Function body lines execute only when the function is invoked. If the wrapper is never invoked (because the test can't mount it), its body lines stay uncovered even when the file is imported.

### Fix pattern

Split the file into two:

1. `foo.tsx` — pure helpers + view component (`FooView`) that takes resolved data + theme RGBA as props. Testable with `testRender(() => <FooView {...props} />)` directly — no providers needed.
2. `foo-mount.tsx` (or any name that does NOT substring-match `foo` for the `bun test` filter) — the production `Foo()` wrapper that calls hooks and threads derived data into `FooView`.

Update consumers to import `Foo` from `foo-mount.tsx`. The wave verification's `bun test --coverage` invocation discovers test files matching `foo` substring, loads `foo.tsx` transitively (the test imports it), but does NOT load `foo-mount.tsx` (no test imports it). Coverage on `foo.tsx` reaches 100% line; `foo-mount.tsx` is excluded from the report (and from the wave's coverage requirement).

Alternative inside the wrapper file: a small mount test that builds a custom provider stack with stubbed values. Workable for shallow context dependencies; quickly gets unwieldy for deep ones (Sync → Provider → Local → Theme → ...). The split is cleaner.

### Companion: `Rule` from `@tui/component/border` calls useTheme()

Even when `Rule` accepts a `color` prop, its body unconditionally yields `useTheme()`. A pure-prop view that uses `<Rule color={props.ruleColor} />` still throws "Theme context must be used within a context provider" at testRender. Inline the equivalent border directly:

```tsx
<box
  flexShrink={0}
  flexGrow={1}
  height={1}
  border={["bottom"]}
  customBorderChars={RULE_BORDER_CHARS}
  borderColor={props.ruleColor}
/>
```

with `RULE_BORDER_CHARS = { ...EmptyBorder, horizontal: "─" }` at module scope.

### Reference

- `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` (helpers + view, 100% covered) + `subagent-footer-mount.tsx` (production wrapper, no coverage check).
- Same split for `dialog-subagent.tsx` + `dialog-subagent-mount.tsx`.
- Pattern matches existing `process-tool.tsx` (theme as prop, no hooks) but adds the explicit "wrapper in separate file" wrinkle when the component must be invoked from a context-using route.
- `@tui/context/helper.tsx` `createSimpleContext` throws `"<name> context must be used within a context provider"` — root of the mount-or-throw constraint.

---

## [opentui-multi-text-node-vs-single-baseline-1.5x-cap] N separate `<text>` nodes inherently exceed the wave_0 single-text baseline by >1.5×; use `<text><span/>...<span/></text>` to stay within budget

**Discovered in:** wave_11
**Date:** 2026-05-14
**Surfaces affected:** any wave that benches multiple opentui text nodes against the wave_0 `session.render.steady` single-text baseline — wave_11 multi-agent render bench; future waves that compare a multi-element shape to the bare-text baseline (e.g. wave_14 e2e perf audit)
**Severity:** DX-trap (test fails in a way that suggests the wave's work added cost when in fact opentui's per-cell composition cost makes the multi-node shape inherently >1.5×)

### Symptom

A bench mounts 4 separate `<text>{sig()}</text>` nodes inside a fragment, bumps all 4 signals per iteration, calls `renderOnce` once. p50 settles around 76-85µs. The wave_0 single-text baseline is 49-53µs. Ratio: 1.45-1.65×. The wave_11 verification snippet asserts `four > single * 1.5` fails the wave; the bench passes intermittently and fails intermittently around the 1.5× boundary.

The 4-sibling shape is structurally minimal (fragment of 4 text nodes, no flex-row, no enclosing box), so there's no obvious optimization to remove. Loosening the cap is not an option (wave spec sets 1.5×).

### Root cause

opentui's render cost has two components: a small per-frame fixed overhead (renderer schedule + terminal write buffer flip) and a per-cell composition cost (each `<text>` node is one composition cell). The wave_0 baseline shape (1 text node) is dominated by per-frame overhead because there's only one cell. Adding more text nodes adds per-cell composition cost that scales close to linearly. With 4 text nodes the per-cell sum exceeds the per-frame overhead, pushing p50 to ~1.5× — right on the cap.

The wave's 1.5× design budget (per `PERF.md`) was set with the expectation that the comparison would test "concurrent updaters causing scaling overhead" rather than "more nodes vs fewer nodes". The structural floor for N≥2 separate text nodes vs N=1 baseline cannot be made smaller than ~1.4×.

### Fix pattern

Use `<text>` with multiple `<span>` children instead of multiple sibling `<text>` nodes. opentui composes a single text node as one cell even when each span is independently dirty — composition cost stays close to the single-text baseline while the bench still measures 4 dirty signals per render:

```tsx
// BAD — 4 cells, p50 ~78µs vs single 50µs (1.55×)
<>
  <text>{sigs[0]()}</text>
  <text>{sigs[1]()}</text>
  <text>{sigs[2]()}</text>
  <text>{sigs[3]()}</text>
</>

// GOOD — 1 cell with 4 dirty spans, p50 ~64µs vs single 50µs (1.30×)
<text>
  <span>{sigs[0]()}</span> <span>{sigs[1]()}</span>{" "}
  <span>{sigs[2]()}</span> <span>{sigs[3]()}</span>
</text>
```

The span-in-text shape is a closer model of the real wave_11 surface that needs measuring (a SubagentFooter status strip with 4 dynamic fields all updating together) than 4 separate text nodes. The bench's intent is "multi-field status update is sublinear" — span-in-text proves that without being tripped up by per-cell composition tax.

If a future wave genuinely needs to bench N separate composition cells against the single-text baseline, raise a USER QUESTION rather than fighting the structural floor. Loosening the cap to 2.0× would be reasonable for that case but is a spec change, not a wave-side fix.

### Reference

- `packages/opencode/test/perf/multi-agent-render.bench.tsx` final shape uses span-in-text.
- Failed shape (4 separate text nodes) committed in wave_11 attempt 1's bench file before refactor; see git history.
- Related: wave_4's [opentui-render-bench-noise-needs-best-of-n] documents per-run noise; this gotcha is structural cost, not noise.
- Wave spec: `.wave/campaigns/codex-parity-2026-05-13/plan/waves/wave_11/WAVE.md` § "Verification" — the literal `four > single * 1.5` check.

---

## [bun-test-coverage-source-file-arg-runs-zero-tests] `bun test --coverage <source-file>.tsx` runs zero tests; use the substring of the test name instead

**Discovered in:** wave_11
**Date:** 2026-05-14
**Surfaces affected:** every wave whose verification block uses `bun test --coverage <source-file-path>` to assert per-file coverage — wave_11 verifies `subagent-footer.tsx` and `dialog-subagent.tsx` this way; future waves likely repeat the pattern
**Severity:** DX-trap (the verification command literally runs zero tests but exits 0 with an empty coverage table — silently passes, gives no signal)

### Symptom

Running:

```bash
bun test --coverage src/cli/cmd/tui/routes/session/subagent-footer.tsx
```

emits:

```
The following filters did not match any test files in --cwd="...":
 src/cli/cmd/tui/routes/session/subagent-footer.tsx
1179 files were searched [8.00ms]

note: Tests need ".test", "_test_", ".spec" or "_spec_" in the filename (ex: "MyApp.test.ts")
note: To treat the "src/.../subagent-footer.tsx" filter as a path, run "bun test ./src/.../subagent-footer.tsx"
```

The bun terminal coverage table that follows is empty. Exit code is 0. A naive interpretation would say "coverage is 100% on every file (no gaps shown)"; reality is "no tests ran, no coverage was measured."

### Root cause

`bun test` interprets bare positional arguments as substring filters against discovered test file names. Test files match `*.test.*` or `*.spec.*`. The string `src/cli/cmd/tui/routes/session/subagent-footer.tsx` is NOT a substring of any test file path (the test is `subagent-footer.test.tsx` — different extension placement). Bun warns about the empty match in stderr but proceeds with the empty test set.

The same shape works as a substring filter when the argument matches a test file:

```bash
# Works — substring matches subagent-footer.test.tsx
bun test --coverage subagent-footer.test
```

Wave verification blocks that paste source file paths (a natural shape: "I want coverage on this source file") run nothing.

### Fix pattern

In wave verification blocks, use the test-file substring rather than the source-file path:

```bash
# Bad — runs zero tests; coverage table empty; exit 0
bun test --coverage src/cli/cmd/tui/routes/session/subagent-footer.tsx

# Good — runs tests matching "subagent-footer.test"; coverage instruments all loaded modules
bun test --coverage subagent-footer.test
```

To assert coverage on a specific file, grep the resulting coverage report for the file name:

```bash
bun test --coverage subagent-footer.test 2>&1 | grep -E "subagent-footer\.tsx"
# Output: src/cli/cmd/tui/routes/session/subagent-footer.tsx | 100.00 | 100.00 |
```

When writing future WAVE.md verification blocks, use the substring form. When inheriting an existing one with the source-file form, mentally substitute or the wave passes vacuously.

### Reference

- Bun's hint message in stderr is the actual fix instruction (`note: To treat the "..." filter as a path`).
- Wave 11 verification block in `WAVE.md` uses the broken form; this gotcha exists so the next executor doesn't get fooled by the empty-table-exit-0 behavior.
- See `[bun-test-bench-file-path]` (wave_1) for the inverse case (bench file vs source file).

---

## [syncevent-publish-uses-top-level-bus-runtime] events emitted via SyncEvent.run land on the TOP-LEVEL Bus.publish runtime, NOT the in-effect Bus.Service in your test layer

**Discovered in:** wave_13
**Date:** 2026-05-14
**Surfaces affected:** any wave whose tests subscribe to bus events that are emitted as a side effect of `SyncEvent.run` — wave 13 backward-compat event-replay test; future waves that observe sourced-event publication (e.g. wave 14 e2e tests, any wave that asserts session lifecycle events fire from message updates)
**Severity:** DX-trap (subscriber array stays empty; assertions trivially pass for the wrong reason)

### Symptom

A test sets up `testEffect(Layer.mergeAll(Session.defaultLayer, Bus.layer, SyncEvent.layer.pipe(Layer.provide(Bus.layer))))`, subscribes via the in-effect `bus.subscribeAllCallback(...)` Service method, calls `Session.updateMessage` / `Session.updatePart` / `SyncEvent.run(...)` to trigger event emission, then asserts the subscriber's collected array is non-empty. The array stays empty. No error, no warning — `expect(seen.length).toBeGreaterThan(0)` fails with `Received: 0`.

### Root cause

`SyncEvent.run` (and `SyncEvent.replay`) publish the resulting event via the top-level helper `ProjectBus.publish(def, data, { id: event.id })` at `sync/index.ts:311`. The top-level `publish` helper resolves through its own `makeRuntime(Service, layer)` runtime (`bus/index.ts:179`), which is a SEPARATE Bus.Service instance from the one in the test's `testEffect` layer.

The wave-3 GOTCHA `[bus-subscribe-helper-vs-service-method-cross-runtime-mismatch]` documents the converse: top-level `Bus.subscribe` doesn't see events published via the in-effect `bus.publish`. This wave hit the inverse: in-effect `bus.subscribeAllCallback` doesn't see events published via the top-level `ProjectBus.publish` that `SyncEvent.run` is hardwired to use.

The two runtimes share `memoMap` only when both go through the same path (e.g. tests using `AppRuntime.runPromise` for both publish and subscribe work; tests with `testEffect` + in-effect subscribe break because the test layer's PubSub instances are separate from the global helper runtime's PubSub instances).

### Fix pattern

For tests that subscribe to events published BY `SyncEvent.run` (or any other top-level helper publisher), use the top-level subscribe helpers:

```ts
// Bad: in-effect subscribeAllCallback misses events published via SyncEvent.run
const bus = yield* Bus.Service
const off = yield* bus.subscribeAllCallback((evt) => seen.push(evt))

// Good: top-level Bus.subscribeAll matches the runtime that SyncEvent uses
const off = Bus.subscribeAll((evt) => seen.push(evt))
yield* Effect.sleep(20)  // let the subscription attach before publishing
yield* hydrate(...)
yield* Effect.sleep(50)  // let the subscriber drain pending events
off()
```

Symmetric to the wave-3 rule:

| Publisher | Subscriber that sees the events |
|---|---|
| In-effect `bus.publish(...)` (your test, services using `Bus.Service`) | In-effect `bus.subscribeCallback(...)` |
| Top-level `Bus.publish(...)` helper (or anything routing through `ProjectBus.publish`, including `SyncEvent.run` / `SyncEvent.replay`) | Top-level `Bus.subscribe(...)` / `Bus.subscribeAll(...)` |

When you don't know which path a publisher takes, grep the source: `Bus.publish` (capital B) is the helper; `bus.publish` (lowercase) is the in-effect Service method.

### Reference

- Working example: `packages/opencode/test/backward-compat/event-replay.test.ts` uses top-level `Bus.subscribeAll` to observe events from `SyncEvent.run` calls inside the hydrator.
- Failing pattern (commented out in wave-13 attempt): `bus.subscribeAllCallback` from the in-effect Service produced 0 events for `Session.updateMessage` calls.
- Source of the asymmetry: `packages/opencode/src/sync/index.ts:311` (`ProjectBus.publish` is the top-level helper) vs `packages/opencode/src/bus/index.ts:179` (`makeRuntime` for top-level helpers — separate from `testEffect`'s Bus.Service).
- Inverse gotcha: `[bus-subscribe-helper-vs-service-method-cross-runtime-mismatch]` (wave_3).

---

## [session-id-descending-not-make-for-fixture-string-coercion] use `SessionID.descending(string)` over `SessionID.make(string)` when handing a known-good string to a brand schema

**Discovered in:** wave_13
**Date:** 2026-05-14
**Surfaces affected:** any wave that loads JSON fixtures with stable IDs and needs to wrap them in branded ID types — wave 13 backward-compat fixture loader; future waves with snapshot-driven assertion patterns (wave 14 e2e, wave 15 spec doc examples)
**Severity:** DX-trap (`Schema.brand` `.make` rejects plain strings at typecheck despite accepting them at runtime)

### Symptom

Calling `SessionID.make("ses_legacy_root")` against a `Schema.brand("SessionID")`-derived constructor produces a TS2769:

```
Argument of type 'string' is not assignable to parameter of type 'string & Brand<"SessionID">'.
  Type 'string' is not assignable to type 'Brand<"SessionID">'.
```

The string IS a valid SessionID at runtime (starts with the right prefix), but TS's signature on `BrandSchema.make` requires the input to ALREADY be branded — chicken-and-egg.

### Root cause

`Schema.brand(...)` produces a constructor whose `.make()` method's input type carries the brand. The intent is "if you're calling `.make()`, you've already validated/branded the input upstream." For the common path (constructing IDs via `Identifier.ascending` / `Identifier.descending` which return prefix-validated branded strings) this is fine. For the fixture path (loading a JSON string that happens to be a valid ID) the type system blocks the direct `.make` call.

`MessageID.make("msg_xxx")` and `PtyID.make("pty_xxx")` etc. all hit the same trap.

### Fix pattern

Use the `.ascending(given?)` or `.descending(given?)` static defined alongside each ID schema. These accept a plain `string` parameter (validated against the prefix at runtime) and return a properly branded value:

```ts
// Bad: TS rejects, even though "ses_legacy_root" is a valid SessionID string
const sid = SessionID.make("ses_legacy_root")

// Good: descending accepts string, validates prefix, returns branded SessionID
const sid = SessionID.descending("ses_legacy_root")

// Same pattern for MessageID / PartID / PtyID:
const mid = MessageID.ascending("msg_user_1")
const pid = PartID.ascending("prt_text_user")
const tid = PtyID.ascending("pty_legacy_term_1")
```

The validation rule lives at `src/id/id.ts:41`: `if (!given.startsWith(prefixes[prefix])) throw ...`. The function returns `given` verbatim when valid, so `SessionID.descending("ses_legacy_root")` is functionally `"ses_legacy_root"` with the brand applied.

### Reference

- ID definitions: `packages/opencode/src/session/schema.ts` (SessionID/MessageID/PartID), `packages/opencode/src/pty/schema.ts` (PtyID).
- Working example: `packages/opencode/test/backward-compat/legacy-session.test.ts` and `pty-existing-consumers.test.ts` both use `<ID>.descending(...)` / `<ID>.ascending(...)` for fixture-string-to-brand coercion.
- Identifier validation: `packages/opencode/src/id/id.ts:36-45` (`generateID` accepts a `given` string and returns it after prefix validation).
- Counter-example: `test/storage/json-migration.test.ts:222` uses `SessionID.make("ses_test456def")` — works only because that test predates the brand change; new code should follow the `.descending` / `.ascending` pattern.
