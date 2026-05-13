# Wave 7 ADR: AgentControl ↔ SessionPrompt circular dependency

## Decision

**Option 1** — `AgentControl` exposes a `registerRunLoop(fn)` method that
`SessionPrompt`'s layer init calls during its own layer build. AgentControl
stores the function in `InstanceState`; `spawnAgent` reads it and uses it to
fork the child's run loop via `Effect.forkIn(parentScope)`. If no run loop is
registered (test scenarios, early bring-up), `spawnAgent` falls back to a
no-op stub that immediately marks the child as `running` and waits for
explicit interruption — sufficient for AgentControl's unit tests, which
provide their own stub via `registerRunLoop`.

## Rationale

- **Breaks the type-level cycle.** AgentControl's layer never names
  `SessionPrompt.Service` as a dependency. SessionPrompt's layer (Wave 9)
  will name `AgentControl.Service` as a dependency and call
  `registerRunLoop` from inside its layer-init effect. Layers compose
  one-way; no `Layer.suspend` gymnastics needed.
- **Matches existing opencode runtime patterns.** `SessionRunState` already
  manages per-session `Runner` fibers in `InstanceState` (see
  `src/session/run-state.ts:32-46`). Storing a single `runLoopProvider`
  function in `AgentControl`'s `InstanceState` is the same shape one level
  up.
- **Testable in isolation.** Wave 7's tests inject a stub run loop and
  verify spawn/send/close mechanics without booting `SessionPrompt`.
  Production wiring is one explicit call in Wave 9; nothing implicit.

## Consequences for Wave 9

Wave 9 is responsible for two threads of integration:

1. **Wire the run loop provider.** Inside `SessionPrompt`'s layer effect
   (`packages/opencode/src/session/prompt.ts:93+`), after yielding all other
   services and BEFORE returning `Service.of(...)`, add:

   ```ts
   const agentControl = yield* AgentControl.Service
   yield* agentControl.registerRunLoop((sessionID) => loop({ sessionID }))
   ```

   `loop` is the existing `SessionPrompt.loop` closure already in scope at
   that point. The provider takes a `SessionID`, returns
   `Effect<MessageV2.WithParts>`. AgentControl forks it into the parent
   scope.

2. **Swap the dispatch site.** At `prompt.ts:1485-1488` (the `task?.type ===
   "subtask"` branch in `runLoop`), introduce v2 routing per
   `MESSAGE_SHAPES.md`:
   - If `task.protocol === "v2"` → call
     `agentControl.spawnAgent({ parentID, parentPath, task_name, agent_type,
     initial_message, options })`
   - Otherwise → fall through to the existing `handleSubtask(...)` path
     (legacy `task` tool keeps working — see `BACKWARD_COMPAT.md`)

3. **Drain mailbox before each model call.** At the existing `lastUser`
   detection block around `prompt.ts:1437-1449`, after computing the user
   message, call `agentControl.drainMailbox(sessionID)` and inject each
   drained `InterAgentCommunication` as a synthetic `MessageV2.UserPart`
   per the shape in `MESSAGE_SHAPES.md`. The `runLoop` then proceeds with
   those parts visible to the model.

## What was rejected and why

- **Option 2 (lazy service location at spawn time).** Yielding
  `SessionPrompt.Service` inside `AgentControl.spawnAgent` would defer the
  cycle from layer-build to fiber-effect time, but Effect's runtime layer
  resolution still walks the dependency graph eagerly when constructing a
  service instance for a fiber's context. Tests that mount only
  `AgentControl.layer` cannot resolve `SessionPrompt.Service` — they'd be
  forced to mount the entire `SessionPrompt.defaultLayer`, including LLM,
  Provider, Plugin, Compaction, etc. The provider-registration approach
  keeps tests cheap.

- **Option 3 (separate `SessionLoopRunner` service).** Cleanest factoring,
  but it would require carving the run-loop entry point out of
  `SessionPrompt` (currently a 1931-line module). That's a refactor of
  shipping code with broad downstream blast radius — the campaign already
  promises no behavioral changes outside the new feature areas
  (`BACKWARD_COMPAT.md`). Defer this refactor to a future cleanup wave if
  the registration pattern proves brittle in practice.
