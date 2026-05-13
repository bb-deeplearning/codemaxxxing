import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { AgentPath } from "../../src/agent/agent-path"
import { InterAgentCommunication } from "../../src/agent/inter-agent-communication"
import { Mailbox } from "../../src/agent/mailbox"
import { bench, type BenchResult } from "../lib/perf"

// Wave 5 perf bench. Three metrics, all measured against new code only — no
// wave_0 baseline applies (mailbox is brand-new). PERF.md sets a 5 ms p99
// soft target for the wakeup-latency metric; the bench records actual numbers
// for future regression checks rather than asserting the budget here.

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
  "wave_5.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const root = AgentPath.root()
const worker = Effect.runSync(AgentPath.from("/root/worker"))

const newMail = (i: number) =>
  new InterAgentCommunication({
    author: root,
    recipient: worker,
    content: `m${i}`,
    trigger_turn: false,
    sent_at: 0,
  })

test("bench: mailbox.send", async () => {
  const mb = await Effect.runPromise(Mailbox.make())
  const result = await bench(
    { samples: 1000, warmup: 100, label: "mailbox.send" },
    async () => {
      await Effect.runPromise(mb.send(newMail(0)))
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

test("bench: mailbox.subscribe.wakeup_latency", async () => {
  const mb = await Effect.runPromise(Mailbox.make())
  const ref = await Effect.runPromise(mb.subscribe())

  const program = Effect.scoped(
    Effect.gen(function* () {
      // Re-arm a one-shot subscriber, mark t=0, send, await join.
      let baseline = 0
      yield* SubscriptionRef.set(ref, baseline)
      const fiber = yield* SubscriptionRef.changes(ref).pipe(
        Stream.dropWhile((c) => c <= baseline),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      )
      const t0 = Bun.nanoseconds()
      yield* mb.send(newMail(0))
      yield* Fiber.join(fiber)
      const elapsed = Bun.nanoseconds() - t0
      baseline += 1
      return elapsed
    }),
  )

  // Custom inline percentile bench so the measurement excludes the harness's
  // own callback overhead — wakeup latency is sensitive enough that an extra
  // Promise hop would dominate the signal.
  const samples: number[] = []
  for (let i = 0; i < 30; i++) await Effect.runPromise(program) // warmup
  for (let i = 0; i < 300; i++) {
    samples.push(await Effect.runPromise(program))
  }
  samples.sort((a, b) => a - b)
  const at = (q: number) => samples[Math.max(0, Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1))]
  let sum = 0
  for (const s of samples) sum += s
  const result: BenchResult = {
    label: "mailbox.subscribe.wakeup_latency",
    samples: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    min: samples[0],
    max: samples[samples.length - 1],
    mean: sum / samples.length,
  }
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

test("bench: mailbox.drain.100_messages", async () => {
  const result = await bench(
    { samples: 200, warmup: 20, label: "mailbox.drain.100_messages" },
    async () => {
      const mb = await Effect.runPromise(Mailbox.make())
      for (let i = 0; i < 100; i++) {
        await Effect.runPromise(mb.send(newMail(i)))
      }
      const drained = await Effect.runPromise(mb.drain())
      if (drained.length !== 100) throw new Error(`expected 100, got ${drained.length}`)
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
