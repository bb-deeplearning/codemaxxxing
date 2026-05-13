# TDD discipline — non-negotiable

This campaign ships test-first. Every wave that touches code has the same shape:

1. Write the tests. Run them. They fail (red).
2. Write the implementation. Run them. They pass (green).
3. Run typecheck + lint. Both clean.
4. Run perf benchmark for that area. Compare to baseline. No regression.
5. Commit. Update STATE. Done.

If you write the implementation before the tests, you have failed the wave. Revert, restart.

## Coverage requirement

100% line + branch coverage on every file you add or modify in this campaign. The test command for each wave checks this. If coverage drops below 100% on any new/modified file, the wave fails.

To verify coverage locally:
```bash
cd packages/opencode
bun test --coverage path/to/your/test.test.ts
```

Coverage reports live in `coverage/` (gitignored). Wave verification asserts every targeted file is at 100%.

## Test categories

Each wave produces tests in one or more of these categories:

### Unit tests — behavior
- Located alongside the code: `src/foo/bar.ts` ↔ `src/foo/bar.test.ts`
- Use Bun's built-in test runner (`bun test`)
- Use `testEffect` from `packages/opencode/test/lib/effect.ts` for Effect services
- Use `it.live(...)` for tests that need real filesystem, child processes, real time, or sockets
- One test per behavior. No "test everything in one giant test." Each test name describes the behavior it asserts.
- Assertions are concrete: exact values, exact field shapes, exact lengths. No "works correctly" or "is reasonable."

### Schema tests — JSON tool surface
- For every tool definition added in this campaign: assert the produced JSON schema matches the expected shape
- Required fields, types, defaults, output schema all verified
- Use snapshot tests sparingly (only for prose descriptions); use structural assertions for everything else

### Integration tests — cross-module behavior
- Located in `packages/opencode/test/integration/<feature>.test.ts`
- Spawn real PTYs, use real Effect runtimes, walk through real session loops
- Use `it.live(...)`
- Hermetic: no network, no system Python, no system packages — use `bun -e '<inline js>'` for scripted child processes

### End-to-end tests — full feature
- Located in `packages/opencode/test/e2e/<scenario>.test.ts`
- Walk through a complete user workflow: prompt → agent spawns siblings → siblings communicate → result returns
- Wave 14 is dedicated to these

### Backward-compat tests
- Located in `packages/opencode/test/backward-compat/`
- Load real snapshots of pre-campaign state (saved in `test/backward-compat/snapshot/`)
- Verify no behavior change for existing surfaces

### Performance benchmarks
- Located in `packages/opencode/test/perf/<area>.bench.ts`
- Use the harness in `packages/opencode/test/lib/perf.ts` (created in Wave 0)
- Output measurements as JSON to `artifacts/perf/<wave-id>.json`
- Wave 0 captures the baseline; every subsequent wave's perf bench compares to it

## Test-writing rules

### Names

A test name reads as a sentence about the system. Bad: `"head tail buffer pushChunk"`. Good: `"pushChunk fills head before tail when below max_bytes"`.

### Setup

Use `beforeEach` for fixtures that don't carry state. Use `it.live`'s scoping for resources that need teardown (PTYs, child processes, temp dirs). Never share mutable state between tests.

### Assertions

Direct equality wherever possible. For structures with non-deterministic fields (timestamps, IDs), assert the deterministic parts and assert the non-deterministic parts have the right SHAPE (e.g. `expect(typeof result.id).toBe("string")` and `expect(result.id).toMatch(/^prc_/)`).

### Edge cases — required

Every wave's tests must cover:
- Happy path
- Empty input
- Maximum input (boundary on byte/length caps)
- Concurrent invocation (where applicable — esp. for AgentControl, Mailbox, Pty)
- Cancellation / interruption (`AbortSignal` in tools, `Effect.interrupt` for fibers)
- Failure modes the implementation can produce (errors, partial state)

If a behavior described in the spec or in this WAVE.md isn't covered by a test, the wave is incomplete.

## Mocking policy

Per repo style: avoid mocks. Test the actual implementation. The only acceptable mocks are:
- A model provider stub for tests that exercise `runLoop` (so we don't burn API credits in CI)
- Time mocks for clamp/timeout behavior tests (`vi.useFakeTimers()` style)

If you find yourself writing a 10-line mock for some service, you are testing your mock not the system. Use the real service.

## Verifying behavior, not implementation

A test should pass if I rewrite the implementation in a different way that produces the same observable behavior. If your test breaks because someone refactored an internal function, your test was checking the wrong thing.

Example bad: `expect(buffer["head_bytes"]).toBe(512000)` — depends on internal field name.
Example good: `expect(buffer.retainedBytes()).toBe(512000)` — depends on observable behavior.

## Performance test discipline

- Each bench runs N=1000 iterations (or whatever the harness says) with warmup
- Report p50, p95, p99
- Compare against baseline JSON in `artifacts/baseline-perf.json`
- Tolerance: ≤ 5% regression on any metric. If you exceed, the wave fails.
- If you legitimately need more headroom (e.g. an unavoidable correctness fix), document why in NOTES.md and bump the baseline (rare; needs explicit justification).

## What "tests pass" means for wave completion

Each wave's WAVE.md `Verification` section spells out the exact commands. Standard:

```bash
cd packages/opencode
bun typecheck
bun lint
bun test path/to/this/wave/tests
bun test path/to/this/wave/perf-benches
```

All four must exit 0. No skipped tests. No `// @ts-expect-error` without an explanatory comment. No `eslint-disable` without an explanatory comment. Every disabled lint or skipped test is an explicit decision the next reviewer can find.
