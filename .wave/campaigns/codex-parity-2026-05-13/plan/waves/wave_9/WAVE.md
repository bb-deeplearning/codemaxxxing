# Wave 9 — runLoop integration

**Prior waves:** 0-8. AgentControl + six tools live; legacy `task` tool still works unchanged.

**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `MESSAGE_SHAPES.md`, `BACKWARD_COMPAT.md`, `PERF.md`, `REFERENCES.md`, AND **`waves/wave_7/ADR.md`** — Wave 7 wrote an ADR documenting how it resolved the AgentControl ↔ SessionPrompt circular dependency. Read it BEFORE designing the dispatch swap; the chosen wiring shape determines how the new dispatch site invokes `AgentControl.spawnAgent`.

**MESSAGE_SHAPES.md fixes the v2 marker AND the cross-agent message injection shape** — read it before designing anything in this wave. The `protocol?: "v2"` discriminator on `SubtaskPart` and the synthetic `UserPart` shape with `metadata.from` are the contracts; both Wave 11 (TUI) and Wave 13 (backward compat) depend on these exact shapes.

**Touch points:**
- `packages/opencode/src/session/prompt.ts` — the runLoop integration site at lines 1485-1488 (subtask dispatch); the per-step model-call assembly at lines 1521 (insertReminders) and 1591-1611 (tools/system/messages composition)
- `packages/opencode/src/session/message-v2.ts` — `SubtaskPart` schema; the `synthetic` flag pattern on `TextPart`

**Codex source for context** (no direct port — codex doesn't have an opencode-shaped runLoop):
- The mailbox drain happens at codex's `Session::next_turn` boundary — read `codex-rs/core/src/session/turn.rs` if needed for context

## Goal

Make the runLoop multi-agent-aware: dispatch v2 subagent spawns concurrently via AgentControl, drain incoming mailbox messages into the model's context before each model call, preserve the legacy `task` tool path unchanged.

This is the single most invasive wave — the file under modification is 1931 lines and on a perf hot path. Read the file's existing perf comments before touching anything.

## Tasks

Sequential.

### 1. Add the v2 marker to SubtaskPart

Per `MESSAGE_SHAPES.md` § "Subtask v2 marker": add an optional `protocol?: Schema.Literal("v2")` field to `MessageV2.SubtaskPart`. Absent or any other value = v1 (legacy task tool, blocking dispatch). `"v2"` = concurrent agent spawn via AgentControl.

The marker is set by tool calls that produce subtask parts. The legacy `task` tool produces SubtaskPart with no `protocol` (continues to work). The new `spawn_agent` tool's primary path is to bypass SubtaskPart entirely and call AgentControl directly via the Effect runtime — but if a slash command (e.g. plan) wants to enqueue a v2 subtask declaratively, it produces a SubtaskPart with `protocol: "v2"`.

### 2. Tests first

Tests for:
- legacy `SubtaskPart` (no v2 marker) routes through `handleSubtask` exactly as before — existing behavior preserved
- v2-marked subtask routes through AgentControl: parent's loop does NOT block on the child; sibling fiber is spawned; parent continues
- mailbox drain step runs before each model call: pending mailbox messages are surfaced in the model's context as user-role parts (or whatever shape Wave 9 picks — see Gotcha 3)
- mailbox drain with empty mailbox is a no-op (perf guard — measured in the bench)
- abort propagates to live siblings: cancelling the parent session interrupts every child's runLoop fiber

### 3. Implement the dispatch swap

Replace the inline `yield* handleSubtask(...)` for parts with `protocol: "v2"` with a call to `AgentControl.spawnAgent`. The legacy path (no `protocol` field) stays. Document the marker check inline in code comments referencing `MESSAGE_SHAPES.md`.

### 4. Implement the mailbox drain

Before each model call (around line 1521), drain the current session's mailbox via `AgentControl.drainMailbox(sessionID)`. Convert each drained `InterAgentCommunication` into a synthetic `MessageV2.UserPart` with the metadata shape spec'd in `MESSAGE_SHAPES.md` § "Cross-agent message injection". Prepend `[from <author>]: ` to the text body so the model sees the source clearly.

The drain must be cheap when the mailbox is empty (Wave 11's TUI bench measures this; Wave 14's perf audit verifies).

### 5. Preserve everything else in runLoop

`handleSubtask` stays. `insertReminders` stays. `compaction.process` stays. The model-call composition stays. The exit conditions at 1463-1471 stay (with the new condition: don't exit if mailbox has pending `trigger_turn` messages — see Gotcha 5).

### 6. Bench

File: `packages/opencode/test/perf/runloop-multi-agent.bench.ts`

- `runloop.step.empty_mailbox` — runLoop step with empty mailbox; must not regress vs Wave 0 baseline `runloop.step.no_op`
- `runloop.step.4_pending_mailbox` — runLoop step with 4 pending messages; measure overhead
- `runloop.spawn_v2` — spawn one v2 subagent, verify parent doesn't block

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_9.json`. Compare `runloop.step.empty_mailbox` vs baseline; budget applies.

## Gotchas

1. **Read the runLoop perf comments first.** `prompt.ts` is hand-tuned; `routes/session/index.tsx` lines 134-154, 240-242 explain the same class of issue from the TUI side. The runLoop has similar landmines on its own.

2. **Backward compat is the dominant constraint.** Any path that worked before this wave must still work. The legacy `task` tool produces `SubtaskPart` with no v2 marker — it must still go through `handleSubtask`.

3. **Mailbox drain shape is fixed.** See `MESSAGE_SHAPES.md` § "Cross-agent message injection". Synthetic `MessageV2.UserPart` with `metadata.from`, `metadata.sent_at`, `metadata.trigger_turn`. Text body is `"[from <author>]: <content>"`. Wave 11's TUI renderer reads this exact shape; Wave 13's backward-compat tests assert UserParts WITHOUT `metadata.from` render as before.

4. **Drain order = delivery order.** Mailbox.drain returns messages in delivery order (Wave 5). Surface them in that order.

5. **Don't exit while mailbox has trigger_turn messages.** The exit-on-finish check at lines 1463-1471 currently only looks at the model's finish reason. After this wave, also check `mailbox.hasPendingTriggerTurn()` — if true, the assistant said "done" but a sibling has queued work for us; we keep looping.

6. **Concurrent siblings share `InstanceState` (DB, Snapshot, Plugin, Bus).** Each sibling has its own Runner (per `SessionRunState` design), but the underlying services are shared. Snapshot in particular: if sibling A and sibling B both call `Snapshot.track`, the resulting diffs may overlap. For Wave 9, document this in NOTES.md if you observe it; Wave 14's E2E tests will exercise it. Don't try to "fix" Snapshot in this wave — that's a separate scoping decision.

7. **Permission propagation.** Spawned children inherit the parent's permission ruleset (already done by `task.ts:73-100`). Wave 12 handles role-specific overlays. Wave 9 just makes sure the inheritance still happens via AgentControl.spawnAgent.

8. **Bus event volume.** Multi-agent runs produce N× the events of single-agent. The Bus handles fan-out fine; verify with the bench in Wave 14.

9. **`Effect.forkIn(parentScope)` is the right primitive.** When the parent's scope dies (session cancel, error, end), every child fiber dies. This is the lifecycle invariant. Test it: spawn 3 children, cancel the parent, verify all 3 fibers are interrupted.

10. **Working tree is clean between sessions.** This wave's commit must keep `bun typecheck` clean. The 1931-line file under edit is a typecheck stress test — be careful with imports and Effect type inference.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# the runLoop changes themselves
bun test src/session/prompt.test.ts  # if exists, otherwise create as part of this wave's tests

# 100% coverage on the modified runLoop region (lines you touched)
# Use a coverage report focused on prompt.ts and assert no drop on the touched lines.

# perf bench
bun test test/perf/runloop-multi-agent.bench.ts
bun -e "
  const { compareToBaseline } = await import('./test/lib/perf.ts')
  const wave = JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_9.json').text())
  const r = compareToBaseline(wave.metrics['runloop.step.empty_mailbox'], '../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json', 'runloop.step.no_op')
  if (!r.passed) { console.error(r.reasons); process.exit(1) }
"

# legacy task tool still works
bun test src/session/  # full session test suite
```

All exit 0.

## Files

New:
- `packages/opencode/test/perf/runloop-multi-agent.bench.ts`
- (plus any new test files you add for the runLoop changes)
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_9.json`

Modified:
- `packages/opencode/src/session/prompt.ts` — dispatch swap + mailbox drain
- `packages/opencode/src/session/message-v2.ts` — if you choose to extend SubtaskPart with a v2 marker, that lives here
