# TDD discipline — non-negotiable, integration-first

Carries forward from `.wave/campaigns/codex-parity-2026-05-13/plan/TDD.md`. The previous campaign held to TDD at the unit level, hit 100% line coverage on every file, and still shipped two structural bugs because no test exercised an integration scenario that would have caught them. This campaign augments TDD with a hard integration-first rule.

## Wave shape (unchanged)

Every wave that touches code follows the same shape:

1. Write the tests. Run them. They fail (red).
2. Write the implementation. Run them. They pass (green).
3. Run typecheck + lint. Both clean.
4. Run perf benchmark for that area. Compare to baseline. No regression.
5. Commit. Update STATE. Done.

If you write the implementation before the tests, you have failed the wave. Revert, restart.

## Integration-first rule (NEW for this campaign)

For every wave that touches `src/agent/control.ts`, `src/tool/agent-*`, or anything that reads from / writes to a child session's mailbox:

1. The wave MUST add at least one `it.instance(...)` test in `packages/opencode/test/integration/multi-agent-invariants.test.ts` covering the relevant `INTEGRATION_INVARIANTS.md` invariant.
2. The integration test asserts observable behavior — multi-root isolation, child-completion wakes parent, cross-root rejection, etc. — never internal state.
3. The integration test MUST run red against the pre-fix code and green against the post-fix code. If the test passes against the broken code, the test is checking the wrong thing — rewrite it.
4. Coverage at 100% line is necessary but not sufficient. A wave that hits 100% coverage with no new integration test is a wave failure.

The integration test file is created in Wave 0 with `.skip` stubs for every invariant. Each later wave unskips and implements the relevant ones.

## Coverage requirement (unchanged)

100% line coverage on every file added or modified in this campaign.

To verify locally:

```bash
cd packages/opencode
bun test --coverage path/to/your/test.test.ts
```

Per the `bun-coverage-aggregation-flake` GOTCHA, ALWAYS use single-file coverage runs. Multi-file aggregation can drop hit counts on lines that single-file runs cover correctly. Source of truth = single-file run.

Per `bun-coverage-line1-quirk` and `bun-coverage-line1-schema-class-only`: if a file shows 99% line coverage with only line 1 uncovered, reorder imports so line 1 is `import * as ... from "node:..."` rather than a default import / comment / Schema.Class-only file's `import { Schema } from "effect"`.

Per `schema-class-function-coverage`: function coverage may show <100% if the file contains a `Schema.TaggedErrorClass`. The bar is 100% LINE coverage — function coverage is a lossy proxy.

## Test categories (this campaign's mix)

### Unit tests

- Located alongside the code: `src/foo/bar.ts` ↔ `src/foo/bar.test.ts`.
- Use `testEffect` from `test/lib/effect.ts` for Effect services.
- Use `it.live(...)` for tests needing real time, fs, child processes, sockets.
- Use `it.instance(...)` for tests needing a scoped tmpdir + Instance binding.

This campaign's unit-test additions live in `src/agent/control.test.ts` (Wave 1 + Wave 2) and any new helpers' own files.

### Integration tests (PRIMARY DELIVERABLE)

- Located in `packages/opencode/test/integration/multi-agent-invariants.test.ts` (created in Wave 0).
- Use `it.instance(...)` so each test gets its own scoped tmpdir + Instance binding.
- Use `afterEach(disposeAllInstances)` so multi-root tests don't leak state across tests.
- Stub the run-loop with `Effect.never` (per the existing `installNeverLoop` pattern in `multi-agent-tools.test.ts`) UNLESS the test specifically needs to drive a real session — in which case use `stub-provider.ts`.
- One test per invariant. Test name = invariant slug from `INTEGRATION_INVARIANTS.md` so the wave's verification can grep for it.

### Backward-compat tests

- Located in `packages/opencode/test/backward-compat/`.
- The previous campaign's tests in this directory MUST stay green.
- This campaign's Wave 4 adds (or extends) a `legacy-task-tool.test.ts` to assert the legacy `task` tool keeps working after Wave 1's per-root refactor.

### Performance benchmarks

- Located in `packages/opencode/test/perf/<area>.bench.ts`.
- Use the harness in `packages/opencode/test/lib/perf.ts`.
- Output measurements to `.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf/wave_<N>.json`.
- Compare against `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` (frozen).

## Test-writing rules

### Names

A test name reads as a sentence about the system.

Bad: `"list_agents test"`. Good: `"list_agents called from chat B does not return chat A's worker"`.

### Setup

Use `beforeEach` for fixtures that don't carry state. Use `it.instance`'s scoped tmpdir for tests needing per-test isolation. Never share mutable state between tests.

For multi-root integration tests: the test body creates two root sessions via `sessions.create({ title: ... })` (no `parentID`), registers each via `control.registerSessionRoot(rootId)`, then exercises the multi-root scenario.

### Assertions

Direct equality wherever possible. Assert deterministic parts; assert non-deterministic parts have the right shape (`expect(typeof x).toBe("string")` + `expect(x).toMatch(/^prc_/)`).

Avoid asserting on internal state shapes. Assert on the API surface — `list_agents` output, `drainMailbox` output, `wait_agent` return value, status `SubscriptionRef.get` value.

### Edge cases — required

Every wave's tests must cover:

- Happy path
- Concurrent invocation (especially multi-root / cross-root scenarios)
- Cancellation / interruption
- Failure modes the implementation can produce

For Wave 1's multi-root work, also cover:

- Root deletion mid-flight (per-root data is torn down)
- Same task_name spawned in two different roots (no `path_already_exists` collision)
- Cross-root `sendInterAgentCommunication` rejected with `AgentNotFoundError`
- Cross-root `closeAgent` rejected with `AgentNotFoundError`

For Wave 2's completion-watcher work, also cover:

- Child completes successfully → notification sent
- Child errors → notification sent with errored body
- Child interrupted by `closeAgent` → notification SKIPPED (parent already knows)
- Multiple children completing concurrently → each fires its own notification
- Watcher fiber cleaned up on instance disposal (no leaked fibers)

## Mocking policy (unchanged)

Per repo style: avoid mocks. The only acceptable mocks:

- The model provider stub (`stub-provider.ts`) for tests that exercise `runLoop`.
- Time mocks for clamp/timeout behavior tests.

If you find yourself writing a 10-line mock for some service, you are testing your mock not the system. Use the real service.

## Verifying behavior, not implementation

A test should pass if I rewrite the implementation in a different way that produces the same observable behavior. If your test breaks because someone refactored an internal function, your test was checking the wrong thing.

Example (good for this campaign):

```ts
// Asserts observable behavior — the multi-root scenario works correctly
it.instance("two roots in same project see independent worker_a", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const control = yield* AgentControl.Service
    yield* installNeverLoop
    const rootA = yield* sessions.create({ title: "chatA" })
    const rootB = yield* sessions.create({ title: "chatB" })
    yield* control.registerSessionRoot(rootA.id)
    yield* control.registerSessionRoot(rootB.id)
    // ... spawn worker_a from each, then assert each sees only its own
  }),
)
```

Bad (depends on internals — will break on refactor):

```ts
expect(control["data"]["mailboxes"].size).toBe(2)
```

## What "tests pass" means for wave completion

Each wave's WAVE.md `Verification` section spells out the exact commands. Standard:

```bash
cd packages/opencode
bun typecheck
bun lint
bun test --coverage <single-file>.test.ts   # 100% line coverage on touched
bun test ./test/integration/multi-agent-invariants.test.ts   # invariants green
bun test ./test/perf/<wave>.bench.ts        # within budget (when applicable)
```

All four must exit 0. No skipped tests (other than Wave 0's seeded `.skip` stubs which Wave 1 / 2 / 3 unskip). No `// @ts-expect-error` without an explanatory comment. No `eslint-disable` without an explanatory comment.
