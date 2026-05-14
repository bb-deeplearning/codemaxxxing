# TDD discipline — non-negotiable, integration-first, differentially verified

Inherits from `.wave/campaigns/codex-parity-2026-05-13/plan/TDD.md` and `.wave/campaigns/codex-parity-hardening-2026-05-14/plan/TDD.md`. Adds practices the previous campaigns showed were necessary: differential testing for refactors, real-config fixture suite for BC, mutation probe per wave, and an explicit test pyramid quota declared by each WAVE.md.

## Wave shape (unchanged from prior campaigns)

Every wave that touches code:

1. Write the tests. Run them. They fail (red).
2. Write the implementation. Run them. They pass (green).
3. Run typecheck + lint. Both clean.
4. Run perf benchmark for that area against baseline. No regression beyond budget.
5. Run differential / fixture tests where the wave declares them.
6. Commit. Update STATE. Done.

Implementation before tests = wave failure. Revert and restart.

## Coverage requirement

100% line coverage on every file added or modified in this campaign. Verify locally:

```bash
cd packages/opencode
bun test --coverage <single-file>.test.ts
```

Per the `bun-coverage-aggregation-flake` GOTCHA: ALWAYS use single-file coverage runs. Multi-file aggregation can drop hit counts on lines that single-file runs cover correctly. Source of truth = single-file run.

Per `bun-coverage-line1-quirk` and `bun-coverage-line1-schema-class-only`: if a file shows 99% line coverage with only line 1 uncovered, reorder imports so line 1 is `import * as ... from "node:..."` rather than a default import / comment / Schema.Class-only file's `import { Schema } from "effect"`.

Per `schema-class-function-coverage`: function coverage may show <100% if the file contains a `Schema.TaggedErrorClass`. The bar is 100% LINE coverage — function coverage is a lossy proxy.

## Integration-first rule

Every wave that touches `tool/shell.ts`, `tool/shell/scan.ts`, `tool/process/`, `tool/agent-*`, `tool/registry.ts`, `permission/index.ts`, or `session/llm.ts`:

1. The wave MUST add at least one `it.instance(...)` test in `packages/opencode/test/integration/tool-surface-replacement.test.ts` covering the relevant invariant from `INTEGRATION_INVARIANTS.md`.
2. The integration test asserts observable behavior — model-visible tool list, permission decision outcome, rendered prompt content — never internal state.
3. The integration test MUST run RED against the pre-fix code and GREEN against the post-fix code. If the test passes against the broken code, the test is checking the wrong thing — rewrite it.
4. Coverage at 100% line is necessary but not sufficient. A wave that hits 100% coverage with no new integration test against the surface it touched is a wave failure.

The integration test file is created in Wave 0 with `.skip` stubs for every invariant. Each later wave unskips and implements the relevant ones.

## Differential testing rule

Wave 1, 2, 3, and 5 ship a refactor or replacement of an existing code path. Each must include a **differential test**: run the OLD and NEW paths against the SAME input from `FIXTURES.md`, assert byte-identical (or surgically-explained) outputs.

Locations:

- Wave 1 — `packages/opencode/test/differential/scanner-extract.diff.test.ts`. OLD: `shell.ts`'s in-line `parse`+`collect`+`ask` flow on a corpus of 50 commands. NEW: `tool/shell/scan.ts`'s `scanCommand`+`askForScan` flow on the same 50. Assert produced `Scan { dirs, patterns, always }` is structurally equal AND the `ctx.ask` payload is structurally equal.
- Wave 2 — `packages/opencode/test/differential/exec-permission.diff.test.ts`. OLD: `bash` tool against fixture configs. NEW: `exec_command` tool against the same fixture configs. Assert the resulting permission decisions (`allow` / `ask` / `deny`) are equal for every (config, command) pair.
- Wave 3 — `packages/opencode/test/differential/spawn-permission.diff.test.ts`. Same shape for `task` vs `spawn_agent`.
- Wave 5 — `packages/opencode/test/differential/prompt-prose.diff.test.ts`. OLD prompt prose (shell.txt + task.txt rendered) versus NEW prompt prose (exec_command + spawn_agent rendered). Assert key fragments — git safety protocol, file-op restriction, per-subagent-type listing — appear in the new with byte-identical text.

Differential failures = wave failure. Surgical diffs allowed only if explicitly enumerated in the wave's NOTES.md with the exact lines that diverge and the justification for each.

## Property-based / fuzz testing

Wave 1 only. The scanner is the campaign's most algorithmically rich addition; the user-input space is enormous. Property test:

```ts
it.live("scanner is deterministic and idempotent across 1000 random commands", ...)
```

Generate from a small grammar (subset: command + 0-3 args, optional pipe, optional &&, optional redirect). Assertions per generated input:

- No crash, no thrown exception
- Same input → same output (run twice, compare)
- `BashArity.prefix(tokens).length <= tokens.length`
- Re-parsing `source(node)` from a tree produces a tree whose `source` equals the original
- `scan.patterns.size > 0` for any non-empty input

Output the seed used for reproducibility on failure.

## Concurrent stress tests

Concurrency is where shared parser state corrupts. The tree-sitter `Parser` instance is lazy-loaded ONCE per process; if multiple Effects call into it concurrently and it isn't reentrant, we get garbage output non-deterministically. Each wave that touches a shared state surface adds a stress test:

- Wave 1 — N=64 concurrent `scanCommand` calls with varied inputs. Assert each result still matches its input deterministically.
- Wave 2 — N=32 concurrent `exec_command` calls with permission flow active. Assert no permission cross-contamination (each call's `ctx.ask` carries only its own command's patterns).
- Wave 3 — N=16 concurrent `spawn_agent` calls. Assert no per-subagent-type permission collision.

## Mutation-test sanity probe

Once per wave on the wave's primary file. After the wave's implementation lands and tests are green:

1. Pick the most semantically critical line (a permission key check, a category mapping, a wildcard match).
2. Deliberately corrupt it (flip `===` to `!==`, swap a string literal).
3. Run the wave's test file.
4. Assert at least one test goes RED.
5. Restore the original line. Re-run; all green.
6. Document the probe in NOTES.md (line probed, what change, which test caught it).

If no test goes RED after the corruption, the test suite isn't actually checking that line. Add a test that does, then restore.

## Real config fixtures

Wave 0 creates `packages/opencode/test/fixtures/permission-configs/` with concrete user-config shapes drawn from `FIXTURES.md`. Examples:

- `empty-config.json` — no permission rules
- `allow-all-bash.json` — `permission.bash: "allow"`
- `deny-all-bash.json` — `permission.bash: { "*": "deny" }`
- `git-allow-rest-ask.json` — `permission.bash: { "git *": "allow", "*": "ask" }`
- `task-explore-allow.json` — `permission.task: { "explore": "allow", "general": "ask" }`
- `mixed-permissions.json` — `permission.bash: { ... }, permission.task: { ... }, permission.edit: "deny"`
- (extend per `FIXTURES.md`)

Wave 2/3/4/6 each load every fixture and assert the corresponding tool-list outcomes and permission-decision outcomes match the doc. Adding a fixture is encouraged; deleting one requires explicit justification in NOTES.md.

## Hermetic test isolation

Every integration test gets its own scoped `Instance` via `it.instance`. `afterEach(disposeAllInstances)` so multi-root scenarios don't leak state. Per the `Instance.bind` GOTCHA in the repo-root GOTCHAS.md, native callbacks need explicit binding; tests must not rely on Instance leak across `it` blocks.

## Test categories used in this campaign

### Unit
- Located alongside code. `src/foo/bar.ts` ↔ `src/foo/bar.test.ts`.
- `testEffect` from `test/lib/effect.ts` for Effect services.
- `it.live(...)` for real fs / child processes / sockets / time.
- `it.instance(...)` for scoped tmpdir + Instance binding.

### Integration invariants (PRIMARY)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts`.
- `it.instance(...)` so each test gets its own scoped tmpdir + Instance binding.
- Test name = invariant slug from `INTEGRATION_INVARIANTS.md`.
- One per invariant. No skips except Wave 0's seeded stubs.

### Differential
- `packages/opencode/test/differential/<wave-target>.diff.test.ts`.
- Loads fixtures from `test/fixtures/`.
- Asserts OLD-path output == NEW-path output for every fixture.

### Fixture suite
- `packages/opencode/test/fixtures/permission-configs/*.json`.
- Run by integration tests + differential tests + the BC suite in Wave 6.

### Performance benchmarks
- `packages/opencode/test/perf/<area>.bench.ts`.
- Use the harness in `packages/opencode/test/lib/perf.ts`.
- Output to `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_<N>.json`.
- Compare against `artifacts/baseline-perf.json` (frozen at Wave 0).

### Plugin contract (Wave 4 only)
- `packages/opencode/test/integration/plugin-bridge.test.ts`.
- Asserts `tool.definition` hooks for legacy IDs (`bash`, `task`) still fire and propagate correctly to the new tools.

### Backward-compat (Wave 6)
- Aggregate run over every fixture + every integration invariant + every differential test.
- Single failure = wave failure.

## Test-writing rules

### Names
A test name reads as a sentence. Bad: `"exec_command perms"`. Good: `"exec_command(cmd: 'git status') matches saved permission.bash 'git *' allow rule"`.

### Setup
`beforeEach` for stateless fixtures. `it.instance`'s scoped tmpdir for tests needing per-test isolation. Never share mutable state.

### Assertions
Direct equality wherever possible. Assert deterministic parts; assert non-deterministic parts have the right shape.

Avoid asserting on internal state shapes. Assert on the API surface: tool list, permission decision, prompt content, Bus event sequence.

### Edge cases — required per wave
- Happy path
- Empty / max input
- Concurrent invocation (where applicable; mandatory for Wave 1/2/3)
- Cancellation / interruption
- Failure modes the implementation can produce

## Mocking policy

Per repo style: avoid mocks. Acceptable mocks only:

- `stubProvider` for runLoop tests (no live LLM in tests)
- Time mocks for clamp/timeout behavior

If you write a 10-line mock for some service, you are testing your mock not the system. Use the real service.

## Verifying behavior, not implementation

A test should pass if I rewrite the implementation differently but produce the same observable behavior. If your test breaks because someone refactored an internal function, your test was checking the wrong thing.

Good — observable:
```ts
it.instance("permission.bash 'git *' allow auto-allows exec_command(git status)", () =>
  Effect.gen(function* () {
    const config = loadFixture("git-allow-rest-ask.json")
    const decision = yield* runExecCommand({ cmd: "git status" }, config)
    expect(decision.action).toBe("allow")
  }),
)
```

Bad — internal:
```ts
expect(scanResult["always"].size).toBe(2)
```

## What "tests pass" means for wave completion

Each wave's WAVE.md `Verification` section spells out exact commands. Standard:

```bash
cd packages/opencode
bun typecheck
bun lint
bun test --coverage <single-file>.test.ts   # 100% line per touched file
bun test ./test/integration/tool-surface-replacement.test.ts   # invariants green
bun test ./test/differential/<wave>.diff.test.ts   # OLD == NEW
bun test ./test/perf/<wave>.bench.ts        # within budget (when applicable)
```

All four (or five with differential) must exit 0. No skipped tests other than Wave 0's seeded `.skip` stubs which later waves unskip. No `// @ts-expect-error` without an explanatory comment. No `eslint-disable` without an explanatory comment.

## Test pyramid quota per wave

Each WAVE.md declares its expected test mix. Not "more is better" — right shape per change. Examples:

- Wave 1 (scanner extract): heavy on unit + property + differential. Light on integration (one invariant).
- Wave 2 (exec_command wire): heavy on differential + integration invariants + fixture suite. Light on unit.
- Wave 4 (registry drop): heavy on integration + plugin contract + tool-list snapshot. No new unit logic.

Wave fails if it ships zero tests in a category its WAVE.md said it would.
