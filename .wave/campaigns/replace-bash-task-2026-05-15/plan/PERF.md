# Performance — measurement protocol, regression budget, trend tracking

Inherits methodology from `.wave/campaigns/codex-parity-2026-05-13/plan/PERF.md` and `.wave/campaigns/codex-parity-hardening-2026-05-14/plan/PERF.md`. This campaign adds **trend tracking** (per-wave deltas plotted against the campaign's frozen pre-replacement baseline so we catch slow drift) and a **prompt-token-count budget** (Wave 5 prose migration must not balloon model context).

## Hot paths this campaign touches

1. **`tool/shell.ts` permission scan** (Wave 1 → moves to `tool/shell/scan.ts`). AST parse + walk + `BashArity.prefix` derivation. Runs once per shell tool call today; runs once per `exec_command` call after Wave 2.
2. **`tool/process/exec-command.ts` execute** (Wave 2). Now includes the AST scan. Per-call cost rises by parse + scan time.
3. **`tool/process/write-stdin.ts` permission lookup** (Wave 2). Permission key changes from `exec_command` to `bash`; lookup time changes only if rules-list shape changes.
4. **`tool/registry.ts:341` `tools()`** (Wave 4). Filters builtin list per agent. Dropping legacy IDs reduces list size; adding plugin-bridge dispatch increases per-tool work. Net delta unknown — measure.
5. **`session/llm.ts:450` `resolveTools`** (Wave 2/3). Adds SHELL_TOOLS + MULTI_AGENT_TOOLS group handling. Hot — runs every turn.
6. **`permission/index.ts:309` `disabled`** (Wave 2/3). Adds two more category mappings. Constant-factor bigger; runs once per turn.
7. **Prompt rendering** (Wave 5). Prose migration changes the byte length of multiple tool descriptions. Token count budget applies here.

## Baseline (FROZEN — established Wave 0)

Path: `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json`

Captured at Wave 0's commit SHA. This file is FROZEN. Per GOTCHA `bun-test-test-dir-runs-baseline-orchestrator`: do NOT run `bun test test/` for spot-checks (it will silently rerun the orchestrator and overwrite the baseline). Run per-area instead. If accidentally regenerated, restore via `git checkout .wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json`.

Required metrics in baseline:

| Metric | Op |
|---|---|
| `scan.cmd_short` | `scanCommand("git status")` end-to-end |
| `scan.cmd_pipe` | `scanCommand("git status \| grep foo")` end-to-end |
| `scan.cmd_chain` | `scanCommand("npm test && npm run build")` end-to-end |
| `scan.cmd_long` | `scanCommand("...")` 200-char input |
| `shell.exec` | `bash` tool exec end-to-end against `bun -e "process.exit(0)"` |
| `exec_command.exec` | `exec_command` exec end-to-end against `bun -e "process.exit(0)"` |
| `task.spawn` | legacy `task` tool spawn end-to-end |
| `spawn_agent.spawn` | v2 `spawn_agent` end-to-end |
| `registry.tools` | `tools(model)` filtered list construction |
| `permission.disabled` | `disabled(toolIds, ruleset)` over a 50-rule ruleset |
| `permission.evaluate` | `evaluate(perm, pattern, ruleset)` over a 50-rule ruleset |
| `prompt.render.exec_command` | rendered `exec_command` description byte length + token count |
| `prompt.render.spawn_agent` | rendered `spawn_agent` description byte length + token count |

Format: `{ p50, p95, p99, samples, op }` in nanoseconds. Plus `{ tokens, bytes }` for prompt metrics.

## Per-wave perf

Each wave that touches a hot path:

1. Adds (or extends) `packages/opencode/test/perf/<area>.bench.ts`.
2. Outputs JSON to `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_<N>.json`.
3. Compares against the frozen baseline.
4. Computes the per-wave delta versus the previous wave's snapshot for trend tracking.

The trend table aggregates into `artifacts/perf-trend.md` (Wave 6 builds the final report).

## Regression budget

**5/10/15 % on p50/p95/p99** vs baseline. Per metric, per wave.

If a metric exceeds the budget on ANY of p50/p95/p99, the wave fails. Surface as USER QUESTION with the regression details if you genuinely cannot stay under budget.

If `post < baseline`, ratio is negative — improvement, no concern.

## Prompt token budget

Wave 5 migrates prose from `shell.txt` → `exec_command.txt` and `task.txt` → `spawn_agent.txt`.

Budget: **±5%** on `prompt.render.exec_command.tokens` AND `prompt.render.spawn_agent.tokens` versus the baseline captures of `bash`'s and `task`'s rendered descriptions. The point: model context is precious; we don't get to silently grow descriptions in the migration.

If a description must legitimately grow (e.g., it inherits the git-safety section that wasn't there before), the new total may exceed +5% of the new tool's pre-migration baseline AS LONG AS it does not exceed the SUM of the old (`bash` + `exec_command`) baselines minus a 10% redundancy assumption. Document in NOTES with the actual numbers.

## Memory budget

Per the previous campaigns: **200 MiB RSS** hard limit per bench. Exceeding fails the wave.

Specific concerns:
- Tree-sitter WASM modules add ~2 MiB once-loaded. Per-call should not allocate.
- Concurrent stress tests (Wave 1 N=64, Wave 2 N=32) must not retain per-call memory beyond the call duration.

## No live LLM calls — ever

Per all prior campaigns: `stubProvider` for any test or bench that goes through the model. Reasons unchanged: live latency is dominated by network, costs API budget for zero signal, is non-deterministic.

## Bench harness

Use the existing harness at `packages/opencode/test/lib/perf.ts`:

```ts
import { bench, compareToBaseline } from "@opencode/test/lib/perf"

await bench("scan.cmd_short", { samples: 1000, warmup: 100 }, async () => {
  yield* ShellScan.scanCommand({ command: "git status", shell: bashShell, cwd, instance })
})

const report = compareToBaseline(
  ".wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json",
)
expect(report.regressions).toEqual([])
```

Bench files use the embedded `test()` + `afterAll` writer pattern (per GOTCHA `bench-file-pattern-split`). Run via `bun test ./test/perf/<wave>.bench.ts` (with `./` prefix per `bun-test-bench-file-path` GOTCHA).

For benches needing an Instance binding: wrap with `Effect.scoped(provideTmpdirInstance(...))` per GOTCHA `bench-managed-runtime-needs-effect-scoped`.

For benches comparing against the wave_0 single-shot baseline algorithm: follow the methodology in GOTCHA `runloop-bench-vs-baseline-methodology-mismatch` — match the per-sample structure or treat the comparison as a sanity check, not a strict bound.

For TUI / noisy benches: apply the best-of-N pattern from GOTCHA `opentui-render-bench-noise-needs-best-of-n`.

## What "no regression" means in practice

For each metric the wave touches:

- `(post.p50 - baseline.p50) / baseline.p50 ≤ 0.05`
- `(post.p95 - baseline.p95) / baseline.p95 ≤ 0.10`
- `(post.p99 - baseline.p99) / baseline.p99 ≤ 0.15`

If a wave's metric is suspiciously fast (e.g. -50%), apply the methodology audit from `runloop-bench-vs-baseline-methodology-mismatch` — verify the per-sample structure matches before claiming a speedup.

## Per-wave perf expectations

### Wave 0
Captures baseline. No comparison; just records numbers. Output: `artifacts/baseline-perf.json` + `artifacts/perf/wave_0.json` (identical content, separate files).

### Wave 1 (scanner extract)
Pure refactor. The scan operations move from `shell.ts` into `tool/shell/scan.ts` with no behavior change. All `scan.*` metrics should be within ±2% of baseline (essentially identical). All `shell.exec` metrics within ±2%.

If the extracted module shows a >2% delta, something about the call-site overhead changed — investigate and fix or surface as USER QUESTION.

### Wave 2 (exec_command wire)
Adds the scan to every `exec_command` call. `exec_command.exec` p50 will rise by the scan cost. Budget: 5% p50, 10% p95, 15% p99.

The scan cost itself (~50-200µs depending on input size) is small relative to PTY allocation (~ms). But the scan IS new work in the hot path; track the delta.

### Wave 3 (spawn_agent wire)
The mapping change is permission-key-only (no new computation in the hot path). `spawn_agent.spawn` should be within ±2%. `permission.disabled` may rise by one comparison (constant); within budget.

### Wave 4 (registry drop + plugin bridge)
Two opposing forces: filtered list is shorter (faster), plugin bridge dispatches twice for legacy IDs (slower per call). Net should be within ±5% on `registry.tools`. If +bridge dominates, optimize.

### Wave 5 (prose migration)
Adds the prompt-token budget on top of the standard latency budget. `prompt.render.exec_command.tokens` and `prompt.render.spawn_agent.tokens` within ±5% of (their respective tool's pre-migration baseline + the legacy tool's contribution where applicable). See "Prompt token budget" above for the inherited-content allowance.

### Wave 6 (final)
No production change; aggregates and reports. Re-runs every metric, emits final delta table at `artifacts/perf-final-report.md`. Asserts every metric green.
