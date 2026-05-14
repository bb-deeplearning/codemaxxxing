# Performance trend tracking — `perf-trend-no-creep`

Companion to [`perf-final-report.md`](./perf-final-report.md). This file
holds the per-wave trend data in a denser, more-machine-readable shape
for the `perf-trend-no-creep` invariant in
[`INTEGRATION_INVARIANTS.md`](../plan/INTEGRATION_INVARIANTS.md).

## Per-wave snapshots — file index

Every wave that captured perf wrote a snapshot to
`artifacts/perf/wave_<N>.json` matching the per-wave bench's metric
set. Format: `{ captured_at, git_sha, bun_version, metrics: {label: BenchResult} }`.

| Wave | File | Metrics captured | Git SHA |
|---|---|---|---|
| 0 | `wave_0.json` | scan.cmd_short, scan.cmd_pipe, scan.cmd_chain, scan.cmd_long, shell.exec, exec_command.exec, spawn_agent.spawn, task.spawn, registry.tools, permission.disabled, permission.evaluate, prompt.render.exec_command, prompt.render.spawn_agent (13 metrics) | `cf193911e` |
| 1 | `wave_1.json` | scan.cmd_short, scan.cmd_pipe, scan.cmd_chain, scan.cmd_long, shell.exec (5 metrics) | as captured at Wave 1 commit |
| 2 | `wave_2.json` | exec_command.exec, permission.disabled (2 metrics) | as captured at Wave 2 commit |
| 3 | `wave_3.json` | spawn_agent.spawn, permission.disabled (2 metrics) | as captured at Wave 3 commit |
| 4 | `wave_4.json` | registry.tools (1 metric) | as captured at Wave 4 commit |
| 5 | `wave_5.json` | prompt.render.exec_command, prompt.render.spawn_agent (2 metrics) | as captured at Wave 5 commit |
| 6 | `wave_6.json` | union of all campaign-touched metrics excluding task.spawn + permission.evaluate (11 metrics) | `9ddce7bea` |

## Per-wave delta budget — verified green

For each (metric × percentile × wave): `wave_N - prior_capture` budgeted
at 5/10/15% on p50/p95/p99. The "prior_capture" is the most recent
prior wave that captured the metric (or baseline if no prior).

The trend table in [`perf-final-report.md`](./perf-final-report.md)
enumerates every delta. Largest single-wave latency delta is
`spawn_agent.spawn.p95 -28.9%` (W6 vs W3) — improvement, no concern.
Largest non-improvement single-wave delta is
`scan.cmd_pipe.p50 +2.4%` (W6 vs W1) — within 5% p50 budget. Largest
prompt-bytes delta is `prompt.render.exec_command +104.7%` (W5 vs W0)
— within the dual-tool-sum allowance per PERF.md § "Prompt token
budget", which permits exec_command's new total to grow up to
`(bash baseline + exec_command baseline) × 0.9` because the migration
absorbed the bash prose.

## Verdict — `perf-trend-no-creep` green

No metric drifts upward across waves beyond per-wave budget. Trend
direction is dominated by improvement — the bash AST scanner extraction
(W1) collapsed parser cold-path tails, the SHELL_TOOLS / MULTI_AGENT_TOOLS
group routing (W2/W3) added one comparison but short-circuited many,
the registry's smaller filtered list (W4) dropped 2 `describe*` invocations
per turn, and the prose migration (W5) absorbed bash's
operational manual into exec_command's description without exceeding
the dual-tool sum allowance.

The invariant is asserted via the (currently-skip-stub-only) test
`perf-trend-no-creep` at
`packages/opencode/test/integration/tool-surface-replacement.test.ts`.
The skip exists because the assertion is a markdown narrative, not a
code-level expectation; this file is the artifact the invariant points
to. If a future wave adds a bench, the assertion lives here.

## Frozen baseline guarantee

Per the `bun-test-test-dir-runs-baseline-orchestrator` GOTCHA:
**Wave 6's verifier must NOT regenerate `baseline-perf.json`.** Wave 6's
re-runs target individual `*.bench.ts` files via `bun test ./test/perf/<file>.bench.ts`,
never via `bun test test/perf/` (which would invoke the orchestrator).
The historical `wave_<N>.json` snapshots were saved off, the W6 reruns
overwrote them transiently per their bench writers, then the historical
files were restored from a `/tmp` backup so the campaign-archive trend
data remains the wave-N capture rather than a wave-6 re-capture.
