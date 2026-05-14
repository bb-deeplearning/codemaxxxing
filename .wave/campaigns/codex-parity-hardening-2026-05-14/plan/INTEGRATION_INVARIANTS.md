# Integration invariants — multi-agent surfaces

This is the campaign's first-class deliverable. Every multi-agent surface — present and future — must hold these invariants. Every wave that touches `agent/control.ts`, `tool/agent-*`, or anything reading from / writing to a child session's mailbox MUST add at least one `it.instance` test in `packages/opencode/test/integration/multi-agent-invariants.test.ts` against the relevant invariant before its implementation lands.

## Why this exists

The previous campaign tested every primitive at 100% coverage. Two structural bugs survived:

- **Bug 1** — `AgentControl` keyed `InstanceState` per directory rather than per root session. Every per-primitive test passed because there was always exactly one root in the test fixture. Real users open chat A and chat B in the same project — the bug surfaces immediately.
- **Bug 2** — child completion never notified the parent's mailbox. Every primitive test for `wait_agent` used the timeout path. Every primitive test for child fiber `onExit` checked the status SubscriptionRef. Neither test composed the two: spawn child → child finishes → parent waiting → does the wait return?

Both bugs were one integration test away from being caught in their original wave. This file lists the integration scenarios that any multi-agent code must hold against.

## How to use this file

For every wave that touches multi-agent surfaces:

1. Read this file end-to-end.
2. Identify which invariants the wave's changes affect (a wave that adds a new tool affects whichever invariants involve message routing or status; a wave that refactors `closeAgent` affects whichever involve cascade and idempotency; etc.).
3. For each affected invariant, locate (or add) a corresponding `it.instance` test in `test/integration/multi-agent-invariants.test.ts`. The test name MUST match the invariant slug (so the wave's verification can grep for it).
4. Make the test pass before the wave commits.

If you add a new invariant during a wave (e.g. you discovered a sharp edge that should never repeat), append it to this file in the "Discovered during execution" section at the bottom. Future waves treat it the same as the seeded invariants.

## Invariant catalog

Each invariant has a stable slug (used as the test name in the integration suite) and a one-paragraph behavioral description. Tests assert observable behavior — never internal state shapes.

### `multi-root-isolation`

Two chat sessions opened in the same project directory each spawn their own subagent named `worker_a`. Neither session sees the other's worker via `list_agents`. Sending a message to chat A's `worker_a` does not deliver to chat B's `worker_a`, and vice versa. Closing chat A's `worker_a` does not affect chat B's. The two roots may run concurrently; their `AgentControl` state must be fully partitioned. Resolution rule: `AgentControl` operations resolve the caller's root from the calling session id, then operate only on that root's per-root data.

### `child-completion-wakes-parent`

Parent session spawns a child via `spawn_agent`. Parent calls `wait_agent` with timeout 30s. Child runLoop completes successfully in under 1s (e.g. via the test's stub-provider scripted single-turn response). Within 100ms of child completion, `wait_agent` returns with `timed_out: false`. The mechanism: a sibling watcher fiber forked at spawn time subscribes to the child's status SubscriptionRef, waits for `AgentStatus.isFinal` to return true, then sends an `InterAgentCommunication` to the PARENT's mailbox via the existing `sendInterAgentCommunication` path. `trigger_turn: false` (this is a notification, not a turn-trigger). The mailbox seq advances; `wait_agent`'s race resolves on the change branch.

### `child-completion-notification-body-shape`

The completion notification's body is `"Agent <child_path> reached status: <status_label>"` where `<status_label>` is one of `completed` or `errored`. (The watcher only fires when `AgentStatus.isFinal(status) === true` AND the status is not `"shutdown"`. Per `agent/status.ts:49-52`, `interrupted` is non-final — a parent can resume an interrupted child — so it never produces a notification. `shutdown` is skipped per the rule documented in MESSAGE_SHAPES.md to avoid waking the parent for a close it just invoked.) The author is the child's `AgentPath`; the recipient is the parent's `AgentPath` (or `/root` if the parent is root). `trigger_turn: false`. `sent_at` is the wall-clock time at which the watcher observed the final status. The shape is observable via a parent-side `drainMailbox` after waking. The shape MUST stay stable across this campaign and any future wave — it is part of the cross-agent message contract.

### `cross-root-send-rejection`

Chat A's session calls `sendInterAgentCommunication(<chat-B-child-id>, comm)` (e.g. via a forged target id, malicious or buggy). The send fails with `AgentNotFoundError`. The chat-B child's mailbox is unchanged. No bus event fires. The rejection is the same shape the operation produces for an unknown / shutdown agent.

### `session-deletion-cleanup`

When a root session is deleted (e.g. user closes the chat from the TUI), every per-root data slot for that root is torn down: mailboxes cleared, statuses cleared, fibers interrupted, registry entry released, rootRef cleared. The per-root teardown is detected by subscribing to `Session.Event.Deleted` inside the `InstanceState.make` closure (using the existing `Inbound`-style BusEvent.Definition shape pattern that wave 10 introduced for `Step.Started/Ended`). The teardown does NOT affect any other root's per-root data slot.

### `parent-close-cascades-to-children`

Calling `closeAgent(<parent-id>)` interrupts every live agent under that parent's subtree (descendants by AgentPath prefix), in leaves-first order. Each descendant's status transitions to `shutdown`. The cascade is idempotent: calling `closeAgent` on an already-closed agent returns `previous_status: shutdown` without error. (This invariant already passes today via `closeAgent`'s descendants walk; this campaign asserts it remains true after Wave 1's per-root refactor.)

### `child-fiber-interrupt-during-wait`

Parent spawns child, then calls `wait_agent` with a long timeout. Before the timeout elapses, an external fiber calls `closeAgent(<child-id>)`. The child fiber is interrupted; its onExit detects `Cause.hasInterrupts` and leaves the status as `shutdown` (set by `closeAgent` first). The completion-watcher fiber observes the shutdown status and either (a) sends a notification with body `"Agent <child_path> reached status: shutdown"` OR (b) skips notification because `closeAgent` was the trigger. The chosen behavior MUST be deterministic and documented; the test asserts whichever was chosen. Recommended: skip notification on `shutdown` so the parent doesn't get a wake-up for an action it just took.

### `mailbox-drain-at-runloop-boundary-with-concurrent-sends`

While the parent's runLoop is between iterations (about to call `drainMailbox` at the top of the next iteration), a sibling fires `sendInterAgentCommunication` to the parent. The drain MUST observe the in-flight send: either the message is in the drained batch (delivered as a synthetic UserPart in the next turn) OR the seq advanced after the drain and the next iteration's drain catches it (no message lost). Empirically, this requires the drain to be atomic with respect to seq updates — the existing Mailbox `Ref.modify`-based atomic append + `SubscriptionRef.set(notify, seq)` broadcast supports this. The test sends N messages concurrently with a drain and asserts the union of (drained, still-pending) equals N.

### `pty-cleanup-on-parent-abort`

When the parent session is aborted (`Session.cancel` → runLoop interrupted → AgentControl's child fibers interrupted via the `forkIn(parentScope)` chain), every PTY spawned inside any descendant subagent's `exec_command` calls is also cleaned up. Concretely: `Pty.list()` returns empty for the project after the abort settles. The mechanism is the existing `acquireUseRelease` pattern in `exec-command.ts` plus the `forkIn` ancestry; this campaign asserts it composes correctly with multi-agent cancellation.

### `legacy-task-tool-coexists-with-v2`

The legacy `task` tool (`packages/opencode/src/tool/task.ts`) creates a child session via `Session.create({ parentID })` directly, with NO `AgentControl` involvement. After Wave 1's per-root refactor, calling `task` from a root session must continue to work: the child session is created, its runLoop runs to completion, the parent's tool call resolves with the `<task_result>` envelope. The test exercises this end-to-end with a stubbed model that completes one turn immediately, then asserts the legacy task tool returns the expected output shape. Crucially: the test uses a separate root from any AgentControl-spawned child, so the test catches any regression that would couple the legacy path to the per-root scoping refactor.

## Discovered during execution

(Empty at campaign start. Each wave that finds a new invariant worth asserting appends a section here following the same shape.)
