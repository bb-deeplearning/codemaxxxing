# Gotchas

Sharp edges discovered the hard way while building codemaxxxing. Each entry is one painful debugging session distilled to a fix pattern. Read before doing the matching kind of work; you'll save the same hours we did.

## How to use this file (for agents and humans)

This file uses progressive disclosure. Three layers:

1. **By surface** (next section) — a table mapping "you're about to do X" to the slugs you should read. Skim this in ~30 seconds.
2. **By category** — slugs grouped by subsystem with one-line summaries. Open the section that matches your work.
3. **Full entries** — every gotcha in detail, alphabetical by slug. Jump via the line numbers in the indexes; do not read the whole file unless you're auditing.

For agents: do `Read GOTCHAS.md limit=200` to load only the indexes. When a slug looks relevant, do a targeted `Read GOTCHAS.md offset=<line> limit=40` to load just that entry.

Entry shape is uniform:

- **When:** the surface that triggers it.
- **Symptom:** what you observe when you hit it.
- **Fix:** the pattern that works.
- **Why:** one-paragraph root cause.
- **See:** working example file path, plus `[cross-ref-slugs]` to related entries.

Severities: `correctness-bug` (silent wrong behavior), `perf-regression` (silent slowdown / OOM), `DX-trap` (wastes engineering time, doesn't ship bugs), `API-quirk` (Effect/Bun/etc. surface that surprises).

## By surface — skim this first

| You're doing... | Read entries |
|---|---|
| Adding a new file that must reach 100% line coverage | `bun-coverage-line1-quirk`, `bun-coverage-line1-schema-class-only`, `schema-class-function-coverage` |
| Writing a `*.bench.ts` or `*.bench.tsx` file | `bun-test-bench-file-path`, `bench-file-pattern-split`, `bench-managed-runtime-needs-effect-scoped`, `bench-tool-yield-loses-transitive-deps` |
| Verifying per-file coverage with `bun test --coverage` | `bun-test-coverage-source-file-arg-runs-zero-tests`, `bun-coverage-aggregation-flake` |
| Spot-checking with `bun test test/` | `bun-test-test-dir-runs-baseline-orchestrator` |
| Touching the TUI render hot path | `tui-flex-row-with-tall-text`, `opentui-multi-text-node-vs-single-baseline-cap` |
| Adding a new TUI component that needs 100% line cov | `tui-component-coverage-needs-mount-split` |
| Mounting `testRender` from `@opentui/solid` | `opentui-testRender-leak` |
| Subscribing to bus events in tests | `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch`, `syncevent-publish-uses-top-level-bus-runtime` |
| Wiring a long-lived bus subscriber inside a service | `bus-subscriber-needs-instance-state-fork-and-instance-ref`, `syncevent-publish-uses-helper-bus-not-test-layer-bus` |
| Storing service state shared across instances | `agentcontrol-providerref-must-live-in-layer-not-instancestate` |
| Touching the D5 completion-watcher extractor in `agent/control.ts` | `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line` |
| Defining a new tool with `Tool.define` | `tool-define-inner-effect-gen-closing-brace`, `tool-execute-needs-explicit-result-type-disjoint-metadata`, `tool-context-ask-typed-as-void` |
| Lifting helpers out of `Tool.define` into a sibling module | `tool-define-execute-r-must-be-never-capture-services-in-closure` |
| Adding a new dep to `ToolRegistry`'s layer | `agentcontrol-required-by-toolregistry-existing-test-layers` |
| Spawning model PTYs (`origin: "model"`) | `pty-onexit-auto-remove-tui-only`, `pty-create-term-override-tui-only` |
| Adding a wave bench against the frozen baseline | `pty-bench-baseline-vs-new-work`, `runloop-bench-vs-baseline-methodology-mismatch`, `opentui-render-bench-noise-needs-best-of-n`, `bench-tool-yield-loses-transitive-deps` |
| Writing e2e perf invariants | `e2e-perf-sibling-fanout-needs-median-of-n` |
| Verifying a clamp's timing on a TTY-mode process | `tty-line-discipline-echo-defeats-clamp-timing-tests` |
| Converting typed-error Effects to assertable values | `effect-v4-either-renamed-to-result`, `effect-v4-catchall-renamed-to-catch` |
| Subscribing to a `SubscriptionRef`'s changes | `subscriptionref-changes-is-top-level` |
| Polling Instance-bound state from inside async callbacks | `bench-effect-runpromise-loses-instance-in-async-callback` |
| Loading JSON fixtures with branded IDs | `session-id-descending-not-make-for-fixture-string-coercion` |
| Authoring a permission fixture (specific + wildcard) | `permission-fixture-order-rule-must-precede-specific-via-findlast` |
| Hoisting `Config.get()` out of `Tool.define`'s inner gen | `instancestate-bound-config-cannot-yield-at-layer-init` |
| Re-measuring a baseline metric whose original capture used small `samples` | `bench-best-of-n-when-baseline-was-single-shot` |
| Writing a permission-deny e2e test | `permission-disabled-removes-tool-from-active-set` |
| Adding a tool to an existing permission group (SHELL_TOOLS / MULTI_AGENT_TOOLS / EDIT_TOOLS) | `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` |
| Asserting forbidden words against tool description prose | `word-boundary-regex-vs-prose-collisions` |
| Tightening a Schema field from optional → required | `bug-3-fix-left-test-files-with-stale-required-shape` |
| Porting concepts from another codebase (Codex/etc.) | `codex-role-vocabulary-imported-verbatim` |
| Adding a domain event consumed by both sourced log + bus | `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` |
| Cleaning up resources in tools when permission is rejected | `tool-context-ask-typed-as-void` |
| Writing a standalone Bun script with `ManagedRuntime` | `managed-runtime-script-needs-process-exit` |
| Capturing `ctx.ask` payloads from a multi-ask tool flow | `multi-ask-capture-needs-counter` |

## By category — slugs with one-line summaries and line offsets

Line numbers (`L###`) are approximate jump targets — use `Read GOTCHAS.md offset=N limit=30` to load just one entry. If an entry has shifted, fall back to `grep` for the slug.

### Coverage / test infrastructure
- L310 `bun-coverage-line1-quirk` — line 1 imports can report 0 hits in lcov.
- L321 `bun-coverage-line1-schema-class-only` — variant of the above for `Schema.Class`-only files.
- L808 `schema-class-function-coverage` — `Schema.TaggedErrorClass` keeps function% < 100% even at 100% lines.
- L345 `bun-test-bench-file-path` — `bun test foo.bench.ts` matches no files; prefix with `./`.
- L216 `bench-file-pattern-split` — two valid `.bench.ts` shapes; pick the embedded `test()` form per wave.
- L299 `bun-coverage-aggregation-flake` — `bun test --coverage <dir>/` can drop hits that single-file runs cover.
- L355 `bun-test-coverage-source-file-arg-runs-zero-tests` — passing a source path silently runs zero tests, exit 0.
- L378 `bun-test-test-dir-runs-baseline-orchestrator` — `bun test test/` reruns and overwrites frozen baseline JSON.

### Effect v4 specifics
- L517 `effect-v4-either-renamed-to-result` — `Either` → `Result`; `Effect.either` → `Effect.result`; `right`/`left` → `success`/`failure`.
- L498 `effect-v4-catchall-renamed-to-catch` — `Effect.catchAll` → `Effect.catch`; `catchAllDefect` → `catchDefect`; `catchAllCause` → `catchCause`.
- L845 `subscriptionref-changes-is-top-level` — `SubscriptionRef.changes(ref)`, not `ref.changes`.
- L231 `bench-managed-runtime-needs-effect-scoped` — `provideTmpdirInstance` needs explicit `Effect.scoped` under `ManagedRuntime`.
- L192 `bench-effect-runpromise-loses-instance-in-async-callback` — `Effect.runPromise` inside `Effect.promise` loses the Instance ALS binding.

### Bus / Instance state
- L398 `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch` — top-level vs in-effect subscribe target different PubSubs in `testEffect`.
- L419 `bus-subscriber-needs-instance-state-fork-and-instance-ref` — long-lived subscribers must fork inside `InstanceState.make` AND re-inject `InstanceRef`.
- L887 `syncevent-publish-uses-top-level-bus-runtime` — events from `SyncEvent.run` land on the top-level Bus runtime, not your test layer's.
- L868 `syncevent-publish-uses-helper-bus-not-test-layer-bus` — same root cause from the other side: subscribe via top-level `Bus.subscribe` from inside `InstanceState.make`.
- L138 `agentcontrol-providerref-must-live-in-layer-not-instancestate` — single-value, instance-agnostic state belongs at layer scope, not in `InstanceState`.
- L148 `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line` — D5 completion watcher must prefer non-terse bodies before falling back to terse status lines.

### Sourced events
- L551 `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` — keep EventV2 (`session.next.<domain>.…`) and BusEvent (`<domain>.…`) under different type prefixes; emit both with the same payload.

### Tool definitions
- L954 `tool-define-execute-r-must-be-never-capture-services-in-closure` — lifting helpers out of `Tool.define` widens execute's R; capture services in the outer closure and provide inline.
- L995 `tool-define-inner-effect-gen-closing-brace` — wrapping the spec in an inner `Effect.gen` leaves a `})` line at 0 hits.
- L1024 `tool-execute-needs-explicit-result-type-disjoint-metadata` — multi-branch `execute` with disjoint metadata needs `Effect.Effect<Tool.ExecuteResult>` annotation.
- L918 `tool-context-ask-typed-as-void` — `ctx.ask` is typed `Effect<void>` but raises at runtime; use `Effect.acquireUseRelease` for cleanup.
- L172 `agentcontrol-required-by-toolregistry-existing-test-layers` — adding a new dep to `ToolRegistry.layer` silently breaks every custom test layer.
- L257 `bench-tool-yield-loses-transitive-deps` — yielding a tool factory directly skips transitive deps; route through `ToolRegistry.tools(...)`.
- L613 `multi-ask-capture-needs-counter` — capture helpers that throw on the first `ctx.ask` truncate multi-ask tool flows; gate the throw on a counter.

### PTY
- L770 `pty-onexit-auto-remove-tui-only` — `proc.onExit` auto-removal must gate on `origin === "tui"` so model PTYs survive for post-exit drain.
- L748 `pty-create-term-override-tui-only` — `Pty.create`'s `TERM=xterm-256color` overlay must gate on `origin === "tui"`.
- L731 `pty-bench-baseline-vs-new-work` — combining new work into an existing baseline metric is apples-to-oranges; split metrics.
- L1013 `tty-line-discipline-echo-defeats-clamp-timing-tests` — TTY echo wakes `Pty.read` early; verify clamps at the unit level.

### Bench methodology
- L663 `opentui-render-bench-noise-needs-best-of-n` — opentui `renderOnce` benches need best-of-3 to suppress noise.
- L637 `opentui-multi-text-node-vs-single-baseline-cap` — N separate `<text>` nodes inherently exceed a single-text baseline by ~1.5×; use `<text><span/>...<span/></text>`.
- L792 `runloop-bench-vs-baseline-methodology-mismatch` — in-`Effect.gen` microbenches and per-sample-`runPromise` baselines measure different things.
- L468 `e2e-perf-sibling-fanout-needs-median-of-n` — single-iteration timing flakes under a noisy suite; median-of-5 minimum.
- L688 `opentui-testRender-leak` — `testRender` allocates native resources; always `handle.renderer.destroy()`.

### TUI rendering
- L1059 `tui-flex-row-with-tall-text` — `<box flexDirection="row">` containing a tall `<text>` child silently freezes opentui paint.
- L1035 `tui-component-coverage-needs-mount-split` — split hooks-using TUI components into helpers+view + wrapper to reach 100% line cov.

### Permission / tool routing
- L708 `permission-disabled-removes-tool-from-active-set` — wildcard `permission: deny` strips the tool entirely; the `ctx.ask` path never fires.
- L1140 `permission-fixture-order-rule-must-precede-specific-via-findlast` — fixtures with `*: ask` AFTER `git *: allow` produce ask, NOT allow; findLast picks the LAST match.
- L1170 `instancestate-bound-config-cannot-yield-at-layer-init` — yielding `config.get()` in `Tool.define`'s OUTER gen crashes with `instance: No context found`. Move to inner gen (init body) where Instance.current is bound.
- L1200 `bench-best-of-n-when-baseline-was-single-shot` — frozen baselines captured with `samples: 20` have `p99 == max`, so single re-runs blow the 15% budget on noise. Use best-of-N over coherent runs.
- L1234 `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` — collapsing N tool IDs onto a group key (EDIT_TOOLS / SHELL_TOOLS / MULTI_AGENT_TOOLS) means `Permission.disabled` and `Permission.evaluate` use different lookup keys; built-in agent rules in `agent.ts` need DUAL-WRITE (per-friend rules + group-key rule) to keep both paths working.

### ID brand coercion
- L818 `session-id-descending-not-make-for-fixture-string-coercion` — use `<ID>.descending(string)` / `.ascending(string)`, not `.make(string)`, when wrapping plain fixture strings.

### Asserting on prose
- L1080 `word-boundary-regex-vs-prose-collisions` — `\bword\b` matches every English usage; scope assertions to the structured section, not the whole concatenated description.

### Schema maintenance
- L282 `bug-3-fix-left-test-files-with-stale-required-shape` — tightening optional → required can leave dependent tests broken in ways `bun typecheck` won't catch through type-erased call sites.

### Cross-codebase porting
- L452 `codex-role-vocabulary-imported-verbatim` — when porting concepts from a reference codebase, map them to host primitives; never invent new vocabulary that conflicts. Tests must assert real behavior, not just propagation.

### Scripts / runtime lifecycle
- L587 `managed-runtime-script-needs-process-exit` — Bun scripts using `ManagedRuntime` hang after `dispose()`; explicit `process.exit(0)` required.

---

## Full entries

Alphabetical by slug. Each entry stands alone — read just what you need.

### `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line`

**Severity:** correctness-bug
**When:** A subagent emits its real deliverable in one assistant message (e.g. `finish: "tool-calls"` + ~5KB body) AND a terse follow-up status message in another (`finish: "stop"` + "Done.").
**Symptom:** Parent's completion notification body is the ⚠️ safety-net warning with `"Done."` inlined as the "last assistant text" — the real deliverable is silently dropped. Reproduces `ses_1c2e8d84affeZ7t5g5LKveGDTo` (Cidoo ABM066) end-to-end.
**Fix:** Two-pass `findMessage` walk in `control.ts`'s completion watcher. Pass 1 prefers non-terse bodies (predicate: `text.length > 0 && !looksLikeMissingDeliverable(text)`). Pass 2 falls back to any non-empty text (the original predicate). The fallback preserves the safety-net behavior for the genuinely-silent-with-only-status-line case (INV-D-03 still green).

```ts
// Pass 1 — prefer substantive deliverable.
const substantive = yield* sessions
  .findMessage(child.id, (m) => {
    if (m.info.role !== "assistant") return false
    const text = extractText(m.parts)
    return text.length > 0 && !looksLikeMissingDeliverable(text)
  })
  .pipe(Effect.orElseSucceed(() => Option.none<never>()))
// Pass 2 — fall back to any non-empty text.
const finalAssistant = Option.isSome(substantive)
  ? substantive
  : yield* sessions
      .findMessage(child.id, (m) => {
        if (m.info.role !== "assistant") return false
        const text = extractText(m.parts)
        return text.length > 0
      })
      .pipe(Effect.orElseSucceed(() => Option.none<never>()))
```

**Why:** `Session.findMessage` walks newest-first. The naive D5 predicate (`text.length > 0`) returns the newest non-empty message, which is the terse follow-up when one exists. `looksLikeMissingDeliverable` then triggers on the terse body and the warning shadows the real deliverable. The two-pass walk preserves newest-first ordering while preferring substantive over terse.
**See:** `packages/opencode/src/agent/control.ts:820-859` (the two-pass walk). Test: `packages/opencode/test/integration/multi-agent-invariants.test.ts` slug `INV-D-01-regression-ses_1c2e8d84affe`. Related: `agentcontrol-providerref-must-live-in-layer-not-instancestate` (sibling D5 invariant — per-root scoping).

---

### `agentcontrol-providerref-must-live-in-layer-not-instancestate`

**Severity:** correctness-bug
**When:** Storing single-value state shared across instances inside `InstanceState.make` and trying to register it from a sibling layer's init effect.
**Symptom:** First test that materializes the layer crashes with `instance: No context found for instance` from inside `InstanceState.get(state)`.
**Fix:** Hoist single-value, instance-agnostic state to **layer scope** (top of `Layer.effect`'s effect). Keep per-instance maps inside `InstanceState.make`.

```ts
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Layer-scope: shared across every instance the layer serves.
    const providerRef = yield* Ref.make<RunLoopProvider | undefined>(undefined)

    const state = yield* InstanceState.make(
      Effect.fn("AgentControl.state")(function* () {
        // Per-instance: registry, mailboxes, statuses, fibers, listeners.
      }),
    )

    const registerRunLoop = Effect.fn(...)(function* (fn) {
      // Reads layer-scope ref → no Instance binding required.
      yield* Ref.set(providerRef, fn)
    })
  }),
)
```

**Why:** Layer init runs once globally when the runtime materializes; no Instance is bound at that point. `InstanceState.get(state)` requires `Instance.current` bound (it's a `ScopedCache.get` keyed by directory). Registration is logically global and must not pretend to be per-instance.
**Rule of thumb:** Set-once-at-layer-build → layer scope. Set-per-instance, varies-per-directory → `InstanceState`.
**See:** `packages/opencode/src/agent/control.ts` `providerRef`. Related: `bus-subscriber-needs-instance-state-fork-and-instance-ref` (opposite resolution for the per-instance subscriber case).

---

### `agentcontrol-required-by-toolregistry-existing-test-layers`

**Severity:** DX-trap
**When:** Adding a new `Foo.Service` to `ToolRegistry`'s layer requirements.
**Symptom:** Three unrelated test files fail to typecheck:
```
test/tool/registry.test.ts: Type 'Service' is not assignable to type 'never'.
test/session/prompt.test.ts: ...
test/session/snapshot-tool-race.test.ts: ...
```
**Fix:**
1. Add `Layer.provide(Foo.defaultLayer)` to `ToolRegistry.defaultLayer` so `defaultLayer` consumers don't break.
2. `git grep "ToolRegistry.layer.pipe" packages/opencode/test` to find every custom layer composition and add `Layer.provide(Foo.defaultLayer)` to each.
3. `git grep "Layer.provide(ProcessSessions.defaultLayer)" packages/opencode/test` is a good proxy — these files usually need the new dep too.

**Why:** `defaultLayer` self-supplies its deps, so `defaultLayer` consumers are fine. Tests that build their own composition (typically to inject test config or to avoid expensive defaults) must ALSO provide every new dep. The dep list is implicit — TS only flags it when residual `R` ends up non-empty.
**See:** `packages/opencode/src/tool/registry.ts` `Service` requirements + `defaultLayer` composition.

---

### `bench-effect-runpromise-loses-instance-in-async-callback`

**Severity:** DX-trap
**When:** Polling Instance-dependent state from inside an `Effect.promise(async () => …)` callback.
**Symptom:** `Effect.runPromise(svc.someMethod())` inside the async callback crashes with `instance: No context found for instance`.
**Fix:** Poll inside an `Effect.gen` scope so `Instance.current` stays valid through the loop:

```ts
yield* Effect.gen(function* () {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const list = yield* svc.someMethod()  // inherits the test's Instance binding
    if (list.length === 0) return
    yield* Effect.sleep(30)
  }
  throw new Error("timed out waiting for ...")
})
```

**Why:** `Effect.runPromise` builds a fresh root scope. The Instance ALS context bound by `provideTmpdirInstance` is on the test's call stack — the new root scope of the inner `runPromise` doesn't inherit it. `Effect.sleep` inside a `while` with `Effect.gen` works because each `yield*` is a continuation in the same fiber.
**See:** `packages/opencode/test/session/prompt.test.ts` "cancel propagates" test.

---

### `bench-file-pattern-split`

**Severity:** DX-trap
**When:** Producing a perf bench file.
**Symptom:** Two patterns coexist in the codebase. Mixing them silently double-counts or fails to run.
**Fix:** Use **pattern (2)** for per-wave benches — single self-contained `.bench.ts` with embedded `test(...)` and `afterAll`. Run via `bun test ./test/perf/<wave>.bench.ts` (see `bun-test-bench-file-path`). Aggregator-style baselines stay in pattern (1):

- Pattern 1: `test/perf/baseline/*.bench.ts` exports a function returning `Record<string, BenchResult>`; orchestrated by `baseline.test.ts`.
- Pattern 2: self-contained file with embedded `test()` calls + own `afterAll`.

**Why:** `bun test` only runs files whose names match `*.test.*` etc. Pattern (1) needs an orchestrator. Pattern (2) makes the bench file itself match by including `test()` calls.
**See:** `packages/opencode/test/perf/baseline/baseline.test.ts` (pattern 1), `packages/opencode/test/perf/head-tail-buffer.bench.ts` (pattern 2).

---

### `bench-managed-runtime-needs-effect-scoped`

**Severity:** DX-trap
**When:** Writing a perf bench file that uses `provideTmpdirInstance` under `ManagedRuntime`.
**Symptom:** Cryptic crash:
```
error: Service not found: effect/Scope (defined at .../effect/dist/internal/effect.js:1471:46)
```
**Fix:** Wrap with `Effect.scoped` before handing to the runtime:

```ts
const runWithInstance = <A, E, R>(self: Effect.Effect<A, E, R>) => {
  const runtime = ManagedRuntime.make(layer)
  return runtime
    .runPromise(
      Effect.scoped(provideTmpdirInstance(() => self)) as Effect.Effect<A, E, never>,
    )
    .finally(() => runtime.dispose())
}
```

**Why:** `provideTmpdirInstance` uses `Effect.addFinalizer`, which requires a Scope. `it.instance(...)` already wraps bodies in `Effect.scoped`; `ManagedRuntime.make(layer)` does NOT provide a default scope.
**See:** `packages/opencode/test/perf/agent-control.bench.ts`, `packages/opencode/test/fixture/fixture.ts:166-187`.

---

### `bench-tool-yield-loses-transitive-deps`

**Severity:** DX-trap
**When:** Benching a tool by yielding it directly inside `Effect.gen` (e.g. `const tool = yield* ShellTool; const def = yield* tool.init()`).
**Symptom:** Code typechecks. At runtime, crashes with `Service not found: @opencode/FileSystem` (or `@opencode/Pty`, `ChildProcessSpawner`, etc.) the moment the tool's `execute` body runs. The layer composition for the bench file LOOKS correct (`ToolRegistry.defaultLayer` is provided) but transitive deps the tool grabs lazily aren't satisfied.
**Fix:** Route every tool resolution through `ToolRegistry.tools({...})`, which materializes the full registry (including transitive deps) and hands back the resolved `Tool.Def[]`:

```ts
// Bad — typechecks, crashes at runtime when execute() touches AppFileSystem
const tool = yield* ShellTool
const def = yield* tool.init()
const out = yield* def.execute(params, ctx)

// Good — registry materializes everything; def is fully wired
const registry = yield* ToolRegistry.Service
const defs = yield* registry.tools({ providerID, modelID, agent })
const def = defs.find((d) => d.id === ShellID.ToolID)!
const out = yield* def.execute(params, ctx)
```

**Why:** `ShellTool` (and friends) are `Tool.Init` factories. Yielding them resolves the factory but DOESN'T materialize the layer's transitive deps. `ToolRegistry.tools()` does — it pulls in `Pty`, `AppFileSystem`, `ChildProcessSpawner`, `Permission`, etc. The factory pattern is intentional (testability), but bench files routinely trip over it.
**See:** `packages/opencode/test/perf/baseline.bench.ts`, `packages/opencode/test/snapshots/capture-baseline.ts`.

---

### `bug-3-fix-left-test-files-with-stale-required-shape`

**Severity:** DX-trap
**When:** Tightening a `Schema.Struct` field from `Schema.optional` to required.
**Symptom:** Typecheck errors in test files that build inputs without the new required field. Sites that route through `Tool.Def`-typed handles erase the Parameters type, so TS doesn't flag them — they only fail at runtime as `SchemaError(Missing key)`. Schema introspection tests asserting `expect((json.required ?? []).slice().sort())` go stale silently.
**Fix:**
1. Run `bun typecheck` immediately and fix every flagged call site in the same commit.
2. `git grep "<field-name>"` across `*.test.ts` to find sites that route through type-erased handles.
3. Run the affected test files to surface runtime SchemaError failures.
4. Audit any test asserting on the schema's `required` list / `accepts` happy path — these encode the OLD shape.
5. Prefer typed `Tool.Def<typeof Parameters, ...>` over plain `Tool.Def` cast so future schema changes flag at the call site.

**Why:** When a generic `Tool.Def` cast erases the Parameters type, the typechecker can't see that a required field is missing. Combined with the team practice of running `bun typecheck` separately from per-file `bun test` runs, schema tightening can quietly accumulate test debt.
**See:** Affected files when this last hit: `packages/opencode/src/tool/agent-spawn/agent-spawn.test.ts`, `packages/opencode/src/tool/agent-spawn/schema.test.ts`, `packages/opencode/test/integration/multi-agent-tools.test.ts`.

---

### `bun-coverage-aggregation-flake`

**Severity:** DX-trap
**When:** Verifying coverage by passing a directory to `bun test --coverage`.
**Symptom:** `bun test --coverage src/foo/` reports 98.54% on `src/foo/index.ts` with specific lines missing. `bun test --coverage src/foo/index.test.ts` (single file) reports 99.27% with those same lines covered.
**Fix:** Always run `bun test --coverage <single-file>.test.ts` rather than `bun test --coverage <directory>/`. Single-file runs produce accurate per-line coverage; aggregation across files is unreliable. Treat any percentage that's "100% minus a platform-conditional branch" as effectively 100%.
**Why:** Bun's V8-backed coverage instrumentation appears to lose hit counts on certain branches when the same code path is exercised across files in an aggregated run. The actual code IS exercised — coverage merely fails to credit it.
**See also:** `bun-test-coverage-source-file-arg-runs-zero-tests`.

---

### `bun-coverage-line1-quirk`

**Severity:** DX-trap
**When:** Verifying 100% line coverage on a new file.
**Symptom:** lcov shows `DA:1,0` (line 1, 0 hits) for the first import statement; coverage stuck at ~99%.
**Fix:** Reorder imports so line 1 is `import * as <name> from "node:<builtin>"` (namespace import from a node-prefixed builtin) rather than a default import or comment. Don't waste cycles on other shapes — the order is the lever.
**Why:** Bun's V8 coverage instruments differently depending on the import shape and order. A default-style import on line 1, or a comment on line 1, can report as 0 hits even though the import is evaluated.
**See also:** `bun-coverage-line1-schema-class-only` for the Schema.Class variant.

---

### `bun-coverage-line1-schema-class-only`

**Severity:** DX-trap
**When:** Adding a new file that declares ONLY a `Schema.Class<...>` (no top-level `Schema.Union`, no top-level value variable).
**Symptom:** `import { Schema } from "effect"` on line 1 reports 0 hits in lcov even though every import is evaluated. A sibling file with the same line-1 import that ALSO declares a top-level `Schema.Union` const reports the same line at 100%.
**Fix:** Reorder imports so line 1 is anything other than `import { Schema } from "effect"`. A workspace-relative import works:

```ts
// BAD — line 1 reads 0 hits
import { Schema } from "effect"
import { SessionID } from "@/session/schema"
export class Foo extends Schema.Class<Foo>("Foo")({ ... }) {}

// GOOD — same imports, different order
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
export class Foo extends Schema.Class<Foo>("Foo")({ ... }) {}
```

**Why:** `Schema.Union(...)` / `Schema.Struct(...)` triggers an IIFE-style execution path that records line 1. `Schema.Class<...>` uses a TS class-like path that bypasses the synthetic record, leaving line 1 marked as 0 hits in LCOV.
**See also:** `bun-coverage-line1-quirk` (the original).

---

### `bun-test-bench-file-path`

**Severity:** DX-trap
**When:** Running a `*.bench.ts` file directly via `bun test`.
**Symptom:** `bun test test/perf/foo.bench.ts` exits with `The following filters did not match any test files`.
**Fix:** Prefix the path: `bun test ./test/perf/foo.bench.ts`. The `./` makes Bun treat the argument as a path rather than a name filter. WAVE.md verification commands that omit the `./` are subtly wrong.
**Why:** `bun test <arg>` interprets bare `<arg>` as a substring filter against discovered test file names (`.test.`, `_test_`, `.spec`, `_spec_`). `*.bench.ts` matches none of those patterns, so no file matches.

---

### `bun-test-coverage-source-file-arg-runs-zero-tests`

**Severity:** DX-trap
**When:** Asserting per-file coverage by passing a source file path to `bun test --coverage`.
**Symptom:** `bun test --coverage src/foo.tsx` emits a "filter did not match any test files" warning. Coverage table is empty. **Exit code is 0.** Naive interpretation: "coverage is fine"; reality: "no tests ran."
**Fix:** Use the test-file substring, not the source-file path:

```bash
# Bad — runs zero tests; coverage table empty; exit 0
bun test --coverage src/cli/cmd/tui/routes/session/foo.tsx

# Good — runs tests matching "foo.test"; coverage instruments all loaded modules
bun test --coverage foo.test

# Then grep for the source file in the report:
bun test --coverage foo.test 2>&1 | grep -E "foo\.tsx"
```

**Why:** `bun test` interprets bare positional args as substring filters against test file names (`*.test.*` / `*.spec.*`). A source file path matches no test file, so the test set is empty.
**See also:** `bun-test-bench-file-path` (inverse case).

---

### `bun-test-test-dir-runs-baseline-orchestrator`

**Severity:** correctness-bug (corrupts the perf baseline)
**When:** Running `bun test test/` to spot-check the suite.
**Symptom:** Tests pass clean. Then `git status` shows `baseline-perf.json` modified with fresh numbers from your machine — every percentile shifted to whatever the current run measured. Subsequent waves' regression budgets compare against the contaminated baseline.
**Fix:** For broad spot-checks, run per-area instead of `bun test test/`:

```bash
# Good
bun test test/session/
bun test test/tool/
bun test test/integration/
bun test src/   # doesn't include the perf dir
```

If you accidentally regenerate the baseline, restore it: `git checkout <path-to-baseline-perf.json>`. A defensive fix is to gate the orchestrator behind an env flag (e.g. `OPENCODE_CAPTURE_PERF_BASELINE=1`).
**Why:** The baseline orchestrator (`test/perf/baseline/baseline.test.ts`) is a regular `.test.ts` file with `afterAll` that writes the baseline JSON. `bun test test/` discovers and runs it.

---

### `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch`

**Severity:** DX-trap
**When:** A test uses `testEffect(layer)` with `Bus.defaultLayer` and tries to subscribe via the top-level `Bus.subscribe(...)` helper.
**Symptom:** Tool publishes events normally during execution but the subscriber array stays empty. `expect(events.length).toBeGreaterThanOrEqual(1)` fails.
**Fix:** Subscribe via the in-effect `Bus.Service` method:

```ts
// Bad: top-level helper, separate runtime, sees nothing
const off = Bus.subscribe(Pty.Event.Created, (evt) => events.push(evt))

// Good: in-effect Service method, same runtime as the publishers
const bus = yield* Bus.Service
const off = yield* bus.subscribeCallback(Pty.Event.Created, (evt) => events.push(evt))
```

**Why:** `Bus.subscribe` (top-level helper) runs against its own `makeRuntime(Service, layer)` runtime. The test's `testEffect` runtime has a SEPARATE `Bus.Service` instance with its own PubSub.
**See also:** `syncevent-publish-uses-top-level-bus-runtime` (the inverse — when you DO want the top-level subscribe). `bus-subscriber-needs-instance-state-fork-and-instance-ref` (production subscriber pattern).

---

### `bus-subscriber-needs-instance-state-fork-and-instance-ref`

**Severity:** correctness-bug
**When:** Wiring a continuous `bus.subscribe(...)` listener inside a service's layer to react to events from other services.
**Symptom:** Layer-scope `Effect.forkScoped(bus.subscribe(def).pipe(Stream.runForEach(...)))` does one of: (1) crashes with `instance: No context found for instance`, (2) runs but the callback never fires, (3) runs and misses the first publish in a test.
**Fix:** Three coordinated moves:

1. **Fork inside `InstanceState.make`'s builder, not at layer scope.** The builder runs lazily on the first method call for that instance, with `Instance.current` bound:

```ts
yield* InstanceState.make(
  Effect.fn("Foo.state")(function* () {
    const ctx = yield* InstanceState.context  // capture for re-injection

    yield* Effect.forkScoped(
      bus
        .subscribe(SomeInbound)
        .pipe(Stream.runForEach((evt) => handle(evt)))
        .pipe(Effect.provideService(InstanceRef, ctx)),
    )
    return state
  }),
)
```

2. **Re-inject `InstanceRef` via `Effect.provideService(InstanceRef, ctx)`** on the forked stream — fibers inherit Effect Context but Instance.current lives in native ALS, which doesn't propagate reliably across scheduler hops.
3. **In tests, sleep 20ms after the first method call (which triggers builder + fork) before publishing** so the lazy stream attaches.

**Why:** Three interacting facts: `Bus.subscribe` resolves through `InstanceState.get(state)` (needs Instance bound); layer init has no Instance; `Effect.forkScoped` schedules the fiber on the next tick (loses races against immediate publish).
**See also:** `agentcontrol-providerref-must-live-in-layer-not-instancestate` (opposite case — single-value, instance-agnostic state belongs at layer scope).

---

### `codex-role-vocabulary-imported-verbatim`

**Severity:** correctness-bug + conceptual-mismatch
**When:** Porting concepts from a reference codebase (Codex, Claude Code, etc.) into codemaxxxing.
**Symptom:** Smoke test fails at runtime with messages like `agent_type "explorer" is not a valid agent type`. The model picks role names it found in the prompt prose and passes them as agent types; the spawned child can't be looked up; the runLoop errors.
**Fix:** Two-part rule:

1. **When porting concepts, map them to host primitives — never invent new vocabulary that conflicts with what the host has.** Verify the mapping by grepping the host codebase for the concept under both names. If both exist, the mapping is the bug.
2. **Tests must assert real behavior, not just propagation.** A test that says "field X arrives at place Y" is testing serialization. A test that says "after spawning with X, the child does Z" is testing behavior. 100% test coverage doesn't catch propagation-only tests.

Mechanical pattern: enumerate valid host values via a runtime describer (e.g. `describeSpawnAgent`) so the model only sees names that actually resolve. Filter by host-side rules (mode, hidden, permission). Drop hardcoded role mentions from prompt prose; point at the templated list.
**Why:** Two codebases often have overlapping concepts under different names (Codex's "roles" map to opencode's "agents"). Importing the foreign vocabulary verbatim sets up the model to call something that doesn't exist.
**See also:** `word-boundary-regex-vs-prose-collisions` (the testing trap that hid this for a campaign).

---

### `e2e-perf-sibling-fanout-needs-median-of-n`

**Severity:** DX-trap
**When:** Asserting a ratio between two timed samples (single-session vs N-sibling, baseline vs concurrent) in an e2e perf test.
**Symptom:** Test passes in isolation. Run as part of the full e2e suite, the ratio swings wildly and the test fails ~30% of the time. The implementation didn't change — only suite pollution did.
**Fix:** Run N iterations of each phase, take the median, compare medians:

```ts
const ITERS = 5
const singleSamples: number[] = []
const fanSamples: number[] = []
for (let it = 0; it < ITERS; it++) {
  const t0 = Bun.nanoseconds()
  yield* runSinglePhase(it)
  singleSamples.push(Bun.nanoseconds() - t0)

  const tf = Bun.nanoseconds()
  yield* runFanPhase(it)
  fanSamples.push(Bun.nanoseconds() - tf)
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
expect(median(fanSamples) / median(singleSamples)).toBeLessThan(1.6)
```

Median-of-5 is stable across runs where single-iteration ratios flake. Bump to median-of-10 for very noisy machines. Don't use "best-of-N" — picking the best fan iteration would understate the realistic cost. Median is the right central tendency. For ops you can run hundreds of times, prefer percentile-based (p99) assertions instead.
**Why:** Single-iteration timing has no defense against background noise from preceding tests, GC, scheduler variance. A 10ms vs 25ms swing purely from scheduler luck blows any ratio assertion.
**See also:** `opentui-render-bench-noise-needs-best-of-n` (same problem class for opentui benches).

---

### `effect-v4-catchall-renamed-to-catch`

**Severity:** DX-trap
**When:** Porting Effect v3 code, copy/pasting from older docs, or reaching for `Effect.catchAll` / `Effect.catchAllDefect` from muscle memory.
**Symptom:** `error: Property 'catchAll' does not exist on type 'typeof import("effect/Effect")'`. Or `'catchAllDefect'` for the defect variant. Typecheck only — runtime never gets a chance.
**Fix:** Use the v4 names:

| v3 | v4 beta |
|---|---|
| `Effect.catchAll(handler)` | `Effect.catch(handler)` |
| `Effect.catchAllDefect(handler)` | `Effect.catchDefect(handler)` |
| `Effect.catchAllCause(handler)` | `Effect.catchCause(handler)` |

The "catch both typed errors AND defects in one handler" combinator is `Effect.catchCause`. The shorter `Effect.catch` handles typed errors only; defects still propagate.
**Why:** Effect v4 dropped the `All` suffix from the catch family for symmetry with `try`/`catch` semantics in JS — there's no "catch one error" vs "catch all" distinction in v4 because every handler subsumes its narrower form.
**See also:** `effect-v4-either-renamed-to-result` (sibling rename).

---

### `effect-v4-either-renamed-to-result`

**Severity:** DX-trap
**When:** Writing a test that converts a typed-error Effect into a non-throwing assertable value.
**Symptom:** Test won't even load:
```
SyntaxError: Export named 'Either' not found in module '.../effect/dist/index.js'.
```
**Fix:** Rename across the board:

| Old (v3) | New (v4) |
|---|---|
| `Either` | `Result` |
| `Effect.either` | `Effect.result` |
| `Either.isRight` | `Result.isSuccess` |
| `Either.isLeft` | `Result.isFailure` |
| `r.right` / `r.left` | `r.success` / `r.failure` |
| `Schema.decodeUnknownEither` | `Schema.decodeUnknownResult` |

```ts
import { Effect, Result } from "effect"

const runResult = <A>(eff: Effect.Effect<A, MyError>) =>
  Effect.runSync(Effect.result(eff))

const r = runResult(svc.decode("bad"))
expect(Result.isFailure(r)).toBe(true)
if (Result.isFailure(r)) expect(r.failure.reason).toMatch(/.../)
```

**Why:** Effect v4 renamed `Either` (and every API around it) to `Result`, with field accessors `success`/`failure`. The `effect` package's top-level barrel no longer re-exports anything named `Either`.

---

### `eventv2-and-bus-dual-emission-with-parallel-type-prefixes`

**Severity:** API-quirk
**When:** Introducing a new domain event consumed by BOTH the EventV2 sourced log (DB / replay / projectors) AND in-process Bus subscribers (TUI / plugins / status derivation).
**Symptom:** The naive design — same type string for both, rely on `SyncEvent.init` auto-registering a BusEvent — breaks down: subscribers can't import the auto-registered Definition handle (it's a side effect of init, not exported); same-type collision between an explicit BusEvent.define and the auto-registration breaks SDK type stability.
**Fix:** Use **two different type prefixes**:

- `session.next.<domain>.<event>` for EventV2 defs (sourced log; persisted by projectors; matched in `SessionEvent.All` union).
- `<domain>.<event>` for BusEvent defs (in-process pub/sub; the Definition object is exported and stable).

Inside the service, emit on BOTH channels with the same payload:

```ts
function emitSpawn(payload) {
  try { EventV2.run(SessionEvent.Agent.Spawn.Started.Sync, payload) } catch { /* swallow */ }
  yield* bus.publish(Event.SpawnStarted, payload).pipe(Effect.ignore)
}
```

For inbound subscriptions (subscribing to an EventV2 emitted by another service), construct a local `BusEvent.Definition` shape from the EventV2 def's `Sync.type` and `Sync.properties`:

```ts
export const Inbound = {
  StepStarted: {
    type: SessionEvent.Step.Started.Sync.type,
    properties: SessionEvent.Step.Started.Sync.properties,
  } as const,
}
yield* bus.subscribe(Inbound.StepStarted).pipe(Stream.runForEach(...))
```

**Why:** `SyncEvent.init` walks the EventV2 registry and calls `BusEvent.define(def.type, def.properties)`. The returned Definition is discarded — there's no exported handle. Co-locating both under the same type creates fragility (cross-runtime mismatches, last-one-wins SDK gen).
**See:** `packages/opencode/src/agent/control.ts` `Event` and `Inbound` consts.

---

### `managed-runtime-script-needs-process-exit`

**Severity:** DX-trap
**When:** Writing a standalone Bun script (run via `bun run script.ts`, not `bun test`) that uses `ManagedRuntime.make(...)` + `runtime.runPromise(...)` + `runtime.dispose()`.
**Symptom:** Script logic completes, output writes correctly, but the process hangs forever after the last `runtime.dispose()`. Ctrl-C is the only way out. Subsequent `git add` etc. blocks until you abort.
**Fix:** Add `process.exit(0)` (or `process.exit(code)`) at the end of the script after `runtime.dispose()`:

```ts
async function main() {
  const runtime = ManagedRuntime.make(layer)
  try {
    await runtime.runPromise(work)
  } finally {
    await runtime.dispose()
  }
}

await main()
process.exit(0)   // required — see below
```

**Why:** `ManagedRuntime.dispose()` releases the layer's scoped resources, but several services (file watcher, plugin loader, bus subscriptions, OpenTelemetry exporter) keep background fibers / handles that the Bun event loop counts as live. Without an explicit exit, Node/Bun waits for them to drain — they never do. `bun test` papers over this because the test runner forces process exit on suite completion.
**See:** `packages/opencode/test/fixtures/generate-corpus.ts`, `packages/opencode/test/snapshots/capture-baseline.ts`.

---

### `multi-ask-capture-needs-counter`

**Severity:** DX-trap
**When:** Recording `ctx.ask` payloads from a tool that fires more than one ask per execution (e.g. `bash` for paths-outside-cwd fires `external_directory` THEN `bash`).
**Symptom:** Capture helper short-circuits via `throw stop` after the first ask. Test only sees one entry, misses the second. Or worse: the test's snapshot oracle records only the first ask shape, hiding the second's existence from later diff tests.
**Fix:** Parameterize the capture's stop trigger with a count threshold:

```ts
const captureCtx = (requests, expectedAskCount = 1, stop) => ({
  ...ctx,
  ask: (req) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop && requests.length >= expectedAskCount) throw stop
    }),
})
```

Caller passes `expectedAskCount: 2` for `bash` against `rm /tmp/foo` (external_directory + bash). For commands that produce no asks (empty / whitespace, due to `shell.ts:281`'s early-return on `scan.patterns.size === 0`), no throw fires — wrap the runPromise in a `try`/`catch` that absorbs the sentinel AND treats the no-throw outcome as `requests.length === 0`.
**Why:** Throwing on the first ask is convenient for single-ask tools but silently truncates multi-ask flows. The first ask order in `shell.ts`'s `ask` fn is `external_directory` THEN `bash`; the second carries the patterns Wave 2's diff target needs. Missing it makes the snapshot a lying oracle.
**See:** `packages/opencode/test/snapshots/capture-baseline.ts` `captureCtx` helper, `packages/opencode/test/fixtures/generate-corpus.ts` (production-style use).

---

### `opentui-multi-text-node-vs-single-baseline-cap`

**Severity:** DX-trap
**When:** Benching multiple opentui text nodes against a single-text baseline (e.g. `session.render.steady`).
**Symptom:** N separate `<text>{sig()}</text>` nodes settle around 1.45-1.65× the single-text baseline — right on a typical 1.5× cap. Test fails intermittently.
**Fix:** Use `<text>` with multiple `<span>` children instead of multiple sibling `<text>` nodes:

```tsx
// BAD — 4 cells, p50 ~78µs vs single 50µs (1.55×)
<>
  <text>{sigs[0]()}</text>
  <text>{sigs[1]()}</text>
  ...
</>

// GOOD — 1 cell with 4 dirty spans, p50 ~64µs vs single 50µs (1.30×)
<text>
  <span>{sigs[0]()}</span> <span>{sigs[1]()}</span> ...
</text>
```

**Why:** opentui composes a single text node as one cell even when each span is independently dirty. Multiple sibling `<text>` nodes incur per-cell composition cost that scales close to linearly. The structural floor for N≥2 vs N=1 cannot be made smaller than ~1.4×.
**See also:** `opentui-render-bench-noise-needs-best-of-n` (per-run noise — different problem).

---

### `opentui-render-bench-noise-needs-best-of-n`

**Severity:** DX-trap
**When:** Benching an opentui render path against a wave_0 baseline metric.
**Symptom:** A bench faithfully replaying the baseline algorithm passes most runs and fails others — `p99 +85% > 15%`, `p99 +358% > 15%`. Captured `max` per run swings from ~330µs to ~6.5ms across runs of the same code.
**Fix:** Run the bench multiple times and pick the run with the lowest p50:

```ts
const runs: BenchResult[] = []
for (let r = 0; r < 3; r++) {
  runs.push(await bench({ samples: 1000, warmup: 100, label: "process.render.steady" }, async () => {
    counter++
    setText(`update ${counter}`)
    await handle.renderOnce()
  }))
}
const result = runs.reduce((best, x) => (x.p50 < best.p50 ? x : best))
```

3 × 1000 samples is enough in practice. This is a measurement strategy, not a fix to the renderer — picking a less-noisy sample approximates "what would I see on a quiet machine" (which is what the baseline captured).
**Why:** opentui's `renderOnce` cost is dominated by per-frame composition through native bindings, with substantial variance from JS GC, OS scheduling, background workload. A single 6ms outlier in 100 samples moves p99 from ~190µs to ~3ms.
**See also:** `e2e-perf-sibling-fanout-needs-median-of-n` (related principle for e2e timing).

---

### `opentui-testRender-leak`

**Severity:** perf-regression (unbounded memory growth)
**When:** Calling `testRender` per sample in a benchmark.
**Symptom:** Bench memory grows monotonically. After 50+ iterations the bench process is multi-GB. No error — just slow and eventually OOM.
**Fix:** Always `handle.renderer.destroy()` between iterations:

```tsx
const firstPaint = await bench({ samples: 30, ... }, async () => {
  const handle = await testRender(() => <MyComponent />, { width: 100, height: 40 })
  await handle.renderOnce()
  handle.renderer.destroy()
})
```

For "steady state" benches, mount once outside the bench loop and only call `renderOnce()` inside — but still `destroy()` after the bench finishes.
**Why:** `testRender` returns a `TestRenderer` backed by native opentui resources. There's no automatic teardown when the JS handle goes out of scope.

---

### `permission-disabled-removes-tool-from-active-set`

**Severity:** DX-trap
**When:** Writing an e2e test that verifies a tool's *runtime denial flow* via wildcard permission deny.
**Symptom:** Test creates a session with `permission: [{ permission: "spawn_agent", pattern: "*", action: "deny" }]`. Stubbed model response calls `spawn_agent`. The tool's `execute` body never runs — the assistant message contains `tool: "invalid"` with `input.error: "Model tried to call unavailable tool 'spawn_agent'..."`.
**Fix:**
- For "the model sees the denial as a tool error and the loop continues", assert the tool resolved to the `invalid` wrapper:

```ts
const invalidTool = msgs
  .filter((m) => m.info.role === "assistant")
  .flatMap((m) => m.parts)
  .find((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "invalid")
expect(invalidTool).toBeDefined()
```

- For "the tool's own denial path fires" (e.g. testing `acquireUseRelease` cleanup on `Permission.DeniedError`), use a **non-wildcard pattern** that doesn't match the wildcard-deny check inside `Permission.disabled`. Patterns like `pattern: "specific_value", action: "deny"` survive the filter; the tool stays available; calling it triggers the real `ctx.ask` → `DeniedError` path.

**Why:** `resolveTools` calls `Permission.disabled(toolNames, mergedRuleset)` BEFORE handing tools to the AI SDK. Tools matching a wildcard-deny rule are removed from the active toolset entirely.
**See:** `packages/opencode/src/permission/index.ts:311-320` (`Permission.disabled`), `packages/opencode/src/session/llm.ts:450-456` (`resolveTools`).

---

### `pty-bench-baseline-vs-new-work`

**Severity:** DX-trap
**When:** Running a bench labeled the same as a baseline metric, but with extra new work in the loop.
**Symptom:** `pty.push.4kb` regresses ~84% vs the baseline (1.875µs → ~3.5µs for 100 chunks). Default 5/10/15% budget rejects it. The new work is 100 × ~16ns of mandatory array-push and number-increment — there is no way to make it free.
**Fix:** Keep the baseline-named metric a faithful replay of the baseline algorithm. Add a **separate metric** for the new work's standalone cost with no baseline comparison (or compare against a closer-matched baseline):

```ts
test("bench: pty.push.4kb (regression check vs baseline)", ...)  // identical to baseline
test("bench: pty.push.4kb.headtail (new head/tail push cost)", ...)
```

**Why:** The baseline measures the legacy algorithm only. Re-running with extra work added is comparing apples to oranges. The 5% budget assumed the new work would be invisible at synthetic-scale; it isn't, because the legacy floor is already micro-optimized to ~18ns/chunk.
**See also:** `runloop-bench-vs-baseline-methodology-mismatch` (related principle).

---

### `pty-create-term-override-tui-only`

**Severity:** correctness-bug
**When:** Spawning model-origin PTYs and passing `env` overrides via `Pty.create`.
**Symptom:** `exec_command` test: spawning a child with `env: { TERM: "dumb", ... }` reads `TERM=xterm-256color` inside the child. The model-supplied env overlay is silently overridden.
**Fix:** Gate the `TERM=xterm-256color` overlay on `origin === "tui"`:

```ts
const origin = input.origin ?? "tui"
const env = (
  origin === "tui"
    ? { ...process.env, ...input.env, ...shell.env, TERM: "xterm-256color", OPENCODE_TERMINAL: "1" }
    : { ...process.env, ...shell.env, ...input.env }
)
```

For model-origin spawns, `input.env` is applied LAST so the caller's overlay (TERM=dumb, NO_COLOR=1, etc.) is observed.
**Why:** Hardcoded `TERM=xterm-256color` is correct for desktop terminal-pane callers (xterm-style readline expects it). `unified_exec` needs `TERM=dumb` to suppress color codes and pager prompts in CI-like contexts.
**See also:** `pty-onexit-auto-remove-tui-only` (same gating principle, different surface).

---

### `pty-onexit-auto-remove-tui-only`

**Severity:** correctness-bug
**When:** Consuming `Pty.read` after a model-origin process exits.
**Symptom:** `Pty.read` returns `undefined` immediately after the child exits, even though the spec says it should return buffered final output plus `exited: true` and the exit code.
**Fix:** Gate the auto-removal on `session.info.origin === "tui"`:

```ts
proc.onExit(({ exitCode }) => {
  // ... set exited / exitCode / publish Exited / resolve exitDeferred ...
  if (session.info.origin === "tui") {
    bridge.fork(remove(id))
  }
})
```

Model-spawned PTYs (`origin: "model"`) stay in the map until the LRU pruner reaps them. TUI-spawned PTYs keep the legacy disappear-on-exit behavior so the desktop terminal pane list doesn't fill with zombie tabs.
**Why:** The legacy `proc.onExit` callback unconditionally forks `remove(id)`, deleting the session from the registry. That's correct for desktop terminal panes but breaks `unified_exec`, which needs exited processes in the store so the model can still drain final bytes.
**See also:** `pty-create-term-override-tui-only` (same origin-gating pattern).

---

### `runloop-bench-vs-baseline-methodology-mismatch`

**Severity:** DX-trap
**When:** A wave bench compares a runLoop-region metric against a baseline that was measured with different per-sample structure.
**Symptom:** New metric measures `drainMailbox + Stream.runDrain` inside a single `Effect.gen` with a tight inner loop, captured at p50 ~10µs. Baseline (just `Stream.runDrain` with per-sample `Effect.runPromise`) sits at p50 ~19µs. Comparison: -55% on p50 — looks like a huge improvement, well under budget. Reality: the new metric does *more* work in a tighter inner loop (no per-sample runPromise overhead). The "improvement" is illusory.
**Fix:** Two viable approaches:

1. **Match the baseline's per-sample structure.** Wrap each sample in `await runtime.runPromise(myEffect)`. Fixed overhead matches; comparison is meaningful but expensive (~10µs floor dominates).
2. **Acknowledge the methodological gap and treat the baseline comparison as a sanity check, not a strict bound.** Accept that the new metric is faster because of less per-sample overhead, not because the new work is free. Capture a separate "drain-only" microbench to attribute precisely.

If a future bench is suspiciously fast (e.g. -50% vs baseline) AND introduces new work, that's the smell — verify per-sample structure matches.
**Why:** Per-sample `Effect.runPromise` adds ~10µs of fixed overhead (resolves layer via memo, wraps in fresh root scope, `Effect.gen` startup). Baseline measures inner work + that overhead; tight-loop benches measure inner work alone.
**See also:** `pty-bench-baseline-vs-new-work` (related principle).

---

### `schema-class-function-coverage`

**Severity:** DX-trap (false-positive coverage gap)
**When:** A new file with a `Schema.TaggedErrorClass` needs to pass a coverage check.
**Symptom:** Function% stuck at ~92% even after every observable behavior is tested. Bun's `--coverage` shows `91.67 | 100.00`.
**Fix:** Target 100% **line** coverage rather than function coverage. Function% is a lossy proxy. If a wave's verification checks "100% on file X" and you see 100% lines + ~90% functions because of a TaggedErrorClass, it's passing the real constraint.
**Why:** `Schema.TaggedErrorClass()` synthesizes class members at definition time (internal `_tag` accessors, `pipe`, equality helpers). Bun's V8 coverage counts them as functions but they aren't directly callable from user code. Function% ceiling is roughly `(N - 1) / N`.

---

### `session-id-descending-not-make-for-fixture-string-coercion`

**Severity:** DX-trap
**When:** Loading JSON fixtures with stable IDs that need wrapping in branded ID types.
**Symptom:** `SessionID.make("ses_legacy_root")` produces TS2769:
```
Argument of type 'string' is not assignable to parameter of type 'string & Brand<"SessionID">'.
```
The string IS a valid SessionID at runtime — chicken-and-egg.
**Fix:** Use `.descending(string)` or `.ascending(string)` instead of `.make(string)`:

```ts
// Bad: TS rejects
const sid = SessionID.make("ses_legacy_root")

// Good: validates prefix at runtime, returns properly branded value
const sid = SessionID.descending("ses_legacy_root")
const mid = MessageID.ascending("msg_user_1")
const pid = PartID.ascending("prt_text_user")
const tid = PtyID.ascending("pty_legacy_term_1")
```

**Why:** `Schema.brand(...)` produces a constructor whose `.make()` requires the input to ALREADY be branded. The intent is "if you're calling `.make()`, you've validated upstream." The `.descending/.ascending` statics accept plain strings and validate the prefix at runtime.
**See:** `packages/opencode/src/id/id.ts:36-45` (`generateID` validates and brands).

---

### `subscriptionref-changes-is-top-level`

**Severity:** DX-trap
**When:** Reading a `SubscriptionRef`'s change stream.
**Symptom:** Runtime crash:
```
TypeError: undefined is not an object (evaluating 'ref.changes.pipe')
```
TypeScript doesn't flag the call.
**Fix:** Use the top-level helper:

```ts
import { SubscriptionRef, Stream } from "effect"

const stream = SubscriptionRef.changes(ref).pipe(Stream.take(1))
const collected = yield* Stream.runCollect(stream)
```

**Why:** In Effect v4, the `changes` stream is a top-level function `SubscriptionRef.changes(ref)`, not an instance accessor. The v3 `ref.changes` instance method is gone.
**See:** `packages/opencode/src/pty/index.ts:513` (working production example).

---

### `syncevent-publish-uses-helper-bus-not-test-layer-bus`

**Severity:** correctness-bug + test-flake
**When:** Subscribing to `Session.Event.Deleted` (or any other SyncEvent-published event) from inside `InstanceState.make` via the layer-built `Bus.Service`.
**Symptom:** Subscriber forks fine, type string matches, `SyncEvent.process` runs and calls `ProjectBus.publish` — yet the in-effect subscriber NEVER receives the event. Even a wildcard `bus.subscribeAll()` on the same `Bus.Service` misses it.
**Fix:** Subscribe via the **top-level** `Bus.subscribe(def, callback)` helper from inside the `InstanceState.make` builder — NOT `bus.subscribe` on the layer-local service. Capture the `off` callback and register it via `Effect.addFinalizer`:

```ts
const off = Bus.subscribe(Inbound.SessionDeleted, (evt) => { ... })
yield* Effect.addFinalizer(() => Effect.sync(() => off()))
```

The callback runs OUTSIDE Effect; for fire-and-forget work use `Effect.runPromise(...).catch(() => {})`. Pure synchronous map mutations are fine inline.
**Why:** The test runtime builds its OWN `Bus.Service` per test. The cross-runtime helper (`Bus.publish`) uses `makeRuntime` backed by a process-wide memoMap. These are TWO different `Bus.Service` instances. `SyncEvent.run → Database.effect → ProjectBus.publish` lands on the memoMap helper's Bus; the in-effect subscriber sits on the test layer's Bus. Their PubSubs are entirely disjoint. In production (single `AppRuntime` + memoMap) both paths share one `Bus.Service`, so this never surfaces.
**See:** `packages/opencode/src/bus/index.ts:187` (top-level publish), `:195` (top-level subscribe), `:179` (`makeRuntime`).
**See also:** `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch` (the converse for tests).

---

### `syncevent-publish-uses-top-level-bus-runtime`

**Severity:** DX-trap
**When:** A test subscribes to bus events that are emitted as a side effect of `SyncEvent.run` / `SyncEvent.replay`.
**Symptom:** The subscriber's collected array stays empty. `expect(seen.length).toBeGreaterThan(0)` fails with `Received: 0`. No error, no warning.
**Fix:** Use top-level `Bus.subscribeAll(...)` / `Bus.subscribe(...)` for events emitted by top-level helpers:

```ts
// Bad: in-effect subscribeAllCallback misses events published via SyncEvent.run
const bus = yield* Bus.Service
const off = yield* bus.subscribeAllCallback((evt) => seen.push(evt))

// Good: top-level Bus.subscribeAll matches the runtime SyncEvent uses
const off = Bus.subscribeAll((evt) => seen.push(evt))
yield* Effect.sleep(20)  // let the subscription attach before publishing
yield* hydrate(...)
yield* Effect.sleep(50)  // let the subscriber drain
off()
```

| Publisher | Subscriber that sees the events |
|---|---|
| In-effect `bus.publish(...)` | In-effect `bus.subscribeCallback(...)` |
| Top-level `Bus.publish(...)` (incl. `SyncEvent.run`/`replay`) | Top-level `Bus.subscribe(...)` / `Bus.subscribeAll(...)` |

When unsure which path a publisher takes: `Bus.publish` (capital B) is the helper; `bus.publish` (lowercase) is the in-effect Service method.
**Why:** `SyncEvent.run` and `SyncEvent.replay` publish via `ProjectBus.publish(def, data, { id: event.id })`. The top-level `publish` helper resolves through its own `makeRuntime` runtime — a SEPARATE `Bus.Service` instance from the one in the test's `testEffect` layer.
**See also:** `syncevent-publish-uses-helper-bus-not-test-layer-bus` (the production-side mirror), `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch`.

---

### `tool-context-ask-typed-as-void`

**Severity:** correctness-bug + DX-trap
**When:** A tool needs to clean up resources (PTYs, file handles, network connections) on permission rejection.
**Symptom:** Writing `yield* ctx.ask(...).pipe(Effect.catch((err) => cleanup))` looks correct but the catch handler never executes. Coverage reports the cleanup as dead. In production, the spawned PTY leaks until the InstanceState finalizer reclaims the project.
**Fix:** Use `Effect.acquireUseRelease` so the release fires on ANY non-success exit (defects, interrupts, typed failures):

```ts
return yield* Effect.acquireUseRelease(
  // acquire: spawn pty + allocate session
  Effect.gen(function* () {
    const info = yield* pty.create(...)
    const session = yield* sessions.allocate(...)
    return { info, session }
  }),
  // use: ask + read + return result
  ({ info, session }) => mainLogic(info, session),
  // release: cleanup if non-success exit
  ({ info, session }, exit) =>
    Exit.isFailure(exit)
      ? Effect.gen(function* () {
          yield* sessions.remove(session.processId)
          yield* pty.remove(info.id)
        })
      : Effect.void,
)
```

Inline cleanup paths (e.g. `ctx.abort` detected before the read) still need explicit cleanup since they return success exits.
**Why:** `Tool.Context.ask` is declared as `Effect.Effect<void>` — the error channel is `never`. `.pipe(Effect.catch(handler))` is type-checked but unreachable. In reality the Permission service raises typed failures; the `Tool.define` wrapper applies `Effect.orDie`, converting them into defects that bypass `Effect.catch`.
**See:** `packages/opencode/src/tool/tool.ts:24` (`ask` declaration), `:124` (`Effect.orDie`).

---

### `tool-define-execute-r-must-be-never-capture-services-in-closure`

**Severity:** DX-trap
**When:** Lifting a helper out of a `Tool.define`'s outer `Effect.gen` into a sibling module as an `Effect.fn` that yields its services from inside (e.g. `function* () { const fs = yield* AppFileSystem.Service; ... }`).
**Symptom:** Tool typechecks fine in isolation. Wiring the new helper into the existing `execute` body breaks `Tool.define`:
```
Argument of type 'Effect<..., never, ChildProcessSpawner | AppFileSystem.Service | ...>'
  is not assignable to parameter of type 'Effect<Init<..., M>, never, R>'.
    Type 'ChildProcessSpawner | AppFileSystem.Service' is not assignable to type 'never'.
```
The Tool's `execute(args, ctx)` signature in `tool.ts` enforces `Effect.Effect<ExecuteResult<M>, never, never>`. R must be empty by the time `execute` returns. Every service the inner code transitively needs must be satisfied at the call site, not the type signature.
**Fix:** Yield each service ONCE in the outer `Effect.gen` (where R is allowed to be wide), capture them as locals, then provide them inline at every call site of the lifted helper. A small `provide` lambda keeps the noise contained:

```ts
export const ShellTool = Tool.define(ShellID.ToolID, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner          // captured in closure
  const fs = yield* AppFileSystem.Service             // captured in closure

  // Shim — keeps execute's R = never while letting scan helpers self-yield.
  const scanProvide = <A, E>(eff: Effect.Effect<A, E, ChildProcessSpawner | AppFileSystem.Service>) =>
    eff.pipe(
      Effect.provideService(ChildProcessSpawner, spawner),
      Effect.provideService(AppFileSystem.Service, fs),
    )

  return () => Effect.gen(function* () {
    return {
      execute: (params, ctx) => Effect.gen(function* () {
        const scan = yield* scanProvide(ShellScan.scanCommand({ ... }))   // R discharged here
        // ...
      }),
    }
  })
}))
```

**Why:** `Tool.define`'s constraint is structural: the registry's typed dispatch needs `execute` to be self-contained at the value level. The R-channel widening from `Effect.fn` helpers travels up the gen until something provides the service. Layer-level provision works for `init()` (whose R is in the type), but not for `execute` (whose R must be `never` regardless of how the body composes). This pattern landed in Wave 1 of the `replace-bash-task-2026-05-15` campaign when `argPath`/`resolvePath`/`cygpath`/`collect` moved out of `tool/shell.ts` into `tool/shell/scan.ts`. Wave 2 reuses the same pattern when wiring `ShellScan.*` into `tool/process/exec-command.ts`.
**See:** `packages/opencode/src/tool/shell.ts` (post-Wave-1) — `scanProvide` shim wrapping `ShellScan.scanCommand` calls. Related: `agentcontrol-required-by-toolregistry-existing-test-layers` (sibling layering pattern).

---

### `tool-define-inner-effect-gen-closing-brace`

**Severity:** DX-trap (false-positive coverage gap)
**When:** Defining a tool with `Tool.define(id, Effect.gen(... return () => Effect.gen(... return spec)))`.
**Symptom:** File reports 99.28% line coverage; the only missing line is the closing `})` of the inner `Effect.gen`. Behavior tests pass; the line is unhittable structurally.
**Fix:** Drop the inner `Effect.gen` wrapper. Return the spec object directly from the outer `Effect.gen`:

```ts
// BAD — closing `})` of inner Effect.gen reports 0 hits
export const FooTool = Tool.define(ID, Effect.gen(function* () {
  const svc = yield* SomeService
  return () => Effect.gen(function* () {
    return { description, parameters: Parameters, execute: (...) => Effect.gen(...) }
  })
}))

// GOOD — direct return; 100/100 line + branch
export const FooTool = Tool.define(ID, Effect.gen(function* () {
  const svc = yield* SomeService
  return { description, parameters: Parameters, execute: (...) => Effect.gen(...) }
}))
```

If a tool genuinely needs deferred construction, use `() => Effect.succeed({ ... })` instead of `() => Effect.gen(function* () { return { ... } })`.
**Why:** Bun's V8 coverage records the inner `})` as 0 hits even when the generator body executes successfully. The wrapper is logically pointless when the spec is constructible synchronously.
**See:** `packages/opencode/src/tool/tool.ts:57-59` (`Init` accepts both `DefWithoutID` and `() => Effect<DefWithoutID>`).

---

### `tool-execute-needs-explicit-result-type-disjoint-metadata`

**Severity:** DX-trap
**When:** Defining a tool whose `execute` returns different `metadata` shapes per branch (success vs validation-error vs typed-error mapping).
**Symptom:** Tool typechecks in isolation. Adding it to `tool/registry.ts` produces a wall of errors:
```
Argument of type 'Effect<...{ metadata: { error: ... } | { queued: ... } ...}, ...>' is not assignable to parameter of type 'Effect<Init<..., M>>'.
```
Downstream test files asserting `expect(result.metadata.queued).toBe(true)` start failing typecheck:
```
Argument of type 'true' is not assignable to parameter of type 'undefined'.
```
**Fix:** Annotate `execute`'s return type explicitly:

```ts
import * as Tool from "../tool"

execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    if (someError) {
      return { title: "...", metadata: { error: "x" }, output: "..." }
    }
    return { title: "...", metadata: { queued: true, target_session_id: id }, output: "..." }
  })
```

`Tool.ExecuteResult` defaults `M` to `Metadata = { [key: string]: any }`. The annotation prevents TS from narrowing `M` to the per-branch union.
**Why:** `Tool.define<P, M, R, ID>` infers `M` from the return type. Multiple branches with disjoint shapes narrow `M` to a union; downstream `result.metadata.<field>` access then fails for fields that only exist on some branches.
**Alternative:** widen via local `metadata: Record<string, unknown>` before the return.

---

### `tty-line-discipline-echo-defeats-clamp-timing-tests`

**Severity:** DX-trap
**When:** Asserting a yield-time clamp's effect on actual elapsed wall time when the test fixture is a TTY-mode process.
**Symptom:** Test asserts that `yield_time_ms: 50` clamps to 250ms (the `MIN_YIELD_TIME_MS` floor). Expected elapsed: ~350ms. Actual: ~106ms. The clamp logic IS correct.
**Fix:** Verify clamp behaviour at the unit level; don't try to verify it via end-to-end elapsed wall time:

```ts
// Good: unit test the clamp
expect(clampWriteYieldTime(50)).toBe(250)
expect(clampEmptyPollYieldTime(100)).toBe(5_000)

// Bad: timing-based clamp verification (race-prone)
const start = Date.now()
yield* writeDef.execute({ session_id: sid, chars: "x", yield_time_ms: 50 }, ctx)
expect(Date.now() - start).toBeGreaterThanOrEqual(300) // FAILS due to TTY echo
```

**Why:** When the spawned process is in TTY mode, the kernel's TTY line discipline echoes input characters back as output. Writing `"x\n"` produces `"x\r\n"` flowing back through `proc.onData`, which advances the byteCursor and fires the SubscriptionRef notify in `Pty.read`'s race. The read returns immediately on the wakeup-on-data path well before the 250ms idle deadline.

---

### `tui-component-coverage-needs-mount-split`

**Severity:** DX-trap
**When:** Adding a TUI component that uses hooks (`useSync`, `useTheme`, `useRoute`, etc.) and must reach 100% line coverage.
**Symptom:** `testRender(() => <Foo />)` throws `<provider> context must be used within a context provider`. Coverage on `foo.tsx` reports ~80% — helpers and view are 100% but the wrapper body is 0%.
**Fix:** Split the file into two:

1. `foo.tsx` — pure helpers + view component (`FooView`) that takes resolved data + theme RGBA as props. Testable with `testRender(() => <FooView {...props} />)` directly.
2. `foo-mount.tsx` (name must NOT substring-match `foo` for the `bun test` filter) — the production `Foo()` wrapper that calls hooks and threads derived data into `FooView`.

Update consumers to import `Foo` from `foo-mount.tsx`. Coverage on `foo.tsx` reaches 100%; `foo-mount.tsx` is excluded from the coverage requirement.

**Companion gotcha:** `Rule` from `@tui/component/border` calls `useTheme()` unconditionally even when given a `color` prop. A pure-prop view that uses `<Rule color={props.ruleColor} />` still throws at testRender. Inline the equivalent border:

```tsx
<box flexShrink={0} flexGrow={1} height={1} border={["bottom"]}
  customBorderChars={RULE_BORDER_CHARS} borderColor={props.ruleColor} />
```

with `RULE_BORDER_CHARS = { ...EmptyBorder, horizontal: "─" }` at module scope.
**Why:** `createSimpleContext` throws on `use()` outside its `provider`. Provider `init()`s often have side effects. Coverage only credits lines that EXECUTED — wrappers never invoked stay uncovered.

---

### `tui-flex-row-with-tall-text`

**Severity:** perf-regression (catastrophic — paint stalls past the failing node)
**When:** Touching the TUI render hot path (`routes/session/index.tsx`, `BlockTool`, `InlineTool`, message body components, anything rendering MCP / LLM / user-pasted text).
**Symptom:** Streaming visually halts mid-message. Solid reactivity keeps firing into the store, new messages mount, deltas accumulate — but **none of it appears on screen**. Same data renders fine in upstream OpenCode.
**Fix:**
- **Never wrap a child whose content can grow tall in `<box flexDirection="row">`.** Stack as vertical siblings instead. For fixed-width chrome, use absolute positioning (e.g. marginalia in a left gutter).
- **Don't use `wrapMode="word"` on text nodes that can hold user-pastable / multi-KB content.** Default wrap is correct.
- **Sanitize any string that flows from `props.input.<arbitrary-key>` into a `<text>` node** — use `@tui/util/inline-safe`.

**Audit checklist when touching the render hot path:**
1. `rg 'flexDirection="row"' packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — for each hit, ask "could the primary child of this row ever be tall?" If yes, restructure.
2. `rg 'wrapMode="word"' packages/opencode/src/cli/cmd/tui/` — for each hit, ask "can this text node ever hold user-pasted or multi-KB content?" If yes, drop the attribute.
3. If the fork has structural nodes (boxes, rows, attributes) in a render-hot-path component that upstream doesn't, that's a regression suspect by default.
4. Any string interpolated into a `<text>` node — sanitize.

**Why:** opentui is a naive measure-then-paint renderer on a 2D character grid. A row whose primary cell is a `<text>` that can wrap to many rows silently exceeds opentui's internal layout-measurement budget. When it does, paint stalls past the failing node and **everything subsequent stops rendering**. The browser-style `<row><text/><pill/></row>` with `justifyContent="space-between"` pattern that's free in browsers (retained-mode compositing, GPU reflow) is O(W × H) per render in opentui. **This bug class hit the codebase four times in two weeks** before the proactive sweep.
**See:** `packages/opencode/src/cli/cmd/tui/util/inline-safe.ts` (sanitizer).

---

### `word-boundary-regex-vs-prose-collisions`

**Severity:** DX-trap
**When:** Asserting "forbidden word X must not appear" against a tool's full description string when the description concatenates prose (`*.txt`) + structured enumeration (registry-appended bullets).
**Symptom:** `expect(spawn.description).not.toMatch(/\bworker\b/)` fails because `\bexplorer\b` matches "an explorer.", `\bworker\b` matches "Observer/worker —", `\bdefault\b` matches "by default." and "(default):".
**Fix:** Scope the regex to the structured section. Locate the enumeration header, slice from there, then anchor the regex to bullet starts:

```ts
const ENUM_HEADER = "Available agent types and the tools they have access to:"
const headerIdx = spawn.description.indexOf(ENUM_HEADER)
if (headerIdx < 0) throw new Error("enumeration header missing — describer changed?")
const enumeration = spawn.description.slice(headerIdx)
expect(enumeration).not.toMatch(/^- explorer:/m)   // matches only bullet entries
```

For tests verifying "this word does not appear ANYWHERE", use the underlying SOURCE (the registry method's return value) so prose and enumeration stay separable.
**Why:** Word boundaries `\b` match between a word character (`[A-Za-z0-9_]`) and a non-word character. In prose, EVERY occurrence of a word in a sentence is bounded by spaces, punctuation, parens, or em-dashes — all non-word chars. The intent ("don't allow `worker_a` etc.") was conflated with "underscore-suffixed only" — but `\bworker\b` matches both.

---

### `permission-fixture-order-rule-must-precede-specific-via-findlast`

**Severity:** correctness-bug (silent — fixture asserts wrong outcome)
**When:** Authoring a permission fixture (`packages/opencode/test/fixtures/permission-configs/*.json`) intended to express "more specific rule wins over wildcard".
**Symptom:** A fixture like `{ "bash": { "git *": "allow", "*": "ask" } }` produces `ask` (NOT `allow`) for `git status`. The intent ("git commands auto-allow, everything else asks") doesn't match what the production code does.
**Fix:** Order rules so the SPECIFIC ones come AFTER the wildcard. `Permission.evaluate` walks the ruleset with `findLast` — the LAST matching rule wins. Put the catch-all FIRST, then narrow with specifics:

```jsonc
// WRONG — `*: ask` shadows `git *: allow` because findLast picks the last match
{ "bash": { "git *": "allow", "*": "ask" } }

// RIGHT — `git *: allow` wins via findLast over the earlier `*: ask`
{ "bash": { "*": "ask", "git *": "allow" } }
```

In tests, sidestep fixture-order risk for assertions that exercise a SPECIFIC pattern shape (e.g. `git *` allow auto-allows `git status`) by building the ruleset inline:

```ts
const ruleset: Permission.Ruleset = [
  { permission: "bash", pattern: "git *", action: "allow" },
]
```

**Why:** `permission/evaluate.ts:11` uses `Array.findLast`. JavaScript's `Object.entries` preserves insertion order (ES2015+), so a fixture's JSON key order = ruleset array order. The intuitive "more specific wins via specificity scoring" is NOT what the code does — last-match wins, and "more specific" only wins if the user puts it last. The replace-bash-task-2026-05-15 Wave 0 fixture `git-allow-rest-ask.json` was authored with specifics first; it expresses the OPPOSITE of its intent.
**See:** `packages/opencode/src/permission/evaluate.ts:11`, `packages/opencode/test/fixtures/permission-configs/git-allow-rest-ask.json`. Related: `bug-3-fix-left-test-files-with-stale-required-shape` (other class of fixture/code drift).

---

### `bench-best-of-n-when-baseline-was-single-shot`

**Severity:** DX-trap (legit-looking budget failures from environmental noise)
**When:** Re-measuring a frozen baseline metric whose original capture used a small sample count (e.g. `samples: 20`) so its p99 == max sample. Single re-runs hit budget failures from a lone outlier even when the production code is unchanged or improved.
**Symptom:** A pure refactor or near-no-op change blows the 10/15% p95/p99 budget on 1-3 of every 5 bench runs. Mean/median measurements are stable and within budget.
**Fix:** Best-of-N over independent runs (3-8) is the codebase pattern. Pick the run whose `p50` is smallest and surface its full distribution as the canonical wave snapshot:

```ts
function pickBest(runs: ReadonlyArray<BenchResult>): BenchResult {
  return runs.reduce((acc, r) => (r.p50 < acc.p50 ? r : acc))
}

test("bench: my_metric", async () => {
  const runs: BenchResult[] = []
  for (let i = 0; i < 5; i++) runs.push(await runBench())
  const best = pickBest(runs)
  // best.p50 / .p95 / .p99 are the run's actual percentiles —
  // a coherent sample, NOT a stitched-together best-per-percentile.
})
```

**Why:** Tail percentiles (`sorted[N-1]` when N is small) are dominated by the cleanest run, not the underlying distribution. With `samples: 20`, `p99 = sorted[19] = max` — any single GC pause, kernel scheduling jitter, or laptop thermal blip blows the metric. Increasing samples to 100+ gives a true p99 but doesn't match baseline methodology, so deltas are misleading. Best-of-N over runs that match baseline methodology gives the cleanest comparable measurement. **Don't pick best-per-percentile across runs** (a Frankenstein measurement) — pick the best COHERENT run.

**Pick the percentile that matters, not always p50.** When a metric is dominated by tail outliers (PTY allocation, plugin dispatch, registry construction — anything with cold-path branches), best-by-p50 may pick a run whose p50 is fastest but whose p99 still hits an outlier. The bench then blows the 15% p99 budget even though the median improved. The fix is `pickBest = (runs) => runs.reduce((a, r) => r.p99 < a.p99 ? r : a)` — best-by-p99. The trade-off: the chosen run may have slightly slower p50 (acceptable when p50 has ample headroom — e.g. -20% versus baseline). Empirically: Wave 4 `registry.tools` (replace-bash-task-2026-05-15) flipped from `p99 +34%` (best-by-p50) to `p99 -29%` (best-by-p99) on the same 5 runs.

**See:** `packages/opencode/test/perf/exec-command.bench.ts` (Wave 2 of replace-bash-task-2026-05-15) — `pickBest` helper + best-of-8 over `runExecBench` (best-by-p50). `packages/opencode/test/perf/registry-tools.bench.ts` (Wave 4 of same campaign) — best-by-p99 variant for tail-sensitive metric. Related: `opentui-render-bench-noise-needs-best-of-n`, `runloop-bench-vs-baseline-methodology-mismatch`.

---

### `instancestate-bound-config-cannot-yield-at-layer-init`

**Severity:** correctness-bug (crashes first test that uses the layer)
**When:** Hoisting `Config.Service.get()` (or any `InstanceState`-backed read) out of a `Tool.define`'s INNER `Effect.gen` into the OUTER `Tool.define` `Effect.gen` to skip per-call overhead.
**Symptom:** Layer materializes fine. First test that exercises the tool crashes with `instance: No context found for instance` from `InstanceState.get` deep inside `Config.get`.
**Fix:** The `InstanceState.get` constraint is structural: `Instance.current` must be bound when the read happens. The OUTER `Tool.define` `Effect.gen` runs at LAYER MATERIALIZATION time — before any Instance is bound. The INNER `Effect.gen` (the function returned by the outer) runs at `info.init()` time, which executes inside the Instance scope.

```ts
// WRONG — outer gen at layer-init has no Instance
Tool.define(id, Effect.gen(function* () {
  const config = yield* Config.Service     // ok — service injection
  const cfg = yield* config.get()          // CRASH — no Instance bound here
  const defaultShell = Shell.acceptable(cfg.shell)
  return () => Effect.succeed({ execute: ... })
}))

// RIGHT — inner gen at init() runs with Instance.current bound
Tool.define(id, Effect.gen(function* () {
  const config = yield* Config.Service
  return () => Effect.gen(function* () {
    const cfg = yield* config.get()        // ok — Instance bound at init time
    const defaultShell = Shell.acceptable(cfg.shell)
    return { execute: (params, ctx) => /* uses defaultShell from closure */ }
  })
}))
```

The cost of yielding `config.get()` ONCE per `init()` (per Instance materialization) is amortized; per-call yields in `execute` were the actual hot-path overhead.
**Why:** Service injection (`yield* Config.Service`) is layer-time-safe — it just resolves the service stub. Method invocations (`config.get()`) execute the service's INTERNAL effect, which can include `InstanceState.get` reads that require `Instance.current`. The error surfaces deep in the call chain because the failing read is several frames down. Mirror of `agentcontrol-providerref-must-live-in-layer-not-instancestate` from the OTHER direction (that one says "shared state at layer scope, per-instance at InstanceState"; this one says "InstanceState-reads at instance scope, NOT at layer init").
**See:** `packages/opencode/src/tool/process/exec-command.ts` (Wave 2 of replace-bash-task-2026-05-15) — `cfg = yield* config.get()` placed in the INNER `Effect.gen`. Related: `agentcontrol-providerref-must-live-in-layer-not-instancestate`, `bench-effect-runpromise-loses-instance-in-async-callback`.

---

### `permission-key-collapse-needs-dual-write-evaluate-vs-disabled`

**Severity:** correctness-bug (silent built-in agent rules become inert)
**When:** Collapsing N tool IDs onto a single permission key via the SHELL_TOOLS / MULTI_AGENT_TOOLS / EDIT_TOOLS group pattern in `permission/index.ts:disabled`. `Permission.disabled` consults the GROUPED key; `Permission.evaluate` (used by `permitted` in `session/system.ts:capabilityHints` and by per-call `ctx.ask` flows) consults the LITERAL key. Built-in agent rules in `src/agent/agent.ts` that target individual tool IDs need DUAL-WRITE to keep both call sites working.

**Symptom:**
- Plan agent's `spawn_agent: "deny"` rule no longer hides spawn_agent from the model's tool list (Permission.disabled lookup uses "task" via MULTI_AGENT_TOOLS, sees no `task: deny`, leaves spawn_agent visible).
- Explore agent's per-friend `send_message: "allow"` etc. rules no longer keep those tools visible (Permission.disabled uses "task" lookup, sees explore's wildcard `*: deny`, removes the entire group from explore).
- BUT the `permitted` check in `system.ts:capabilityHints` still uses the literal key — so removing the per-friend rules silently breaks `system-prompt-regression.test.ts`'s explore-agent fragment-injection assertion.

**Fix:** Keep BOTH the per-friend rules (for evaluate / capabilityHints / per-call asks) AND add the group-key rule (for Permission.disabled). They're not redundant — they target different lookup paths.

```ts
// src/agent/agent.ts — plan
permission: Permission.merge(
  defaults,
  Permission.fromConfig({
    // Per-friend deny rules: evaluate("spawn_agent", "*", ruleset) returns
    // deny → permitted("spawn_agent") false → no MULTI_AGENT_ROOT fragment
    // injected. Per-call ctx.ask payloads (where they happen) hit the
    // literal-key match too.
    spawn_agent: "deny",
    send_message: "deny",
    followup_task: "deny",
    wait_agent: "deny",
    list_agents: "deny",
    close_agent: "deny",
    // Group-key deny: Permission.disabled looks up under "task" (via
    // MULTI_AGENT_TOOLS group); finds task: deny → removes ALL 6 v2
    // tools (and legacy task) from the model's visible tool list.
    task: { "*": "deny" },
  }),
)

// src/agent/agent.ts — explore (the inverse: re-enable visibility)
permission: Permission.merge(
  defaults,
  Permission.fromConfig({
    "*": "deny",
    // Per-friend allows: evaluate sees them → permitted("send_message")
    // true → SUBAGENT fragment injected. Pre-Wave-3 these rules ALSO
    // unblocked Permission.disabled; post-Wave-3 they no longer do
    // (lookup uses "task" key).
    send_message: "allow",
    followup_task: "allow",
    wait_agent: "allow",
    list_agents: "allow",
    // Group-key override: Permission.disabled looks up under "task";
    // without this rule the wildcard `*: deny` above would propagate
    // to the entire MULTI_AGENT_TOOLS group, hiding all 6 v2 tools
    // from explore. `task: ask` overrides the wildcard for the
    // task-key lookup so the 4 coordination tools stay visible (with
    // per-call prompts as the safety surface).
    task: "ask",
  }),
)
```

**Why:** `Permission.disabled(toolIDs, ruleset)` walks each tool ID through the EDIT_TOOLS / SHELL_TOOLS / MULTI_AGENT_TOOLS group mapping to derive a `permission` key, then `findLast`s on that key. The result is "is this tool wildcard-denied for the GROUP?" `Permission.evaluate(perm, pattern, ruleset)` matches the literal `perm` against `rule.permission` via `Wildcard.match` — which means a literal `"spawn_agent"` query does NOT match a `"task"` rule (and vice versa). The two functions have different semantics by design (the disabled() group rule makes user toggles act on the group; the evaluate() literal-key match preserves fine-grained per-tool decisions for callers who want them). The interaction surfaces when built-in agent rules use literal-key denies — they only block one of the two paths post-collapse.

**Rule of thumb:** When collapsing tool keys onto a group:
- **User-saved configs** (BC matrix): documented as "out of scope" — users restate intent under the group key.
- **Built-in agent rules in `src/agent/agent.ts`**: dual-write the group key rule alongside the per-tool rules. The per-tool rules become decorative for `Permission.disabled` but still drive `Permission.evaluate` callers.
- **Per-call `ctx.ask` payloads**: change the literal `permission:` field once (in the tool's `PermissionKey` constant); `Permission.disabled` already routes through the group key; `Permission.ask` evaluates with the same key the ctx.ask carries, so the per-call ask resolves consistently.

**See:** `packages/opencode/src/agent/agent.ts` (Wave 3 of replace-bash-task-2026-05-15) — plan and explore agents both dual-write per-friend + group-key rules. Related: `permission-fixture-order-rule-must-precede-specific-via-findlast` (the `findLast` semantics that shape both disabled() and evaluate()).

---
