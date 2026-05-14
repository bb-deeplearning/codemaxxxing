# Wave 0 — Survey, invariant seed, behavioral baseline, integration scaffold

<!--
Previous waves: none — this is the first wave of the campaign.
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../BACKWARD_COMPAT.md, ../../INTEGRATION_INVARIANTS.md
- ../../PERMISSION_MAPPING.md, ../../FIXTURES.md, ../../REFERENCES.md
- repo-root GOTCHAS.md (indexes first; load specific entries as needed)
- packages/opencode/AGENTS.md and the repo-root AGENTS.md
-->

## Goal

Stand up everything later waves consume. Three deliverables:

1. **Behavioral baseline** — capture pre-change observable artifacts (model-visible tool list per agent, rendered permission prompts, prompt token counts, Bus event sequences) into `artifacts/snapshots/`. Wave 6 diffs against these.
2. **Perf baseline** — capture pre-replacement perf for every metric in `PERF.md` § "Hot paths" into `artifacts/baseline-perf.json`. Frozen.
3. **Integration test scaffold + fixtures** — create `test/integration/tool-surface-replacement.test.ts` with seeded `.skip` stubs for every invariant in `INTEGRATION_INVARIANTS.md`, and materialize the fixtures from `FIXTURES.md` into `test/fixtures/permission-configs/*.json` + `test/fixtures/scanner-corpus.json`.

**No production code changes.** Wave 0 creates test/fixture/snapshot files only.

## Tasks

Three sub-agents in parallel — A and B and C are independent.

### Sub-agent A — fixture materialization + scanner corpus generation

Files:
- `packages/opencode/test/fixtures/permission-configs/empty-config.json`
- `packages/opencode/test/fixtures/permission-configs/allow-all-bash.json`
- `packages/opencode/test/fixtures/permission-configs/deny-all-bash.json`
- `packages/opencode/test/fixtures/permission-configs/git-allow-rest-ask.json`
- `packages/opencode/test/fixtures/permission-configs/task-explore-allow.json`
- `packages/opencode/test/fixtures/permission-configs/task-explore-deny.json`
- `packages/opencode/test/fixtures/permission-configs/deny-all-task.json`
- `packages/opencode/test/fixtures/permission-configs/mixed-permissions.json`
- `packages/opencode/test/fixtures/permission-configs/tools-bash-false.json`
- `packages/opencode/test/fixtures/permission-configs/tools-task-false.json`
- `packages/opencode/test/fixtures/permission-configs/agent-overrides-deny-bash.json`
- `packages/opencode/test/fixtures/load-config.ts` — helper module per `FIXTURES.md` § "How fixtures are loaded"
- `packages/opencode/test/fixtures/generate-corpus.ts` — script that reads the hardcoded command list (categories per `FIXTURES.md` § "Scanner command corpus"), calls `shell.ts`'s scanner on each, writes `scanner-corpus.json`.
- `packages/opencode/test/fixtures/scanner-corpus.json` — committed output of `generate-corpus.ts` run against current `shell.ts`.

Run `bun run packages/opencode/test/fixtures/generate-corpus.ts` once, commit the resulting JSON. Re-running with no scanner change must produce a byte-identical file (idempotent).

Verify each fixture loads and parses cleanly:
```bash
cd packages/opencode
bun test test/fixtures/load-config.test.ts   # add a small test that loads each fixture
```

### Sub-agent B — integration test scaffold

File: `packages/opencode/test/integration/tool-surface-replacement.test.ts`

Structure mirrors the codex-parity-hardening campaign's `multi-agent-invariants.test.ts` (read it for the pattern). One `it.instance.skip(...)` block per invariant from `INTEGRATION_INVARIANTS.md`. Each block:
- Has the exact slug as its test name.
- Carries a `// TODO(wave_N): unskip when <description> lands.` comment naming the wave that will unskip.
- Has a real (typechecking) test body even though skipped — `yield* Effect.void` is fine for the stub.

Required imports + setup pattern (copy from the hardening campaign):

```ts
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(
  Agent.defaultLayer,
  AgentControl.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Permission.defaultLayer,
  Session.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
))

describe("INTEGRATION_INVARIANTS — tool surface replacement", () => {
  // TODO(wave_1): unskip when scanner extract lands.
  it.instance.skip("scanner-extract-preserves-bash-output", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )
  // ... one block per invariant in INTEGRATION_INVARIANTS.md
})
```

Run:
```bash
cd packages/opencode
bun test test/integration/tool-surface-replacement.test.ts   # all skipped, suite passes
bun typecheck   # the file typechecks
```

### Sub-agent C — behavioral baseline + perf baseline capture

Behavioral snapshots — write to `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/`:

- `tool-list-build.json` — `tools(model)` for `build` agent. List of `{ id, descriptionTokens }` entries, sorted by id.
- `tool-list-caveman.json` — same for `caveman` agent.
- `tool-list-explore.json` — same for `explore` subagent.
- `tool-list-general.json` — same for `general` subagent.
- `tool-list-plan.json` — same for `plan` agent.
- `permission-prompts/bash-git-status.json` — full `Permission.Event.Asked` payload when `bash` tool is invoked with `cmd: "git status"`. Captured by subscribing to `Permission.Event.Asked` while running the tool.
- `permission-prompts/bash-rm-tmp.json` — same for `rm /tmp/foo`.
- `permission-prompts/bash-cd-home.json` — same for `cd /home/user`.
- `permission-prompts/exec-command-git-status.json` — same shape but invoking `exec_command` (current pre-Wave-2 form).
- `permission-prompts/spawn-agent-explore.json` — same for `spawn_agent`.
- `prompt-prose/bash-description.txt` — current `bash` tool's full rendered description.
- `prompt-prose/exec-command-description.txt` — current `exec_command`'s full rendered description.
- `prompt-prose/task-description.txt` — current `task`'s full rendered description.
- `prompt-prose/spawn-agent-description.txt` — current `spawn_agent`'s full rendered description.

Capture script: `packages/opencode/test/snapshots/capture-baseline.ts`. Reads the agent registry, instantiates each, calls into `tools()` with a minimal `model` arg, writes JSON files. Token count via the project's existing tokenizer wrapper if one exists; otherwise `description.length` as a byte proxy and document the proxy in NOTES.

Run:
```bash
cd packages/opencode
bun run test/snapshots/capture-baseline.ts
git add ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/
```

Perf baseline — write to `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json`. One bench file:

`packages/opencode/test/perf/baseline.bench.ts` — captures every metric in `PERF.md` § "Required metrics in baseline". Output JSON via the harness's `compareToBaseline`-compatible writer.

Run:
```bash
cd packages/opencode
bun test ./test/perf/baseline.bench.ts
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json
```

Also write the same content to `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_0.json` for the trend-tracking series.

## Test pyramid quota for Wave 0

- Unit: 0 (no production code).
- Integration: skeleton only (all .skip).
- Differential: 0.
- Property: 0.
- Fixtures: 11 permission-configs + 1 scanner-corpus.
- Plugin contract: 0.
- Snapshot: 14 behavioral baselines + 1 perf baseline.
- Bench: 1 (baseline-only).

## Gotchas

1. **Don't run `bun test test/`.** Per the `bun-test-test-dir-runs-baseline-orchestrator` GOTCHA. Use per-file invocations only when capturing baseline so the orchestrator doesn't run and overwrite files.

2. **`scanner-corpus.json` is the differential oracle for Wave 1.** Generate it ONCE in this wave from the current `shell.ts` scanner. Wave 1 must NOT regenerate it. Commit with the wave.

3. **Fixture file paths** are absolute from package root: `packages/opencode/test/fixtures/...`. Per `do-not-run-tests-from-root` GOTCHA, run via `cd packages/opencode && bun test ...`.

4. **Snapshot capture for `tools(model)`** requires a real agent layer. Use the existing test agent setup pattern from `test/integration/multi-agent-invariants.test.ts`. Don't invent a new pattern.

5. **Token counting** — opencode's tokenizer is provider-specific. If no project-level helper exists, document the byte-proxy choice in NOTES and write the snapshot bytes; Wave 5 can adopt a real tokenizer if needed for the budget assertion.

6. **`permission-prompts/*.json` capture** — subscribe to `Permission.Event.Asked` via `Bus.subscribe(Permission.Event.Asked, ...)` BEFORE invoking the tool. Stub the reply so the tool doesn't hang waiting for a real user; you only care about the asked-event payload. Pattern: subscribe, run tool, stub reply with "once" to clear the prompt, capture the asked event.

7. **`pid:<n>` rules in baseline capture** — when capturing `exec-command-git-status.json`, the `pid:<n>` always-pattern will be a different number on every run. Substitute with a placeholder `pid:<N>` in the captured JSON OR strip the field; Wave 2's diff test must apply the same substitution to its own capture before comparing.

8. **`caveman` is a markdown agent, not built-in.** Only `build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary` are defined inline in `agent/agent.ts:130-301`. The `caveman` agent (and any other custom agent the snapshot needs) is loaded from `.opencode/agent/<name>.md` files via `ConfigAgent.load(dir)` (see `packages/opencode/src/config/agent.ts:110`). The capture script must bind the test instance to a directory whose `.opencode/agent/` actually contains `caveman.md` — the obvious choice is the repo root, where `.opencode/agent/caveman.md` already exists, or copy the file into a tmpdir before binding. If `caveman` doesn't surface in `agents.list()`, the snapshot file will be missing or wrong, and Wave 4's snapshot-diff test will fail. Note in NOTES.md whatever fixture path the script uses.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# fixtures load and parse
bun test test/fixtures/load-config.test.ts

# integration scaffold typechecks and runs (all skipped)
bun test test/integration/tool-surface-replacement.test.ts
test "$(bun test test/integration/tool-surface-replacement.test.ts 2>&1 | grep -c '^✗')" = "0"

# behavioral baseline captured
ls ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/tool-list-build.json
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/permission-prompts/bash-git-status.json

# perf baseline captured
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_0.json

# scanner-corpus.json is committed and idempotent
bun run test/fixtures/generate-corpus.ts
git diff --quiet test/fixtures/scanner-corpus.json   # exit 0 means no change
```

All exit 0.

## Files

New:
- `packages/opencode/test/fixtures/permission-configs/*.json` (11 files per Sub-agent A)
- `packages/opencode/test/fixtures/load-config.ts`
- `packages/opencode/test/fixtures/load-config.test.ts`
- `packages/opencode/test/fixtures/generate-corpus.ts`
- `packages/opencode/test/fixtures/scanner-corpus.json`
- `packages/opencode/test/integration/tool-surface-replacement.test.ts`
- `packages/opencode/test/snapshots/capture-baseline.ts`
- `packages/opencode/test/perf/baseline.bench.ts`
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/*` (14 files per Sub-agent C)
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/baseline-perf.json`
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_0.json`

Modified: none.
