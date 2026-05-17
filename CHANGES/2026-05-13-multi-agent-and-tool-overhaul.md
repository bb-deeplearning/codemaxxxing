# Changes: Multi-agent architecture and tool surface overhaul

**Date**: 2026-05-13 through 2026-05-17
**Iteration**: [PROMPT_ITERATIONS/2026-05-13-multi-agent-and-tool-overhaul.md](../PROMPT_ITERATIONS/2026-05-13-multi-agent-and-tool-overhaul.md)

The biggest divergence from upstream OpenCode since the initial fork. We rewrote how subagents talk to each other and how the model runs shell-flavored work. Three back-to-back wave campaigns on the `codex-parity` branch, then post-campaign fixes from dogfooding. We used `openai/codex-cli` as a reference because it had already shipped these surfaces in a shape close to what we wanted, but the architecture is ours.

This entry covers everything in the fork since the [wave system entry](2026-05-06-wave-system-and-tui-overhaul.md) on 2026-05-06.

## TL;DR for users

- **Model no longer sees `bash` or `task`.** Replaced by `exec_command` plus `write_stdin` (persistent PTY) and the six v2 multi-agent tools (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`).
- **Saved permissions still work without edits.** Rules under `permission.bash: ...` transparently gate `exec_command` plus `write_stdin` (permission key collapse onto `bash` via the `SHELL_TOOLS` group). Rules under `permission.task: ...` transparently gate all six v2 multi-agent tools (permission key collapse onto `task` via the `MULTI_AGENT_TOOLS` group, mirroring the existing `EDIT_TOOLS` precedent where `edit` / `write` / `apply_patch` all consult permission key `edit`). No config migration required.
- **`tools: { bash: false }` and `tools: { task: false }`** now hide every member of their respective group from the model's tool list. Pre-campaign they hid only the literally-named tool.
- **Plugin `tool.definition` hooks for legacy IDs continue to fire** via a bridge in `tool/registry.ts:407-421`. Mutations land on `exec_command` or `spawn_agent`'s description. No plugin change required.
- **Plugin `tool.execute` hooks for legacy IDs must migrate explicitly.** Execution semantics differ between the pairs (one-shot vs persistent for shell; single-shot vs concurrent-interactive for agents). Bridging would break expectations.
- **Saved per-friend permission keys are silently inert.** Rules under `permission.spawn_agent`, `permission.send_message`, `permission.followup_task`, `permission.wait_agent`, `permission.list_agents`, `permission.close_agent` no longer match. Restate the intent under `permission.task`. Same precedent as `EDIT_TOOLS` (saved `permission.write` rules don't match `write.ts`'s asks either; those land under `permission.edit`).
- **Custom prompts that mention "the bash tool" or "the task tool"** should update to `exec_command` or `spawn_agent`. The model self-corrects in most cases.
- **`shell.ts` and `task.ts` are not deleted.** Both remain importable and callable from internal code. They're just no longer advertised to the model.

## Three campaigns plus post-campaign fixes

Each campaign shipped a full engineering reference under `specs/`. This entry summarizes; the spec docs are the file:line reference.

### Campaign 1: codex-parity (16 waves)

> Archive: `.wave/campaigns/codex-parity-2026-05-13/`
> Spec: [`specs/codex-parity.md`](../specs/codex-parity.md)

Built the new tools alongside the legacy ones. Goal: model can use them, old workflows undisturbed.

**Persistent processes.** Two new tools backed by a 64-process PTY pool with head/tail-buffered output and yield-time clamps.

**Multi-agent v2.** Six new tools backed by a per-root agent registry, per-session mailbox with monotonic seq watch for wake-ups, and a sibling-completion watcher fiber that bridges child status to parent mailbox.

**Capability hints.** `SystemPrompt.capabilityHints(agent)` injects up to three prompt fragments based on the agent's effective permission set. An agent with `exec_command: deny` doesn't get the persistent-process hint.

**Per-built-in permission defaults.** `build` and `general` allow everything new; `explore` allows messaging but not spawning/closing; `plan` denies all new tools; `compaction`, `title`, and `summary` deny everything wildcard-wise.

**TUI rendering.** New components for process tool calls, mailbox messages (cross-agent), per-session subagent status, and a `close` action on the subagent dialog.

**Test discipline.** TDD throughout. 100% line coverage per file. 10 e2e scenarios. Frozen perf baseline at 5/10/15% budget on p50/p95/p99.

**`GOTCHAS.md` knowledge base.** New file at repo root. Progressive-disclosure structure: agents load indexes (about 4 KB) first, jump to specific entries with offset reads. Captures Effect v4 renames, Bus and InstanceState lifetime traps, opentui render antipatterns, Bun coverage quirks, PTY origin gating, perf bench methodology.

### Campaign 2: codex-parity-hardening (6 waves)

> Archive: `.wave/campaigns/codex-parity-hardening-2026-05-14/`
> Spec: [`specs/codex-parity-hardening.md`](../specs/codex-parity-hardening.md)

100% line coverage shipped campaign 1. Three structural bugs survived it:

- **Bug 1: multi-chat state collision.** `AgentControl` state lived in `InstanceState` (per-directory). Two chats in the same project shared one registry; chat A's `list_agents` returned chat B's workers. Fix: per-root slot map plus `sessionToRoot` O(1) index plus `Session.Event.Deleted` teardown.
- **Bug 2: `wait_agent` always timed out.** Child `onExit` updated the child's status SubscriptionRef; parent's `wait_agent` watched parent's mailbox seq. The two ends were not connected. Fix: sibling watcher fiber per spawn that posts a notification to the parent's mailbox on final non-shutdown status.
- **Bug 3: `agent_type` validation.** Model called `spawn_agent` with codex role names (`explorer`, `worker`, `default`); opencode has no such agents. Fix (already landed at `c86c58f94`): required `Schema.String` plus per-turn description templating plus execute-body validation against the live registry.

**The discipline change.** All three bugs shared one defect mode: tests asserted primitives worked, never that scenarios worked. The hardening campaign's first-class deliverable is `INTEGRATION_INVARIANTS.md` plus the harness at `packages/opencode/test/integration/multi-agent-invariants.test.ts`. Ten invariants; each `it.instance` walks the scenario the invariant describes and asserts what the user would observe. Every wave touching multi-agent code must add at least one `it.instance` before its production code lands.

### Campaign 3: replace-bash-task (7 waves)

> Archive: `.wave/campaigns/replace-bash-task-2026-05-15/`
> Spec: [`specs/replace-bash-task.md`](../specs/replace-bash-task.md)

The new tools were shipping correctly. Time to drop the legacy ones from the model's tool list.

**Three constraints made this non-trivial:**

1. Saved `permission.bash` and `permission.task` rules must keep working without user edits.
2. Plugin `tool.definition` hooks keyed on `bash` or `task` must keep firing.
3. The legacy `.ts` files must remain importable from internal code.

**What landed:**

- Permission key collapse via `SHELL_TOOLS` (consult key `bash`) and `MULTI_AGENT_TOOLS` (consult key `task`). Mirror of `EDIT_TOOLS`.
- `disabled()` plus `resolveTools` group rules. Wildcard deny on `permission.bash` (or `tools: { bash: false }`) now hides every member of `SHELL_TOOLS`. Same for `permission.task` and `MULTI_AGENT_TOOLS`.
- `describeSpawnAgent` filter key migrated to `task` so saved per-subagent-type rules apply symmetrically to `spawn_agent` and `task`.
- `tool.shell` plus `tool.task` dropped from the registry's builtin array. Model-visible tool list no longer includes `bash` or `task`. Both files remain importable.
- Plugin bridge in `tool/registry.ts:407-421`: fires the legacy ID's `tool.definition` hook first, then the new ID's, on the same `output` reference. NOT done for `tool.execute` (execution semantics differ).
- AST scanner extracted from `shell.ts` to `tool/shell/scan.ts`. Pure refactor. 50-command differential green.
- Git safety protocol, PR creation flow, and file-op restriction prose migrated from `shell.txt` into `exec_command.txt`. Differential test asserts key fragments survive byte-identical.
- 33/33 BC matrix verified green at `artifacts/bc-verification.md`.

### Post-campaign fixes from dogfooding (3 commits, 2026-05-17)

- **`b3c32594e`.** Wake parent `wait_agent` on child self-close / sibling-close. The completion watcher's skip rule assumed `closeAgent` was parent-driven. A grandchild told "respond then close yourself" stranded the parent's `wait_agent` at full timeout. Fix: `closeAgent` takes an optional `callerID`; watcher skips notification only when caller is a strict ancestor of the target.
- **`05894e683`.** TUI cycle subagents by siblings, not root's children. `session_child_first` was re-resolving to "root + root's children" instead of drilling into the current session's direct children, so descent only worked at depth 1. Fixed both `session_child_first` and `session_child_cycle` / `_reverse` with proper sibling resolution.
- **`dd04cad1a`.** STATE reset (housekeeping after a campaign settled).

## File inventory diff vs the previous state

### New: persistent processes

- `packages/opencode/src/tool/process/exec-command.ts` + `.txt` + `.test.ts`
- `packages/opencode/src/tool/process/write-stdin.ts` + `.txt` + `.test.ts`
- `packages/opencode/src/tool/process/constants.ts` (yield-time clamps, byte caps, env overlay)
- `packages/opencode/src/tool/process/id.ts` (`PermissionKey = "bash"`)
- `packages/opencode/src/tool/process/prompt.ts`
- `packages/opencode/src/tool/process/sessions.ts` (per-instance map of model-spawned PTYs)
- `packages/opencode/src/tool/process/schema.test.ts`
- `packages/opencode/src/pty/head-tail-buffer.ts` + `.test.ts` (ported from codex)

### New: multi-agent v2 tools

- `packages/opencode/src/tool/agent-spawn/agent-spawn.{ts,txt,test.ts}` + `schema.test.ts`
- `packages/opencode/src/tool/agent-send/agent-send.{ts,txt,test.ts}` + `schema.test.ts`
- `packages/opencode/src/tool/agent-followup/agent-followup.{ts,txt,test.ts}` + `schema.test.ts`
- `packages/opencode/src/tool/agent-wait/agent-wait.{ts,txt,test.ts}` + `constants.ts` + `schema.test.ts`
- `packages/opencode/src/tool/agent-list/agent-list.{ts,txt,test.ts}` + `schema.test.ts`
- `packages/opencode/src/tool/agent-close/agent-close.{ts,txt,test.ts}` + `schema.test.ts`
- `packages/opencode/src/tool/agents/current-path.ts` + `.test.ts`

### New: multi-agent v2 infrastructure

- `packages/opencode/src/agent/control.ts` + `.test.ts` (about 1200 lines; AgentControl service)
- `packages/opencode/src/agent/mailbox.ts` + `.test.ts`
- `packages/opencode/src/agent/inter-agent-communication.ts` + `.test.ts`
- `packages/opencode/src/agent/registry.ts` + `.test.ts`
- `packages/opencode/src/agent/agent-path.ts` + `.test.ts`
- `packages/opencode/src/agent/live-agent.ts` + `.test.ts`
- `packages/opencode/src/agent/status.ts` + `.test.ts`
- `packages/opencode/src/agent/metadata.ts` + `.test.ts`
- `packages/opencode/src/agent/builtins/agent-names.ts` + `.test.ts` (nickname pool)
- `packages/opencode/src/v2/session-event.ts` + `.test.ts` (sourced log event types)
- `packages/opencode/src/v2/session-message-updater.ts`

### New: capability hint prompt fragments

- `packages/opencode/src/agent/prompt/persistent-processes.txt`
- `packages/opencode/src/agent/prompt/multi-agent-root.txt`
- `packages/opencode/src/agent/prompt/multi-agent-subagent.txt`

### New: shell scanner extraction (from `shell.ts`)

- `packages/opencode/src/tool/shell/scan.ts` + `.test.ts` (pure refactor; AST-derived patterns)
- `packages/opencode/src/tool/shell/id.ts`
- `packages/opencode/src/tool/shell/prompt.ts`
- `packages/opencode/src/tool/shell/shell.txt` (relocated)

### New: TUI multi-agent rendering

- `packages/opencode/src/cli/cmd/tui/routes/session/process-tool.tsx` + `.test.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/mailbox-message.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/subagent-status.ts` + `.test.ts`
- `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` + `subagent-footer-mount.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-subagent.tsx` + `dialog-subagent-mount.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/agent-identity.ts` + `.test.ts`
- `packages/opencode/src/cli/cmd/tui/routes/session/agent-tool.tsx` + `agent-tool-mount.tsx` + `.test.tsx`

### Modified: core wiring

- `packages/opencode/src/tool/registry.ts` (new builtins, plugin bridge, `describeSpawnAgent`)
- `packages/opencode/src/tool/shell.ts` (372 lines down to much smaller; scanner extracted out)
- `packages/opencode/src/agent/agent.ts` (per-built-in permission defaults; capability hint resolution)
- `packages/opencode/src/permission/index.ts` (`SHELL_TOOLS`, `MULTI_AGENT_TOOLS`, group `disabled()` arms)
- `packages/opencode/src/session/llm.ts` (`shellGroupDisabled` / `taskGroupDisabled` plus `resolveTools` filters)
- `packages/opencode/src/session/prompt.ts` (mailbox drain at runloop boundary; v2 dispatch branch)
- `packages/opencode/src/session/system.ts` (`capabilityHints(agent)`)
- `packages/opencode/src/pty/index.ts` (race-read, LRU pruner, `origin: "tui" | "model"`, `terminateAll`)

### New: test surfaces

- `packages/opencode/test/integration/multi-agent-invariants.test.ts` (campaign 2, 13 invariants)
- `packages/opencode/test/integration/multi-agent-tools.test.ts` (campaign 1)
- `packages/opencode/test/integration/process-tool.test.ts` (campaign 1)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts` (campaign 3, 24 invariants)
- `packages/opencode/test/integration/plugin-bridge.test.ts` (campaign 3)
- `packages/opencode/test/integration/legacy-internal-runnable.test.ts` (campaign 3)
- `packages/opencode/test/e2e/` (10 scenarios: `parallel-explorers`, `worker-pipeline`, `debate`, `observer`, `persistent-repl`, `long-running-server`, `cancellation-cascade`, `permission-denial`, `concurrent-perf-invariants`, `memory-load`)
- `packages/opencode/test/backward-compat/` (6 files: `legacy-session`, `legacy-task-tool`, `pty-existing-consumers`, `system-prompt-regression`, `plugin-hooks`, `event-replay`)
- `packages/opencode/test/differential/` (4 files: `scanner-extract.diff`, `exec-permission.diff`, `spawn-permission.diff`, `prompt-prose.diff`)
- `packages/opencode/test/perf/` (14 bench files: `agent-control`, `baseline`, `exec-command`, `head-tail-buffer`, `mailbox`, `multi-agent-render`, `process-render`, `process-tool`, `prompt-render`, `pty-read`, `registry-tools`, `registry`, `runloop-multi-agent`, `scan`, `spawn-agent`)
- `packages/opencode/test/fixtures/` (`fuzz.ts`, `generate-corpus.ts`, `load-config.{ts,test.ts}`)
- `packages/opencode/test/snapshots/capture-baseline.ts`

### New: spec docs

- `specs/codex-parity.md` (375 lines; campaign 1 engineering reference)
- `specs/codex-parity-hardening.md` (429 lines; campaign 2 engineering reference)
- `specs/replace-bash-task.md` (438 lines; campaign 3 engineering reference)

### New: root files

- `GOTCHAS.md` (about 1300 lines; sharp-edges knowledge base, progressive disclosure)

### Removed

- `CHANGES.md` (root, transient: was a partial user-facing changelog; folded into this entry under "TL;DR for users")

### Wave campaigns archived

- `.wave/campaigns/codex-parity-2026-05-13/` (16 waves, full plans + NOTES + perf artifacts)
- `.wave/campaigns/codex-parity-hardening-2026-05-14/` (6 waves)
- `.wave/campaigns/replace-bash-task-2026-05-15/` (7 waves)
