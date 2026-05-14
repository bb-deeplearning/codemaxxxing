# Gotchas — append-only knowledge base (curated for this campaign)

This file is APPEND-ONLY by every wave's executor. If you hit a sharp edge, write a new entry here BEFORE finishing the wave so the next executor doesn't pay the same cost.

The previous campaign's `GOTCHAS.md` (1727 lines, 31 entries) is the full knowledge base. It lives at:

```
.wave/campaigns/codex-parity-2026-05-13/plan/GOTCHAS.md
```

That file is too long to atomically read every wave. **This file is the curated index for this campaign**: each entry below is a one-paragraph summary of an inherited gotcha plus a pointer to the full entry in the previous file. Read THIS file end-to-end on every wave entry. When a summary matches a surface you're touching, OPEN the full entry from the previous file — that has the code examples and the deep-dive.

## How to read

1. Skim the index below.
2. For every match against the surfaces your wave touches, open the full entry in the previous campaign's file via the pointer.
3. The entries marked **[CRITICAL FOR THIS CAMPAIGN]** are guaranteed-relevant — read those full entries even if you don't think they apply.

## How to write

When you discover something new during a wave, append a new entry at the BOTTOM of THIS file (preserve all existing entries verbatim). Use the format from the previous campaign's file (slug, discovered-in, surfaces, severity, symptom, root cause, fix pattern, reference). Commit the new entry as part of the wave's outcome commit.

---

## Inherited entries — index

### Coverage / test infrastructure

- **`bun-coverage-line1-quirk`** — A file's first import line may report 0 hits in lcov even though the import is evaluated. Reorder line 1 to `import * as X from "node:..."` to fix. **[CRITICAL FOR THIS CAMPAIGN]** when adding new files. Full entry: previous GOTCHAS.md lines 90-115.

- **`bun-coverage-line1-schema-class-only`** — Same line-1 quirk hits Schema.Class-only files differently. Reorder so line 1 is NOT `import { Schema } from "effect"`. Full entry: previous GOTCHAS.md lines 717-758.

- **`schema-class-function-coverage`** — `Schema.TaggedErrorClass` keeps function% < 100% even at 100% line coverage. Bar is 100% LINE coverage; function% is a lossy proxy. Full entry: previous GOTCHAS.md lines 154-176.

- **`bun-test-bench-file-path`** — `bun test test/perf/foo.bench.ts` matches no files; prefix with `./`. **[CRITICAL FOR THIS CAMPAIGN]** for every wave bench. Full entry: previous GOTCHAS.md lines 180-201.

- **`bench-file-pattern-split`** — Two valid patterns for `*.bench.ts` files; pick the embedded `test()` + `afterAll` pattern for per-wave benches. Full entry: previous GOTCHAS.md lines 205-231.

- **`bun-coverage-aggregation-flake`** — `bun test --coverage <dir>/` can drop branch coverage on lines that single-file runs cover. **[CRITICAL FOR THIS CAMPAIGN]** — always use single-file coverage runs. Full entry: previous GOTCHAS.md lines 309-334.

- **`bun-test-coverage-source-file-arg-runs-zero-tests`** — `bun test --coverage <source-file-path>` runs ZERO tests but exits 0. Use the test file substring instead. **[CRITICAL FOR THIS CAMPAIGN]** for every coverage assertion. Full entry: previous GOTCHAS.md lines 1407-1473.

- **`bun-test-test-dir-runs-baseline-orchestrator`** — `bun test test/` reruns the baseline orchestrator and OVERWRITES `baseline-perf.json`. Don't do it; run per-area instead. If you accidentally regen, restore via `git checkout`. **[CRITICAL FOR THIS CAMPAIGN]** — the baseline is frozen. Full entry: previous GOTCHAS.md lines 1055-1100.

### Effect v4 specifics

- **`effect-v4-either-renamed-to-result`** — `Either` no longer ships under `effect`. Use `Result` + `Effect.result` + `Result.isSuccess` / `r.success`. **[CRITICAL FOR THIS CAMPAIGN]** in test helpers that convert typed-error effects. Full entry: previous GOTCHAS.md lines 573-625.

- **`subscriptionref-changes-is-top-level`** — `SubscriptionRef.changes(ref)` (top-level), not `ref.changes`. **[CRITICAL FOR THIS CAMPAIGN]** — Wave 2's watcher subscribes to the child's status SubscriptionRef. Full entry: previous GOTCHAS.md lines 675-714.

- **`bench-managed-runtime-needs-effect-scoped`** — `provideTmpdirInstance` requires `Effect.scoped` wrap when run via `ManagedRuntime`. **[CRITICAL FOR THIS CAMPAIGN]** for any wave bench. Full entry: previous GOTCHAS.md lines 629-672.

- **`bench-effect-runpromise-loses-instance-in-async-callback`** — `await Effect.runPromise(<instance-effect>)` inside `Effect.promise(async () => ...)` crashes with "No context found for instance". Poll inside `Effect.gen` instead. **[CRITICAL FOR THIS CAMPAIGN]** — Wave 1 / 2 / 3 integration tests poll for state. Full entry: previous GOTCHAS.md lines 1000-1052.

### AgentControl / multi-agent state

- **`agentcontrol-providerref-must-live-in-layer-not-instancestate`** — Single-value, instance-agnostic state (e.g. registered runLoop closure) must live at LAYER scope, not InstanceState. **[CRITICAL FOR THIS CAMPAIGN]** — Wave 1's per-root refactor must respect this rule. Full entry: previous GOTCHAS.md lines 929-997.

- **`bus-subscriber-needs-instance-state-fork-and-instance-ref`** — Long-lived bus subscribers must fork inside `InstanceState.make` AND re-inject `InstanceRef`. Tests need 20ms sleeps before publishing. **[CRITICAL FOR THIS CAMPAIGN]** — Wave 1's `Session.Event.Deleted` subscriber for per-root teardown follows this exact pattern. Full entry: previous GOTCHAS.md lines 1154-1221.

- **`eventv2-and-bus-dual-emission-with-parallel-type-prefixes`** — When subscribing to events emitted by ANOTHER service via `EventV2.run`, construct a local `BusEvent.Definition` shape from the EventV2 def's `Sync.type` and `Sync.properties`. **[CRITICAL FOR THIS CAMPAIGN]** — Wave 1's `Session.Event.Deleted` subscriber follows the same `Inbound` shape pattern as the existing `Inbound.StepStarted/Ended`. Full entry: previous GOTCHAS.md lines 1224-1297.

- **`bus-subscribe-helper-vs-service-method-cross-runtime-mismatch`** — Top-level `Bus.subscribe(...)` and in-effect `bus.subscribeCallback(...)` target different PubSubs in `testEffect` layers. Use the in-effect Service method for tests. Full entry: previous GOTCHAS.md lines 486-522.

- **`syncevent-publish-uses-top-level-bus-runtime`** — Events emitted via `SyncEvent.run` land on the top-level Bus.publish runtime. Tests subscribing to those events must use the top-level `Bus.subscribe(...)` helper, not the in-effect `bus.subscribeCallback`. **[CRITICAL FOR THIS CAMPAIGN]** — Wave 1's per-root teardown listens for `Session.Event.Deleted` which fires via `sync.run`. Full entry: previous GOTCHAS.md lines 1477-1527.

- **`agentcontrol-required-by-toolregistry-existing-test-layers`** — Adding a new dep to ToolRegistry's layer requirements silently breaks every test layer that builds ToolRegistry from `layer` (not `defaultLayer`). Hunt with `git grep "ToolRegistry.layer.pipe" packages/opencode/test`. Full entry: previous GOTCHAS.md lines 890-925.

### Tool definition shapes

- **`tool-define-inner-effect-gen-closing-brace`** — `Tool.define` factory wrapped in inner `Effect.gen` leaves the closing `})` as 0-hit. Drop the inner wrapper. Full entry: previous GOTCHAS.md lines 762-822.

- **`tool-execute-needs-explicit-result-type-when-branches-have-disjoint-metadata`** — Multi-branch `execute` with disjoint `metadata` shapes needs explicit `Effect.Effect<Tool.ExecuteResult>` annotation. Full entry: previous GOTCHAS.md lines 826-887.

- **`tool-context-ask-typed-as-void`** — `Tool.Context.ask` returns `Effect<void>` but at runtime can fail; use `Effect.acquireUseRelease` for cleanup. Full entry: previous GOTCHAS.md lines 387-441.

### PTY (relevant for Wave 4 backward-compat)

- **`pty-onexit-auto-remove-tui-only`** — `proc.onExit` auto-removal must gate on `origin === "tui"`. Full entry: previous GOTCHAS.md lines 235-269.

- **`pty-create-term-override-tui-only`** — `Pty.create` `TERM=xterm-256color` overlay must gate on `origin === "tui"`. Full entry: previous GOTCHAS.md lines 337-383.

- **`pty-bench-baseline-vs-new-work`** — Combining new work into an existing baseline metric is comparing apples to oranges. Split metrics. Full entry: previous GOTCHAS.md lines 273-306.

- **`tty-line-discipline-echo-defeats-clamp-timing-tests`** — TTY echo defeats Pty.read timing tests. Verify clamp at unit level. Full entry: previous GOTCHAS.md lines 445-482.

### Perf / bench methodology

- **`opentui-render-bench-noise-needs-best-of-n`** — opentui `renderOnce` benches need best-of-3 to suppress noise. (Not expected to apply this campaign — no TUI benches planned. Listed for completeness.) Full entry: previous GOTCHAS.md lines 525-569.

- **`opentui-multi-text-node-vs-single-baseline-1.5x-cap`** — N separate `<text>` nodes inherently exceed the single-text baseline by >1.5×; use `<text><span/>...<span/></text>` to stay within budget. (Not expected to apply this campaign.) Full entry: previous GOTCHAS.md lines 1355-1404.

- **`runloop-bench-vs-baseline-methodology-mismatch`** — In-`Effect.gen` microbench loops measure ns-scale work; baseline measures ns + per-sample `Effect.runPromise` overhead. Treat the comparison as a sanity check, not a strict bound. Full entry: previous GOTCHAS.md lines 1103-1151.

- **`opentui-testRender-leak`** — `testRender` from `@opentui/solid` allocates native resources per call; always `handle.renderer.destroy()`. Full entry: previous GOTCHAS.md lines 118-150.

- **`e2e-perf-sibling-fanout-needs-median-of-n`** — e2e perf invariants comparing single-session to N-sibling samples need median-of-N to avoid flakes under suite pollution. **[CRITICAL FOR THIS CAMPAIGN]** if Wave 4 re-runs the wave-14 e2e perf invariants. Full entry: previous GOTCHAS.md lines 1629-1681.

### TUI rendering (relevant for backward compat)

- **`tui-flex-row-with-tall-text`** — opentui freezes when a flex-row contains a tall `<text>` child. (Not directly applicable this campaign; relevant if any wave touches a TUI hot path.) Full entry: previous GOTCHAS.md lines 50-86.

- **`tui-component-coverage-needs-mount-split`** — Hooks-using TUI components must split into helpers+view + wrapper for 100% coverage. (Not expected to apply this campaign.) Full entry: previous GOTCHAS.md lines 1301-1352.

### Permission / tool routing

- **`permission-disabled-removes-tool-from-active-set`** — Wildcard `permission: deny` strips the tool from the model's active toolset; the tool's own `ctx.ask` denial flow never fires. Use specific patterns to test runtime denial. (Relevant if any wave adds a permission-denial integration test.) Full entry: previous GOTCHAS.md lines 1583-1625.

### ID brand coercion

- **`session-id-descending-not-make-for-fixture-string-coercion`** — Use `SessionID.descending(string)` (or `.ascending`) instead of `.make(string)` for fixture string-to-brand coercion. **[CRITICAL FOR THIS CAMPAIGN]** for any test that synthesizes SessionID values. Full entry: previous GOTCHAS.md lines 1531-1579.

### The shared root cause

- **`codex-role-vocabulary-imported-verbatim`** — Importing codex's `default/explorer/worker` role names without mapping to opencode's existing subagents. The fix landed before this campaign; the lesson is general: when porting concepts, map them to host-codebase primitives, never invent new vocabulary that conflicts. Tests must assert real behavior, not just propagation. **[CRITICAL FOR THIS CAMPAIGN]** — this is the immediate ancestor of the campaign's integration-first rule. Full entry: previous GOTCHAS.md lines 1682-1727.

---

## New entries — append below this line

(Empty at campaign start. Each wave's executor that discovers a new sharp edge appends an entry here following the format used in the previous campaign's file.)

## [word-boundary-regex-vs-prose-collisions] `\bword\b` matches common English words in tool description prose

**Discovered in:** wave_0
**Date:** 2026-05-14
**Surfaces affected:** any test that asserts "forbidden word X must not appear" against a tool's full description string when the description is a concat of prose (`*.txt`) + structured enumeration (registry-appended bullets)
**Severity:** DX-trap

### Symptom

Wave 0 spec test 1 of the bug-3 audit asserted `expect(spawn.description).not.toMatch(/\bworker\b/)` (and `/\bexplorer\b/`, `/\bdefault\b/`) to verify the codex role names did not appear as agent types. Spec gotcha 4a explicitly claimed the word-boundary regex was safe against the prose. Test failed at runtime: `\bexplorer\b` matched "an explorer." (line 92 of agent-spawn.txt), `\bworker\b` matched "Observer/worker —" (line 44), `\bdefault\b` matched "by default." (line 29) and "(default):" (line 107).

### Root cause

Word boundaries `\b` match between a word character (`[A-Za-z0-9_]`) and a non-word character. In prose, EVERY occurrence of a common English word in a sentence is bounded by spaces, punctuation, parentheses, or em-dashes — all non-word chars. So `\bword\b` matches every English usage of the word. The spec author conflated "underscore-suffixed" cases (`worker_a`, `worker_1` — `_` is a word char so `\bworker\b` doesn't match) with all prose mentions; the latter ARE matched.

The deeper issue: the description is a CONCAT of two distinct surfaces — the prose from `agent-spawn.txt` (illustrative, narrative) and the registry's appended enumeration (`describeSpawnAgent` output, structured `- name: description` bullets). The bug-3 fix operates on the enumeration only. A whole-string assertion conflates the two.

### Fix pattern

When asserting "forbidden-word X must not appear AS A STRUCTURED ENTRY", scope the regex to the structured section. Pattern: locate the enumeration header, slice from there, then anchor the regex to bullet starts:

```ts
const ENUM_HEADER = "Available agent types and the tools they have access to:"
const headerIdx = spawn.description.indexOf(ENUM_HEADER)
if (headerIdx < 0) throw new Error("enumeration header missing — describer changed?")
const enumeration = spawn.description.slice(headerIdx)
expect(enumeration).not.toMatch(/^- explorer:/m)   // matches only bullet entries
```

The anchor `^- name:` (multiline regex) catches enumeration entries while ignoring prose mentions. The header-existence guard catches the case where `describeSpawnAgent` is renamed/removed.

For tests that need to verify "this word does not appear ANYWHERE", use the underlying SOURCE (the registry method's return value, not the rendered tool description) so prose and enumeration stay separable.

### Reference

- `packages/opencode/test/integration/multi-agent-invariants.test.ts:140-179` — the corrected test scoping the assertion to the enumeration only.
- `packages/opencode/src/tool/registry.ts:326-339` — `describeSpawnAgent` builds the enumeration; the `"Available agent types and the tools they have access to:"` header is the stable anchor.
- `.wave/campaigns/codex-parity-hardening-2026-05-14/waves/wave_0/NOTES.md` — full empirical story.

---

## [bug-3-fix-left-test-files-with-stale-required-shape] making a Schema field required without updating dependent tests breaks runtime + typecheck silently

**Discovered in:** wave_0
**Date:** 2026-05-14
**Surfaces affected:** `Schema.Struct` field that was previously `Schema.optional` and is changed to required; tests that build inputs without supplying the new required field
**Severity:** DX-trap

### Symptom

Bug-3 fix (`c86c58f94`) made `agent_type` required on `spawn_agent`'s `Parameters` (was `Schema.optional`). The fix updated production code (validation logic + description) but did NOT update dependent test files. Result: 21 typecheck errors in `agent-spawn.test.ts` (20) and `schema.test.ts` (1), plus 14 + 2 runtime test failures the typechecker missed where `Tool.Def`-cast call sites erased Parameters typing. The errors slept on the `codex-parity` branch from the fix commit until wave 0 surfaced them.

Additionally, `schema.test.ts` had two BEHAVIORAL assertions that became factually wrong:
- `expect((json.required ?? []).slice().sort()).toEqual(["message", "task_name"])` — should now include `"agent_type"`.
- `test("accepts message + task_name only", ...)` — schema no longer accepts that input shape; agent_type is required.

These were latent bugs on the branch, not flagged by `bun test` because nobody was running the schema/agent-spawn unit tests as part of routine verification. Wave 0's tooling-touch work surfaced them.

### Root cause

When changing `Schema.optional(...)` → required (`Schema.String.annotate(...)`) on a field, every call site that built the input WITHOUT that field becomes an error — but only at the call site where the type is concretely known. Sites that pass the input through a generic `Tool.Def`-typed handle erase the Parameters type, so the typechecker doesn't flag them. The runtime schema validator catches them as `SchemaError(Missing key)`.

Combined with the team practice of running `bun typecheck` separately from per-file `bun test` runs, a schema tightening can quietly accumulate test debt that's invisible until someone hits the affected file.

### Fix pattern

When tightening a Schema field's optionality:

1. `bun typecheck` immediately and fix every flagged call site in the same commit.
2. `git grep "<field-name>"` across `*.test.ts` to find sites that route through type-erased handles.
3. Run the affected test files (`bun test path/to/affected/file.test.ts`) to surface runtime SchemaError missing-key failures.
4. Audit any test asserting on the schema's `required` list / `accepts` happy path — these encode the OLD shape and become stale.

For tool tests specifically: prefer typed `Tool.Def<typeof Parameters, ...>` over plain `Tool.Def` cast where possible, so future schema changes flag at the call site.

### Reference

- Commit `c86c58f94` — the fix that landed the required tightening without updating dependents.
- Commits `45d2fbaf9` + the wave-0-resume commit — the cleanup.
- Affected files: `packages/opencode/src/tool/agent-spawn/agent-spawn.test.ts`, `packages/opencode/src/tool/agent-spawn/schema.test.ts`, `packages/opencode/test/integration/multi-agent-tools.test.ts`.

---

<!--
Entry format reminder:

## [<short-slug>] <one-line title>

**Discovered in:** wave_<N>
**Date:** YYYY-MM-DD
**Surfaces affected:** <which files / which subsystem / what kind of work triggers it>
**Severity:** <perf-regression | correctness-bug | DX-trap | API-quirk>

### Symptom

<what you saw, observably, that was wrong or surprising>

### Root cause

<one paragraph explaining why>

### Fix pattern

<concrete: how to avoid this in future code, with a one-line code example if helpful>

### Reference

<link to specs/, commits, or external docs that have the long-form story>

---
-->
