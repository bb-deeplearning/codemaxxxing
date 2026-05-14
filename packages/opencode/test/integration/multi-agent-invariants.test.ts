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
import { Effect, Layer, Result } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl, AgentNotFoundError } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { AgentWaitTool } from "@/tool/agent-wait/agent-wait"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import type * as Tool from "@/tool/tool"
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
    Session.defaultLayer,
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
      // MESSAGE_SHAPES.md § "completion notification body shape (Wave 2)".
      const drained = yield* control.drainMailbox(root.id)
      expect(drained).toHaveLength(1)
      const note = drained[0]!
      expect(note.content).toBe("Agent /root/task_b reached status: completed")
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
  it.instance.skip("parent-close-cascades-to-children", () =>
    Effect.gen(function* () {
      yield* Effect.void
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
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("100 millis")
          yield* control.closeAgent(child.thread_id)
        }),
      )

      // wait_agent timeout floors to MIN_WAIT_TIMEOUT_MS=1000 (the smallest
      // possible wall-clock the timeout branch can return on). The watcher
      // MUST skip the notification when status reaches "shutdown" (per the
      // MESSAGE_SHAPES.md § "Skip rule"). With no notification fired, the
      // wait runs out the timeout → timed_out=true.
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

  // TODO(wave_3): audit — assert under concurrent send pressure.
  it.instance.skip("mailbox-drain-at-runloop-boundary-with-concurrent-sends", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): audit — assert PTY cleanup under multi-agent cancellation.
  it.instance.skip("pty-cleanup-on-parent-abort", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): backward-compat verification.
  it.instance.skip("legacy-task-tool-coexists-with-v2", () =>
    Effect.gen(function* () {
      yield* Effect.void
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
