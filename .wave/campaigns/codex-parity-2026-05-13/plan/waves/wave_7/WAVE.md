# Wave 7 — AgentControl service

**Prior waves:** 0-6 (mailbox, AgentPath, registry, metadata).
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`, `MESSAGE_SHAPES.md`, `BACKWARD_COMPAT.md`, `REFERENCES.md`.
**Codex source to mirror:**
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/control.rs` (1258 lines) — entry point at line 184 (`spawn_agent_with_metadata`), inter-agent communication at line 671, close at 737, list at 864
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/agent_resolver.rs` (36 lines) — `resolve_agent_target`
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/status.rs` (28 lines) — `AgentStatus` derivation

## Goal

Build the orchestration service that owns the per-parent registry + per-session mailboxes + agent lifecycle. Exposes `spawnAgent`, `sendInterAgentCommunication`, `closeAgent`, `listAgents`, `subscribeStatus`, `resolveAgentReference`, `getAgentMetadata`. Each spawned agent runs in its own fiber via `Effect.forkIn`.

This is the largest wave by code volume. Take it carefully.

## Tasks

Sequential.

### 0. Write the architecture decision record (ADR) FIRST

Before writing any code in this wave, decide how you'll resolve the AgentControl ↔ SessionPrompt circular dependency (see "Critical design point" below for the three options).

Write the decision to `.wave/campaigns/codex-parity-2026-05-13/plan/waves/wave_7/ADR.md` BEFORE step 1. Format:

```markdown
# Wave 7 ADR: AgentControl ↔ SessionPrompt circular dependency

## Decision

[option 1 / option 2 / option 3 / something else]

## Rationale

[2-3 sentences why this option fits opencode's Effect+InstanceState patterns best]

## Consequences for Wave 9

[Specifically what the runLoop integration in Wave 9 needs to know — e.g. "Wave 9 calls AgentControl.setRunLoop(loop) at SessionPrompt.layer init" or "Wave 9 imports AgentControl.Service inside spawnAgent's effect; provided via Layer.mergeAll"]

## What was rejected and why

[1-2 sentences on the other options and why not]
```

This ADR is read by Wave 9 BEFORE designing the dispatch swap. It removes the risk of Wave 9 re-deriving the wrong shape.

### 1. Define AgentStatus

File: `packages/opencode/src/agent/status.ts`

```ts
export const AgentStatus = Schema.Union([
  Schema.Literal("pending_init"),
  Schema.Literal("running"),
  Schema.Literal("interrupted"),
  Schema.Literal("shutdown"),
  Schema.Literal("not_found"),
  Schema.Struct({ completed: Schema.NullOr(Schema.String) }),
  Schema.Struct({ errored: Schema.String }),
])
export type AgentStatus = Schema.Schema.Type<typeof AgentStatus>

// Derive next status from a session lifecycle event (mirrors codex agent_status_from_event)
export const fromSessionEvent: (
  event: { type: string; ... },
  prev: AgentStatus,
) => AgentStatus | null  // null = no status change

// Final-status check
export const isFinal: (status: AgentStatus) => boolean

export * as AgentStatus from "./status"
```

Tests cover: each variant decodes; `fromSessionEvent` for each input event type; `isFinal` semantics.

### 2. Define LiveAgent return type

File: `packages/opencode/src/agent/live-agent.ts`

```ts
export class LiveAgent extends Schema.Class<LiveAgent>("LiveAgent")({
  thread_id: SessionID,
  metadata: AgentMetadata,
  status: AgentStatus,
}) {}

export * as LiveAgent from "./live-agent"
```

### 3. Tests first for AgentControl

File: `packages/opencode/src/agent/control.test.ts`

This is a large test file. Cover:

**Spawn**
- `spawnAgent creates a child session and returns LiveAgent` — uses real Session.Service (in test layer); verify SessionID is set, agent_path matches `/root/<task_name>`, status is `pending_init` or `running`
- `spawnAgent with parent_path /root/a and task_name "b" produces /root/a/b`
- `spawnAgent rejects when path already exists`
- `spawnAgent rejects when depth exceeds AGENT_MAX_DEPTH (default 4)` — set the constant or test against the default; spawn from depth-3 parent, expect AgentLimitReachedError or similar
- `spawnAgent rejects when AGENT_MAX_THREADS is reached` — only when cap is set; default unset = no cap
- `spawnAgent emits CollabAgentSpawnBegin and CollabAgentSpawnEnd events` (the Bus events go in Wave 10, but the AgentControl should fire emitter callbacks here — design the API so the emit is testable in this wave even before Wave 10 wires it to Bus)
- `spawnAgent forks the parent's runLoop fiber for the child` — verify the child session has a Runner instance after spawn

**Inter-agent communication**
- `sendInterAgentCommunication routes to target's mailbox` — send to a spawned child, drain child's mailbox, verify message present
- `sendInterAgentCommunication with trigger_turn: true wakes the recipient` — recipient's mailbox seq watch advances; if recipient was waiting in `wait_agent`, that wait resumes
- `sendInterAgentCommunication on non-existent target returns InternalAgentDied or similar typed error`
- `sendInterAgentCommunication updates last_task_message in registry`

**Resolve**
- `resolveAgentReference for relative name resolves against current` — current=/root/a, ref="b" → /root/a/b
- `resolveAgentReference for canonical path returns it as-is`
- `resolveAgentReference for unknown live path errors`
- `resolveAgentReference for "/root" returns the root SessionID`

**Close**
- `closeAgent shuts down target and descendants` — spawn /root/a, /root/a/b, /root/a/c; close /root/a; verify b and c are also gone
- `closeAgent on root errors`
- `closeAgent on already-shutdown is idempotent`
- `closeAgent returns previous_status`
- `closeAgent fires Effect.interrupt on the child fiber` — verify the fiber is interrupted, Runner.cancel called

**List**
- `listAgents returns all live non-root agents`
- `listAgents with path_prefix filters` — populate `/root/a/x`, `/root/a/y`, `/root/b/z`; prefix `/root/a` returns x and y only
- `listAgents includes root in the result when prefix matches root`
- `listAgents includes last_task_message and current status for each`

**Subscribe**
- `subscribeStatus returns a watch.Receiver-equivalent that yields status changes` — spawn, subscribe, drive status changes, assert observer sees them
- `subscribeStatus on shutdown agent yields the final status then completes`

**Concurrency**
- `spawning 4 agents in parallel each gets a unique nickname and unique path`
- `concurrent sendInterAgentCommunication to one target — all messages enqueued in some order`
- `closing parent while children are mid-turn interrupts them cleanly`

### 4. Implement AgentControl

File: `packages/opencode/src/agent/control.ts`

```ts
import { Context, Effect, Layer, Ref, Scope, SubscriptionRef } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"  // for SessionPrompt.loop
import { Mailbox } from "./mailbox"
import { AgentRegistry } from "./registry"
import { AgentPath } from "./agent-path"
import { AgentStatus } from "./status"
import { LiveAgent } from "./live-agent"
import { AgentMetadata } from "./metadata"
import { InterAgentCommunication } from "./inter-agent-communication"

export interface SpawnAgentOptions {
  fork_turns?: "none" | "all" | number
  // future: model override, reasoning_effort override, environments
}

export interface Interface {
  readonly registerSessionRoot: (rootID: SessionID) => Effect.Effect<void>
  readonly spawnAgent: (input: {
    parentID: SessionID
    parentPath: AgentPath  // current agent's path; child path = parentPath / task_name
    task_name: string
    agent_type?: string  // role name; defaults to "default"
    initial_message: string
    options?: SpawnAgentOptions
  }) => Effect.Effect<LiveAgent, ...errors>
  
  readonly sendInterAgentCommunication: (
    targetID: SessionID,
    comm: InterAgentCommunication,
  ) => Effect.Effect<void, ...errors>
  
  readonly closeAgent: (id: SessionID) => Effect.Effect<{ previous_status: AgentStatus }, ...errors>
  
  readonly listAgents: (
    currentPath: AgentPath,
    pathPrefix?: string,
  ) => Effect.Effect<readonly { agent_name: string; agent_status: AgentStatus; last_task_message?: string }[]>
  
  readonly resolveAgentReference: (
    currentPath: AgentPath,
    reference: string,
  ) => Effect.Effect<SessionID, ...errors>
  
  readonly getAgentMetadata: (id: SessionID) => Effect.Effect<AgentMetadata | undefined>
  
  readonly subscribeStatus: (id: SessionID) => Effect.Effect<SubscriptionRef.SubscriptionRef<AgentStatus>>
  
  readonly subscribeMailboxSeq: (id: SessionID) => Effect.Effect<SubscriptionRef.SubscriptionRef<number>>
  
  readonly hasPendingMailboxItems: (id: SessionID) => Effect.Effect<boolean>
  
  readonly drainMailbox: (id: SessionID) => Effect.Effect<readonly InterAgentCommunication[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentControl") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const registry = yield* AgentRegistry.Service
  const sessions = yield* Session.Service
  // SessionPrompt.Service can't be a direct dependency due to circular import
  // (SessionPrompt.runLoop will use AgentControl via runtime injection in Wave 9)
  
  const state = yield* InstanceState.make(Effect.gen(function* () {
    // Per-instance state. Holds:
    // - mailboxes: Map<SessionID, Mailbox.Interface>
    // - statuses: Map<SessionID, SubscriptionRef<AgentStatus>>
    // - childFibers: Map<SessionID, Fiber.Fiber<...>>
    // - parentScope: Scope.Scope  (for forkIn)
    
    // Finalizer: interrupt all child fibers, drain all mailboxes, clear maps
    yield* Effect.addFinalizer(() => /* terminate all */)
    
    return { ... }
  }))
  
  const spawnAgent = Effect.fn("AgentControl.spawnAgent")(function* (input) {
    // 1. Resolve child path: AgentPath.join(input.parentPath, input.task_name)
    // 2. Look up role from input.agent_type (or "default")
    // 3. Reserve spawn slot via registry.reserveSpawnSlot(cfg.agent_max_threads)
    // 4. Reserve agent path
    // 5. Reserve nickname (from agent role candidates or default pool)
    // 6. Create child session via Session.create({ parentID: input.parentID, agent: roleName, ...permission inheritance ... })
    // 7. Create Mailbox for child
    // 8. Create SubscriptionRef<AgentStatus> for child, set to "pending_init"
    // 9. Fork the child's runLoop fiber via Effect.forkIn(parentScope) — this calls SessionPrompt.loop with child sessionID
    //    (How: inject SessionPrompt.Service via service location at runtime; see Wave 9 for the wiring)
    // 10. Store mailbox + status + fiber in state maps
    // 11. Send the initial_message into the child's mailbox with trigger_turn: true (so child's runLoop drains it on first iteration)
    // 12. Commit reservation with metadata
    // 13. Return LiveAgent { thread_id: childSessionID, metadata, status }
  })
  
  // ... rest of methods
  
  return Service.of({ spawnAgent, sendInterAgentCommunication, closeAgent, ... })
}))

export const defaultLayer = layer.pipe(
  Layer.provide(AgentRegistry.layer),
  Layer.provide(Session.defaultLayer),
)

export * as AgentControl from "./control"
```

**Critical design point — circular dependency with SessionPrompt:**

`AgentControl.spawnAgent` needs to fork `SessionPrompt.loop(childSessionID)`. But `SessionPrompt` will need `AgentControl.Service` (in Wave 9) to dispatch v2 subagents from runLoop. This is circular.

Resolution options (in order of preference):

1. **Don't take SessionPrompt as a typed dependency in AgentControl's layer.** Instead, AgentControl exposes a `setRunLoop(fn)` method that SessionPrompt calls during its own layer init. AgentControl stores the function in state and uses it in `spawnAgent`. This breaks the type cycle while keeping the runtime wiring explicit.

2. **Lazy service location at spawn time.** Inside `spawnAgent`, do `const sp = yield* SessionPrompt.Service` and call `sp.loop({ sessionID })`. Effect's service resolution happens at fiber-effect time, not layer-build time, so the cycle exists at the runtime level only. If both layers are in the same `Layer.mergeAll`, this should work — but verify with a small experiment.

3. **A separate `SessionLoopRunner` service** that both SessionPrompt and AgentControl depend on. SessionLoopRunner.run(sessionID) is the single forkable entry point. SessionPrompt is the consumer of SessionLoopRunner; AgentControl injects it into child fibers. Cleanest, most refactoring.

Recommendation: option 1 for v0 (least intrusive); migrate to option 3 if option 1 proves brittle.

### 5. Bench

File: `packages/opencode/test/perf/agent-control.bench.ts`

- `agentControl.spawnAgent` — measure spawn latency end-to-end (with stub provider so the child's runLoop returns immediately)
- `agentControl.sendInterAgentCommunication` — measure routing latency
- `agentControl.listAgents.populated` — list with 16 live agents

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_7.json`.

## Gotchas

1. **Circular dependency.** Read the "Critical design point" above. Get the wiring right; otherwise Wave 9 is blocked.

2. **`Effect.forkIn(scope)` for child fibers.** The parent's runLoop scope is the right scope. When the parent ends (or its scope closes), siblings die. This is the lifecycle invariant.

3. **`Runner` per session.** The existing `SessionRunState` (`session/run-state.ts`) creates one `Runner` per session. Sibling sessions get THEIR OWN Runners — that's already correct from the existing infrastructure. AgentControl just needs to make sure spawning a child sessionID and calling `SessionPrompt.loop({ sessionID })` on it kicks off a Runner for that child. Verify by reading `SessionRunState.ensureRunning`.

4. **Permission inheritance.** When creating the child session, pass the parent's permission ruleset (similar to `task.ts:73-100`). The child gets the parent's allow/deny rules, optionally augmented by role-specific permissions. Wave 12 handles role-specific permission overrides.

5. **Mailbox routing on send.** Codex `send_inter_agent_communication` uses `state.send_op(target, Op::InterAgentCommunication { communication })`. In opencode, send goes directly into the per-session Mailbox. The recipient's runLoop drains the mailbox at turn start (Wave 9 wires this in).

6. **`closeAgent` cascades.** Walk the live tree from the target down (use registry.live_agents + parent linkage in agent_path), interrupt each fiber, release each registry slot. Codex does this in `shutdown_agent_tree` and `live_thread_spawn_descendants` (`control.rs:751-796`).

7. **Status derivation from session events.** The child session's runLoop emits `SessionEvent.Step.Started/Ended`, etc. AgentControl subscribes to these (via Bus) and derives `AgentStatus` per-session, updating the SubscriptionRef. `wait_agent` (Wave 8) and `list_agents` (Wave 8) read these statuses.

   For Wave 7, this can be partially stubbed — set status to "running" on spawn, "completed" on session end, "errored" on failure. Wave 10 wires the full event-driven status derivation when EventV2 events for agent lifecycle land.

8. **No backward-compat impact yet.** This wave adds new modules. It does NOT modify session/prompt.ts or the legacy task tool. Wave 9 does the integration.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/agent/control.test.ts
bun test src/agent/status.test.ts
bun test src/agent/live-agent.test.ts

bun test --coverage src/agent/control.ts        # 100%
bun test --coverage src/agent/status.ts         # 100%
bun test --coverage src/agent/live-agent.ts     # 100%

bun test test/perf/agent-control.bench.ts
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_7.json

# Existing session tests still pass
bun test src/session/
```

All exit 0.

## Files

New:
- `packages/opencode/src/agent/status.ts`
- `packages/opencode/src/agent/status.test.ts`
- `packages/opencode/src/agent/live-agent.ts`
- `packages/opencode/src/agent/control.ts`
- `packages/opencode/src/agent/control.test.ts`
- `packages/opencode/test/perf/agent-control.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_7.json`

Modified: none (Wave 9 does the runLoop integration).
