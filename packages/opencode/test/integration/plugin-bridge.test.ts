// Wave 4 — plugin hook bridge integration tests.
//
// `tool.shell` and `tool.task` are dropped from the registry's builtin
// array. Plugins keying `tool.definition` on the legacy IDs `bash` /
// `task` continue to fire and propagate to the codex-ported `exec_command`
// / `spawn_agent` tools. The bridge in `registry.ts:tools()` dispatches
// the legacy `tool.definition` event BEFORE the new-id event so legacy
// mutations land first and any new-id hook (if any) sees them.
//
// Contract surfaces asserted here (matches WAVE.md task 5):
// 1. `tool.definition` for "bash" fires AND mutates exec_command's description.
// 2. `tool.definition` for "task" fires AND mutates spawn_agent's description.
// 3. `tool.definition` for "bash" does NOT mutate unrelated tool descriptions
//    (e.g. read) — the bridge is scoped to exec_command / write_stdin's
//    legacy-bash route and spawn_agent's legacy-task route.
// 4. `tool.definition` for the new ID ("exec_command") still fires for
//    exec_command — the new-key code path is unchanged. Bridge dispatch
//    order: legacy first, then new. A plugin that mutates via BOTH IDs
//    sees the legacy mutation through the same `output` reference when
//    its new-id hook runs — assertable by appending and checking order.
//
// Per WAVE.md gotcha 9: there is no `Plugin.register(...)` API. The
// hermetic test approach mirrors `test/plugin/trigger.test.ts`: write a
// real plugin file into a tmpdir-bound `.opencode/plugin/` directory
// before binding the test instance, set OPENCODE_DISABLE_DEFAULT_PLUGINS
// so the internal auth plugins don't interfere, and let `applyPlugin`
// pick it up via the standard loader.
//
// `tool.execute.before` / `tool.execute.after` for "bash" are NOT bridged
// (different execution semantics — one-shot vs persistent PTY). registry
// only wires `tool.definition`; execute hooks fire from
// `session/prompt.ts:455-475` keyed on the runtime tool ID. A plugin
// hooking `tool.execute.before` for "bash" would never fire on
// `exec_command` — documented as a plugin-migration boundary in
// BACKWARD_COMPAT.md "Out of scope" + Wave 6 spec doc. Not asserted here
// because the registry never invokes execute (no path to test that
// negative claim through this surface).

import { afterAll, afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Pty } from "@/pty"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ProcessSessions } from "@/tool/process/sessions"
import { ProviderID, ModelID } from "@/provider/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Per `test/plugin/trigger.test.ts` — set BEFORE the dynamic import so the
// plugin layer's INTERNAL_PLUGINS bootstrap can see it. The auth plugins
// don't register `tool.definition` hooks today, but blocking them keeps
// future additions from polluting these contract tests.
const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("@/plugin")
const { ToolRegistry } = await import("@/tool/registry")

afterAll(() => {
  if (disableDefault === undefined) {
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    ProcessSessions.defaultLayer,
    Pty.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Render a plugin source that hooks `tool.definition` for the given
// legacy and/or new tool IDs and appends a tag to each invocation's
// output.description. The tag is the only assertion surface; tests read
// the resulting description and check for the tag.
//
// `tags`: object mapping target toolID → tag to append.
function makePluginSource(args: { tags: Record<string, string> }): string {
  const tagJson = JSON.stringify(args.tags)
  return [
    `const tags = ${tagJson}`,
    `export default async () => ({`,
    `  "tool.definition": async (input, output) => {`,
    `    const tag = tags[input.toolID]`,
    `    if (tag === undefined) return`,
    `    output.description = (output.description ?? "") + "\\n" + tag`,
    `  },`,
    `})`,
    ``,
  ].join("\n")
}

// Mirrors `test/plugin/trigger.test.ts` `withProject`. Writes the plugin
// source + opencode.json into the tmpdir BEFORE the test body runs so
// the Plugin layer's loader picks it up during state init.
function withPlugin(source: string) {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "plugin.ts")
        yield* Effect.all(
          [
            Effect.promise(() => Bun.write(file, source)),
            Effect.promise(() =>
              Bun.write(
                path.join(dir, "opencode.json"),
                JSON.stringify({ plugin: [pathToFileURL(file).href] }, null, 2),
              ),
            ),
          ],
          { discard: true, concurrency: 2 },
        )
        return yield* self
      }),
    )
}

const findTool = Effect.fnUntraced(function* (id: string) {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const build = yield* agents.get("build")
  const tools = yield* registry.tools({ ...STUB_MODEL, agent: build })
  const found = tools.find((t) => t.id === id)
  if (!found) throw new Error(`tool ${id} missing from registry tools`)
  return found
})

describe("plugin hook bridge — Wave 4", () => {
  // Contract 1: bash → exec_command bridge.
  it.live(
    "plugin tool.definition hook for 'bash' fires AND mutates exec_command's description",
    () =>
      withPlugin(makePluginSource({ tags: { bash: "[plugin appended via bash]" } }))(
        Effect.gen(function* () {
          const exec = yield* findTool("exec_command")
          // Bridge: tools()'s legacy-id dispatch fires a tool.definition
          // event with toolID="bash". The plugin's hook keyed on "bash"
          // matches and appends the tag to the SAME output.description
          // reference that the new-id dispatch also sees, so the
          // returned description carries the tag.
          expect(exec.description).toContain("[plugin appended via bash]")

          // The bash hook fires per-tool that bridges to bash. Today
          // that's exec_command + write_stdin. write_stdin must also
          // carry the mutation (proves the bridge is per-tool, not
          // per-call).
          const writeStdin = yield* findTool("write_stdin")
          expect(writeStdin.description).toContain("[plugin appended via bash]")
        }),
      ),
    30_000,
  )

  // Contract 2: task → spawn_agent bridge.
  it.live(
    "plugin tool.definition hook for 'task' fires AND mutates spawn_agent's description",
    () =>
      withPlugin(makePluginSource({ tags: { task: "[plugin appended via task]" } }))(
        Effect.gen(function* () {
          const spawn = yield* findTool("spawn_agent")
          expect(spawn.description).toContain("[plugin appended via task]")

          // The task hook fires for every tool that bridges to task.
          // Today that's spawn_agent + 5 friends.
          for (const id of ["send_message", "followup_task", "wait_agent", "list_agents", "close_agent"]) {
            const def = yield* findTool(id)
            expect(def.description).toContain("[plugin appended via task]")
          }
        }),
      ),
    30_000,
  )

  // Contract 3: bash hook does NOT mutate unrelated tool descriptions.
  it.live(
    "plugin tool.definition hook for 'bash' does NOT touch unrelated tool descriptions",
    () =>
      withPlugin(makePluginSource({ tags: { bash: "[plugin appended via bash]" } }))(
        Effect.gen(function* () {
          const read = yield* findTool("read")
          // The bash hook returns early when input.toolID !== "bash";
          // the registry dispatches a tool.definition event with
          // toolID="read" (no bridge for read), so the hook sees
          // toolID="read" and does nothing.
          expect(read.description).not.toContain("[plugin appended via bash]")

          // Sanity: spawn_agent does NOT inherit the bash bridge —
          // only the task bridge applies to it.
          const spawn = yield* findTool("spawn_agent")
          expect(spawn.description).not.toContain("[plugin appended via bash]")
        }),
      ),
    30_000,
  )

  // Contract 4: legacy-then-new dispatch order. A plugin that hooks BOTH
  // `bash` AND `exec_command` sees the bash mutation FIRST through the
  // same output.description reference when the exec_command hook runs
  // (so the exec_command hook can observe & extend it). The order
  // matters: legacy first, then new. Reversing the order in the bridge
  // would let the legacy mutation clobber the new one — a subtle
  // footgun WAVE.md gotcha 3 explicitly forbids.
  it.live(
    "plugin hooks for both bash and exec_command see legacy-then-new order in same output reference",
    () =>
      withPlugin(makePluginSource({ tags: { bash: "<<bash-tag>>", exec_command: "<<exec-tag>>" } }))(
        Effect.gen(function* () {
          const exec = yield* findTool("exec_command")
          // Both tags appended. The bash tag (legacy) appears BEFORE
          // the exec_command tag (new) in the resulting description
          // because the bridge dispatches legacy first.
          expect(exec.description).toContain("<<bash-tag>>")
          expect(exec.description).toContain("<<exec-tag>>")
          const bashIdx = exec.description.indexOf("<<bash-tag>>")
          const execIdx = exec.description.indexOf("<<exec-tag>>")
          expect(bashIdx).toBeLessThan(execIdx)
        }),
      ),
    30_000,
  )
})
