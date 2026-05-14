# References

External and internal source paths every wave may need.

## Codex source (read-only)

Path: `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/`

The codex port already happened in prior campaigns. Codex is the **design reference** for what the new tools should do — not for what to do in this campaign. This campaign is about removing the alternatives, not adding new ports.

Files most relevant to permission/tool surface design:

- `codex-rs/core/src/tools/spec_plan.rs:124-189` — codex's `ConfigShellToolType` config gate. Mutually exclusive shell-flavored tool registration. The pattern this campaign mirrors structurally (without the config knob — opencode chooses the post-replacement state unconditionally).
- `codex-rs/core/src/tools/spec_plan.rs:296-331` — codex's `multi_agent_v2` config gate. V1 vs V2 tools are mutually exclusive in codex; opencode is going for V2-only at the model surface.
- `codex-rs/core/src/tools/handlers/shell/shell_handler.rs` — codex's `ShellHandler::default()` pattern: `options: None` makes `spec()` return `None`, leaving the handler registered as a silent backstop without advertising the tool. Useful framing for understanding why codex registers multiple shell handlers.

## Prior campaigns

`.wave/campaigns/codex-parity-2026-05-13/`:

- `plan/OVERVIEW.md` — original port's overview. Useful for tool-by-tool background.
- `plan/MESSAGE_SHAPES.md` — message and event shapes for multi-agent v2. Cross-agent message contract.
- `plan/PERMISSIONS.md` (if present, otherwise `MESSAGE_SHAPES.md` § "Permission keys") — original permission-key choices.
- `plan/PROMPT_ENGINEERING.md` — voice guidelines for tool descriptions. Read before Wave 5.
- `plan/CONSTANTS.md` — numeric constants for unified_exec.
- `plan/TOOL_SCHEMAS.md` — JSON schema definitions for the 8 ported tools.
- `artifacts/baseline-perf.json` — frozen perf baseline from the original port. Wave 0 of this campaign establishes a fresh pre-replacement baseline; the original is reference only.

`.wave/campaigns/codex-parity-hardening-2026-05-14/`:

- `plan/INTEGRATION_INVARIANTS.md` — the previous integration-invariants doc. Still authoritative for multi-agent surfaces; this campaign extends but does not replace it.
- `plan/TDD.md` — integration-first rule. Still applies; this campaign extends with differential and property practices.
- `plan/PERF.md` — perf methodology. Still applies; this campaign adds prompt-token budget and trend tracking.

## Repo files this campaign reads or modifies

### Tool surface

- `packages/opencode/src/tool/shell.ts` — the legacy bash tool. Wave 1 lifts its scanner into `tool/shell/scan.ts`. Wave 4 drops it from the registry's builtin array (file remains).
- `packages/opencode/src/tool/shell/id.ts` — `ToolID = "bash"`. The hardcoded permission key. Stays.
- `packages/opencode/src/tool/shell/prompt.ts` — `ShellPrompt.render(...)`. Wave 5 reuses for shared prose template.
- `packages/opencode/src/tool/shell/shell.txt` — the legacy bash description prose. Wave 5 migrates content to `exec_command.txt`.
- `packages/opencode/src/tool/process/exec-command.ts` — codex-ported persistent PTY tool. Wave 2 wires the shared scanner.
- `packages/opencode/src/tool/process/exec-command.txt` — current prompt prose. Wave 5 absorbs `shell.txt` content.
- `packages/opencode/src/tool/process/write-stdin.ts` — codex-ported write-stdin tool. Wave 2 changes its `PermissionKey` to `bash`.
- `packages/opencode/src/tool/process/id.ts` — exports `ExecCommandID`, `WriteStdinID`, `PermissionKey`, `pidPattern`. Wave 2 changes `PermissionKey` from `"exec_command"` to `ShellID.ToolID` (= `"bash"`).
- `packages/opencode/src/tool/process/prompt.ts` + `constants.ts` — supporting modules. Likely untouched.
- `packages/opencode/src/tool/task.ts` — the legacy task tool. Wave 4 drops from registry's builtin array.
- `packages/opencode/src/tool/task.txt` — task description. Wave 5 may absorb fragments into `spawn_agent`'s prose if needed.
- `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` — v2 spawn_agent tool. Wave 3 changes its permission key from `"spawn_agent"` to `"task"`.
- `packages/opencode/src/tool/agent-{send,followup,wait,list,close}/` — the 5 friend tools. Wave 3 documents their permission key story (no per-call ask, but `MULTI_AGENT_TOOLS` group affects `Permission.disabled` lookup).
- `packages/opencode/src/tool/registry.ts` — the central registry. Wave 4 drops `tool.shell` and `tool.task` from `builtin` array (lines ~250-269). Wave 4 adds plugin hook bridge in `tools()` (line ~341). Wave 3 changes `describeSpawnAgent` filter (line ~329) from `Permission.evaluate("spawn_agent", ...)` to `Permission.evaluate("task", ...)`.

### Permission system

- `packages/opencode/src/permission/index.ts` — `disabled()` function (lines 309-320). Wave 2 adds `SHELL_TOOLS` to the category mapping. Wave 3 adds `MULTI_AGENT_TOOLS`.
- `packages/opencode/src/permission/evaluate.ts` — `evaluate()` function. Pure; unchanged by this campaign.
- `packages/opencode/src/permission/arity.ts` — `BashArity.prefix(...)` table. Unchanged. (Pattern derivation via this table is what makes saved `bash: { "git *": "allow" }` rules generalize across `git status`, `git status -s`, etc.)
- `packages/opencode/src/permission/schema.ts` — config types. Unchanged.

### Session integration

- `packages/opencode/src/session/llm.ts` — `resolveTools()` at line 450-456. Wave 2 adds SHELL_TOOLS user-config group rule. Wave 3 adds MULTI_AGENT_TOOLS user-config group rule.
- `packages/opencode/src/session/prompt.ts:1427` — user `tools` config parsing at session boot. Read for context; unchanged.

### Agent definitions

- `packages/opencode/src/agent/agent.ts` — `defaults` ruleset (around line 92), per-agent overrides. Wave 2/3 may add per-built-in overrides for the new permission keys (matches the codex-parity Wave 12 pattern).

### Plugin hooks

- `packages/opencode/src/plugin/index.ts` — `Plugin.trigger("tool.definition", ...)` at `registry.ts:363`. Wave 4's bridge inspects this to dispatch legacy IDs.
- The full set of plugin hook IDs is enumerated in `packages/opencode/src/plugin/index.ts`; Wave 4's plugin contract test exercises every hook that touches tool ID `bash` or `task`.

## Bun + Effect

- Repo-root `AGENTS.md` — Bun + Effect rules. Read on every wave entry.
- `packages/opencode/AGENTS.md` — package-level Drizzle, module shape, Effect v4 rules. Read on every wave entry.
- `GOTCHAS.md` (repo root) — append-only sharp-edges knowledge base. Read indexes on every wave entry; load specific entries via `Read GOTCHAS.md offset=<L> limit=30`.

## Specs

- `specs/codex-parity.md` — original port narrative.
- `specs/codex-parity-hardening.md` — hardening narrative.
- `specs/v2/session.md` — v2 session model background.
- This campaign's spec doc lands at `specs/replace-bash-task.md` (Wave 6).

## Test infrastructure

- `packages/opencode/test/lib/effect.ts` — `testEffect`, `it.live`, `it.instance` helpers.
- `packages/opencode/test/lib/perf.ts` — `bench`, `compareToBaseline` harness.
- `packages/opencode/test/fixture/fixture.ts` — `disposeAllInstances` and friends for hermetic test isolation.
- `packages/opencode/test/lib/stub-provider.ts` — model provider stub for runLoop tests.
