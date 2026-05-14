# Backward compatibility — what must keep working

Carries forward from `.wave/campaigns/codex-parity-2026-05-13/plan/BACKWARD_COMPAT.md`. This campaign refactors `AgentControl` (Bug 1) and adds a completion watcher (Bug 2). Neither is allowed to break:

1. The legacy `task` tool's input/output/blocking behavior.
2. Any session created before this campaign — load, render, run-loop continuation.
3. The existing six multi-agent v2 tools' input/output/permission behavior.
4. Existing Pty consumers (TUI / desktop callers).
5. Plugin authors using `tool.execute.before/after` hooks.
6. The TUI subagent navigation keybinds.

If any of these break, the wave fails.

## Non-removal list

Do not remove, rename, or change the signature of:

- `AgentControl.Service` interface methods. **Caveat:** the AgentControl.Service interface is INTERNAL to the `packages/opencode` workspace — no plugin / desktop / external consumer reads it directly. Wave 1 explicitly adds a required `senderID: SessionID` parameter to three methods (`sendInterAgentCommunication`, `listAgents`, `resolveAgentReference`) as part of the per-root resolution refactor. That signature growth is permitted because (a) every in-tree caller is updated in the same wave, and (b) the user-observable surface — the v2 multi-agent tools' input parameters, output JSON, error tags, permission keys, and emitted Bus event shapes — stays unchanged. New methods may be ADDED freely. Existing methods (`registerSessionRoot`, `spawnAgent`, `closeAgent`, `getAgentMetadata`, `subscribeStatus`, `subscribeMailboxSeq`, `hasPendingMailboxItems`, `hasPendingTriggerTurn`, `drainMailbox`, `cancelChildrenOf`, `emitWaitStarted`, `emitWaitEnded`, `registerRunLoop`) keep their signatures unchanged. Wave 1's per-root refactor changes the INTERNAL implementation of every method; only the three listed above gain a new required parameter.
- `Pty.Service` methods (`list`, `get`, `create`, `update`, `remove`, `resize`, `write`, `connect`).
- `Pty.Info` schema fields.
- `Pty.Event.Created/Updated/Exited/Deleted` payloads.
- `Tool.Context` interface.
- `Session.Service` interface.
- `MessageV2.Part` discriminated union (no removed variants; add new fields only as `Schema.optional`).
- `Tool.define` signature.
- `Session.create({parentID})` shape — the legacy `task` tool's path through `task.ts:70` must still work.
- `Permission.ask` signature.
- The legacy `task` tool — KEEP IT IN THE REGISTRY.

## Schema compatibility

No schema changes in this campaign. Bug 1 is a per-root scoping refactor — internal Map keying changes but no externally-observable schema shape. Bug 2 adds a sibling watcher fiber that sends an existing `InterAgentCommunication` shape (no new fields).

If any wave thinks it needs a new field on a persisted shape, it doesn't. Surface as USER QUESTION.

## Migration policy

This campaign produces NO Drizzle migrations. None.

- All AgentControl state is in-memory (now per-root inside `InstanceState`).
- Mailboxes are in-memory.
- Statuses, fibers are in-memory.
- The completion-watcher fiber is in-memory (forked into the existing `data.scope`).

If a wave thinks it needs a migration, that wave is doing something wrong.

## Existing test suite

Before merging anything, the entire pre-existing test suite must still pass. Wave 4 dedicates its verification to this:

```bash
cd packages/opencode
bun test
```

Test counts as of campaign start (commit `c86c58f94`):

- ~80 tests in `agent/control.test.ts`
- ~22 tests in `mailbox.test.ts`
- ~70 tests in `registry.test.ts`
- ~3 tests in `test/integration/multi-agent-tools.test.ts`
- ~12 e2e tests in `test/e2e/`
- ~62 backward-compat tests across 6 files

Wave 1 + Wave 2 may need to UPDATE some primitive tests in `agent/control.test.ts` if they assert on internal state shapes that the per-root refactor changes (e.g. an assertion against `data.mailboxes.size` becomes per-root). Update to assert observable behavior; do not delete.

The existing `test/integration/multi-agent-tools.test.ts` walk-through (spawn → send → list → wait → followup → close) MUST continue to pass unchanged. It uses one root only — Wave 1's refactor is invisible at the single-root level.

## Behavioral compat

These behaviors MUST be observable identically before and after this campaign:

1. `task` tool with `description: "x"`, `prompt: "y"`, `subagent_type: "explore"` → returns the same `<task_result>` envelope shape.
2. `Session.cancel` interrupts the runLoop → same as before.
3. Permission denials propagate as `Permission.RejectedError` → same as before.
4. Snapshot/patch tracking at tool-call boundaries → same as before; concurrent siblings' snapshots stay scoped to their own session.
5. TUI subagent navigation keybinds (`session.parent`, `session.child.next`, `session.child.previous`, `session.child.first`) work — same as before.
6. The six v2 multi-agent tools' input parameters, permission keys, output JSON shape, error tag set — all unchanged.
7. The `Bus.Event` definitions exported by `agent/control.ts` (`Event.SpawnStarted`, `Event.SpawnEnded`, `Event.Closed`, `Event.WaitStarted`, `Event.WaitEnded`, `Event.MessageSent`) — same payload shape. Wave 2 may emit additional `Event.MessageSent` events (the watcher's notification routes through `sendInterAgentCommunication` which already publishes that event); subscribers see the same event type for both user-initiated sends and watcher-initiated notifications.

## What this campaign IS allowed to change

- The internal shape of `AgentControl`'s `InstanceState` (Wave 1).
- The internal forking topology inside `spawnAgent` (Wave 2 adds a sibling watcher fiber).
- Test files that assert on internal state shapes — update them to assert observable behavior.
- The cross-agent message NOTIFICATION body shape (the new "Agent <path> reached status: <label>" body) — this is a NEW body the watcher produces; it doesn't change any existing message body.
