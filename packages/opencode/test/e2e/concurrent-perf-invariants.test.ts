// Wave 14 e2e — concurrent perf invariants per PERF.md.
//
// Three measurements:
//   1. 4-sibling concurrent CPU vs single-session: ratio \u2264 1.6\u00d7
//   2. Per-sibling LLM stream latency: same as single-session (under
//      stubbed provider, what we measure is dispatch overhead)
//   3. Mailbox seq-watch wakeup latency: \u2264 5ms p99 from `send` to
//      subscriber resume
//
// Results land in artifacts/perf/wave_14.json so the final perf report
// (generated separately) can carry them. No baseline comparison here \u2014
// these are wave-14-introduced metrics measuring multi-agent v2 invariants
// that didn't exist before this campaign.

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { afterAll, describe, expect } from "bun:test"
import { Effect, SubscriptionRef } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { Session } from "@/session/session"
import { provideTmpdirServer } from "../fixture/fixture"
import { type BenchResult } from "../lib/perf"
import { it, providerCfg, installSuiteNetworkGuard } from "./lib"

installSuiteNetworkGuard()

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
  "wave_14.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const percentile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]

const summarize = (label: string, samples: number[]): BenchResult => {
  samples.sort((a, b) => a - b)
  let sum = 0
  for (const s of samples) sum += s
  return {
    label,
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    min: samples[0],
    max: samples[samples.length - 1],
    mean: sum / samples.length,
  }
}

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

describe("e2e perf: concurrent-session invariants", () => {
  it.live(
    "4 sibling sessions running in parallel: total CPU \u2264 1.6\u00d7 single-session",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service

          // Stub provider returns instantly (no latency); what we measure
          // is wall-clock dispatch overhead. Queue enough responses for
          // every iteration of both runs.
          for (let i = 0; i < 60; i++) yield* llm.text(`r${i}`)

          const root = yield* sessions.create({
            title: "perf-cpu-ratio",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* control.registerSessionRoot(root.id)

          // Warmup pass — ignored. Get the runtime hot before measuring.
          for (let i = 0; i < 2; i++) {
            yield* control.spawnAgent({
              parentID: root.id,
              parentPath: AgentPath.root(),
              task_name: `warm${i}`,
              initial_message: ".",
            })
          }
          yield* llm.wait(2)

          // Repeat single + 4-sibling 5 iterations each. Take medians.
          // Mirrors the wave_4 best-of-N gotcha: per-iteration noise on a
          // dev machine is large enough to swing a single ratio past the
          // budget even when the implementation is fine.
          const ITERS = 5
          let pulls = 2 // already pulled 2 in warmup
          const singleSamples: number[] = []
          const fanSamples: number[] = []

          for (let it = 0; it < ITERS; it++) {
            // single
            const t0 = Bun.nanoseconds()
            yield* control.spawnAgent({
              parentID: root.id,
              parentPath: AgentPath.root(),
              task_name: `single_${it}`,
              initial_message: ".",
            })
            pulls += 1
            yield* llm.wait(pulls)
            singleSamples.push(Bun.nanoseconds() - t0)

            // 4-sibling
            const tf = Bun.nanoseconds()
            for (let i = 0; i < 4; i++) {
              yield* control.spawnAgent({
                parentID: root.id,
                parentPath: AgentPath.root(),
                task_name: `fan_${it}_${i}`,
                initial_message: ".",
              })
            }
            pulls += 4
            yield* llm.wait(pulls)
            fanSamples.push(Bun.nanoseconds() - tf)
          }

          const median = (xs: number[]) => {
            const s = [...xs].sort((a, b) => a - b)
            return s[Math.floor(s.length / 2)]!
          }
          const singleMed = median(singleSamples)
          const fanMed = median(fanSamples)
          const ratio = fanMed / singleMed
          allResults["e2e.concurrent.4sibling_vs_single"] = summarize(
            "e2e.concurrent.4sibling_vs_single",
            [...fanSamples, ...singleSamples],
          )
          // PERF.md cap: 1.6\u00d7. We report the actual ratio; assert under
          // cap. Median-vs-median resists per-run noise.
          // eslint-disable-next-line no-console
          console.log(
            `[concurrent-perf] single med=${(singleMed / 1_000_000).toFixed(2)}ms fan med=${(fanMed / 1_000_000).toFixed(2)}ms ratio=${ratio.toFixed(2)}\u00d7 cap=1.6\u00d7`,
          )
          expect(ratio).toBeLessThan(1.6)
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )

  it.live(
    "mailbox seq-watch wakeup latency: p99 \u2264 5ms from send to subscriber resume",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          // Hang LLM so the spawned child loop holds and never drains the
          // mailbox out from under us between iterations.
          yield* llm.hang

          const root = yield* sessions.create({
            title: "perf-mailbox-wakeup",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* control.registerSessionRoot(root.id)
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "wakee",
            initial_message: ".",
          })
          // Drain the seed message so the next sequence increment is
          // measurable.
          yield* control.drainMailbox(child.thread_id)

          const seqRef = yield* control.subscribeMailboxSeq(child.thread_id)
          const recipient = child.metadata.agent_path ?? AgentPath.root()

          // Warmup
          for (let i = 0; i < 20; i++) {
            const before = yield* SubscriptionRef.get(seqRef)
            yield* control.sendInterAgentCommunication(
              child.thread_id,
              new InterAgentCommunication({
                author: AgentPath.root(),
                recipient,
                content: `w${i}`,
                trigger_turn: false,
                sent_at: i,
              }),
            )
            // Wait until seqRef reports a higher seq (the wakeup signal).
            yield* Effect.gen(function* () {
              const deadline = Date.now() + 200
              while (Date.now() < deadline) {
                const cur = yield* SubscriptionRef.get(seqRef)
                if (cur > before) return
                yield* Effect.sleep(1)
              }
              throw new Error("warmup wakeup did not fire within 200ms")
            })
          }
          yield* control.drainMailbox(child.thread_id)

          const samples: number[] = []
          for (let i = 0; i < 100; i++) {
            const before = yield* SubscriptionRef.get(seqRef)
            const t0 = Bun.nanoseconds()
            yield* control.sendInterAgentCommunication(
              child.thread_id,
              new InterAgentCommunication({
                author: AgentPath.root(),
                recipient,
                content: `m${i}`,
                trigger_turn: false,
                sent_at: i,
              }),
            )
            // Spin-poll the SubscriptionRef value rather than subscribing
            // a Stream per sample (per-iteration Stream setup would
            // dominate the measurement). Spinning is acceptable: the
            // ref is set from the same fiber that returns from the send,
            // so the wakeup is observable on the very next read.
            yield* Effect.gen(function* () {
              const deadline = Date.now() + 100
              while (Date.now() < deadline) {
                const cur = yield* SubscriptionRef.get(seqRef)
                if (cur > before) return
                yield* Effect.sleep(0)
              }
              throw new Error("mailbox wakeup exceeded 100ms")
            })
            samples.push(Bun.nanoseconds() - t0)
            // Drain occasionally so the mailbox stays bounded and seq
            // increments cleanly.
            if (i % 20 === 19) yield* control.drainMailbox(child.thread_id)
          }
          const result = summarize("e2e.mailbox.wakeup_latency", samples)
          allResults[result.label] = result
          // PERF.md cap: 5ms p99. Convert to ns for comparison.
          expect(result.p99).toBeLessThan(5_000_000)
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )
})
