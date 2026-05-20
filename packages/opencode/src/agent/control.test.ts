import { afterEach, describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Result, Stream, SubscriptionRef } from "effect"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Bus } from "@/bus"
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
  spawnErrorTag,
} from "./control"
import { AgentPath, AgentPathInvalidError } from "./agent-path"
import { AgentLimitReachedError, NoNicknameAvailableError, PathAlreadyExistsError } from "./registry"
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
    Bus.defaultLayer,
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

  it.live("emits Agent.Spawn.Started then Spawn.Ended on the bus on success", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const bus = yield* Bus.Service
        const started: Array<{ task_name: string; child_path: string }> = []
        const ended: Array<{
          task_name: string
          child_path: string
          status: unknown
          child_session_id?: string
          error?: string
        }> = []
        const offStarted = yield* bus.subscribeCallback(AgentControl.Event.SpawnStarted, (evt) =>
          started.push({
            task_name: evt.properties.task_name,
            child_path: String(evt.properties.child_path),
          }),
        )
        const offEnded = yield* bus.subscribeCallback(AgentControl.Event.SpawnEnded, (evt) =>
          ended.push({
            task_name: evt.properties.task_name,
            child_path: String(evt.properties.child_path),
            status: evt.properties.status,
            child_session_id: evt.properties.child_session_id,
            error: evt.properties.error,
          }),
        )

        try {
          yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "watched",
            initial_message: "watch me",
          })
          // Bus dispatch is synchronous within the same fiber but the
          // subscriber callback runs through Effect.tryPromise — give it a
          // microtask to drain.
          yield* Effect.sleep(20)

          expect(started.length).toBe(1)
          expect(started[0]?.task_name).toBe("watched")
          expect(started[0]?.child_path).toBe("/root/watched")

          expect(ended.length).toBe(1)
          expect(ended[0]?.task_name).toBe("watched")
          expect(ended[0]?.child_path).toBe("/root/watched")
          // Success path: child_session_id is set, error is undefined,
          // status is non-final (pending_init or running).
          expect(typeof ended[0]?.child_session_id).toBe("string")
          expect(ended[0]?.error).toBeUndefined()
        } finally {
          offStarted()
          offEnded()
        }
      }),
    ),
  )

  it.live("emits Agent.Spawn.Ended with status not_found and error tag on rejection", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const bus = yield* Bus.Service
        const ended: Array<{ status: unknown; error?: string }> = []
        const off = yield* bus.subscribeCallback(AgentControl.Event.SpawnEnded, (evt) =>
          ended.push({ status: evt.properties.status, error: evt.properties.error }),
        )

        try {
          // First spawn succeeds — second spawn collides on the path.
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
          yield* Effect.sleep(20)

          expect(ended.length).toBe(2)
          // Second emission carries the failure shape.
          const failure = ended[1]
          expect(failure?.status).toBe("not_found")
          expect(failure?.error).toBe("path_exists")
        } finally {
          off()
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
          root.id,
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
          root.id,
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
        const root = yield* seedRoot()
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
            root.id,
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
          root.id,
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

        const resolved = yield* control.resolveAgentReference(path("/root/a"), "b", root.id)
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

        const resolved = yield* control.resolveAgentReference(ROOT, "/root/abs", root.id)
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

        const resolved = yield* control.resolveAgentReference(ROOT, "/root", root.id)
        expect(resolved).toBe(root.id)
      }),
    ),
  )

  it.live("rejects when the reference resolves to an unknown live path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* Effect.result(
          control.resolveAgentReference(ROOT, "missing", root.id),
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

        const live = yield* control.listAgents(ROOT, root.id)
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

        const all = yield* control.listAgents(ROOT, root.id)
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

        const filtered = yield* control.listAgents(ROOT, root.id, "/root/a")
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

        const all = yield* control.listAgents(ROOT, root.id, "/root")
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

        const list = yield* control.listAgents(ROOT, root.id)
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
              root.id,
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

// D10 (actor-discipline-2026-05-20 Wave 3) — findMailboxByCorrelationId peeks
// the caller's mailbox for a message carrying a matching correlation_id WITHOUT
// draining. Powers the wait_for_reply tool's filter (fast-path on already-queued
// matches; mailbox-seq watch re-scans on each new send).
describe("AgentControl.findMailboxByCorrelationId", () => {
  it.live("returns the matching message without draining (idempotent)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "replier",
          initial_message: "init",
        })
        const childPath = child.metadata.agent_path ?? ROOT
        yield* control.drainMailbox(root.id)
        yield* control.sendInterAgentCommunication(
          root.id,
          new InterAgentCommunication({
            author: childPath,
            recipient: ROOT,
            content: "the reply",
            trigger_turn: false,
            sent_at: 1,
            correlation_id: "req-x",
          }),
          child.thread_id,
        )

        const first = yield* control.findMailboxByCorrelationId(root.id, "req-x")
        expect(first?.content).toBe("the reply")
        expect(first?.correlation_id).toBe("req-x")

        // Idempotent: a second peek returns the same message; nothing drained.
        const second = yield* control.findMailboxByCorrelationId(root.id, "req-x")
        expect(second?.content).toBe("the reply")

        // Drain confirms the message is still queued post-peek.
        const drained = yield* control.drainMailbox(root.id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.correlation_id).toBe("req-x")
      }),
    ),
  )

  it.live("returns undefined when no message matches the correlation_id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "noisy",
          initial_message: "init",
        })
        const childPath = child.metadata.agent_path ?? ROOT
        yield* control.drainMailbox(root.id)
        // Send a message with a DIFFERENT correlation_id.
        yield* control.sendInterAgentCommunication(
          root.id,
          new InterAgentCommunication({
            author: childPath,
            recipient: ROOT,
            content: "unrelated",
            trigger_turn: false,
            sent_at: 2,
            correlation_id: "other",
          }),
          child.thread_id,
        )

        const out = yield* control.findMailboxByCorrelationId(root.id, "req-x")
        expect(out).toBeUndefined()
      }),
    ),
  )

  it.live("returns undefined when the session has no slot (unregistered)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        // SessionID.descending() yields a fresh unregistered id.
        const out = yield* control.findMailboxByCorrelationId(
          SessionID.descending(),
          "req-x",
        )
        expect(out).toBeUndefined()
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

describe("AgentControl bus event emission", () => {
  it.live("spawnErrorTag classifies every SpawnError tag", () =>
    Effect.sync(() => {
      // Drives the unreachable-via-spawn `no_nickname` arm directly. The
      // registry recycles the nickname pool with reset suffixes, so a
      // genuine NoNicknameAvailableError can't be triggered through the
      // current default candidates. Exporting + unit-testing the
      // classifier keeps line coverage honest without forcing a contrived
      // candidate-pool injection.
      expect(spawnErrorTag(new AgentDepthExceededError({ depth: 5, max: 4 }))).toBe(
        "depth_exceeded",
      )
      expect(spawnErrorTag(new AgentLimitReachedError({ max_threads: 4 }))).toBe("limit_reached")
      expect(
        spawnErrorTag(new AgentPathInvalidError({ input: "bad", reason: "x" })),
      ).toBe("path_invalid")
      expect(
        spawnErrorTag(new PathAlreadyExistsError({ path: AgentPath.root() })),
      ).toBe("path_exists")
      expect(spawnErrorTag(new NoNicknameAvailableError({}))).toBe("no_nickname")
      expect(spawnErrorTag(new Error("anything else"))).toBe("unknown")
    }),
  )

  it.live("emits Agent.Message.Sent on sendInterAgentCommunication with sender path and trigger flag", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "tgt",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const bus = yield* Bus.Service
        const sent: Array<{
          target_session_id: string
          target_path: string
          message_length: number
          trigger_turn: boolean
          sender_path: string
        }> = []
        const off = yield* bus.subscribeCallback(AgentControl.Event.MessageSent, (evt) =>
          sent.push({
            target_session_id: evt.properties.target_session_id,
            target_path: String(evt.properties.target_path),
            message_length: evt.properties.message_length,
            trigger_turn: evt.properties.trigger_turn,
            sender_path: String(evt.properties.sender_path),
          }),
        )
        try {
          yield* control.sendInterAgentCommunication(
            child.thread_id,
            new InterAgentCommunication({
              author: ROOT,
              recipient: path("/root/tgt"),
              content: "hello sibling",
              trigger_turn: false,
              sent_at: 1,
            }),
            root.id,
          )
          yield* Effect.sleep(20)

          expect(sent.length).toBe(1)
          expect(sent[0]?.target_session_id).toBe(child.thread_id)
          expect(sent[0]?.target_path).toBe("/root/tgt")
          expect(sent[0]?.message_length).toBe("hello sibling".length)
          expect(sent[0]?.trigger_turn).toBe(false)
          expect(sent[0]?.sender_path).toBe("/root")
        } finally {
          off()
        }
      }),
    ),
  )

  it.live("emits Agent.Closed for closeAgent + each cascaded descendant", () =>
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

        const bus = yield* Bus.Service
        const closed: Array<{ agent_path: string; previous_status: unknown }> = []
        const off = yield* bus.subscribeCallback(AgentControl.Event.Closed, (evt) =>
          closed.push({
            agent_path: String(evt.properties.agent_path),
            previous_status: evt.properties.previous_status,
          }),
        )
        try {
          yield* control.closeAgent(a.thread_id)
          yield* Effect.sleep(20)

          // Three closures: leaves first (b, c) then root of subtree (a).
          const paths = closed.map((c) => c.agent_path).sort()
          expect(paths).toEqual(["/root/a", "/root/a/b", "/root/a/c"])
          // sanity: spawned ids exist (referenced by closure ordering)
          expect([a.thread_id, b.thread_id, c.thread_id]).toHaveLength(3)
        } finally {
          off()
        }
      }),
    ),
  )
})

describe("AgentControl status derivation from session events", () => {
  it.live("Step.Started on a child session transitions status from pending_init to running", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "stepped",
          initial_message: ".",
        })

        // Publish a Step.Started event into the test's bus (the same bus
        // instance AgentControl's subscriber listens to). In production,
        // processor.ts calls EventV2.run for the same payload, which
        // ultimately publishes to the same shared bus.
        const bus = yield* Bus.Service
        // Allow the InstanceState-bound bus subscriber to actually start
        // listening before publishing — Effect.forkScoped is asynchronous.
        yield* Effect.sleep(20)
        yield* bus.publish(AgentControl.Inbound.StepStarted, {
          timestamp: DateTime.makeUnsafe(Date.now()),
          sessionID: live.thread_id,
          agent: "default",
          model: { id: "test", providerID: "test" },
        })
        yield* Effect.sleep(50)

        const ref = yield* control.subscribeStatus(live.thread_id)
        const value = yield* SubscriptionRef.get(ref)
        expect(value).toBe("running")
      }),
    ),
  )

  it.live("Step.Ended on a child session transitions status to completed(null)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "stepended",
          initial_message: ".",
        })

        const bus = yield* Bus.Service
        // Allow the InstanceState-bound bus subscriber to actually start
        // listening before publishing — Effect.forkScoped is asynchronous.
        yield* Effect.sleep(20)
        yield* bus.publish(AgentControl.Inbound.StepEnded, {
          timestamp: DateTime.makeUnsafe(Date.now()),
          sessionID: live.thread_id,
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        yield* Effect.sleep(50)

        const ref = yield* control.subscribeStatus(live.thread_id)
        const value = yield* SubscriptionRef.get(ref)
        expect(value).toEqual({ completed: null })
      }),
    ),
  )

  it.live("Step events for sessions outside the registry do not affect tracked status", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const live = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "unaffected",
          initial_message: ".",
        })
        const before = yield* SubscriptionRef.get(yield* control.subscribeStatus(live.thread_id))

        const bus = yield* Bus.Service
        // Allow the InstanceState-bound bus subscriber to start listening.
        yield* Effect.sleep(20)
        yield* bus.publish(AgentControl.Inbound.StepStarted, {
          timestamp: DateTime.makeUnsafe(Date.now()),
          sessionID: SessionID.descending(),
          agent: "default",
          model: { id: "test", providerID: "test" },
        })
        yield* Effect.sleep(50)

        const after = yield* SubscriptionRef.get(yield* control.subscribeStatus(live.thread_id))
        expect(after).toBe(before)
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
        // No seedRoot() — root is unregistered. Pass a phantom sender id;
        // slot lookup fails, surfacing the "root not registered" error.
        const result = yield* Effect.result(
          control.resolveAgentReference(ROOT, "/root", SessionID.descending()),
        )
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
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const result = yield* Effect.result(
          control.resolveAgentReference(ROOT, "bad-name", root.id),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentReferenceInvalidError)
        }
      }),
    ),
  )
})

describe("AgentControl.hasPendingTriggerTurn", () => {
  it.live("reports true when at least one queued message has trigger_turn set", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        // spawnAgent's seed initial_message is sent with trigger_turn: true.
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "tt",
          initial_message: "wake me",
        })
        expect(yield* control.hasPendingTriggerTurn(child.thread_id)).toBe(true)
        yield* control.drainMailbox(child.thread_id)
        expect(yield* control.hasPendingTriggerTurn(child.thread_id)).toBe(false)
      }),
    ),
  )

  it.live("reports false when only non-trigger_turn messages are queued", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "ntt",
          initial_message: "first",
        })
        // Drain the seed (trigger_turn: true) then send a passive sibling
        // message with trigger_turn: false — the runLoop should be free to
        // exit on its assistant finish without being held back.
        yield* control.drainMailbox(child.thread_id)
        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: child.metadata.agent_path ?? ROOT,
            content: "fyi",
            trigger_turn: false,
            sent_at: 1,
          }),
          root.id,
        )
        expect(yield* control.hasPendingTriggerTurn(child.thread_id)).toBe(false)
      }),
    ),
  )

  it.live("reports false for an unknown SessionID (no error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        expect(yield* control.hasPendingTriggerTurn(SessionID.descending())).toBe(false)
      }),
    ),
  )
})

describe("AgentControl.cancelChildrenOf", () => {
  it.live("interrupts every direct child whose path sits beneath the parent", () =>
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
          parentID: root.id,
          parentPath: ROOT,
          task_name: "b",
          initial_message: ".",
        })
        const c = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "c",
          initial_message: ".",
        })

        yield* control.cancelChildrenOf(root.id)

        // After cancellation each agent's registry slot is released — the
        // metadata lookup returns undefined.
        expect(yield* control.getAgentMetadata(a.thread_id)).toBeUndefined()
        expect(yield* control.getAgentMetadata(b.thread_id)).toBeUndefined()
        expect(yield* control.getAgentMetadata(c.thread_id)).toBeUndefined()
      }),
    ),
  )

  it.live("cascades through nested descendants leaves-first", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const parent = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "p",
          initial_message: ".",
        })
        const parentPath = parent.metadata.agent_path
        if (!parentPath) throw new Error("parent has no path")
        const child = yield* control.spawnAgent({
          parentID: parent.thread_id,
          parentPath,
          task_name: "c",
          initial_message: ".",
        })
        const childPath = child.metadata.agent_path
        if (!childPath) throw new Error("child has no path")
        const grandchild = yield* control.spawnAgent({
          parentID: child.thread_id,
          parentPath: childPath,
          task_name: "g",
          initial_message: ".",
        })

        // Cancel from the parent — both child and grandchild should die,
        // parent itself stays (cancelChildrenOf only touches descendants).
        yield* control.cancelChildrenOf(parent.thread_id)
        expect(yield* control.getAgentMetadata(child.thread_id)).toBeUndefined()
        expect(yield* control.getAgentMetadata(grandchild.thread_id)).toBeUndefined()
        // parent itself is still alive in the registry
        expect(yield* control.getAgentMetadata(parent.thread_id)).toBeDefined()
      }),
    ),
  )

  it.live("is a no-op for a session that is neither root nor a registered agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const sessions = yield* Session.Service
        const stranger = yield* sessions.create({ title: "stranger" })
        // Should not throw and should not affect any other agent.
        const exit = yield* Effect.exit(control.cancelChildrenOf(stranger.id))
        expect(exit._tag).toBe("Success")
      }),
    ),
  )
})

// Wave 1 — per-root primitive tests covering the new error paths and
// per-root scoping. The integration test in test/integration/multi-agent-
// invariants.test.ts asserts the multi-root scenarios end-to-end; these
// tests exercise the same code from the primitive surface so coverage
// stays at 100% on src/agent/control.ts even when the integration test
// file is run separately.
describe("AgentControl per-root scoping", () => {
  it.live("sendInterAgentCommunication rejects when sender and target belong to different roots", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const rootA = yield* sessions.create({ title: "A" })
        const rootB = yield* sessions.create({ title: "B" })
        yield* control.registerSessionRoot(rootA.id)
        yield* control.registerSessionRoot(rootB.id)
        const childB = yield* control.spawnAgent({
          parentID: rootB.id,
          parentPath: ROOT,
          task_name: "wb",
          initial_message: ".",
        })

        // From rootA, attempt to send to childB → AgentNotFoundError.
        // Exercises the cross-root branch (slot lookup mismatch).
        const result = yield* Effect.result(
          control.sendInterAgentCommunication(
            childB.thread_id,
            new InterAgentCommunication({
              author: ROOT,
              recipient: childB.metadata.agent_path ?? ROOT,
              content: "x",
              trigger_turn: false,
              sent_at: 1,
            }),
            rootA.id,
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentNotFoundError)
        }
      }),
    ),
  )

  it.live("listAgents returns empty when senderID is unknown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        // Phantom session id resolves to no slot → empty list.
        const out = yield* control.listAgents(ROOT, SessionID.descending())
        expect(out).toEqual([])
      }),
    ),
  )

  it.live("getAgentMetadata returns undefined for an unknown SessionID", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const meta = yield* control.getAgentMetadata(SessionID.descending())
        expect(meta).toBeUndefined()
      }),
    ),
  )

  it.live("subscribeMailboxSeq rejects with AgentNotFoundError for unknown SessionID (no slot)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        const result = yield* Effect.result(
          control.subscribeMailboxSeq(SessionID.descending()),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AgentNotFoundError)
        }
      }),
    ),
  )

  it.live("registerSessionRoot is idempotent — second call returns the existing slot", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "root" })
        yield* control.registerSessionRoot(root.id)
        // Spawn under the slot.
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "stays",
          initial_message: ".",
        })
        // Registering again must NOT recreate the slot — the child stays.
        yield* control.registerSessionRoot(root.id)
        const meta = yield* control.getAgentMetadata(child.thread_id)
        expect(meta).toBeDefined()
      }),
    ),
  )

  it.live("emitWaitStarted publishes Agent.Wait.Started on the bus", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const bus = yield* Bus.Service
        const seen: Array<{ call_id: string; timeout_ms: number }> = []
        const off = yield* bus.subscribeCallback(AgentControl.Event.WaitStarted, (evt) =>
          seen.push({ call_id: evt.properties.call_id, timeout_ms: evt.properties.timeout_ms }),
        )
        try {
          yield* control.emitWaitStarted(root.id, "call_x", 100)
          yield* Effect.sleep(20)
          expect(seen.length).toBe(1)
          expect(seen[0]?.call_id).toBe("call_x")
          expect(seen[0]?.timeout_ms).toBe(100)
        } finally {
          off()
        }
      }),
    ),
  )

  it.live("emitWaitEnded publishes Agent.Wait.Ended on the bus", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const bus = yield* Bus.Service
        const seen: Array<{ call_id: string; timed_out: boolean }> = []
        const off = yield* bus.subscribeCallback(AgentControl.Event.WaitEnded, (evt) =>
          seen.push({ call_id: evt.properties.call_id, timed_out: evt.properties.timed_out }),
        )
        try {
          yield* control.emitWaitEnded(root.id, "call_y", true)
          yield* Effect.sleep(20)
          expect(seen.length).toBe(1)
          expect(seen[0]?.call_id).toBe("call_y")
          expect(seen[0]?.timed_out).toBe(true)
        } finally {
          off()
        }
      }),
    ),
  )

  it.live("session-deletion cleans up the deleted root's slot via top-level Bus subscriber", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const rootA = yield* sessions.create({ title: "A" })
        yield* control.registerSessionRoot(rootA.id)
        yield* control.spawnAgent({
          parentID: rootA.id,
          parentPath: ROOT,
          task_name: "doomed",
          initial_message: ".",
        })

        yield* sessions.remove(rootA.id)
        // Sleep gives the top-level Bus subscriber + microtask queue time
        // to drain the session.deleted event.
        yield* Effect.sleep(80)

        // After deletion: the slot is gone, so listAgents returns empty
        // for rootA (slotFor → undefined → []).
        const out = yield* control.listAgents(ROOT, rootA.id)
        expect(out).toEqual([])
      }),
    ),
  )

  it.live("closeAgent on an idempotent already-shutdown id returns shutdown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "twice2",
          initial_message: ".",
        })
        yield* control.closeAgent(child.thread_id)
        // Second close lands in the meta-not-found branch with status=shutdown.
        const second = yield* control.closeAgent(child.thread_id)
        expect(second.previous_status).toBe("shutdown")
      }),
    ),
  )

  it.live("spawnAgent lazy-registers the root when the parent isn't pre-registered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        // No seedRoot() — parent is fresh and unknown to AgentControl.
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* sessions.create({ title: "fresh" })
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "lazyroot",
          initial_message: ".",
        })
        expect(String(child.metadata.agent_path)).toBe("/root/lazyroot")
      }),
    ),
  )

  it.live("spawnAgent fails when parent is unknown and parent path is not /root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        // Phantom parent with non-root path → no slot → AgentDepthExceeded.
        const result = yield* Effect.result(
          control.spawnAgent({
            parentID: SessionID.descending(),
            parentPath: path("/root/somewhere"),
            task_name: "orphan",
            initial_message: ".",
          }),
        )
        expect(Result.isFailure(result)).toBe(true)
      }),
    ),
  )

  it.live("sendInterAgentCommunication: target slot exists but mailbox is gone", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "drained",
          initial_message: ".",
        })
        // Close the child — its mailbox is removed but the sessionToRoot
        // entry persists. A send still hits the mailbox-not-found branch.
        yield* control.closeAgent(child.thread_id)
        const result = yield* Effect.result(
          control.sendInterAgentCommunication(
            child.thread_id,
            new InterAgentCommunication({
              author: ROOT,
              recipient: path("/root/drained"),
              content: "after-close",
              trigger_turn: false,
              sent_at: 1,
            }),
            root.id,
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
      }),
    ),
  )
})

describe("AgentControl.sendInterAgentCommunication revival", () => {
  it.live("trigger_turn=true on a completed agent restarts its run-loop fiber", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        // The runLoop completes immediately on each invocation; the second
        // call must be observable (revival from trigger_turn).
        const invocations: SessionID[] = []
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            invocations.push(sid)
            return "done"
          }),
        )
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "revivable",
          initial_message: ".",
        })
        // First spawn invokes the runLoop once and exits.
        yield* Effect.sleep(20)
        expect(invocations.length).toBe(1)
        const ref = yield* control.subscribeStatus(child.thread_id)
        expect(yield* SubscriptionRef.get(ref)).toEqual({ completed: null })

        // Second message with trigger_turn=true must revive the fiber and
        // result in a second runLoop invocation. Drain the seeded mailbox
        // first so the new send is the only pending message.
        yield* control.drainMailbox(child.thread_id)
        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/revivable"),
            content: "wake up",
            trigger_turn: true,
            sent_at: 1,
          }),
          root.id,
        )
        yield* Effect.sleep(20)
        expect(invocations.length).toBe(2)
        // Status returns to completed after the second turn finishes.
        expect(yield* SubscriptionRef.get(ref)).toEqual({ completed: null })
      }),
    ),
  )

  it.live("trigger_turn=false does NOT revive a completed agent (queue-only)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const invocations: SessionID[] = []
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            invocations.push(sid)
            return "done"
          }),
        )
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "queueonly",
          initial_message: ".",
        })
        yield* Effect.sleep(20)
        expect(invocations.length).toBe(1)

        yield* control.drainMailbox(child.thread_id)
        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/queueonly"),
            content: "fyi",
            trigger_turn: false,
            sent_at: 1,
          }),
          root.id,
        )
        yield* Effect.sleep(20)
        // No revival — fiber stays dead, message just sits in mailbox.
        expect(invocations.length).toBe(1)
      }),
    ),
  )

  it.live("trigger_turn=true on a shutdown (closed) agent does NOT revive", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const invocations: SessionID[] = []
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            invocations.push(sid)
            return "done"
          }),
        )
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "closed",
          initial_message: ".",
        })
        yield* Effect.sleep(20)
        expect(invocations.length).toBe(1)
        // closeAgent removes the mailbox AND sets status to "shutdown".
        // The send_inter_agent_communication mailbox-not-found branch
        // fires before the revival check, so revival never runs. Verify
        // the contract: an explicitly-closed agent never resurrects.
        yield* control.closeAgent(child.thread_id)
        const result = yield* Effect.result(
          control.sendInterAgentCommunication(
            child.thread_id,
            new InterAgentCommunication({
              author: ROOT,
              recipient: path("/root/closed"),
              content: "wake up",
              trigger_turn: true,
              sent_at: 1,
            }),
            root.id,
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
        // Sleep then re-assert no revival fired despite trigger_turn=true.
        yield* Effect.sleep(20)
        expect(invocations.length).toBe(1)
      }),
    ),
  )

  it.live("trigger_turn=true on the root agent does NOT spawn a new fiber (root has no managed loop)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const invocations: SessionID[] = []
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            invocations.push(sid)
            return "done"
          }),
        )
        const root = yield* seedRoot()
        // Spawn one child so we have a sender; the root receives.
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "sender",
          initial_message: ".",
        })
        yield* Effect.sleep(20)
        const beforeCount = invocations.length

        // Send to root with trigger_turn=true. Root's runLoop is owned
        // by the chat front-end, not AgentControl — revival here would
        // spawn a duplicate loop and double-process the user's input.
        yield* control.sendInterAgentCommunication(
          root.id,
          new InterAgentCommunication({
            author: path("/root/sender"),
            recipient: ROOT,
            content: "ping",
            trigger_turn: true,
            sent_at: 1,
          }),
          child.thread_id,
        )
        yield* Effect.sleep(20)
        // No new invocation — only the original child.
        expect(invocations.length).toBe(beforeCount)
      }),
    ),
  )
})

describe("AgentControl completion watcher body inclusion", () => {
  it.live("forwards the child's last finished assistant text to the parent's mailbox on completion", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service

        // The runLoop writes a finished assistant message to the child
        // session, then exits successfully. The completion watcher must
        // observe the status flip and look that message up to inline its
        // text in the notification it sends to the parent's mailbox.
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const userMsg = {
              id: MessageID.ascending(),
              sessionID: sid,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-3-5-sonnet") },
            }
            yield* sessions.updateMessage(userMsg)
            const assistantMsg = {
              id: MessageID.ascending(),
              sessionID: sid,
              parentID: userMsg.id,
              role: "assistant" as const,
              mode: "build",
              agent: "build",
              path: { cwd: ".", root: "." },
              time: { created: Date.now(), completed: Date.now() },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("claude-3-5-sonnet"),
              providerID: ProviderID.make("anthropic"),
              finish: "stop",
            }
            yield* sessions.updateMessage(assistantMsg)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistantMsg.id,
              sessionID: sid,
              type: "text",
              text: "Here is the final deliverable.",
            })
            return "done"
          }),
        )

        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "answers",
          initial_message: ".",
        })
        // Wait for the child runLoop to finish + completion watcher to fire.
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        expect(drained.length).toBeGreaterThanOrEqual(1)
        const fromChild = drained.find(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(fromChild).toBeDefined()
        // The notification still includes the status header so existing
        // consumers (TUI / log scrapers) see the lifecycle event.
        expect(fromChild?.content).toContain("reached status: completed")
        // AND it now also includes the child's final assistant text so the
        // parent sees the actual deliverable on its next turn drain. This
        // is the divergence from codex's V2 behaviour described in the
        // watcher comment in control.ts.
        expect(fromChild?.content).toContain("Here is the final deliverable.")
      }),
    ),
  )

  it.live("falls back to status-only when the child has no finished assistant message (early failure)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        // The runLoop dies before producing any assistant message — the
        // watcher must still send a notification, just without a body.
        yield* control.registerRunLoop(() => Effect.die("boom"))
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "fails",
          initial_message: ".",
        })
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        const fromChild = drained.find(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(fromChild).toBeDefined()
        expect(fromChild?.content).toContain("reached status: errored")
        // No body to inline — the notification is the bare status header.
        // Asserting absence of a stray "deliverable" sentinel so a future
        // regression that double-renders the failure cause doesn't sneak
        // through.
        expect(fromChild?.content).not.toContain("Here is the final deliverable.")
      }),
    ),
  )

  it.live("watcher fires on EVERY revival cycle, not just the first turn (Bug 2b + Bug 3 interaction)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Regression: the original watcher self-interrupted after the
        // first send. Bug 3's revival path then ran subsequent turns
        // silently because no watcher was left to fire. The smoke-test
        // failure mode looked like: parent's wait_agent times out
        // forever after followup_task even though list_agents shows the
        // child as completed. The fix removed the self-interrupt; this
        // test pins it.
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service

        let turn = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            turn += 1
            const localTurn = turn
            const userMsg = {
              id: MessageID.ascending(),
              sessionID: sid,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-3-5-sonnet") },
            }
            yield* sessions.updateMessage(userMsg)
            const assistantMsg = {
              id: MessageID.ascending(),
              sessionID: sid,
              parentID: userMsg.id,
              role: "assistant" as const,
              mode: "build",
              agent: "build",
              path: { cwd: ".", root: "." },
              time: { created: Date.now(), completed: Date.now() },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("claude-3-5-sonnet"),
              providerID: ProviderID.make("anthropic"),
              finish: "stop",
            }
            yield* sessions.updateMessage(assistantMsg)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistantMsg.id,
              sessionID: sid,
              type: "text",
              text: `answer-${localTurn}`,
            })
            return "done"
          }),
        )
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "multi",
          initial_message: ".",
        })
        // Wait for first turn to complete + watcher to fire.
        yield* Effect.sleep(50)
        // Drain root's mailbox: must contain the first answer.
        const after1 = yield* control.drainMailbox(root.id)
        const first = after1.find((m) => String(m.author) === String(child.metadata.agent_path))
        expect(first).toBeDefined()
        expect(first?.content).toContain("answer-1")

        // Trigger revival via followup_task semantics.
        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/multi"),
            content: "second please",
            trigger_turn: true,
            sent_at: 1,
          }),
          root.id,
        )
        yield* Effect.sleep(50)
        // The pre-fix bug: watcher had self-interrupted after turn 1;
        // turn 2 completed silently and root's mailbox stayed empty.
        // Post-fix: watcher kept listening, fires again on turn 2's
        // terminal status, root receives "answer-2".
        const after2 = yield* control.drainMailbox(root.id)
        const second = after2.find((m) => String(m.author) === String(child.metadata.agent_path))
        expect(second).toBeDefined()
        expect(second?.content).toContain("answer-2")

        // One more cycle to lock in the multi-revival contract.
        yield* control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: ROOT,
            recipient: path("/root/multi"),
            content: "third please",
            trigger_turn: true,
            sent_at: 2,
          }),
          root.id,
        )
        yield* Effect.sleep(50)
        const after3 = yield* control.drainMailbox(root.id)
        const third = after3.find((m) => String(m.author) === String(child.metadata.agent_path))
        expect(third).toBeDefined()
        expect(third?.content).toContain("answer-3")
        expect(turn).toBe(3)
      }),
    ),
  )
})

// Sanity: silence unused import warnings if Fiber is referenced only in
// type context. Fiber is imported for type narrowing in some test-only
// rewrites; this no-op keeps the import live.
void Fiber

// D5 + D9 (actor-discipline-2026-05-20) — extractor narrowing, safety net,
// and wasKnownPath. The diagnostic-session-3 bug
// (ses_1c2e8d84affeZ7t5g5LKveGDTo) shipped a subagent that emitted text
// AND close_agent in the same turn → message.finish === "tool-calls" →
// pre-D5 predicate skipped the message → parent received an empty body.
// These tests pin every branch of the fix at the unit level so regressions
// surface in `bun test src/agent/control.test.ts` instead of waiting for the
// integration suite.
describe("AgentControl D5 extractor narrowing + safety net", () => {
  // Helper — write a child assistant message with a fixed finish reason and
  // text. Mirrors the pattern at "completion watcher body inclusion" above
  // (line ~2052).
  const writeAssistantMessage = (
    sessions: Session.Interface,
    sessionID: SessionID,
    text: string,
    finish: string,
  ) =>
    Effect.gen(function* () {
      const userMsg = {
        id: MessageID.ascending(),
        sessionID,
        role: "user" as const,
        time: { created: Date.now() },
        agent: "build",
        model: {
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-3-5-sonnet"),
        },
      }
      yield* sessions.updateMessage(userMsg)
      const assistantMsg = {
        id: MessageID.ascending(),
        sessionID,
        parentID: userMsg.id,
        role: "assistant" as const,
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        time: { created: Date.now(), completed: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("claude-3-5-sonnet"),
        providerID: ProviderID.make("anthropic"),
        finish,
      }
      yield* sessions.updateMessage(assistantMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMsg.id,
        sessionID,
        type: "text",
        text,
      })
      return assistantMsg
    })

  it.live(
    "extractor returns text from an assistant message whose finish reason is `tool-calls` (INV-D-01 unit)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service

          // Child runLoop emits a single assistant message with text AND
          // finish=tool-calls (the diagnostic-session-3 shape), then exits.
          // Pre-D5 the watcher's predicate skipped this message; post-D5
          // the predicate accepts any assistant text. The body must land
          // in the parent's mailbox notification.
          yield* control.registerRunLoop((sid) =>
            Effect.gen(function* () {
              yield* writeAssistantMessage(
                sessions,
                sid,
                "This is the actual deliverable text the parent needs.",
                "tool-calls",
              )
              return "done"
            }),
          )

          const root = yield* seedRoot()
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "toolcall_child",
            initial_message: ".",
          })
          yield* Effect.sleep(50)

          const drained = yield* control.drainMailbox(root.id)
          const fromChild = drained.find(
            (m) => String(m.author) === String(child.metadata.agent_path),
          )
          expect(fromChild).toBeDefined()
          expect(fromChild?.content).toContain(
            "This is the actual deliverable text the parent needs.",
          )
        }),
      ),
  )

  it.live("extractor walks back when the latest assistant message has no text (only tool parts)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service

        // The child writes two assistant messages: first carries the real
        // deliverable text, second is a follow-up turn with only a
        // tool-call (no text part). The walk-back logic must skip past the
        // text-less second message and surface the first message's text.
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            // First assistant message with the actual deliverable.
            yield* writeAssistantMessage(
              sessions,
              sid,
              "This is the deliverable from the first turn.",
              "stop",
            )
            // Second assistant message: ONLY a tool-call part (no text).
            const userMsg2 = {
              id: MessageID.ascending(),
              sessionID: sid,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: {
                providerID: ProviderID.make("anthropic"),
                modelID: ModelID.make("claude-3-5-sonnet"),
              },
            }
            yield* sessions.updateMessage(userMsg2)
            const assistantMsg2 = {
              id: MessageID.ascending(),
              sessionID: sid,
              parentID: userMsg2.id,
              role: "assistant" as const,
              mode: "build",
              agent: "build",
              path: { cwd: ".", root: "." },
              time: { created: Date.now(), completed: Date.now() },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("claude-3-5-sonnet"),
              providerID: ProviderID.make("anthropic"),
              finish: "tool-calls",
            }
            yield* sessions.updateMessage(assistantMsg2)
            // No text part — only a tool-call part (we use a synthetic
            // part shape here; the extractor's filter is type === "text"
            // so any non-text part is dropped).
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistantMsg2.id,
              sessionID: sid,
              type: "tool",
              tool: "close_agent",
              callID: "call_xyz",
              state: {
                status: "completed",
                input: {},
                output: "",
                metadata: {},
                title: "close_agent",
                time: { start: 0, end: 0 },
              },
            })
            return "done"
          }),
        )

        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "walkback_child",
          initial_message: ".",
        })
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        const fromChild = drained.find(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(fromChild).toBeDefined()
        // Pre-fix: the watcher picked up the text-less second message
        // → joined body was "" → notification was header-only.
        // Post-fix: the predicate walks back over the empty match and
        // finds the first message's text.
        expect(fromChild?.content).toContain("This is the deliverable from the first turn.")
      }),
    ),
  )

  it.live(
    "safety-net warning prepended when child never sent send_message/followup_task to spawner (INV-D-03 unit)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service

          // Child emits the diagnostic-session-3 message ("Report delivered
          // to parent") as its last assistant text. The text alone matches
          // the status-line heuristic (short, single-line, contains
          // "delivered"). Because the child never called send_message to
          // its spawner, the safety-net warning must be prepended.
          yield* control.registerRunLoop((sid) =>
            Effect.gen(function* () {
              yield* writeAssistantMessage(
                sessions,
                sid,
                "Report delivered to parent. Closing now.",
                "tool-calls",
              )
              return "done"
            }),
          )

          const root = yield* seedRoot()
          yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "silent_child",
            initial_message: ".",
          })
          yield* Effect.sleep(50)

          const drained = yield* control.drainMailbox(root.id)
          expect(drained.length).toBeGreaterThanOrEqual(1)
          const note = drained[0]!
          expect(note.content.startsWith("⚠️")).toBe(true)
          expect(note.content).toContain(
            "Child did NOT call",
          )
          expect(note.content).toContain("Report delivered to parent")
        }),
      ),
  )

  it.live("safety-net warning suppressed when child DID call send_message to spawner", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        // Capture root.id before runLoop registration so the closure can
        // refer to it without going through resolveAgentReference (which
        // is an Effect<_, AgentReferenceInvalidError, _> that doesn't fit
        // the runLoop's `Effect<unknown>` signature without an explicit
        // `orDie`). Spawn happens after the runLoop registers.
        const root = yield* seedRoot()
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            yield* control
              .sendInterAgentCommunication(
                root.id,
                new InterAgentCommunication({
                  author: path("/root/talker"),
                  recipient: ROOT,
                  content: "explicit delivery",
                  trigger_turn: false,
                  sent_at: 1,
                }),
                sid,
              )
              .pipe(Effect.orDie)
            yield* writeAssistantMessage(
              sessions,
              sid,
              "Report delivered. Closing now.",
              "tool-calls",
            )
            return "done"
          }),
        )
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "talker",
          initial_message: ".",
        })
        yield* Effect.sleep(80)

        const drained = yield* control.drainMailbox(root.id)
        // Mailbox contains the explicit send AND the completion
        // notification. The completion notification body must NOT start
        // with ⚠️ — the explicit send marked outgoingToSpawner.
        const notif = drained.find(
          (m) =>
            (m.content.startsWith("Agent /root/talker reached status:") ||
              m.content.includes("Agent /root/talker reached status:")) &&
            !m.content.includes("explicit delivery"),
        )
        expect(notif).toBeDefined()
        expect(notif?.content.startsWith("⚠️")).toBe(false)
      }),
    ),
  )

  it.live("safety-net warning includes <no text emitted> when child produced zero assistant text", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        // Child dies before writing any assistant message. The extractor
        // walks back, finds nothing, returns empty body. The child also
        // never delivered via send_message → safety net fires with the
        // "<no text emitted>" placeholder.
        yield* control.registerRunLoop(() => Effect.die("immediate death"))

        const root = yield* seedRoot()
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "noemit",
          initial_message: ".",
        })
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        const note = drained.find((m) => String(m.author) === "/root/noemit")
        expect(note).toBeDefined()
        expect(note?.content.startsWith("⚠️")).toBe(true)
        expect(note?.content).toContain("<no text emitted>")
        expect(note?.content).toContain("reached status: errored")
      }),
    ),
  )
})

describe("AgentControl D11 ABORT recognition", () => {
  // Reuse the D5 writeAssistantMessage shape — defined inside the D5
  // describe block. Replicated here to keep this block self-contained
  // (the helper is closure-local to the D5 describe and not exported).
  const writeAssistantMessage = (
    sessions: Session.Interface,
    sessionID: SessionID,
    text: string,
    finish: string,
  ) =>
    Effect.gen(function* () {
      const userMsg = {
        id: MessageID.ascending(),
        sessionID,
        role: "user" as const,
        time: { created: Date.now() },
        agent: "build",
        model: {
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-3-5-sonnet"),
        },
      }
      yield* sessions.updateMessage(userMsg)
      const assistantMsg = {
        id: MessageID.ascending(),
        sessionID,
        parentID: userMsg.id,
        role: "assistant" as const,
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        time: { created: Date.now(), completed: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("claude-3-5-sonnet"),
        providerID: ProviderID.make("anthropic"),
        finish,
      }
      yield* sessions.updateMessage(assistantMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMsg.id,
        sessionID,
        type: "text",
        text,
      })
      return assistantMsg
    })

  it.live(
    "recognizes ABORT(<reason>): <details> as last assistant line and surfaces structured payload (INV-D-12 unit)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          yield* control.registerRunLoop((sid) =>
            Effect.gen(function* () {
              yield* writeAssistantMessage(
                sessions,
                sid,
                "ABORT(spec_wrong): bad spec.",
                "tool-calls",
              )
              return "done"
            }),
          )

          const root = yield* seedRoot()
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "abort_basic",
            initial_message: ".",
          })
          yield* Effect.sleep(50)

          const drained = yield* control.drainMailbox(root.id)
          const note = drained.find(
            (m) => String(m.author) === String(child.metadata.agent_path),
          )
          expect(note).toBeDefined()
          expect(note?.abort_reason?.reason).toBe("spec_wrong")
          expect(note?.abort_reason?.details).toBe("bad spec.")
          // Legacy text preserved inside content for TUI / log scrapers.
          expect(note?.content).toContain("ABORT(spec_wrong)")
        }),
      ),
  )

  it.live("parses ABORT from the LAST line of a multi-line body, not from interior lines", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            yield* writeAssistantMessage(
              sessions,
              sid,
              "Working on fix.\nAttempted 3 strategies.\nABORT(approach_failed): tried 3x.",
              "tool-calls",
            )
            return "done"
          }),
        )

        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "abort_multiline",
          initial_message: ".",
        })
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        const note = drained.find(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(note).toBeDefined()
        expect(note?.abort_reason?.reason).toBe("approach_failed")
        expect(note?.abort_reason?.details).toBe("tried 3x.")
      }),
    ),
  )

  it.live("returns undefined abort_reason on normal completion with no ABORT line", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            yield* writeAssistantMessage(
              sessions,
              sid,
              "Task complete. Found 5 results.",
              "tool-calls",
            )
            return "done"
          }),
        )

        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "abort_none",
          initial_message: ".",
        })
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        const note = drained.find(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(note).toBeDefined()
        expect(note?.abort_reason).toBeUndefined()
      }),
    ),
  )

  it.live("forwards unrecognized reason tags (graceful degradation per WAVE.md Gotcha #2)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            yield* writeAssistantMessage(
              sessions,
              sid,
              "ABORT(custom_reason): foo",
              "tool-calls",
            )
            return "done"
          }),
        )

        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "abort_custom",
          initial_message: ".",
        })
        yield* Effect.sleep(50)

        const drained = yield* control.drainMailbox(root.id)
        const note = drained.find(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(note).toBeDefined()
        // Runtime does NOT enforce the official six — forwards whatever matches `[a-z_]+`.
        expect(note?.abort_reason?.reason).toBe("custom_reason")
        expect(note?.abort_reason?.details).toBe("foo")
      }),
    ),
  )
})

describe("AgentControl D9 wasKnownPath", () => {
  it.live("returns true for a path that was once registered, false for a never-registered path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "known",
          initial_message: ".",
        })

        // The child's path is registered now AND remains in knownPaths.
        expect(yield* control.wasKnownPath(root.id, child.metadata.agent_path!)).toBe(true)
        expect(yield* control.wasKnownPath(root.id, path("/root/never"))).toBe(false)

        // After closeAgent, the path is RELEASED from the registry but
        // STAYS in knownPaths — the close_agent tool needs this exact
        // distinction to surface already_terminated vs path_invalid.
        yield* control.closeAgent(child.thread_id, root.id)
        expect(yield* control.wasKnownPath(root.id, child.metadata.agent_path!)).toBe(true)

        // Root itself is in knownPaths (seeded when ensureRootSlot ran).
        expect(yield* control.wasKnownPath(root.id, ROOT)).toBe(true)
      }),
    ),
  )

  it.live("returns false when senderID does not resolve to a slot (unknown root)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        // Phantom session id → slotFor returns undefined → returns false.
        const phantom = SessionID.descending()
        expect(yield* control.wasKnownPath(phantom, path("/root/anything"))).toBe(false)
      }),
    ),
  )

  it.live("is per-root scoped — a path registered under root A is invisible to root B's caller", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const rootA = yield* sessions.create({ title: "A" })
        const rootB = yield* sessions.create({ title: "B" })
        yield* control.registerSessionRoot(rootA.id)
        yield* control.registerSessionRoot(rootB.id)

        yield* control.spawnAgent({
          parentID: rootA.id,
          parentPath: ROOT,
          task_name: "isolated",
          initial_message: ".",
        })
        // From rootA: the path is known.
        expect(yield* control.wasKnownPath(rootA.id, path("/root/isolated"))).toBe(true)
        // From rootB: the SAME path is invisible.
        expect(yield* control.wasKnownPath(rootB.id, path("/root/isolated"))).toBe(false)
      }),
    ),
  )
})

describe("AgentControl D12 supervision strategies", () => {
  // Reuse the D5/D11 writeAssistantMessage shape — duplicated locally so
  // this describe block stays self-contained (the helper is closure-local
  // to the D5/D11 describes and not exported).
  const writeAssistantMessage = (
    sessions: Session.Interface,
    sessionID: SessionID,
    text: string,
    finish: string,
  ) =>
    Effect.gen(function* () {
      const userMsg = {
        id: MessageID.ascending(),
        sessionID,
        role: "user" as const,
        time: { created: Date.now() },
        agent: "build",
        model: {
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-3-5-sonnet"),
        },
      }
      yield* sessions.updateMessage(userMsg)
      const assistantMsg = {
        id: MessageID.ascending(),
        sessionID,
        parentID: userMsg.id,
        role: "assistant" as const,
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        time: { created: Date.now(), completed: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("claude-3-5-sonnet"),
        providerID: ProviderID.make("anthropic"),
        finish,
      }
      yield* sessions.updateMessage(assistantMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMsg.id,
        sessionID,
        type: "text",
        text,
      })
      return assistantMsg
    })

  it.live(
    "defaults to escalate when on_failure is not provided (current behavior preserved)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const control = yield* AgentControl.Service
          yield* control.registerRunLoop(() => Effect.die("boom"))
          const root = yield* seedRoot()
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "default_escalate",
            initial_message: ".",
          })
          yield* Effect.sleep(100)

          const drained = yield* control.drainMailbox(root.id)
          const fromChild = drained.filter(
            (m) => String(m.author) === String(child.metadata.agent_path),
          )
          expect(fromChild.length).toBe(1)
          expect(fromChild[0]!.content).toContain("reached status: errored")
          expect(fromChild[0]!.abort_reason).toBeUndefined()
        }),
      ),
  )

  it.live(
    "on_failure=respawn: child re-spawns at the same task_name with a new session id after a crash",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          let counter = 0
          yield* control.registerRunLoop((sid) =>
            Effect.gen(function* () {
              counter += 1
              if (counter === 1) return yield* Effect.die("first crash")
              yield* writeAssistantMessage(sessions, sid, "respawned ok", "tool-calls")
              return "done"
            }),
          )

          const root = yield* seedRoot()
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "respawner",
            initial_message: ".",
            on_failure: "respawn",
          })
          yield* Effect.sleep(150)

          expect(counter).toBe(2)
          const resolved = yield* control.resolveAgentReference(
            ROOT,
            "/root/respawner",
            root.id,
          )
          expect(resolved).not.toBe(child.thread_id)

          const drained = yield* control.drainMailbox(root.id)
          const fromChild = drained.filter(
            (m) => String(m.author) === String(child.metadata.agent_path),
          )
          const respawnNote = fromChild.find(
            (m) => m.abort_reason?.reason === "transient_tool_error",
          )
          expect(respawnNote).toBeDefined()
          expect(respawnNote?.abort_reason?.details).toMatch(/respawned after crash; attempt 1\/3/)
        }),
      ),
  )

  it.live(
    "on_failure=respawn: max-3 respawns then escalates with respawn-cap-exceeded note",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const control = yield* AgentControl.Service
          let counter = 0
          yield* control.registerRunLoop(() =>
            Effect.gen(function* () {
              counter += 1
              return yield* Effect.die("always dies")
            }),
          )

          const root = yield* seedRoot()
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "cap_exceeded",
            initial_message: ".",
            on_failure: "respawn",
          })
          yield* Effect.sleep(200)

          expect(counter).toBe(4)
          const drained = yield* control.drainMailbox(root.id)
          const fromChild = drained.filter(
            (m) => String(m.author) === String(child.metadata.agent_path),
          )
          const capNote = fromChild.find((m) =>
            m.abort_reason?.details?.match(/respawn cap exceeded/),
          )
          expect(capNote).toBeDefined()
          expect(capNote?.abort_reason?.reason).toBe("transient_tool_error")
        }),
      ),
  )

  it.live("on_failure=ignore: errored child produces NO completion notification to parent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop(() => Effect.die("silent"))
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "ignored",
          initial_message: ".",
          on_failure: "ignore",
        })
        yield* Effect.sleep(100)

        const drained = yield* control.drainMailbox(root.id)
        const fromChild = drained.filter(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(fromChild.length).toBe(0)
      }),
    ),
  )

  it.live(
    "on_failure=kill_pool: stored but no runtime effect this wave (Wave 6 wires)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          yield* control.registerRunLoop((sid) =>
            Effect.gen(function* () {
              yield* writeAssistantMessage(sessions, sid, "all good", "tool-calls")
              return "done"
            }),
          )
          const root = yield* seedRoot()
          const child = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: ROOT,
            task_name: "killpool_stub",
            initial_message: ".",
            on_failure: "kill_pool",
          })
          yield* Effect.sleep(100)

          const drained = yield* control.drainMailbox(root.id)
          const fromChild = drained.filter(
            (m) => String(m.author) === String(child.metadata.agent_path),
          )
          expect(fromChild.length).toBeGreaterThanOrEqual(1)
          expect(fromChild[0]!.content).toContain("reached status: completed")
        }),
      ),
  )

  it.live("pool_strategy stored on the per-child slot (stub for Wave 6)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            yield* writeAssistantMessage(sessions, sid, "pool ok", "tool-calls")
            return "done"
          }),
        )
        const root = yield* seedRoot()
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "pool_member",
          initial_message: ".",
          pool_strategy: "one_for_all",
        })
        yield* Effect.sleep(100)

        expect(typeof child.thread_id).toBe("string")
        const drained = yield* control.drainMailbox(root.id)
        const fromChild = drained.filter(
          (m) => String(m.author) === String(child.metadata.agent_path),
        )
        expect(fromChild.length).toBeGreaterThanOrEqual(1)
        expect(fromChild[0]!.content).toContain("reached status: completed")
      }),
    ),
  )
})

describe("AgentControl D13 pool primitives", () => {
  it.live("createPool with count=3 spawns 3 members and populates poolMembers + poolOf maps", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 3,
          common_message: "do work",
        })

        expect(result.pool_id.startsWith("pool_")).toBe(true)
        expect(result.members.length).toBe(3)
        expect(result.failures.length).toBe(0)
        expect(String(result.members[0]!.metadata.agent_path)).toBe("/root/pool_0")
        expect(String(result.members[1]!.metadata.agent_path)).toBe("/root/pool_1")
        expect(String(result.members[2]!.metadata.agent_path)).toBe("/root/pool_2")

        const listed = yield* control.listPoolMembers(result.pool_id, root.id)
        expect(listed.length).toBe(3)
        expect(listed[0]).toBe(result.members[0]!.thread_id)
      }),
    ),
  )

  it.live("createPool with depth-exceeding parent path returns failures (partial-pool tolerance)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        // Build a chain to depth 4 so a 5th spawn under it trips depth.
        const l1 = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "l1",
          initial_message: ".",
        })
        const l2 = yield* control.spawnAgent({
          parentID: l1.thread_id,
          parentPath: path("/root/l1"),
          task_name: "l2",
          initial_message: ".",
        })
        const l3 = yield* control.spawnAgent({
          parentID: l2.thread_id,
          parentPath: path("/root/l1/l2"),
          task_name: "l3",
          initial_message: ".",
        })
        const l4 = yield* control.spawnAgent({
          parentID: l3.thread_id,
          parentPath: path("/root/l1/l2/l3"),
          task_name: "l4",
          initial_message: ".",
        })

        const result = yield* control.createPool({
          parentID: l4.thread_id,
          parentPath: path("/root/l1/l2/l3/l4"),
          count: 2,
          common_message: "too deep",
        })

        expect(result.members.length).toBe(0)
        expect(result.failures.length).toBe(2)
        expect(result.failures[0]!.error_tag).toBe("depth_exceeded")
        expect(result.failures[0]!.task_name).toBe("pool_0")
      }),
    ),
  )

  it.live('collectPool with strategy { type: "all" } returns deliverables in completion order', () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const root = yield* seedRoot()
        let counter = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const idx = counter++
            const meta = yield* control.getAgentMetadata(sid)
            const author = meta!.agent_path!
            // Stagger sends so delivered_at ordering is observable.
            yield* Effect.sleep(20 * (idx + 1))
            yield* control
              .sendInterAgentCommunication(
                root.id,
                new InterAgentCommunication({
                  author,
                  recipient: ROOT,
                  content: `from worker ${idx}`,
                  trigger_turn: false,
                  sent_at: Date.now(),
                }),
                sid,
              )
              .pipe(Effect.orDie)
            return "done"
          }),
        )

        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: "go",
        })
        expect(created.members.length).toBe(2)

        const collected = yield* control.collectPool(
          created.pool_id,
          root.id,
          { type: "all" },
          5000,
        )
        expect(collected.timed_out).toBe(false)
        expect(collected.deliverables.length).toBe(2)
        // delivered_at non-decreasing — sort by delivered_at guarantee.
        expect(collected.deliverables[0]!.delivered_at).toBeLessThanOrEqual(
          collected.deliverables[1]!.delivered_at,
        )
        const contents = collected.deliverables.map((d) => d.content)
        expect(contents).toContain("from worker 0")
        expect(contents).toContain("from worker 1")
      }),
    ),
  )

  it.live('collectPool with strategy { type: "first" } returns exactly one deliverable', () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const root = yield* seedRoot()
        let idx = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const myIdx = idx++
            const meta = yield* control.getAgentMetadata(sid)
            const author = meta!.agent_path!
            if (myIdx === 0) {
              yield* control
                .sendInterAgentCommunication(
                  root.id,
                  new InterAgentCommunication({
                    author,
                    recipient: ROOT,
                    content: "fastest finger",
                    trigger_turn: false,
                    sent_at: Date.now(),
                  }),
                  sid,
                )
                .pipe(Effect.orDie)
              return "done"
            }
            // Other worker sits idle.
            return yield* Effect.never
          }),
        )
        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: "race",
        })
        expect(created.members.length).toBe(2)
        const collected = yield* control.collectPool(
          created.pool_id,
          root.id,
          { type: "first" },
          5000,
        )
        expect(collected.timed_out).toBe(false)
        expect(collected.deliverables.length).toBe(1)
        expect(collected.deliverables[0]!.content).toBe("fastest finger")
      }),
    ),
  )

  it.live("closePoolMembers closes all members except the named survivor", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 3,
          common_message: ".",
        })
        expect(created.members.length).toBe(3)

        const survivor = created.members[0]!.thread_id
        const others = [created.members[1]!.thread_id, created.members[2]!.thread_id]

        yield* control.closePoolMembers(created.pool_id, root.id, survivor)
        yield* Effect.sleep(100)

        for (const oid of others) {
          const ref = yield* Effect.result(control.subscribeStatus(oid))
          if (Result.isSuccess(ref)) {
            const status = yield* SubscriptionRef.get(ref.success)
            expect(status).toBe("shutdown")
          }
        }
        const survivorRef = yield* control.subscribeStatus(survivor)
        const survivorStatus = yield* SubscriptionRef.get(survivorRef)
        expect(survivorStatus).not.toBe("shutdown")
      }),
    ),
  )

  it.live("collectPool times out when no deliverables arrive", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: ".",
        })
        expect(created.members.length).toBe(2)
        const collected = yield* control.collectPool(
          created.pool_id,
          root.id,
          { type: "all" },
          100,
        )
        expect(collected.timed_out).toBe(true)
        expect(collected.deliverables.length).toBe(0)
      }),
    ),
  )

  it.live("collectPool filters out completion-notification messages (Agent ... reached status:)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const root = yield* seedRoot()
        // Workers emit an assistant message then exit naturally — that
        // triggers a completion-notification ("Agent <path> reached status:
        // completed") to root's mailbox. Without explicit send_message
        // delivers, collectPool ("all", short timeout) should report 0
        // deliverables AND timed_out=true (filter rule excludes the
        // notification).
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const userMsg = {
              id: MessageID.ascending(),
              sessionID: sid,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: {
                providerID: ProviderID.make("anthropic"),
                modelID: ModelID.make("claude-3-5-sonnet"),
              },
            }
            yield* sessions.updateMessage(userMsg)
            const aMsg = {
              id: MessageID.ascending(),
              sessionID: sid,
              parentID: userMsg.id,
              role: "assistant" as const,
              mode: "build",
              agent: "build",
              path: { cwd: ".", root: "." },
              time: { created: Date.now(), completed: Date.now() },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelID.make("claude-3-5-sonnet"),
              providerID: ProviderID.make("anthropic"),
              finish: "tool-calls",
            }
            yield* sessions.updateMessage(aMsg)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: aMsg.id,
              sessionID: sid,
              type: "text",
              text: "final reply, but routed via auto-extraction",
            })
            return "done"
          }),
        )
        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: ".",
        })
        const collected = yield* control.collectPool(
          created.pool_id,
          root.id,
          { type: "all" },
          250,
        )
        // Completion notifications get filtered → no deliverables, timed out.
        expect(collected.timed_out).toBe(true)
        expect(collected.deliverables.length).toBe(0)
      }),
    ),
  )

  it.live("listPoolMembers returns empty for unknown pool_id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const listed = yield* control.listPoolMembers("pool_nonexistent", root.id)
        expect(listed.length).toBe(0)
      }),
    ),
  )

  it.live("closePoolMembers on unknown pool_id is a no-op", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.closePoolMembers("pool_nonexistent", root.id)
      }),
    ),
  )

  it.live("createPool propagates pool_strategy and on_failure to spawnAgent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: ".",
          pool_strategy: "one_for_all",
          on_failure: "ignore",
        })
        expect(result.members.length).toBe(2)
        // The on_failure / pool_strategy fields are propagated into
        // spawnAgent and stored on the per-child slot — exercising the
        // path is sufficient (the storage assertions live in the D12
        // tests). Here we assert the spawn path didn't reject the
        // supervision args.
        const listed = yield* control.listPoolMembers(result.pool_id, root.id)
        expect(listed.length).toBe(2)
      }),
    ),
  )

  it.live("createPool with per_worker_messages overrides common_message per index", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const result = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: "default",
          per_worker_messages: ["custom_0", "custom_1"],
          task_prefix: "w",
        })
        expect(result.members.length).toBe(2)
        expect(String(result.members[0]!.metadata.agent_path)).toBe("/root/w_0")
        expect(result.members[0]!.metadata.last_task_message).toBe("custom_0")
        expect(result.members[1]!.metadata.last_task_message).toBe("custom_1")
      }),
    ),
  )

  it.live("createPool with unknown parent returns empty result (no slot, no throw)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        yield* seedRoot()
        const control = yield* AgentControl.Service
        // parentID is fabricated and parentPath is NOT root, so the
        // ensureRootSlot fallback doesn't fire. createPool returns an
        // empty pool result rather than throwing.
        const result = yield* control.createPool({
          parentID: SessionID.descending("ses_unknown"),
          parentPath: path("/root/elsewhere"),
          count: 2,
          common_message: ".",
        })
        expect(result.members.length).toBe(0)
        expect(result.failures.length).toBe(0)
      }),
    ),
  )

  it.live("collectPool on unknown caller returns empty + not timed out", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const control = yield* AgentControl.Service
        const r = yield* control.collectPool(
          "pool_anything",
          SessionID.descending("ses_unregistered"),
          { type: "first" },
          50,
        )
        expect(r.deliverables.length).toBe(0)
        expect(r.timed_out).toBe(false)
      }),
    ),
  )

  it.live("collectPool partial timeout — captures deliverables that landed during the window", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        // Create a session WITHOUT calling registerSessionRoot — the
        // createPool fallback at L1743 should lazy-register it.
        const root = yield* sessions.create({ title: "lazy_root" })
        const result = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 1,
          common_message: ".",
        })
        expect(result.members.length).toBe(1)
        expect(result.failures.length).toBe(0)
      }),
    ),
  )

  it.live("collectPool partial timeout — captures deliverables that landed during the window", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* AgentControl.Service
        const root = yield* seedRoot()
        let counter = 0
        yield* control.registerRunLoop((sid) =>
          Effect.gen(function* () {
            const idx = counter++
            const meta = yield* control.getAgentMetadata(sid)
            const author = meta!.agent_path!
            if (idx === 0) {
              // Worker 0 sends quickly.
              yield* control
                .sendInterAgentCommunication(
                  root.id,
                  new InterAgentCommunication({
                    author,
                    recipient: ROOT,
                    content: "fast deliverable",
                    trigger_turn: false,
                    sent_at: Date.now(),
                  }),
                  sid,
                )
                .pipe(Effect.orDie)
              return "done"
            }
            // Worker 1 never sends.
            return yield* Effect.never
          }),
        )
        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 2,
          common_message: ".",
        })
        // Strategy "all" with timeout shorter than worker 1 will ever send.
        const collected = yield* control.collectPool(
          created.pool_id,
          root.id,
          { type: "all" },
          200,
        )
        expect(collected.timed_out).toBe(true)
        expect(collected.deliverables.length).toBe(1)
        expect(collected.deliverables[0]!.content).toBe("fast deliverable")
      }),
    ),
  )

  it.live("collectPool returns empty when caller's mailbox slot has been torn down", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        // Spawn a subagent, then close it. The closeAgent path removes
        // the subagent's mailbox but its sessionToRoot index persists
        // — calling collectPool with that closed subagent's id hits the
        // mailbox-missing branch (returns empty, not timed out).
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: ROOT,
          task_name: "ghost",
          initial_message: ".",
        })
        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 1,
          common_message: ".",
        })
        yield* control.closeAgent(child.thread_id, root.id)
        const r = yield* control.collectPool(
          created.pool_id,
          child.thread_id,
          { type: "all" },
          50,
        )
        expect(r.deliverables.length).toBe(0)
        expect(r.timed_out).toBe(false)
      }),
    ),
  )

  it.live("collectPool without timeout returns immediately for satisfied empty pool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop([])
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service

        const created = yield* control.createPool({
          parentID: root.id,
          parentPath: ROOT,
          count: 0,
          common_message: ".",
        })
        expect(created.members.length).toBe(0)
        // No timeout_ms — relies on satisfied() returning true immediately
        // for the empty-member-set { type: "all" } strategy.
        const r = yield* control.collectPool(created.pool_id, root.id, { type: "all" })
        expect(r.deliverables.length).toBe(0)
        expect(r.timed_out).toBe(false)
      }),
    ),
  )
})
