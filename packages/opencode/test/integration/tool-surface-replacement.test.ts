// Integration invariants — every tool-surface-replacement scenario in this
// campaign asserts observable behavior against the scenarios listed in
// .wave/campaigns/replace-bash-task-2026-05-15/plan/INTEGRATION_INVARIANTS.md.
//
// Every invariant in the doc has exactly one `it.instance` block here. Wave 0
// seeds the file with skipped stubs (TODO comments name the wave that
// unskips). Each later wave unskips and implements the relevant ones.
//
// Test names MATCH the invariant slugs in the doc so the wave's verification
// can grep for them.

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
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// `expect` stays imported per the WAVE.md template — later waves swap stub
// bodies for real assertions. Reference once so unused-import linters stay
// quiet on the Wave 0 scaffold.
void expect

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

describe("INTEGRATION_INVARIANTS — tool surface replacement", () => {
  // TODO(wave_1): unskip when scanner extract preserves byte-identical bash output across the 50-command corpus.
  it.instance.skip("scanner-extract-preserves-bash-output", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_1): unskip when scanCommand is deterministic under 64 concurrent invocations.
  it.instance.skip("scanner-deterministic-under-concurrent-load", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_1): unskip when scanCommand survives 1000 fuzz inputs without crashing.
  it.instance.skip("scanner-handles-1000-fuzz-inputs-without-crash", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when exec_command honors saved permission.bash allow patterns.
  it.instance.skip("exec-command-honors-saved-bash-allow-pattern", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when exec_command triggers external_directory before bash for outside-cwd paths.
  it.instance.skip("exec-command-triggers-external-directory-for-outside-cwd-paths", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when write_stdin auto-allows after a pid:<N> rule registers under permission key bash.
  it.instance.skip("write-stdin-auto-allows-after-pid-rule-registered-under-bash", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when permission.bash deny hides exec_command and write_stdin from the model tool list.
  it.instance.skip("permission-bash-deny-hides-exec-and-stdin-from-tool-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when 32 concurrent exec_command flows do not cross-contaminate permission state.
  it.instance.skip("exec-command-concurrent-permission-flows-do-not-cross-contaminate", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): unskip when spawn_agent honors saved permission.task allow patterns.
  it.instance.skip("spawn-agent-honors-saved-task-allow-pattern", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): unskip when spawn_agent description filters its eligible list by permission.task rules.
  it.instance.skip("spawn-agent-description-filters-by-task-rules", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): unskip when permission.task deny hides all six v2 multi-agent tools from the list.
  it.instance.skip("permission-task-deny-hides-all-six-v2-tools-from-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when bash is dropped from the model-visible tool list.
  it.instance.skip("model-tool-list-no-bash", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when task is dropped from the model-visible tool list.
  it.instance.skip("model-tool-list-no-task", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when plugin tool.definition hooks for bash apply to exec_command.
  it.instance.skip("plugin-bash-hook-applies-to-exec-command", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when plugin tool.definition hooks for task apply to spawn_agent.
  it.instance.skip("plugin-task-hook-applies-to-spawn-agent", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when ShellTool stays importable + executable from internal code despite being unadvertised.
  it.instance.skip("legacy-shell-tool-still-runnable-from-internal-code", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when TaskTool stays importable + executable from internal code despite being unadvertised.
  it.instance.skip("legacy-task-tool-still-runnable-from-internal-code", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the git safety protocol fragment verbatim in exec_command.txt.
  it.instance.skip("prose-migration-preserves-git-safety-protocol", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the PR creation flow fragment verbatim in exec_command.txt.
  it.instance.skip("prose-migration-preserves-pr-creation-flow", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the spawn_agent eligible-subagent-types listing.
  it.instance.skip("prose-migration-preserves-spawn-agent-eligible-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when migrated exec_command + spawn_agent descriptions stay within the prompt token budget.
  it.instance.skip("prompt-token-count-within-budget", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_6): unskip when every BACKWARD_COMPAT.md fixture × invocation tuple produces the expected outcome.
  it.instance.skip("bc-matrix-fully-green", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_6): unskip when the aggregated perf trend table shows no metric drifting beyond the per-wave budget.
  it.instance.skip("perf-trend-no-creep", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )
})
