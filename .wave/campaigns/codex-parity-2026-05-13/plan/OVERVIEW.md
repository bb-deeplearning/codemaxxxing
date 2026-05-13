# Project context — codemaxxxing fork of opencode

This is a fork of OpenCode (the AI coding TUI) that we maintain as `codemaxxxing`. Default branch is `dev`; this campaign runs on `codex-parity` branched from `codemaxxxing`. Workspace root is `/Users/rohan/Documents/Personal/codemaxxxing/`.

## What we're shipping

Two capabilities ported from openai/codex-cli, with full prose-quality prompts and zero behavioral compromises on the codex side:

1. **unified_exec** — model-facing persistent PTY tool surface. Two tools (`exec_command`, `write_stdin`) over a 64-process pool with head/tail-buffered output.
2. **multi_agents_v2** — concurrent interactive subagents with cross-agent messaging. Six tools (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`) backed by a new `AgentControl` service with per-parent registry and per-session mailbox.

After this campaign, codemaxxxing diverges meaningfully from OpenCode upstream. Both features must ship correctly, with full TDD, perf-measured, backward-compatible.

## Hard constraints

- **TDD discipline**: tests before implementation. 100% coverage on added/modified code. See `TDD.md`.
- **No perf regressions**: every wave that touches a hot path measures and verifies budget. See `PERF.md`.
- **Backward compat**: old sessions must load; legacy `task` tool must keep working; existing Pty consumers (TUI/desktop) unaffected. No Drizzle migrations. See `BACKWARD_COMPAT.md`.
- **Code quality**: idiomatic Effect v4, package conventions followed, no junior-tier patterns. See `STYLE.md`.
- **Prompt engineering**: tool descriptions are codex-quality manuals teaching when/why/how to use each tool. System prompts gain awareness of new capabilities via injected fragments. See `PROMPT_ENGINEERING.md`.

## Project facts the agent needs

- **Stack**: TypeScript + Bun + Effect v4 (effect-smol). TUI is Solid.js + opentui.
- **Database**: Drizzle + SQLite. Schema lives in `src/**/*.sql.ts`. This campaign produces zero migrations.
- **Module shape**: flat top-level exports + self-reexport at bottom (`export * as Foo from "./foo"`). Multi-sibling directories: no barrel `index.ts`.
- **Test runner**: `bun test` from `packages/opencode/` (NOT from repo root — there's a `do-not-run-tests-from-root` guard). Tests live alongside code (`foo.ts` ↔ `foo.test.ts`) or in `packages/opencode/test/{integration,e2e,perf,backward-compat,lib}/`.
- **Typecheck command**: `bun typecheck` from `packages/opencode/`. Never `tsc` directly.
- **Runtime conventions**: `makeRuntime` (`src/effect/run-service.ts`) for services. `InstanceState` (`src/effect/instance-state.ts`) for per-directory state. `Effect.forkIn(scope)` for concurrent fibers. `Instance.bind(fn)` for native-addon callbacks.

## Cross-cutting reference docs (read these every wave)

In this `plan/` directory:

- `REFERENCES.md` — every source file you might touch, absolute paths
- `CONSTANTS.md` — verbatim numeric constants from codex
- `TOOL_SCHEMAS.md` — semantic specs for the 8 model-facing tools (semantics from codex, prose ours)
- `MESSAGE_SHAPES.md` — cross-cutting decisions on message shapes, permission keys, constants split. **Read this before any wave that touches message shapes, permissions, or constants.**
- `GOTCHAS.md` — append-only knowledge base of sharp edges discovered by prior waves. **Read on every wave entry; append to it before finishing the wave if you discovered something worth recording.**
- `PROMPT_ENGINEERING.md` — discipline for tool descriptions and agent system prompts
- `TDD.md` — test-first protocol, coverage requirement, mocking policy
- `BACKWARD_COMPAT.md` — what must keep working, no-removal lists, no-migration policy
- `PERF.md` — measurement protocol, regression budget, hot paths

Each `WAVE.md` says explicitly which of these to load for that wave.

## Wave order at a glance

```
wave_0   test infra + perf baseline
wave_1   head/tail buffer (foundation for unified_exec)
wave_2   Pty.Service extensions (read primitive + LRU)
wave_3   tool/process.ts — exec_command + write_stdin
wave_4   process tool TUI part renderer
wave_5   Mailbox primitive
wave_6   Agent registry + AgentPath
wave_7   AgentControl service
wave_8   six multi-agent tools (parallel sub-agents)
wave_9   runLoop integration (replace handleSubtask dispatch + mailbox drain)
wave_10  EventV2 + Bus events for agent lifecycle
wave_11  TUI subagent enhancements
wave_12  Permission + agent system prompt fragments
wave_13  Backward compat verification
wave_14  E2E integration tests + final perf audit
wave_15  Spec doc
```

Sequential dependencies: 1→2→3→4 for unified_exec; 5→6→7→8→9 for multi-agent; 10 after 7; 11 after 9+10; 12 after 8+11; 13 after 12; 14 after 13; 15 after 14.

## Branch / commit hygiene

- Working branch: `codex-parity` (already created, branched off `codemaxxxing`)
- Commits go on this branch — never push to remote during the campaign
- Default branch in repo is `dev`; do NOT merge to dev as part of waves
- Commit messages follow the existing convention (see `git log --oneline -10` of `codemaxxxing` for tone)

## What "done" looks like for the campaign

- All 16 waves complete and committed
- `bun typecheck`, `bun lint`, full `bun test` from `packages/opencode/` all pass
- `artifacts/perf-final-report.md` shows no regression beyond budget on any hot path
- `specs/codex-parity.md` exists and matches the implementation
- `task` tool still works, old sessions still load, TUI renders unchanged for non-multi-agent sessions
