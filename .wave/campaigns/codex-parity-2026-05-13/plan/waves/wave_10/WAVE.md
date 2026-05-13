# Wave 10 — EventV2 + Bus events for agent lifecycle

**Prior waves:** 0-9. AgentControl emits lifecycle events through callbacks (or stubs); Wave 9's runLoop integration is live.

**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `REFERENCES.md`.

**Touch points:**
- `packages/opencode/src/v2/session-event.ts` — extend with new `Agent.*` namespace
- `packages/opencode/src/bus/bus-event.ts` — register parallel bus events
- `packages/opencode/src/agent/control.ts` — wire emission

**Codex source for event shape reference:**
- Event names: `CollabAgentSpawnBegin/End`, `CollabAgentInteractionBegin/End`, `CollabWaitingBegin/End`, `CollabCloseBegin/End`. Payloads: see `multi_agents_v2/spawn.rs:71-205`, `wait.rs:71-101`, `close_agent.rs:55-112`, `message_tool.rs:88-138`.

## Goal

Surface agent lifecycle on the bus + EventV2 sourced log so the TUI (Wave 11) and any plugins/sync consumers can observe spawn, message, wait, and close events.

## Tasks

Sequential.

### 1. Tests first

Tests for:
- each new event type emits at the right moment in `AgentControl` (spawn-begin before fiber starts; spawn-end after; etc.)
- payloads include `sessionID`, `timestamp`, `call_id` (where applicable), and the event-specific fields (target, prompt, status, etc.)
- All union (the `All` schema in `v2/session-event.ts:352`) includes the new events
- Bus subscribers receive the events when subscribed via `Bus.subscribe(Event.AgentSpawnStarted)` etc.

### 2. Define events

Mirror codex's begin/end pattern for spawn, interaction (message), wait, close. Each gets a SyncEvent definition (for the EventV2 log) and a parallel BusEvent definition (for in-process subscribers).

Naming convention to match the existing `v2/session-event.ts` style: `Agent.Spawn.Started`, `Agent.Spawn.Ended`, `Agent.Message.Sent`, `Agent.Wait.Started`, `Agent.Wait.Ended`, `Agent.Closed`.

### 3. Wire emission in AgentControl

Replace any callback stubs from Wave 7 with real `EventV2.run(...)` + `Bus.publish(...)` calls. Preserve event ordering: begin before the operation, end after.

### 4. Update status derivation

Wave 7 stubbed `subscribeStatus` updates. With agent lifecycle events flowing, status can now derive from the event stream. Subscribe to relevant `SessionEvent.Step.Started/Ended` and `Agent.Closed` events; update the per-session `SubscriptionRef<AgentStatus>`.

## Gotchas

1. **Backward compat for the EventV2 union.** Adding to the `All` union is fine; removing or reordering is not. Keep ordering stable.

2. **Bus event registry.** Every `BusEvent.define` call registers in the bus registry (`bus/bus-event.ts:10`). The registry is consumed by the SDK generator. Adding events expands the public API surface — that's expected here. Run `./packages/sdk/js/script/build.ts` after Wave 10 to confirm the SDK regenerates cleanly (this is a verification task, not part of this wave's commit).

3. **Sync semantics.** EventV2 events get persisted to `SessionMessageTable` (see `session.sql.ts:106-123`). Adding new event types is a JSON-discriminator extension — no migration. Confirm the table accepts them.

4. **Event payload schemas reuse existing brands.** Use `SessionID`, `AgentPath`, `AgentStatus` from existing modules. Don't redefine.

5. **Plugin authors get new hook surfaces for free** (via Bus). No plugin changes needed.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/v2/session-event.test.ts  # extend or create
bun test src/agent/control.test.ts     # re-run; new emission tests live here

bun test --coverage src/v2/session-event.ts
bun test --coverage src/agent/control.ts  # still 100% after the wiring
bun test --coverage src/bus/bus-event.ts  # if you touched it

# SDK regenerates cleanly (smoke test)
./packages/sdk/js/script/build.ts
```

All exit 0.

## Files

New: any new test files.

Modified:
- `packages/opencode/src/v2/session-event.ts` — add `Agent` namespace + extend `All` union
- `packages/opencode/src/bus/bus-event.ts` — if Bus event definitions live here (or alongside `Pty.Event` in `pty/index.ts`'s pattern, in `agent/control.ts`)
- `packages/opencode/src/agent/control.ts` — wire emission
