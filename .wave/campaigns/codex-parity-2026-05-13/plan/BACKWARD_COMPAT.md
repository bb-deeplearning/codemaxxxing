# Backward compatibility — what must keep working

This campaign adds two large new feature areas without removing or breaking any existing one. After this campaign lands, every codemaxxxing user must be able to:

1. Open the TUI and load any session created before the campaign — no errors, no broken renders, no missing parts.
2. Run `task` tool calls (the legacy single-shot subagent surface) — same input shape, same output shape, same blocking behavior.
3. Use the `shell` tool — completely untouched.
4. Continue using `Pty.Service` from desktop / electron clients via the existing HTTP+WS surface — no schema breaks.
5. Plugin authors using `tool.execute.before/after` hooks — keep working unchanged.

If any of these break, the wave fails.

## Non-removal list

Do not remove, rename, or change the signature of:

- `Pty.Service` methods: `list`, `get`, `create`, `update`, `remove`, `resize`, `write`, `connect` (`pty/index.ts:101-113`)
- `Pty.Info` schema fields (we may ADD `origin?: "tui" | "model"` as optional — must default-deserialize for old rows)
- `Pty.Event.Created/Updated/Exited/Deleted` payloads (we may add fields but never change existing field types)
- `Tool.Context` interface (`tool/tool.ts:15-25`) — it's load-bearing across every tool
- `Session.Service` interface (`session/session.ts:425-473`) — extending is fine; removing/renaming is not
- `MessageV2.Part` discriminated union — adding new variants is fine; removing or renaming variants is not. The existing `SubtaskPart` (`message-v2.ts:225-241`) must keep working.
- `Tool.define` signature (`tool/tool.ts:130`)
- `Session.create({parentID})` shape — the new `spawn_agent` flow uses this same primitive, but the legacy `task` tool's path through `task.ts:70` must still work
- `Permission.ask` signature — extending the `permission` string namespace is fine; the function itself stays
- The existing `task` tool (`tool/task.ts`) — KEEP IT IN THE REGISTRY. Do not delete or deprecate as part of this campaign. It is the simple "fan one off and forget" surface; v2 is the concurrent surface; both coexist.

## Schema compatibility

`MessageV2.Part`, `MessageV2.Info`, `Session.Info`, `Pty.Info` are all JSON-stored in Drizzle. Tests in Wave 13 verify:

- A real session.sql.ts row from before this campaign deserializes cleanly
- All `MessageV2.Part` variants (Text, Subtask, Reasoning, File, Tool, StepStart, StepFinish, Snapshot, Patch, Agent, Retry, Compaction) parse back into objects with no missing fields
- The Pty pre-existing buffer/cursor protocol over WebSocket (used by desktop) is unchanged

If any added field would break old-row deserialization, the field must be `Schema.optional` (per the existing pattern at `session.ts:184-196`).

## Migration policy

This campaign produces NO Drizzle migrations. None. Reasons:

- Mailbox state is in-memory in `InstanceState` — dies with the process, no persistence
- AgentControl registry is in-memory
- All new MessageV2.Part variants (if any) are JSON discriminator extensions — no column changes
- Pty.Info gains optional `origin` field — also JSON, no column change
- Session.Info `nickname?` and `agent_role?` — added to Agent.Info schema (in-memory), NOT to SessionTable

If a wave thinks it needs a migration, that wave is doing something wrong. Stop and surface a USER QUESTION.

## Existing test suite

Before merging anything, the entire pre-existing test suite (the one we inherited) must still pass. Run from `packages/opencode`:

```bash
bun test
```

Wave 13 dedicates its verification to this.

## Behavioral compat

These behaviors MUST be observable identically before and after the campaign:

1. Calling `task` with `description: "x"`, `prompt: "y"`, `subagent_type: "explore"` — returns same string-shaped result (the `<task_result>` envelope)
2. Cancelling a session via `Session.cancel` interrupts the runLoop — same as before
3. Permission denials propagate as `Permission.RejectedError` to tool-call errors — same as before
4. Snapshot/patch tracking on `processor.ts:115` and `:484` runs at tool-call boundaries — same as before, no extra snapshots from concurrent siblings leaking into the parent's diff
5. The TUI's existing subagent navigation keybinds (`session.parent`, `session.child.next`, `session.child.previous`, `session.child.first`) work — same as before, with possibly enriched footer info from Wave 11
