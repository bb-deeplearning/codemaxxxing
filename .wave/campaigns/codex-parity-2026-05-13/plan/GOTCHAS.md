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
