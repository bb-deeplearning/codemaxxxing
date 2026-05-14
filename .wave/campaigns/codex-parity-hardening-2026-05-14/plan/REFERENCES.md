# References — file paths the campaign cares about

Absolute paths so sub-agents don't have to derive them. `<repo>` shorthand: `/Users/rohan/Documents/Personal/codemaxxxing`.

## Read-only canonical reference

- Codex source tree (READ-ONLY, never modify): `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/`
  - `codex-rs/core/src/agent/control.rs` — codex's AgentControl. Key sections:
    - lines 130-136: "An AgentControl instance is intended to be created at most once per root thread/session tree" — the invariant Bug 1 violates.
    - lines 943-1015: `maybe_start_completion_watcher` — codex's solution to Bug 2.
    - lines 751-761: `shutdown_agent_tree` — descendants cascade.
    - lines 1217-1229: `agent_matches_prefix` — already mirrored in opencode.
  - `codex-rs/core/src/agent/status.rs` — `agent_status_from_event`, `is_final` (already mirrored in `agent/status.ts`).
  - `codex-rs/protocol/src/agent_path.rs` — already mirrored in `agent/agent-path.ts`.
  - `codex-rs/protocol/src/protocol.rs` — `InterAgentCommunication`, `AgentStatus` (already mirrored).

## Code under change in this campaign

### Always-touched

- `<repo>/packages/opencode/src/agent/control.ts` — Bugs 1 + 2 land here.
- `<repo>/packages/opencode/src/agent/control.test.ts` — primitive-level tests; Wave 1 + 2 add multi-root + completion-watcher unit tests here.
- `<repo>/packages/opencode/test/integration/multi-agent-invariants.test.ts` — created in Wave 0 (DOES NOT EXIST YET); every invariant lands here as `it.instance` tests.

### Touched only when relevant

- `<repo>/packages/opencode/src/tool/agent-wait/agent-wait.ts` — Bug 2's symptom surface. Wave 2 may not need to modify it (the fix is in `control.ts`'s spawn path), but Wave 2's integration test exercises it end-to-end.
- `<repo>/packages/opencode/src/tool/agent-wait/agent-wait.txt` — prompt prose. If the fix changes user-visible behavior, update the prose; otherwise leave alone.
- `<repo>/packages/opencode/src/agent/mailbox.ts` — read-only for Wave 2 (the watcher reuses the existing `send`).
- `<repo>/packages/opencode/src/agent/agent-path.ts` — read-only.
- `<repo>/packages/opencode/src/agent/inter-agent-communication.ts` — read-only.
- `<repo>/packages/opencode/src/agent/registry.ts` — Wave 1 may need to scope `liveAgents`-style queries by root. Read carefully.
- `<repo>/packages/opencode/src/agent/status.ts` — read-only. Use `AgentStatus.isFinal` for the watcher.
- `<repo>/packages/opencode/src/session/session.ts` — read-only. `Event.Deleted` (line 323) is what Wave 1's per-root subscriber listens to.
- `<repo>/packages/opencode/src/tool/task.ts` — read-only. Backward-compat asserts this still works.
- `<repo>/packages/opencode/src/tool/registry.ts` — read-only for Wave 0 audit (`describeSpawnAgent` already exists).
- `<repo>/packages/opencode/src/tool/agent-spawn/agent-spawn.ts` — read-only for Wave 0 audit (already validates `agent_type`).

### Tests to keep green (non-regression)

- `<repo>/packages/opencode/src/agent/control.test.ts` (existing 80+ tests)
- `<repo>/packages/opencode/src/agent/mailbox.test.ts`
- `<repo>/packages/opencode/src/agent/registry.test.ts`
- `<repo>/packages/opencode/test/integration/multi-agent-tools.test.ts` (existing wave 8 integration walk)
- `<repo>/packages/opencode/test/e2e/concurrent-perf-invariants.test.ts` (existing wave 14)
- Every existing test in `packages/opencode/test/{e2e,integration,backward-compat}/`

## Test infrastructure

- `<repo>/packages/opencode/test/lib/effect.ts` — `testEffect`, `it.instance`, `it.live`. Use `it.instance` for multi-agent integration tests so each test gets its own scoped tmpdir + Instance binding.
- `<repo>/packages/opencode/test/fixture/fixture.ts` — `tmpdir`, `provideTmpdirInstance`, `withTmpdirInstance`, `disposeAllInstances`. The `disposeAllInstances` helper in `afterEach` is critical for multi-instance tests.
- `<repo>/packages/opencode/test/lib/stub-provider.ts` — LLM stub. NEVER use a real provider in this campaign's tests.
- `<repo>/packages/opencode/test/lib/perf.ts` — bench harness. `bench(...)`, `compareToBaseline(...)`.
- `<repo>/packages/opencode/test/lib/CAMPAIGN_TESTING.md` — patterns the previous campaign settled on.

## Previous campaign reference docs (still authoritative)

The previous campaign at `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/` shipped reference docs that this campaign carries forward. The carry-forward copies in THIS campaign's `plan/` (STYLE.md, TDD.md, BACKWARD_COMPAT.md, PERF.md, MESSAGE_SHAPES.md) are edited for this campaign's narrower scope. When a wave needs the deeper context behind a rule, consult the previous campaign's original:

- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/STYLE.md` — full style guide.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/TDD.md` — full TDD protocol.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/BACKWARD_COMPAT.md` — full backward-compat list.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/PERF.md` — full perf protocol; baseline JSON path.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md` — full cross-agent message shape decisions.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/GOTCHAS.md` — every gotcha discovered by the previous campaign. THIS campaign's GOTCHAS.md inherits each entry verbatim and adds new ones at the bottom.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/CONSTANTS.md` — verbatim numeric constants from codex.
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/REFERENCES.md` — file pointers for the v2 multi-agent build (broader than this campaign's scope).
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/plan/PROMPT_ENGINEERING.md` — prompt-quality discipline.

## Perf baseline

- `<repo>/.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` — frozen baseline. Compare against this; never overwrite (see GOTCHAS `bun-test-test-dir-runs-baseline-orchestrator`).
- `<repo>/.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md` — the previous campaign's final perf report.

## This campaign's artifacts

- `<repo>/.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf/wave_<N>.json` — one file per wave that touches a hot path.
- `<repo>/.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf-final-report.md` — produced by Wave 4.
- `<repo>/.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/` — gitignored. Anything else (screenshots, logs) lands here.

## Toolchain

- Bun ≥ 1.0 (project uses workspaces). Test runner is `bun test`; never `vitest`.
- TypeScript via `bun typecheck` (a workspace script). Never `tsc`.
- Effect v4 / effect-smol (4.0.0-beta.59 at time of writing).
