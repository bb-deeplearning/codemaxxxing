# Wave 0 — Notes

## Attempt 1 — success

**Session:** ses_1d816765cffetHaX40einkd5VR
**Commit:** (filled post-commit)
**Date:** 2026-05-15
**Decision on entry:** first attempt

### What landed

Three parallel sub-agents (A/B/C). All slices green, all WAVE.md verification gates pass.

**A — fixtures + scanner corpus:**
- 11 permission-config JSON fixtures at `packages/opencode/test/fixtures/permission-configs/`
- `load-config.ts` helper + `load-config.test.ts` (12 pass / 0 fail / 332 expects)
- `generate-corpus.ts` script + `scanner-corpus.json` (50 commands, 8808 bytes, byte-identical re-run)

**B — integration scaffold:**
- `test/integration/tool-surface-replacement.test.ts` — 23 `it.instance.skip` blocks, one per invariant slug from `INTEGRATION_INVARIANTS.md`
- All slugs verbatim. TODO comments name the wave that unskips.
- Suite: 0 pass / 23 skip / 0 fail.

**C — behavioral + perf baselines:**
- `test/snapshots/capture-baseline.ts` (284 lines) → 14 snapshot files at `artifacts/snapshots/`
- `test/perf/baseline.bench.ts` (476 lines after lint cleanup) → `artifacts/baseline-perf.json` + `artifacts/perf/wave_0.json`
- 13 perf metrics captured (4 scan.*, shell.exec, exec_command.exec, task.spawn, spawn_agent.spawn, registry.tools, permission.disabled, permission.evaluate, prompt.render.exec_command, prompt.render.spawn_agent)

### Documented deviations

1. **Token proxy is `description.length` (byte length)** — repo has no project-wide tokenizer wrapper. Used in both snapshot capture (`tool-list-*.json`'s `descriptionTokens` field) AND perf bench (`prompt.render.*.tokens` equals `bytes`). Wave 5's prompt-token budget evaluation should revisit if a real tokenizer lands.

2. **`empty-config.json` uses `{ "permission": {} }`, not `{ "permission": [] }`** as `FIXTURES.md` originally hinted. The `ConfigPermission.Info` schema is an object map (per `packages/opencode/src/config/permission.ts:24-43`), not an array. The `[]` in the doc was a typo; `{}` matches the actual schema.

3. **5 extra commands added to scanner-corpus.json** beyond FIXTURES.md's enumerated samples to reach the 50 target. Additions: `go test ./...`, `ps aux | grep node`, `cargo check ; cargo test`, `touch ./newfile`, `tar -czf out.tar.gz src/`, `curl https://example.com`, `docker ps -a`, `kubectl get pods`, `make build`. Representative cwd-confined and external-net commands.

4. **`task.spawn` perf metric measures pre-spawn ctx.ask + validation overhead** (~31µs p50), NOT a full spawn. To compare cleanly against `spawn_agent.spawn` (which uses `registerRunLoop(() => Effect.never)` to stub inference), the bench throws the sentinel inside `ctx.ask` BEFORE `task.ts:55`'s `agent.get` + `sessions.create` chain. Wave 3 should NOT compare `task.spawn` and `shell.exec` 1-to-1 — they measure different work.

5. **`bash-cd-home.json` snapshot has 1 request, not 2.** Source-of-truth: `shell.ts:402` skips `scan.patterns.add` when `cmd ∈ CWD` (`cd`, `chdir`, etc.). `cd /home/user` produces only the `external_directory` ask, no `bash` ask. The snapshot reflects this correctly. Wave 2's diff target must expect 1 prompt for this command.

6. **`tool-list-*.json` content is nearly identical across agents** because `ToolRegistry.tools(...)` does NOT apply per-agent permission filtering — that's done downstream in `Permission.disabled` consumed by `session/llm.ts:resolveTools`. Only the `describeSpawnAgent` listing varies per agent (build → 5853 chars, explore → 5155 chars). The snapshots show what the registry produces; Wave 4's verification table in `BACKWARD_COMPAT.md` will get accurate diffs after Wave 4 ships per-agent filtering.

7. **`exec-command-git-status.json` uses `pid:<N>` placeholder** — the actual `pid:<n>` always-pattern carries a different number on every run. Substituted via `/^pid:\d+$/` → `pid:<N>` regex before write. Wave 2's diff test must apply the same substitution to its capture before comparing.

8. **`workdir` field in `exec-command-git-status.json` is host-machine-specific** (e.g. `/Users/rohan/...`). Wave 2's diff should compare structure (key presence + non-pid, non-workdir fields) rather than raw equality. Or scrub `workdir` if cross-machine diffability becomes a goal.

### Sharp edges added to GOTCHAS.md

Four new entries (all alphabetical, indexes updated):

- `bench-tool-yield-loses-transitive-deps` (L257) — yielding `ShellTool` directly inside a bench `Effect.gen` leaves `AppFileSystem`/`Pty`/`ChildProcessSpawner` unsatisfied at runtime even though `ToolRegistry.defaultLayer` provides them. Symptom: `Service not found: @opencode/FileSystem`. Fix: route through `ToolRegistry.tools({...})`.
- `effect-v4-catchall-renamed-to-catch` (L498) — `Effect.catchAll` doesn't exist in v4-beta-59; it's `Effect.catch`. `catchAllDefect` → `catchDefect`. `catchAllCause` → `catchCause`.
- `managed-runtime-script-needs-process-exit` (L587) — Bun scripts using `ManagedRuntime.dispose()` hang because background fibers (file watcher, plugin loader, OpenTelemetry exporter) never drain. Add explicit `process.exit(0)` after the script's last work.
- `multi-ask-capture-needs-counter` (L613) — `capture(requests, throwError)` helpers that throw on the first `ctx.ask` truncate multi-ask flows (e.g. `bash` against `rm /tmp/foo` fires external_directory + bash). Gate the throw on a counter (`expectedAskCount`).

Skipped (deemed non-actionable / too trivial / already implicit elsewhere):
- `permission-request-readonly-arrays` — typed `readonly string[]` requires spread before mutation. Trivial type-juggling, not a sharp edge.
- `AppRuntime-runPromise-variance-needs-AppServices-cast` — TS variance with `R` channels narrowing across structurally-equivalent `Service` types. Workaround is the established `as Effect.Effect<A, E, never>` pattern documented in existing `bench-managed-runtime-needs-effect-scoped` GOTCHA.
- Scanner early-return on empty patterns — implicit in the documented `multi-ask-capture-needs-counter` pattern (the `if (no throw fired) ⇒ requests.length === 0` branch).

### Lint warnings in new files

`bun lint` exits 0 with 3068 warnings repo-wide. New files contribute the standard bench-pattern warnings:
- `as Effect.Effect<A, E, never>` casts in `baseline.bench.ts` and `capture-baseline.ts` — same pattern as `agent-control.bench.ts`, accepted convention per `bench-managed-runtime-needs-effect-scoped` GOTCHA.
- One unused-import flagged on `baseline.bench.ts:23` (`AgentPath`) — fixed in-session post-sub-agent.

### Verification

All from `packages/opencode/`:

| Gate | Result |
|---|---|
| `bun typecheck` | exit 0, clean |
| `bun lint` (from repo root) | exit 0, 3068 warnings, 0 errors |
| `bun test test/fixtures/load-config.test.ts` | 12 pass / 0 fail / 332 expects |
| `bun test test/integration/tool-surface-replacement.test.ts` | 0 pass / 23 skip / 0 fail |
| WAVE.md gate `grep -c '^✗'` on integration | 0 |
| `bun test ./test/perf/baseline.bench.ts` | 13 pass / 0 fail |
| Snapshots dir contents | 5 tool-list + 5 permission-prompts + 4 prose = 14 files |
| `baseline-perf.json` exists | yes |
| `perf/wave_0.json` exists | yes |
| `bun run test/fixtures/generate-corpus.ts && git diff --quiet test/fixtures/scanner-corpus.json` | exit 0 (idempotent) |

### Recommendation

Wave 1 (scanner extract) starts from a clean baseline. The differential test at `test/differential/scanner-extract.diff.test.ts` should:

1. Load `scanner-corpus.json` via `loadScannerCorpus()` from `test/fixtures/load-config.ts`.
2. For each entry, run the new `tool/shell/scan.ts` `scanCommand` against `cmd`. Assert resulting `{ patterns, always, dirs }` matches the entry's `expected_*` fields byte-identically.
3. Apply the `pid:<N>` and `workdir` scrubs documented above when comparing permission-prompt snapshots in Wave 2.

Wave 2's `exec-permission.diff.test.ts` should subscribe to `Permission.Event.Asked` via `bus.subscribeCallback` (per `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch` GOTCHA), NOT the top-level `Bus.subscribe` helper.

---
