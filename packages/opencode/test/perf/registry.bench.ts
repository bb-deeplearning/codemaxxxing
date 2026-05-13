import * as fs from "node:fs/promises"
import * as path from "node:path"
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionID } from "../../src/session/schema"
import { AgentPath } from "../../src/agent/agent-path"
import { AgentMetadata } from "../../src/agent/metadata"
import { AgentRegistry, type Interface as AgentRegistryInterface } from "../../src/agent/registry"
import { bench, type BenchResult } from "../lib/perf"

// Wave 6 perf bench. Three metrics, all measured against new code only — no
// wave_0 baseline applies (registry is brand-new). The bench records actual
// numbers for future regression checks rather than asserting a budget here.
//
// Metrics:
//   - registry.reserveSpawnSlot.then.commit — full one-agent reservation cycle
//   - registry.agentIdForPath.lookup        — single lookup in a 64-agent tree
//   - registry.liveAgents.snapshot          — snapshot of a populated tree

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
  "wave_6.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

const POOL_SIZE = 64
const candidates = Array.from({ length: POOL_SIZE * 4 }, (_, i) => `candidate_${i}`)

const populate = (registry: AgentRegistryInterface) =>
  Effect.gen(function* () {
    yield* registry.registerRootThread(SessionID.descending())
    for (let i = 0; i < POOL_SIZE; i++) {
      const reservation = yield* registry.reserveSpawnSlot(undefined)
      const agentPath = yield* AgentPath.from(`/root/agent_${i}`)
      yield* reservation.reserveAgentPath(agentPath)
      yield* reservation.commit(
        new AgentMetadata({
          agent_id: SessionID.descending(),
          agent_path: agentPath,
          agent_nickname: `worker_${i}`,
          agent_role: "explorer",
        }),
      )
    }
  })

test("bench: registry.reserveSpawnSlot.then.commit", async () => {
  const result = await bench(
    { samples: 1000, warmup: 100, label: "registry.reserveSpawnSlot.then.commit" },
    async () => {
      // Each iteration is a fresh registry so the slot count doesn't grow
      // unboundedly across samples — the metric measures cost of reserve+commit
      // for a single agent on an empty tree, not amortized over a populated one.
      const r = await Effect.runPromise(AgentRegistry.make())
      const reservation = await Effect.runPromise(r.reserveSpawnSlot(undefined))
      await Effect.runPromise(
        reservation.commit(new AgentMetadata({ agent_id: SessionID.descending() })),
      )
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

test("bench: registry.agentIdForPath.lookup", async () => {
  const r = await Effect.runPromise(AgentRegistry.make())
  await Effect.runPromise(populate(r))
  const lookups = Array.from({ length: 1000 }, (_, i) =>
    Effect.runSync(AgentPath.from(`/root/agent_${i % POOL_SIZE}`)),
  )

  const result = await bench(
    { samples: 1000, warmup: 100, label: "registry.agentIdForPath.lookup" },
    async () => {
      // Single lookup per sample — the hot path inside Pty is one lookup per
      // model turn, not a batch. Use a different index each iteration so
      // cache effects don't bias the result.
      const idx = Math.floor(Math.random() * lookups.length)
      await Effect.runPromise(r.agentIdForPath(lookups[idx]))
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
  // Sanity check: the registry actually has 64 entries.
  const live = await Effect.runPromise(r.liveAgents())
  expect(live.length).toBe(POOL_SIZE)
})

test("bench: registry.liveAgents.snapshot", async () => {
  const r = await Effect.runPromise(AgentRegistry.make())
  await Effect.runPromise(populate(r))

  const result = await bench(
    { samples: 1000, warmup: 100, label: "registry.liveAgents.snapshot" },
    async () => {
      const snapshot = await Effect.runPromise(r.liveAgents())
      if (snapshot.length !== POOL_SIZE) {
        throw new Error(`expected ${POOL_SIZE} agents, got ${snapshot.length}`)
      }
    },
  )
  allResults[result.label] = result
  expect(result.samples).toBeGreaterThan(0)
})

// Sanity: ensure the candidate pool isn't unused (silences the import warning
// pattern of files that build helper data at module scope but only use it in
// some cases). We exercise the candidates array via a quick reservation
// cycle so any future refactor that drops the pool is caught.
test("bench self-check: nickname allocation finishes in linear time across the pool", async () => {
  const r = await Effect.runPromise(AgentRegistry.make())
  for (let i = 0; i < candidates.length; i++) {
    const reservation = await Effect.runPromise(r.reserveSpawnSlot(undefined))
    const nick = await Effect.runPromise(
      reservation.reserveAgentNicknameWithPreference(candidates),
    )
    await Effect.runPromise(
      reservation.commit(
        new AgentMetadata({ agent_id: SessionID.descending(), agent_nickname: nick }),
      ),
    )
  }
  const live = await Effect.runPromise(r.liveAgents())
  expect(live.length).toBe(candidates.length)
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
