# Wave 13 — Backward compat verification

**Prior waves:** 0-12. All implementation done; this wave is the safety net before E2E.

**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `BACKWARD_COMPAT.md`.

## Goal

Verify nothing pre-existing broke. Comprehensive sweep across the surfaces named in `BACKWARD_COMPAT.md`. This wave is read-heavy and test-heavy; very little new code.

## Tasks

### 1. Build a comprehensive synthetic fixture

Create `packages/opencode/test/backward-compat/snapshot/legacy-session.json` — a hand-built fixture representing a session as it would have existed BEFORE this campaign. It must contain at least one of every `MessageV2.Part` variant the system supports today:

- `TextPart` (user-typed and assistant-generated)
- `ReasoningPart`
- `ToolPart` for several tools (read, edit, bash, todowrite, task)
- `StepStartPart` + `StepFinishPart`
- `SnapshotPart` + `PatchPart`
- `FilePart`
- `AgentPart`
- `RetryPart`
- `CompactionPart`
- `SubtaskPart` (legacy task tool, no `protocol` field)

Plus a session record with `parentID` set (to exercise sub-session loading) and one without. Permission ruleset using the pre-campaign permission keys only (no `exec_command`, no `spawn_agent`, etc.).

The fixture is JSON shape — the exact rows that would have lived in `session.sql.ts`'s `session`, `message`, `part` tables. A test loader hydrates them via `Session.Service.updateMessage` / `updatePart` into a temp DB and then reads them back via `Session.get` / `Session.messages`.

A synthetic fixture beats a captured-real-session fixture for this purpose: hermetic, version-controlled, every variant explicitly represented, no dependency on git checkout dance.

### 2. Tests

Cover at minimum:

- **Schema parsing**: every `MessageV2.Part` variant (Text, Subtask, Reasoning, File, Tool, StepStart, StepFinish, Snapshot, Patch, Agent, Retry, Compaction) parses from the legacy snapshot without error
- **Session loading**: load the legacy session through `Session.get` + `Session.messages` end-to-end; verify it matches the snapshot
- **Legacy `task` tool**: invoke `TaskTool.execute` with the same input shape it always took (`description`, `prompt`, `subagent_type`); verify it returns the same `<task_result>` envelope output
- **Pty existing consumers**: the existing HTTP+WS routes for desktop (`server/routes/instance/pty.ts`) — exercise via test client; verify schema and behavior unchanged
- **System prompts for agents without new permissions**: snapshot the system prompt for `build` with default config (which DOES enable new perms); then snapshot for a custom agent with the new perms disabled; assert the disabled version matches a pre-campaign baseline (capture this baseline as part of this wave)
- **EventV2 events for old session activities**: replay the legacy session events through the EventV2 system; verify no new event types are emitted spuriously
- **Bus events for old session activities**: same as EventV2

### 3. Existing test suite

Run the pre-existing test suite top-to-bottom. Anything that was passing before this campaign must still pass.

```bash
cd packages/opencode
bun test  # full suite
```

If any pre-existing test fails, the wave fails. Diagnose, fix, retry.

### 4. Manual smoke test (documented, not automated)

Boot the TUI against the legacy snapshot directory. Verify:
- Session list shows the legacy session
- Selecting it renders the transcript correctly
- Subagent footer doesn't break for non-subagent sessions
- Existing keybindings work

Document the smoke test results in NOTES.md or a `manual-smoke.md` artifact. Automated assertions for TUI smoke aren't worth the lift for a one-shot verification.

## Gotchas

1. **Synthetic fixture is comprehensive, not minimal.** Every part variant listed in step 1 must appear at least once. Missing variants is how schema-compat regressions slip through.

2. **MessageV2 schema additions must be `Schema.optional`.** If any wave added a required field, this wave catches it (the legacy snapshot won't have it). Failing tests here mean a wave somewhere broke compat — root-cause and fix in a follow-up commit on this wave.

3. **Pre-existing test failures.** If a pre-existing test fails after the campaign, it's a sign the campaign changed observable behavior somewhere. Don't update the test to make it pass — that's the wrong direction. Find the changed behavior, fix it (or USER QUESTION if it's intentional and the test is now the wrong oracle).

4. **The TUI render bench should still hit baseline numbers for non-subagent sessions.** Wave 11 already verified this; re-run as part of this wave's verification just to be sure.

5. **Plugin authors using `tool.execute.before/after`.** If a plugin author hooks `task`'s execute callbacks, those must still fire with the same payload shape. Cover this in a test: simulate a plugin subscribing to the hook; invoke `task`; verify the hook fires with the legacy payload.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# Full pre-existing suite
bun test

# Backward compat suite
bun test test/backward-compat/

# Render bench for non-subagent sessions (should match baseline)
bun test test/perf/baseline/session-render.bench.ts
bun -e "
  // re-run a comparison; any single-session metric > baseline×1.05 fails this wave
"
```

All exit 0.

## Files

New:
- `packages/opencode/test/backward-compat/snapshot/legacy-session.json`
- `packages/opencode/test/backward-compat/legacy-session.test.ts`
- `packages/opencode/test/backward-compat/legacy-task-tool.test.ts`
- `packages/opencode/test/backward-compat/pty-existing-consumers.test.ts`
- `packages/opencode/test/backward-compat/system-prompt-regression.test.ts`
- `packages/opencode/test/backward-compat/plugin-hooks.test.ts`
- (possibly) `manual-smoke.md` notes in NOTES.md or as a sibling artifact

Modified: probably none. If a wave-N regression surfaces, you may need a fix commit on this wave.
