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
//
// Wave 4 — model-tool-list assertions covering invariants
// `model-tool-list-no-bash` and `model-tool-list-no-task`. The registry's
// `builtin` array drops `tool.shell` and `tool.task`, so per-agent
// `tools()` results no longer expose them while the codex-ported
// `exec_command` + `spawn_agent` (and 5 v2 friends) take their place.
// Per-agent coverage matches the BACKWARD_COMPAT.md "Snapshot diffs" rows
// for the build / plan / general / explore agents (caveman + custom-agent
// variations are user-defined and don't exist in clean test instances —
// covered by the snapshot-diff invariant in tool-surface-replacement.test.ts).

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
    "describeSpawnAgent filter consults task key (post-Wave-3 collapse)",
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
          if (!spawn) throw new Error("spawn_agent missing from registry tools")
          // Wave 4 — `task` tool is no longer in `tools()` output (dropped
          // from registry's builtin array). The describeTask branch in
          // tools() is dead code; the cross-check that describeTask and
          // describeSpawnAgent agree is now meaningless because task
          // isn't model-visible. We retain just the spawn_agent half of
          // the original Wave 3 assertion: explore filtered out via
          // task: deny, general unaffected.
          const spawnEnum = findEnumeration(spawn.description)
          expect(spawnEnum).not.toMatch(/^- explore:/m)
          expect(spawnEnum).toMatch(/^- general:/m)
        }),
      ),
  )
})

// =============================================================================
// Wave 4 — `tool.shell` and `tool.task` are dropped from the registry's
// `builtin` array. The model-visible tool list per agent must no longer
// contain `bash` or `task`. The codex-ported replacements (`exec_command` +
// `write_stdin` for shell, `spawn_agent` + 5 v2 friends for task) MUST stay
// visible. Per-agent coverage matches BACKWARD_COMPAT.md § "Snapshot diffs".
//
// Per Wave 0 NOTES item 6: `ToolRegistry.tools(...)` does NOT apply
// per-agent permission filtering (that happens downstream in
// `session/llm.ts:resolveTools` via `Permission.disabled`). All agents see
// the same builtin list from the registry; only `describeSpawnAgent` /
// `describeTask` enumerations vary by agent. So these per-agent assertions
// are equivalent on the registry surface — but enumerating each built-in
// agent makes the future drift case (someone adds an agent-level filter
// inside tools()) immediately visible per row.
//
// describeTask continues to be defined and exported by the registry — the
// `tool.id === TaskTool.id` branch in `tools()` is dead code after Wave 4
// because `filtered` no longer contains a tool with id "task" (per WAVE.md
// gotcha 2: kept for plugin reactivation). The fact that the branch is
// dead doesn't matter for these tests; we just assert the model-visible
// IDs.
// =============================================================================

const BUILTIN_AGENTS = ["build", "plan", "general", "explore"] as const

describe("ToolRegistry.tools — Wave 4 model-visible list excludes bash + task", () => {
  for (const agentName of BUILTIN_AGENTS) {
    it.live(
      `registry.tools() for ${agentName} agent does NOT include bash or task`,
      () =>
        provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const agents = yield* Agent.Service
            const agent = yield* agents.get(agentName)
            const tools = yield* registry.tools({ ...STUB_MODEL, agent })
            const ids = tools.map((t) => t.id)
            // model-tool-list-no-bash + model-tool-list-no-task invariants.
            expect(ids).not.toContain("bash")
            expect(ids).not.toContain("task")
            // exec_command + spawn_agent take their place. registry.tools()
            // does NOT apply per-agent permission filtering (per Wave 0
            // NOTES item 6), so all agents see the same builtin list.
            expect(ids).toContain("exec_command")
            expect(ids).toContain("write_stdin")
            expect(ids).toContain("spawn_agent")
            expect(ids).toContain("send_message")
            expect(ids).toContain("followup_task")
            expect(ids).toContain("wait_agent")
            expect(ids).toContain("list_agents")
            expect(ids).toContain("close_agent")
          }),
        ),
    )
  }
})
