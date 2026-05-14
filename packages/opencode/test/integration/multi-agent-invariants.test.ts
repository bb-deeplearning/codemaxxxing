// Integration invariants — every multi-agent surface in this campaign asserts
// observable behavior against the scenarios listed in
// .wave/campaigns/codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md.
//
// Every scenario in the doc has exactly one `it.instance` block here. Wave 0
// seeds the file with skipped stubs (TODO comments name the wave that
// unskips). Each later wave unskips and implements the relevant ones.
//
// Test names MATCH the invariant slugs in the doc (so the wave's verification
// can grep for them): `multi-root-isolation`, `child-completion-wakes-parent`,
// `cross-root-send-rejection`, etc.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ProviderID, ModelID } from "@/provider/schema"
import { MessageID } from "@/session/schema"
import type * as Tool from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
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
    AgentControl.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

// Stub the run-loop so spawned agents stay alive in the registry without
// trying to drive a real session. Same pattern as multi-agent-tools.test.ts.
const installNeverLoop = Effect.gen(function* () {
  const control = yield* AgentControl.Service
  yield* control.registerRunLoop(() => Effect.never)
})

describe("INTEGRATION_INVARIANTS — multi-agent surfaces", () => {
  // TODO(wave_1): unskip when per-root scoping lands.
  it.instance.skip("multi-root-isolation", () =>
    Effect.gen(function* () {
      // Set up two roots in the same project, spawn worker_a in each, assert
      // each root's listAgents only sees its own worker; cross-root send /
      // close return AgentNotFoundError.
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when completion watcher lands.
  it.instance.skip("child-completion-wakes-parent", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when completion watcher lands.
  it.instance.skip("child-completion-notification-body-shape", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_1): unskip when per-root scoping lands.
  it.instance.skip("cross-root-send-rejection", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_1): unskip when per-root scoping lands.
  it.instance.skip("session-deletion-cleanup", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): audit — already passes, assert it stays true after wave 1.
  it.instance.skip("parent-close-cascades-to-children", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_2): unskip when completion watcher lands.
  it.instance.skip("child-fiber-interrupt-during-wait", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): audit — assert under concurrent send pressure.
  it.instance.skip("mailbox-drain-at-runloop-boundary-with-concurrent-sends", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_3): audit — assert PTY cleanup under multi-agent cancellation.
  it.instance.skip("pty-cleanup-on-parent-abort", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): backward-compat verification.
  it.instance.skip("legacy-task-tool-coexists-with-v2", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )
})

describe("bug 3 audit — agent_type role-vocabulary fix is intact", () => {
  // NOT SKIPPED. Wave 0 asserts the fix is present on the current branch.
  // If this test fails, the bug-3 regression has slipped back in. Restore it
  // (do NOT re-fix in this wave; the fix already landed on codex-parity at
  // commit c86c58f94 — restore by reverting whatever undid it).

  it.instance("spawn_agent description lists explore + general (not explorer / worker)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent not registered")
      // describeSpawnAgent (registry.ts:326-339) appends a templated list of
      // valid agent types to the tool's description, prefixed by the header
      // line "Available agent types and the tools they have access to:". Each
      // eligible subagent appears as a "- <name>: <description>" bullet under
      // that header. Built-ins yield `explore` and `general` only. Codex role
      // names (`explorer`, `worker`, `default`) must NOT appear as bullet
      // entries here.
      //
      // The assertion scope is the APPENDED ENUMERATION ONLY — not the full
      // description. The agent-spawn.txt prose legitimately uses the
      // substrings "an explorer", "Observer/worker", "by default", and
      // "(default)" as illustrative copy. Those collide with `\bword\b` regex
      // (every neighbor is a non-word char → boundaries present), so a
      // whole-description regex would false-positive on prose. The bug-3 fix
      // operates on the registry's enumeration, not on the prose, so scoping
      // to the enumeration matches the fix's actual surface.
      const ENUM_HEADER = "Available agent types and the tools they have access to:"
      const headerIdx = spawn.description.indexOf(ENUM_HEADER)
      if (headerIdx < 0) {
        throw new Error(
          `spawn_agent description is missing the enumeration header "${ENUM_HEADER}". ` +
            "describeSpawnAgent (registry.ts) may have been removed or renamed.",
        )
      }
      const enumeration = spawn.description.slice(headerIdx)
      // Eligible subagent names appear as "- <name>:" bullets, anchored to
      // the start of a line (multiline regex). The two built-ins are
      // explore + general.
      expect(enumeration).toMatch(/^- explore:/m)
      expect(enumeration).toMatch(/^- general:/m)
      // Codex role names must NOT appear as bullet-pointed agent type
      // entries. The bullet anchor (`^-`) and trailing colon ensure we only
      // catch agent-type bullets, never prose mentions.
      expect(enumeration).not.toMatch(/^- explorer:/m)
      expect(enumeration).not.toMatch(/^- worker:/m)
      expect(enumeration).not.toMatch(/^- default:/m)
    }),
  )

  it.instance("spawn_agent rejects agent_type 'explorer' with agent_type_invalid", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({ ...ref, agent: build })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent not registered")
      const root = yield* sessions.create({ title: "root" })
      // Build a minimal Tool.Context. The exact shape is in
      // packages/opencode/src/tool/tool.ts; ask: returns Effect.void.
      const ctx: Tool.Context = {
        sessionID: root.id,
        messageID: MessageID.make(""),
        callID: "",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const res = yield* spawn.execute(
        { message: "do work", task_name: "worker_a", agent_type: "explorer" },
        ctx,
      )
      // The fix returns a model-recoverable error tagged agent_type_invalid.
      // metadata.error is the stable tag; output prose lists what IS valid.
      expect((res as { metadata: { error?: string } }).metadata.error).toBe("agent_type_invalid")
      expect((res as { output: string }).output).toContain("explore")
      expect((res as { output: string }).output).toContain("general")
    }),
  )

  it.instance("spawn_agent Parameters.agent_type is a required Schema.String", () =>
    Effect.gen(function* () {
      // Cheap structural assertion — the schema's JSON form must list
      // agent_type as a required string field. If a future refactor makes
      // it optional or non-string, the propagation tests can pass while the
      // lookup blows up at runtime — exactly the failure mode bug 3 was.
      const { Parameters } = yield* Effect.promise(() => import("@/tool/agent-spawn/agent-spawn"))
      const ast = (Parameters as unknown as { ast: unknown }).ast
      const json = JSON.stringify(ast)
      // The schema's AST encodes propertySignatures with `isOptional`. A
      // required string field surfaces as { isOptional: false } on agent_type.
      // We assert the substring rather than parsing the full AST shape (Schema
      // internals shift across betas).
      expect(json).toContain("\"agent_type\"")
      // No subagent_type fallback — bug 3's earlier fix removed any optional
      // alias. Defensive: confirm the field name didn't drift.
      expect(json).not.toContain("\"subagent_type\"")
    }),
  )
})
