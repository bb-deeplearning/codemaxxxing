# Wave 6 — Notes

## Attempt 1 — success

**Session:** ses_1d73a96ffffegAtNmwPYklYmW7
**Commit:** (filled in by next session via record-commit-SHA pass)
**Date:** 2026-05-15
**Decision on entry:** first attempt

### What landed

Final wave. No production code change. Three deliverables shipped:

1. **Full BC re-run** — every fixture × every invocation tuple in
   `BACKWARD_COMPAT.md` aggregated to `artifacts/bc-verification.md`.
   33/33 cells green across 6 categories (bash key, task key, pid:N
   rule, external_directory, plugin hooks, snapshot diffs).
2. **Perf aggregate** — re-ran all 5 campaign-touched bench files
   (scan, exec-command, spawn-agent, registry-tools, prompt-render).
   Captured 11 metrics into `artifacts/perf/wave_6.json`. Built the
   per-wave trend table at `artifacts/perf-final-report.md` plus a
   companion `artifacts/perf-trend.md` for the `perf-trend-no-creep`
   invariant. Every metric within 5/10/15% budget vs frozen baseline;
   most show net improvement.
3. **Spec doc + ship** — `specs/replace-bash-task.md` (~440 lines,
   voice matches `specs/codex-parity.md` + `specs/codex-parity-hardening.md`).
   Repo-root `CHANGES.md` created with the campaign entry (no prior
   CHANGES file existed).

**New files:**

- `specs/replace-bash-task.md` — the campaign's narrative spec doc.
- `CHANGES.md` (repo root) — first CHANGES entry; no prior file existed.
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-final-report.md`
  — per-metric trend table + verdict.
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf-trend.md`
  — `perf-trend-no-creep` evidence companion.
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/bc-verification.md`
  — 33-row BC matrix verification table.
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_6.json`
  — Wave 6 fresh re-capture of 11 metrics.
- `.wave/campaigns/replace-bash-task-2026-05-15/waves/wave_6/NOTES.md`
  — this file.

**Modified files:**

- `packages/opencode/test/perf/scan.bench.ts` — added a
  `ShellTool.init()` fallback in the `toolDef` helper for `bash`
  lookups. Wave 4 dropped `bash` from the registry's model-facing
  builtin array, which broke the Wave 1 bench's `registry.tools(...)`-
  based `bash` retrieval. Test infrastructure only — no production
  code change. Methodology delta vs the wave_1.json snapshot: skips
  the registry's `Plugin.trigger("tool.definition")` wrapper around
  the def. Same `execute` fn underneath; numbers comparable. Added
  `AppFileSystem.defaultLayer`, `Bus.layer`, `Plugin.defaultLayer`
  to the bench layer to satisfy `ShellTool`'s direct yield (these
  are provided transitively by ToolRegistry.defaultLayer when going
  through registry.tools(); explicit at the top level when yielding
  the tool service directly).
- `.wave/campaigns/replace-bash-task-2026-05-15/STATE.md` — Wave 6
  marked complete, `wave_status: all_complete`, `current_wave: 7`,
  `session_count: 7`, `retry_count: 0`. Wave 6 row updated with
  commit SHA + notes.

### Verification gate (per WAVE.md "Verification" block)

All from `packages/opencode/`:

| Gate | Result |
|---|---|
| `bun typecheck` | exit 0, clean |
| `bun lint` (from repo root) | exit 0, 3094 warnings (was 3081 in W2 baseline + 13 from new test file `legacy-internal-runnable.test.ts` + new `plugin-bridge.test.ts` + 2 imports added in scan.bench.ts), 0 errors |
| `bun test test/integration/tool-surface-replacement.test.ts` | 23 pass / 2 skip / 0 fail (the 2 skips are the wave 6 narrative invariants; their evidence lives in the artifacts) |
| `bun test test/integration/plugin-bridge.test.ts test/integration/legacy-internal-runnable.test.ts` | 6 pass / 0 fail |
| `bun test test/integration/` (full integration suite) | 49 pass / 2 skip / 0 fail (3 reruns confirmed pty-cleanup-on-parent-abort flake passes in isolation; documented in codex-parity-hardening.md) |
| `bun test test/differential/` | 10 pass / 0 fail (4 differential test files) |
| `bun test src/tool/shell src/tool/process src/tool/agent-* src/tool/task.test.ts src/tool/registry.test.ts` | 298 pass / 0 fail (17 files) |
| `bun test src/permission/` | 36 pass / 0 fail |
| `bun test test/tool/shell.test.ts` | full suite green |
| `bun test --timeout 30000` (team standard) | 3437 pass / 15 skip / 3 todo / 4 fail. The 4 failures are pre-existing (verified by running each at HEAD-prior-to-wave-6: same failures present). See § "Pre-existing test failures" below. |
| `bun test ./test/perf/scan.bench.ts` | 5 pass / 0 fail |
| `bun test ./test/perf/exec-command.bench.ts` | 2 pass / 0 fail (best-of-8 lands within budget; ~70% pass rate documented since Wave 2 NOTES) |
| `bun test ./test/perf/spawn-agent.bench.ts` | 2 pass / 0 fail |
| `bun test ./test/perf/registry-tools.bench.ts` | 1 pass / 0 fail |
| `bun test ./test/perf/prompt-render.bench.ts` | 2 pass / 0 fail |
| `git diff --quiet artifacts/baseline-perf.json` | exit 0 (frozen baseline untouched) |
| `git diff --quiet artifacts/perf/wave_{0,1,2,3,4,5}.json` | exit 0 (historical snapshots restored from /tmp backup after the W6 re-runs overwrote them) |
| `test -f specs/replace-bash-task.md` | exit 0 |
| `test -f artifacts/perf-final-report.md` | exit 0 |
| `test -f artifacts/bc-verification.md` | exit 0 |
| `test -f artifacts/perf-trend.md` | exit 0 |
| `rg "replace-bash-task" CHANGES.md` | match found (repo-root CHANGES.md, first file in repo with this name) |

### Pre-existing test failures (unrelated to this campaign)

WAVE.md gotcha 4 says: "Pre-existing test suite includes flakes…
Re-running here should NOT block — confirm against the GOTCHAS.md
list and document in NOTES.md if encountered."

Verified each failure exists with this campaign's changes stashed
(`git stash` before re-run). All confirmed pre-existing, no
regression caused by replace-bash-task:

1. **`test/server/httpapi-bridge.test.ts > covers every generated
   OpenAPI route with Effect HttpApi contracts`** — new `/wave/*` HTTP
   routes (the wave subsystem agent loop infra) are present in Hono
   but not yet mirrored in Effect HttpApi contracts. Unrelated to
   bash/task replacement; will resolve when the wave HttpApi mirror
   lands in a separate piece of work.
2. **`test/storage/db.test.ts > Database.Path > returns database path
   for the current channel`** — environment-dependent (test machine
   has `InstallationChannel = "local"` which produces
   `opencode-local.db`; assertion expects `opencode.db`). Unrelated.
3. **`test/session/compaction.test.ts > falls back to full summary
   when retained tail media exceeds preserve token budget`** —
   `tail_start_id` assertion. Unrelated to bash/task replacement.
4. **`test/integration/multi-agent-invariants.test.ts >
   pty-cleanup-on-parent-abort`** — known suite-pollution flake from
   the codex-parity-hardening campaign (its spec doc § "Performance"
   already documents a related sibling pattern). Passes in isolation
   3/3 reruns; passes in the full integration suite 2/2 reruns
   without the broader `bun test` invocation noise. The full
   `bun test --timeout 30000` invocation that triggers this flake
   includes 273 test files; suite ordering + shared resource
   pressure produces a transient false-fail.

### Documented deviations

1. **`scan.bench.ts` test-infrastructure fix.** Wave 4 dropped `bash`
   from `registry.tools(...)`'s output. The Wave 1 bench's `toolDef`
   helper retrieved `bash` via that path — broke at Wave 6's re-run.
   Added a `yield* ShellTool` direct-import fallback when the registry
   lookup misses for `bash`. This is test infrastructure, not
   production code. Wave 4 should arguably have caught this (it
   modified registry.ts but didn't re-run scan.bench.ts which it
   wasn't in scope for); Wave 6 catches and fixes. The wave_1.json
   historical snapshot is preserved (restored from /tmp backup after
   the W6 re-run overwrote its file path); the W6 fresh capture lives
   in wave_6.json.

2. **Wave 6 fresh perf capture writes to `wave_6.json` (a new file).**
   The campaign protocol writes per-wave snapshots to `wave_<N>.json`,
   one per wave. Wave 6 re-ran every campaign-touched bench and
   merged the captures into a unified `wave_6.json`. The bench files
   themselves still write to their per-wave path (e.g.
   `scan.bench.ts` writes `wave_1.json`); the orchestration steps:
   - Backed up `wave_{1,2,3,4,5}.json` to `/tmp/wave6-perf-backup/`
   - Ran each bench (which overwrote its respective `wave_N.json`)
   - Copied the freshly-overwritten file to `/tmp/wave6-rerun-<area>.json`
   - Restored the original `wave_{1,2,3,4,5}.json` from backup
   - Merged the 5 rerun captures into `wave_6.json` via `jq -s`
   This preserves the historical wave-N snapshots (which were
   captured at their wave-N commit) AND records a fresh wave-6
   "Final" capture for the trend table.

3. **Two narrative invariants stay as `it.instance.skip` stubs.** The
   `bc-matrix-fully-green` and `perf-trend-no-creep` invariants in
   `tool-surface-replacement.test.ts:1352-1364` are documentation-
   anchored (the assertion is "the markdown artifacts pass review"
   not "this code expression returns truthy"). The skip stubs exist
   so the slug names are still grep-discoverable in the test file;
   their actual evidence lives at `artifacts/bc-verification.md` and
   `artifacts/perf-final-report.md` + `artifacts/perf-trend.md`.

4. **No `task.spawn` or `permission.evaluate` re-capture.** Per Wave 0
   NOTES item 4, `task.spawn` measures pre-spawn ctx.ask + validation
   overhead, not full spawn — quirky measurement, not comparable to
   spawn_agent.spawn. Per Wave 2 NOTES item 3, `permission.evaluate`
   is unchanged across the campaign; re-capture would be pure system
   noise. Both intentionally excluded from the W6 fresh capture; the
   frozen baseline still pins their numbers.

5. **`prompt.render.spawn_agent` shows 0% delta vs Wave 0 baseline**
   despite Wave 5 NOTES describing a 5811-vs-5883 cross-environment
   gap. The Wave 6 re-capture (5811 bytes) exactly matches the Wave
   0 baseline-perf bench capture (5811 bytes) because both were
   measured in the clean Bun test environment. The 5883-byte snapshot
   in `artifacts/snapshots/prompt-prose/spawn-agent-description.txt`
   was captured by the Wave 0 `capture-baseline.ts` script which
   includes the `docs` agent in the per-subagent listing (present on
   the executor's machine but not in clean test instances). Both
   shapes are documented in Wave 5 NOTES § "Token budget".

### Mutation probe

Skipped per WAVE.md "Test pyramid quota for Wave 6" → "Unit: 0 (no
production change)." Wave 6 is purely verification + documentation;
no code logic to mutate. The mutation probes from Waves 1-5 have
already exercised the production code paths.

### Coverage status

Wave 6 adds no production code. Test infrastructure additions:

- `scan.bench.ts` toolDef fallback — exercised by the bench re-runs.
- New artifact files (markdown, json) — n/a.
- Spec doc + CHANGES.md — n/a.

The campaign rule "100% line coverage on every file added or modified"
applies to `scan.bench.ts`'s 4 modified lines (the 3-line fallback +
the 3 new imports + the 3 new layer.mergeAll entries). All exercised
when the bench runs.

### Sharp edges

No new GOTCHA-worthy sharp edges discovered during Wave 6. The two
incidents that took >10 minutes:

1. **`bun test test/perf/` would have re-run baseline.bench.ts** and
   overwritten `baseline-perf.json` per the documented
   `bun-test-test-dir-runs-baseline-orchestrator` GOTCHA. Avoided by
   running each bench file with `./test/perf/<file>.bench.ts` per
   the per-wave protocol. Not a new sharp edge — already covered.
2. **The `bun test --timeout 30000` invocation early in Wave 6
   transiently overwrote codex-parity baseline files** at
   `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`
   etc. Same root cause as #1 (full-tree `bun test` invokes the
   codex-parity orchestrator too). Restored via `git checkout`.
   Could be a NEW sharp edge worth documenting — but it's a strict
   subset of the already-documented `bun-test-test-dir-runs-baseline-orchestrator`.
   Skipped (deemed "addendum to existing GOTCHA, not new" per
   the same standard Wave 0 used for similar judgment calls).

### Recommendation

Campaign complete. Wave 6 is the final wave (`total_waves: 7` in
STATE.md, 0-indexed → waves 0..6). After this commit:

- `wave_status: all_complete`
- `current_wave: 7`
- The next session that polls STATE.md will see `WAVES DONE` per the
  AGENT_INSTRUCTIONS.md start-here checkpoint and stop.

For the merge-to-`dev` decision:

- The `codex-parity` branch now carries 3 campaigns: codex-parity (16
  waves), codex-parity-hardening (6 waves), and replace-bash-task (7
  waves). 29 waves + their record-commit-SHA passes total (~50
  commits).
- The branch is ahead of `origin/codex-parity` by 14 commits
  (this campaign's local-only commits). Origin push is gated on user
  decision per AGENT_INSTRUCTIONS.md "NEVER push" rule.
- Merge-to-`dev` is a separate decision — campaigns ship to the
  campaign branch first; the user controls the merge cadence.

---
