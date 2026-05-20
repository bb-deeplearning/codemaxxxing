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
| `packages/opencode/src/agent/prompt/explore.txt`           | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md), [caveman-agent](2026-04-11-caveman-agent.md), [actor-discipline](2026-05-20-actor-discipline.md): D4 defer-edits                   |
| `packages/opencode/src/agent/prompt/general/anthropic.txt` | New      | [prompt-parity](2026-02-22-prompt-parity.md), [caveman-agent](2026-04-11-caveman-agent.md), [actor-discipline](2026-05-20-actor-discipline.md): D4 defer-edits                         |
| `packages/opencode/src/agent/prompt/general/gemini.txt`    | New      | [prompt-parity](2026-02-22-prompt-parity.md), [actor-discipline](2026-05-20-actor-discipline.md): D4 defer-edits                                                                       |

## Source code: capability hint fragments

Injected by `SystemPrompt.capabilityHints(agent)` at session bootstrap based on the agent's effective permission set. See [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md).

| File                                                          | Status   | Changes file                                                                                                                                                              |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/agent/prompt/persistent-processes.txt` | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md)                                                                                              |
| `packages/opencode/src/agent/prompt/multi-agent-root.txt`     | New + Extended | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md), [actor-discipline](2026-05-20-actor-discipline.md): D7 Sibling coordination + D8 Limits + D13 Routers and pools + mandatory-timeout doctrine (+42 LOC) |
| `packages/opencode/src/agent/prompt/multi-agent-subagent.txt` | New + Extended | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md), [actor-discipline](2026-05-20-actor-discipline.md): D1 Delivery contract + D11 ABORT + D15 mailbox backpressure + D16 Your behavior contract + D2 canonical-path per-spawn injection (+60 LOC) |

## Source code: agent infrastructure

| File                                            | Status   | Changes file                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/agent/agent.ts`          | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md), [prompt-parity](2026-02-22-prompt-parity.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md), [actor-discipline](2026-05-20-actor-discipline.md): D16 attaches behaviors to general+explore + `behaviorContractFor` helper |
| `packages/opencode/src/session/llm.ts`          | Modified | [prompt-parity](2026-02-22-prompt-parity.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md)                                                                                                    |
| `packages/opencode/src/session/system.ts`       | Modified | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md): `capabilityHints(agent)`; [actor-discipline](2026-05-20-actor-discipline.md): D2 per-spawn canonical-path injection (optional `sessionID` param) |
| `packages/opencode/src/session/prompt.ts`       | Modified | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md): mailbox drain + v2 dispatch branch; [actor-discipline](2026-05-20-actor-discipline.md): pass `sessionID` to capabilityHints |
| `packages/opencode/src/permission/index.ts`     | Modified | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md): `SHELL_TOOLS`, `MULTI_AGENT_TOOLS`, group `disabled()` arms; [actor-discipline](2026-05-20-actor-discipline.md): MULTI_AGENT_TOOLS extended 7→10 (`spawn_pool`, `link_agents`, `unlink_agents`) |
| `packages/opencode/src/project/bootstrap.ts`    | Modified | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                                                                                                                     |
| `packages/opencode/src/config/keybinds.ts`      | Modified | [flush-queued](2026-05-18-flush-queued.md): `session_flush_queued`                                                                                                                                                            |

## Source code: multi-agent v2 (NEW subsystem)

Per-root agent registry, per-session bounded mailboxes, completion watchers, supervision strategies, link cascades, behavior contracts, and the ten concurrent-interactive subagent tools.

| Subsystem                       | Files                                                                                                                                                                                                                                                                                                                                                                                                                            | Origin |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `AgentControl` service          | `packages/opencode/src/agent/control.ts` + `.test.ts` (~2200 lines after D5/D11/D12/D13/D14/D15/D16/D18; ~140 tests)                                                                                                                                                                                                                                                                                                            | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) + [actor-discipline](2026-05-20-actor-discipline.md) |
| Mailbox + cross-agent messaging | `packages/opencode/src/agent/mailbox.ts` + `.test.ts` (D15 bounded queue + `MailboxFullError` + `sendSystem`), `inter-agent-communication.ts` + `.test.ts` (D10 `correlation_id`, D11 `abort_reason`, D16 `behavior_violation` optional fields)                                                                                                                                                                                  | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) + [actor-discipline](2026-05-20-actor-discipline.md) |
| Behavior contracts              | `packages/opencode/src/agent/behaviors.ts` (NEW; `BehaviorContract` + `BehaviorViolation` Schema.Class + `DEFAULT_CONTRACTS` for general/explore + `resolveContract` + `computeViolations` + `ABORT_REASONS` const)                                                                                                                                                                                                              | [actor-discipline](2026-05-20-actor-discipline.md) |
| Registry + paths                | `packages/opencode/src/agent/registry.ts` + `.test.ts`, `agent-path.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                                             | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Live status + metadata          | `packages/opencode/src/agent/live-agent.ts` + `.test.ts`, `status.ts` + `.test.ts`, `metadata.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                   | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Nickname pool                   | `packages/opencode/src/agent/builtins/agent-names.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                                                               | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Sourced log events              | `packages/opencode/src/v2/session-event.ts` + `.test.ts`, `session-message-updater.ts`                                                                                                                                                                                                                                                                                                                                           | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Observability metrics           | `packages/opencode/src/wave/metric.ts` + `.test.ts` (NEW; 4 BusEvent under `agent.metric.*` + 4 pure rate helpers + `DeliverableSource` literal union; 30 tests, 100/100 coverage)                                                                                                                                                                                                                                               | [actor-discipline](2026-05-20-actor-discipline.md) |
| Tool surface (original 6 tools) | `packages/opencode/src/tool/agent-spawn/{agent-spawn.ts,.txt,.test.ts,schema.test.ts}` (+D12 `on_failure` + `pool_strategy` params), `agent-send/...` (+D10 `correlation_id`, D15 mailbox_full, D18 SubagentToolError emission), `agent-followup/...` (same shape as agent-send), `agent-wait/{agent-wait.ts,.txt,constants.ts,.test.ts,schema.test.ts}` (+D10 second `wait_for_reply` Tool.define + `wait-for-reply.txt`, D11 mandatory-timeout warnings, D18 SiblingDeadlock emission), `agent-list/...`, `agent-close/...` (+D3 optional `target`, D9 `already_terminated`/`path_invalid` split)        | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) + [actor-discipline](2026-05-20-actor-discipline.md) |
| Tool surface (D13 fan-out)      | `packages/opencode/src/tool/agent-pool/{agent-pool.ts,.txt,.test.ts}` (NEW; `spawn_pool` with `collect: all / first / any_n`; 278 + 109 + 698 = 1085 lines; 21 tests; 100/100 coverage)                                                                                                                                                                                                                                          | [actor-discipline](2026-05-20-actor-discipline.md) |
| Tool surface (D14 linking)      | `packages/opencode/src/tool/agent-link/{agent-link.ts,.txt,.test.ts}` (NEW; `link_agents` + `unlink_agents`; 14 tests; 100/100 coverage)                                                                                                                                                                                                                                                                                          | [actor-discipline](2026-05-20-actor-discipline.md) |
| Tool helpers                    | `packages/opencode/src/tool/agents/current-path.ts` + `.test.ts`                                                                                                                                                                                                                                                                                                                                                                 | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |

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
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`  | Modified | [flush-queued](2026-05-18-flush-queued.md): `loop` handler                                              |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`    | Modified | [flush-queued](2026-05-18-flush-queued.md): `SessionPaths.loop` + `HttpApiEndpoint.post("loop", ...)`   |
| `packages/opencode/src/server/routes/instance/session.ts`                   | Modified | [flush-queued](2026-05-18-flush-queued.md): legacy Hono `POST /:sessionID/loop` for parity              |
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
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`                          | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) (depth>1 sibling navigation), [flush-queued](2026-05-18-flush-queued.md) (inline flush hint next to `queued` badge) |
| `packages/opencode/src/cli/cmd/tui/app.tsx`                                           | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                       |
| `packages/opencode/src/cli/cmd/tui/routes/session/process-tool.tsx` + `.test.tsx`     | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Renders `Process` + `ProcessWriteStdin` parts.                                                |
| `packages/opencode/src/cli/cmd/tui/routes/session/mailbox-message.tsx`                | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Cross-agent message rendering.                                                                |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-status.ts` + `.test.ts`    | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Per-session subagent status derivation.                                                       |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` + `-mount.tsx` | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). 4-field status strip in footer.                                                               |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-subagent.tsx` + `-mount.tsx` | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). `close` action on quick-action dialog.                                                        |
| `packages/opencode/src/cli/cmd/tui/routes/session/agent-identity.ts` + `.test.ts`     | New      | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md)                                                                                                |
| `packages/opencode/src/cli/cmd/tui/routes/session/agent-tool.tsx` + `-mount.tsx` + `.test.tsx` | New | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). Semantic rendering of multi-agent v2 tool calls.                                          |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`                        | Modified | [flush-queued](2026-05-18-flush-queued.md): `queuedCount` memo, `session.flush_queued` command, footer hint when busy + queued |

## Tests

| Test surface         | Files (`packages/opencode/test/...`)                                                                                                                                                                                                  | Purpose                                                                                                                | Changes file |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| Integration          | `integration/multi-agent-invariants.test.ts` (45 invariants: 17 pre-existing + INV-D-01..28), `multi-agent-tools.test.ts`, `process-tool.test.ts`, `tool-surface-replacement.test.ts` (24 invariants), `plugin-bridge.test.ts`, `legacy-internal-runnable.test.ts` | Scenario-level invariants per `INTEGRATION_INVARIANTS.md`. Coverage is necessary; this harness is sufficient.          | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) + [actor-discipline](2026-05-20-actor-discipline.md) |
| Prose                | `prose/subagent-prompts.test.ts` (NEW; 54 grep-assertions on forbidden phrases absent + required phrases present across the five subagent prompt files)                                                                              | Keeps prose contract from regressing on future edits.                                                                  | [actor-discipline](2026-05-20-actor-discipline.md) |
| E2E                  | `e2e/`. 10 scenarios: `parallel-explorers`, `worker-pipeline`, `debate`, `observer`, `persistent-repl`, `long-running-server`, `cancellation-cascade`, `permission-denial`, `concurrent-perf-invariants`, `memory-load`.             | Full happy-path scenarios for the new tool surfaces.                                                                   | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Backward compat      | `backward-compat/`. `legacy-session`, `legacy-task-tool`, `pty-existing-consumers`, `system-prompt-regression`, `plugin-hooks`, `event-replay` (plus `manual-smoke.md`).                                                              | Verify no regression on legacy `task` and `bash`, old session deserialization, plugin hooks, sourced-event replay.     | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Differential         | `differential/`. `scanner-extract.diff`, `exec-permission.diff`, `spawn-permission.diff`, `prompt-prose.diff`.                                                                                                                        | OLD-path output == NEW-path output across fixture corpus. Used for pure refactors and permission key collapse.         | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Perf benches         | `perf/`. 14 files including `agent-control`, `baseline`, `exec-command`, `head-tail-buffer`, `mailbox`, `multi-agent-render`, `process-render`, `process-tool`, `prompt-render`, `pty-read`, `registry-tools`, `registry`, `runloop-multi-agent`, `scan`, `spawn-agent`. | Frozen baseline + 5/10/15% budget on p50/p95/p99 vs `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`. | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Fixtures + helpers   | `fixtures/fuzz.ts`, `fixtures/generate-corpus.ts`, `fixtures/load-config.{ts,test.ts}`, `snapshots/capture-baseline.ts`, `lib/stub-provider.ts`                                                                                       | Shared test infrastructure for the campaign harnesses.                                                                 | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| Session (modified)   | `session/system-backward-compat.test.ts`, `session/system.test.ts` (D2 path-injection layer rebuild)                                                                                                                                  | Capability hint injection back-compat; D2 path injection visible to real subagents.                                    | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) + [actor-discipline](2026-05-20-actor-discipline.md) |

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

Full engineering references for each campaign.

| File                                  | Status | Purpose                                                                                                                                  | Changes file |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `specs/codex-parity.md`               | New    | 375 lines. Original 6-tool port reference: tool surfaces, backing services, behavior notes, BC, perf, testing, archive index.            | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| `specs/codex-parity-hardening.md`     | New    | 429 lines. Per-root scoping + completion-watcher reference: 3 bugs (root cause + fix), `INTEGRATION_INVARIANTS` discipline, perf audit.  | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| `specs/replace-bash-task.md`          | New    | 438 lines. SHELL_TOOLS/MULTI_AGENT_TOOLS groups, plugin bridge, prose migration, BC matrix, differential tests.                          | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md) |
| `specs/tui-render-freeze.md`          | New    | TUI render-freeze investigation log.                                                                                                     | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `specs/actor-discipline.md`           | New    | ~500 lines. Full actor-system surface: D5/D2/D3/D9 bootstrap floor, D1/D7/D8/D4 delivery contract prose, D10/D11 ask + ABORT, D12/D13/D14/D15/D16 supervision/pools/links/bounded-mailboxes/behaviors, D18 observability metrics, 28 D-series integration invariants. | [actor-discipline](2026-05-20-actor-discipline.md) |

## Root files

| File          | Status    | Changes file                                                                                                                                                  |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`   | Rewritten | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md), [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md), [actor-discipline](2026-05-20-actor-discipline.md) (intro reframed, 10-tool surface, orchestrated waves subsection, observability + behavior contracts) |
| `.gitignore`  | Modified  | [initial-fork](2026-02-15-initial-fork.md)                                                                                                                    |
| `WAVES.md`    | Rewritten | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                         |
| `GOTCHAS.md`  | New + Extended | [multi-agent-and-tool-overhaul](2026-05-13-multi-agent-and-tool-overhaul.md). About 1300 lines progressive-disclosure knowledge base; [actor-discipline](2026-05-20-actor-discipline.md) added 2 entries: `agentcontrol-d5-extractor-needs-two-pass-walk-for-terse-followup-status-line` + `agentcontrol-d11-abort-line-parser-last-line-only`. |
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
| `.wave/campaigns/`                                     | Archived wave campaigns: `codex-parity-2026-05-13/`, `codex-parity-hardening-2026-05-14/`, `replace-bash-task-2026-05-15/`, `actor-discipline-2026-05-20/` |
