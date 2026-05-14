# Wave 1 — Bug 1: per-root AgentControl scoping

<!--
Previous waves:
- wave_0 — integration test scaffolding + bug 3 audit

Also read:
- ../../INTEGRATION_INVARIANTS.md (focus on multi-root-isolation, cross-root-send-rejection, session-deletion-cleanup)
- ../../GOTCHAS.md (CRITICAL: agentcontrol-providerref-must-live-in-layer-not-instancestate, bus-subscriber-needs-instance-state-fork-and-instance-ref, syncevent-publish-uses-top-level-bus-runtime, eventv2-and-bus-dual-emission-with-parallel-type-prefixes, bench-managed-runtime-needs-effect-scoped, subscriptionref-changes-is-top-level)
- ../../STYLE.md, TDD.md, BACKWARD_COMPAT.md, PERF.md
- .wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md
- Codex reference (READ-ONLY): /Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/control.rs lines 130-136 (per-root invariant)
-->

## Goal

Refactor `packages/opencode/src/agent/control.ts` so every `InstanceState`-held data structure is keyed per ROOT SESSION rather than per directory. After this wave: two chats opened in the same project each have their own registry, mailboxes, statuses, fibers, and rootRef; cross-root operations are rejected with `AgentNotFoundError`; session deletion tears down only that root's slot.

## Tasks

### Sub-agent A — multi-root integration tests (TDD red)

Single agent, sequential. Unskip and implement the multi-root invariant tests in `packages/opencode/test/integration/multi-agent-invariants.test.ts`:

- `multi-root-isolation` — two roots in the same project each spawn their own `worker_a`. Assert `listAgents(rootA)` shows only rootA's worker; `listAgents(rootB)` shows only rootB's worker. Send a message to rootA's worker — it lands in rootA's worker's mailbox, NOT rootB's. Close rootA's worker — rootB's worker is unaffected.
- `cross-root-send-rejection` — chat A's session calls `sendInterAgentCommunication(<chat-B-child-id>, comm)` (using rootB's child's actual SessionID — the test grabs it from the spawnAgent return). Assert the call fails with `AgentNotFoundError`. Assert rootB's child's mailbox is unchanged (drain it, length 0).
- `session-deletion-cleanup` — create rootA, spawn worker, then delete rootA via `Session.Service.remove(rootA.id)`. Sleep 50ms (per `bus-subscriber-needs-instance-state-fork-and-instance-ref` GOTCHA — let the deletion subscriber drain the event). Assert `listAgents(rootA)` returns `AgentNotFoundError` OR an empty list (whichever the implementation chooses; document the choice in MESSAGE_SHAPES.md if it lands new). RootB and its worker stay live; assert `listAgents(rootB)` still shows rootB's worker.

These tests MUST run RED against the current code (before sub-agent B's implementation). Sub-agent A commits the test file with the new tests still red — they go green when sub-agent B's implementation lands.

Test names match the invariant slugs from `INTEGRATION_INVARIANTS.md` exactly (so the verification can grep for them).

### Sub-agent B — implementation: per-root scoping in control.ts

Single agent, sequential AFTER sub-agent A's tests are red. The implementation goes in `packages/opencode/src/agent/control.ts`. Touchpoints (read each method first; the names below are the existing methods that need root-scoping):

1. **InternalState shape change.** Replace the current single-tier shape:
   ```ts
   interface InternalState {
     readonly registry, mailboxes, statuses, fibers, rootRef, scope
   }
   ```
   with a two-tier shape:
   ```ts
   interface PerRootData {
     readonly registry: AgentRegistry.Interface
     readonly mailboxes: Map<SessionID, Mailbox.Interface>
     readonly statuses: Map<SessionID, SubscriptionRef.SubscriptionRef<AgentStatus>>
     readonly fibers: Map<SessionID, Fiber.Fiber<unknown, unknown>>
   }
   interface InternalState {
     readonly perRoot: Map<SessionID, PerRootData>
     readonly sessionToRoot: Map<SessionID, SessionID>   // any session (root or subagent) → its root
     readonly scope: Scope.Scope
   }
   ```
   The `rootRef` is gone — there isn't one root, there are N. The `sessionToRoot` map is the index that lets every method resolve the caller's root from `ctx.sessionID`.

2. **registerSessionRoot(id)** — create a new `PerRootData` slot for `id`, register `id → id` in `sessionToRoot`, build a fresh `AgentRegistry`, allocate a `running` status SubscriptionRef. Idempotent: registering an already-registered root is a no-op (return existing slot).

3. **spawnAgent(input)** — resolve `input.parentID` to its root via `sessionToRoot.get(input.parentID)`. If not found AND `parentPath` is `/root`, treat `input.parentID` as the root and call `registerSessionRoot(input.parentID)` first (preserves the current line 513 idempotent-register behavior). Look up the resolved root's `PerRootData` slot. Operate on that slot's registry/mailboxes/statuses/fibers ONLY. After child session creation, register `child.id → root.id` in `sessionToRoot` so subsequent operations (`sendInterAgentCommunication`, `closeAgent`, `wait_agent`) on the child resolve to the right root.

4. **sendInterAgentCommunication(targetID, comm)** — resolve `targetID → root` via `sessionToRoot`. If not found, fail with `AgentNotFoundError`. (This is the cross-root rejection path: if the target belongs to a different root, the lookup succeeds with a different root and you'd land in the wrong slot's mailbox — instead, the lookup must verify the target's root matches the SENDER's root before touching the mailbox. See "Resolving sender root" below.) Operate on that root's mailbox map.

   **Resolving sender root.** The current method has no caller-session id. Add a third parameter `senderID: SessionID` to `sendInterAgentCommunication` (REQUIRED, no default). Update every call site:
   - `tool/agent-send/agent-send.ts` — passes `ctx.sessionID` as senderID.
   - `tool/agent-followup/agent-followup.ts` — passes `ctx.sessionID` as senderID.
   - `spawnAgent`'s seed mailbox call (`mailbox.send(...)` at the existing seed-message path inside `spawnAgent`) — uses `input.parentID` as senderID. Note: this is a mailbox-direct call, not a sendInterAgentCommunication call, so the senderID arg only flows through the public method.
   - **Test files** — substantial scope. Discover the full set with `git grep -l "sendInterAgentCommunication" packages/opencode`. As of campaign start the call sites are:
     - `src/agent/control.test.ts` (multiple)
     - `src/tool/agent-wait/agent-wait.test.ts`
     - `test/e2e/concurrent-perf-invariants.test.ts` (2 calls)
     - `test/e2e/debate.test.ts`
     - `test/e2e/memory-load.test.ts`
     - `test/e2e/observer.test.ts`
     - `test/perf/agent-control.bench.ts` (multiple)
     - `test/perf/runloop-multi-agent.bench.ts`
     - `test/session/prompt.test.ts`
     Each test passes the synthesized senderID that matches its scenario (typically the spawner's session id or the root session id).

   With senderID, the method resolves both sender's and target's roots and rejects if they differ. The interface's existing `Effect.Effect<void, AgentNotFoundError>` signature works for this — use `AgentNotFoundError` to signal the cross-root case (same shape as unknown / shutdown).

5. **closeAgent(id)** — resolve `id → root`. Operate on that root's slot.
6. **listAgents(currentPath, pathPrefix?)** — the method takes `currentPath` (the caller's `AgentPath`). Add a CALLER `senderID: SessionID` parameter (REQUIRED, no default). Resolve via `sessionToRoot`. List only that root's agents.
   - Update call sites: `tool/agent-list/agent-list.ts` passes `ctx.sessionID`.
   - **Test files** — discover via `git grep -l "listAgents\b" packages/opencode`. As of campaign start:
     - `src/agent/control.test.ts`
     - `src/tool/agent-close/agent-close.test.ts`
     - `test/integration/multi-agent-tools.test.ts`
     - `test/e2e/parallel-explorers.test.ts`
     - `test/e2e/permission-denial.test.ts`
     - `test/e2e/worker-pipeline.test.ts`
     - `test/e2e/cancellation-cascade.test.ts`
     - `test/e2e/observer.test.ts`
     - `test/perf/agent-control.bench.ts`
     - `test/session/prompt.test.ts`
     - `src/tool/agents/current-path.ts` (the helper itself does NOT call listAgents today; included for completeness if the helper grows new callers).
7. **resolveAgentReference(currentPath, reference)** — same: add `senderID: SessionID`. Operate on that root's registry.
   - Update call sites: `tool/agent-send/agent-send.ts`, `tool/agent-followup/agent-followup.ts`, `tool/agent-close/agent-close.ts`.
   - **Test files** — discover via `git grep -l "resolveAgentReference" packages/opencode`. As of campaign start:
     - `src/agent/control.test.ts`
     - `src/tool/agents/current-path.ts` and `current-path.test.ts`
     - `src/tool/agent-spawn/agent-spawn.test.ts`
8. **getAgentMetadata(id)** — `id` already identifies the agent uniquely; resolve via `sessionToRoot`. Return undefined if `id` is unknown.
9. **subscribeStatus(id), subscribeMailboxSeq(id), hasPendingMailboxItems(id), hasPendingTriggerTurn(id), drainMailbox(id)** — all take `id`. Resolve `id → root`. Look up that root's slot. Same error semantics as today (`AgentNotFoundError` when unknown; empty / false when no slot).
10. **cancelChildrenOf(parentID)** — resolve `parentID → root`. Operate on that root's slot's descendants only. (A cancel from chat A must not cascade into chat B's tree.)
11. **emitWaitStarted, emitWaitEnded** — these are pure event emitters; they take `sessionID` already. No root-scoping change needed; they fire bus events that include the sessionID and are delivered to whatever subscribers exist.

### Layer-scoped per-root teardown subscriber

Inside the `InstanceState.make` builder (where the current `Step.Started/Ended` subscribers live), add a third subscriber for `Session.Event.Deleted`:

- Construct `Inbound.SessionDeleted` as `{ type: Session.Event.Deleted.Sync.type, properties: Session.Event.Deleted.Sync.properties } as const` (matches the existing `Inbound.StepStarted/Ended` shape — see `agent/control.ts:174-183`).
- Fork a stream consumer: `bus.subscribe(Inbound.SessionDeleted).pipe(Stream.runForEach(handleDeletion))` where `handleDeletion` looks up `evt.properties.sessionID` in `data.perRoot`. If found, interrupt that root's fibers (`Effect.forEach(fibers.values(), Fiber.interrupt, { concurrency: "unbounded", discard: true })`), clear the slot's maps, release its registry's slots (best-effort: registry's internal state is cleared on disposal), delete the slot from `data.perRoot`, and remove every entry in `data.sessionToRoot` that maps to this root.
- Wrap the forked stream in `Effect.provideService(InstanceRef, ctx)` per GOTCHA `bus-subscriber-needs-instance-state-fork-and-instance-ref`.

The `data.scope` finalizer (currently lines 424-434) stays — it's belt-and-braces for instance disposal. Both finalizer paths must compose cleanly: instance disposal interrupts every fiber across every root; per-root deletion interrupts only the deleted root's fibers.

### registerRunLoop

The `providerRef` at LAYER scope (lines 356-358) STAYS exactly as it is. The provider closure is instance-agnostic — it just takes a SessionID and returns an Effect. Per GOTCHA `agentcontrol-providerref-must-live-in-layer-not-instancestate`, this MUST stay at layer scope. Do not move it into `InstanceState`.

### Updates outside control.ts

Tools that call methods whose signatures changed (added `senderID: SessionID` parameter):

- `tool/agent-send/agent-send.ts`
- `tool/agent-followup/agent-followup.ts`
- `tool/agent-list/agent-list.ts`
- `tool/agent-close/agent-close.ts` (only if it calls `resolveAgentReference` — read first)

Each call site pass `ctx.sessionID` as the new arg. Read each tool first to find the call site and the right insertion point.

The `tool/task.ts` (legacy task tool) has NO AgentControl calls — it doesn't need updates. Verify by `grep AgentControl packages/opencode/src/tool/task.ts` returning nothing.

### Update existing primitive tests

`packages/opencode/src/agent/control.test.ts` may have ~80 tests. Some assert against the single-root `data.rootRef` indirectly (e.g. assert that `listAgents` shows the root in single-root scenarios). After the refactor, all existing tests STILL pass behaviorally against the new shape (single-root scenarios still work — the refactor strictly generalizes). However, the three signature changes above (`sendInterAgentCommunication`, `listAgents`, `resolveAgentReference` each gain a required `senderID: SessionID`) will break TYPECHECK across every test file that calls them. The complete list of test files needing typecheck-fix updates is enumerated under tasks 4 / 6 / 7 above. Each test passes the appropriate session id (typically the calling root id, the spawning agent's session id, or the seeded child session id depending on scenario).

If a test fails BEHAVIORALLY because it asserted on internal shapes (e.g. `data.mailboxes.size`), update it to assert observable behavior. Do not delete any test.

The integration walkthrough at `test/integration/multi-agent-tools.test.ts` MUST continue to pass unchanged (single-root scenario; refactor invisible at single-root level). If it breaks, the refactor has a single-root regression — fix.

## Gotchas

1. **`agentcontrol-providerref-must-live-in-layer-not-instancestate`** — `providerRef` STAYS at layer scope. Moving it into `InstanceState` will crash with "No context found for instance" the moment SessionPrompt's layer init runs `registerRunLoop`. Rule: single-value, instance-agnostic state lives at layer scope. Per-instance / per-root state lives in `InstanceState`.

2. **`bus-subscriber-needs-instance-state-fork-and-instance-ref`** — the new `Session.Event.Deleted` subscriber follows the EXACT same pattern as the existing `Inbound.StepStarted/Ended` subscribers in `control.ts:394-419`: capture `ctx = yield* InstanceState.context`, fork inside `InstanceState.make`'s builder via `Effect.forkScoped(... .pipe(Effect.provideService(InstanceRef, ctx)))`. Tests must sleep 20ms after the operation that triggers the subscriber lazy-attach and another 50ms for the handler to drain.

3. **`syncevent-publish-uses-top-level-bus-runtime`** — `Session.remove` publishes `Event.Deleted` via `sync.run`, which routes through `ProjectBus.publish` (top-level helper runtime). When you write the integration test for `session-deletion-cleanup`, subscribing via the in-effect `bus.subscribeCallback` will see ZERO events. Use the top-level `Bus.subscribeAll` helper, OR — better — don't subscribe in the test at all; just `Session.Service.remove(rootID)`, sleep 50ms, then assert the per-root data is gone via the AgentControl public API. The PRODUCTION subscriber inside AgentControl is per-instance and will see the events because it's wired the right way (see Gotcha 2).

4. **`eventv2-and-bus-dual-emission-with-parallel-type-prefixes`** — the `Inbound.SessionDeleted` shape is `{ type: Session.Event.Deleted.Sync.type, properties: Session.Event.Deleted.Sync.properties } as const`. Do NOT call `BusEvent.define` for it — `SyncEvent.init` already auto-registered a BusEvent with that type. Constructing the Definition shape locally lets you subscribe without colliding.

5. **`subscriptionref-changes-is-top-level`** — if any new code subscribes to a SubscriptionRef's change stream, use `SubscriptionRef.changes(ref).pipe(...)`, NOT `ref.changes`. This wave probably doesn't add new SubscriptionRef change subscriptions; only Wave 2 does. Listed for completeness.

6. **AgentRegistry is per-root.** Each `PerRootData` slot has its OWN `AgentRegistry` instance built via `yield* AgentRegistry.make()` at slot creation. The registry's internal state (agentTree, usedNicknames, totalCount) is independent per root. This is the right behavior — codex creates one registry per root tree (`codex-rs/core/src/agent/control.rs:130-136`). Sharing one registry across roots was the bug.

7. **Spawning from a parent that's a SUBAGENT (not root).** A subagent might itself spawn a sub-subagent. The parent's session id resolves via `sessionToRoot` to its root. The sub-subagent gets registered under that same root's slot. Multi-level trees stay under one root.

8. **Idempotent `registerSessionRoot`.** Spec says idempotent — registering the same root twice is a no-op (returns existing slot). DO NOT recreate the slot on the second call; that would lose the existing mailboxes / statuses / fibers / registry. Use a guard: `if (data.perRoot.has(id)) return`.

9. **`disposeAllInstances` in tests.** Without `afterEach(disposeAllInstances)`, multi-root tests leak state across tests via the InstanceState scope. Already present in `multi-agent-invariants.test.ts` from Wave 0.

10. **Performance: extra Map lookups.** Every method now does `data.sessionToRoot.get(id) → data.perRoot.get(rootId)` instead of a direct `data.mailboxes.get(id)`. Two map lookups vs one. Per `PERF.md` Wave 1 budget, `spawn / send / list` p50 should not regress > 5%. Re-run `test/perf/agent-control.bench.ts` and verify. If it does regress, consider caching the per-session root resolution (e.g. memoize at session create time — but that's a micro-optimization; the simple two-lookup form should be well within budget on small Maps).

11. **Existing tests that rely on `rootRef` semantics.** Search `agent/control.test.ts` for `rootRef`, `registerSessionRoot`, `listAgents` — any test that assumes single-root semantics may need updating to assert the new per-root shape. The intent is that single-root scenarios still work identically.

## Verification

```bash
cd packages/opencode

# 1. Typecheck — zero errors.
bun typecheck

# 2. Lint — zero errors.
bun lint

# 3. Coverage on the touched file (single-file per `bun-coverage-aggregation-flake`).
bun test --coverage src/agent/control.test.ts 2>&1 | grep -E "control\.ts"
#    Expected: 100.00 line coverage on src/agent/control.ts

# 4. Existing primitive tests pass (no regression).
bun test ./src/agent/control.test.ts

# 5. New + existing integration tests pass (the multi-root invariants are now green).
bun test ./test/integration/multi-agent-invariants.test.ts
bun test ./test/integration/multi-agent-tools.test.ts

# 6. Perf — agent-control bench within budget vs prior campaign baseline.
bun test ./test/perf/agent-control.bench.ts
#    Manually inspect output JSON (or run baselineDelta in the bench file's
#    afterAll) and verify spawn / send / list p50 within 5% of baseline.

# 7. The full multi-agent test surface still passes.
bun test ./src/agent/
```

Coverage assertion: `src/agent/control.ts` at 100% line coverage. Function% may show < 100% due to `Schema.TaggedErrorClass` ceiling per GOTCHA `schema-class-function-coverage`.

Integration test names that MUST be green after this wave:

- `multi-root-isolation`
- `cross-root-send-rejection`
- `session-deletion-cleanup`

If any other invariant is incidentally fixed by the refactor (unlikely but possible), unskip it and verify. If any invariant test runs but still fails, the refactor is incomplete; do NOT advance the wave.

Perf assertion: `agent_control.spawn`, `agent_control.send`, `agent_control.list` within 5% of baseline p50. If any regress > 5%, document why in NOTES.md and surface as USER QUESTION. Do not silently bump the baseline.
