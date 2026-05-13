# Cross-cutting message + state shapes

These shapes are shared across multiple waves. Decide them ONCE here so waves don't drift.

## Cross-agent message injection (used by Wave 9 + Wave 11)

When a sibling sends a message via `send_message` or `followup_task`, Wave 9's runLoop drains the recipient's mailbox before each model call. Each drained `InterAgentCommunication` becomes a synthetic `MessageV2.UserPart` injected into the current turn's user message:

```ts
// Shape:
{
  id: PartID.ascending(),
  messageID: <current user message id>,
  sessionID: <recipient session id>,
  type: "text",
  text: <InterAgentCommunication.content>,
  synthetic: true,
  metadata: {
    from: <InterAgentCommunication.author as AgentPath string>,
    sent_at: <InterAgentCommunication.sent_at>,
    trigger_turn: <bool>,
  },
}
```

**Why this shape:**

- `synthetic: true` — the existing flag (`message-v2.ts:116`) already tells the runLoop / TUI this isn't user input. Reuses existing infrastructure.
- `metadata.from` — discriminator for the TUI renderer to show "← message from @worker_1" instead of regular user text.
- `metadata.sent_at` — timestamp from the sender side, useful for transcripts and reproducibility.
- `metadata.trigger_turn` — surfaces whether this message woke the recipient (followup_task) or just queued (send_message). The TUI may render these subtly differently.
- Type `text` — surfaces in the model's context as plain text (no special handling needed in `MessageV2.toModelMessagesEffect`). The model sees the from-prefix in the rendered TUI but for the model itself, the text content is what matters; we prepend `"[from <author>]: "` to the text body so the model knows the source. (Final formatting: `"[from /root/explorers/worker_1]: <content>"`. This matches codex's `format_subagent_context_line` style.)

**Backward compat:** `MessageV2.UserPart` already exists; `synthetic` flag exists; `metadata` is `Schema.optional(Schema.Record(Schema.String, Schema.Any))` (`message-v2.ts:124`) — already optional. Adding fields to metadata requires no schema change.

**Wave 9** drains the mailbox and produces parts of this shape.
**Wave 11** renders parts whose `metadata.from` is set with the cross-agent visual treatment.
**Wave 13's** backward-compat tests assert that UserParts WITHOUT `metadata.from` render as before.

## Subtask v2 marker (used by Wave 9)

The existing `MessageV2.SubtaskPart` (`message-v2.ts:225-241`) is what the legacy `task` tool produces. Wave 9's runLoop must distinguish v2 (concurrent agent spawn via AgentControl) from v1 (legacy task tool, blocking). The chosen marker:

Add an optional `protocol?: "v2"` field to `SubtaskPart`. If absent or any other value, treat as v1 (legacy) — backward compat preserved. If `"v2"`, route through AgentControl.

```ts
export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  // existing fields: prompt, description, agent, model, command
  protocol: Schema.optional(Schema.Literal("v2")),  // NEW
})
```

**Rationale over alternatives:**
- A separate `AgentSpawnPart` type would be cleaner architecturally but breaks more downstream (TUI renderers, sync schema, etc.). Adding an optional discriminator on the existing type is the minimum-invasive choice.
- Boolean `v2: true` works but the literal `"v2"` is forward-compat for future protocol versions.

**Where the marker is set:** by tool calls that produce subtask parts. Legacy `task` tool produces `SubtaskPart` with no `protocol` (continues to work). The new `spawn_agent` tool (Wave 8) produces a SubtaskPart with `protocol: "v2"` if it produces one at all, OR — preferred — bypasses SubtaskPart and goes directly through AgentControl in Wave 9's runLoop integration. The cleaner path: `spawn_agent` calls `AgentControl.spawnAgent` directly via the runtime context, no SubtaskPart involved. SubtaskPart with `protocol: "v2"` is reserved for the case where a slash command (e.g. `plan`) wants to enqueue a v2 subtask declaratively.

## Permission keys

**Convention (verified in `agent.ts`):** permission_key = tool_name (e.g. `bash` for the shell tool whose ToolID is `"bash"`; `grep`, `glob`, `read`, `edit`, `task`, etc.).

**For this campaign:**

| Tool | Permission key |
|---|---|
| exec_command | `exec_command` |
| write_stdin | `exec_command` (shared — write_stdin always operates on a process spawned via exec_command; per-PID always-pattern on first spawn covers reuse) |
| spawn_agent | `spawn_agent` |
| send_message | `send_message` |
| followup_task | `followup_task` |
| wait_agent | `wait_agent` |
| list_agents | `list_agents` |
| close_agent | `close_agent` |

**Per-PID always-pattern for `exec_command`:** when the model approves the first `exec_command` call, the registered "always" pattern is `pid:<process_id>`. Subsequent `write_stdin` calls evaluate the `exec_command` permission with pattern `pid:<process_id>` and find the always-allow rule. This caches per-process, not per-command-string.

## Constants split

| Concern | Lives in | Visibility |
|---|---|---|
| `MAX_UNIFIED_EXEC_PROCESSES`, `WARNING_UNIFIED_EXEC_PROCESSES`, `UNIFIED_EXEC_OUTPUT_MAX_BYTES` | `pty/index.ts` (Pty.Service consumes them) | **exported** — tests in Wave 3 + Wave 14 import these to verify cap behavior without hardcoding magic numbers |
| Tool-side: `MIN_YIELD_TIME_MS`, `MIN_EMPTY_YIELD_TIME_MS`, `MAX_YIELD_TIME_MS`, `DEFAULT_EXEC_YIELD_TIME_MS`, `DEFAULT_WRITE_STDIN_YIELD_TIME_MS`, `POST_WRITE_STDIN_SLEEP_MS`, `DEFAULT_MAX_OUTPUT_TOKENS`, `UNIFIED_EXEC_ENV` | `tool/process/constants.ts` | exported |
| `DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS` (process_manager.max_write_stdin_yield_time_ms) | `tool/process/constants.ts` | exported |
| Buffer-related: `EARLY_EXIT_GRACE_PERIOD_MS`, `POST_EXIT_CLOSE_WAIT_CAP_MS`, `TRAILING_OUTPUT_GRACE_MS`, `UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES` | `pty/index.ts` (used internally by Pty.read race + streaming pipeline) | exported (tests may want them) |
| `PROCESS_STORE_PROTECTED_RECENT`, `PROCESS_ID_RANGE_MIN/MAX` | `pty/index.ts` | exported |
| Multi-agent: `AGENT_MAX_DEPTH = 4`, `AGENT_MAX_THREADS = undefined` (no cap default) | `agent/registry.ts` (module-owned constants for v0; if user demands runtime override later, lift to Config) | exported |
| Mailbox wait: `DEFAULT_WAIT_TIMEOUT_MS = 30_000`, `MIN_WAIT_TIMEOUT_MS = 1_000`, `MAX_WAIT_TIMEOUT_MS = 600_000` | `tool/wait-agent/constants.ts` (or `agent/constants.ts` if shared) | exported |

**All constants in this campaign are EXPORTED, not module-private.** The "lives in" column says where the file is, not whether it's hidden. Tests, downstream waves, and external consumers can `import` any of these — that's the whole point of pulling them out. The grouping is for organization (Pty cares about Pty constants; tools care about tool constants), not encapsulation.

No `agent_max_depth` / `agent_max_threads` Config fields in this campaign. Constants live with their consumers. If a future task wants user-tunable values, that's a separate Config wave.
