# Wave 2 — Bug 2: completion watcher wakes parent on child final status

<!--
Previous waves:
- wave_0 — integration test scaffolding + bug 3 audit
- wave_1 — per-root scoping in AgentControl

Also read:
- ../../INTEGRATION_INVARIANTS.md (focus on child-completion-wakes-parent, child-completion-notification-body-shape, child-fiber-interrupt-during-wait)
- ../../GOTCHAS.md (CRITICAL: subscriptionref-changes-is-top-level, bench-managed-runtime-needs-effect-scoped, bench-effect-runpromise-loses-instance-in-async-callback)
- ../../STYLE.md, TDD.md, BACKWARD_COMPAT.md, PERF.md
- ../../MESSAGE_SHAPES.md § "NEW: completion notification body shape (Wave 2)" — load-bearing for the body shape
- Codex reference (READ-ONLY): /Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/control.rs lines 943-1015 — maybe_start_completion_watcher
-->

## Goal

Add a sibling watcher fiber forked at every `spawnAgent` call that sends an `InterAgentCommunication` to the PARENT's mailbox when the child reaches a final status. After this wave: the parent's `wait_agent` returns within ~100ms of child completion (currently waits the full 30s timeout); the watcher follows the body shape defined in `MESSAGE_SHAPES.md`; close-triggered shutdowns are skipped; multiple children completing concurrently each fire their own notification.

## Tasks

### Sub-agent A — completion-watcher integration tests (TDD red)

Single agent, sequential. Unskip and implement the completion-watcher invariant tests in `packages/opencode/test/integration/multi-agent-invariants.test.ts`:

- `child-completion-wakes-parent` — register a stub run-loop that completes after a 50ms sleep (returns Effect.void → fiber.onExit sets status to `{ completed: null }`). Spawn child. Time `wait_agent.execute({ timeout_ms: 30_000 }, parentCtx)`. Assert `metadata.timed_out === false` and elapsed wall time < 500ms.
- `child-completion-notification-body-shape` — same setup as above. After `wait_agent` returns, drain the parent's mailbox. Assert exactly one message with `content === "Agent /root/<task_name> reached status: completed"`, `author === childPath`, `recipient === parentPath` (or `/root` if parent is root), `trigger_turn === false`.
- `child-fiber-interrupt-during-wait` — register a stub run-loop that runs forever (`Effect.never`). Spawn child. Fire `wait_agent` in a fork (or use a separate effect with a long timeout). After 50ms, call `closeAgent(childID)`. Per `MESSAGE_SHAPES.md`'s "Skip rule: closeAgent-triggered shutdown", the watcher MUST NOT fire a notification when the child's status reaches `shutdown` (closeAgent is the only path that sets that status). Assert: `wait_agent` returns `timed_out=true` (no notification fires; the wait runs out the timeout). Drain the parent mailbox after the wait returns: 0 notifications. To keep the test fast, configure the wait_agent timeout near the floor (e.g. `1000` clamps to MIN — that's the minimum the wait can return on the timeout branch).

These tests MUST run RED against the current code (before sub-agent B's implementation). The current code's wait_agent times out; the tests assert it doesn't.

### Sub-agent B — completion watcher implementation in control.ts

Single agent, sequential AFTER sub-agent A's tests are red. The implementation goes in `packages/opencode/src/agent/control.ts` inside the existing `spawnAgent` method's `acquireUseRelease` `use` block.

Location: just after the `data.fibers.set(child.id, fiber)` line (currently around `control.ts:611`), before the status-mark-running block. After the per-root refactor in Wave 1, the location is the same logical spot inside the slot-resolved spawn flow.

Add a sibling watcher fiber:

```ts
// Sibling completion watcher. Mirrors codex maybe_start_completion_watcher
// (codex-rs/core/src/agent/control.rs:943-1015): when this child reaches a
// final status, send a notification to the parent's mailbox so wait_agent's
// seq watch wakes. Forked into data.scope so the watcher dies with the
// instance and doesn't outlive the parent root.
//
// Skip on shutdown: closeAgent sets status to "shutdown" before interrupting
// the run-loop fiber. The parent invoked the close itself; a notification
// here would be confusing. See MESSAGE_SHAPES.md § "Skip rule".
yield* Effect.forkIn(data.scope)(
  Effect.gen(function* () {
    // Wait for the status to reach a final value. SubscriptionRef.changes
    // emits the current value first, so we drop(1) and look at every
    // subsequent transition until isFinal.
    yield* Stream.runForEach(
      SubscriptionRef.changes(status).pipe(Stream.drop(1)),
      (next) =>
        Effect.gen(function* () {
          if (!AgentStatus.isFinal(next)) return
          // Skip shutdown — closeAgent triggered this; don't double-notify.
          if (next === "shutdown") return Effect.interrupt as never
          const label = statusLabel(next)
          // Look up the parent's path. If the parent is root, that's
          // /root; otherwise the parent's metadata gives its path.
          // For root parents we still call sendInterAgentCommunication
          // with the parent's session id; the routing inside that method
          // resolves the right per-root mailbox (the parent's, not the
          // child's).
          const parentMeta = yield* sendOrSkip(input.parentID, child.id, childPath, parentPathFor(input.parentID, input.parentPath), label)
          // Once we've sent (or skipped), interrupt the watcher — the child
          // can only have one final status.
          return Effect.interrupt as never
        }),
    )
  }),
)
```

Helper function `statusLabel(s: AgentStatus): "completed" | "errored"` — pure mapping per `MESSAGE_SHAPES.md`:

```ts
function statusLabel(s: AgentStatus): "completed" | "errored" {
  if (typeof s === "object" && "completed" in s) return "completed"
  if (typeof s === "object" && "errored" in s) return "errored"
  // Defensive fallback. The watcher only invokes statusLabel after gating
  // on `AgentStatus.isFinal(next) && next !== "shutdown"`. Per
  // agent/status.ts:49-52 the non-final set is { pending_init, running,
  // interrupted } — none of these reach this branch. The remaining final
  // statuses are { completed, errored, shutdown, not_found }; shutdown is
  // skipped above and not_found is unreachable via the SubscriptionRef
  // (the ref starts at "pending_init" and is only set by onExit /
  // closeAgent). The "errored" fallback is structurally defensive.
  return "errored"
}
```

Helper `parentPathFor(parentID, parentPath)`: returns `parentPath` if non-root; returns `AgentPath.root()` if `parentID === root` (resolved via the per-root data's known root id). The existing `input.parentPath` is what was passed in by the spawn caller; for AgentPath.root() the recipient is `/root`.

The notification send uses `sendInterAgentCommunication(targetID = input.parentID, comm)`. Per Wave 1's signature, `senderID` is the new third arg — pass `child.id` (the child IS the sender; the message is FROM the child).

Construct the InterAgentCommunication:

```ts
new InterAgentCommunication({
  author: childPath,
  recipient: parentPathFor(input.parentID, input.parentPath),
  content: `Agent ${String(childPath)} reached status: ${label}`,
  trigger_turn: false,
  sent_at: Date.now(),
})
```

Wrap the send in `.pipe(Effect.catch(() => Effect.void))` because if the parent has been deleted between the child completing and the watcher firing, the send fails with `AgentNotFoundError` — that's fine, just absorb it (the parent is gone; nothing to wake).

### Watcher fiber teardown

The watcher is forked via `Effect.forkIn(data.scope)`. Per the existing pattern at `control.ts:609`, this ties the watcher to the per-root scope (post Wave 1). When the per-root data is torn down (root deletion), the scope dies, the watcher dies. No explicit cleanup needed.

### Update wait_agent.txt prompt prose

The agent-wait prompt at `packages/opencode/src/tool/agent-wait/agent-wait.txt:36-37` currently promises:

> Otherwise blocks until ANY mailbox seq update — a queued message, a follow-up task, or a final-status notification from a sibling.

The "final-status notification from a sibling" part finally exists after this wave. The prose was aspirational; now it's accurate. NO PROSE CHANGE NEEDED — the doc already describes the post-fix behavior. Verify by re-reading the file; if your reading suggests a prose update would clarify, propose it in the wave's commit message but DO NOT change the file in this wave (changing prompt prose is a tested behavior — would need its own snapshot test).

### Update existing primitive tests

`packages/opencode/src/agent/control.test.ts` may have tests that assert `wait_agent`'s timeout behavior (the old "always-times-out" semantic). After this wave, those tests need updating: in any test where a child completes naturally during a wait, the new expectation is that wait returns timed_out=false. Read each test that exercises wait_agent + spawn together and update accordingly. Tests that ONLY use `wait_agent` (no child to fire a notification) are unchanged.

The integration walkthrough at `test/integration/multi-agent-tools.test.ts` has a specific wait test (`step 4: wait_agent`) where the child is `installNeverLoop` — never completes. That test STAYS AS-IS — its `timed_out: true` expectation remains correct because the child never finishes.

### NO new dep on agent-wait.ts

The completion-watcher implementation is entirely inside `control.ts`. `agent-wait.ts` doesn't change — it already subscribes to the parent's mailbox seq watch, which now advances when the watcher sends. Verify by `git diff` — `agent-wait.ts` should be unchanged after this wave.

## Gotchas

1. **`subscriptionref-changes-is-top-level`** — use `SubscriptionRef.changes(status).pipe(...)` (top-level helper), NOT `status.changes`. The latter doesn't exist on Effect v4 SubscriptionRef and crashes at runtime with a TypeError.

2. **`bus-subscriber-needs-instance-state-fork-and-instance-ref`** — the watcher fiber resolves `sendInterAgentCommunication` which reads `InstanceState.get(state)`. The fiber is forked via `Effect.forkIn(data.scope)` — `data.scope` was captured inside `InstanceState.make`'s builder, so the forked fiber inherits the instance binding. Per the gotcha, `Effect.forkScoped` is the OTHER pattern (for layer-init forks). `Effect.forkIn(data.scope)` is correct for this case because we have the per-root scope in hand.

3. **Skip on shutdown.** `AgentStatus.isFinal("shutdown") === true`. The watcher must explicitly check `if (next === "shutdown") return` BEFORE sending. Otherwise close-triggered shutdowns will fire notifications and the integration test for `child-fiber-interrupt-during-wait` will fail (it asserts no notification on close).

4. **Watcher MUST NOT fire on intermediate transitions.** `AgentStatus.isFinal` returns false for `pending_init`, `running`, `interrupted` — the watcher's `if (!AgentStatus.isFinal(next)) return` handles this. But note: `interrupted` is non-final per `agent/status.ts:50` (a parent can resume an interrupted child). So a transition to `interrupted` is NOT a wake-up trigger. Codex's behavior: only completed / errored / shutdown wake; we additionally skip shutdown. So effectively only completed / errored fire notifications.

5. **Stream.runForEach termination.** After sending, the watcher should stop. The pattern is `return Effect.interrupt` from the handler — that interrupts the stream consumer. Alternative: use `Stream.takeUntil(...)` to filter for final statuses, then `Stream.take(1)` to take just one. Either works; the explicit interrupt pattern is more readable for "fire-once-then-die".

6. **`bench-managed-runtime-needs-effect-scoped`** — if Wave 2 adds a perf bench (recommended: a microbench measuring spawn-with-watcher vs spawn-without-watcher overhead), the bench's `provideTmpdirInstance` call needs `Effect.scoped` wrap when run via `ManagedRuntime`. See the existing `test/perf/agent-control.bench.ts` for the pattern.

7. **Test timing.** The integration test for `child-completion-wakes-parent` asserts elapsed < 500ms. The child sleeps 50ms before returning. The watcher fires within microseconds of the status change. The wait_agent race resolves on the seq watch within milliseconds. Total budget: ~50ms work + <50ms wakeup. The 500ms upper bound is comfortable. If the test FAILS the timing assertion (e.g. 700ms elapsed), the watcher is firing late — investigate. Common cause: test running on a noisy machine OR the fiber scheduling delay. Bump the upper bound to 1000ms before declaring spec-undoable; if it still fails, surface as USER QUESTION.

8. **Concurrent children.** Two children completing at near-the-same time each have their own watcher; both fire notifications to the SAME parent mailbox. The parent's mailbox (per-root) is a single Map slot; the Mailbox's atomic `Ref.modify`-based send guarantees both messages are appended in order with monotonic seq. The `wait_agent` race wakes on the FIRST seq advance; subsequent seq advances also wake any future wait calls. Test for this edge case is OPTIONAL but recommended (extend `child-completion-wakes-parent` to spawn 2 children, both complete, assert mailbox has 2 messages after the wait).

9. **Don't accidentally double-notify.** If you also keep `Cause.hasInterrupts` detection in the existing `onExit` handler at `control.ts:600-602`, you'll have TWO paths that try to set status — onExit and the watcher. The watcher only READS status; it doesn't set. The onExit STILL sets status on its own. So no race. Double-check the status-setting paths in onExit don't accidentally fire the watcher's send (they don't — the watcher's send is gated on `AgentStatus.isFinal(next) && next !== "shutdown"` from the SubscriptionRef change stream).

10. **Performance: extra fiber per spawn.** Per `PERF.md` Wave 2 budget, `spawn` p50 should not regress > 5%. Forking a fiber is cheap (sub-µs). The watcher's body never executes during the spawn measurement (it sleeps awaiting status changes that never come during the bench). Re-run `test/perf/agent-control.bench.ts`. If it regresses > 5%, the fork is more expensive than expected; consider lazy-fork (only fork when the parent calls wait_agent — but that's a bigger refactor). Surface as USER QUESTION.

## Verification

```bash
cd packages/opencode

# 1. Typecheck — zero errors.
bun typecheck

# 2. Lint — zero errors.
bun lint

# 3. Coverage on the touched file.
bun test --coverage src/agent/control.test.ts 2>&1 | grep -E "control\.ts"
#    Expected: 100.00 line coverage on src/agent/control.ts.

# 4. Existing primitive tests pass (with any wait_agent timing test updates).
bun test ./src/agent/control.test.ts

# 5. Integration tests pass (the completion-watcher invariants are now green).
bun test ./test/integration/multi-agent-invariants.test.ts
bun test ./test/integration/multi-agent-tools.test.ts

# 6. agent-wait tests pass (no change to agent-wait.ts; verify nothing broke).
bun test ./src/tool/agent-wait/

# 7. Perf — agent-control bench within budget.
bun test ./test/perf/agent-control.bench.ts
#    Inspect output JSON for spawn / send / list p50 within 5% of baseline.

# 8. Full multi-agent test surface still passes.
bun test ./src/agent/
```

Coverage assertion: `src/agent/control.ts` at 100% line coverage including the new watcher fork and statusLabel helper.

Integration test names that MUST be green after this wave:

- `child-completion-wakes-parent`
- `child-completion-notification-body-shape`
- `child-fiber-interrupt-during-wait`

If `child-completion-wakes-parent` runs but elapses > 500ms, see Gotcha 7. If `child-fiber-interrupt-during-wait` shows a notification was fired (mailbox length > 0), the skip rule isn't working — see Gotcha 3.

Perf assertion: `agent_control.spawn` within 5% of baseline p50. If regresses, see Gotcha 10.
