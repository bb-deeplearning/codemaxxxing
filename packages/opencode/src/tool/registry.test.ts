// Wave 3 — `describeSpawnAgent` filter consults the `task` permission key.
//
// Mirrors `describeTask` (registry.ts:307-320) which has always consulted
// `task`. Pre-Wave-3 the spawn_agent variant used `spawn_agent` as its
// permission key; post-Wave-3 both filters use `task` so saved
// `permission.task: { explore: deny }` rules transparently filter the
// per-subagent enumeration in BOTH tools' descriptions.
//
// This test exercises the registry through `tools()` end-to-end with two
// agent fixtures: one whose permission denies under `task` (the explore
// subagent must NOT appear), one whose permission denies under the legacy
// `spawn_agent` key (the explore subagent MUST still appear because the
// new lookup ignores that key). The first proves the new behavior; the
// second proves the legacy key no longer gates the filter (BC matrix
// "Saved permission rules — task key" row 3).
//
// References: WAVE.md step 3, INTEGRATION_INVARIANTS.md
// `spawn-agent-description-filters-by-task-rules`,
// PERMISSION_MAPPING.md § "Post-Wave-3 mapping (task group)".

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ProviderID, ModelID } from "@/provider/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../../test/fixture/fixture"
import { testEffect } from "../../test/lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

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

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const ENUM_HEADER = "Available agent types and the tools they have access to:"

const findEnumeration = (description: string) => {
  const headerIdx = description.indexOf(ENUM_HEADER)
  if (headerIdx < 0) {
    throw new Error(
      `description missing enumeration header "${ENUM_HEADER}". ` +
        "describeSpawnAgent / describeTask must always emit it.",
    )
  }
  return description.slice(headerIdx)
}

describe("ToolRegistry.describeSpawnAgent — Wave 3 task-key filter", () => {
  it.live(
    "permission.task: { explore: deny } removes explore from spawn_agent enumeration",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const build = yield* agents.get("build")
          // Append a single rule under the task key. evaluate uses findLast,
          // so this overrides the build agent's defaults for "explore".
          const taskDeny: Permission.Ruleset = [
            { permission: "task", pattern: "explore", action: "deny" },
          ]
          const agent = { ...build, permission: Permission.merge(build.permission, taskDeny) }
          const tools = yield* registry.tools({ ...STUB_MODEL, agent })
          const spawn = tools.find((t) => t.id === "spawn_agent")
          if (!spawn) throw new Error("spawn_agent missing from registry tools")
          const enumeration = findEnumeration(spawn.description)
          // explore filtered out via task: deny.
          expect(enumeration).not.toMatch(/^- explore:/m)
          // general unaffected — present.
          expect(enumeration).toMatch(/^- general:/m)
        }),
      ),
  )

  it.live(
    "legacy permission.spawn_agent: { explore: deny } no longer gates spawn_agent enumeration",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const build = yield* agents.get("build")
          // BC matrix: saved per-friend rules silently stop matching after
          // Wave 3. A user who had `permission.spawn_agent: { explore: deny }`
          // before now sees explore in the enumeration again.
          // (BACKWARD_COMPAT.md "Out of scope" documents the migration.)
          const legacyDeny: Permission.Ruleset = [
            { permission: "spawn_agent", pattern: "explore", action: "deny" },
          ]
          const agent = { ...build, permission: Permission.merge(build.permission, legacyDeny) }
          const tools = yield* registry.tools({ ...STUB_MODEL, agent })
          const spawn = tools.find((t) => t.id === "spawn_agent")
          if (!spawn) throw new Error("spawn_agent missing from registry tools")
          const enumeration = findEnumeration(spawn.description)
          // explore is still present — the legacy spawn_agent key is no
          // longer consulted by the filter.
          expect(enumeration).toMatch(/^- explore:/m)
          expect(enumeration).toMatch(/^- general:/m)
        }),
      ),
  )

  it.live(
    "describeSpawnAgent and describeTask filters agree (both consult task key)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const build = yield* agents.get("build")
          const taskDeny: Permission.Ruleset = [
            { permission: "task", pattern: "explore", action: "deny" },
          ]
          const agent = { ...build, permission: Permission.merge(build.permission, taskDeny) }
          const tools = yield* registry.tools({ ...STUB_MODEL, agent })

          const spawn = tools.find((t) => t.id === "spawn_agent")
          const task = tools.find((t) => t.id === "task")
          if (!spawn || !task) throw new Error("spawn_agent / task missing from registry tools")

          // Both tools' enumerations should now agree: explore filtered, general kept.
          const spawnEnum = findEnumeration(spawn.description)
          const taskEnum = findEnumeration(task.description)
          expect(spawnEnum).not.toMatch(/^- explore:/m)
          expect(taskEnum).not.toMatch(/^- explore:/m)
          // general is "subagent" mode (eligible for spawn_agent which excludes
          // hidden) AND non-primary (eligible for task which excludes "primary").
          // Both enumerations include it.
          expect(spawnEnum).toMatch(/^- general:/m)
          expect(taskEnum).toMatch(/^- general:/m)
        }),
      ),
  )
})
