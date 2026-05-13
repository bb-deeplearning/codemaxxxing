# Wave 1 — Head/tail buffer

**Prior waves:** wave_0 (perf harness exists at `packages/opencode/test/lib/perf.ts`).
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`, `REFERENCES.md` (the unified_exec section).
**Codex source to port:**
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/unified_exec/head_tail_buffer.rs` (183 lines)
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/unified_exec/head_tail_buffer_tests.rs`

## Goal

Port codex's symmetric head/tail buffer to TypeScript with byte-level fidelity. Tests written first, mirroring the codex tests; implementation follows. Establish that head/tail push throughput is acceptable (no slower than 2x the existing `Pty.Service` sliding buffer).

## Tasks

Sequential within this single session.

### 1. Read the codex source and tests

Open `head_tail_buffer.rs` and `head_tail_buffer_tests.rs`. Internalize:
- Symmetric 50/50 split: `head_budget = max_bytes / 2`, `tail_budget = max_bytes - head_budget`
- Push policy: head fills first; once `head_bytes >= head_budget`, all new bytes go to tail
- Tail policy: if a single chunk is larger than the entire tail budget, drop everything in tail and keep only the LAST `tail_budget` bytes of that chunk
- `omitted_bytes` tracks dropped middle bytes (never reset by push; reset only by `drainChunks`)
- `snapshot_chunks` returns head chunks then tail chunks (no separator)
- `to_bytes` concatenates them
- `drain_chunks` takes everything and resets all internal counters to zero

### 2. Write tests first

File: `packages/opencode/src/pty/head-tail-buffer.test.ts`

Cover every test case in codex's `head_tail_buffer_tests.rs`. At minimum:

- `new buffer reports retainedBytes === 0 and omittedBytes === 0`
- `pushChunk fills head before tail when below max_bytes`
- `pushChunk splits a single chunk across head and tail when crossing the budget`
- `pushChunk drops oldest tail chunks when exceeding tail budget`
- `pushChunk drops middle bytes within a single tail chunk when needed (front draining)`
- `pushChunk handles a chunk larger than tail_budget by keeping only its last tail_budget bytes`
- `pushChunk handles a chunk larger than max_bytes (the whole buffer) — head untouched if already full, last bytes kept`
- `omittedBytes accumulates correctly across pushes`
- `snapshotChunks returns [...head, ...tail] in order, never the omitted middle`
- `toBytes concatenates head + tail`
- `drainChunks returns [...head, ...tail] and resets retained + omitted to 0`
- `new buffer with max_bytes === 0 omits everything pushed`
- `new buffer with max_bytes === 1 still keeps the last byte`
- `pushing empty chunk is a no-op` (verify against codex behavior — read the test)

Run them. Watch them fail (no implementation yet). Commit nothing yet.

### 3. Implement the module

File: `packages/opencode/src/pty/head-tail-buffer.ts`

Shape:

```ts
import { CONSTANTS } from "@/..."  // import HEAD_TAIL_BUFFER_MAX_BYTES from CONSTANTS.md

export class HeadTailBuffer {
  constructor(maxBytes?: number)  // default UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1 MiB
  pushChunk(chunk: Uint8Array): void
  snapshotChunks(): Uint8Array[]
  toBytes(): Uint8Array
  drainChunks(): Uint8Array[]
  retainedBytes(): number
  omittedBytes(): number
}

export * as HeadTailBuffer from "./head-tail-buffer"
```

Implementation notes:
- Internal storage: two `Uint8Array[]` (head, tail) and four counters (head_bytes, tail_bytes, omitted_bytes, max_bytes — the budgets are derived)
- Use `subarray` not `slice` where possible for zero-copy
- Match codex's algorithm in `push_chunk` exactly. Read the Rust carefully.
- Performance target: `pushChunk` should be O(1) amortized. The only O(n) path is the tail-trimming loop which only runs when bytes are being dropped.

### 4. Bench

File: `packages/opencode/test/perf/head-tail-buffer.bench.ts`

Measure:
- `head-tail.push.4kb` — push 100 × 4KiB chunks; report mean push time
- `head-tail.push.large` — push a single chunk larger than max_bytes; report time
- `head-tail.snapshot` — populate to capacity, then snapshotChunks 1000x

Compare against the existing `Pty` sliding buffer baseline captured in Wave 0 (`pty.push.4kb`). The head-tail bench should be within 2x of the sliding baseline (the head-tail does more work; some overhead is expected). Write delta to `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_1.json`.

### 5. Run verification

See Verification section below.

## Gotchas

1. **`Uint8Array` vs `Buffer`.** Codex uses `Vec<u8>`; TypeScript has `Uint8Array` (cross-platform) and Node `Buffer` (subclass of Uint8Array). Use `Uint8Array` in the public API. Internally either is fine; `Uint8Array.from`, `subarray`, `set` are zero-copy.

2. **Empty chunk semantics.** Codex's `push_chunk` with `chunk.len() == 0` is a no-op (the head budget check guards against zero appends). Verify by running codex's test cases — yours must match.

3. **`retainedBytes` is the SUM of head_bytes + tail_bytes.** Don't compute it from `head.length + tail.length` (those are chunk counts, not byte counts).

4. **`omittedBytes` is monotonic between drains.** Pushes only add; never decrement. Drains reset to 0.

5. **Testing the "single chunk larger than tail_budget" case.** This branch in codex's `push_to_tail` (lines 138-152) is subtle: `start = chunk.len() - tail_budget`, then keep `chunk[start..]`. Test with a chunk that's 3x the tail budget to verify only the last tail_budget bytes survive.

6. **No mocks for this wave.** Pure data-structure testing — direct, fast, deterministic.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# tests
bun test src/pty/head-tail-buffer.test.ts

# coverage on the new module
bun test --coverage src/pty/head-tail-buffer.ts
# expect 100% lines, 100% branches

# bench produces a result
bun test test/perf/head-tail-buffer.bench.ts
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_1.json

# the bench result must be within 2x the Pty sliding buffer baseline
bun -e "
  const baseline = JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json').text())
  const wave = JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_1.json').text())
  const baselineP50 = baseline.metrics['pty.push.4kb'].p50
  const headtailP50 = wave.metrics['head-tail.push.4kb'].p50
  if (headtailP50 > baselineP50 * 2) { console.error('head-tail too slow:', headtailP50, 'vs', baselineP50); process.exit(1) }
  console.log('head-tail push within budget:', (headtailP50 / baselineP50).toFixed(2), 'x baseline')
"
```

All steps exit 0.

## Files

New:
- `packages/opencode/src/pty/head-tail-buffer.ts`
- `packages/opencode/src/pty/head-tail-buffer.test.ts`
- `packages/opencode/test/perf/head-tail-buffer.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_1.json`

Modified: none.
