// Wave 4 — legacy ShellTool + TaskTool stay importable and runnable from
// internal code despite being dropped from the registry's model-facing
// builtin array.
//
// The campaign's hard constraint per OVERVIEW.md "Hard constraints":
// > **No deletions of `shell.ts` or `task.ts`.** Per user instruction:
// > "I don't mind infra being there." The campaign drops their entries
// > from the registry's builtin array; the files remain.
//
// > **No regressions on the legacy paths.** `shell.ts` and `task.ts`
// > remain compileable, importable, and runnable from internal code.
// > Their tests stay green.
//
// These two tests exercise the import + execute paths directly (without
// going through ToolRegistry.builtin) to assert the files still produce
// expected output. The existing comprehensive shell.test.ts and
// task.test.ts continue to verify per-feature behavior; this file is a
// compact sanity backstop scoped to Wave 4's drop.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { Shell } from "@/shell/shell"
import { ShellTool } from "@/tool/shell"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Plugin.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const REF = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const ctxBase = {
  sessionID: SessionID.make("ses_legacy_internal"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("legacy tools stay runnable from internal code after Wave 4 builtin-drop", () => {
  it.live("ShellTool.execute still works when invoked directly (not via model)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        // Reset shell detector cache so the test instance sees a fresh
        // resolution rather than module-load-time state.
        Shell.acceptable.reset()

        const tool = yield* ShellTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          { command: "echo legacy-shell-ok", description: "echo test" },
          ctxBase,
        )
        // Expected output shape: title + output + metadata. The exact
        // output text from `echo` ends with a newline.
        expect(result.output).toContain("legacy-shell-ok")
        expect(result.title).toBe("echo test")
      }),
    ),
  )

  it.live("TaskTool.execute still works when invoked directly", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Build the seed: parent session + assistant message that
        // task.ts:103 reads from MessageV2.get(...). Mirror task.test.ts.
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "legacy-task-test" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: REF,
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
          modelID: REF.modelID,
          providerID: REF.providerID,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)

        // task.ts requires ctx.extra.promptOps to drive the subagent. Stub
        // returns a fixed reply text without spawning a real run-loop.
        const replyText = "legacy-task-ok"
        const promptOps: TaskPromptOps = {
          cancel() {},
          resolvePromptParts: (template) =>
            Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input: SessionPrompt.PromptInput) => {
            const id = MessageID.ascending()
            const replyMsg: MessageV2.WithParts = {
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
                modelID: input.model?.modelID ?? REF.modelID,
                providerID: input.model?.providerID ?? REF.providerID,
                time: { created: Date.now() },
                finish: "stop",
              },
              parts: [
                {
                  id: PartID.ascending(),
                  messageID: id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: replyText,
                },
              ],
            }
            return Effect.succeed(replyMsg)
          },
        }

        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            description: "legacy task test",
            prompt: "do the thing",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
            callID: "",
          },
        )
        expect(result.output).toContain("<task_result>")
        expect(result.output).toContain(replyText)
        expect(result.metadata.sessionId).toBeDefined()
      }),
    ),
  )
})
