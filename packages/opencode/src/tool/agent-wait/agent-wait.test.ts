import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import type { Permission } from "@/permission"
import * as Tool from "../tool"
import { disposeAllInstances, provideTmpdirInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"
import { AgentWaitTool, PermissionKey } from "./agent-wait"
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS } from "./constants"

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

const installNeverLoop = Effect.gen(function* () {
  const control = yield* AgentControl.Service
  yield* control.registerRunLoop(() => Effect.never)
})

interface CtxRecord {
  asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>
  metadata: Array<{ title?: string; metadata?: Record<string, unknown> }>
  abort: AbortController
}

function makeCtx(sessionID: SessionID): { record: CtxRecord; ctx: Tool.Context } {
  const record: CtxRecord = {
    asks: [],
    metadata: [],
    abort: new AbortController(),
  }
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: record.abort.signal,
    messages: [],
    metadata: (input) =>
      Effect.sync(() => {
        record.metadata.push(input as { title?: string; metadata?: Record<string, unknown> })
      }),
    ask: (input) =>
      Effect.sync(() => {
        record.asks.push(input)
      }),
  }
  return { record, ctx }
}

const initTool = Effect.fn("AgentWaitToolTest.init")(function* () {
  const info = yield* AgentWaitTool
  return yield* info.init()
})

const seedRoot = Effect.fn("AgentWaitToolTest.seedRoot")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "root" })
  const control = yield* AgentControl.Service
  yield* control.registerSessionRoot(root.id)
  return root
})

describe("tool.wait_agent — child mailbox empty", () => {
  it.live("times out cleanly when no mailbox update arrives", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker",
          initial_message: "init",
        })
        // Drain seed message so mailbox is empty.
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        const start = Date.now()
        const result = yield* def.execute({ timeout_ms: 1000 }, ctx)
        const elapsed = Date.now() - start

        expect(result.metadata.timed_out).toBe(true)
        expect(elapsed).toBeGreaterThan(900)
        expect(elapsed).toBeLessThan(2000)
        const payload = JSON.parse(result.output)
        expect(payload.message).toBe("Wait timed out.")
        expect(payload.timed_out).toBe(true)
      }),
    ),
  )
})

describe("tool.wait_agent — child mailbox already has pending items", () => {
  it.live("returns immediately with timed_out=false", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "prepending",
          initial_message: "seed-message",
        })
        // Do NOT drain — the seed message keeps the mailbox pending.

        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        const start = Date.now()
        const result = yield* def.execute({ timeout_ms: 5_000 }, ctx)
        const elapsed = Date.now() - start

        expect(result.metadata.timed_out).toBe(false)
        // Should return well under the 5s timeout.
        expect(elapsed).toBeLessThan(500)
        const payload = JSON.parse(result.output)
        expect(payload.message).toBe("Wait completed.")
        expect(payload.timed_out).toBe(false)
      }),
    ),
  )
})

describe("tool.wait_agent — mailbox receives a message during the wait", () => {
  it.live("returns with timed_out=false when a sender wakes the mailbox mid-wait", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "wakeable",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)

        // Schedule a send 200ms in. Use Effect.forkScoped so the helper
        // fiber is bound to the test scope.
        const childPath = yield* AgentPath.from("/root/wakeable")
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.sleep("200 millis")
            yield* control.sendInterAgentCommunication(
              child.thread_id,
              new InterAgentCommunication({
                author: AgentPath.root(),
                recipient: childPath,
                content: "wake up",
                trigger_turn: true,
                sent_at: Date.now(),
              }),
            )
          }),
        )

        const start = Date.now()
        const result = yield* def.execute({ timeout_ms: 5_000 }, ctx)
        const elapsed = Date.now() - start

        expect(result.metadata.timed_out).toBe(false)
        // Should fire shortly after the 200ms send, well under 5s timeout.
        expect(elapsed).toBeGreaterThan(150)
        expect(elapsed).toBeLessThan(2_000)
        const payload = JSON.parse(result.output)
        expect(payload.message).toBe("Wait completed.")
      }),
    ),
  )
})

describe("tool.wait_agent — calling session has no mailbox (root)", () => {
  it.live("falls back to a sleep-then-timeout when sessionID has no mailbox", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const start = Date.now()
        const result = yield* def.execute({ timeout_ms: 1000 }, ctx)
        const elapsed = Date.now() - start

        expect(result.metadata.timed_out).toBe(true)
        expect(elapsed).toBeGreaterThan(900)
        expect(elapsed).toBeLessThan(2_000)
        const payload = JSON.parse(result.output)
        expect(payload.timed_out).toBe(true)
        expect(payload.message).toBe("Wait timed out.")
      }),
    ),
  )
})

describe("tool.wait_agent — validation", () => {
  it.live("timeout_ms = 0 returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        const result = yield* def.execute({ timeout_ms: 0 }, ctx)
        expect(result.output.toLowerCase()).toContain("greater than zero")
        // Permission should NOT have been requested — validation rejects first.
        expect(record.asks.length).toBe(0)
      }),
    ),
  )

  it.live("timeout_ms = -100 returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ timeout_ms: -100 }, ctx)
        expect(result.output.toLowerCase()).toContain("greater than zero")
      }),
    ),
  )

  it.live("timeout_ms = 100 (below MIN) clamps to MIN_WAIT_TIMEOUT_MS", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        // Use a child whose mailbox is pre-pending so the call returns
        // immediately and we can read metadata.timeout_ms without waiting.
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "clamp_lo",
          initial_message: "seed",
        })
        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        const result = yield* def.execute({ timeout_ms: 100 }, ctx)
        expect(result.metadata.timeout_ms).toBe(MIN_WAIT_TIMEOUT_MS)
      }),
    ),
  )

  it.live("timeout_ms = 1_000_000 (above MAX) clamps to MAX_WAIT_TIMEOUT_MS", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "clamp_hi",
          initial_message: "seed",
        })
        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        const result = yield* def.execute({ timeout_ms: 1_000_000 }, ctx)
        expect(result.metadata.timeout_ms).toBe(MAX_WAIT_TIMEOUT_MS)
      }),
    ),
  )

  it.live("omitted timeout_ms uses DEFAULT_WAIT_TIMEOUT_MS=30_000", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "default_to",
          initial_message: "seed",
        })
        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        // Pre-pending mailbox returns immediately; metadata records the
        // resolved timeout_ms (30_000 default).
        const result = yield* def.execute({}, ctx)
        expect(result.metadata.timeout_ms).toBe(DEFAULT_WAIT_TIMEOUT_MS)
      }),
    ),
  )

  it.live("ctx.ask is invoked with permission key 'wait_agent'", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "asked",
          initial_message: "seed",
        })
        const def = yield* initTool()
        const { ctx, record } = makeCtx(child.thread_id)
        yield* def.execute({ timeout_ms: 1_000 }, ctx)
        expect(record.asks.length).toBe(1)
        expect(record.asks[0].permission).toBe(PermissionKey)
      }),
    ),
  )
})

// Sanity guard.
void Result
