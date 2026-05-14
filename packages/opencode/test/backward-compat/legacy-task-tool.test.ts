// Wave 13 backward-compat — the legacy `task` tool's input shape and output
// envelope must remain identical to the pre-campaign behavior. Plugin authors
// and external callers (slash commands, recorded transcripts, the SDK's
// fan-out helpers) parse the `task_id: <ses_xxx>` line and the
// `<task_result>...</task_result>` envelope verbatim. Any schema or
// formatting drift breaks them silently.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, Parameters as TaskParameters, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
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
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const seed = Effect.fn("LegacyTaskTool.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
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
}

function stubOps(text: string): TaskPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.sync(() => reply(input, text)),
  }
}

const accepts = (input: unknown) => Result.isSuccess(Schema.decodeUnknownResult(TaskParameters)(input))
const parse = (input: unknown) => Schema.decodeUnknownSync(TaskParameters)(input)

describe("legacy task tool — parameters schema is unchanged", () => {
  it.live("accepts the minimum legacy shape (description + prompt + subagent_type)", () =>
    Effect.gen(function* () {
      const parsed = parse({ description: "d", prompt: "p", subagent_type: "general" })
      expect(parsed).toEqual({ description: "d", prompt: "p", subagent_type: "general" })
    }),
  )

  it.live("accepts task_id and command as optional fields", () =>
    Effect.gen(function* () {
      const parsed = parse({
        description: "d",
        prompt: "p",
        subagent_type: "general",
        task_id: "ses_legacy_resume",
        command: "/recipe",
      })
      expect(parsed.task_id).toBe("ses_legacy_resume")
      expect(parsed.command).toBe("/recipe")
    }),
  )

  it.live("rejects missing description", () =>
    Effect.gen(function* () {
      expect(accepts({ prompt: "p", subagent_type: "general" })).toBe(false)
    }),
  )

  it.live("rejects missing prompt", () =>
    Effect.gen(function* () {
      expect(accepts({ description: "d", subagent_type: "general" })).toBe(false)
    }),
  )

  it.live("rejects missing subagent_type", () =>
    Effect.gen(function* () {
      expect(accepts({ description: "d", prompt: "p" })).toBe(false)
    }),
  )

  it.live("does not require any new wave-12 keys (e.g. protocol)", () =>
    Effect.gen(function* () {
      const parsed = parse({ description: "d", prompt: "p", subagent_type: "general" })
      // Sentinel: post-campaign additions must remain absent from the
      // parsed legacy shape. If a wave snuck in a required field this
      // assertion will surface it before plugin authors do.
      expect("protocol" in parsed).toBe(false)
    }),
  )
})

describe("legacy task tool — output envelope unchanged", () => {
  it.live("output starts with `task_id: <session>` line and contains <task_result> tags", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            description: "find auth tests",
            prompt: "locate every test for auth middleware",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps("Found 3 tests in test/auth/.") },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const newChild = (yield* sessions.children(chat.id))[0]
        // Envelope shape mirrors `task.ts:158-163`. Rebuild it from the
        // observed child id and assert byte equality so any future
        // formatting drift (extra leading whitespace, blank-line removal,
        // tag rename) trips here loudly.
        const expected = [
          `task_id: ${newChild.id} (for resuming to continue this task if needed)`,
          "",
          "<task_result>",
          "Found 3 tests in test/auth/.",
          "</task_result>",
        ].join("\n")
        expect(result.output).toBe(expected)
        expect(result.title).toBe("find auth tests")
        expect(result.metadata.sessionId).toBe(newChild.id)
        expect(result.metadata.model).toEqual({ providerID: ref.providerID, modelID: ref.modelID })
      }),
    ),
  )

  it.live("output uses an empty <task_result> when the subagent returns no text part", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const noText: TaskPromptOps = {
          cancel() {},
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => ({
              ...reply(input, ""),
              parts: [], // no text part at all
            })),
        }
        const result = yield* def.execute(
          {
            description: "silent run",
            prompt: "do nothing visible",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: noText },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        // Empty between the tags — same shape as pre-campaign. The model is
        // expected to read this as "no content" rather than parse-error.
        expect(result.output).toContain("<task_result>\n\n</task_result>")
      }),
    ),
  )
})
