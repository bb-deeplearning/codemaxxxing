# Changes: TUI flush-queued (interrupt + drain queued user messages on demand)

**Date**: 2026-05-18

A small but high-value TUI quality-of-life fix that closes a long-standing pet peeve: messages typed while an agent is running sit in the queue with no way to force them through. They wait for the current turn to finish naturally before the model sees them. Frustrating when you realize mid-stream that you want to redirect the agent and don't want to wait however long the current tool call takes to settle.

## Background: how queueing worked

Server side hasn't changed. When you hit Enter while a turn is running:

1. The TUI fires `sdk.client.session.prompt({ sessionID, parts, ... })` — fire-and-forget at `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1043`.
2. The server's `SessionPrompt.prompt` (`packages/opencode/src/session/prompt.ts:1419`) calls `createUserMessage` immediately, persisting the message to the session log, then calls `loop({sessionID})` which hits `SessionRunState.ensureRunning` (`packages/opencode/src/session/run-state.ts:87`). Because a runner is already in the `"Running"` state, `ensureRunning` just attaches an `awaitDone` to the existing fiber's `done` deferred (`packages/opencode/src/effect/runner.ts:115-122`). No new work is scheduled.
3. The existing `runLoop` (`packages/opencode/src/session/prompt.ts:1509`) is a `while(true)` that re-reads messages from the DB each iteration. When the current model stream and tool calls settle, it sees the new user message as `lastUser` (its monotonic ID is greater than the assistant's), the exit condition fails (`prompt.ts:1559-1576`), and the next pass feeds it to the model.

So the queued message gets processed at the next turn boundary inside the same runner fiber. No client-side queue, no separate data structure — the message lives in the message log and the run loop notices it.

The TUI surfaces this via a derived `queued` predicate at `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1524`:

```ts
const queued = createMemo(() => props.pending && props.message.id > props.pending)
```

`props.pending` is the ID of the currently-streaming assistant (`messageTail()` at the same file's line 333). Any user message with `id > pending` renders with a ` queued ` badge. Purely derived from message IDs — no separate queue.

## What was missing

No way to manually trigger "drain queued NOW." The user had to either wait for the current turn to settle or triple-tap Esc to abort entirely, which kills the run and leaves the queued messages stranded in the DB until the user manually re-prompts.

## What landed

A new TUI command + server endpoint + keybind:

- **Keybind**: `<leader>return` (i.e. `ctrl+x` then `return`). Configurable via `keybinds.session_flush_queued` in `opencode.json`.
- **TUI command**: `session.flush_queued` at `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`. Hidden from the command palette, enabled only when the session is busy AND at least one user message has `id > pending`.
- **Server endpoint**: `POST /session/:sessionID/loop` (HttpApi + Hono parity). Calls `promptSvc.loop({sessionID})` in a forked fiber and returns `true` immediately so the client doesn't block on the new turn streaming through.
- **Behaviour**: on press → `sdk.client.session.abort({sessionID})` → await → `sdk.client.session.loop({sessionID})`. Abort cancels the running fiber, `processor.ts:629-642` finalizes the assistant message in place (partial text/reasoning preserved, in-flight tool calls marked `interrupted: true`, `time.completed` set, persisted). Runner transitions to `Idle` via `onIdle` callback (`run-state.ts:57`). The new `loop` call starts a fresh fiber; its first iteration reads all messages from the DB, sees the queued user messages as `lastUser`, and feeds them to the model on the next pass.

Two visible hints surface the keybind:

- Inline next to each queued user message: ` <leader> return to flush  queued ` (at `routes/session/index.tsx:1632-1641`).
- In the prompt footer when busy + queued count > 0: `esc interrupt · <leader> return flush N queued` (at `component/prompt/index.tsx:1729-1738`).

## Why a new server endpoint instead of reusing an existing one

The server had `promptSvc.loop({sessionID})` defined and called internally (by the summarize handler at `httpapi/handlers/session.ts:251` and the Hono summarize route) but not exposed as its own client-callable endpoint. The alternative was `prompt` with `parts: []` and `noReply: true`, which would have inserted a synthetic empty user message just to trigger the loop — wrong on its face. New endpoint is cleaner and reusable for any future "kick the loop without a new message" need.

## Trade-offs

- **Race when the composer has unsent text.** If the user types something and hits the flush keybind without first hitting Enter, the draft is lost (it's still in the composer; it doesn't get submitted). Workflow: hit Enter to queue, then hit flush. This is deliberate — wiring submit-then-flush into one keypress introduces a race between `prompt` POST completion and `abort`. We can revisit if the workflow grates.
- **No batched / merged drain.** Each queued user message gets fed to the model as a separate user turn in conversation history (preserved in order). The separate-turns shape matches how the messages were entered.
- **Partial-output preservation is free.** Already implemented at `processor.ts:629-642` for the existing triple-Esc interrupt path. The new flush path reuses it.

## File inventory

### New

- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` (added `SessionPaths.loop` and `HttpApiEndpoint.post("loop", ...)`)
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (added `const loop` handler; `.handle("loop", loop)`)
- `packages/opencode/src/server/routes/instance/session.ts` (added legacy Hono `POST /:sessionID/loop` for parity)
- `packages/sdk/js/src/v2/gen/sdk.gen.ts` (regenerated; `OpencodeClient.session.loop` now exists)
- `packages/sdk/js/src/v2/gen/types.gen.ts` (regenerated; `SessionLoopData`, `SessionLoopResponses`, etc.)

### Modified

- `packages/opencode/src/config/keybinds.ts` (added `session_flush_queued: keybind("<leader>return", ...)`)
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`:
  - Added `queuedCount` memo (mirror of the message-timeline `queued` predicate).
  - Added `session.flush_queued` command. Handler: `abort` → `loop`.
  - Added footer hint when `queuedCount > 0` and busy.
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`:
  - Added `useKeybind` import (was present, scoped here).
  - Added `flushKey` memo per `UserMessage`.
  - Inline hint left of the ` queued ` badge.

## Why this entry exists

Smaller-scope changes get logged because (a) it's one of those affordances that's invisible until you need it, and the README would otherwise be the only documentation, and (b) the server-side endpoint is reusable from plugins / other clients and worth flagging for anyone extending the API.
