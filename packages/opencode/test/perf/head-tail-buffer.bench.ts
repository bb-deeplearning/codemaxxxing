import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { HeadTailBuffer } from "../../src/pty/head-tail-buffer"
import { bench, type BenchResult } from "../lib/perf"

// Wave 1 perf bench. The wave_1 plan calls for three measurements:
//   - head-tail.push.4kb   — 100 × 4KiB chunks pushed into a 1 MiB buffer
//   - head-tail.push.large — a single chunk bigger than maxBytes
//   - head-tail.snapshot   — populate to capacity, then snapshotChunks repeatedly
//
// Wave 0 captured `pty.push.4kb` at ~1.9 µs p50 inside the existing sliding
// buffer. The head/tail port may legitimately be slower (it does more work),
// but the wave verification asserts head-tail.push.4kb ≤ 2× the baseline.

const CHUNK_4KB = (() => {
  const u = new Uint8Array(4096)
  for (let i = 0; i < u.length; i++) u[i] = (i * 31) & 0xff // deterministic, non-uniform
  return u
})()
const CHUNKS_PER_SAMPLE = 100

const LARGE_CHUNK = (() => {
  // Twice the default buffer cap so the chunk-larger-than-tail-budget branch
  // fires repeatedly and the omittedBytes counter does the work.
  const u = new Uint8Array(2 * 1024 * 1024)
  for (let i = 0; i < u.length; i++) u[i] = (i * 17) & 0xff
  return u
})()

// Pre-seed for snapshot bench: a 1 MiB buffer filled to capacity (head + tail
// both populated, no further trim work). Mounted once at module load so the
// bench loop only measures snapshotChunks() itself.
const SNAPSHOT_BUF = (() => {
  const buf = new HeadTailBuffer()
  for (let i = 0; i < 256; i++) buf.pushChunk(CHUNK_4KB) // 256 × 4KiB = 1 MiB
  return buf
})()

const allResults: Record<string, BenchResult> = {}

const wavePerfFile = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "codex-parity-2026-05-13",
  "artifacts",
  "perf",
  "wave_1.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

test("bench: head-tail.push.4kb", async () => {
  const result = await bench(
    { samples: 500, warmup: 100, label: "head-tail.push.4kb" },
    () => {
      const buf = new HeadTailBuffer()
      for (let i = 0; i < CHUNKS_PER_SAMPLE; i++) buf.pushChunk(CHUNK_4KB)
      // Touch the result so the loop body cannot be optimized away.
      if (buf.retainedBytes() === -1) throw new Error("unreachable")
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

test("bench: head-tail.push.large", async () => {
  const result = await bench(
    { samples: 100, warmup: 10, label: "head-tail.push.large" },
    () => {
      const buf = new HeadTailBuffer()
      buf.pushChunk(LARGE_CHUNK) // exercises chunk >= tail_budget path
      if (buf.omittedBytes() === -1) throw new Error("unreachable")
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

test("bench: head-tail.snapshot", async () => {
  const result = await bench(
    { samples: 1000, warmup: 50, label: "head-tail.snapshot" },
    () => {
      const chunks = SNAPSHOT_BUF.snapshotChunks()
      if (chunks.length === -1) throw new Error("unreachable")
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

afterAll(async () => {
  if (Object.keys(allResults).length === 0) return
  await fs.mkdir(path.dirname(wavePerfFile), { recursive: true })
  const payload = {
    captured_at: new Date().toISOString(),
    git_sha: gitSha(),
    bun_version: Bun.version,
    metrics: allResults,
  }
  await Bun.write(wavePerfFile, JSON.stringify(payload, null, 2))
})
