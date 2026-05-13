import { describe, expect } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { SessionID } from "@/session/schema"
import { testEffect } from "../../test/lib/effect"
import { AgentPath } from "./agent-path"
import { AgentMetadata } from "./metadata"
import {
  AGENT_MAX_DEPTH,
  AGENT_MAX_THREADS,
  AgentLimitReachedError,
  AgentRegistry,
  NoNicknameAvailableError,
  PathAlreadyExistsError,
  exceedsThreadSpawnDepthLimit,
  formatAgentNickname,
  nextThreadSpawnDepth,
} from "./registry"

const it = testEffect(Layer.empty)

const path = (s: string) => Effect.runSync(AgentPath.from(s))
const id = () => SessionID.descending()
const meta = (sessionId: SessionID, extras: Partial<AgentMetadata> = {}) =>
  new AgentMetadata({ agent_id: sessionId, ...extras })

// English ordinal suffix, used to derive expectations for the formatter test.
const ordinal = (n: number): string => {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return "th"
  switch (n % 10) {
    case 1:
      return "st"
    case 2:
      return "nd"
    case 3:
      return "rd"
    default:
      return "th"
  }
}

describe("registry constants", () => {
  it.live("AGENT_MAX_DEPTH default matches codex (4)", () =>
    Effect.sync(() => {
      expect(AGENT_MAX_DEPTH).toBe(4)
    }),
  )

  it.live("AGENT_MAX_THREADS default is undefined (no cap)", () =>
    Effect.sync(() => {
      expect(AGENT_MAX_THREADS).toBeUndefined()
    }),
  )
})

describe("registry error messages", () => {
  it.live("AgentLimitReachedError.message includes the cap", () =>
    Effect.sync(() => {
      const err = new AgentLimitReachedError({ max_threads: 7 })
      expect(err.message).toContain("7")
      expect(err.message).toMatch(/limit/i)
    }),
  )

  it.live("NoNicknameAvailableError.message is human-readable", () =>
    Effect.sync(() => {
      const err = new NoNicknameAvailableError({})
      expect(err.message).toMatch(/nickname/i)
    }),
  )

  it.live("PathAlreadyExistsError.message includes the path", () =>
    Effect.sync(() => {
      const err = new PathAlreadyExistsError({ path: path("/root/dup") })
      expect(err.message).toContain("/root/dup")
    }),
  )
})

describe("formatAgentNickname", () => {
  it.live("returns the bare name when reset count is 0", () =>
    Effect.sync(() => {
      expect(formatAgentNickname("Plato", 0)).toBe("Plato")
    }),
  )

  it.live("appends 'the 2nd' on the first reset", () =>
    Effect.sync(() => {
      expect(formatAgentNickname("Plato", 1)).toBe("Plato the 2nd")
    }),
  )

  it.live("appends 'the 3rd' on the second reset", () =>
    Effect.sync(() => {
      expect(formatAgentNickname("Plato", 2)).toBe("Plato the 3rd")
    }),
  )

  it.live("matches the english ordinal suffix for resets 1..30 (incl. 11..13 → th)", () =>
    Effect.sync(() => {
      for (let reset = 1; reset <= 30; reset++) {
        const value = reset + 1
        const expected = `Plato the ${value}${ordinal(value)}`
        expect(formatAgentNickname("Plato", reset)).toBe(expected)
      }
    }),
  )
})

describe("depth helpers", () => {
  it.live("nextThreadSpawnDepth returns 1 when source depth is missing", () =>
    Effect.sync(() => {
      expect(nextThreadSpawnDepth(null)).toBe(1)
      expect(nextThreadSpawnDepth(undefined)).toBe(1)
      expect(nextThreadSpawnDepth({})).toBe(1)
    }),
  )

  it.live("nextThreadSpawnDepth returns N+1 for a ThreadSpawn at depth N", () =>
    Effect.sync(() => {
      expect(nextThreadSpawnDepth({ depth: 0 })).toBe(1)
      expect(nextThreadSpawnDepth({ depth: 1 })).toBe(2)
      expect(nextThreadSpawnDepth({ depth: 4 })).toBe(5)
    }),
  )

  it.live("exceedsThreadSpawnDepthLimit returns true when depth > maxDepth", () =>
    Effect.sync(() => {
      expect(exceedsThreadSpawnDepthLimit(5, 4)).toBe(true)
      expect(exceedsThreadSpawnDepthLimit(4, 4)).toBe(false)
      expect(exceedsThreadSpawnDepthLimit(1, 4)).toBe(false)
    }),
  )
})

describe("AgentRegistry.reserveSpawnSlot — concurrency cap", () => {
  it.live("succeeds when under cap", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const res = yield* r.reserveSpawnSlot(1)
      yield* res.commit(meta(id()))
    }),
  )

  it.live("rejects with AgentLimitReachedError when at cap", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(1)
      yield* first.commit(meta(id()))
      const result = yield* Effect.result(r.reserveSpawnSlot(1))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AgentLimitReachedError)
        expect(result.failure.max_threads).toBe(1)
      }
    }),
  )

  it.live("with no cap (undefined) always succeeds", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      for (let i = 0; i < 10; i++) {
        const res = yield* r.reserveSpawnSlot(undefined)
        yield* res.commit(meta(id()))
      }
      const all = yield* r.liveAgents()
      expect(all.length).toBe(10)
    }),
  )

  it.live("released slot can be re-reserved", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(1)
      const sid = id()
      yield* first.commit(meta(sid))
      yield* r.releaseSpawnedThread(sid)
      const second = yield* r.reserveSpawnSlot(1)
      yield* second.commit(meta(id()))
    }),
  )
})

describe("SpawnReservation.release without commit", () => {
  it.live("dropping (releasing) without commit frees the slot", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(1)
      yield* first.release()
      // After release, the slot is free again.
      const second = yield* r.reserveSpawnSlot(1)
      yield* second.release()
    }),
  )

  it.live("release is idempotent", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(1)
      yield* first.release()
      yield* first.release()
      // Slot is still free; reserve again.
      const second = yield* r.reserveSpawnSlot(1)
      yield* second.commit(meta(id()))
      // And the cap still binds at 1.
      const result = yield* Effect.result(r.reserveSpawnSlot(1))
      expect(Result.isFailure(result)).toBe(true)
    }),
  )

  it.live("commit followed by release does not double-decrement the slot", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(1)
      yield* reservation.commit(meta(id()))
      // After commit, release is a no-op.
      yield* reservation.release()
      const result = yield* Effect.result(r.reserveSpawnSlot(1))
      expect(Result.isFailure(result)).toBe(true)
    }),
  )

  it.live("reserved (uncommitted) path is freed on release", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      yield* first.reserveAgentPath(path("/root/researcher"))
      yield* first.release()
      // Same path can be reserved again because the prior reservation released.
      const second = yield* r.reserveSpawnSlot(undefined)
      yield* second.reserveAgentPath(path("/root/researcher"))
    }),
  )
})

describe("SpawnReservation.commit", () => {
  it.live("registers metadata indexed by agent_path", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.reserveAgentPath(path("/root/researcher"))
      yield* reservation.commit(
        new AgentMetadata({
          agent_id: sid,
          agent_path: path("/root/researcher"),
        }),
      )
      const looked = yield* r.agentIdForPath(path("/root/researcher"))
      expect(looked).toBe(sid)
    }),
  )

  it.live("metadata without an agent_path is keyed under thread:<id>", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.commit(meta(sid))
      const all = yield* r.liveAgents()
      expect(all.length).toBe(1)
      expect(all[0].agent_id).toBe(sid)
    }),
  )

  it.live("commit drops a metadata that has no agent_id (defensive)", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      // commit with empty metadata — no thread to register
      yield* reservation.commit(new AgentMetadata({}))
      const all = yield* r.liveAgents()
      expect(all.length).toBe(0)
    }),
  )
})

describe("SpawnReservation.reserveAgentPath", () => {
  it.live("rejects a duplicate path with PathAlreadyExistsError", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      yield* first.reserveAgentPath(path("/root/worker"))

      const second = yield* r.reserveSpawnSlot(undefined)
      const result = yield* Effect.result(second.reserveAgentPath(path("/root/worker")))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(PathAlreadyExistsError)
        expect(String(result.failure.path)).toBe("/root/worker")
      }
    }),
  )
})

describe("AgentRegistry.registerRootThread", () => {
  it.live("registers /root with the supplied SessionID", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const rootId = id()
      yield* r.registerRootThread(rootId)
      const looked = yield* r.agentIdForPath(AgentPath.root())
      expect(looked).toBe(rootId)
    }),
  )

  it.live("is idempotent — second call does not overwrite", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const rootA = id()
      const rootB = id()
      yield* r.registerRootThread(rootA)
      yield* r.registerRootThread(rootB)
      const looked = yield* r.agentIdForPath(AgentPath.root())
      expect(looked).toBe(rootA)
    }),
  )
})

describe("AgentRegistry.releaseSpawnedThread", () => {
  it.live("removes a non-root agent and decrements the slot count", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(1)
      const sid = id()
      yield* first.commit(meta(sid))
      yield* r.releaseSpawnedThread(sid)
      // Slot is free again under cap=1
      const second = yield* r.reserveSpawnSlot(1)
      yield* second.commit(meta(id()))
    }),
  )

  it.live("on the root SessionID does NOT decrement the slot count", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const rootId = id()
      yield* r.registerRootThread(rootId)
      const first = yield* r.reserveSpawnSlot(1)
      yield* first.commit(meta(id()))
      // releasing the ROOT must not free a slot — root isn't counted.
      yield* r.releaseSpawnedThread(rootId)
      const result = yield* Effect.result(r.reserveSpawnSlot(1))
      expect(Result.isFailure(result)).toBe(true)
    }),
  )

  it.live("ignores an unknown SessionID without changing state", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(1)
      yield* first.commit(meta(id()))
      yield* r.releaseSpawnedThread(id())
      // Cap still binds.
      const result = yield* Effect.result(r.reserveSpawnSlot(1))
      expect(Result.isFailure(result)).toBe(true)
    }),
  )

  it.live("calling release twice on the same id is a no-op the second time", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(2)
      const sid = id()
      yield* first.commit(meta(sid))
      const second = yield* r.reserveSpawnSlot(2)
      yield* second.commit(meta(id()))
      yield* r.releaseSpawnedThread(sid)
      yield* r.releaseSpawnedThread(sid)
      // Only the second commit remains in the slot count, so cap=2 still
      // permits exactly one more reservation. A third must fail.
      const okThird = yield* r.reserveSpawnSlot(2)
      yield* okThird.commit(meta(id()))
      const result = yield* Effect.result(r.reserveSpawnSlot(2))
      expect(Result.isFailure(result)).toBe(true)
    }),
  )

  it.live("removing a committed agent unlinks its agent_path lookup", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.reserveAgentPath(path("/root/researcher"))
      yield* reservation.commit(
        new AgentMetadata({ agent_id: sid, agent_path: path("/root/researcher") }),
      )
      yield* r.releaseSpawnedThread(sid)
      const looked = yield* r.agentIdForPath(path("/root/researcher"))
      expect(looked).toBeUndefined()
    }),
  )
})

describe("AgentRegistry.agentIdForPath", () => {
  it.live("returns the registered SessionID for a known path", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.reserveAgentPath(path("/root/a/b"))
      yield* reservation.commit(
        new AgentMetadata({ agent_id: sid, agent_path: path("/root/a/b") }),
      )
      expect(yield* r.agentIdForPath(path("/root/a/b"))).toBe(sid)
    }),
  )

  it.live("returns undefined for an unknown path", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      expect(yield* r.agentIdForPath(path("/root/missing"))).toBeUndefined()
    }),
  )

  it.live("returns undefined for a reserved-but-uncommitted path", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      yield* reservation.reserveAgentPath(path("/root/pending"))
      // The path is reserved but the entry has no agent_id yet.
      expect(yield* r.agentIdForPath(path("/root/pending"))).toBeUndefined()
    }),
  )
})

describe("AgentRegistry.agentMetadataForThread", () => {
  it.live("returns metadata for a known SessionID", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.commit(
        new AgentMetadata({
          agent_id: sid,
          agent_nickname: "Plato",
          agent_role: "philosopher",
        }),
      )
      const m = yield* r.agentMetadataForThread(sid)
      expect(m).toBeDefined()
      expect(m?.agent_nickname).toBe("Plato")
      expect(m?.agent_role).toBe("philosopher")
    }),
  )

  it.live("returns undefined for an unknown SessionID", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      expect(yield* r.agentMetadataForThread(id())).toBeUndefined()
    }),
  )
})

describe("AgentRegistry.liveAgents", () => {
  it.live("returns all non-root agents", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      yield* r.registerRootThread(id())
      const a = yield* r.reserveSpawnSlot(undefined)
      yield* a.commit(meta(id(), { agent_nickname: "alpha" }))
      const b = yield* r.reserveSpawnSlot(undefined)
      yield* b.commit(meta(id(), { agent_nickname: "beta" }))
      const all = yield* r.liveAgents()
      expect(all.length).toBe(2)
      const nicks = all.map((m) => m.agent_nickname).sort()
      expect(nicks).toEqual(["alpha", "beta"])
    }),
  )

  it.live("excludes the root entry", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      yield* r.registerRootThread(id())
      const all = yield* r.liveAgents()
      expect(all.length).toBe(0)
    }),
  )

  it.live("excludes a reserved-but-uncommitted path entry", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      yield* reservation.reserveAgentPath(path("/root/pending"))
      const all = yield* r.liveAgents()
      expect(all.length).toBe(0)
    }),
  )

  it.live("returns empty for a fresh registry", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      expect(yield* r.liveAgents()).toEqual([])
    }),
  )
})

describe("AgentRegistry.updateLastTaskMessage", () => {
  it.live("persists the message in the agent's metadata", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.commit(meta(sid, { agent_nickname: "Newton" }))
      yield* r.updateLastTaskMessage(sid, "compute the gradient")
      const m = yield* r.agentMetadataForThread(sid)
      expect(m?.last_task_message).toBe("compute the gradient")
      // Other fields preserved.
      expect(m?.agent_nickname).toBe("Newton")
    }),
  )

  it.live("overwrites an existing message", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const sid = id()
      yield* reservation.commit(meta(sid, { last_task_message: "first" }))
      yield* r.updateLastTaskMessage(sid, "second")
      const m = yield* r.agentMetadataForThread(sid)
      expect(m?.last_task_message).toBe("second")
    }),
  )

  it.live("is a silent no-op for an unknown SessionID", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      yield* r.updateLastTaskMessage(id(), "ghost message")
      const all = yield* r.liveAgents()
      expect(all.length).toBe(0)
    }),
  )
})

describe("SpawnReservation.reserveAgentNicknameWithPreference", () => {
  it.live("returns the only candidate when nothing is used", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const nick = yield* reservation.reserveAgentNicknameWithPreference(["alpha"])
      expect(nick).toBe("alpha")
    }),
  )

  it.live("respects the preferred name when it is available", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const nick = yield* reservation.reserveAgentNicknameWithPreference(
        ["alpha", "beta"],
        "preferred_name",
      )
      expect(nick).toBe("preferred_name")
    }),
  )

  it.live("falls back to candidates when preferred is already taken", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      yield* first.commit(meta(id(), { agent_nickname: "duplicated" }))

      const second = yield* r.reserveSpawnSlot(undefined)
      const nick = yield* second.reserveAgentNicknameWithPreference(["alpha"], "duplicated")
      // Preferred is taken, fall back to the only available candidate.
      expect(nick).toBe("alpha")
    }),
  )

  it.live("a failed (released) reservation keeps its nickname marked as used", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      const firstNick = yield* first.reserveAgentNicknameWithPreference(["alpha"])
      expect(firstNick).toBe("alpha")
      yield* first.release()

      const second = yield* r.reserveSpawnSlot(undefined)
      const secondNick = yield* second.reserveAgentNicknameWithPreference(["alpha", "beta"])
      // 'alpha' is still marked used despite the prior reservation being released.
      expect(secondNick).toBe("beta")
    }),
  )

  it.live("a released committed thread keeps its nickname marked as used", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      const firstNick = yield* first.reserveAgentNicknameWithPreference(["alpha"])
      const firstId = id()
      yield* first.commit(meta(firstId, { agent_nickname: firstNick }))
      yield* r.releaseSpawnedThread(firstId)

      const second = yield* r.reserveSpawnSlot(undefined)
      const secondNick = yield* second.reserveAgentNicknameWithPreference(["alpha", "beta"])
      expect(secondNick).toBe("beta")
    }),
  )

  it.live("resets the pool with the suffix ordinal when exhausted", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      yield* first.reserveAgentNicknameWithPreference(["alpha"])
      yield* first.commit(meta(id(), { agent_nickname: "alpha" }))

      const second = yield* r.reserveSpawnSlot(undefined)
      const nick = yield* second.reserveAgentNicknameWithPreference(["alpha"])
      expect(nick).toBe("alpha the 2nd")
    }),
  )

  it.live("repeated resets advance the suffix ordinal", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const first = yield* r.reserveSpawnSlot(undefined)
      const firstNick = yield* first.reserveAgentNicknameWithPreference(["Plato"])
      const firstId = id()
      yield* first.commit(meta(firstId, { agent_nickname: firstNick }))
      expect(firstNick).toBe("Plato")
      yield* r.releaseSpawnedThread(firstId)

      const second = yield* r.reserveSpawnSlot(undefined)
      const secondNick = yield* second.reserveAgentNicknameWithPreference(["Plato"])
      const secondId = id()
      yield* second.commit(meta(secondId, { agent_nickname: secondNick }))
      expect(secondNick).toBe("Plato the 2nd")
      yield* r.releaseSpawnedThread(secondId)

      const third = yield* r.reserveSpawnSlot(undefined)
      const thirdNick = yield* third.reserveAgentNicknameWithPreference(["Plato"])
      expect(thirdNick).toBe("Plato the 3rd")
    }),
  )

  it.live("rejects with NoNicknameAvailableError when candidates is empty and no preferred", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const result = yield* Effect.result(reservation.reserveAgentNicknameWithPreference([]))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(NoNicknameAvailableError)
      }
    }),
  )

  it.live("preferred wins even when candidates is empty (preferred is independent)", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const reservation = yield* r.reserveSpawnSlot(undefined)
      const nick = yield* reservation.reserveAgentNicknameWithPreference([], "solo")
      expect(nick).toBe("solo")
    }),
  )
})

describe("AgentRegistry concurrency", () => {
  it.live("concurrent reservations under cap each get a slot exclusively", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const N = 5
      const reservations = yield* Effect.all(
        Array.from({ length: N }, () => r.reserveSpawnSlot(N)),
        { concurrency: "unbounded" },
      )
      expect(reservations.length).toBe(N)
      // The (N+1)th reservation must fail.
      const overflow = yield* Effect.result(r.reserveSpawnSlot(N))
      expect(Result.isFailure(overflow)).toBe(true)
    }),
  )

  it.live("under contention only `cap` reservations succeed", () =>
    Effect.gen(function* () {
      const r = yield* AgentRegistry.make()
      const cap = 3
      const attempts = yield* Effect.all(
        Array.from({ length: 10 }, () => Effect.result(r.reserveSpawnSlot(cap))),
        { concurrency: "unbounded" },
      )
      const successes = attempts.filter(Result.isSuccess).length
      const failures = attempts.filter(Result.isFailure).length
      expect(successes).toBe(cap)
      expect(failures).toBe(10 - cap)
    }),
  )
})
