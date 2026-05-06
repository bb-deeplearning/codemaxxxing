# Index: Files differing from upstream

All files in this fork that intentionally differ from [anomalyco/opencode](https://github.com/anomalyco/opencode) `dev` branch. Use this to track merge conflicts and verify fork integrity.

Compare with: `git diff origin/dev --stat`

## Source code — prompts

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

## Source code — agent infrastructure

| File                                   | Status   | Changes file                                                                                                                                     |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/agent/agent.ts` | Modified | [initial-fork](2026-02-15-initial-fork.md), [explore-delegation](2026-02-22-explore-delegation.md), [prompt-parity](2026-02-22-prompt-parity.md) |
| `packages/opencode/src/session/llm.ts` | Modified | [prompt-parity](2026-02-22-prompt-parity.md)                                                                                                     |
| `packages/opencode/src/project/bootstrap.ts` | Modified | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                                                                                  |

## Source code — wave system

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

## Source code — TUI

| File                                                           | Status   | Changes file                                                                          |
| -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `packages/opencode/src/cli/logo.ts`                            | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/cli/cmd/tui/component/logo.tsx`         | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`   | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `packages/opencode/src/cli/cmd/tui/app.tsx`                    | Modified | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |

## Project-local config

| File                         | Status | Changes file                                 |
| ---------------------------- | ------ | -------------------------------------------- |
| `.opencode/agent/caveman.md` | New    | [caveman-agent](2026-04-11-caveman-agent.md) |

## Custom agents (`custom_agents/` — copied to `~/.config/opencode/agent/`)

| File                            | Status     | Changes file                                                                          |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `custom_agents/docs.md`         | New        | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `custom_agents/general.md`      | New (ref)  | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `custom_agents/plan_structured.md` | New     | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `custom_agents/wave_plan.md`    | Renamed + rewritten | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) (was `wave_decompose.md` from [initial-fork](2026-02-15-initial-fork.md)) |
| `custom_agents/wave_verify.md`  | New        | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md)                             |

## Root files

| File         | Status    | Changes file                                                                          |
| ------------ | --------- | ------------------------------------------------------------------------------------- |
| `README.md`  | Rewritten | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `.gitignore` | Modified  | [initial-fork](2026-02-15-initial-fork.md)                                            |
| `WAVES.md`   | Rewritten | [initial-fork](2026-02-15-initial-fork.md), [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |

## Scripts + fixtures

| File                              | Status | Changes file                                              |
| --------------------------------- | ------ | --------------------------------------------------------- |
| `script/wave-demo-fixture.ts`     | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `wave-pill.tape`                  | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `wave-dashboard.tape`             | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) |
| `specs/tui-render-freeze.md`      | New    | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) (TUI render-freeze investigation log) |

## Removed files

| File                              | Status  | Changes file                                              |
| --------------------------------- | ------- | --------------------------------------------------------- |
| `.opencode/command/commit.md`     | Removed | [wave-system](2026-05-06-wave-system-and-tui-overhaul.md) (superseded by AGENTS.md commit guidance) |

## Fork-only directories

| Directory            | Purpose                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CHANGES/`           | Per-change documentation linking to iteration logs                                                                   |
| `PROMPT_ITERATIONS/` | Research, rationale, and observation logs for prompt changes                                                         |
| `custom_agents/`     | Agent configs for `~/.config/opencode/agent/` (docs, plan_structured, wave_plan, wave_verify; general kept as ref)   |
| `.wave/` (per-project, gitignored except `campaigns/`) | Wave campaign state — produced by `wave_plan` agent, consumed/mutated by executor + `wave_verify` |
