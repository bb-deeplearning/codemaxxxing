import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { RecallTool } from "../../src/tool/recall/recall"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const ctx = (sessionID: SessionID): Tool.Context => ({
  sessionID,
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const recall = Effect.fn("RecallToolTest.init")(function* () {
  const info = yield* RecallTool
  return yield* info.init()
})

const seed = Effect.fn("RecallToolTest.seed")(function* (title: string) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title })
  return chat.id
})

const say = Effect.fn("RecallToolTest.say")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const called = Effect.fn("RecallToolTest.called")(function* (input: {
  sessionID: SessionID
  tool: string
  args: Record<string, unknown>
  output: string
  compacted?: boolean
}) {
  const sessions = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID: input.sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* sessions.updateMessage(msg)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: "call_" + msg.id,
    tool: input.tool,
    state: {
      status: "completed",
      input: input.args,
      output: input.output,
      title: input.tool,
      metadata: {},
      time: { start: Date.now(), end: Date.now(), ...(input.compacted ? { compacted: Date.now() } : {}) },
    },
  })
  return msg
})

describe("tool.recall", () => {
  it.instance("finds text in an old message", () =>
    Effect.gen(function* () {
      const sessionID = yield* seed("recall-text")
      yield* say(sessionID, "first we talked about the deploy runbook")
      yield* say(sessionID, "the widget cache key is wgt:v3:${tenant}")
      yield* say(sessionID, "then we moved on to something else entirely")

      const tool = yield* recall()
      const result = yield* tool.execute({ query: "widget cache" }, ctx(sessionID))

      expect(result.metadata.matches).toBe(1)
      expect(result.metadata.returned).toBe(1)
      expect(result.output).toContain("wgt:v3:${tenant}")
      expect(result.output).toContain("| user | text |")
    }),
  )

  it.instance("recovers content from a pruned tool part", () =>
    Effect.gen(function* () {
      const sessionID = yield* seed("recall-pruned")
      yield* called({
        sessionID,
        tool: "exec_command",
        args: { cmd: "bun run build" },
        output: "error: ENOSPC no space left on device while writing .next/cache",
        compacted: true,
      })

      const tool = yield* recall()
      const result = yield* tool.execute({ query: "ENOSPC" }, ctx(sessionID))

      expect(result.metadata.matches).toBe(1)
      expect(result.metadata.pruned).toBe(1)
      expect(result.output).toContain("[recovered from pruned tool output]")
      expect(result.output).toContain("no space left on device")
      expect(result.output).toContain("| assistant | tool:exec_command |")
    }),
  )

  it.instance("requires every query term to match", () =>
    Effect.gen(function* () {
      const sessionID = yield* seed("recall-and")
      yield* say(sessionID, "alpha bravo lives in the first message")
      yield* say(sessionID, "alpha charlie lives in the second message")

      const tool = yield* recall()
      const result = yield* tool.execute({ query: "alpha charlie" }, ctx(sessionID))

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain("second message")
      expect(result.output).not.toContain("first message")

      const both = yield* tool.execute({ query: "alpha" }, ctx(sessionID))
      expect(both.metadata.matches).toBe(2)
    }),
  )

  it.instance("caps returned excerpts at the limit", () =>
    Effect.gen(function* () {
      const sessionID = yield* seed("recall-limit")
      yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], (n) => say(sessionID, `needle number ${n}`), {
        discard: true,
      })

      const tool = yield* recall()
      const capped = yield* tool.execute({ query: "needle", limit: 2 }, ctx(sessionID))
      expect(capped.metadata.matches).toBe(8)
      expect(capped.metadata.returned).toBe(2)
      expect(capped.output).toContain("showing the top 2")

      const defaulted = yield* tool.execute({ query: "needle" }, ctx(sessionID))
      expect(defaulted.metadata.matches).toBe(8)
      expect(defaulted.metadata.returned).toBe(5)
    }),
  )

  it.instance("says so plainly when nothing matches", () =>
    Effect.gen(function* () {
      const sessionID = yield* seed("recall-empty")
      yield* say(sessionID, "nothing in here resembles the query")

      const tool = yield* recall()
      const result = yield* tool.execute({ query: "quetzalcoatl" }, ctx(sessionID))

      expect(result.metadata.matches).toBe(0)
      expect(result.metadata.returned).toBe(0)
      expect(result.output).toContain('No matches for "quetzalcoatl"')
      expect(result.output).toContain("Try fewer terms")
    }),
  )
})
