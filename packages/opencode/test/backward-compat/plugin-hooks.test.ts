// Wave 13 backward-compat — plugin authors hook `tool.execute.before` /
// `tool.execute.after` to observe and mutate tool calls. The hook payload
// shapes have shipped publicly since opencode 0.x; mutating them silently
// breaks every plugin in the wild. The prompt loop's tool wrapper at
// prompt.ts:455-474 is the production trigger site, but we test the
// contract here directly via `Plugin.Service.trigger` so the signature lock
// is independent of the prompt loop's evolution.
//
// Inspired by `test/plugin/trigger.test.ts` (`withProject` pattern). That
// file covers `experimental.chat.system.transform`; this one covers the
// tool-execution hooks specifically because legacy plugins use them most.

import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Mirror the trigger.test.ts setup: disable default plugins so external
// plugin loading is the only source of hooks for this file's tests.
const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")

const it = testEffect(Layer.mergeAll(Plugin.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterAll(() => {
  if (disableDefault === undefined) {
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "plugin.ts")
      yield* Effect.all(
        [
          Effect.promise(() => Bun.write(file, source)),
          Effect.promise(() =>
            Bun.write(
              path.join(dir, "opencode.json"),
              JSON.stringify(
                {
                  $schema: "https://opencode.ai/config.json",
                  plugin: [pathToFileURL(file).href],
                },
                null,
                2,
              ),
            ),
          ),
        ],
        { discard: true, concurrency: 2 },
      )
      return yield* self
    }),
  )
}

// Plugin source recording before / after hook payloads via globalThis. The
// plugin module evaluates in a forked subprocess context (PluginLoader
// runs it with esbuild), so we can't share variables — instead the hook
// stores the payloads on a global and the test reads them via Plugin.trigger
// chaining (the test mutates `output` in the hook; the test reads
// `output.recorded` afterwards).
const beforeAndAfterPlugin = `
export default async () => ({
  "tool.execute.before": async (input, output) => {
    output["recorded_before"] = { input, args: output.args }
  },
  "tool.execute.after": async (input, output) => {
    output["recorded_after"] = {
      input,
      title: output.title,
      output: output.output,
      metadata: output.metadata,
    }
  },
})
`

const mutatingPlugin = `
export default async () => ({
  "tool.execute.before": async (_input, output) => {
    output.args = { ...output.args, mutated: true }
  },
})
`

describe("plugin tool.execute.before / after hooks — payload shapes unchanged", () => {
  it.live("before hook receives the legacy payload shape and can read args", () =>
    withProject(
      beforeAndAfterPlugin,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const args = { filePath: "/legacy/dir/src/auth/middleware.ts" }
        const output = { args } as { args: typeof args; recorded_before?: unknown }
        yield* plugin.trigger(
          "tool.execute.before",
          { tool: "read", sessionID: "ses_legacy", callID: "call_1" },
          output,
        )
        expect(output.recorded_before).toEqual({
          input: { tool: "read", sessionID: "ses_legacy", callID: "call_1" },
          args,
        })
      }),
    ),
  )

  it.live("after hook receives the legacy payload shape including title / output / metadata", () =>
    withProject(
      beforeAndAfterPlugin,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const args = { filePath: "/legacy/dir/src/auth/middleware.ts" }
        const result = {
          title: "src/auth/middleware.ts",
          output: "export function authMiddleware(req) { ... }",
          metadata: { lines: 42 } as Record<string, unknown>,
        }
        const output = result as typeof result & { recorded_after?: unknown }
        yield* plugin.trigger(
          "tool.execute.after",
          { tool: "read", sessionID: "ses_legacy", callID: "call_1", args },
          output,
        )
        expect(output.recorded_after).toEqual({
          input: { tool: "read", sessionID: "ses_legacy", callID: "call_1", args },
          title: "src/auth/middleware.ts",
          output: "export function authMiddleware(req) { ... }",
          metadata: { lines: 42 },
        })
      }),
    ),
  )

  it.live("mutating output.args in the before hook propagates to the tool", () =>
    withProject(
      mutatingPlugin,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const output = { args: { command: "ls" } as Record<string, unknown> }
        const returned = yield* plugin.trigger(
          "tool.execute.before",
          { tool: "bash", sessionID: "ses_legacy", callID: "call_1" },
          output,
        )
        expect(returned.args).toEqual({ command: "ls", mutated: true })
        expect(output.args).toEqual({ command: "ls", mutated: true })
      }),
    ),
  )
})

describe("plugin tool.execute hooks — legacy task tool payload shape", () => {
  it.live("triggering tool.execute.before with the legacy task payload preserves every field", () =>
    withProject(
      beforeAndAfterPlugin,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const args = {
          description: "find auth tests",
          prompt: "locate every test for auth middleware",
          subagent_type: "explore",
        }
        const output = { args } as { args: typeof args; recorded_before?: unknown }
        yield* plugin.trigger(
          "tool.execute.before",
          { tool: "task", sessionID: "ses_root", callID: "call_task_1" },
          output,
        )
        expect(output.recorded_before).toEqual({
          input: { tool: "task", sessionID: "ses_root", callID: "call_task_1" },
          args,
        })
      }),
    ),
  )

  it.live("triggering tool.execute.after with the legacy task envelope output preserves every field", () =>
    withProject(
      beforeAndAfterPlugin,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const args = {
          description: "find auth tests",
          prompt: "locate every test for auth middleware",
          subagent_type: "explore",
        }
        const taskOutput =
          "task_id: ses_legacy_child (for resuming to continue this task if needed)\n\n<task_result>\nFound 3 tests in test/auth/.\n</task_result>"
        const output: {
          title: string
          output: string
          metadata: Record<string, unknown>
          recorded_after?: unknown
        } = {
          title: "find auth tests",
          output: taskOutput,
          metadata: { sessionId: "ses_legacy_child" },
        }
        yield* plugin.trigger(
          "tool.execute.after",
          { tool: "task", sessionID: "ses_root", callID: "call_task_1", args },
          output,
        )
        expect(output.recorded_after).toEqual({
          input: { tool: "task", sessionID: "ses_root", callID: "call_task_1", args },
          title: "find auth tests",
          output: taskOutput,
          metadata: { sessionId: "ses_legacy_child" },
        })
      }),
    ),
  )
})
