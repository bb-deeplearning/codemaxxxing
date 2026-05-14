# Cross-cutting message + state shapes

Carries forward from `.wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md` (which is still authoritative for the cross-agent communication shape, the SubtaskPart v2 marker, the permission keys, and the constants split). This file additionally defines the COMPLETION NOTIFICATION body shape introduced by Wave 2.

## Carried forward (still load-bearing)

These shapes are unchanged from the previous campaign — the previous file is authoritative:

- **Cross-agent message injection** (synthetic UserPart with `metadata.from`, `metadata.sent_at`, `metadata.trigger_turn`).
- **Subtask v2 marker** (`SubtaskPart.protocol?: "v2"`).
- **Permission keys** (one per tool name).
- **Constants split** (which constants live in which module, all exported).

If your wave needs the precise shape of one of those, read the previous file:

```
.wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md
```

## NEW: completion notification body shape (Wave 2)

The completion watcher introduced by Wave 2 sends an `InterAgentCommunication` to the parent's mailbox when a child reaches a final status. The shape is constrained as follows:

```ts
new InterAgentCommunication({
  author: <child_path>,
  recipient: <parent_path>,             // /root if parent is root; otherwise the parent's AgentPath
  content: `Agent ${child_path} reached status: ${status_label}`,
  trigger_turn: false,                  // NOT a turn-trigger; informational
  sent_at: Date.now(),                  // wall-clock at watcher observation
})
```

Where `status_label` is one of:

- `"completed"` — child runLoop finished successfully (status is `{ completed: ... }` after fiber's onExit handler set it).
- `"errored"` — child runLoop failed with a typed error (status is `{ errored: ... }`).

The watcher subscribes to the child's status `SubscriptionRef` and fires once `AgentStatus.isFinal(status) === true` AND the status is not `"shutdown"` (skipped per the rule below). Per `agent/status.ts:49-52`, the non-final statuses are `pending_init`, `running`, and `interrupted` — the watcher does NOT fire on these. `"interrupted"` is non-final because a parent can resume an interrupted child via `send_inter_agent_communication { trigger_turn: true }`; it never produces a notification body. The two final-and-non-shutdown statuses (`completed`, `errored`) are therefore the only labels that can ever appear in the body.

The notification is sent via the existing `AgentControl.sendInterAgentCommunication` so:

- The parent's mailbox seq advances (waking `wait_agent`).
- The `agent.message.sent` Bus event fires (TUI + plugins observe).
- The `EventV2.run(SessionEvent.Agent.Message.Sent.Sync, ...)` projection runs.

The author/recipient relationship: the child is the AUTHOR (it reached the final status; this is the child's last "communication" to the world). The parent is the RECIPIENT (it's been waiting; this is the answer it was waiting for).

### Skip rule: closeAgent-triggered shutdown

When `closeAgent(<child-id>)` is the cause of the child's status reaching `shutdown`, the watcher MUST NOT fire a notification. The parent invoked the close itself; waking `wait_agent` with a notification it just caused would be confusing.

Detection mechanism for the skip: the watcher subscribes to the child's status `SubscriptionRef`. When the status transitions to `shutdown`, the watcher checks: was this transition the result of an interrupt that came from `closeAgent`?

Two implementation options Wave 2 may choose between:

1. **Status-based skip.** Watcher waits for `AgentStatus.isFinal(status) === true`. If the status is `"shutdown"`, skip the notification (closeAgent is the only path that sets this status). This is simple and matches the current `control.ts:600-602` interrupt-handling pattern.
2. **Cause-based skip.** Watcher races status against the fiber's exit, and on fiber exit checks `Cause.hasInterrupts(exit.cause)` to detect close-triggered shutdown. More precise but requires plumbing the fiber's exit into the watcher.

Wave 2 SHOULD implement option (1) — the status-based skip — because `shutdown` is exclusively set by `closeAgent` (no other code path produces it) and the resulting code is simpler. The integration test for `child-fiber-interrupt-during-wait` asserts the chosen behavior.

### Why this body shape and not codex's

Codex's `maybe_start_completion_watcher` (`codex-rs/core/src/agent/control.rs:943-1015`) sends a richer payload that includes the child's `last_agent_message` and a structured status enum. Opencode's `InterAgentCommunication.content` is a plain string (text only), so we synthesize a one-line summary. The structured status info is already available via `subscribeStatus(child_id)` for any consumer that wants it; the notification's job is to advance the parent's mailbox seq and tell the model in plain text what happened.

If a future wave needs structured status info delivered alongside the notification, it can populate `items: Schema.optional(Schema.Array(Schema.Unknown))` (the existing field on `InterAgentCommunication`) without changing the body string.

### Backward compat

`InterAgentCommunication` already exists; `trigger_turn` already exists; `author` and `recipient` already exist. The notification reuses every field unchanged. No schema migration. The synthetic UserPart that the runLoop drains for this notification renders identically to a user-initiated message — same `metadata.from`, same `metadata.sent_at`, same `metadata.trigger_turn: false` shape that the previous campaign defined for cross-agent messages.

## Test fixtures the integration tests use

For tests that verify the completion notification:

```ts
// Setup: spawn child with stub-provider that scripts a single-turn completion
yield* control.registerRunLoop((sessionID) =>
  Effect.gen(function* () {
    yield* Effect.sleep(50)                      // child "works" briefly
    return                                       // returns success → fiber.onExit sets status to { completed: null }
  }),
)
const child = yield* control.spawnAgent({ ... })
const t0 = Date.now()
const waitResult = yield* AgentWaitTool.execute(
  { timeout_ms: 30_000 },
  { ... ctx with sessionID = parentID },
)
const elapsed = Date.now() - t0
expect(waitResult.metadata.timed_out).toBe(false)
expect(elapsed).toBeLessThan(500)                // wait returned promptly
const drained = yield* control.drainMailbox(parentID)
expect(drained).toHaveLength(1)
expect(drained[0].content).toBe(`Agent ${childPath} reached status: completed`)
expect(drained[0].author).toEqual(childPath)
expect(drained[0].trigger_turn).toBe(false)
```

The 500ms upper bound on `elapsed` is a sanity check (the child completes in ~50ms; the watcher fires within ~10ms of status transition; the wait_agent race resolves on the seq watch). The 30s timeout proves the test isn't trivially passing because the timeout fired.
