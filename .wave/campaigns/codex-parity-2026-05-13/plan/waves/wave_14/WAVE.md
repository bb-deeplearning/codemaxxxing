# Wave 14 — End-to-end integration tests + final perf audit

**Prior waves:** 0-13. All implementation done, backward compat verified.

**Also read:** `OVERVIEW.md`, `TDD.md`, `PERF.md`.

## Goal

Walk full multi-agent and persistent-process workflows end-to-end through real services (Effect runtime, real PTYs, real Session), but stub the LLM provider per `PERF.md` § "No live LLM calls in perf — ever". Capture final perf numbers and audit against baseline across every hot path.

This is the wave that catches issues that no individual wave's narrow tests would reveal.

## Tasks

### 1. E2E scenarios

Implement each scenario as a single test under `packages/opencode/test/e2e/`. The stubbed provider follows a scripted decision tree per scenario. Each test asserts:
- correct sequence of events on the bus
- correct final state of the session tree
- no leaked PTYs / fibers / mailbox messages
- timings within reason (not regression-tested per metric, but hard ceilings noted in NOTES.md if a scenario takes >30s wall time)

**Scenarios to cover:**

a. **Parallel explorer fan-out** — Root spawns 3 explorer subagents with distinct questions. All run concurrently. Wall time ≈ max(t1, t2, t3), not sum. Each returns its result via final assistant message. Root composes the three findings.

b. **Worker pipeline** — Root spawns a worker. Worker completes phase-1 work, sends result back via `send_message`. Root spawns a second worker for phase-2, passes phase-1 result via initial message. Verifies sequential delegation with context handoff.

c. **Debate** — Root spawns 2 sibling agents (`worker` role) with opposing scopes. They `followup_task` each other for N=4 rounds. Root reads the final exchange via `wait_agent` + drained mailbox. Verifies cross-sibling messaging works under turn pressure.

d. **Observer pattern** — Root spawns N=3 workers, then `wait_agent`s on the mailbox. As workers complete, observer drains messages, makes a decision, possibly spawns more workers. Verifies the wait/drain cycle.

e. **Persistent REPL** — Use `exec_command tty:true` with `bun -e '<inline repl>'` (a script that reads lines and echoes; or `bun repl` if available). Send 3 sequential `write_stdin` calls preserving state (set a variable, increment it, read it). Verify state persists across calls and the session_id stays valid.

f. **Long-running dev-server attach** — Spawn `bun -e "setInterval(()=>console.log('tick'), 100)"` with `tty:true`. Pure-poll N times with 5-second waits. Verify output streams in, session stays alive, no kill.

g. **Cancellation cascade** — Spawn parent + 2 children + 1 grandchild. Cancel the parent. Verify all 4 fibers terminate; all PTYs they spawned are cleaned up; no orphaned state.

h. **Permission denial** — Configure the agent to have `spawn_agent: deny`. Attempt `spawn_agent`. Verify the model gets a useful error and the session continues.

### 2. Final perf audit

Re-run every bench file across the campaign. Aggregate into a single report:

`.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md`

Format:
- Per-metric: baseline value, current value, delta percent, pass/fail vs budget
- Summary: total metrics, count passed, count failed, list of failures
- Hot-path summary: TUI render, runLoop, Pty push, Permission, EventV2, Bus, Snapshot, Mailbox

If ANY metric exceeds budget, the wave fails. If all pass, the report goes into the spec doc Wave 15 references.

### 3. Concurrent-session perf invariant check

Per `PERF.md` § "Concurrent-session perf invariant":
- 4 sibling sessions running in parallel: total CPU ≤ 1.6× single-session
- Per-sibling LLM stream latency: same as single-session (stubbed provider; what we measure is dispatch overhead)
- Mailbox seq-watch wakeup latency: ≤ 5ms p99 from `send` to `wait_agent` resume

Add a dedicated test for each. Output goes into the final report.

### 4. Memory check

Run a longer-form memory test: spawn 16 concurrent agents each running a stubbed-provider workflow with some bus event volume. Measure resident set size. Cap: 200 MiB per `PERF.md`.

### 5. assertNoNetworkCalls in every E2E test

Every test in `test/e2e/` calls `assertNoNetworkCalls()` (from Wave 0's `stub-provider.ts`). If anything tried to hit the network, the test fails loudly.

## Gotchas

1. **Stubbed provider scripts are the test fixture.** Each scenario needs a believable script of model decisions: what tools to call, in what order, with what params. The script doesn't need to be smart — it just needs to walk the path the test wants to verify.

2. **Hermetic — no system Python, no system Docker, no system anything.** Use `bun -e` for all child-process scenarios. No `python3`, no `psql`, no `redis-cli`. The test must run on a fresh machine with only the repo cloned.

3. **Cancellation tests are flaky if not done right.** When you cancel the parent, race conditions exist between fiber interrupt propagation and resource cleanup. Use `Effect.exit` and explicit `Fiber.await` to confirm everything terminated; don't use `setTimeout` waits.

4. **Final perf report is committed.** It's an artifact of the campaign. Wave 15's spec doc references it.

5. **If a perf budget fails.** Diagnose first. The fix may live in a wave that already shipped — in which case this wave creates a fix commit AGAINST Wave 14 (don't go back and rewrite Wave N's history). Document the regression source and the fix in NOTES.md.

6. **Don't add unit tests in this wave.** This wave is integration + audit. Unit tests live in their respective waves.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test test/e2e/

bun test --coverage test/e2e/  # 100% on the test files themselves; the underlying code is already covered by prior waves

# Final perf report exists and shows zero regressions
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md
bun -e "
  const text = await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md').text()
  if (text.includes('FAIL') || text.match(/❌|failed:/i)) { console.error('perf regressions present'); process.exit(1) }
  console.log('perf OK')
"

# Full campaign suite green
bun test
```

All exit 0.

## Files

New:
- `packages/opencode/test/e2e/parallel-explorers.test.ts`
- `packages/opencode/test/e2e/worker-pipeline.test.ts`
- `packages/opencode/test/e2e/debate.test.ts`
- `packages/opencode/test/e2e/observer.test.ts`
- `packages/opencode/test/e2e/persistent-repl.test.ts`
- `packages/opencode/test/e2e/long-running-server.test.ts`
- `packages/opencode/test/e2e/cancellation-cascade.test.ts`
- `packages/opencode/test/e2e/permission-denial.test.ts`
- `packages/opencode/test/e2e/concurrent-perf-invariants.test.ts`
- `packages/opencode/test/e2e/memory-load.test.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_14.json`

Modified: none expected.
