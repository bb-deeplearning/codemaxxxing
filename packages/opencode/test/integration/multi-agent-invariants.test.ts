// Integration invariants — every multi-agent surface in this campaign asserts
// observable behavior against the scenarios listed in
// .wave/campaigns/codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md.
//
// Every scenario in the doc has exactly one `it.instance` block here. Wave 0
// seeds the file with skipped stubs (TODO comments name the wave that
// unskips). Each later wave unskips and implements the relevant ones.
//
// Test names MATCH the invariant slugs in the doc (so the wave's verification
// can grep for them): `multi-root-isolation`, `child-completion-wakes-parent`,
// `cross-root-send-rejection`, etc.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Result, SubscriptionRef } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl, AgentNotFoundError } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { AgentStatus } from "@/agent/status"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Pty } from "@/pty"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { SystemPrompt } from "@/session/system"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { AgentCloseTool } from "@/tool/agent-close/agent-close"
import { AgentWaitTool, AgentWaitForReplyTool } from "@/tool/agent-wait/agent-wait"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type * as Tool from "@/tool/tool"
import type { Permission as PermissionTypes } from "@/permission"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Pty.defaultLayer,
    Session.defaultLayer,
    SystemPrompt.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

// Stub the run-loop so spawned agents stay alive in the registry without
// trying to drive a real session. Same pattern as multi-agent-tools.test.ts.
const installNeverLoop = Effect.gen(function* () {
  const control = yield* AgentControl.Service
  yield* control.registerRunLoop(() => Effect.never)
})

// Resolve AgentWaitTool to its Def so tests can call `.execute(args, ctx)`.
// Tool.Info.init() returns the Def; the outer Effect resolves the Info.
const initWaitTool = Effect.gen(function* () {
  const info = yield* AgentWaitTool
  return yield* info.init()
})

const initWaitForReplyTool = Effect.gen(function* () {
  const info = yield* AgentWaitForReplyTool
  return yield* info.init()
})

// Build a minimal Tool.Context for invoking AgentWaitTool from a parent
// session. The same shape the bug-3 audit tests + multi-agent-tools tests use.
const makeCtx = (sessionID: SessionID): Tool.Context => ({
  sessionID,
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// Seed a parent session with the user + assistant message TaskTool requires
// per task.ts:103 (msg.info.role !== "assistant" → fail). Returns the
// assistant message id so callers can pass it as ctx.messageID.
const seedAssistantMessage = Effect.fn("multi-agent-invariants.seedAssistantMessage")(function* (
  parentID: SessionID,
) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parentID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: parentID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return assistant
})

// Stub the legacy task tool's `promptOps` so the child runLoop completes
// synchronously with a single text part. Mirrors the shape used by
// test/backward-compat/legacy-task-tool.test.ts:103-109. The text appears
// inside the `<task_result>` envelope per task.ts:158-163.
const stubPromptOps = (text: string): TaskPromptOps => ({
  cancel() {},
  resolvePromptParts: (template) =>
    Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input: SessionPrompt.PromptInput) =>
    Effect.sync(() => {
      const id = MessageID.ascending()
      return {
        info: {
          id,
          role: "assistant",
          parentID: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          mode: input.agent ?? "general",
          agent: input.agent ?? "general",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model?.modelID ?? ref.modelID,
          providerID: input.model?.providerID ?? ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: id,
            sessionID: input.sessionID,
            type: "text",
            text,
          },
        ],
      }
    }),
})

describe("INTEGRATION_INVARIANTS — multi-agent surfaces", () => {
  // TODO(wave_1): unskip when per-root scoping lands.
  it.instance("multi-root-isolation", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const rootA = yield* sessions.create({ title: "chatA" })
      const rootB = yield* sessions.create({ title: "chatB" })
      yield* control.registerSessionRoot(rootA.id)
      yield* control.registerSessionRoot(rootB.id)

      // Spawn worker_a from each root. Currently (RED), the second spawn
      // collides on `path_already_exists` because the registry is shared.
      // After the fix, each root has its own registry → both succeed.
      const childA = yield* control.spawnAgent({
        parentID: rootA.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "from A",
      })
      const childB = yield* control.spawnAgent({
        parentID: rootB.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "from B",
      })
      expect(childA.thread_id).not.toBe(childB.thread_id)

      // Each root's listAgents shows only its own worker.
      // Use the post-refactor signature: listAgents(currentPath, senderID, pathPrefix?)
      const listA = yield* control.listAgents(AgentPath.root(), rootA.id)
      const listB = yield* control.listAgents(AgentPath.root(), rootB.id)

      const namesA = listA.map((l) => l.agent_name).sort()
      const namesB = listB.map((l) => l.agent_name).sort()
      expect(namesA).toEqual(["/root", "/root/worker_a"])
      expect(namesB).toEqual(["/root", "/root/worker_a"])

      // The two listings refer to DIFFERENT worker_a sessions.
      // Drain childA's seed message; childB's mailbox keeps its seed.
      const drainA1 = yield* control.drainMailbox(childA.thread_id)
      expect(drainA1).toHaveLength(1)
      expect(drainA1[0]?.content).toBe("from A")
      const drainB1 = yield* control.drainMailbox(childB.thread_id)
      expect(drainB1).toHaveLength(1)
      expect(drainB1[0]?.content).toBe("from B")

      // Send to rootA's worker — lands in childA's mailbox, NOT childB's.
      yield* control.sendInterAgentCommunication(
        childA.thread_id,
        new InterAgentCommunication({
          author: AgentPath.root(),
          recipient: childA.metadata.agent_path ?? AgentPath.root(),
          content: "for A only",
          trigger_turn: false,
          sent_at: 1,
        }),
        rootA.id,
      )
      const drainA2 = yield* control.drainMailbox(childA.thread_id)
      const drainB2 = yield* control.drainMailbox(childB.thread_id)
      expect(drainA2).toHaveLength(1)
      expect(drainA2[0]?.content).toBe("for A only")
      expect(drainB2).toHaveLength(0)

      // Close rootA's worker — rootB's worker stays alive.
      yield* control.closeAgent(childA.thread_id)
      const listAAfter = yield* control.listAgents(AgentPath.root(), rootA.id)
      const listBAfter = yield* control.listAgents(AgentPath.root(), rootB.id)
      expect(listAAfter.find((l) => l.agent_name === "/root/worker_a")).toBeUndefined()
      expect(listBAfter.find((l) => l.agent_name === "/root/worker_a")).toBeDefined()
    }),
  )

  // TODO(wave_2): unskip when completion watcher lands.
  it.instance("child-completion-wakes-parent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      // Run-loop sleeps 50ms then returns Effect.void. fiber.onExit on
      // success sets status to { completed: null }. The completion watcher
      // (Wave 2) observes that final status and notifies the parent's
      // mailbox so wait_agent's seq watch wakes promptly.
      yield* control.registerRunLoop(() => Effect.sleep("50 millis"))

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "task_a",
        initial_message: "go",
      })

      // Drain anything that might have landed on the parent's mailbox during
      // spawn — only the watcher's notification should remain after waiting.
      yield* control.drainMailbox(root.id)

      const def = yield* initWaitTool
      const t0 = Date.now()
      const result = yield* def.execute({ timeout_ms: 30_000 }, makeCtx(root.id))
      const elapsed = Date.now() - t0

      // Pre-fix: wait_agent on root falls back to a sleep-then-timeout (root
      // has no mailbox) and elapsed ≈ 30_000 with timed_out=true. Post-fix:
      // root has a mailbox, the watcher fires the completion notification,
      // wait_agent races the seq change and returns timed_out=false.
      //
      // Budget: child sleep 50ms + watcher fire (~µs) + wait_agent wakeup
      // (~ms). 1000ms allows comfortable headroom for cold session.create
      // (Drizzle write) + permission ask plumbing on a noisy machine. Per
      // GOTCHAS.md gotcha 7: bump to 1000ms when 500ms flakes; ≤ 1000ms is
      // still ~30× under the 30s timeout so the test isn't trivially passing
      // on the timeout branch.
      expect(result.metadata.timed_out).toBe(false)
      expect(elapsed).toBeLessThan(1000)
    }),
  )

  // TODO(wave_2): unskip when completion watcher lands.
  // Updated in actor-discipline-2026-05-20 Wave 0: a silently-exiting child
  // (no assistant text, no send_message) now trips the D5 safety net.
  // The notification body STARTS with the ⚠️ warning, with the status
  // header appended at the end. The lifecycle envelope (author/recipient/
  // trigger_turn) is unchanged.
  it.instance("child-completion-notification-body-shape", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      yield* control.registerRunLoop(() => Effect.sleep("50 millis"))

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "task_b",
        initial_message: "go",
      })
      yield* control.drainMailbox(root.id)

      const def = yield* initWaitTool
      const result = yield* def.execute({ timeout_ms: 30_000 }, makeCtx(root.id))
      expect(result.metadata.timed_out).toBe(false)

      // The watcher's notification carries a fixed body shape per
      // MESSAGE_SHAPES.md § "completion notification body shape (Wave 2)"
      // + the actor-discipline-2026-05-20 safety-net additions.
      const drained = yield* control.drainMailbox(root.id)
      expect(drained).toHaveLength(1)
      const note = drained[0]!
      // D5 safety net: child silently exited, no send to spawner → ⚠️.
      expect(note.content.startsWith("⚠️")).toBe(true)
      expect(note.content).toContain("Agent /root/task_b reached status: completed")
      expect(note.content).toContain("<no text emitted>")
      expect(String(note.author)).toBe("/root/task_b")
      // The parent here IS root → recipient is "/root".
      expect(String(note.recipient)).toBe("/root")
      expect(note.trigger_turn).toBe(false)
    }),
  )

  // TODO(wave_1): unskip when per-root scoping lands.
  it.instance("cross-root-send-rejection", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const rootA = yield* sessions.create({ title: "chatA" })
      const rootB = yield* sessions.create({ title: "chatB" })
      yield* control.registerSessionRoot(rootA.id)
      yield* control.registerSessionRoot(rootB.id)

      yield* control.spawnAgent({
        parentID: rootA.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "init A",
      })
      const childB = yield* control.spawnAgent({
        parentID: rootB.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "init B",
      })
      // Drain seed messages so the next drain length reflects new sends only.
      yield* control.drainMailbox(childB.thread_id)

      // From rootA, attempt to send to childB (a different root's child).
      // Post-refactor: rejected with AgentNotFoundError.
      const result = yield* Effect.result(
        control.sendInterAgentCommunication(
          childB.thread_id,
          new InterAgentCommunication({
            author: AgentPath.root(),
            recipient: childB.metadata.agent_path ?? AgentPath.root(),
            content: "cross-root attempt",
            trigger_turn: true,
            sent_at: 1,
          }),
          rootA.id,
        ),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AgentNotFoundError)
      }

      // childB's mailbox is unchanged — drain returns empty.
      const drainedB = yield* control.drainMailbox(childB.thread_id)
      expect(drainedB).toHaveLength(0)
    }),
  )

  // TODO(wave_1): unskip when per-root scoping lands.
  it.instance("session-deletion-cleanup", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const rootA = yield* sessions.create({ title: "chatA" })
      const rootB = yield* sessions.create({ title: "chatB" })
      yield* control.registerSessionRoot(rootA.id)
      yield* control.registerSessionRoot(rootB.id)

      yield* control.spawnAgent({
        parentID: rootA.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "alive",
      })
      yield* control.spawnAgent({
        parentID: rootB.id,
        parentPath: AgentPath.root(),
        task_name: "worker_b",
        initial_message: "alive",
      })

      // Delete rootA. The per-root subscriber inside AgentControl observes
      // Session.Event.Deleted and tears down rootA's slot. Sleep gives the
      // bus + the subscriber time to drain.
      yield* sessions.remove(rootA.id)
      yield* Effect.sleep(50)

      // Querying rootA either yields AgentNotFoundError OR empty (impl choice).
      const listAResult = yield* Effect.result(
        control.listAgents(AgentPath.root(), rootA.id),
      )
      if (Result.isSuccess(listAResult)) {
        expect(listAResult.success).toEqual([])
      } else {
        expect(listAResult.failure).toBeInstanceOf(AgentNotFoundError)
      }

      // RootB still has its worker.
      const listB = yield* control.listAgents(AgentPath.root(), rootB.id)
      const namesB = listB.map((l) => l.agent_name).sort()
      expect(namesB).toEqual(["/root", "/root/worker_b"])
    }),
  )

  // TODO(wave_3): audit — already passes, assert it stays true after wave 1.
  it.instance("parent-close-cascades-to-children", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      // Tree: root → workerA → workerB. workerB is spawned from workerA's
      // session id (subagent → sub-subagent), which exercises the per-root
      // sessionToRoot indexing landed in Wave 1.
      const workerA = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "init A",
      })
      const workerAPath = workerA.metadata.agent_path ?? AgentPath.root()
      const workerB = yield* control.spawnAgent({
        parentID: workerA.thread_id,
        parentPath: workerAPath,
        task_name: "worker_b",
        initial_message: "init B",
      })

      // Sanity — both children show up in the registry before the cascade.
      const before = yield* control.listAgents(AgentPath.root(), root.id)
      const beforeNames = before.map((l) => l.agent_name).sort()
      expect(beforeNames).toEqual(["/root", "/root/worker_a", "/root/worker_a/worker_b"])

      // Close workerA from root — closeAgent's descendants walk
      // (control.ts:842-855) shuts every agent whose path starts with
      // workerA's path + "/" before workerA itself. Leaves-first.
      const closeResult = yield* control.closeAgent(workerA.thread_id)
      expect(closeResult.previous_status).not.toBe("shutdown")

      // Both descendants reach "shutdown". subscribeStatus retains the
      // SubscriptionRef post-shutdown (shutdownOne flips status before
      // releasing meta from the registry); reading it returns "shutdown".
      const refA = yield* control.subscribeStatus(workerA.thread_id)
      const refB = yield* control.subscribeStatus(workerB.thread_id)
      expect(yield* SubscriptionRef.get(refA)).toBe("shutdown")
      expect(yield* SubscriptionRef.get(refB)).toBe("shutdown")

      // Idempotency — re-close returns previous_status: "shutdown" without
      // erroring (the registry has released meta but the SubscriptionRef
      // and sessionToRoot entry remain, so slotFor still resolves).
      const second = yield* control.closeAgent(workerA.thread_id)
      expect(second.previous_status).toBe("shutdown")

      // listAgents from root: workerA and workerB are gone (registry
      // released them via shutdownOne → releaseSpawnedThread).
      const after = yield* control.listAgents(AgentPath.root(), root.id)
      const afterNames = after.map((l) => l.agent_name)
      expect(afterNames).not.toContain("/root/worker_a")
      expect(afterNames).not.toContain("/root/worker_a/worker_b")
      expect(afterNames).toContain("/root")
    }),
  )

  // TODO(wave_2): unskip when completion watcher lands.
  it.instance("child-fiber-interrupt-during-wait", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "longrun",
        initial_message: "go",
      })
      yield* control.drainMailbox(root.id)

      // Schedule the close 100ms in. Effect.forkScoped binds the helper
      // fiber to the test's scope so it never leaks past this test.
      // Pass `root.id` as the caller — that's what the close_agent tool
      // would pass when root is the agent invoking the close, and it's
      // also what cancelChildrenOf passes on a user cancel cascade. With
      // a strict-ancestor caller, the watcher MUST skip the notification.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("100 millis")
          yield* control.closeAgent(child.thread_id, root.id)
        }),
      )

      // wait_agent timeout floors to MIN_WAIT_TIMEOUT_MS=1000 (the smallest
      // possible wall-clock the timeout branch can return on). With root
      // (a strict ancestor of `longrun`) as the closer, the watcher's
      // skip rule (see MESSAGE_SHAPES.md § "Skip rule" and the inline
      // comment in control.ts's spawn watcher) suppresses the parent
      // notification. The wait runs out the timeout → timed_out=true.
      const def = yield* initWaitTool
      const t0 = Date.now()
      const result = yield* def.execute({ timeout_ms: 1000 }, makeCtx(root.id))
      const elapsed = Date.now() - t0

      expect(result.metadata.timed_out).toBe(true)
      // The wait actually waited; it didn't return early on a notification.
      expect(elapsed).toBeGreaterThan(900)

      // No notification was sent — the parent's mailbox is empty.
      const drained = yield* control.drainMailbox(root.id)
      expect(drained).toHaveLength(0)
    }),
  )

  // Regression for ses_1ce9356abffep1L0TvDbD80uUO — a grandchild was told
  // to "respond then close yourself", invoked close_agent on itself, and
  // the legacy unconditional skip-on-shutdown rule swallowed the parent
  // notification. wait_agent timed out at the full 60s even though the
  // grandchild had finished in seconds. With caller-aware skipping, a
  // self-close (caller === target, NOT a strict ancestor) fires the
  // notification so wait_agent wakes near-instantly.
  it.instance("self-close-wakes-parent-wait", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "selfcloser",
        initial_message: "go",
      })
      // Drain the spawn-seed `initial_message` so the post-wait mailbox
      // assertion below is exact (only the completion notification, not
      // the seed echo).
      yield* control.drainMailbox(root.id)

      // Child closes itself 100ms in. callerID === child.thread_id, which
      // is NOT a strict ancestor of itself, so the watcher MUST notify.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("100 millis")
          yield* control.closeAgent(child.thread_id, child.thread_id)
        }),
      )

      const def = yield* initWaitTool
      const t0 = Date.now()
      const result = yield* def.execute({ timeout_ms: 10_000 }, makeCtx(root.id))
      const elapsed = Date.now() - t0

      // Wait wakes on the notification, not the timeout.
      expect(result.metadata.timed_out).toBe(false)
      // Far less than the 10s timeout — single-digit seconds at most.
      expect(elapsed).toBeLessThan(5_000)

      // Mailbox holds exactly the completion notification. Body uses the
      // "shutdown" label so the parent can tell a self-close apart from
      // a natural exit (where the label is "completed").
      const drained = yield* control.drainMailbox(root.id)
      expect(drained).toHaveLength(1)
      expect(drained[0].content).toContain("reached status: shutdown")
      expect(drained[0].trigger_turn).toBe(false)
    }),
  )

  // Sibling-initiated close — A and B share a parent. A closes B. B's
  // parent never invoked the close itself, so the watcher MUST notify
  // (parent learns about B going away instead of polling status).
  it.instance("sibling-close-notifies-parent", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      const a = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "a",
        initial_message: "go",
      })
      const b = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "b",
        initial_message: "go",
      })
      yield* control.drainMailbox(root.id)

      // A closes B. Caller=A, target=B. A is not B's ancestor → notify.
      yield* control.closeAgent(b.thread_id, a.thread_id)

      // Allow the watcher's async send to land in root's mailbox.
      yield* Effect.sleep("50 millis")

      const drained = yield* control.drainMailbox(root.id)
      expect(drained).toHaveLength(1)
      expect(drained[0].content).toContain("reached status: shutdown")
      // Author is the closed agent (b), recipient is root.
      expect(drained[0].author as string).toBe("/root/b")
      // Sanity — A is still alive (sibling close shouldn't touch A).
      const aStatus = yield* control.subscribeStatus(a.thread_id)
      expect(yield* SubscriptionRef.get(aStatus)).not.toBe("shutdown")
    }),
  )

  // TODO(wave_3): audit — assert under concurrent send pressure.
  it.instance("mailbox-drain-at-runloop-boundary-with-concurrent-sends", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "worker",
        initial_message: "seed",
      })
      const childPath = child.metadata.agent_path ?? AgentPath.root()
      // Drain the spawn-seed message so the union math below is exact.
      yield* control.drainMailbox(child.thread_id)

      const N = 10

      // Fork N concurrent sends. Each carries a unique payload so we can
      // detect duplicates. Each fork yields the Fiber back so we can join
      // it after the racing drain. The send goes through
      // sendInterAgentCommunication (root resolution + Mailbox.send), which
      // is the path Bug 1's per-root refactor changed; the union assertion
      // proves no message is lost across the routed path under fan-in.
      const sendFibers = yield* Effect.forEach(
        Array.from({ length: N }, (_, i) => i),
        (i) =>
          Effect.forkScoped(
            control.sendInterAgentCommunication(
              child.thread_id,
              new InterAgentCommunication({
                author: AgentPath.root(),
                recipient: childPath,
                content: `msg-${i}`,
                trigger_turn: false,
                sent_at: i + 1,
              }),
              root.id,
            ),
          ),
      )

      // First drain races the in-flight sends — captures whatever the
      // Mailbox's atomic Ref.modify exposed by now. The atomic seq + append
      // (mailbox.ts:48-55) guarantees no torn state: every concurrent send
      // either fully landed or hasn't started, never half-applied.
      const drain1 = yield* control.drainMailbox(child.thread_id)

      // Wait for every send to fully land. Fiber.join only returns once the
      // forked effect has completed, so after this every send has either
      // appeared in drain1 or remains queued for drain2.
      yield* Effect.forEach(sendFibers, (f) => Fiber.join(f), { discard: true })

      // Second drain catches everything drain1 missed.
      const drain2 = yield* control.drainMailbox(child.thread_id)

      const all = [...drain1, ...drain2]
      const contents = all.map((c) => c.content).sort()
      const expected = Array.from({ length: N }, (_, i) => `msg-${i}`).sort()
      // Union has all N unique payloads; nothing lost across the
      // drain/send race; nothing duplicated.
      expect(contents).toEqual(expected)
      expect(new Set(contents).size).toBe(N)
    }),
  )

  // TODO(wave_3): audit — assert PTY cleanup under multi-agent cancellation.
  it.instance("pty-cleanup-on-parent-abort", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const pty = yield* Pty.Service

      // Stub run-loop spawns a model-origin PTY inside acquireUseRelease.
      // origin: "model" disables Pty's auto-remove-on-exit gating per
      // GOTCHAS pty-onexit-auto-remove-tui-only — the assertion is that the
      // multi-agent cancellation cascade triggers explicit cleanup, not
      // that the PTY exits on its own. The setInterval keeps the bun child
      // alive for 5s so the PTY stays in Pty.list until cleanup fires.
      yield* control.registerRunLoop(() =>
        Effect.acquireUseRelease(
          pty.create({
            command: "bun",
            args: ["-e", "setInterval(()=>{},5000)"],
            origin: "model",
          }),
          () => Effect.never,
          (info) => pty.remove(info.id),
        ),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "exec",
        initial_message: "go",
      })

      // Let the run-loop body register its PTY.
      yield* Effect.sleep("100 millis")
      const before = yield* pty.list()
      expect(before.length).toBeGreaterThanOrEqual(1)

      // cancelChildrenOf walks /root descendants and closeAgent's each one.
      // Each closeAgent → shutdownOne → Fiber.interrupt(runLoopFiber) →
      // run-loop's acquireUseRelease release fires → pty.remove → PTY
      // killed and unregistered. The forkIn(parentScope) chain in
      // AgentControl wires the run-loop into a scope reachable by the
      // shutdown, which is the whole composability claim this test makes.
      yield* control.cancelChildrenOf(root.id)

      // Cascade settles. Fiber.interrupt awaits exit before returning so
      // most of the cleanup is sync; the small sleep covers any residual
      // bridge.fork plumbing inside the Pty layer.
      yield* Effect.sleep("100 millis")

      const after = yield* pty.list()
      expect(after.length).toBe(0)
    }),
  )

  // wave_4: backward-compat verification — the legacy `task` tool path
  // (sessions.create({parentID}) directly, no AgentControl) must keep
  // working unchanged after Wave 1's per-root refactor and Wave 2's
  // completion watcher.
  it.instance("legacy-task-tool-coexists-with-v2", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      // Two roots in the same project — the campaign's defining scenario.
      // Root B is a separate "chat" we'll assert remains untouched after
      // root A drives a legacy-task call.
      const rootA = yield* sessions.create({ title: "chatA" })
      const rootB = yield* sessions.create({ title: "chatB" })
      yield* control.registerSessionRoot(rootA.id)
      yield* control.registerSessionRoot(rootB.id)

      // task.ts:103 reads MessageV2.get({sessionID, messageID}) and fails if
      // role !== "assistant". Seed root A with a (user, assistant) pair so
      // the assistant id is what we pass as ctx.messageID.
      const assistantA = yield* seedAssistantMessage(rootA.id)

      // Resolve the legacy TaskTool to its Def for direct .execute(args, ctx).
      // task.ts exports the Tool.Info via the `Tool.define` factory.
      const taskInfo = yield* TaskTool
      const taskDef = yield* taskInfo.init()

      // Drive the legacy task call exactly as a model would: description +
      // prompt + subagent_type, with promptOps stubbed in ctx.extra so the
      // child runLoop completes synchronously without a real model.
      const result = yield* taskDef.execute(
        {
          description: "audit",
          prompt: "find foo",
          subagent_type: "explore",
        },
        {
          sessionID: rootA.id,
          messageID: assistantA.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubPromptOps("task complete: found foo") },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 1) The `<task_result>` envelope shape is unchanged (task.ts:158-163).
      // The model parses this verbatim — drift here breaks every plugin /
      // SDK consumer that reads the envelope.
      expect(result.output).toContain("<task_result>")
      expect(result.output).toContain("</task_result>")
      expect(result.output).toContain("task complete: found foo")
      expect(result.title).toBe("audit")

      // 2) The legacy task path created a child session of root A via
      // sessions.create({parentID: ctx.sessionID}) at task.ts:70. This is
      // the path that has NO AgentControl involvement — assert it still
      // works after the per-root refactor by reading the parent's
      // children directly through Session.Service.
      const childrenOfA = yield* sessions.children(rootA.id)
      expect(childrenOfA).toHaveLength(1)
      expect(childrenOfA[0]?.id).toBe(result.metadata.sessionId)

      // 3) Root B is fully unaffected — its listAgents shows just root B
      // itself, no leakage of root A's task-spawned child. Catches the
      // failure mode where the legacy path coupled to per-root state in
      // a way that crossed the root boundary.
      const listB = yield* control.listAgents(AgentPath.root(), rootB.id)
      expect(listB.map((l) => l.agent_name)).toEqual(["/root"])

      // 4) Root B has no task-tool children either (the legacy path used
      // the SAME sessions.create / parentID mechanism — assert the parent
      // index is properly per-root).
      const childrenOfB = yield* sessions.children(rootB.id)
      expect(childrenOfB).toHaveLength(0)
    }),
  )

  // -----------------------------------------------------------------
  // actor-discipline-2026-05-20 — INV-D-01..05, INV-D-07 (Wave 0).
  // Each test reproduces the diagnostic-session bug the campaign exists
  // to prevent. See INTEGRATION_INVARIANTS.md for the slug-by-slug spec.
  // -----------------------------------------------------------------

  // INV-D-01 — diagnostic-session-3 regression. A subagent emitted text
  // AND close_agent in the same turn → message.finish === "tool-calls" →
  // pre-D5 predicate skipped → parent received an empty body. After the
  // fix, the parent's completion notification contains the text body.
  it.instance("INV-D-01-extractor-returns-text-from-finish-tool-calls", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      // Run-loop writes one assistant message with text AND finish=tool-calls,
      // then exits. The completion watcher MUST surface the text in the
      // parent's notification despite the tool-calls finish.
      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "tool-calls",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "This is my deliverable.",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "tc",
        initial_message: "go",
      })
      yield* Effect.sleep(60)

      const drained = yield* control.drainMailbox(root.id)
      const note = drained.find((m) => String(m.author) === "/root/tc")
      expect(note).toBeDefined()
      expect(note?.content).toContain("This is my deliverable.")
    }),
  )

  // INV-D-02 — explicit send + completion compose. The child explicitly
  // calls send_message to the parent during its runLoop, then exits. The
  // parent's mailbox holds both (a) the explicit message, (b) the
  // completion notification with label "completed" — in order. Validates
  // that the safety net does NOT fire when the child delivers explicitly.
  it.instance("INV-D-02-explicit-send-message-delivers-and-completion-notifies", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      // Resolve the child's canonical path outside the runLoop closure so
      // the InterAgentCommunication construction can't introduce typed
      // errors into the registered run-loop signature.
      const childPath = yield* AgentPath.from("/root/explicit")
      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          // Explicit delivery via send_message to the spawner (root).
          yield* control
            .sendInterAgentCommunication(
              root.id,
              new InterAgentCommunication({
                author: childPath,
                recipient: AgentPath.root(),
                content: "Explicit deliverable.",
                trigger_turn: false,
                sent_at: Date.now(),
              }),
              sid,
            )
            .pipe(Effect.orDie)
          // Successful exit triggers the watcher's completion notification.
          return "done"
        }),
      )

      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "explicit",
        initial_message: "go",
      })
      yield* Effect.sleep(80)

      const drained = yield* control.drainMailbox(root.id)
      // Two messages from the child: explicit + completion. Order is
      // explicit first (sent during runLoop), completion second (watcher
      // fires after runLoop exits).
      const fromChild = drained.filter((m) => String(m.author) === "/root/explicit")
      expect(fromChild.length).toBeGreaterThanOrEqual(2)
      expect(fromChild[0]?.content).toBe("Explicit deliverable.")
      expect(fromChild[1]?.content).toContain("reached status: completed")
      // Safety-net warning must NOT fire — child delivered explicitly.
      expect(fromChild[1]?.content.startsWith("⚠️")).toBe(false)
    }),
  )

  // INV-D-03 — safety net fires when child silently exits. Child emits no
  // text in any assistant turn (dies early), never sends to spawner.
  // Parent's notification body STARTS with the ⚠️ warning prefix.
  it.instance("INV-D-03-safety-net-warning-when-deliverable-missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      yield* control.registerRunLoop(() => Effect.die("silent failure"))

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "silent",
        initial_message: "go",
      })
      yield* Effect.sleep(60)

      const drained = yield* control.drainMailbox(root.id)
      const note = drained.find((m) => String(m.author) === "/root/silent")
      expect(note).toBeDefined()
      expect(note?.content.startsWith("⚠️")).toBe(true)
      expect(note?.content).toContain("Child did NOT call")
      expect(note?.content).toContain("send_message/followup_task")
      // No text emitted → placeholder appears in the warning body.
      expect(note?.content).toContain("<no text emitted>")
    }),
  )

  // INV-D-04 — close_agent with omitted target resolves to the caller.
  // Subagent invokes close_agent({}); the tool resolves target to the
  // subagent's canonical path and closes the subagent.
  it.instance("INV-D-04-agent-close-without-target-resolves-to-caller", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "abc",
        initial_message: "go",
      })

      const info = yield* AgentCloseTool
      const def = yield* info.init()
      // Caller IS the child. target omitted → tool resolves to /root/abc.
      const ctx: Tool.Context = {
        sessionID: child.thread_id,
        messageID: MessageID.make(""),
        callID: "",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* def.execute({}, ctx)

      const payload = JSON.parse(result.output)
      expect(payload.previous_status).toBeDefined()

      // Child removed from the registry.
      const list = yield* control.listAgents(AgentPath.root(), root.id)
      expect(list.find((l) => l.agent_name === "/root/abc")).toBeUndefined()
    }),
  )

  // INV-D-05 — subagent prompt contains canonical path. Spawn a child;
  // assert the system prompt the child sees on its first turn contains
  // `/root/worker_a` verbatim (D2 templating).
  it.instance("INV-D-05-subagent-prompt-contains-canonical-path", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const sys = yield* SystemPrompt.Service
      const agents = yield* Agent.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "worker_a",
        initial_message: "go",
      })

      // Render the capability hints the child would see on its first turn.
      // The "general" agent type is a subagent with send_message permission,
      // which is the case D2 targets (subagent fragment + path block).
      const general = yield* agents.get("general")
      if (!general) throw new Error("general agent not registered")
      // Override mode to "subagent" if needed (general's built-in default).
      const subagent: Agent.Info = {
        ...general,
        mode: "subagent",
        permission: Permission.fromConfig({ send_message: "allow", wait_agent: "allow" }),
      }
      const hints = yield* sys.capabilityHints(subagent, child.thread_id)
      const joined = hints.join("\n\n")

      // The canonical path appears in the per-spawn block.
      expect(joined).toContain("/root/worker_a")
      expect(joined).toContain("Your canonical path")
      expect(joined).toContain(`close_agent(target: "/root/worker_a")`)
    }),
  )

  // INV-D-07 — close_agent splits failed resolution into
  // already_terminated (success case) vs path_invalid (error case).
  // Self-terminate a child via control.closeAgent (callerID = child);
  // then re-close via the tool → already_terminated. Separately,
  // close a never-registered path → path_invalid.
  it.instance("INV-D-07-close-agent-distinguishes-already-terminated-from-path-invalid", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "child_a",
        initial_message: "go",
      })
      // Self-close to release the path from the registry. The path STAYS
      // in slot.knownPaths.
      yield* control.closeAgent(child.thread_id, child.thread_id)

      const info = yield* AgentCloseTool
      const def = yield* info.init()
      const asks: Array<Omit<PermissionTypes.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        sessionID: root.id,
        messageID: MessageID.make(""),
        callID: "",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (input) =>
          Effect.sync(() => {
            asks.push(input)
          }),
      }

      // Already-terminated case.
      const r1 = yield* def.execute({ target: "/root/child_a" }, ctx)
      const meta1 = (r1 as { metadata: { error?: string; previous_status?: string } }).metadata
      expect(meta1.error).toBe("already_terminated")
      expect(meta1.previous_status).toBe("shutdown")

      // Path-invalid case — never registered.
      const r2 = yield* def.execute({ target: "/root/nonexistent" }, ctx)
      const meta2 = (r2 as { metadata: { error?: string } }).metadata
      expect(meta2.error).toBe("path_invalid")

      // Neither failure mode prompted permission.
      expect(asks).toHaveLength(0)
    }),
  )

  // INV-D-06 — send_message is unicast. Sending from root to /root/alice
  // lands the message in alice's mailbox and ONLY alice's; bob's mailbox
  // stays empty. Locks the post-D7 unicast doctrine into a runtime check.
  it.instance("INV-D-06-send-message-is-unicast-not-broadcast", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      const alice = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "alice",
        initial_message: "alice init",
      })
      const bob = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "bob",
        initial_message: "bob init",
      })
      // Drain the spawn-seed `initial_message` from BOTH mailboxes so the
      // post-send drain reflects ONLY the unicast send we are testing.
      yield* control.drainMailbox(alice.thread_id)
      yield* control.drainMailbox(bob.thread_id)

      // Unicast: target = alice ONLY. The runtime resolves the recipient
      // mailbox by targetID; there is no broadcast primitive. Bob's mailbox
      // must remain empty.
      yield* control.sendInterAgentCommunication(
        alice.thread_id,
        new InterAgentCommunication({
          author: AgentPath.root(),
          recipient: alice.metadata.agent_path ?? AgentPath.root(),
          content: "for alice only",
          trigger_turn: false,
          sent_at: 1,
        }),
        root.id,
      )

      const drainedAlice = yield* control.drainMailbox(alice.thread_id)
      const drainedBob = yield* control.drainMailbox(bob.thread_id)
      expect(drainedAlice).toHaveLength(1)
      expect(drainedAlice[0].content).toBe("for alice only")
      // The unicast invariant: bob was never addressed → mailbox empty.
      expect(drainedBob).toHaveLength(0)
    }),
  )

  // INV-D-08 — coordinator fan-out yields ONE consolidated reply, not N.
  // Locks in Demo 1's success pattern as a regression-resistant shape:
  // coordinator spawns two grandchildren, each grandchild sends one partial
  // finding to coordinator, coordinator drains+integrates, sends ONE
  // consolidated message to root. Root's mailbox holds exactly ONE message
  // from the coordinator with BOTH grandchildren's payload tokens present.
  it.instance("INV-D-08-coordinator-fan-out-delivers-single-consolidated-message", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      // Spawn /root/coordinator from root.
      const coordinator = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "coordinator",
        initial_message: "coordinate",
      })
      const coordinatorPath = coordinator.metadata.agent_path ?? AgentPath.root()
      // Drain the spawn-seed echo on root so the final assertion is exact.
      yield* control.drainMailbox(root.id)
      // Drain the coordinator's spawn-seed too so its post-fan-in drain
      // returns only the grandchildren's findings.
      yield* control.drainMailbox(coordinator.thread_id)

      // Coordinator spawns two grandchildren in a single conceptual step
      // (two spawn_agent calls, as if emitted in one assistant message).
      const gcA = yield* control.spawnAgent({
        parentID: coordinator.thread_id,
        parentPath: coordinatorPath,
        task_name: "gc_a",
        initial_message: "go a",
      })
      const gcB = yield* control.spawnAgent({
        parentID: coordinator.thread_id,
        parentPath: coordinatorPath,
        task_name: "gc_b",
        initial_message: "go b",
      })
      const gcAPath = gcA.metadata.agent_path ?? AgentPath.root()
      const gcBPath = gcB.metadata.agent_path ?? AgentPath.root()

      // Each grandchild send_message(coordinator, <partial finding>).
      // senderID is the grandchild's own session id (the runtime resolution
      // path the close-of-self / send-to-spawner sequence the spec
      // describes). Per-root scoping means coordinator + grandchildren
      // share root → sends are accepted.
      yield* control.sendInterAgentCommunication(
        coordinator.thread_id,
        new InterAgentCommunication({
          author: gcAPath,
          recipient: coordinatorPath,
          content: "finding-a",
          trigger_turn: false,
          sent_at: 1,
        }),
        gcA.thread_id,
      )
      yield* control.sendInterAgentCommunication(
        coordinator.thread_id,
        new InterAgentCommunication({
          author: gcBPath,
          recipient: coordinatorPath,
          content: "finding-b",
          trigger_turn: false,
          sent_at: 2,
        }),
        gcB.thread_id,
      )

      // Each grandchild self-closes. callerID = coordinator (strict
      // ancestor) suppresses the completion-watcher notification so the
      // coordinator's mailbox holds ONLY the two explicit findings — keeps
      // the integration step deterministic.
      yield* control.closeAgent(gcA.thread_id, coordinator.thread_id)
      yield* control.closeAgent(gcB.thread_id, coordinator.thread_id)

      // Coordinator drains, integrates, and sends ONE consolidated message
      // to root. This is the locked-in success shape: ONE consolidated body
      // carrying BOTH partial findings, not N separate messages.
      const drainedAtCoord = yield* control.drainMailbox(coordinator.thread_id)
      const findings = drainedAtCoord.map((m) => m.content).sort()
      // Both partial findings arrived at the coordinator before integration.
      expect(findings).toEqual(["finding-a", "finding-b"])
      const integrated = `integrated: ${findings.join(" + ")}`
      // Sanity: the integrated body carries BOTH grandchildren's payload
      // tokens (the C5 grep verifies the same tokens appear in the test
      // source; this expect validates the runtime body too).
      expect(integrated).toContain("finding-a")
      expect(integrated).toContain("finding-b")

      yield* control.sendInterAgentCommunication(
        root.id,
        new InterAgentCommunication({
          author: coordinatorPath,
          recipient: AgentPath.root(),
          content: integrated,
          trigger_turn: false,
          sent_at: 3,
        }),
        coordinator.thread_id,
      )

      // Close coordinator with callerID=root (strict ancestor of coordinator)
      // so the completion watcher's notification is suppressed. Without this
      // suppression, root would receive a SECOND message (the completion
      // note), breaking the exactly-one invariant this test exists to lock.
      yield* control.closeAgent(coordinator.thread_id, root.id)

      const drainedAtRoot = yield* control.drainMailbox(root.id)
      // Exactly ONE consolidated message — not two, not N.
      expect(drainedAtRoot).toHaveLength(1)
      const note = drainedAtRoot[0]!
      expect(String(note.author)).toBe("/root/coordinator")
      expect(note.content).toContain("finding-a")
      expect(note.content).toContain("finding-b")
    }),
  )

  // INV-D-01-regression-ses_1c2e8d84affe — diagnostic-session-1 (Cidoo
  // ABM066) shape. Subagent emits a multi-KB tool-calls assistant message
  // carrying the actual deliverable, THEN a second finish="stop" message
  // with just "Done." The pre-D5 extractor surfaced only the last
  // assistant text → parent received "Done." with the report lost. After
  // D5, the parent's completion notification carries the report body.
  it.instance("INV-D-01-regression-ses_1c2e8d84affe", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      // Build a ~5KB body. Marker substring "FULL REPORT BODY" stays
      // intact so the assertion can grep it back out.
      const longText = "FULL REPORT BODY ".repeat(256)

      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)

          // First assistant message: finish="tool-calls" carrying the
          // multi-KB report. This is the actual deliverable.
          const asst1 = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "tool-calls",
          }
          yield* sessions.updateMessage(asst1)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst1.id,
            sessionID: sid,
            type: "text",
            text: longText,
          })

          // Second assistant message: finish="stop" with just "Done."
          // Pre-D5 extractor surfaced THIS as the deliverable, losing
          // the report body above.
          const asst2 = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: asst1.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "stop",
          }
          yield* sessions.updateMessage(asst2)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst2.id,
            sessionID: sid,
            type: "text",
            text: "Done.",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "cidoo_repro",
        initial_message: "go",
      })
      yield* Effect.sleep(80)

      const drained = yield* control.drainMailbox(root.id)
      // Exactly ONE notification from the child path.
      const fromChild = drained.filter((m) => String(m.author) === "/root/cidoo_repro")
      expect(fromChild).toHaveLength(1)
      const note = fromChild[0]!
      // The actual deliverable (report body) landed in the parent's
      // mailbox — NOT just the second-turn "Done." message.
      expect(note.content).toContain("FULL REPORT BODY")
    }),
  )

  // INV-D-06-regression-ses_1d84f236bffe — Demo 2 (The People v.
  // Frankfurter) sibling-deadlock reproduction. Prosecutor and defense
  // both filed openings to /root and then idled, each waiting for the
  // other's reply that never arrived. This test pins the doctrine that
  // the deadlock IS the runtime's correct unicast behavior: each sibling
  // addresses /root, root receives BOTH openings, and neither sibling's
  // mailbox ever receives the other's message (the runtime does not
  // broadcast). The bug was in PROSE — the prompts did not tell the
  // model to address peers directly. Wave 1 D7 fixed the prose; this
  // regression locks the runtime contract that made the prose fix the
  // right fix.
  it.instance("INV-D-06-regression-ses_1d84f236bffe", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "frankfurter" })
      yield* control.registerSessionRoot(root.id)

      const prosecutor = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "prosecutor",
        initial_message: "prosecutor init",
      })
      const defense = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "defense",
        initial_message: "defense init",
      })
      // Drain spawn-seed mailboxes on BOTH siblings and on root so the
      // post-send drains reflect ONLY the openings this test issues.
      yield* control.drainMailbox(prosecutor.thread_id)
      yield* control.drainMailbox(defense.thread_id)
      yield* control.drainMailbox(root.id)

      const prosecutorPath = prosecutor.metadata.agent_path ?? AgentPath.root()
      const defensePath = defense.metadata.agent_path ?? AgentPath.root()

      // Each sibling addresses /root with its opening (the Demo 2 shape:
      // both filings land at root, no sibling-to-sibling sends).
      yield* control.sendInterAgentCommunication(
        root.id,
        new InterAgentCommunication({
          author: prosecutorPath,
          recipient: AgentPath.root(),
          content: "prosecutor opening",
          trigger_turn: false,
          sent_at: 1,
        }),
        prosecutor.thread_id,
      )
      yield* control.sendInterAgentCommunication(
        root.id,
        new InterAgentCommunication({
          author: defensePath,
          recipient: AgentPath.root(),
          content: "defense opening",
          trigger_turn: false,
          sent_at: 2,
        }),
        defense.thread_id,
      )

      const drainRoot = yield* control.drainMailbox(root.id)
      const drainProsecutor = yield* control.drainMailbox(prosecutor.thread_id)
      const drainDefense = yield* control.drainMailbox(defense.thread_id)

      // Root received BOTH openings (one per unicast send).
      expect(drainRoot).toHaveLength(2)
      expect(drainRoot.map((m) => m.content).sort()).toEqual([
        "defense opening",
        "prosecutor opening",
      ])
      // The unicast invariant — neither sibling addressed the other, so
      // both sibling mailboxes stay empty. This is the runtime contract
      // that made the Demo 2 deadlock a prose bug, not a runtime bug.
      expect(drainProsecutor).toHaveLength(0)
      expect(drainDefense).toHaveLength(0)
    }),
  )

  // INV-D-09 — wait_for_reply pairs a reply to a request via correlation_id.
  // Parent and child exchange messages with matching correlation_id; the
  // parent's wait_for_reply call wakes on the matching reply, returns the
  // body, and the matched message stays in the mailbox so the next turn's
  // drain delivers it to the model. A second wait_for_reply for the same
  // correlation_id returns immediately with the queued message.
  it.instance("INV-D-09-correlation-id-pairs-reply-to-request", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "replier",
        initial_message: "init",
      })
      // Drain spawn-seed echoes so the rest of the test sees a clean state.
      yield* control.drainMailbox(child.thread_id)
      yield* control.drainMailbox(root.id)

      const childPath = child.metadata.agent_path ?? AgentPath.root()

      // Child replies to parent with matching correlation_id.
      yield* control.sendInterAgentCommunication(
        root.id,
        new InterAgentCommunication({
          author: childPath,
          recipient: AgentPath.root(),
          content: "the reply body",
          trigger_turn: false,
          sent_at: 1,
          correlation_id: "req-1",
        }),
        child.thread_id,
      )

      const def = yield* initWaitForReplyTool
      const ctx = makeCtx(root.id)
      const result = yield* def.execute({ correlation_id: "req-1", timeout_ms: 5000 }, ctx)

      // Matched: timed_out=false, output carries the body.
      expect(result.metadata.timed_out).toBe(false)
      expect(result.metadata.matched).toBe(true)
      expect(result.metadata.correlation_id).toBe("req-1")
      const payload = JSON.parse(result.output)
      expect(payload.timed_out).toBe(false)
      expect(payload.message).toBe("the reply body")
      expect(payload.correlation_id).toBe("req-1")

      // A second wait_for_reply for the same correlation_id returns
      // immediately with the still-queued message (idempotent within
      // mailbox lifetime — wait_for_reply does NOT drain).
      const result2 = yield* def.execute({ correlation_id: "req-1", timeout_ms: 5000 }, ctx)
      expect(result2.metadata.timed_out).toBe(false)
      expect(JSON.parse(result2.output).message).toBe("the reply body")
    }),
  )

  // INV-D-10 — wait_for_reply times out when no message carries the
  // matching correlation_id. An unrelated message arriving mid-wait
  // (different correlation_id) does NOT wake the targeted wait — the
  // filter operates on correlation_id, not on raw mailbox-seq updates.
  it.instance("INV-D-10-wait-for-reply-times-out-without-matching-correlation", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "noisy",
        initial_message: "init",
      })
      yield* control.drainMailbox(child.thread_id)
      yield* control.drainMailbox(root.id)

      const childPath = child.metadata.agent_path ?? AgentPath.root()

      // Schedule a NON-matching send mid-wait (correlation_id "other" — not
      // "req-1"). The targeted wait_for_reply must NOT wake on this.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("150 millis")
          yield* control.sendInterAgentCommunication(
            root.id,
            new InterAgentCommunication({
              author: childPath,
              recipient: AgentPath.root(),
              content: "unrelated traffic",
              trigger_turn: false,
              sent_at: 2,
              correlation_id: "other",
            }),
            child.thread_id,
          )
        }),
      )

      const def = yield* initWaitForReplyTool
      const ctx = makeCtx(root.id)
      const start = Date.now()
      const result = yield* def.execute({ correlation_id: "req-1", timeout_ms: 1000 }, ctx)
      const elapsed = Date.now() - start

      // Filter rejected the non-matching message; wait ran the full timeout.
      expect(result.metadata.timed_out).toBe(true)
      expect(result.metadata.matched).toBe(false)
      expect(elapsed).toBeGreaterThan(900)
      expect(elapsed).toBeLessThan(2000)
      const payload = JSON.parse(result.output)
      expect(payload.timed_out).toBe(true)

      // The unrelated message still landed in the mailbox (the seq advance
      // works; only the wait_for_reply filter ignored it). Drain confirms.
      const drained = yield* control.drainMailbox(root.id)
      const unrelated = drained.find((m) => m.correlation_id === "other")
      expect(unrelated).toBeDefined()
    }),
  )

  // INV-D-11 — wait_agent emits a structured warning when timeout_ms is
  // omitted OR exceeds MAX_WAIT_TIMEOUT_MS. The warning rides in result
  // metadata; the call still completes (informational, not fatal).
  it.instance("INV-D-11-missing-timeout-on-wait-emits-warning", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      // Pre-pending mailbox so the wait returns immediately and we can
      // read the warning without waiting the full default 30s.
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "warned",
        initial_message: "seed",
      })

      const def = yield* initWaitTool
      const ctx = makeCtx(child.thread_id)

      // Sub-case A: omitted timeout_ms → metadata.warning === "missing_timeout".
      const r1 = yield* def.execute({}, ctx)
      expect((r1.metadata as { warning?: string }).warning).toBe("missing_timeout")
      // Call still completed normally.
      expect(r1.metadata.timed_out).toBe(false)

      // Re-spawn a fresh child for sub-case B (the prior child's mailbox
      // was already drained by the wait call).
      const child2 = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "warned2",
        initial_message: "seed",
      })
      const ctx2 = makeCtx(child2.thread_id)

      // Sub-case B: timeout_ms above MAX (>600000) → metadata.warning ===
      // "timeout_clamped". Use 1_000_000 (well above cap).
      const r2 = yield* def.execute({ timeout_ms: 1_000_000 }, ctx2)
      expect((r2.metadata as { warning?: string }).warning).toBe("timeout_clamped")
      expect(r2.metadata.timed_out).toBe(false)
    }),
  )

  // INV-D-12 (actor-discipline-2026-05-20 Wave 4) — D11 ABORT protocol.
  // Child runLoop emits an assistant message whose body ends with
  // `ABORT(spec_wrong): details here.` on the LAST line. The
  // completion-watcher (control.ts:907-928) parses the set-phrase via
  // parseAbortReason (control.ts:221) and rides the structured payload
  // alongside the human-readable `content`. Asserts both surfaces:
  // (a) note.abort_reason carries { reason: 'spec_wrong', details: '…' };
  // (b) note.content still contains the literal `ABORT(spec_wrong)` so
  // legacy consumers (TUI, log scrapers) keep working.
  it.instance("INV-D-12-abort-reason-delivered-as-structured-payload", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "tool-calls",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "Some preamble.\nABORT(spec_wrong): details here.",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "aborter",
        initial_message: "go",
      })
      yield* Effect.sleep(80)

      const drained = yield* control.drainMailbox(root.id)
      const note = drained.find((m) => String(m.author) === "/root/aborter")
      expect(note).toBeDefined()
      expect(note?.abort_reason?.reason).toBe("spec_wrong")
      expect(note?.abort_reason?.details).toBe("details here.")
      // Legacy consumers still see the literal phrase inside the body.
      expect(note?.content).toContain("ABORT(spec_wrong)")
    }),
  )

  // INV-D-13 (actor-discipline-2026-05-20 Wave 4) — stub orchestrator
  // pivot on ABORT(approach_failed). Validates the supervisor recovery
  // pattern: child reports approach_failed, parent reads structured
  // abort_reason, records a pivot in a local audit array, respawns with a
  // refined initial_message under a NON-colliding task_name (pivot_v2),
  // and the respawn delivers a normal completion (no ABORT). No real git,
  // no real ChildProcess — purely orchestration semantics.
  it.instance("INV-D-13-orchestrator-pivots-on-abort-approach-failed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      // Shared runLoop drives BOTH children: the first emits ABORT, the
      // second (the pivot) emits a normal completion. Branch on the
      // initial_message contents (which the runLoop can't read directly
      // — task_name discrimination happens via session distinctness):
      // we simply count loop invocations via a closure-local counter.
      let loopInvocation = 0
      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const which = ++loopInvocation
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "tool-calls",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text:
              which === 1
                ? "tried approaches A, B, C.\nABORT(approach_failed): tried 3 attempts, recommend reset."
                : "pivot delivered cleanly.",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      // First child — the one that ABORTs.
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "pivot",
        initial_message: "go",
      })
      yield* Effect.sleep(80)

      const drained1 = yield* control.drainMailbox(root.id)
      const first = drained1.find((m) => String(m.author) === "/root/pivot")
      expect(first).toBeDefined()
      expect(first?.abort_reason?.reason).toBe("approach_failed")
      expect(first?.abort_reason?.details).toBe("tried 3 attempts, recommend reset.")

      // Stub orchestrator decision logic — local mutable audit array.
      const audit: string[] = []
      if (first?.abort_reason?.reason === "approach_failed") {
        audit.push(`pivot:${first.abort_reason.reason}`)
      }
      expect(audit).toEqual(["pivot:approach_failed"])

      // Respawn under a fresh task_name with a refined message derived
      // from the abort details. Different path → no collision with the
      // first child's `/root/pivot`.
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "pivot_v2",
        initial_message: `retry with context: ${first?.abort_reason?.details}`,
      })
      yield* Effect.sleep(80)

      const drained2 = yield* control.drainMailbox(root.id)
      const second = drained2.find((m) => String(m.author) === "/root/pivot_v2")
      expect(second).toBeDefined()
      expect(second?.abort_reason).toBeUndefined()
      expect(second?.content).toContain("pivot delivered cleanly.")
    }),
  )

  // INV-D-14 (actor-discipline-2026-05-20 Wave 4) — set-phrase ladder is
  // agent-type-agnostic. The registry differentiates agent types at the
  // prompt-selection layer (general/anthropic.txt, general/gemini.txt,
  // explore.txt), but the runtime parseAbortReason at control.ts:221
  // operates on bytes — it cannot distinguish "I was spawned as explore"
  // from "I was spawned as general". This test exercises that property
  // by spawning two children under different task_names through the
  // same AgentControl.spawnAgent path (which has no agent_type
  // parameter — that lives at the tool layer). Both children's runLoops
  // emit identical ABORT(out_of_scope) phrases; both notifications must
  // carry the structured payload. Agent-type prose coverage lives in
  // the prose grep suite added in this same commit.
  it.instance("INV-D-14-set-phrase-ladder-extended-to-all-subagent-types", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "tool-calls",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "preamble.\nABORT(out_of_scope): test",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      // Two spawns under distinct task_names. Both share the same runLoop
      // (one registerRunLoop call above) — the parser path is the same.
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "g14",
        initial_message: "go",
      })
      yield* Effect.sleep(80)
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "e14",
        initial_message: "go",
      })
      yield* Effect.sleep(80)

      const drained = yield* control.drainMailbox(root.id)
      const noteG = drained.find((m) => String(m.author) === "/root/g14")
      const noteE = drained.find((m) => String(m.author) === "/root/e14")
      expect(noteG).toBeDefined()
      expect(noteE).toBeDefined()
      expect(noteG?.abort_reason?.reason).toBe("out_of_scope")
      expect(noteG?.abort_reason?.details).toBe("test")
      expect(noteE?.abort_reason?.reason).toBe("out_of_scope")
      expect(noteE?.abort_reason?.details).toBe("test")
    }),
  )

  // INV-D-15 (actor-discipline-2026-05-20 Wave 5) — D12 on_failure:"respawn"
  // restarts a crashed child at the same task_name with a fresh session id.
  // Pattern mirrors INV-D-13: a single registerRunLoop drives BOTH spawn
  // attempts; a closure-local counter discriminates them. First invocation
  // `Effect.die`s before any assistant message — the runtime status goes
  // errored → completion-watcher dispatches the respawn branch. Second
  // invocation emits a normal assistant message + returns "done".
  // Assertions cover:
  //   (a) loop ran twice (initial + 1 respawn)
  //   (b) resolveAgentReference for /root/respawner now returns a SessionID
  //       distinct from the originally returned child.thread_id (the slot
  //       was re-issued)
  //   (c) parent mailbox carries a transient_tool_error respawn note
  //       (`attempt 1/3`) AND the SECOND completion notification (normal
  //       completion of the replacement child)
  it.instance("INV-D-15-spawn-agent-with-on-failure-respawn-restarts-on-crash", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      let counter = 0
      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          counter += 1
          if (counter === 1) return yield* Effect.die("first crash")
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "tool-calls",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "respawned ok",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "respawner",
        initial_message: "go",
        on_failure: "respawn",
      })
      yield* Effect.sleep(150)

      // (a) Initial crash + one respawn = 2 loop invocations.
      expect(counter).toBe(2)

      // (b) The replacement child holds a different session id under the
      // same /root/respawner path. resolveAgentReference walks the live
      // registry; the original child.thread_id was released by the
      // respawn branch in control.ts.
      const resolved = yield* control.resolveAgentReference(
        AgentPath.root(),
        "/root/respawner",
        root.id,
      )
      expect(resolved).not.toBe(child.thread_id)

      // (c) Mailbox carries both the transient_tool_error respawn note
      // (`attempt 1/3`) AND the normal completion notification from the
      // replacement child.
      const drained = yield* control.drainMailbox(root.id)
      const fromChild = drained.filter(
        (m) => String(m.author) === String(child.metadata.agent_path),
      )
      const respawnNote = fromChild.find(
        (m) => m.abort_reason?.reason === "transient_tool_error",
      )
      expect(respawnNote).toBeDefined()
      expect(respawnNote?.abort_reason?.details).toMatch(/respawned after crash; attempt 1\/3/)
      // Second notification = normal completion (no abort_reason).
      const completionNote = fromChild.find(
        (m) => m !== respawnNote && m.abort_reason === undefined,
      )
      expect(completionNote).toBeDefined()
    }),
  )

  // INV-D-16 (actor-discipline-2026-05-20 Wave 5) — D12
  // pool_strategy:"one_for_all" STUB form. Full one_for_all behavior
  // (sibling teardown on a single failure) lands in Wave 6 when
  // `spawn_pool` is wired. Here we pin two invariants:
  //   (i) the param is accepted at the spawn surface (no decode / runtime
  //       errors)
  //   (ii) the spawn surface is unchanged when the policy is set — both
  //        children land in the registry with distinct agent_paths.
  it.instance("INV-D-16-pool-strategy-one-for-all-kills-pair-on-single-failure", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      const childA = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "pair_a",
        initial_message: "go a",
        pool_strategy: "one_for_all",
      })
      const childB = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "pair_b",
        initial_message: "go b",
        pool_strategy: "one_for_all",
      })

      // Both spawns returned LiveAgent values with valid thread_ids — the
      // policy did not break the spawn surface.
      expect(childA.thread_id).toBeDefined()
      expect(childB.thread_id).toBeDefined()
      const pathA = childA.metadata.agent_path
      const pathB = childB.metadata.agent_path
      expect(pathA).toBeDefined()
      expect(pathB).toBeDefined()
      expect(String(pathA)).not.toBe(String(pathB))
    }),
  )

  // INV-D-17 (actor-discipline-2026-05-20 Wave 5) — D12
  // pool_strategy:"one_for_one" STUB form. Full one_for_one runtime
  // enforcement lands in Wave 6; today the policy is the runtime's
  // default isolation behavior. This test pins that storing the param
  // does NOT break sibling isolation — all three children spawn
  // successfully AND remain alive after a short sleep (no tear-down
  // cascade).
  it.instance("INV-D-17-pool-strategy-one-for-one-isolates-failures", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      const c1 = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "iso_1",
        initial_message: "go 1",
        pool_strategy: "one_for_one",
      })
      const c2 = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "iso_2",
        initial_message: "go 2",
        pool_strategy: "one_for_one",
      })
      const c3 = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "iso_3",
        initial_message: "go 3",
        pool_strategy: "one_for_one",
      })

      // All three spawn calls returned LiveAgent values with a non-final
      // status (installNeverLoop → status stays running / pending_init).
      expect(AgentStatus.isFinal(c1.status)).toBe(false)
      expect(AgentStatus.isFinal(c2.status)).toBe(false)
      expect(AgentStatus.isFinal(c3.status)).toBe(false)

      yield* Effect.sleep(100)

      // After the sleep, all three remain alive — sibling isolation is
      // preserved. subscribeStatus reads the live SubscriptionRef the
      // run-loop fiber owns.
      const r1 = yield* control.subscribeStatus(c1.thread_id)
      const r2 = yield* control.subscribeStatus(c2.thread_id)
      const r3 = yield* control.subscribeStatus(c3.thread_id)
      const s1 = yield* SubscriptionRef.get(r1)
      const s2 = yield* SubscriptionRef.get(r2)
      const s3 = yield* SubscriptionRef.get(r3)
      expect(AgentStatus.isFinal(s1)).toBe(false)
      expect(AgentStatus.isFinal(s2)).toBe(false)
      expect(AgentStatus.isFinal(s3)).toBe(false)
    }),
  )

  // INV-D-18 (actor-discipline-2026-05-20 Wave 6) — spawn_pool collect=all
  // aggregates deliverables from every member. Each worker's runLoop pushes
  // a unique payload to the parent's mailbox via sendInterAgentCommunication
  // (the same code path the send_message tool uses). collectPool with
  // { type: "all" } drains until every member has authored a deliverable.
  // Assertions: 3 deliverables; contents are the three worker payloads;
  // delivered_at ordering is monotonic (matches the +counter stagger we
  // bake into sent_at); every worker_path is one of the spawned members.
  it.instance("INV-D-18-spawn-pool-collect-all-aggregates-results", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "pool_root" })
      yield* control.registerSessionRoot(root.id)

      let counter = 0
      yield* control.registerRunLoop((childSid) =>
        Effect.gen(function* () {
          const myCounter = ++counter
          const meta = yield* control.getAgentMetadata(childSid)
          const myPath = meta?.agent_path
          if (!myPath) return "skipped"
          yield* control
            .sendInterAgentCommunication(
              root.id,
              new InterAgentCommunication({
                author: myPath,
                recipient: AgentPath.root(),
                content: `worker_${myCounter}_payload`,
                trigger_turn: false,
                sent_at: Date.now() + myCounter,
              }),
              childSid,
            )
            .pipe(Effect.orDie)
          return "delivered"
        }),
      )

      // Drain any incidental seed messages before creating the pool so the
      // collect loop only sees pool-member deliverables.
      yield* control.drainMailbox(root.id)

      const created = yield* control.createPool({
        parentID: root.id,
        parentPath: AgentPath.root(),
        count: 3,
        common_message: "go",
      })
      expect(created.members.length).toBe(3)
      expect(created.failures.length).toBe(0)

      const collected = yield* control.collectPool(
        created.pool_id,
        root.id,
        { type: "all" },
        10_000,
      )

      expect(collected.timed_out).toBe(false)
      expect(collected.deliverables.length).toBe(3)

      const contents = collected.deliverables.map((d) => d.content).sort()
      expect(contents).toEqual([
        "worker_1_payload",
        "worker_2_payload",
        "worker_3_payload",
      ])

      // collectPool sorts by delivered_at — the +myCounter we baked into
      // sent_at guarantees monotonic order.
      const times = collected.deliverables.map((d) => d.delivered_at)
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!)
      }

      // Every reported worker_path is one of the spawned members.
      const memberPaths = new Set(
        created.members.map((m) => String(m.metadata.agent_path)),
      )
      for (const d of collected.deliverables) {
        expect(memberPaths.has(String(d.worker_path))).toBe(true)
      }
    }),
  )

  // INV-D-19 (actor-discipline-2026-05-20 Wave 6) — spawn_pool collect=first
  // returns the first deliverable, and closePoolMembers tears down the
  // non-winners. Only the first invocation of the runLoop sends a payload;
  // workers 2+3 idle in Effect.never. collectPool returns after the first
  // arrival; closePoolMembers(..., except: winnerID) then closes everyone
  // else. After a 100ms grace, the non-winners' status reads `shutdown`
  // (or their slot is fully released → AgentNotFoundError). Winner
  // survives.
  it.instance("INV-D-19-spawn-pool-collect-first-cancels-remaining", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "race_root" })
      yield* control.registerSessionRoot(root.id)

      let invocation = 0
      yield* control.registerRunLoop((childSid) =>
        Effect.gen(function* () {
          const which = ++invocation
          if (which === 1) {
            yield* Effect.sleep(20)
            const meta = yield* control.getAgentMetadata(childSid)
            const myPath = meta?.agent_path
            if (!myPath) return "skipped"
            yield* control
              .sendInterAgentCommunication(
                root.id,
                new InterAgentCommunication({
                  author: myPath,
                  recipient: AgentPath.root(),
                  content: "first_winner",
                  trigger_turn: false,
                  sent_at: Date.now(),
                }),
                childSid,
              )
              .pipe(Effect.orDie)
            return "won"
          }
          return yield* Effect.never
        }),
      )

      yield* control.drainMailbox(root.id)

      const created = yield* control.createPool({
        parentID: root.id,
        parentPath: AgentPath.root(),
        count: 3,
        common_message: "race",
      })
      expect(created.members.length).toBe(3)

      const collected = yield* control.collectPool(
        created.pool_id,
        root.id,
        { type: "first" },
        5_000,
      )
      expect(collected.timed_out).toBe(false)
      expect(collected.deliverables.length).toBe(1)
      expect(collected.deliverables[0]!.content).toBe("first_winner")

      const winnerID = collected.deliverables[0]!.worker_session_id

      // closePoolMembers closes every member except the winner.
      yield* control.closePoolMembers(created.pool_id, root.id, winnerID)
      yield* Effect.sleep(100)

      // Non-winners must be shut down: subscribeStatus either returns
      // status="shutdown" (slot retained with terminal status) OR fails
      // with AgentNotFoundError (slot fully released). Both are valid
      // teardown outcomes.
      for (const m of created.members) {
        if (m.thread_id === winnerID) continue
        const refResult = yield* Effect.result(
          control.subscribeStatus(m.thread_id),
        )
        if (Result.isSuccess(refResult)) {
          const status = yield* SubscriptionRef.get(refResult.success)
          expect(status).toBe("shutdown")
        } else {
          expect(refResult.failure._tag).toBe("AgentNotFoundError")
        }
      }

      // Winner survived — subscribeStatus succeeds and status is not
      // "shutdown" (the runLoop reached terminal `completed` via the
      // "won" return).
      const winnerRefResult = yield* Effect.result(
        control.subscribeStatus(winnerID),
      )
      if (Result.isSuccess(winnerRefResult)) {
        const winnerStatus = yield* SubscriptionRef.get(winnerRefResult.success)
        expect(winnerStatus).not.toBe("shutdown")
      }
    }),
  )

  // INV-D-20 (actor-discipline-2026-05-20 Wave 6) — spawn_pool's
  // PermissionKey collapses onto the existing `task` group. Two assertions
  // prove the collapse without requiring a live spawn (the runtime spawn
  // flow needs full Permission.Service plumbing the integration harness
  // doesn't stand up):
  //   (1) Permission.evaluate("task", "explore", ruleset) returns "allow"
  //       when user config is `permission.task: { explore: allow }` — any
  //       tool whose PermissionKey === "task" (spawn_pool, spawn_agent,
  //       send_message, …) reads from the SAME group key, so no per-tool
  //       rule re-declaration is needed.
  //   (2) Permission.disabled(["spawn_pool", "spawn_agent", "task",
  //       "read"], [{permission:"task", pattern:"*", action:"deny"}])
  //       strips spawn_pool alongside the other MULTI_AGENT_TOOLS — if
  //       spawn_pool were NOT in MULTI_AGENT_TOOLS, the lookup would fall
  //       through to its own literal key and the wildcard task deny would
  //       NOT strip it. The fact that the deny strips it proves the
  //       collapse.
  it.instance("INV-D-20-spawn-pool-permission-collapses-to-task", () =>
    Effect.gen(function* () {
      // (1) evaluate — user's task rule resolves for explore agent_type.
      const ruleset: PermissionTypes.Ruleset = [
        { permission: "task", pattern: "explore", action: "allow" },
      ]
      const rule = Permission.evaluate("task", "explore", ruleset)
      expect(rule.action).toBe("allow")

      // (2) disabled — wildcard task deny strips spawn_pool.
      const disabled = Permission.disabled(
        ["spawn_pool", "spawn_agent", "task", "read"],
        [{ permission: "task", pattern: "*", action: "deny" }],
      )
      expect(disabled.has("spawn_pool")).toBe(true)
      expect(disabled.has("spawn_agent")).toBe(true)
      expect(disabled.has("task")).toBe(true)
      // Tools outside the task group are unaffected (sanity).
      expect(disabled.has("read")).toBe(false)
    }),
  )

  // INV-D-21 (actor-discipline-2026-05-20 Wave 7) — D14 link-paired-death.
  // Three sub-assertions in one test (sub-cases share spawn/link plumbing
  // and are quick — splitting would just duplicate setup):
  //   (a) Crash peer_a → within ~200ms peer_b is closed, parent's mailbox
  //       contains a peer_b notification whose body header reads
  //       `reached status: linked_death`.
  //   (b) Symmetric: a fresh pair where crashing peer_b kills peer_a.
  //   (c) Unlink before crash → no cascade; peer_b stays alive.
  // Pattern mirrors INV-D-15: single registerRunLoop, closure variable
  // (`crashTarget: SessionID | undefined`) discriminates which fiber
  // Effect.die's; non-crashers loop on Effect.sleep so the runtime gets
  // turn boundaries to dispatch the crash. The completion watcher's
  // cascade fires only when isShutdown is false (errored / completed) —
  // Effect.die maps to errored, which is the trigger.
  it.instance("INV-D-21-link-paired-death-on-either-crash", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      let crashTarget: SessionID | undefined = undefined
      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          yield* Effect.sleep(10)
          if (crashTarget === sid) return yield* Effect.die("link cascade crash")
        }).pipe(Effect.forever),
      )

      // ----- (a) crash peer_a → peer_b cascades closed with linked_death.
      const root = yield* sessions.create({ title: "link_root_a" })
      yield* control.registerSessionRoot(root.id)
      const peerA = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "peer_a",
        initial_message: "go a",
      })
      const peerB = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "peer_b",
        initial_message: "go b",
      })
      yield* control.linkAgents(peerA.thread_id, peerB.thread_id, root.id)
      // Confirm linkAgents stored the symmetric edge.
      const linksA = yield* control.agentLinks(peerA.thread_id, root.id)
      expect(linksA).toContain(peerB.thread_id)
      const linksB = yield* control.agentLinks(peerB.thread_id, root.id)
      expect(linksB).toContain(peerA.thread_id)

      crashTarget = peerA.thread_id
      yield* Effect.sleep(300)

      // peer_b's status must read shutdown — the cascade closed it.
      const refB = yield* control.subscribeStatus(peerB.thread_id)
      const statusB = yield* SubscriptionRef.get(refB)
      expect(statusB).toBe("shutdown")

      // Parent mailbox carries the peer_b notification with the
      // linked_death label in its header. Note the body can be
      // safety-net-wrapped (peer_b never emitted assistant text → empty
      // body → warning prefix), so we match by `reached status:` rather
      // than `startsWith("Agent ")`.
      const drained = yield* control.drainMailbox(root.id)
      const peerBNote = drained.find(
        (m) =>
          String(m.author) === String(peerB.metadata.agent_path) &&
          m.content.includes("reached status:"),
      )
      expect(peerBNote).toBeDefined()
      expect(peerBNote?.content).toContain("reached status: linked_death")

      // ----- (b) symmetric: crash peer_b first → peer_a cascades closed.
      crashTarget = undefined
      const root2 = yield* sessions.create({ title: "link_root_b" })
      yield* control.registerSessionRoot(root2.id)
      const peerA2 = yield* control.spawnAgent({
        parentID: root2.id,
        parentPath: AgentPath.root(),
        task_name: "peer_a",
        initial_message: "go a",
      })
      const peerB2 = yield* control.spawnAgent({
        parentID: root2.id,
        parentPath: AgentPath.root(),
        task_name: "peer_b",
        initial_message: "go b",
      })
      yield* control.linkAgents(peerA2.thread_id, peerB2.thread_id, root2.id)
      crashTarget = peerB2.thread_id
      yield* Effect.sleep(300)
      const refA2 = yield* control.subscribeStatus(peerA2.thread_id)
      const statusA2 = yield* SubscriptionRef.get(refA2)
      expect(statusA2).toBe("shutdown")
      const drained2 = yield* control.drainMailbox(root2.id)
      const peerANote = drained2.find(
        (m) =>
          String(m.author) === String(peerA2.metadata.agent_path) &&
          m.content.includes("reached status:"),
      )
      expect(peerANote).toBeDefined()
      expect(peerANote?.content).toContain("reached status: linked_death")

      // ----- (c) unlink before crash → no cascade.
      crashTarget = undefined
      const root3 = yield* sessions.create({ title: "link_root_c" })
      yield* control.registerSessionRoot(root3.id)
      const peerA3 = yield* control.spawnAgent({
        parentID: root3.id,
        parentPath: AgentPath.root(),
        task_name: "peer_a",
        initial_message: "go a",
      })
      const peerB3 = yield* control.spawnAgent({
        parentID: root3.id,
        parentPath: AgentPath.root(),
        task_name: "peer_b",
        initial_message: "go b",
      })
      yield* control.linkAgents(peerA3.thread_id, peerB3.thread_id, root3.id)
      yield* control.unlinkAgents(peerA3.thread_id, peerB3.thread_id, root3.id)
      // After unlink the adjacency is empty.
      const linksA3 = yield* control.agentLinks(peerA3.thread_id, root3.id)
      expect(linksA3).not.toContain(peerB3.thread_id)
      crashTarget = peerA3.thread_id
      yield* Effect.sleep(300)
      const refB3 = yield* control.subscribeStatus(peerB3.thread_id)
      const statusB3 = yield* SubscriptionRef.get(refB3)
      // peer_b stays alive — its loop kept Effect.forever-ing on sleep.
      expect(AgentStatus.isFinal(statusB3)).toBe(false)
    }),
  )

  // INV-D-22 (actor-discipline-2026-05-20 Wave 7) — D15 bounded mailbox
  // backpressure. Spawn a child with `mailbox_capacity: 4`; fire 4 sends
  // → all succeed; the 5th send returns Effect.result failure carrying
  // MailboxFullError. peek shows 4 items in delivery order. The 6th send
  // still fails. After draining, sends succeed again.
  it.instance("INV-D-22-bounded-mailbox-rejects-on-overflow", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const root = yield* sessions.create({ title: "cap_root" })
      yield* control.registerSessionRoot(root.id)

      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "capped",
        initial_message: "seed",
        mailbox_capacity: 4,
      })

      // Drain the initial-message seed first — it occupies the system
      // slot but counts against the same underlying queue. Mailbox now
      // has 0 user messages and 4 cap.
      yield* control.drainMailbox(child.thread_id)

      const send = (n: number) =>
        control.sendInterAgentCommunication(
          child.thread_id,
          new InterAgentCommunication({
            author: AgentPath.root(),
            recipient: child.metadata.agent_path!,
            content: `msg_${n}`,
            trigger_turn: false,
            sent_at: Date.now() + n,
          }),
          root.id,
        )

      // 4 sends succeed.
      for (let i = 1; i <= 4; i++) {
        const r = yield* Effect.result(send(i))
        expect(Result.isSuccess(r)).toBe(true)
      }

      // 5th send fails with MailboxFullError.
      const fifth = yield* Effect.result(send(5))
      expect(Result.isFailure(fifth)).toBe(true)
      if (Result.isFailure(fifth)) {
        expect(fifth.failure._tag).toBe("MailboxFullError")
      }

      // 6th send still fails (cap unchanged).
      const sixth = yield* Effect.result(send(6))
      expect(Result.isFailure(sixth)).toBe(true)
      if (Result.isFailure(sixth)) {
        expect(sixth.failure._tag).toBe("MailboxFullError")
      }

      // Drain → frees capacity → subsequent sends succeed again.
      const drained = yield* control.drainMailbox(child.thread_id)
      // The 4 queued items appear in delivery order (msg_1 .. msg_4).
      const contents = drained
        .filter((m) => m.content.startsWith("msg_"))
        .map((m) => m.content)
      expect(contents).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])

      const seventh = yield* Effect.result(send(7))
      expect(Result.isSuccess(seventh)).toBe(true)
    }),
  )

  // INV-D-23 (actor-discipline-2026-05-20 Wave 7) — bounded-mailbox cap
  // does NOT block completion notifications. Fill the parent's mailbox
  // to capacity, then crash a child. The completion watcher posts the
  // notification via the `sendSystem` (flags.system=true) path which
  // bypasses the cap — so the parent's mailbox grows past capacity and
  // the "reached status:" notification arrives.
  it.instance("INV-D-23-bounded-mailbox-does-not-block-completion-notification", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      // Single-shot crash loop — the runLoop dies on first dispatch so
      // status flips to errored and the completion watcher fires.
      yield* control.registerRunLoop(() =>
        Effect.gen(function* () {
          yield* Effect.sleep(10)
          return yield* Effect.die("d23 crash")
        }),
      )

      // Root mailbox uses MAILBOX_DEFAULT_CAPACITY=32 — we don't have a
      // per-root override surface (ensureRootSlot calls Mailbox.make()
      // with no arg). Fill to default capacity via system sends so the
      // user-cap path is saturated and any further `send` would fail.
      // We use Mailbox directly through control.sendInterAgentCommunication
      // with system:true to pre-load — the test point is that the
      // completion watcher posts ITS notification via the bypass path
      // even though the user queue is full.
      const root = yield* sessions.create({ title: "d23_root" })
      yield* control.registerSessionRoot(root.id)

      // Spawn a second never-loop child to be the sender. We can't
      // address /root from /root with the user-send path (the sender
      // and target must share a root — they do here — but root is its
      // own slot, so this is fine). Pre-fill the root mailbox to cap.
      // Note: the cap is 32 default; we use 32 to saturate.
      for (let i = 0; i < 32; i++) {
        yield* control
          .sendInterAgentCommunication(
            root.id,
            new InterAgentCommunication({
              author: AgentPath.root(),
              recipient: AgentPath.root(),
              content: `prefill_${i}`,
              trigger_turn: false,
              sent_at: Date.now() + i,
            }),
            root.id,
          )
          .pipe(Effect.catch(() => Effect.void))
      }

      // Confirm the mailbox is at cap by attempting one more USER send
      // and verifying it fails with MailboxFullError.
      const overflow = yield* Effect.result(
        control.sendInterAgentCommunication(
          root.id,
          new InterAgentCommunication({
            author: AgentPath.root(),
            recipient: AgentPath.root(),
            content: "should_fail",
            trigger_turn: false,
            sent_at: Date.now(),
          }),
          root.id,
        ),
      )
      expect(Result.isFailure(overflow)).toBe(true)
      if (Result.isFailure(overflow)) {
        expect(overflow.failure._tag).toBe("MailboxFullError")
      }

      // Spawn the crash-on-first-tick child. The runLoop dies → errored
      // → completion watcher posts notification via sendSystem (bypass).
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "crasher",
        initial_message: "go",
      })
      yield* Effect.sleep(300)

      // Drain and look for the completion notification on the parent's
      // mailbox. Its presence proves system-bypass works under
      // backpressure. The body may carry the safety-net warning prefix
      // (no assistant text emitted) so we match on the header substring
      // rather than `startsWith("Agent ")`.
      const drained = yield* control.drainMailbox(root.id)
      const completion = drained.find(
        (m) =>
          String(m.author) === String(child.metadata.agent_path) &&
          m.content.includes("reached status:"),
      )
      expect(completion).toBeDefined()
    }),
  )

  // INV-D-24 (actor-discipline-2026-05-20 Wave 8) — D16 behavior contract
  // validated at terminal-status time. WAVE.md gotcha 1: validation runs
  // at TERMINAL time (not at spawn time) — spawnAgent always succeeds, the
  // violation is observed AFTER the child reaches a final status via the
  // completion-watcher attaching a structured `behavior_violation` payload
  // to the parent's notification. WAVE.md gotcha 2: existing tests that
  // OMIT `agent_type` continue to work — this test intentionally PASSES
  // `agent_type: "general"` to OPT IN to validation. WAVE.md gotcha 4: D5
  // safety-net prose warning and D16 structured violation are independent
  // — both can fire on the same case (the body is empty so D5 may also
  // emit its warning prefix); the D16 assertion is about the structured
  // `behavior_violation` field, which is authoritative.
  //
  // Stub runLoop writes ONE assistant text + exits. Does NOT call
  // send_message → contract `send_message_required` is violated → parent
  // mailbox notification carries `behavior_violation.violations[0].kind
  // === "missing_delivery"` against `contract_version === "subagent_v1"`
  // (general's default).
  it.instance("INV-D-24-agent-type-behavior-contract-validated-at-spawn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "stop",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "did some work but never delivered",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "g24",
        agent_type: "general",
        initial_message: "go",
      })
      yield* Effect.sleep(80)

      const drained = yield* control.drainMailbox(root.id)
      const note = drained.find((m) => String(m.author) === "/root/g24")
      expect(note).toBeDefined()
      expect(note?.content).toContain("reached status:")
      expect(note?.behavior_violation).toBeDefined()
      expect(note?.behavior_violation?.contract_version).toBe("subagent_v1")
      expect(note?.behavior_violation?.violations.length).toBeGreaterThanOrEqual(1)
      expect(note?.behavior_violation?.violations[0]?.kind).toBe("missing_delivery")
    }),
  )

  // INV-D-25 (actor-discipline-2026-05-20 Wave 8) — D16 version coexistence.
  // WAVE.md gotcha 3: `subagent_v1` and `subagent_v2` declared
  // simultaneously under the same agent_type (`general` — see
  // behaviors.ts DEFAULT_CONTRACTS); each child uses its declared
  // version's contract (passed at spawn time via `behavior_version`).
  //
  // Both children share one stub runLoop that writes "preamble.\nABORT
  // (spec_wrong): test" — `spec_wrong` IS in BOTH v1 AND v2
  // declared_failure_modes (per behaviors.ts L115-135), so neither
  // child triggers `undeclared_failure_mode` noise that would distract
  // from the version-coexistence assertion. Neither child calls
  // send_message → both should carry `missing_delivery` under their
  // RESPECTIVE contract versions. No cross-contamination: v1child's
  // notification carries `"subagent_v1"` and NOT `"subagent_v2"`, and
  // vice versa.
  it.instance("INV-D-25-behavior-contract-version-bump-coexists-with-prior-version", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "stop",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "preamble.\nABORT(spec_wrong): test",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "v1child",
        agent_type: "general",
        behavior_version: "subagent_v1",
        initial_message: "go",
      })
      yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "v2child",
        agent_type: "general",
        behavior_version: "subagent_v2",
        initial_message: "go",
      })
      yield* Effect.sleep(150)

      const drained = yield* control.drainMailbox(root.id)
      const noteV1 = drained.find((m) => String(m.author) === "/root/v1child")
      const noteV2 = drained.find((m) => String(m.author) === "/root/v2child")
      expect(noteV1).toBeDefined()
      expect(noteV2).toBeDefined()

      // Each child validated against its declared version's contract.
      expect(noteV1?.behavior_violation?.contract_version).toBe("subagent_v1")
      expect(noteV2?.behavior_violation?.contract_version).toBe("subagent_v2")

      // Both carry a missing_delivery violation (neither called send_message).
      const v1Kinds = noteV1?.behavior_violation?.violations.map((v) => v.kind) ?? []
      const v2Kinds = noteV2?.behavior_violation?.violations.map((v) => v.kind) ?? []
      expect(v1Kinds).toContain("missing_delivery")
      expect(v2Kinds).toContain("missing_delivery")

      // No cross-contamination: v1child's notification must NOT mention
      // "subagent_v2" and vice versa. Stringify the whole envelope so we
      // catch the version label anywhere it might leak (contract_version,
      // violation detail strings, etc).
      const v1Str = JSON.stringify(noteV1)
      const v2Str = JSON.stringify(noteV2)
      expect(v1Str).not.toContain("subagent_v2")
      expect(v2Str).not.toContain("subagent_v1")
    }),
  )

  // INV-D-26 (actor-discipline-2026-05-20 Wave 8) — D16 violation does
  // NOT fail spawn. WAVE.md gotcha 1: spawnAgent MUST return cleanly
  // even when the child will subsequently violate its declared contract;
  // validation runs at TERMINAL-status time (the completion-watcher),
  // not at spawn time. The orchestrator observes the violation AFTER
  // spawn via the mailbox notification's `behavior_violation` payload
  // and decides whether to pivot / retry / ignore. Separates "violation
  // detected" from "what to do about it."
  //
  // Effect.result wrapper proves spawn returned a Success branch (no
  // Result.failure); the runLoop then writes one assistant message
  // (never calls send_message) → child reaches terminal status → parent
  // mailbox carries the completion notification with
  // `behavior_violation` populated.
  it.instance("INV-D-26-behavior-contract-violation-fails-orchestrated-wave-not-spawn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service

      yield* control.registerRunLoop((sid) =>
        Effect.gen(function* () {
          const user = {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: ref,
          }
          yield* sessions.updateMessage(user)
          const asst = {
            id: MessageID.ascending(),
            sessionID: sid,
            parentID: user.id,
            role: "assistant" as const,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            time: { created: Date.now(), completed: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            finish: "stop",
          }
          yield* sessions.updateMessage(asst)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: asst.id,
            sessionID: sid,
            type: "text",
            text: "one assistant message, no send_message",
          })
          return "done"
        }),
      )

      const root = yield* sessions.create({ title: "parent" })
      yield* control.registerSessionRoot(root.id)

      // Effect.result wrapper proves the spawn returns a Success even
      // though the runtime contract WILL be violated. Validation lives
      // at terminal-status time, not at spawn time.
      const spawned = yield* Effect.result(
        control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "g26",
          agent_type: "general",
          initial_message: "go",
        }),
      )
      expect(Result.isSuccess(spawned)).toBe(true)
      if (Result.isSuccess(spawned)) {
        expect(typeof spawned.success.thread_id).toBe("string")
        // Spawn returns the LiveAgent before terminal-status validation
        // — the status is non-final at this read point (the runLoop has
        // not yet completed, OR the registry returns the pre-terminal
        // status snapshot from registerRunLoop's first publish).
        expect(AgentStatus.isFinal(spawned.success.status)).toBe(false)
      }

      // After the runLoop exits, the completion-watcher attaches the
      // behavior_violation payload to the parent's mailbox notification.
      yield* Effect.sleep(80)
      const drained = yield* control.drainMailbox(root.id)
      const note = drained.find((m) => String(m.author) === "/root/g26")
      expect(note).toBeDefined()
      expect(note?.content).toContain("reached status:")
      expect(note?.behavior_violation).toBeDefined()
      expect(note?.behavior_violation?.contract_version).toBe("subagent_v1")
      const kinds = note?.behavior_violation?.violations.map((v) => v.kind) ?? []
      expect(kinds).toContain("missing_delivery")
    }),
  )
})

describe("bug 3 audit — agent_type role-vocabulary fix is intact", () => {
  // NOT SKIPPED. Wave 0 asserts the fix is present on the current branch.
  // If this test fails, the bug-3 regression has slipped back in. Restore it
  // (do NOT re-fix in this wave; the fix already landed on codex-parity at
  // commit c86c58f94 — restore by reverting whatever undid it).

  it.instance("spawn_agent description lists explore + general (not explorer / worker)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent not registered")
      // describeSpawnAgent (registry.ts:326-339) appends a templated list of
      // valid agent types to the tool's description, prefixed by the header
      // line "Available agent types and the tools they have access to:". Each
      // eligible subagent appears as a "- <name>: <description>" bullet under
      // that header. Built-ins yield `explore` and `general` only. Codex role
      // names (`explorer`, `worker`, `default`) must NOT appear as bullet
      // entries here.
      //
      // The assertion scope is the APPENDED ENUMERATION ONLY — not the full
      // description. The agent-spawn.txt prose legitimately uses the
      // substrings "an explorer", "Observer/worker", "by default", and
      // "(default)" as illustrative copy. Those collide with `\bword\b` regex
      // (every neighbor is a non-word char → boundaries present), so a
      // whole-description regex would false-positive on prose. The bug-3 fix
      // operates on the registry's enumeration, not on the prose, so scoping
      // to the enumeration matches the fix's actual surface.
      const ENUM_HEADER = "Available agent types and the tools they have access to:"
      const headerIdx = spawn.description.indexOf(ENUM_HEADER)
      if (headerIdx < 0) {
        throw new Error(
          `spawn_agent description is missing the enumeration header "${ENUM_HEADER}". ` +
            "describeSpawnAgent (registry.ts) may have been removed or renamed.",
        )
      }
      const enumeration = spawn.description.slice(headerIdx)
      // Eligible subagent names appear as "- <name>:" bullets, anchored to
      // the start of a line (multiline regex). The two built-ins are
      // explore + general.
      expect(enumeration).toMatch(/^- explore:/m)
      expect(enumeration).toMatch(/^- general:/m)
      // Codex role names must NOT appear as bullet-pointed agent type
      // entries. The bullet anchor (`^-`) and trailing colon ensure we only
      // catch agent-type bullets, never prose mentions.
      expect(enumeration).not.toMatch(/^- explorer:/m)
      expect(enumeration).not.toMatch(/^- worker:/m)
      expect(enumeration).not.toMatch(/^- default:/m)
    }),
  )

  it.instance("spawn_agent rejects agent_type 'explorer' with agent_type_invalid", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent not registered")
      const root = yield* sessions.create({ title: "root" })
      // Build a minimal Tool.Context. The exact shape is in
      // packages/opencode/src/tool/tool.ts; ask: returns Effect.void.
      const ctx: Tool.Context = {
        sessionID: root.id,
        messageID: MessageID.make(""),
        callID: "",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const res = yield* spawn.execute(
        { message: "do work", task_name: "worker_a", agent_type: "explorer" },
        ctx,
      )
      // The fix returns a model-recoverable error tagged agent_type_invalid.
      // metadata.error is the stable tag; output prose lists what IS valid.
      expect((res as { metadata: { error?: string } }).metadata.error).toBe("agent_type_invalid")
      expect((res as { output: string }).output).toContain("explore")
      expect((res as { output: string }).output).toContain("general")
    }),
  )

  it.instance("spawn_agent Parameters.agent_type is a required Schema.String", () =>
    Effect.gen(function* () {
      // Cheap structural assertion — the schema's JSON form must list
      // agent_type as a required string field. If a future refactor makes
      // it optional or non-string, the propagation tests can pass while the
      // lookup blows up at runtime — exactly the failure mode bug 3 was.
      const { Parameters } = yield* Effect.promise(() => import("@/tool/agent-spawn/agent-spawn"))
      const ast = (Parameters as unknown as { ast: unknown }).ast
      const json = JSON.stringify(ast)
      // The schema's AST encodes propertySignatures with `isOptional`. A
      // required string field surfaces as { isOptional: false } on agent_type.
      // We assert the substring rather than parsing the full AST shape (Schema
      // internals shift across betas).
      expect(json).toContain("\"agent_type\"")
      // No subagent_type fallback — bug 3's earlier fix removed any optional
      // alias. Defensive: confirm the field name didn't drift.
      expect(json).not.toContain("\"subagent_type\"")
    }),
  )
})
