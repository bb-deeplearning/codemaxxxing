# Index: Files differing from upstream

All files in this fork that intentionally differ from [anomalyco/opencode](https://github.com/anomalyco/opencode) `dev` branch. Use this to track merge conflicts and verify fork integrity.

Compare with: `git diff origin/dev --stat`

## Source code: prompts

| File                                                       | Status   | Changes file                                                                                                                                                       |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/session/prompt/anthropic.txt`       | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md), [anthropic-inquiry-mode](2026-02-23-anthropic-inquiry-mode.md) |
| `packages/opencode/src/session/prompt/qwen.txt`            | Modified | [qwen-prompt-sync](2026-02-24-qwen-prompt-sync.md)                                                                                                                 |
| `packages/opencode/src/session/prompt/gemini.txt`          | Modified | [prompt-parity](2026-02-22-prompt-parity.md)                                                                                                                       |
| `packages/opencode/src/session/prompt/plan.txt`            | Modified | [initial-fork](2026-02-15-initial-fork.md)                                                                                                                         |
| `packages/opencode/src/tool/task.txt`                      | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md)                                                                 |
| `packages/opencode/src/agent/prompt/explore.txt`           | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md), [caveman-agent](2026-04-11-caveman-agent.md)                   |
| `packages/opencode/src/agent/prompt/general/anthropic.txt` | New      | [prompt-parity](2026-02-22-prompt-parity.md), [caveman-agent](2026-04-11-caveman-agent.md)                                                                         |
| `packages/opencode/src/agent/prompt/general/gemini.txt`    | New      | [prompt-parity](2026-02-22-prompt-parity.md)                                                                                                                       |

## Source code: capability hint fragments

Injected by `SystemPrompt.capabilityHints(agent)` at session bootstrap based on the agent's effective permission set. See [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md).

| File                                                          | Status |
| ------------------------------------------------------------- | ------ |
| `packages/opencode/src/agent/prompt/persistent-processes.txt` | New    |
| `packages/opencode/src/agent/prompt/multi-agent-root.txt`     | New    |
| `packages/opencode/src/agent/prompt/multi-agent-subagent.txt` | New    |

## Source code: agent infrastructure

| File                                            | Status   | Changes file                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/agent/agent.ts`          | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md), [prompt-parity](2026-02-22-prompt-parity.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| `packages/opencode/src/session/llm.ts`          | Modified | [prompt-parity](2026-02-22-prompt-parity.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md)                                                                                                    |
| `packages/opencode/src/session/system.ts`       | Modified | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md): `capabilityHints(agent)`                                                                                                                        |
| `packages/opencode/src/session/prompt.ts`       | Modified | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md): mailbox drain + v2 dispatch branch                                                                                                              |
| `packages/opencode/src/permission/index.ts`     | Modified | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md): `SHELL_TOOLS`, `MULTI_AGENT_TOOLS`, group `disabled()` arms                                                                                     |
| `packages/opencode/src/project/bootstrap.ts`    | Modified | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                                                                                                                     |

## Source code: multi-agent v2 (NEW subsystem)

Per-root agent registry, per-session mailbox, completion watchers, and the six concurrent-interactive subagent tools. All [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md).

| Subsystem                       | Files                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentControl` service          | `packages/opencode/src/agent/control.ts` + `.test.ts` (about 1200 lines)                                                                                                                                                                                                                                                                                                                                                         |
| Mailbox + cross-agent messaging | `packages/opencode/src/agent/mailbox.ts` + `.test.ts`, `inter-agent-communication.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                               |
| Registry + paths                | `packages/opencode/src/agent/registry.ts` + `.test.ts`, `agent-path.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                                             |
| Live status + metadata          | `packages/opencode/src/agent/live-agent.ts` + `.test.ts`, `status.ts` + `.test.ts`, `metadata.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                   |
| Nickname pool                   | `packages/opencode/src/agent/builtins/agent-names.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                                                               |
| Sourced log events              | `packages/opencode/src/v2/session-event.ts` + `.test.ts`, `session-message-updater.ts`                                                                                                                                                                                                                                                                                                                                           |
| Tool surface (6 tools)          | `packages/opencode/src/tool/agent-spawn/{agent-spawn.ts,.txt,.test.ts,schema.test.ts}`, `agent-send/...`, `agent-followup/...`, `agent-wait/{agent-wait.ts,.txt,constants.ts,.test.ts,schema.test.ts}`, `agent-list/...`, `agent-close/...`                                                                                                                                                                                       |
| Tool helpers                    | `packages/opencode/src/tool/agents/current-path.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                                                                 |

## Source code: persistent processes (NEW subsystem)

64-process PTY pool with head/tail-buffered output. Two model-facing tools (`exec_command`, `write_stdin`) plus Pty service extensions. All [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md).

| Subsystem                | Files                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool surface (2 tools)   | `packages/opencode/src/tool/process/{exec-command.ts,.txt,.test.ts,write-stdin.ts,.txt,.test.ts,constants.ts,id.ts,prompt.ts,sessions.ts,schema.test.ts}`                          |
| Pty service extensions   | `packages/opencode/src/pty/index.ts` (race-read, LRU pruner, `origin: "tui" \| "model"`, `terminateAll`), `head-tail-buffer.ts` + `.test.ts` (ported from codex)                   |

## Source code: shell scanner extraction (NEW subsystem)

Pure refactor extracted from `shell.ts` during campaign 3. All [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md).

| File                                                | Status                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/opencode/src/tool/shell/scan.ts`          | New. AST-derived patterns, reentrant under load.                                    |
| `packages/opencode/src/tool/shell/scan.test.ts`     | New. 531 lines including 50-command corpus tests.                                   |
| `packages/opencode/src/tool/shell/id.ts`            | New                                                                                 |
| `packages/opencode/src/tool/shell/prompt.ts`        | New                                                                                 |
| `packages/opencode/src/tool/shell/shell.txt`        | Relocated from `tool/shell.txt`                                                     |
| `packages/opencode/src/tool/shell.ts`               | Modified. Scanner extracted out (372 lines down to much smaller).                   |
| `packages/opencode/src/tool/registry.ts`            | Modified. New builtins, plugin bridge, `describeSpawnAgent` filter onto `task` key. |

## Source code: wave system

| File                                                                        | Status | Changes file                                              |
| --------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `packages/opencode/src/wave/wave.ts`                                        | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/wave/loop.ts`                                        | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/wave/state.ts`                                       | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/wave.ts`     | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/server/routes/instance/httpapi/groups/wave.ts`       | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/cli/cmd/tui/routes/wave/index.tsx`                   | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/cli/cmd/tui/context/wave.tsx`                        | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/test/wave/wave.test.ts`                                  | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/test/wave/state.test.ts`                                 | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |

## Source code: TUI

| File                                                                                  | Status   | Changes file                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/cli/logo.ts`                                                   | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                       |
| `packages/opencode/src/cli/cmd/tui/component/logo.tsx`                                | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                       |
| `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`                        | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                       |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`                          | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) (depth>1 sibling navigation) |
| `packages/opencode/src/cli/cmd/tui/app.tsx`                                           | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                       |
| `packages/opencode/src/cli/cmd/tui/routes/session/process-tool.tsx` + `.test.tsx`     | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Renders `Process` + `ProcessWriteStdin` parts.                                                |
| `packages/opencode/src/cli/cmd/tui/routes/session/mailbox-message.tsx`                | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Cross-agent message rendering.                                                                |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-status.ts` + `.test.ts`    | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Per-session subagent status derivation.                                                       |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` + `-mount.tsx` | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). 4-field status strip in footer.                                                               |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-subagent.tsx` + `-mount.tsx` | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). `close` action on quick-action dialog.                                                        |
| `packages/opencode/src/cli/cmd/tui/routes/session/agent-identity.ts` + `.test.ts`     | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md)                                                                                                |
| `packages/opencode/src/cli/cmd/tui/routes/session/agent-tool.tsx` + `-mount.tsx` + `.test.tsx` | New | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Semantic rendering of multi-agent v2 tool calls.                                          |

## Tests

All [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) unless noted.

| Test surface         | Files (`packages/opencode/test/...`)                                                                                                                                                                                                  | Purpose                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Integration          | `integration/multi-agent-invariants.test.ts` (13 invariants), `multi-agent-tools.test.ts`, `process-tool.test.ts`, `tool-surface-replacement.test.ts` (24 invariants), `plugin-bridge.test.ts`, `legacy-internal-runnable.test.ts`     | Scenario-level invariants per `INTEGRATION_INVARIANTS.md`. Coverage is necessary; this harness is sufficient.          |
| E2E                  | `e2e/`. 10 scenarios: `parallel-explorers`, `worker-pipeline`, `debate`, `observer`, `persistent-repl`, `long-running-server`, `cancellation-cascade`, `permission-denial`, `concurrent-perf-invariants`, `memory-load`.             | Full happy-path scenarios for the new tool surfaces.                                                                   |
| Backward compat      | `backward-compat/`. `legacy-session`, `legacy-task-tool`, `pty-existing-consumers`, `system-prompt-regression`, `plugin-hooks`, `event-replay` (plus `manual-smoke.md`).                                                              | Verify no regression on legacy `task` and `bash`, old session deserialization, plugin hooks, sourced-event replay.     |
| Differential         | `differential/`. `scanner-extract.diff`, `exec-permission.diff`, `spawn-permission.diff`, `prompt-prose.diff`.                                                                                                                        | OLD-path output == NEW-path output across fixture corpus. Used for pure refactors and permission key collapse.         |
| Perf benches         | `perf/`. 14 files including `agent-control`, `baseline`, `exec-command`, `head-tail-buffer`, `mailbox`, `multi-agent-render`, `process-render`, `process-tool`, `prompt-render`, `pty-read`, `registry-tools`, `registry`, `runloop-multi-agent`, `scan`, `spawn-agent`. | Frozen baseline + 5/10/15% budget on p50/p95/p99 vs `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`. |
| Fixtures + helpers   | `fixtures/fuzz.ts`, `fixtures/generate-corpus.ts`, `fixtures/load-config.{ts,test.ts}`, `snapshots/capture-baseline.ts`, `lib/stub-provider.ts`                                                                                       | Shared test infrastructure for the campaign harnesses.                                                                 |
| Session (modified)   | `session/system-backward-compat.test.ts`                                                                                                                                                                                              | Capability hint injection back-compat: compaction, title, summary stay hint-free.                                      |

## Project-local config

| File                         | Status | Changes file                                 |
| ---------------------------- | ------ | -------------------------------------------- |
| `.opencode/agent/caveman.md` | New    | [caveman-agent](2026-04-11-caveman-agent.md) |

## Custom agents (`custom_agents/`, copied to `~/.config/opencode/agent/`)

| File                            | Status     | Changes file                                                                          |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `custom_agents/docs.md`         | New        | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `custom_agents/general.md`      | New (ref)  | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `custom_agents/plan_structured.md` | New     | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `custom_agents/wave_plan.md`    | Renamed + rewritten | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) (was `wave_decompose.md` from [initial-fork](2026-02-15-initial-fork.md)) |
| `custom_agents/wave_verify.md`  | New        | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                             |

## Specs

Full engineering references for the three campaigns. All [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md).

| File                                  | Status | Purpose                                                                                                                                  |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `specs/codex-parity.md`               | New    | 375 lines. Campaign 1 reference: tool surfaces, backing services, behavior notes, BC, perf, testing, archive index.                      |
| `specs/codex-parity-hardening.md`     | New    | 429 lines. Campaign 2 reference: 3 bugs (root cause + fix + codex precedent), `INTEGRATION_INVARIANTS` discipline, perf audit.           |
| `specs/replace-bash-task.md`          | New    | 438 lines. Campaign 3 reference: SHELL_TOOLS/MULTI_AGENT_TOOLS groups, plugin bridge, prose migration, BC matrix, differential tests.    |
| `specs/tui-render-freeze.md`          | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md). TUI render-freeze investigation log.                                          |

## Root files

| File          | Status    | Changes file                                                                                                                                                  |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`   | Rewritten | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| `.gitignore`  | Modified  | [initial-fork](2026-02-15-initial-fork.md)                                                                                                                    |
| `WAVES.md`    | Rewritten | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                         |
| `GOTCHAS.md`  | New       | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). About 1300 lines, progressive-disclosure knowledge base.                        |
| `AGENTS.md`   | Modified  | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). `GOTCHAS.md` reference added.                                                   |

## Scripts + fixtures

| File                              | Status | Changes file                                              |
| --------------------------------- | ------ | --------------------------------------------------------- |
| `script/wave-demo-fixture.ts`     | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `wave-pill.tape`                  | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `wave-dashboard.tape`             | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |

## Removed files

| File                              | Status  | Changes file                                                                                                            |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.opencode/command/commit.md`     | Removed | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) (superseded by AGENTS.md commit guidance)                     |
| `CHANGES.md` (root)               | Removed | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) (transient changelog; folded into this dir) |

## Fork-only directories

| Directory                                              | Purpose                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `CHANGES/`                                             | Per-change documentation linking to iteration logs                                                                   |
| `PROMPT_ITERATIONS/`                                   | Research, rationale, and observation logs for prompt changes                                                         |
| `custom_agents/`                                       | Agent configs for `~/.config/opencode/agent/` (docs, plan_structured, wave_plan, wave_verify; general kept as ref)   |
| `specs/`                                               | Engineering reference docs for shipped campaigns (codex-parity, codex-parity-hardening, replace-bash-task, etc.)     |
| `.wave/` (per-project, gitignored except `campaigns/`) | Wave campaign state. Produced by `wave_plan` agent, consumed/mutated by executor + `wave_verify`.                    |
| `.wave/campaigns/`                                     | Archived wave campaigns: `codex-parity-2026-05-13/`, `codex-parity-hardening-2026-05-14/`, `replace-bash-task-2026-05-15/` |
