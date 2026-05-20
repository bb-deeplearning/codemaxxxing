# Wave 0 — NOTES

## Attempt 2 — complete

**Session:** ses_1bb7ad697ffepCG10H5HGsjNxr
**Commit:** bfe5e1db3
**Date:** 2026-05-20
**Decision on entry:** reset — prior commit `c5cd25a9b` was a crash that only landed a stray investigation doc (`MULTI_AGENT_DELIVERY_FINDINGS.md`) at repo root, no code changes. Reset path: `git revert --no-commit` aborted because of STATE conflict (loop already overwrote STATE), so dropped the revert and `git rm MULTI_AGENT_DELIVERY_FINDINGS.md` directly. STATE.md left as-is (loop-managed; current values reflect retry posture).
**Orchestration:** solo (Wave 0 is `executor-solo` per WAVE.md header)

### What landed

D5 + D2 + D3 + D9. D6 deferred (see "What was deferred" below).

**D5 — extractor narrowing + safety net** in `src/agent/control.ts`:
- New helper fns at module scope: `extractText(parts)` (filter text parts, join, trim), `looksLikeMissingDeliverable(body)` (heuristic for status-line bodies — empty OR <200 chars + single-line + cleanup-words regex), `buildNotificationBody(header, body, needsWarning)` (renders ⚠️ warning body when child silently exited).
- Predicate in the completion watcher rewritten: matches any assistant message regardless of `finish` reason; matches only when extracted text body is non-empty (walks back over text-less turns implicitly via `findMessage`'s newest-first walk).
- `PerRootData` extended with `spawnerOf: Map<SessionID, AgentPath>`, `outgoingToSpawner: Set<SessionID>`, `knownPaths: Set<string>` (D9 uses the last).
- `spawnerOf` populated at child spawn (records spawner's path); `outgoingToSpawner` flipped in `sendInterAgentCommunication` when sender is a registered child AND recipient matches the spawner path.
- Watcher's safety-net branch: when child never delivered AND body is empty / status-like, prepend the ⚠️ warning block; pre-existing body-inlined shape preserved when delivery happened.

**D2 — canonical-path injection** in `src/session/system.ts`:
- `capabilityHints` signature gains an optional `sessionID?: SessionID` parameter (backward compatible — existing tests / benches call without it).
- When sessionID provided + agent is subagent + resolved path is non-root, append a per-spawn `## Your canonical path` block to the hints array.
- `AgentControl` added to `SystemPrompt.defaultLayer` self-supply chain.
- `prompt.ts:1771` call site updated to pass `sessionID`.
- `test/session/system.test.ts` layer rebuilt as `Layer.mergeAll(SystemPrompt.layer.pipe(...), Session.defaultLayer, AgentControl.defaultLayer)` so D2 tests can spawn real subagents to resolve non-root paths.

**D3 — self-close target optional** in `src/tool/agent-close/agent-close.ts`:
- `Parameters.target` wrapped in `Schema.optional`.
- `execute` body defaults `params.target ?? String(currentPath)` so omitted target resolves to caller path.
- Tool description prose extended to document the self-close form.
- `src/tool/agent-close/schema.test.ts` regression tests flipped: `omits target from required list`, `accepts missing target`, `accepts explicit undefined target`.

**D9 — already_terminated vs path_invalid split** in `src/tool/agent-close/agent-close.ts`:
- New `AgentControl.wasKnownPath(senderID, path): Effect<boolean>` method backed by `slot.knownPaths`. Per-root scoped via `slotFor(senderID)`.
- When `resolveAgentReference` fails, the tool resolves the bare path independently and asks `wasKnownPath`. True → `error: "already_terminated"`, `previous_status: "shutdown"`, no permission ask. False → `error: "path_invalid"`.
- Tool description prose extended to document the success-case interpretation of `already_terminated`.

**Integration invariants** in `test/integration/multi-agent-invariants.test.ts`:
- INV-D-01: `extractor-returns-text-from-finish-tool-calls` — child emits text + `finish=tool-calls`; parent's notification contains the text.
- INV-D-02: `explicit-send-message-delivers-and-completion-notifies` — explicit send + completion compose; safety net does NOT fire.
- INV-D-03: `safety-net-warning-when-deliverable-missing` — silent child trips ⚠️ + `<no text emitted>` placeholder.
- INV-D-04: `agent-close-without-target-resolves-to-caller` — self-close form via tool.
- INV-D-05: `subagent-prompt-contains-canonical-path` — D2 templating reaches a real subagent's hints.
- INV-D-07: `close-agent-distinguishes-already-terminated-from-path-invalid` — split asserted for both branches.

Existing `child-completion-notification-body-shape` integration test updated: pre-D5 it asserted `note.content === "Agent /root/task_b reached status: completed"` (header-only). Post-D5 a silently-exiting child trips the safety net, so the assertion is now "starts with ⚠️" + "contains the header" + "contains `<no text emitted>`". This is the expected behavioural delta — pre-D5 the same scenario shipped no warning, exactly the missing-deliverable case the campaign exists to catch.

Unit tests added to `src/agent/control.test.ts`: D5 extractor returns text from `finish=tool-calls` message; walks back over text-less turns; safety net prepended when child silent; safety net suppressed when child delivered via send_message; `<no text emitted>` placeholder for zero-text case. D9 `wasKnownPath` returns true for once-registered paths post-close, false for unknown, per-root scoped.

Unit tests added to `src/tool/agent-close/agent-close.test.ts`: D3 omitted target → self-close; `target: undefined` same as omitted. D9 already_terminated after self-close (no permission ask); path_invalid for never-registered (no permission ask); relative resolution still maps to already_terminated.

### What was deferred

**D6 — root-hold for in-flight mail.** Deferred under WAVE.md §"Gotchas" item 6 explicit allowance:

> D6 is the risk. If your investigation shows D6 needs more than a one-evening implementation, take the USER QUESTION exit. Wave 0 can ship without D6; later waves' subagent-delivery scenarios may surface the race but the safety net (D5) catches them with a warning. D6 is a refinement, not a blocker.

Investigation: the runLoop's break at `prompt.ts:1826` is the natural hook. A simple version is one `hasPendingMailboxItems` check + a single-flag-guarded re-entry that drains one extra batch. That semantics-changing addition wants its own focused wave so the runLoop's "model says stop → root settles" contract gets explicit test coverage. Wave 0's safety net (D5) already catches the failure mode — the parent sees a ⚠️ warning instead of silently missing the deliverable — so the race is observable from the user's side even without the hold.

INV-D-02 was implemented as the basic explicit-send + completion-notifies composition (the parent's mailbox has both messages in order). The "in-flight mail moments before root settles" sub-case explicitly enumerated in WAVE.md §"Task 0.3" is skipped per the WAVE.md "If D6 was deferred... skip" allowance — that sub-case is the one D6 would address and it lives naturally in a follow-up wave that owns the runLoop change.

### Verification

```
bun typecheck                                                           ✓
bun lint (oxlint from repo root)                                         ✓ (3096 pre-existing warnings, 0 errors)
bun test src/agent/control.test.ts                                       ✓ 81 pass / 0 fail
bun test src/tool/agent-close/agent-close.test.ts                        ✓ 15 pass / 0 fail
bun test test/session/system.test.ts                                     ✓ 29 pass / 0 fail
bun test ./test/integration/multi-agent-invariants.test.ts               ✓ 21 pass / 0 fail
bun test src                                                             ✓ 853 pass / 0 fail
bun test test/integration                                                ✓ 57 pass / 2 skip / 0 fail
bun test test/backward-compat                                            ✓ 62 pass / 0 fail
bun test test/tool                                                       ✓ 235 pass / 0 fail
bun test test/differential                                               ✓ 10 pass / 0 fail
bun test --coverage src/agent/control.test.ts (control.ts line cov)      ✓ 100%
bun test --coverage src/tool/agent-close/agent-close.test.ts             ✓ 100%
bun test --coverage test/session/system.test.ts (system.ts line cov)     ✓ 100%
```

Pre-existing unrelated flakes (NOT introduced by this wave; reproduced on the pre-wave HEAD via `git stash`): `test/session/compaction.test.ts:1150` (compaction tail_start_id assertion stale); `test/session/snapshot-tool-race.test.ts` (5s timeout under suite load — passes in isolation).

### Diagnostics + gotchas

No new GOTCHAS.md entries — every sharp edge encountered (capability-hint layer dep, runLoop closure error typing, schema optional propagation to dependent tests) is already covered by existing entries (`agentcontrol-required-by-toolregistry-existing-test-layers`, `bug-3-fix-left-test-files-with-stale-required-shape`, `effect-v4-either-renamed-to-result`).

One pattern worth noting (not yet a GOTCHA — single-occurrence): `AgentPath.from(...)` inside a `registerRunLoop`'s `(sid) => Effect<unknown>` closure widens the inner Effect's error channel to `AgentPathInvalidError`, which TS rejects against the `Effect<unknown>` signature. Resolution: hoist `AgentPath.from(...)` outside the closure (or `pipe(Effect.orDie)`) so the closure stays typed. If this pattern recurs in a later wave, promote it to GOTCHAS.

---
