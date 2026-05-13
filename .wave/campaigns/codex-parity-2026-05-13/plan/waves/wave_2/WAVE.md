# Wave 2 — Pty.Service extensions

**Prior waves:** wave_0 (perf harness), wave_1 (head/tail buffer at `packages/opencode/src/pty/head-tail-buffer.ts`).
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`, `BACKWARD_COMPAT.md`, `REFERENCES.md`.
**Codex source to mirror:**
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/unified_exec/process_manager.rs:1071-1158` — `collect_output_until_deadline`
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/unified_exec/process_manager.rs:1196-1241` — LRU pruning
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/unified_exec/process.rs:155-185` — exit detection

Also load `MESSAGE_SHAPES.md` § "Constants split" — Pty-side constants (cap, buffer max, grace periods, ID range, protected-recent) live in `pty/index.ts` (module-private). Tool-side constants live in `tool/process/constants.ts` (Wave 3).

## Goal

Extend `Pty.Service` with the primitives unified_exec needs, without breaking existing TUI/desktop consumers. Add a `read` race primitive (cursor-advance vs idle vs exit), per-Active head/tail buffer, LRU pruning at 64-cap with 8-protected, `terminateAll` cleanup, and an `origin` field on the Info schema.

## Tasks

Sequential.

### 1. Tests first

File: `packages/opencode/src/pty/index.test.ts`

Cover:

**Read primitive (`Pty.read`)**
- `read returns immediately when output already past sinceCursor` — chunks already in buffer, idleMs > 0, returns synchronously
- `read waits idleMs when no new output, then returns empty bytes + same cursor` — verify timing within ±50ms of idleMs
- `read wakes when new output arrives before idleMs elapses` — verify wakeup latency < 10ms
- `read returns immediately when process has exited` — exit-watcher fires, read should return without waiting full idleMs
- `read respects maxBytes by truncating returned data via head/tail` — head/tail buffer is consulted
- `read with sinceCursor === currentCursor and no new chunks during idleMs returns wallTime ≈ idleMs and no bytes`
- `read on a non-existent PtyID rejects with PtyNotFoundError` (or returns undefined per existing convention — match `Pty.get` semantics)

**LRU pruning (`MAX_PTY_PROCESSES = 64`, `WARNING_PTY_PROCESSES = 60`)**
- `creating up to 64 PTYs succeeds` — populate to 63, 64th must succeed
- `creating the 65th PTY prunes the LRU non-protected one` — confirm via `Pty.list` that the original LRU is gone, the new one is present
- `creating PTY when pool is at 60 emits a warning event` — Bus subscribes for `Pty.Event.PoolWarning` (new event type) and verifies one emission
- `pruning protects the 8 most-recently-used PTYs` — set 9 PTYs to "recently used" via `read` calls, verify that PTY #1 (oldest used) is the prune target
- `exited PTYs are pruned first when the cap is hit` — a mix of exited + alive PTYs should prune exited ones preferentially

**`terminateAll`**
- `terminateAll kills all live PTYs and clears the registry` — verify `Pty.list` returns empty
- `terminateAll publishes Deleted events for each` — Bus subscriber sees N deletes
- `terminateAll is idempotent` — calling twice doesn't error

**`origin` field**
- `Pty.create with no origin defaults to "tui"` — backward compat for desktop callers
- `Pty.create with origin: "model" sets it on Info` — model-spawned PTYs are tagged
- `Pty.list returns Info objects with origin field present`
- `existing Info schema parses both origin: "tui" rows and rows with origin missing` — backward compat verified at schema level

### 2. Implement

Modify `packages/opencode/src/pty/index.ts`:

#### Add to `Active` type

The `Active` type gains four fields beyond what already exists. Match codex's `UnifiedExecProcess` shape:
- a per-Active `HeadTailBuffer` (separate from the existing sliding `buffer` so the TUI WebSocket consumer is unaffected)
- a notification primitive that wakes `Pty.read` when the cursor advances or when the process exits — pick **`SubscriptionRef<number>`** wrapping the cursor value (not Effect.Latch — Latches are one-shot; cursor watch needs repeated wake)
- an `exited` boolean for fast-path branch in `read`
- a `lastUsed` timestamp for LRU pruning

The TUI WebSocket consumer keeps using the existing sliding `buffer` + cursor protocol — no change. The new `headTail` is fed in parallel from the same `proc.onData` handler.

#### Add `read` method

```ts
readonly read: (
  id: PtyID,
  sinceCursor: number,
  idleMs: number,
  maxBytes: number,
) => Effect.Effect<{ output: Uint8Array; cursor: number; exited: boolean; exitCode?: number }>
```

Implementation: races (a) `notify` SubscriptionRef changes past `sinceCursor`, (b) `Effect.sleep(idleMs)`, (c) the exit-deferred. On any wakeup, drain new bytes from `headTail.snapshotChunks()` filtered to `sinceCursor..currentCursor`, truncate to `maxBytes` if needed, return.

#### Add cap enforcement

In `create`:
- Before insert: check `s.sessions.size >= MAX_PTY_PROCESSES` → run prune
- Prune algorithm matches codex `process_id_to_prune_from_meta` (`process_manager.rs:1196-1241`):
  - Compute meta: `[(id, lastUsed, exited)]` for all sessions
  - Protect the 8 most-recently-used
  - Prefer exited non-protected; else LRU non-protected
- After insert: if `s.sessions.size >= WARNING_PTY_PROCESSES` → publish `Pty.Event.PoolWarning`

#### Add `Pty.Event.PoolWarning`

```ts
PoolWarning: BusEvent.define("pty.pool_warning", Schema.Struct({
  count: PositiveInt,
  cap: PositiveInt,
})),
```

#### Add `terminateAll`

```ts
readonly terminateAll: () => Effect.Effect<void>
```

Iterate sessions, call `teardown` on each, clear the map, publish Deleted for each.

#### Update `CreateInput` and `Info`

Add `origin?: "tui" | "model"` to both. Default to `"tui"` in `create` if absent. Add to `Pty.Info` schema as `Schema.optional(Schema.Literals(["tui", "model"]))`.

#### Update `Active.lastUsed`

Set on `create`, update on every `Pty.read` and `Pty.write`.

### 3. Bench

File: `packages/opencode/test/perf/pty-read.bench.ts`

Measure:
- `pty.read.immediate` — read on a PTY with output already buffered (no wait)
- `pty.read.wakeup` — read with `idleMs=10000`, write a chunk after 5ms; measure end-to-end latency
- `pty.read.timeout` — read with `idleMs=100`, no output; verify wallTime ≈ 100ms, sample p99 ≤ 110ms

Plus: re-run `pty.push.4kb` from baseline to verify the new `headTail` push doesn't regress beyond 5% on push throughput.

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_2.json`. Compare to baseline.

### 4. Verify backward compat

Add a test in `packages/opencode/src/pty/index.test.ts`:
- `existing connect handler still works without origin field` — call `Pty.create({})` with no origin, then `Pty.connect` over a fake WebSocket, verify the existing buffer-replay behavior is unchanged

This protects desktop/electron consumers.

## Gotchas

1. **The TUI WebSocket consumer is real.** `pty/index.ts:297-356` (`connect`) is what powers desktop terminal panes. Do NOT break the sliding buffer / cursor protocol it depends on. Keep `buffer`, `bufferCursor`, `cursor`, `subscribers` exactly as they are. Add the `headTail` and `notify` IN PARALLEL.

2. **`SubscriptionRef.changes` semantics.** Use `SubscriptionRef.make(0)` for the cursor signal. On every `proc.onData`, call `SubscriptionRef.update(notify, c => c + 1)`. `read` subscribes via `SubscriptionRef.changes`. This gives you the wakeup primitive.

3. **`Effect.race` ordering.** Race three effects: cursor-changed, sleep, exit-fired. Use `Effect.raceAll([...])` with discriminated tags so you can branch on which won.

4. **`Effect.forkScoped` for the notify producer.** Set up the cursor signal increment in the existing `proc.onData` callback (which is a JS callback, not Effect). Use `Instance.bind` if needed (per AGENTS.md). The notify ref itself is created in the `Active` setup.

5. **Exit semantics.** When `proc.onExit` fires, set `active.exited = true` AND notify the cursor (so `read`s racing on cursor advance also wake up). Don't rely on cursor-advance alone — exit can happen with no new output.

6. **Prune timing.** Prune runs INSIDE `create` BEFORE inserting the new PTY. This avoids ever exceeding the cap. Codex does it the same way (`process_manager.rs:830-840`).

7. **`origin: "tui"` default.** This is the BACKWARD COMPAT default. Existing callers don't pass `origin`; they should still work and get `"tui"`. Only the new `tool/process.ts` (Wave 3) passes `"model"`.

8. **Don't change `Pty.connect`.** The TUI's existing WebSocket protocol (cursor-based replay) is load-bearing. Adding `read` is additive. They share the same underlying chunk stream via separate consumption paths.

9. **Test concurrency carefully.** `Pty.read` will be called from many concurrent fibers in real use (one per write_stdin call). Tests should include: 3 concurrent `read`s on the same PTY all wake up when new output arrives.

10. **`HeadTailBuffer.pushChunk` takes Uint8Array.** Existing `proc.onData(chunk)` gives a string. Convert via `new TextEncoder().encode(chunk)` once per push. Don't re-encode in the hot path; cache the TextEncoder at module scope.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/pty/index.test.ts
bun test --coverage src/pty/index.ts        # 100% on touched code
bun test --coverage src/pty/schema.ts       # 100%
bun test --coverage src/pty/head-tail-buffer.ts  # still 100% from wave 1

bun test test/perf/pty-read.bench.ts

# regression check vs baseline
bun -e "
  const { compareToBaseline } = await import('./test/lib/perf.ts')
  const wave = JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_2.json').text())
  for (const m of ['pty.push.4kb']) {
    const r = compareToBaseline(wave.metrics[m], '../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json', m)
    if (!r.passed) { console.error('regression on', m, r.reasons); process.exit(1) }
  }
  console.log('no regressions')
"

# backward compat smoke: existing pty server route still typechecks against the new types
bun typecheck    # if Pty.Info changes broke server/routes/instance/pty.ts, this catches it
```

All exit 0.

## Files

New:
- `packages/opencode/src/pty/index.test.ts`
- `packages/opencode/test/perf/pty-read.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_2.json`

Modified:
- `packages/opencode/src/pty/index.ts` — add `read`, `terminateAll`, `Active.headTail`, `Active.notify`, `Active.lastUsed`, `Active.exited`, prune logic, `origin` field, `Event.PoolWarning`. Pty-side constants (`MAX_UNIFIED_EXEC_PROCESSES`, `WARNING_UNIFIED_EXEC_PROCESSES`, `UNIFIED_EXEC_OUTPUT_MAX_BYTES`, `EARLY_EXIT_GRACE_PERIOD_MS`, `POST_EXIT_CLOSE_WAIT_CAP_MS`, `TRAILING_OUTPUT_GRACE_MS`, `UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES`, `PROCESS_STORE_PROTECTED_RECENT`, `PROCESS_ID_RANGE_MIN/MAX`) are module-private constants here per `MESSAGE_SHAPES.md` § "Constants split"
- `packages/opencode/src/pty/schema.ts` — add `origin` to `Info`
