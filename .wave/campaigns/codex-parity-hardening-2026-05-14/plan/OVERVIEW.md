# Project context — codex-parity-hardening

This campaign hardens the multi-agent v2 subsystem shipped by `codex-parity-2026-05-13` against three structural bugs that survived the previous campaign's per-primitive 100% coverage. Two of the three are unfixed (this campaign fixes them); the third already landed and is audited read-only by Wave 0.

## What's broken

The full root-cause analysis is in `INTEGRATION_INVARIANTS.md`. Headlines:

1. **Bug 1 — `AgentControl` state shared across root sessions.** `packages/opencode/src/agent/control.ts:360` keys `InstanceState.make` per directory, not per root session. Every chat session in the same project shares one registry, one mailbox map, one statuses map, one fibers map, and one `rootRef` (last-write-wins). `list_agents` from chat B sees chat A's workers; `send_message` and `close_agent` cross the root boundary; `spawn_agent` collides on `path_already_exists`.
2. **Bug 2 — `wait_agent` never wakes on child completion.** The child fiber's `onExit` (`control.ts:589-610`) only updates the child's status `SubscriptionRef`. It never sends to the parent's mailbox. `wait_agent` (`tool/agent-wait/agent-wait.ts:115-127`) subscribes to the parent's mailbox seq watch, which only advances when something is sent INTO the parent. Child completion → status changes → parent mailbox unchanged → wait races change vs timeout, timeout always wins.
3. **Bug 3 — `agent_type` role-vocabulary mismatch.** ALREADY FIXED on `codex-parity` (commit `c86c58f94`). Wave 0 verifies the fix is intact via a small read-only assertion test. DO NOT re-fix.

The shared root cause across all three: the previous campaign asserted that primitives worked, not that scenarios worked. This campaign's first-class deliverable is `INTEGRATION_INVARIANTS.md` plus the harness that exercises every invariant against real `it.instance` fixtures.

## What we're shipping

| Wave | Goal |
|------|------|
| 0 | Integration test infrastructure + `INTEGRATION_INVARIANTS.md` + bug 3 audit test |
| 1 | Bug 1 — per-root scoping in `AgentControl` (TDD-first, integration tests for the multi-root invariants) |
| 2 | Bug 2 — completion watcher that wakes parent on child final status (TDD-first, end-to-end integration test that would have caught the original bug) |
| 3 | Audit pass — apply remaining INTEGRATION_INVARIANTS to existing surfaces (`closeAgent` cascade, `sendInterAgentCommunication` routing, `drainMailbox` under concurrent sends, Pty cleanup on parent abort) and patch any gaps |
| 4 | Backward compat verification + perf audit vs prior campaign baseline |
| 5 | Spec doc at `specs/codex-parity-hardening.md` |

Each wave that touches multi-agent code MUST add at least one `it.instance` integration test in `packages/opencode/test/integration/multi-agent-invariants.test.ts` against the relevant invariant. Coverage alone does not satisfy this campaign.

## Hard constraints

- **TDD discipline.** Tests before implementation. 100% line coverage on touched files (run single-file per `bun-coverage-aggregation-flake` GOTCHA).
- **Integration-first.** Coverage is necessary, not sufficient. The new file `test/integration/multi-agent-invariants.test.ts` (created in Wave 0) carries the campaign's invariant tests; every later wave unskips and implements the relevant ones.
- **No perf regressions** vs `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` (5/10/15 % p50/p95/p99 budget).
- **Backward compat.** Legacy `task` tool, old sessions, Pty consumers, existing TUI keep working. No Drizzle migrations.
- **No live LLM calls.** Use `packages/opencode/test/lib/stub-provider.ts`.
- **Module shape.** Flat exports + self-reexport. NO `export namespace`. Per `packages/opencode/AGENTS.md`.
- **Effect v4.** `Effect.fn`, `Effect.gen`, `InstanceState.make`, `Effect.forkIn(parentScope)` for siblings. NO `Effect.fork` / `Effect.forkDaemon`.
- **DO NOT re-fix bug 3.**
- **Codex reference is READ-ONLY.** `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/`.

## Project facts

- Stack: TypeScript + Bun + Effect v4 (effect-smol) + Solid + opentui + Drizzle/SQLite.
- Test runner: `bun test` from `packages/opencode/`. NEVER from repo root (do-not-run-tests-from-root guard).
- Typecheck: `bun typecheck` from `packages/opencode/`. Never `tsc` directly.
- Tests live alongside code (`foo.ts` ↔ `foo.test.ts`) or in `packages/opencode/test/{integration,e2e,perf,backward-compat,lib}/`.
- Branch: `codex-parity` (previous campaign already merged onto it; this campaign continues on the same branch).

## Cross-cutting reference docs (in this `plan/` directory)

- `INTEGRATION_INVARIANTS.md` — the campaign's first-class deliverable. Read on every wave that touches multi-agent code.
- `GOTCHAS.md` — append-only knowledge base. Carries forward every entry from the previous campaign plus new entries this campaign discovers. Read end-to-end on every wave entry.
- `REFERENCES.md` — file-path index of every source file the campaign may touch + pointers to the previous campaign's reference docs.
- `STYLE.md` — codemaxxxing code standards (carried forward and edited for this campaign's narrower scope).
- `TDD.md` — test-first protocol + 100% coverage requirement (carried forward, augmented with the integration-first rule).
- `BACKWARD_COMPAT.md` — what must keep working (carried forward unchanged in spirit).
- `PERF.md` — measurement protocol + regression budget (carried forward; baseline still at the previous campaign's artifact path).
- `MESSAGE_SHAPES.md` — cross-agent message + completion-notification shapes (carried forward; Wave 2 adds the completion-notification body shape).

Each WAVE.md says explicitly which of these to load.

## What "done" looks like for the campaign

- All 6 waves complete and committed
- `bun typecheck`, `bun lint`, full `bun test` from `packages/opencode/` all pass
- `test/integration/multi-agent-invariants.test.ts` has every invariant from `INTEGRATION_INVARIANTS.md` implemented and green (no `.skip`)
- `artifacts/perf-final-report.md` shows no regression beyond budget on any hot path
- `specs/codex-parity-hardening.md` exists and matches the implementation
- The two-chat-same-project scenario, the spawn-then-wait-immediate-return scenario, and the legacy `task` tool all observably work
