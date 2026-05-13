import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Result, Stream, SubscriptionRef } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../../test/fixture/fixture"
import { testEffect } from "../../test/lib/effect"
import {
  AgentControl,
  AgentDepthExceededError,
  AgentNotFoundError,
  AgentReferenceInvalidError,
  type SpawnEvent,
} from "./control"
import { AgentPath } from "./agent-path"
import { AgentLimitReachedError, PathAlreadyExistsError } from "./registry"
import { InterAgentCommunication } from "./inter-agent-communication"

// AgentControl tests use real Session.Service so the spawn flow exercises the
// actual session-create code path. The runLoop is stubbed via
// `registerRunLoop` — production wiring lands in Wave 9. Each it.live test
// runs in a tmpdir instance so InstanceState gives us a fresh AgentControl
// (mailboxes, statuses, fibers) per test.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    AgentControl.defaultLayer,
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const ROOT = AgentPath.root()
const path = (s: string) => Effect.runSync(AgentPath.from(s))

// Stub run-loop installer: takes ownership of a "block until cancelled" effect
// per child so spawn returns the LiveAgent immediately and the child stays in
// the registry until close. The caller provides an array to record which
// session ids were forked (one per spawn).
const installNeverLoop = (recorded: SessionID[]) =>
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    yield* control.registerRunLoop((sid) => {
      recorded.push(sid)
      return Effect.never
    })
  })

const seedRoot = Effect.fn("AgentControlTest.seedRoot")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "root" })
  const control = yield* AgentControl.Service
  yield* control.registerSessionRoot(root.id)
  return root
})

describe("AgentControl.spawnAgent", () => {
  it.live("creates a child session, registers metadata, and returns a LiveAgent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const recorded: SessionID[] = []
        yield* installNeverLoop(recorded)
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "worker",
          initial_message: "do the thing",
        })

        expect(typeof live.thread_id).toBe("string")
        expect(String(live.metadata.agent_path)).toBe("/root/worker")
        expect(live.metadata.agent_id).toBe(live.thread_id)
        expect(live.metadata.last_task_message).toBe("do the thing")
        // Status begins as pending_init or running depending on whether the
        // run-loop fork has executed. Either is acceptable; what matters is
        // that we observe a non-final state right after spawn.
        const final = AgentStatusIsFinal(live.status)
        expect(final).toBe(false)
        // Run-loop was forked exactly once for this spawn.
        expect(recorded).toEqual([live.thread_id])
      }),
    ),
  )

  it.live("nests a child path under the parent's path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: "first level",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/a"),
          task_name: "b",
          initial_message: "second level",
        })

        expect(String(b.metadata.agent_path)).toBe("/root/a/b")
      }),
    ),
  )

  it.live("rejects when the path already exists in the tree", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "dup",
          initial_message: "first",
        })

        const result = yield* Effect.result(
          control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "dup",
            initial_message: "second",
          }),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(PathAlreadyExistsError)
        }
      }),
    ),
  )

  it.live("rejects when child depth would exceed AGENT_MAX_DEPTH (4)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        // Build a chain of depths 1..4 — all should succeed.
        const lvl1 = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "l1",
          initial_message: ".",
        })
        const lvl2 = yield* control.spawnAgent({
          parentID: lvl1.thread_id,
          parentPath: path("/root/l1"),
          task_name: "l2",
          initial_message: ".",
        })
        const lvl3 = yield* control.spawnAgent({
          parentID: lvl2.thread_id,
          parentPath: path("/root/l1/l2"),
          task_name: "l3",
          initial_message: ".",
        })
        const lvl4 = yield* control.spawnAgent({
          parentID: lvl3.thread_id,
          parentPath: path("/root/l1/l2/l3"),
          task_name: "l4",
          initial_message: ".",
        })
        expect(String(lvl4.metadata.agent_path)).toBe("/root/l1/l2/l3/l4")

        // Depth 5 — must reject.
        const result = yield* Effect.result(
          control.spawnAgent({
            parentID: lvl4.thread_id,
            parentPath: path("/root/l1/l2/l3/l4"),
            task_name: "l5",
            initial_message: ".",
          }),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentDepthExceededError)
        }
      }),
    ),
  )

  it.live("rejects when the explicit max_threads cap is reached", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "first",
          initial_message: ".",
          max_threads: 2,
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "second",
          initial_message: ".",
          max_threads: 2,
        })
        const result = yield* Effect.result(
          control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "third",
            initial_message: ".",
            max_threads: 2,
          }),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentLimitReachedError)
        }
      }),
    ),
  )

  it.live("emits spawn_begin then spawn_end to a registered listener", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const events: SpawnEvent[] = []
        yield* control.onSpawnEvent((e) => events.push(e))

        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "watched",
          initial_message: "watch me",
        })

        const types = events.map((e) => e.type)
        expect(types).toEqual(["spawn_begin", "spawn_end"])
        const end = events.find((e) => e.type === "spawn_end")
        if (end?.type === "spawn_end") {
          expect(String(end.path)).toBe("/root/watched")
          expect(end.metadata.agent_id).toBe(end.sessionID)
        }
      }),
    ),
  )

  it.live("emits spawn_error when the spawn rejects (path collision)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const events: SpawnEvent[] = []
        yield* control.onSpawnEvent((e) => events.push(e))

        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "boom",
          initial_message: "first",
        })
        yield* Effect.result(
          control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "boom",
            initial_message: "second",
          }),
        )

        // Two spawn_begin events (one per attempt), one spawn_end (success), one spawn_error.
        expect(events.filter((e) => e.type === "spawn_error")).toHaveLength(1)
        const err = events.find((e) => e.type === "spawn_error")
        if (err?.type === "spawn_error") {
          expect(String(err.path)).toBe("/root/boom")
          expect(err.reason.length).toBeGreaterThan(0)
        }
      }),
    ),
  )

  it.live("seeds the child mailbox with the initial message before forking", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "delivers",
          initial_message: "first thought",
        })

        // The child's mailbox starts holding the initial message until the
        // run loop drains it. Wave 7's stub run-loop never drains, so we can
        // observe the message via drainMailbox directly.
        const drained = yield* control.drainMailbox(live.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("first thought")
        expect(drained[0]?.trigger_turn).toBe(true)
        expect(String(drained[0]?.recipient)).toBe("/root/delivers")
        expect(String(drained[0]?.author)).toBe("/root")
      }),
    ),
  )

  it.live("rejects when task_name is not a valid AgentPath segment", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* Effect.result(
          control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "bad-name", // hyphens are rejected by the segment validator
            initial_message: ".",
          }),
        )
        expect(Result.isFailure(result)).toBe(true)
      }),
    ),
  )
})

describe("AgentControl.sendInterAgentCommunication", () => {
  it.live("routes a message into the target's mailbox", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "routee",
          initial_message: "init",
        })
        // Drain the initial message so the next drain only shows the new send.
        yield* control.drainMailbox(child.thread_id)

        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/routee"),
            content: "hello sibling",
            trigger_turn: false,
            sent_at: 1,
          }),
        )
        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("hello sibling")
        expect(drained[0]?.trigger_turn).toBe(false)
      }),
    ),
  )

  it.live("trigger_turn=true advances the recipient's mailbox seq", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "wakeable",
          initial_message: "init",
        })
        const seqRef = yield* control.subscribeMailboxSeq(child.thread_id)
        const before = yield* SubscriptionRef.get(seqRef)

        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/wakeable"),
            content: "wake up",
            trigger_turn: true,
            sent_at: 2,
          }),
        )

        const after = yield* SubscriptionRef.get(seqRef)
        expect(after).toBeGreaterThan(before)
      }),
    ),
  )

  it.live("rejects with AgentNotFoundError when the target does not exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const phantom = SessionID.descending()

        const result = yield* Effect.result(
          control.sendInterAgentCommunication(
            phantom,
            new InterAgentCommunication({
              author: ROOT,
              recipient: path("/root/ghost"),
              content: "nobody home",
              trigger_turn: true,
              sent_at: 3,
            }),
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentNotFoundError)
        }
      }),
    ),
  )

  it.live("updates the target's last_task_message in the registry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "tasked",
          initial_message: "first",
        })

        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/tasked"),
            content: "second task: do X",
            trigger_turn: true,
            sent_at: 4,
          }),
        )
        const meta = yield* control.getAgentMetadata(child.thread_id)
        expect(meta?.last_task_message).toBe("second task: do X")
      }),
    ),
  )
})

describe("AgentControl.resolveAgentReference", () => {
  it.live("resolves a relative reference against the current path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/a"),
          task_name: "b",
          initial_message: ".",
        })

        const resolved = yield* control.resolveAgentReference(path("/root/a"), "b")
        expect(resolved).toBe(b.thread_id)
      }),
    ),
  )

  it.live("resolves a canonical absolute path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "abs",
          initial_message: ".",
        })

        const resolved = yield* control.resolveAgentReference(ROOT, "/root/abs")
        expect(resolved).toBe(child.thread_id)
      }),
    ),
  )

  it.live("returns the root SessionID when reference is /root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const resolved = yield* control.resolveAgentReference(ROOT, "/root")
        expect(resolved).toBe(root.id)
      }),
    ),
  )

  it.live("rejects when the reference resolves to an unknown live path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* Effect.result(
          control.resolveAgentReference(ROOT, "missing"),
        )
        expect(Result.isFailure(result)).toBe(true)
      }),
    ),
  )
})

describe("AgentControl.closeAgent", () => {
  it.live("shuts down the target and cascades to live descendants", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/a"),
          task_name: "b",
          initial_message: ".",
        })
        const c = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/a"),
          task_name: "c",
          initial_message: ".",
        })

        yield* control.closeAgent(a.thread_id)

        const live = yield* control.listAgents(ROOT)
        const remaining = live.map((l) => l.agent_name)
        expect(remaining.includes("/root/a")).toBe(false)
        expect(remaining.includes("/root/a/b")).toBe(false)
        expect(remaining.includes("/root/a/c")).toBe(false)
        // Sanity — b and c are released too, registry no longer reports them.
        expect(yield* control.getAgentMetadata(b.thread_id)).toBeUndefined()
        expect(yield* control.getAgentMetadata(c.thread_id)).toBeUndefined()
      }),
    ),
  )

  it.live("rejects when called on the root agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* Effect.result(control.closeAgent(root.id))
        expect(Result.isFailure(result)).toBe(true)
      }),
    ),
  )

  it.live("returns the previous status of the closed agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "closeme",
          initial_message: ".",
        })

        const { previous_status } = yield* control.closeAgent(child.thread_id)
        // Stub never-loop kept the child in pending_init or running before close.
        const wasNonFinal = previous_status === "pending_init" || previous_status === "running"
        expect(wasNonFinal).toBe(true)
      }),
    ),
  )

  it.live("is idempotent on an already-closed agent (returns shutdown)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "twice",
          initial_message: ".",
        })

        yield* control.closeAgent(child.thread_id)
        const second = yield* control.closeAgent(child.thread_id)
        expect(second.previous_status).toBe("shutdown")
      }),
    ),
  )

  it.live("interrupts the child run-loop fiber on close", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        let signaled = false
        yield* control.registerRunLoop(() =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                signaled = true
              }),
            ),
          ),
        )
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "interruptme",
          initial_message: ".",
        })

        // Allow the forked fiber to actually start so its onInterrupt is wired.
        yield* Effect.sleep(10)

        yield* control.closeAgent(child.thread_id)
        // Give the interruption a moment to propagate.
        yield* Effect.sleep(10)
        expect(signaled).toBe(true)
      }),
    ),
  )
})

describe("AgentControl.listAgents", () => {
  it.live("returns every live non-root agent registered in the tree", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "x",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "y",
          initial_message: ".",
        })

        const all = yield* control.listAgents(ROOT)
        const names = all.map((l) => l.agent_name).sort()
        // Includes root + the two spawned children.
        expect(names).toEqual(["/root", "/root/x", "/root/y"])
      }),
    ),
  )

  it.live("filters by a relative path_prefix resolved against the current path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "a",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/a"),
          task_name: "x",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/a"),
          task_name: "y",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })

        const filtered = yield* control.listAgents(ROOT, "/root/a")
        const names = filtered.map((l) => l.agent_name).sort()
        expect(names).toEqual(["/root/a", "/root/a/x", "/root/a/y"])
      }),
    ),
  )

  it.live("includes root in the result when the prefix matches root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "child",
          initial_message: ".",
        })

        const all = yield* control.listAgents(ROOT, "/root")
        const rootEntry = all.find((l) => l.agent_name === "/root")
        expect(rootEntry).toBeDefined()
        expect(rootEntry?.last_task_message).toBe("Main thread")
      }),
    ),
  )

  it.live("includes last_task_message and current status for each non-root agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "tracked",
          initial_message: "do thing X",
        })

        const list = yield* control.listAgents(ROOT)
        const tracked = list.find((l) => l.agent_name === "/root/tracked")
        expect(tracked).toBeDefined()
        expect(tracked?.last_task_message).toBe("do thing X")
        // Status begins non-final (pending_init or running).
        const finalStatus = AgentStatusIsFinal(tracked!.agent_status)
        expect(finalStatus).toBe(false)
      }),
    ),
  )
})

describe("AgentControl.subscribeStatus", () => {
  it.live("returns a SubscriptionRef yielding status changes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "subbed",
          initial_message: ".",
        })

        const ref = yield* control.subscribeStatus(child.thread_id)
        const initial = yield* SubscriptionRef.get(ref)
        // Initial status is non-final (pending_init or running).
        const initialFinal = AgentStatusIsFinal(initial)
        expect(initialFinal).toBe(false)

        // Drive a change via close.
        yield* control.closeAgent(child.thread_id)
        const after = yield* SubscriptionRef.get(ref)
        expect(after).toBe("shutdown")
      }),
    ),
  )

  it.live("rejects with AgentNotFoundError for an unknown SessionID", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* Effect.result(control.subscribeStatus(SessionID.descending()))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentNotFoundError)
        }
      }),
    ),
  )

  it.live("on a shutdown agent yields the final status without further changes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "after",
          initial_message: ".",
        })
        yield* control.closeAgent(child.thread_id)

        const ref = yield* control.subscribeStatus(child.thread_id)
        const value = yield* SubscriptionRef.get(ref)
        expect(value).toBe("shutdown")

        // Subscribers receive the cached final value via SubscriptionRef.changes.
        const stream = SubscriptionRef.changes(ref).pipe(Stream.take(1))
        const collected = yield* Stream.runCollect(stream)
        expect(Array.from(collected)).toEqual(["shutdown"])
      }),
    ),
  )
})

describe("AgentControl concurrency", () => {
  it.live("spawning N agents concurrently produces unique paths and unique nicknames", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const N = 4
        const live = yield* Effect.all(
          Array.from({ length: N }, (_, i) =>
            control.spawnAgent({
              parentID: root.id,
              parentPath: ROOT,
              task_name: `c${i}`,
              initial_message: ".",
            }),
          ),
          { concurrency: "unbounded" },
        )
        const paths = live.map((l) => String(l.metadata.agent_path))
        const nicknames = live.map((l) => l.metadata.agent_nickname)
        expect(new Set(paths).size).toBe(N)
        expect(new Set(nicknames).size).toBe(N)
      }),
    ),
  )

  it.live("concurrent sends to one target enqueue all messages without loss", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "barrage",
          initial_message: "init",
        })
        // Drain the initial.
        yield* control.drainMailbox(child.thread_id)

        const N = 16
        yield* Effect.all(
          Array.from({ length: N }, (_, i) =>
            control.sendInterAgentCommunication(
              child.thread_id,
              new InterAgentCommunication({
                author: ROOT,
                recipient: path("/root/barrage"),
                content: `msg ${i}`,
                trigger_turn: i % 2 === 0,
                sent_at: i,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        )
        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(N)
        const contents = drained.map((c) => c.content).sort()
        const expected = Array.from({ length: N }, (_, i) => `msg ${i}`).sort()
        expect(contents).toEqual(expected)
      }),
    ),
  )

  it.live("closing the parent interrupts mid-running children", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        let interrupted = 0
        yield* control.registerRunLoop(() =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++
              }),
            ),
          ),
        )
        const root = yield* seedRoot()
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "p",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/p"),
          task_name: "c1",
          initial_message: ".",
        })
        yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: path("/root/p"),
          task_name: "c2",
          initial_message: ".",
        })

        yield* Effect.sleep(15)
        yield* control.closeAgent(a.thread_id)
        yield* Effect.sleep(15)
        // p, c1, c2 — three fibers interrupted.
        expect(interrupted).toBe(3)
      }),
    ),
  )
})

describe("AgentControl.hasPendingMailboxItems", () => {
  it.live("reports true when at least one InterAgentCommunication is queued", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "hp",
          initial_message: "queued at spawn",
        })
        const before = yield* control.hasPendingMailboxItems(child.thread_id)
        expect(before).toBe(true)
        yield* control.drainMailbox(child.thread_id)
        const after = yield* control.hasPendingMailboxItems(child.thread_id)
        expect(after).toBe(false)
      }),
    ),
  )

  it.live("reports false for an unknown SessionID (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const out = yield* control.hasPendingMailboxItems(SessionID.descending())
        expect(out).toBe(false)
      }),
    ),
  )
})

// Local helper that mirrors AgentStatus.isFinal — we re-implement here to keep
// tests independent of the module under examination. If this duplicates and
// the implementation drifts, the test fails meaningfully.
function AgentStatusIsFinal(s: import("./status").AgentStatus): boolean {
  if (s === "pending_init" || s === "running" || s === "interrupted") return false
  return true
}

describe("AgentControl error classes", () => {
  it.live("AgentDepthExceededError.message includes both depths", () =>
    Effect.sync(() => {
      const err = new AgentDepthExceededError({ depth: 7, max: 4 })
      expect(err.message).toContain("7")
      expect(err.message).toContain("4")
    }),
  )

  it.live("AgentNotFoundError.message includes the SessionID", () =>
    Effect.sync(() => {
      const sid = SessionID.descending()
      const err = new AgentNotFoundError({ session: sid })
      expect(err.message).toContain(String(sid))
    }),
  )

  it.live("AgentReferenceInvalidError.message includes the reference and the reason", () =>
    Effect.sync(() => {
      const err = new AgentReferenceInvalidError({ reference: "../weird", reason: "escapes root" })
      expect(err.message).toContain("../weird")
      expect(err.message).toContain("escapes root")
    }),
  )
})

describe("AgentControl.onSpawnEvent unsubscribe", () => {
  it.live("the returned unsubscribe stops further events from firing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const events: SpawnEvent[] = []
        const off = yield* control.onSpawnEvent((e) => events.push(e))
        off()

        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "silent",
          initial_message: ".",
        })
        expect(events).toEqual([])
      }),
    ),
  )

  it.live("callback errors do not break the spawn flow", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.onSpawnEvent(() => {
          throw new Error("listener exploded")
        })
        // Spawn must still succeed despite the listener throwing.
        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "resilient",
          initial_message: ".",
        })
        expect(String(live.metadata.agent_path)).toBe("/root/resilient")
      }),
    ),
  )
})

describe("AgentControl run-loop completion", () => {
  it.live("on natural success, status transitions to completed(null)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop(() => Effect.succeed("done"))
        const root = yield* seedRoot()
        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "completes",
          initial_message: ".",
        })
        // Wait for the forked fiber to exit and onExit to run.
        yield* Effect.sleep(20)
        const ref = yield* control.subscribeStatus(live.thread_id)
        const value = yield* SubscriptionRef.get(ref)
        expect(value).toEqual({ completed: null })
      }),
    ),
  )

  it.live("on a typed failure, status transitions to errored(<cause>)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop(() => Effect.die("kaboom"))
        const root = yield* seedRoot()
        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "fails",
          initial_message: ".",
        })
        yield* Effect.sleep(20)
        const ref = yield* control.subscribeStatus(live.thread_id)
        const value = yield* SubscriptionRef.get(ref)
        if (typeof value === "string") {
          throw new Error(`expected struct status, got literal ${value}`)
        }
        expect("errored" in value).toBe(true)
        if ("errored" in value) {
          expect(value.errored).toContain("kaboom")
        }
      }),
    ),
  )
})

describe("AgentControl.closeAgent edge cases", () => {
  it.live("rejects with AgentNotFoundError when the SessionID was never spawned", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const phantom = SessionID.descending()
        const result = yield* Effect.result(control.closeAgent(phantom))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentNotFoundError)
        }
      }),
    ),
  )
})

describe("AgentControl.resolveAgentReference edge cases", () => {
  it.live("rejects when /root is referenced before any registerSessionRoot call", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const control = yield* AgentControl.Service
        // No seedRoot() — root is unregistered.
        const result = yield* Effect.result(control.resolveAgentReference(ROOT, "/root"))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentReferenceInvalidError)
        }
      }),
    ),
  )

  it.live("rejects when the reference itself fails AgentPath validation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const result = yield* Effect.result(control.resolveAgentReference(ROOT, "bad-name"))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentReferenceInvalidError)
        }
      }),
    ),
  )
})

// Sanity: silence unused import warnings if Fiber is referenced only in
// type context. Fiber is imported for type narrowing in some test-only
// rewrites; this no-op keeps the import live.
void Fiber
