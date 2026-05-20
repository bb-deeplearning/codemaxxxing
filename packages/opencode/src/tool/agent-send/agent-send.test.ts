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
import type { Permission } from "@/permission"
import * as Tool from "../tool"
import { disposeAllInstances, provideTmpdirInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"
import { AgentSendTool, PermissionKey } from "./agent-send"

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

const initTool = Effect.fn("AgentSendToolTest.init")(function* () {
  const info = yield* AgentSendTool
  return yield* info.init()
})

const seedRoot = Effect.fn("AgentSendToolTest.seedRoot")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "root" })
  const control = yield* AgentControl.Service
  yield* control.registerSessionRoot(root.id)
  return root
})

describe("tool.send_message", () => {
  it.live("queues the message in the target's mailbox (relative target from root)", () =>
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
        // Drain the seed message that spawnAgent placed in the mailbox so
        // the next drain only shows the send_message effect.
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "worker", message: "hello" }, ctx)

        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("hello")
        // Output is a brief acknowledgement string (codex returns empty;
        // we surface a short note for transcript readability).
        expect(typeof result.output).toBe("string")
        expect(result.output.length).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("queued message has trigger_turn: false (parity with codex QueueOnly mode)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "queueonly",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        yield* def.execute({ target: "queueonly", message: "fyi" }, ctx)

        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.trigger_turn).toBe(false)
      }),
    ),
  )

  it.live("accepts a canonical absolute path as target", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "abs_target",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        yield* def.execute({ target: "/root/abs_target", message: "by path" }, ctx)

        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("by path")
      }),
    ),
  )

  it.live("relative target from a sub-agent resolves against the sender's path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: "init",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "b",
          initial_message: "init",
        })
        yield* control.drainMailbox(b.thread_id)

        const def = yield* initTool()
        // Sender is A (sessionID=a.thread_id); target "b" must resolve to
        // /root/a/b, not /root/b.
        const { ctx } = makeCtx(a.thread_id)
        yield* def.execute({ target: "b", message: "from sibling parent" }, ctx)

        const drained = yield* control.drainMailbox(b.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("from sibling parent")
      }),
    ),
  )

  it.live("empty message returns model-recoverable error in output, no exception", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "empty_target",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "empty_target", message: "" }, ctx)
        // Codex: "Empty message can't be sent to an agent" via RespondToModel.
        expect(result.output.toLowerCase()).toContain("empty")
        // Nothing landed in the mailbox.
        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(0)
      }),
    ),
  )

  it.live("whitespace-only message returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "ws_target",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target: "ws_target", message: "   \n\t  " },
          ctx,
        )
        expect(result.output.toLowerCase()).toContain("empty")
        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(0)
      }),
    ),
  )

  it.live("unknown target returns model-recoverable error in output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute(
          { target: "no_such_agent", message: "hello?" },
          ctx,
        )
        // Should not throw; should encode the failure into the result.
        expect(typeof result.output).toBe("string")
        expect(result.output.toLowerCase()).toMatch(/not found|cannot resolve|unknown|invalid/)
      }),
    ),
  )

  it.live("invalid path syntax for target returns model-recoverable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        // Hyphen is not a valid path-segment character — resolve fails before
        // the registry is even consulted.
        const result = yield* def.execute(
          { target: "bad-name", message: "hi" },
          ctx,
        )
        expect(typeof result.output).toBe("string")
        expect(result.output.toLowerCase()).toMatch(/not found|cannot resolve|invalid/)
      }),
    ),
  )

  it.live("ctx.ask is invoked with permission key 'task' and target as pattern (Wave 3 collapsed onto task)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "ask_target",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        yield* def.execute({ target: "ask_target", message: "ping" }, ctx)

        expect(record.asks.length).toBe(1)
        // PermissionKey moved from "send_message" → "task" in Wave 3 (mirror
        // of EDIT_TOOLS where edit/write/apply_patch all consult "edit").
        // Saved `permission.task: { ... }` rules now gate this surface.
        // Literal-string assertion guards against accidental revert of the
        // constant; stays RED if PermissionKey drifts back.
        expect(record.asks[0].permission).toBe("task")
        expect(record.asks[0].permission).toBe(PermissionKey)
        expect(record.asks[0].patterns).toEqual(["ask_target"])
      }),
    ),
  )

  it.live("recorded author of the InterAgentCommunication matches the sender's currentPath", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const a = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "a",
          initial_message: "init",
        })
        const b = yield* control.spawnAgent({
          parentID: a.thread_id,
          parentPath: yield* AgentPath.from("/root/a"),
          task_name: "b",
          initial_message: "init",
        })
        yield* control.drainMailbox(b.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(a.thread_id)
        yield* def.execute({ target: "b", message: "from a" }, ctx)

        const drained = yield* control.drainMailbox(b.thread_id)
        expect(drained).toHaveLength(1)
        expect(String(drained[0]?.author)).toBe("/root/a")
        expect(String(drained[0]?.recipient)).toBe("/root/a/b")
      }),
    ),
  )

  it.live("metadata records the resolved target session id and queued=true on success", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "meta_target",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        const result = yield* def.execute({ target: "meta_target", message: "ok" }, ctx)
        expect(result.metadata.target).toBe("meta_target")
        expect(result.metadata.target_session_id).toBe(child.thread_id)
        expect(result.metadata.queued).toBe(true)
      }),
    ),
  )

  it.live("send to /root from a child queues into the root's mailbox", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        // Spawn a child so the sender path resolves through registry; the
        // child sends back to /root, which now has its own mailbox so the
        // wait_agent watcher can wake on completion notifications (Wave 2).
        // Pre-Wave 2 root had no mailbox and this send failed with
        // AgentNotFoundError; post-fix the send queues normally.
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "back_sender",
          initial_message: "init",
        })
        const def = yield* initTool()
        const { ctx } = makeCtx(child.thread_id)
        const result = yield* def.execute(
          { target: "/root", message: "phoning home" },
          ctx,
        )
        expect(result.metadata.queued).toBe(true)
        expect(result.metadata.target_session_id).toBe(root.id)
        const drained = yield* control.drainMailbox(root.id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.content).toBe("phoning home")
      }),
    ),
  )

  it.live("does not call ctx.ask when the message is empty (rejected before permission)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "no_ask",
          initial_message: "init",
        })
        const def = yield* initTool()
        const { ctx, record } = makeCtx(root.id)
        yield* def.execute({ target: "no_ask", message: "" }, ctx)
        expect(record.asks.length).toBe(0)
      }),
    ),
  )

  it.live("correlation_id flows through to the queued InterAgentCommunication when supplied", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const root = yield* seedRoot()
        const control = yield* AgentControl.Service
        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "corr_target",
          initial_message: "init",
        })
        yield* control.drainMailbox(child.thread_id)

        const def = yield* initTool()
        const { ctx } = makeCtx(root.id)
        yield* def.execute(
          { target: "corr_target", message: "hello", correlation_id: "req-123" },
          ctx,
        )

        const drained = yield* control.drainMailbox(child.thread_id)
        expect(drained).toHaveLength(1)
        expect(drained[0]?.correlation_id).toBe("req-123")
      }),
    ),
  )
})

// Sanity guard — referencing Result in import section keeps lint happy if the
// helper is unused in a future refactor; here we explicitly use it to satisfy
// the test harness's pretty-error printer requirements.
void Result
