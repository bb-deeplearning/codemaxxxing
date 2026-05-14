# Wave 4 — Backward compat verification + perf audit

<!--
Previous waves:
- wave_0 — integration test scaffolding + bug 3 audit
- wave_1 — per-root scoping
- wave_2 — completion watcher
- wave_3 — audit pass

Also read:
- ../../INTEGRATION_INVARIANTS.md (focus on legacy-task-tool-coexists-with-v2)
- ../../GOTCHAS.md (CRITICAL: bun-test-test-dir-runs-baseline-orchestrator — DO NOT regenerate baseline; e2e-perf-sibling-fanout-needs-median-of-n for the e2e perf check)
- ../../STYLE.md, TDD.md, BACKWARD_COMPAT.md, PERF.md
- .wave/campaigns/codex-parity-2026-05-13/plan/BACKWARD_COMPAT.md (full version)
-->

## Goal

Verify the campaign doesn't break anything. Run the full pre-existing test suite, run the legacy task tool integration test, run every perf bench against the frozen baseline, produce a final perf report.

## Tasks

### Sub-agent A — `legacy-task-tool-coexists-with-v2` integration test

Single agent, sequential. Unskip and implement the test in `multi-agent-invariants.test.ts`. The test:

- Use the existing `Layer.mergeAll(...)` layer that includes `Agent.defaultLayer`, `AgentControl.defaultLayer`, `Session.defaultLayer`, and `ToolRegistry.defaultLayer`.
- Use `installNeverLoop` to keep AgentControl-spawned children alive (in case any are spawned mid-test).
- Create a root session A.
- Create a SECOND root session B (separate from A).
- From root A: simulate a `task` tool call with `description: "audit"`, `prompt: "find foo"`, `subagent_type: "explore"`. The task tool's `execute` requires a `promptOps` in `ctx.extra`. Build a minimal stub:
  ```ts
  const promptOps = {
    cancel: () => {},
    resolvePromptParts: (template: string) => Effect.succeed([{ type: "text", text: template, ... }]),
    prompt: (input) => Effect.succeed({
      info: { ... },
      parts: [{ type: "text", text: "task complete: found foo" }],
    } as never),
  }
  ```
  See `tool/task.ts:11-15` for the `TaskPromptOps` interface and `tool/task.ts:128-170` for the call shape.
- Call `taskTool.execute({ description: "audit", prompt: "find foo", subagent_type: "explore" }, ctxA)` where `ctxA.sessionID = rootA.id` and `ctxA.extra.promptOps = promptOps`.
- Assert: the result is the `<task_result>` envelope shape (`output` contains `"<task_result>"` and `"</task_result>"` and the inner text matches `"task complete: found foo"`).
- Assert: the legacy task path created a child session (visible via `Session.Service.children(rootA.id)`).
- Assert: root B is unaffected (`listAgents(rootB)` returns just root B itself, no leakage).

This test asserts the legacy task tool's coexistence with the v2 multi-agent path after Wave 1's per-root refactor. If it fails, the refactor broke the legacy path — fix.

### Sub-agent B — full pre-existing test suite

Single agent, sequential, AFTER Sub-agent A. Run the full pre-existing test suite from `packages/opencode/`:

```bash
cd packages/opencode
bun test 2>&1 | tee /tmp/wave4-test-output.log
```

CRITICAL: do NOT use `bun test test/` (path filter) — that would re-run the baseline orchestrator and overwrite the frozen baseline. Use `bun test` with no path argument (lets bun discover all `*.test.ts` files in `src/` and `test/` per its config).

Wait, actually — the previous campaign's GOTCHA `bun-test-test-dir-runs-baseline-orchestrator` says `bun test test/` reruns the orchestrator. The bare `bun test` from `packages/opencode/` ALSO discovers everything in `test/` including the baseline orchestrator. Verify by checking `packages/opencode/bunfig.toml` (or equivalent test config) to see how test discovery is configured.

If the bare `bun test` reruns the orchestrator, run instead:

```bash
bun test src/                                                    # everything in src/
bun test ./test/integration/                                      # integration suite
bun test ./test/e2e/                                              # e2e suite
bun test ./test/backward-compat/                                   # backward-compat suite
# DO NOT run: bun test test/perf/  (would rerun the baseline orchestrator)
```

After running, check the baseline file is unchanged:

```bash
git diff .wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json
# Expected: empty diff. If non-empty, the baseline was overwritten — restore:
# git checkout .wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json
```

Failures in pre-existing tests fall into three categories:

1. **Pre-existing failures unrelated to this campaign.** The previous campaign's wave 13 NOTES.md documented 4 such failures on the `codemaxxxing` branch. These don't gate this wave — record their identity in this wave's NOTES.md and continue.
2. **Failures caused by Wave 1 / 2 / 3 changes.** These DO gate this wave. Investigate and fix in this wave (the wave's purpose is to keep them from shipping).
3. **Flaky tests.** Re-run failing tests in isolation. If they pass alone but fail in the suite, document and continue.

### Sub-agent C — perf audit

Single agent, sequential, AFTER Sub-agent B. Run every perf bench file this campaign added or that the previous campaign relied on:

```bash
cd packages/opencode

# Wave 1's bench (if added):
bun test ./test/perf/agent-control.bench.ts

# Wave 2's bench (if added):
bun test ./test/perf/<wave2-bench-file>.bench.ts

# Plus the prior campaign's e2e perf invariants — confirm they still pass:
bun test ./test/e2e/concurrent-perf-invariants.test.ts
```

Each bench writes JSON to `.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf/wave_<N>.json`.

Aggregate the results into `.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf-final-report.md`. Format mirrors the previous campaign's `perf-final-report.md` (read it for the shape):

```markdown
# Perf final report — codex-parity-hardening

## Methodology

(Same as previous campaign — one paragraph reference.)

## Baseline reference

`.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` (frozen at commit 18369b2a8).

## Wave-by-wave deltas

### Wave 1 — per-root scoping (commit <SHA>)

| Metric | Baseline p50 | Wave 1 p50 | Δ | Budget | Status |
|---|---|---|---|---|---|
| agent_control.spawn | 403µs | <measured> | <delta> | 5% | OK / OVER |
| agent_control.send | 17µs | <measured> | <delta> | 5% | OK / OVER |
| agent_control.list(16) | 12µs | <measured> | <delta> | 5% | OK / OVER |

(p95 / p99 columns similarly.)

### Wave 2 — completion watcher (commit <SHA>)

(Same shape.)

## Concurrent-session perf invariants

(From the prior campaign's e2e perf invariants test — run again, report ratio.)

## Summary

All metrics within budget: <yes / no with details>.
```

If any metric regresses beyond budget, the wave fails. Surface as USER QUESTION with the regression details — the user decides whether to revisit Wave 1 or 2 or to accept the regression with documented justification.

## Gotchas

1. **`bun-test-test-dir-runs-baseline-orchestrator`** — DO NOT run `bun test test/`. The baseline orchestrator rewrites the frozen baseline. If you accidentally regenerate it, restore via `git checkout`.

2. **Pre-existing failures are not regressions.** The previous campaign documented 4 pre-existing failures. Identify them by running `bun test` once and comparing failure list to the prior campaign's wave_13 NOTES.md. Anything in that list is fine; anything else is a regression this wave caused.

3. **`e2e-perf-sibling-fanout-needs-median-of-n`** — the e2e concurrent-perf-invariants test uses median-of-5 to suppress noise. If it flakes despite the median, re-run it 3 times and report the median of medians. Flaking on a noisy machine isn't a wave-failing regression.

4. **Legacy task tool's `promptOps` is REQUIRED in ctx.extra.** Per `tool/task.ts:119-120`, the absence of `promptOps` causes `Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))`. The integration test must build a minimal stub. Without it, the test trivially fails for an irrelevant reason.

5. **Wave 4 may not need to touch production code at all.** If everything passes, this is a verification-only wave. Commit the final perf report and the legacy-task integration test; that's the wave's deliverable. If a regression surfaces, this wave fixes it; do NOT push the fix to a separate wave.

## Verification

```bash
cd packages/opencode

# 1. Typecheck — zero errors.
bun typecheck

# 2. Lint — zero errors.
bun lint

# 3. Full pre-existing test suite passes (modulo documented pre-existing fails).
bun test src/
bun test ./test/integration/
bun test ./test/e2e/
bun test ./test/backward-compat/

# 4. Multi-agent invariants all green (every test in the file, no skips remain
#    that should have been unskipped).
bun test ./test/integration/multi-agent-invariants.test.ts

# 5. Perf benches within budget.
bun test ./test/perf/agent-control.bench.ts

# 6. Baseline file unchanged.
git diff --exit-code .wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json

# 7. Final perf report exists and is non-empty.
test -s .wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf-final-report.md
```

If all of the above pass, the wave is complete.
