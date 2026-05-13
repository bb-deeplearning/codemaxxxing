# Wave 6 — Agent registry

**Prior waves:** 0-5 (mailbox + AgentPath in place).
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`, `MESSAGE_SHAPES.md`.
**Codex source to mirror:**
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/registry.rs` (344 lines) — `AgentRegistry`, `SpawnReservation`, depth+concurrency limits, nickname pool

Constants `AGENT_MAX_DEPTH = 4` and `AGENT_MAX_THREADS = undefined` (no cap default) live in this module — not in Config. See `MESSAGE_SHAPES.md` § "Constants split". If a future task wants user-tunable values, that's a separate Config wave.

## Goal

Build the per-root-tree agent registry: tracks live agents by path/id/nickname/role, enforces concurrency cap, allocates nicknames from a pool with reset-and-suffix when exhausted, supports SpawnReservation RAII.

## Tasks

Sequential.

### 1. Nickname pool

File: `packages/opencode/src/agent/builtins/agent-names.ts`

Export an array of friendly agent nicknames as `string[]`. Codex sources from `agent_names.txt`. Ours can be a similar list — pick names that read well in TUI footer ("Worker Bee", "Cassandra", "Hermes", etc.). Aim for 100+ unique names so the pool reset is rare.

```ts
export const AGENT_NAMES: readonly string[] = [
  // ... 100+ names
]
```

Tests in `agent-names.test.ts`:
- list is non-empty
- no duplicates
- all entries are non-empty strings
- entries match a sane character set (letters, spaces — no special chars)

### 2. AgentMetadata type

File: `packages/opencode/src/agent/metadata.ts`

```ts
export class AgentMetadata extends Schema.Class<AgentMetadata>("AgentMetadata")({
  agent_id: Schema.optional(SessionID),    // codex calls this thread_id; ours is a SessionID
  agent_path: Schema.optional(AgentPath),
  agent_nickname: Schema.optional(Schema.String),
  agent_role: Schema.optional(Schema.String),
  last_task_message: Schema.optional(Schema.String),
}) {}

export * as AgentMetadata from "./metadata"
```

Tests cover construction, schema decode, optional field handling.

### 3. Tests first for Registry

File: `packages/opencode/src/agent/registry.test.ts`

Cover (mirror codex `registry_tests.rs`):

- `reserveSpawnSlot succeeds when under cap (cap = AGENT_MAX_THREADS or undefined for no cap)`
- `reserveSpawnSlot rejects when at AGENT_MAX_THREADS` (when cap is set)
- `reserveSpawnSlot with no cap (undefined) always succeeds`
- `SpawnReservation.commit registers the agent in the tree`
- `SpawnReservation dropped without commit releases the slot` — verify total_count decremented
- `SpawnReservation reserve_agent_path rejects duplicate path`
- `SpawnReservation reserve_agent_path on drop releases the path reservation`
- `register_root_thread idempotent — calling twice doesn't double-register`
- `release_spawned_thread on a non-root agent decrements total_count`
- `release_spawned_thread on root does NOT decrement total_count` (root is implicit)
- `agent_id_for_path returns the registered SessionID for a known path`
- `agent_id_for_path returns undefined for an unknown path`
- `agent_metadata_for_thread returns metadata for a known SessionID`
- `live_agents returns all non-root agents`
- `update_last_task_message persists the message in metadata`

**Nickname pool:**
- `reserve_agent_nickname picks an unused name from the candidates`
- `reserve_agent_nickname respects preferred name when provided and available`
- `reserve_agent_nickname falls back to candidates when preferred is taken`
- `reserve_agent_nickname resets the pool with suffix when exhausted` — exhaust the candidate list, next reservation should be `<name> the 2nd`
- `nickname pool reset increments suffix on subsequent resets` — `<name> the 3rd`, etc.
- `english ordinal suffix correctness for 1..30 (st, nd, rd, th, including 11..13 → th)`

**Depth limits:**
- `next_thread_spawn_depth from a SessionSource returns 1 when source is root`
- `next_thread_spawn_depth from a ThreadSpawn { depth: N } returns N+1`
- `exceeds_thread_spawn_depth_limit returns true when depth > AGENT_MAX_DEPTH (4 by default)`

### 4. Implement Registry

File: `packages/opencode/src/agent/registry.ts`

```ts
import { Effect, Ref, Context, Layer } from "effect"
import { AgentPath } from "./agent-path"
import { AgentMetadata } from "./metadata"
import { SessionID } from "@/session/schema"
import { AGENT_NAMES } from "./builtins/agent-names"

export interface Interface {
  readonly reserveSpawnSlot: (maxThreads?: number) => Effect.Effect<SpawnReservation, AgentLimitReachedError>
  readonly registerRootThread: (id: SessionID) => Effect.Effect<void>
  readonly releaseSpawnedThread: (id: SessionID) => Effect.Effect<void>
  readonly agentIdForPath: (p: AgentPath) => Effect.Effect<SessionID | undefined>
  readonly agentMetadataForThread: (id: SessionID) => Effect.Effect<AgentMetadata | undefined>
  readonly liveAgents: () => Effect.Effect<readonly AgentMetadata[]>
  readonly updateLastTaskMessage: (id: SessionID, msg: string) => Effect.Effect<void>
}

export interface SpawnReservation {
  readonly reserveAgentNicknameWithPreference: (
    candidates: readonly string[],
    preferred?: string,
  ) => Effect.Effect<string, NoNicknameAvailableError>
  readonly reserveAgentPath: (path: AgentPath) => Effect.Effect<void, PathAlreadyExistsError>
  readonly commit: (metadata: AgentMetadata) => Effect.Effect<void>
  readonly release: () => Effect.Effect<void>  // explicit release for non-commit paths
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentRegistry") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  // Internal state in a Ref:
  // - agentTree: Map<string, AgentMetadata>  (key is agent_path string; "/root" is the root entry)
  // - usedNicknames: Set<string>
  // - nicknameResetCount: number
  // - totalCount: number  (excludes root)
  // - reservedPaths: Set<string>  (paths held by uncommitted reservations)
  
  // ... implement per codex registry.rs
}))

export class AgentLimitReachedError extends Schema.TaggedErrorClass<AgentLimitReachedError>()(
  "AgentLimitReachedError",
  { max_threads: Schema.Number },
) {}

export class NoNicknameAvailableError extends Schema.TaggedErrorClass<NoNicknameAvailableError>()(
  "NoNicknameAvailableError",
  {},
) {}

export class PathAlreadyExistsError extends Schema.TaggedErrorClass<PathAlreadyExistsError>()(
  "PathAlreadyExistsError",
  { path: AgentPath },
) {}

// Helper exports
export const nextThreadSpawnDepth: (source: { depth?: number } | null) => number
export const exceedsThreadSpawnDepthLimit: (depth: number, max: number) => boolean
export const formatAgentNickname: (name: string, resetCount: number) => string

export * as AgentRegistry from "./registry"
```

**Important — `SpawnReservation` lifetime in Effect**: codex uses Rust's `Drop` trait for auto-release. Effect equivalent: use `Effect.acquireRelease` so the reservation is released if the wave's spawn flow fails before `commit`. Inside `AgentControl.spawn_agent` (Wave 7), wrap the spawn flow in `Effect.acquireRelease(reserveSpawnSlot(), (res, exit) => Exit.isFailure(exit) ? res.release() : Effect.void)` (or similar — design carefully so that `commit` succeeds suppress the release).

Cleaner pattern: `reserveSpawnSlot` returns a `SpawnReservation` object with `.commit` and `.release`. Inside spawn, use `acquireUseRelease`:

```ts
yield* Effect.acquireUseRelease(
  registry.reserveSpawnSlot(cfg.agent_max_threads),
  (reservation) => /* spawn flow that calls reservation.commit on success */,
  (reservation, exit) => Exit.isSuccess(exit) ? Effect.void : reservation.release(),
)
```

Document this pattern in registry.ts.

### 5. Bench

File: `packages/opencode/test/perf/registry.bench.ts`

- `registry.reserveSpawnSlot.then.commit` — full reservation cycle
- `registry.agentIdForPath.lookup` — 1000 lookups in a populated registry
- `registry.liveAgents.snapshot` — snapshot a populated registry of N=64 agents

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_6.json`.

## Gotchas

1. **Root is implicit, not counted.** `register_root_thread` adds `/root` to the tree; `release_spawned_thread` for `/root` is a no-op for `total_count`. Only non-root agents count toward `agent_max_threads`.

2. **Reservation vs commit.** A reservation HOLDS a slot; commit FILLS it with metadata. Drop without commit releases the slot. This pattern lets us call `reserveSpawnSlot` BEFORE we know the SessionID (which is allocated mid-spawn) — codex does this so it can fail fast on cap-exceeded.

3. **Path reservation separate from slot reservation.** `reserveSpawnSlot` reserves a counted slot; `reserveAgentPath` reserves a specific path string. Both must succeed before commit. Reserved-but-uncommitted paths are tracked in a Set so concurrent spawns can't grab the same path.

4. **Nickname pool exhaustion.** When all candidates are used, codex resets the pool and increments a counter. Subsequent picks get the suffix `the 2nd`, `the 3rd`, etc. Match the English ordinal suffix logic exactly (special case 11/12/13 → "th").

5. **Concurrency.** Multiple sibling spawns can race. The internal Ref must be updated atomically — use `Ref.update` (which is atomic in Effect). For multi-step transactions (reserve slot AND reserve path), use `Ref.modify` or wrap in `Synchronized.Ref`.

6. **`InstanceState` for the registry per parent tree.** The registry lives in `InstanceState` keyed on the root SessionID. Wave 7's `AgentControl` constructs the registry per-instance and shares it across the tree.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/agent/registry.test.ts
bun test src/agent/metadata.test.ts
bun test src/agent/builtins/agent-names.test.ts

bun test --coverage src/agent/registry.ts          # 100%
bun test --coverage src/agent/metadata.ts          # 100%
bun test --coverage src/agent/builtins/agent-names.ts  # 100%

bun test test/perf/registry.bench.ts
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_6.json
```

All exit 0.

## Files

New:
- `packages/opencode/src/agent/builtins/agent-names.ts`
- `packages/opencode/src/agent/builtins/agent-names.test.ts`
- `packages/opencode/src/agent/metadata.ts`
- `packages/opencode/src/agent/metadata.test.ts`
- `packages/opencode/src/agent/registry.ts`
- `packages/opencode/src/agent/registry.test.ts`
- `packages/opencode/test/perf/registry.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_6.json`

Modified: none.
