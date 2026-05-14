# Wave 0 — Integration test infrastructure + INTEGRATION_INVARIANTS.md + bug 3 audit

<!--
Previous waves: none. This is the first wave of the campaign.
Also read:
- ../../INTEGRATION_INVARIANTS.md (full, in this campaign's plan/ dir)
- ../../GOTCHAS.md (full, in this campaign's plan/ dir)
- ../../STYLE.md, TDD.md (in this campaign's plan/)
- .wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md § "Cross-agent message injection"
-->

## Goal

Stand up the integration-test scaffolding for this campaign and verify the bug-3 fix is intact. Wave 1 onwards builds on this scaffold; without it, the campaign's integration-first rule has no shared home.

Three deliverables:

1. **`packages/opencode/test/integration/multi-agent-invariants.test.ts`** — new file. One `it.instance` block per invariant from `INTEGRATION_INVARIANTS.md`, all marked `.skip` with a TODO comment naming the wave that will unskip it. Contains real test bodies (so the file typechecks) but skipped so the wave doesn't fail trying to assert behavior the campaign hasn't fixed yet.
2. **Bug 3 audit test** — added to the same file (or its own file under `test/integration/`, your choice). A NON-SKIPPED `it.instance` test that asserts the bug-3 fix is intact: `agent_type` is required + Schema.String, `describeSpawnAgent` exists in registry.ts (test executes a `tools()` call and asserts the spawn_agent description includes "explore" / "general" but NOT "explorer" / "worker"), spawning with `agent_type: "explorer"` returns the `agent_type_invalid` error tag.
3. **No production code changes.** This wave creates test files only.

## Tasks

### Sub-agent A — `multi-agent-invariants.test.ts` skeleton + bug 3 audit

Single agent, no parallelism. The whole wave is one focused file.

Create `packages/opencode/test/integration/multi-agent-invariants.test.ts` with the following structure:

```ts
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
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
      const tools = yield* registry.tools({
        providerID: "test" as never,
        modelID: "test-model" as never,
        agent: build,
      })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent not registered")
      // describeSpawnAgent appends a templated list of valid agent types to
      // the tool's description. Built-ins are `explore` and `general`. Codex
      // role names (`explorer`, `worker`, `default`) must NOT appear as
      // standalone agent types.
      //
      // We use word-boundary regex (not toContain) because the prose in
      // agent-spawn.txt legitimately mentions "/root/explorers", "worker_a",
      // "worker_1", "workers" as illustrative path/name examples — those are
      // copy in the doc, not codex role names. The spec must reject only
      // the standalone words.
      expect(spawn.description).toMatch(/\bexplore\b/)
      expect(spawn.description).toMatch(/\bgeneral\b/)
      expect(spawn.description).not.toMatch(/\bexplorer\b/)
      expect(spawn.description).not.toMatch(/\bworker\b/)
      expect(spawn.description).not.toMatch(/\bdefault\b/)
    }),
  )

  it.instance("spawn_agent rejects agent_type 'explorer' with agent_type_invalid", () =>
    Effect.gen(function* () {
      yield* installNeverLoop
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const tools = yield* registry.tools({
        providerID: "test" as never,
        modelID: "test-model" as never,
        agent: build,
      })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent not registered")
      const root = yield* sessions.create({ title: "root" })
      // Build a minimal Tool.Context. The exact shape is in
      // packages/opencode/src/tool/tool.ts; ask: returns Effect.void.
      const ctx = {
        sessionID: root.id,
        messageID: "" as never,
        callID: "",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } as never
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
```

Notes for the implementer:

- The test file uses the existing `Layer.mergeAll(...)` layer that `multi-agent-tools.test.ts` uses — copy it, don't innovate. Every test that touches multi-agent surfaces gets the same layer.
- The `installNeverLoop` helper makes spawned agents stay alive in the registry without driving a real session — same pattern as `multi-agent-tools.test.ts`.
- For the bug-3 schema assertion, the cheap path (substring on the AST JSON) is good enough. A more rigorous assertion would walk the AST nodes; if the substring approach proves flaky, the next wave can upgrade it.
- All `.skip` blocks have TODO comments naming the wave that unskips. Do not unskip in Wave 0.
- The `ctx` object cast to `never` is intentional — `Tool.Context` has more fields than the test needs; the cast keeps the test body short. The bug-3 audit test's `expect((res as ...).metadata.error)` casts are likewise intentional (Tool.ExecuteResult's metadata is the wide `Record<string, unknown>`).

## Gotchas

1. **GOTCHAS.md `bun-coverage-line1-quirk`** — the new test file's line 1 is `import { afterEach, describe, expect } from "bun:test"`. That's a named import from a `bun:` builtin — it MAY trip the line-1 hit-count quirk depending on bun version. If the wave's coverage check fails by exactly one line on line 1, reorder so line 1 is `import * as path from "node:path"` (even if path isn't used in the file body, an unused import is fine and triggers the recording correctly). Don't let it hold up the wave.

2. **GOTCHAS.md `bun-test-coverage-source-file-arg-runs-zero-tests`** — the verification command must use the test-file substring, not a source-file path. Verification commands below already do this.

3. **GOTCHAS.md `bun-test-test-dir-runs-baseline-orchestrator`** — DO NOT run `bun test test/` to spot-check this wave's file. Run only the new file (`bun test ./test/integration/multi-agent-invariants.test.ts`) plus the existing one (`bun test ./test/integration/multi-agent-tools.test.ts`).

4. **Schema AST shape can shift across Effect betas.** The substring assertion on `Parameters` AST is a "this should not regress under refactor" test — if Effect upgrades cause it to break with no behavior change, weaken the assertion (e.g. just confirm `agent_type` is a key in the schema's described keys via `Schema.fields(Parameters)` if such an API exists in the current beta). Surface as USER QUESTION if both approaches break.

4a. **`agent-spawn.txt` legitimately uses substrings of forbidden role names.** The current prose contains `/root/explorers`, `worker_a`, `worker_1`, "workers", "an explorer", and "(default)" as illustrative copy. The bug 3 audit's negative assertions therefore MUST use `expect(...).not.toMatch(/\bword\b/)` (word-boundary regex) rather than `not.toContain("word")` — `toContain` does substring matching and would falsely fail on the legitimate prose. The wave 0 test bodies above already use the regex form; preserve them verbatim.

5. **ToolRegistry.tools needs ProviderID / ModelID branded values.** The existing `multi-agent-tools.test.ts` uses `ProviderID.make("test")` / `ModelID.make("test-model")`. Per GOTCHAS `session-id-descending-not-make-for-fixture-string-coercion`, the brand schemas have a `.make` shortcut that works with plain strings ONLY for ProviderID / ModelID (because they're not Identifier-prefixed brands). If TS rejects, copy the cast pattern from `multi-agent-tools.test.ts:31-34` exactly.

6. **`disposeAllInstances` in afterEach is critical.** Without it, the per-test InstanceState entries leak across tests in the same file. Multi-root tests in later waves will appear to "see" each other's roots if you skip this. Do not omit.

## Verification

```bash
cd packages/opencode

# 1. Typecheck — zero errors.
bun typecheck

# 2. Lint — zero errors.
bun lint

# 3. The new file runs (the bug-3 audit tests pass; all invariants are skipped).
bun test ./test/integration/multi-agent-invariants.test.ts

#    Expected output: 3 passing (bug 3 audit), 10 skipped (invariants).

# 4. Existing integration walkthrough still passes (no regression from the file
#    being added).
bun test ./test/integration/multi-agent-tools.test.ts

# 5. Coverage assertion on the new test file itself is meaningless (it IS the
#    test). Skip coverage for this wave.

# 6. NO perf bench for this wave — no production code touched.
```

If all four commands exit 0, the wave is complete. If the bug-3 audit tests FAIL on this branch, the bug-3 fix has been regressed somehow — diagnose by checking `git log --oneline -- packages/opencode/src/tool/agent-spawn/`. Restore the fix from the prior commit; do NOT re-implement. If you cannot restore, surface as USER QUESTION.

If only the substring schema assertion fails, see Gotcha 4 above.
