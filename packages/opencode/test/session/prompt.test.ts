import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "../../src/session/session.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt, slugifyTaskName } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Pty } from "@/pty"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { ProcessSessions } from "@/tool/process/sessions"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(Pty.defaultLayer),
    Layer.provide(ProcessSessions.defaultLayer),
    // Wave 9: lift AgentControl from a hidden registry dep to a top-level
    // service so SessionPrompt's layer init can register the run-loop
    // provider, the runLoop drain step can call drainMailbox, and tests can
    // yield AgentControl.Service to assert against it directly.
    Layer.provideMerge(AgentControl.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())
const unix = process.platform !== "win32" ? it.live : it.live.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const addSubtaskV2 = (
  sessionID: SessionID,
  messageID: MessageID,
  init?: { agent?: string; description?: string; prompt?: string },
) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: init?.prompt ?? "do the v2 thing",
      description: init?.description ?? "v2-spawn",
      agent: init?.agent ?? "general",
      model: ref,
      protocol: "v2",
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("prompt emits v2 prompted and synthetic events", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("glob tool keeps instance context during prompt runs", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Glob context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "probe"))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "find text files" }],
        })
        yield* llm.tool("glob", { pattern: "**/*.txt" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
          )
        if (!tool) return

        expect(tool.state.output).toContain(file)
        expect(tool.state.output).not.toContain("No context found for instance")
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live(
  "running subtask preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
            const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running subtask metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBeDefined()
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

import { test } from "bun:test"

test("slugifyTaskName: passes through valid leaf segments unchanged", () => {
  expect(slugifyTaskName("worker_1")).toBe("worker_1")
  expect(slugifyTaskName("a_b_c_42")).toBe("a_b_c_42")
})

test("slugifyTaskName: lowercases and replaces invalid runs with single underscore", () => {
  expect(slugifyTaskName("Hello-World 42")).toBe("hello_world_42")
  expect(slugifyTaskName("v2-spawn")).toBe("v2_spawn")
})

test("slugifyTaskName: returns empty when no valid characters survive", () => {
  expect(slugifyTaskName("---")).toBe("")
  expect(slugifyTaskName("")).toBe("")
})

it.live("trigger_turn pending defers loop exit even when assistant has finished", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const chat = yield* sessions.create({
        title: "trigger_turn-defer",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* control.registerSessionRoot(chat.id)

      // Spawn a child via AgentControl so the registered loop drives it.
      const child = yield* control.spawnAgent({
        parentID: chat.id,
        parentPath: AgentPath.root(),
        task_name: "deferchild",
        initial_message: "first turn",
      })

      // First model response: model says "stop". Then queue a follow-up.
      // Because the follow-up arrives between the assistant's "stop" and
      // the exit check, hasPendingTriggerTurn returns true and the loop
      // continues into another turn rather than breaking. The second model
      // call returns the second text — observable in the transcript.
      yield* llm.text("first done")
      yield* llm.text("second done")

      // Wait for the first model call to complete.
      yield* Effect.promise(async () => {
        const end = Date.now() + 5_000
        while (Date.now() < end) {
          const calls = await Effect.runPromise(llm.calls)
          if (calls >= 1) return
          await new Promise((done) => setTimeout(done, 30))
        }
        throw new Error("timed out waiting for first model call")
      })

      // Inject a trigger_turn message; the next exit check should defer.
      yield* control.sendInterAgentCommunication(
        child.thread_id,
        new InterAgentCommunication({
          author: AgentPath.root(),
          recipient: child.metadata.agent_path ?? AgentPath.root(),
          content: "wake up",
          trigger_turn: true,
          sent_at: 1,
        }),
        chat.id,
      )

      // After the second model call, the child loop exits cleanly.
      yield* Effect.promise(async () => {
        const end = Date.now() + 5_000
        while (Date.now() < end) {
          const calls = await Effect.runPromise(llm.calls)
          if (calls >= 2) return
          await new Promise((done) => setTimeout(done, 30))
        }
        throw new Error("timed out waiting for second model call")
      })

      // Two model calls happened — confirms the trigger_turn defer caused a
      // second turn after the first "stop".
      expect(yield* llm.calls).toBeGreaterThanOrEqual(2)
    }),
    { git: true, config: providerCfg },
  ),
)

// Wave 4 (replace-bash-task-2026-05-15) — `task` is no longer in the
// model-facing tool list (registry's builtin array dropped tool.task).
// The LLM stub `llm.tool("task", ...)` queues a tool call the model
// can't actually emit; the session has no `tools["task"]` handler so
// the call dispatches into invalidTool / nothing.
//
// The behavior this test asserted — TaskTool's metadata propagation
// from `ctx.metadata({ title, metadata: { sessionId, model } })` —
// remains exercised by:
//   * `test/integration/legacy-internal-runnable.test.ts` "TaskTool.execute
//     still works when invoked directly" — calls TaskTool's execute
//     directly and asserts on `result.metadata.sessionId`.
//   * `test/tool/task.test.ts` "execute resumes an existing task session
//     from task_id" + sibling cases — full TaskTool execution path with
//     metadata assertions.
//
// Skipped here because porting to spawn_agent is non-trivial (different
// metadata field names: spawn_agent emits agent_path / agent_nickname /
// task_name / parent_path, not sessionId / title / model). spawn_agent's
// metadata flow is covered by `test/integration/multi-agent-invariants.test.ts`
// and `test/tool/agent-spawn/agent-spawn.test.ts`.
it.live.skip(
  "running task tool preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
            const tool = assistant?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
            )
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running task metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBe("inspect bug")
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { task } = yield* registry.named()
          const original = task.execute
          task.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            const result = yield* prompt.shell({
              sessionID: chat.id,
              agent: "build",
              command: "[[ 1 -eq 1 ]] && printf configured",
            })

            const tool = completedTool(result.parts)
            if (!tool) return
            expect(tool.state.output).toContain("configured")
          }),
        { git: true, config: { ...cfg, shell: "bash" } },
      ),
    ),
  30_000,
)

unix("shell commands can change directory after startup", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            yield* llm.text("done")

            const result = yield* prompt.command({
              sessionID: chat.id,
              command: "probe",
              arguments: "",
            })

            expect(result.info.role).toBe("assistant")
            const inputs = yield* llm.inputs
            expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
          }),
        {
          git: true,
          config: (url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
              },
            },
          }),
        },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Wave 4 (replace-bash-task-2026-05-15) — `bash` is no longer in the
// model-facing tool list. The truncation behavior asserted here
// (metadata.truncated + metadata.outputPath + "...output truncated...") is
// specific to the legacy bash tool's spill-to-file pattern. exec_command
// uses head/tail in-memory truncation with a different metadata shape
// (`original_token_count`, `wall_time_seconds`, etc.) — the migration is
// not a 1:1 mapping.
//
// Bash truncation behavior is still exercised by:
//   * `test/tool/shell.test.ts` "tool.shell truncation" describe block —
//     direct ShellTool execute calls with the spill-to-file pattern.
//   * `test/integration/legacy-internal-runnable.test.ts` —
//     ShellTool.execute still works internally.
//
// Skipped here because porting to exec_command's truncation surface is
// non-trivial and the underlying behavior is covered elsewhere. Using
// `it.live.skip` directly because `unix` is a conditional function whose
// type union doesn't expose `.skip` without narrowing.
it.live.skip(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command:
              'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            const tool = completedTool(exit.value.parts)
            expect(tool?.state.output).toContain("User aborted the command")
          }

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

// Missing file handling

it.live("does not fail the prompt when a file part is missing", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "does-not-exist.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")
        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

it.live("keeps stored part order stable when file resolution is async", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "still-missing.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

// Special characters in filenames

it.live("handles filenames with # character", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir, "file#name.txt"), "special content\n"))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

        const message = yield* prompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

// Regression: empty assistant turn loop

it.live("does not loop empty assistant turns for a simple reply", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt regression" })

      yield* llm.text("packages/opencode/src/session/processor.ts")

      const result = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Where is SessionProcessor?" }],
      })

      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
      expect(yield* llm.calls).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Prompt cancel regression" })

        yield* llm.hang

        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Cancel me" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* prompt.cancel(session.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          if (exit.value.info.role === "assistant") {
            expect(exit.value.info.error?.name).toBe("MessageAbortedError")
          }
        }

        const msgs = yield* sessions.messages({ sessionID: session.id })
        const last = msgs.findLast((msg) => msg.info.role === "assistant")
        expect(last?.info.role).toBe("assistant")
        if (last?.info.role === "assistant") {
          expect(last.info.error?.name).toBe("MessageAbortedError")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Agent variant

it.live("applies agent variant only when using agent model", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const other = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (other.info.role !== "user") throw new Error("expected user message")
        expect(other.info.model.variant).toBeUndefined()

        const match = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        })
        if (match.info.role !== "user") throw new Error("expected user message")
        expect(match.info.model).toEqual({
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test-model"),
          variant: "xhigh",
        })
        expect(match.info.model.variant).toBe("xhigh")

        const override = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "hello third" }],
        })
        if (override.info.role !== "user") throw new Error("expected user message")
        expect(override.info.model.variant).toBe("high")

        yield* sessions.remove(session.id)
      }),
    {
      git: true,
      config: {
        ...cfg,
        provider: {
          ...cfg.provider,
          test: {
            ...cfg.provider.test,
            models: {
              "test-model": {
                ...cfg.provider.test.models["test-model"],
                variants: { xhigh: {}, high: {} },
              },
            },
          },
        },
        agent: {
          build: {
            model: "test/test-model",
            variant: "xhigh",
          },
        },
      },
    },
  ),
)

// Agent / command resolution errors

it.live(
  "unknown agent throws typed error",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

it.live(
  "unknown agent error includes available agent names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain("build")
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

it.live(
  "unknown command throws typed error with available names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .command({
              sessionID: session.id,
              command: "nonexistent-command-xyz",
              arguments: "",
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
              expect(err.data.message).toContain("init")
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

// ── Wave 9: multi-agent v2 dispatch + mailbox drain ────────────────────────
//
// These tests cover the runLoop integration touched by Wave 9:
//   * Legacy SubtaskPart (no `protocol`) still flows through `handleSubtask`.
//   * `protocol: "v2"` dispatches via AgentControl.spawnAgent and the parent
//     loop continues without blocking on the child.
//   * Mailbox drain runs at the top of each iteration. Pending messages
//     surface as a fresh user message of synthetic text parts; an empty
//     mailbox is a true no-op.
//   * Cancelling the parent session interrupts every spawned child fiber.

const ROOT_PATH = AgentPath.root()

const liveAgentNamesUnder = Effect.fn("test.liveAgentNamesUnder")(function* (
  control: AgentControl.Interface,
  senderID: SessionID,
  prefix = ROOT_PATH,
) {
  const list = yield* control.listAgents(prefix, senderID)
  // strip the root entry; we only care about spawned children
  return list.map((entry) => entry.agent_name).filter((name) => name !== String(ROOT_PATH))
})

it.live("legacy SubtaskPart (no protocol marker) routes through handleSubtask", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const chat = yield* sessions.create({ title: "legacy-subtask" })

      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")

      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      yield* prompt.loop({ sessionID: chat.id })

      // handleSubtask creates an assistant child message tagged with the
      // subtask agent ("general"). v2 dispatch never produces such a message.
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const subAgentMsg = msgs.find(
        (item) => item.info.role === "assistant" && item.info.agent === "general",
      )
      expect(subAgentMsg).toBeDefined()

      // No v2 child should exist in AgentControl — the legacy path bypasses it.
      const live = yield* liveAgentNamesUnder(control, chat.id)
      expect(live).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "protocol=v2 SubtaskPart dispatches via AgentControl without blocking the parent loop",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const chat = yield* sessions.create({ title: "v2-spawn" })

        const msg = yield* user(chat.id, "spawn the v2 child")
        yield* addSubtaskV2(chat.id, msg.id, { agent: "general" })

        const start = Date.now()
        const result = yield* prompt.loop({ sessionID: chat.id })
        const elapsed = Date.now() - start

        // Parent loop returns promptly — no blocking on the spawned child.
        // 5s is comfortably above any reasonable spawn-fork cost; it would be
        // exceeded only if the loop awaited child completion.
        expect(elapsed).toBeLessThan(5_000)
        expect(result.info.role).toBe("assistant")

        // A v2 child was spawned via AgentControl.
        const live = yield* liveAgentNamesUnder(control, chat.id)
        expect(live.length).toBe(1)
        expect(live[0]?.startsWith("/root/")).toBe(true)

        // handleSubtask path was NOT taken — no assistant message tagged
        // with the subtask agent appears in the parent's transcript.
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const subAgentMsg = msgs.find(
          (item) => item.info.role === "assistant" && item.info.agent === "general",
        )
        expect(subAgentMsg).toBeUndefined()
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "v2 dispatch records a failure assistant message when AgentControl.spawnAgent rejects",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const chat = yield* sessions.create({ title: "v2-spawn-fail" })

        // Pre-claim the canonical /root/duplicate path via a real spawn so
        // the second SubtaskPart hits PathAlreadyExistsError. Registers root
        // as a side-effect via spawnAgent.
        yield* control.registerSessionRoot(chat.id)
        yield* control.spawnAgent({
          parentID: chat.id,
          parentPath: AgentPath.root(),
          task_name: "duplicate",
          initial_message: "first",
        })

        // The SubtaskPart's description slugifies to "duplicate" — same path.
        const msg = yield* user(chat.id, "spawn the duplicate")
        yield* addSubtaskV2(chat.id, msg.id, { agent: "general", description: "duplicate" })

        const result = yield* prompt.loop({ sessionID: chat.id })

        // The synthesized assistant message records the failure with the
        // human-readable reason; the parent loop exits cleanly.
        expect(result.info.role).toBe("assistant")
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const synthetic = msgs
          .filter((m) => m.info.role === "assistant")
          .flatMap((m) => m.parts)
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .find((p) => p.synthetic && p.text.startsWith("Failed to spawn agent"))
        expect(synthetic).toBeDefined()
        expect(synthetic?.text).toContain("duplicate")
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live("mailbox drain inserts pending sibling messages as synthetic user parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      const chat = yield* sessions.create({
        title: "mailbox-drain",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Register chat as the registered session root so AgentControl knows
      // its mailbox identity, then queue an inter-agent communication. The
      // runLoop will drain it before the first model call.
      yield* control.registerSessionRoot(chat.id)

      // Seed mailbox via spawnAgent's seed path is awkward here (we'd be
      // registering chat as a child of itself); the production wiring lands
      // through send_message / followup_task. Use sendInterAgentCommunication
      // directly — it requires a registered mailbox, which root has.
      // Spawn a placeholder child so root's identity is wired but use the
      // SAME chat session as recipient by also adding chat to mailbox map.
      // The simplest path: spawn a child and have IT receive the message,
      // then run the child's loop. This exercises the fresh-spawn drain too.
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      // For drain testing, inject directly into the chat session's mailbox.
      // AgentControl exposes a registered mailbox only for spawned children;
      // we register chat as root so its session ID gets a status entry. The
      // actual drain test uses spawnAgent below to create a real child whose
      // mailbox we can target.
      const live = yield* control.spawnAgent({
        parentID: chat.id,
        parentPath: ROOT_PATH,
        task_name: "echoer",
        initial_message: "first ping",
      })

      // Send a follow-up trigger_turn message into the child's mailbox.
      yield* control.sendInterAgentCommunication(
        live.thread_id,
        new InterAgentCommunication({
          author: ROOT_PATH,
          recipient: live.metadata.agent_path ?? ROOT_PATH,
          content: "second ping",
          trigger_turn: true,
          sent_at: 1234,
        }),
        chat.id,
      )

      // Stub the LLM with a single text response; the child's runLoop will
      // run one turn after draining the seed + follow-up messages.
      yield* llm.text("acknowledged")

      // The runLoop must already be running for this child (spawnAgent forks
      // it). Wait briefly for the loop to drain and the model call to fire.
      yield* Effect.promise(async () => {
        const end = Date.now() + 5_000
        while (Date.now() < end) {
          const calls = await Effect.runPromise(llm.calls)
          if (calls >= 1) return
          await new Promise((done) => setTimeout(done, 30))
        }
        throw new Error("timed out waiting for child to call LLM")
      })

      // Verify both seed + follow-up messages were materialized as synthetic
      // text parts on a user message in the child's transcript.
      const msgs = yield* MessageV2.filterCompactedEffect(live.thread_id)
      const userParts = msgs
        .filter((m) => m.info.role === "user")
        .flatMap((m) => m.parts)
        .filter((p): p is MessageV2.TextPart => p.type === "text")

      const fromSibling = userParts.filter((p) => p.synthetic && p.metadata?.from)
      expect(fromSibling.length).toBeGreaterThanOrEqual(2)
      // Body carries the [from <author>]: prefix per MESSAGE_SHAPES.md.
      expect(fromSibling.some((p) => p.text.includes("first ping"))).toBe(true)
      expect(fromSibling.some((p) => p.text.includes("second ping"))).toBe(true)
      expect(fromSibling.every((p) => p.text.startsWith("[from "))).toBe(true)
      // Metadata fields per the spec.
      const followUp = fromSibling.find((p) => p.text.includes("second ping"))
      expect(followUp?.metadata?.from).toBe(String(ROOT_PATH))
      expect(followUp?.metadata?.sent_at).toBe(1234)
      expect(followUp?.metadata?.trigger_turn).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("mailbox drain on an empty mailbox is a no-op (no synthetic user message)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "empty-mailbox",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hi" }],
      })
      yield* llm.text("hello")

      yield* prompt.loop({ sessionID: chat.id })

      // No mailbox has been provisioned for the regular chat session, so the
      // drain returns []; the only user message is the original "hi" — no
      // sibling-prefixed synthetic parts get added.
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const sibParts = msgs
        .filter((m) => m.info.role === "user")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && (p as MessageV2.TextPart).metadata?.from !== undefined)
      expect(sibParts).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "cancel propagates: cancelling the parent interrupts every v2 child fiber",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const control = yield* AgentControl.Service
        const chat = yield* sessions.create({ title: "cancel-cascade" })

        // Pin the child run loops on the LLM hang gate so each child stays
        // running until interrupted.
        yield* llm.hang

        // Spawn 3 v2 children directly via AgentControl. The seed
        // initial_message goes into each child's mailbox; the child run loop
        // (registered by SessionPrompt's layer init) drains it and starts a
        // model call — which hangs on llm.hang.
        const a = yield* control.spawnAgent({
          parentID: chat.id,
          parentPath: ROOT_PATH,
          task_name: "a",
          initial_message: "alpha",
        })
        const b = yield* control.spawnAgent({
          parentID: chat.id,
          parentPath: ROOT_PATH,
          task_name: "b",
          initial_message: "beta",
        })
        const c = yield* control.spawnAgent({
          parentID: chat.id,
          parentPath: ROOT_PATH,
          task_name: "c",
          initial_message: "gamma",
        })

        // All three children are alive and reachable through listAgents.
        const beforeNames = yield* liveAgentNamesUnder(control, chat.id)
        expect(beforeNames.sort()).toEqual(["/root/a", "/root/b", "/root/c"])

        // Wait for all three children to actually start their model calls so
        // we know the runLoop is in flight (not in the early init phase).
        yield* llm.wait(3)

        // Cancel the parent — every child fiber must die.
        yield* prompt.cancel(chat.id)

        // After cancel, each child's status reaches a final state ("shutdown"
        // for cancellation). Poll inside the Effect scope so InstanceState
        // resolution stays valid; bare `Effect.runPromise` here would lose
        // the test's tmpdir Instance binding and crash with "No context
        // found for instance".
        yield* Effect.gen(function* () {
          const deadline = Date.now() + 3_000
          while (Date.now() < deadline) {
            const list = yield* control.listAgents(ROOT_PATH, chat.id)
            const stillLive = list
              .filter((entry) => entry.agent_name !== String(ROOT_PATH))
              .filter(
                (entry) => entry.agent_status !== "shutdown" && entry.agent_status !== "not_found",
              )
            if (stillLive.length === 0) return
            yield* Effect.sleep(30)
          }
          throw new Error("timed out waiting for v2 children to interrupt")
        })

        // Sanity: explicit closeAgent on each child no longer finds them in
        // the live registry (they've been removed by cancelChildrenOf →
        // closeAgent → shutdownOne → registry.releaseSpawnedThread).
        for (const live of [a, b, c]) {
          const meta = yield* control.getAgentMetadata(live.thread_id)
          expect(meta).toBeUndefined()
        }
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

