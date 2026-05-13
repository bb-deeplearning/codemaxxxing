import { Effect, Ref, Schema } from "effect"
import { SessionID } from "@/session/schema"
import { AgentPath } from "./agent-path"
import { AgentMetadata } from "./metadata"

// Per-tree agent registry, ported from codex's `AgentRegistry`
// (codex-rs/core/src/agent/registry.rs). One registry instance lives per
// root SessionID — Wave 7's AgentControl will hold one in InstanceState.
//
// Responsibilities:
//   - Track every live agent in the tree by SessionID, AgentPath, and nickname.
//   - Cap concurrent spawns per `maxThreads` (no cap when undefined — codex
//     default at registry.rs:88-91).
//   - Serve nickname requests from a candidate pool, recycling the pool with
//     an ordinal suffix ("Plato the 2nd") when every name is taken.
//   - Enforce that agent_path entries are unique across the tree.
//
// `SpawnReservation` is the codex `Drop`-based RAII pattern reshaped for
// Effect: a reservation holds the slot and (optionally) a path until either
// `commit(metadata)` finalizes the spawn or `release()` returns the slot.
// Wave 7 wraps this in `Effect.acquireUseRelease(reserveSpawnSlot(...), use,
// (res, exit) => Exit.isSuccess(exit) ? Effect.void : res.release())` so the
// slot is freed on any failure exit (typed errors, defects, interrupts).

export const AGENT_MAX_DEPTH = 4
export const AGENT_MAX_THREADS: number | undefined = undefined

const ROOT_KEY = String(AgentPath.ROOT)

// English ordinal suffix for `n`. Matches codex registry.rs:49-56 — the
// 11/12/13 special case is required for grammatical correctness ("11th", not
// "11st"). Used as the reset-pool suffix: reset 1 → "name the 2nd",
// reset 2 → "name the 3rd", reset 10 → "name the 11th", reset 20 → "name the 21st".
export const formatAgentNickname = (name: string, resetCount: number): string => {
  if (resetCount === 0) return name
  const value = resetCount + 1
  const mod100 = value % 100
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : value % 10 === 1
        ? "st"
        : value % 10 === 2
          ? "nd"
          : value % 10 === 3
            ? "rd"
            : "th"
  return `${name} the ${value}${suffix}`
}

// Codex registry.rs:71-73 — the *child* spawn depth is the parent's depth + 1.
// A null/undefined source (root session) returns 1 (first sub-agent layer).
export const nextThreadSpawnDepth = (source: { depth?: number } | null | undefined): number =>
  Math.max(0, source?.depth ?? 0) + 1

// Codex registry.rs:75-77. Strict greater-than: depth == max is allowed; only
// depth > max rejects a spawn. AGENT_MAX_DEPTH defaults to 4 so the
// permitted depths are 1..=4 and a 5th level is rejected.
export const exceedsThreadSpawnDepthLimit = (depth: number, maxDepth: number): boolean =>
  depth > maxDepth

export class AgentLimitReachedError extends Schema.TaggedErrorClass<AgentLimitReachedError>()(
  "AgentLimitReachedError",
  { max_threads: Schema.Number },
) {
  override get message(): string {
    return `Agent thread limit reached: max_threads=${this.max_threads}`
  }
}

export class NoNicknameAvailableError extends Schema.TaggedErrorClass<NoNicknameAvailableError>()(
  "NoNicknameAvailableError",
  {},
) {
  override get message(): string {
    return "No agent nickname available"
  }
}

export class PathAlreadyExistsError extends Schema.TaggedErrorClass<PathAlreadyExistsError>()(
  "PathAlreadyExistsError",
  { path: AgentPath },
) {
  override get message(): string {
    return `Agent path '${this.path}' already exists`
  }
}

export interface SpawnReservation {
  /**
   * Pick a nickname from `candidates`, optionally honoring `preferred`.
   *
   * Preferred semantics: if `preferred` is supplied AND not already in use,
   * it is returned verbatim. If `preferred` is taken (or omitted), a name is
   * chosen at random from `candidates` after applying the current reset
   * suffix and filtering out names that are already used. When every
   * candidate (after suffixing) is taken, the pool resets — used set is
   * cleared, the reset counter increments, and a candidate is returned with
   * the next ordinal suffix.
   *
   * Diverges from codex on one point: codex always returns `preferred` even
   * when taken, allowing nickname collisions. We treat `preferred` as a soft
   * hint and fall back to candidates so two siblings cannot end up with the
   * same nickname through the model preferring the same string twice.
   */
  readonly reserveAgentNicknameWithPreference: (
    candidates: ReadonlyArray<string>,
    preferred?: string,
  ) => Effect.Effect<string, NoNicknameAvailableError>
  /** Reserve a specific path; rejects if already in the tree. */
  readonly reserveAgentPath: (path: AgentPath) => Effect.Effect<void, PathAlreadyExistsError>
  /**
   * Finalize the spawn with full metadata. Inserts the metadata into the
   * tree (overwriting any reserved-but-uncommitted entry at the same path)
   * and marks the reservation inactive so a subsequent `release()` is a
   * no-op. If the metadata has no `agent_id`, this is a defensive no-op
   * mirroring codex's `register_spawned_thread` early return.
   */
  readonly commit: (metadata: AgentMetadata) => Effect.Effect<void>
  /**
   * Release the reservation: returns the counted slot, removes any
   * reserved-but-uncommitted path entry, and marks the reservation inactive
   * so a follow-up commit or release is a no-op. Idempotent.
   */
  readonly release: () => Effect.Effect<void>
}

export interface Interface {
  /**
   * Reserve a slot for a new spawn. When `maxThreads` is set, fails with
   * `AgentLimitReachedError` if the tree already holds that many counted
   * (non-root) agents. The returned reservation must be either committed or
   * released to balance the slot count.
   */
  readonly reserveSpawnSlot: (
    maxThreads?: number,
  ) => Effect.Effect<SpawnReservation, AgentLimitReachedError>
  /** Register the root SessionID under `/root`. Idempotent. */
  readonly registerRootThread: (id: SessionID) => Effect.Effect<void>
  /**
   * Remove an agent's tree entry and decrement the slot count if the agent
   * was non-root. Unknown SessionIDs are silently ignored. Releasing the
   * root SessionID does not change the count (root is implicit).
   */
  readonly releaseSpawnedThread: (id: SessionID) => Effect.Effect<void>
  /**
   * Look up the SessionID for a registered agent path. Returns undefined
   * when the path is unknown OR reserved-but-uncommitted (no agent_id yet).
   */
  readonly agentIdForPath: (path: AgentPath) => Effect.Effect<SessionID | undefined>
  /** Look up an agent's metadata by SessionID. */
  readonly agentMetadataForThread: (id: SessionID) => Effect.Effect<AgentMetadata | undefined>
  /** Snapshot every non-root agent currently in the tree. */
  readonly liveAgents: () => Effect.Effect<ReadonlyArray<AgentMetadata>>
  /**
   * Replace an agent's `last_task_message` field. Silent no-op for unknown
   * SessionIDs. Other metadata fields are preserved.
   */
  readonly updateLastTaskMessage: (id: SessionID, msg: string) => Effect.Effect<void>
}

interface State {
  agentTree: Map<string, AgentMetadata>
  usedNicknames: Set<string>
  nicknameResetCount: number
  totalCount: number
}

const initialState = (): State => ({
  agentTree: new Map(),
  usedNicknames: new Set(),
  nicknameResetCount: 0,
  totalCount: 0,
})

// Internal helper: locate the agent_tree key for a given SessionID. Returns
// the key + metadata pair, or null if no entry has that id. Linear scan over
// the tree because the path index is the primary key — codex does the same
// (registry.rs:107-108). Tree size is small (≤ AGENT_MAX_THREADS or whatever
// the model spawns), so the cost is negligible.
const findByThreadId = (
  s: State,
  id: SessionID,
): readonly [string, AgentMetadata] | null => {
  for (const [k, m] of s.agentTree) {
    if (m.agent_id === id) return [k, m] as const
  }
  return null
}

export const make = (): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(initialState())

    const reserveSpawnSlot = (
      maxThreads?: number,
    ): Effect.Effect<SpawnReservation, AgentLimitReachedError> =>
      Effect.gen(function* () {
        const ok = yield* Ref.modify(state, (s) => {
          if (maxThreads !== undefined && s.totalCount >= maxThreads) {
            return [false, s] as const
          }
          return [true, { ...s, totalCount: s.totalCount + 1 }] as const
        })
        if (!ok) {
          return yield* new AgentLimitReachedError({ max_threads: maxThreads as number })
        }

        // Reservation-local state captured by the closure. The contract is
        // that a reservation is used sequentially (no concurrent fork of its
        // methods), matching codex's `&mut self` API.
        let active = true
        let reservedPath: AgentPath | null = null

        const reserveAgentNicknameWithPreference = (
          candidates: ReadonlyArray<string>,
          preferred?: string,
        ): Effect.Effect<string, NoNicknameAvailableError> =>
          Effect.gen(function* () {
            const result = yield* Ref.modify(state, (s) => {
              // Soft preference: take preferred only when free.
              if (preferred !== undefined && !s.usedNicknames.has(preferred)) {
                const updated = new Set(s.usedNicknames)
                updated.add(preferred)
                return [preferred as string | null, { ...s, usedNicknames: updated }] as const
              }
              if (candidates.length === 0) {
                return [null as string | null, s] as const
              }
              const available = candidates
                .map((n) => formatAgentNickname(n, s.nicknameResetCount))
                .filter((n) => !s.usedNicknames.has(n))
              if (available.length > 0) {
                const pick = available[Math.floor(Math.random() * available.length)]
                const updated = new Set(s.usedNicknames)
                updated.add(pick)
                return [pick as string | null, { ...s, usedNicknames: updated }] as const
              }
              // Pool exhausted — clear used, bump suffix, pick from formatted
              // candidates with the new suffix. Mirrors registry.rs:220-233.
              const newReset = s.nicknameResetCount + 1
              const formatted = formatAgentNickname(
                candidates[Math.floor(Math.random() * candidates.length)],
                newReset,
              )
              return [
                formatted as string | null,
                { ...s, usedNicknames: new Set([formatted]), nicknameResetCount: newReset },
              ] as const
            })
            if (result === null) {
              return yield* new NoNicknameAvailableError({})
            }
            return result
          })

        const reserveAgentPath = (
          path: AgentPath,
        ): Effect.Effect<void, PathAlreadyExistsError> =>
          Effect.gen(function* () {
            const claimed = yield* Ref.modify(state, (s) => {
              const key = String(path)
              if (s.agentTree.has(key)) return [false, s] as const
              const newTree = new Map(s.agentTree)
              newTree.set(key, new AgentMetadata({ agent_path: path }))
              return [true, { ...s, agentTree: newTree }] as const
            })
            if (!claimed) return yield* new PathAlreadyExistsError({ path })
            reservedPath = path
          })

        const commit = (metadata: AgentMetadata): Effect.Effect<void> =>
          Ref.update(state, (s) => {
            // Defensive: codex's register_spawned_thread early-returns when
            // agent_id is None (registry.rs:184-186). Replicate so callers
            // can't smuggle a half-baked metadata into the index.
            if (metadata.agent_id === undefined) {
              active = false
              reservedPath = null
              return s
            }
            const key =
              metadata.agent_path !== undefined
                ? String(metadata.agent_path)
                : `thread:${metadata.agent_id}`
            const newTree = new Map(s.agentTree)
            const newUsed = new Set(s.usedNicknames)
            if (metadata.agent_nickname !== undefined) newUsed.add(metadata.agent_nickname)
            newTree.set(key, metadata)
            active = false
            reservedPath = null
            return { ...s, agentTree: newTree, usedNicknames: newUsed }
          })

        const release = (): Effect.Effect<void> =>
          Effect.suspend(() => {
            if (!active) return Effect.void
            // Capture the path locally so the subsequent reset can't mutate it
            // out from under the Ref.update closure if a concurrent fiber
            // (defensive — the API is sequential) flipped active.
            const pathToFree = reservedPath
            active = false
            reservedPath = null
            return Ref.update(state, (s) => {
              const newTree = new Map(s.agentTree)
              if (pathToFree !== null) {
                const key = String(pathToFree)
                const meta = newTree.get(key)
                // Only remove the entry if it's still the uncommitted
                // placeholder (no agent_id). Mirrors codex registry.rs:266-272.
                if (meta && meta.agent_id === undefined) newTree.delete(key)
              }
              return {
                ...s,
                agentTree: newTree,
                totalCount: Math.max(0, s.totalCount - 1),
              }
            })
          })

        return { reserveAgentNicknameWithPreference, reserveAgentPath, commit, release }
      })

    const registerRootThread = (id: SessionID): Effect.Effect<void> =>
      Ref.update(state, (s) => {
        if (s.agentTree.has(ROOT_KEY)) return s
        const newTree = new Map(s.agentTree)
        newTree.set(
          ROOT_KEY,
          new AgentMetadata({ agent_id: id, agent_path: AgentPath.root() }),
        )
        return { ...s, agentTree: newTree }
      })

    const releaseSpawnedThread = (id: SessionID): Effect.Effect<void> =>
      Ref.update(state, (s) => {
        const found = findByThreadId(s, id)
        if (found === null) return s
        const [key, m] = found
        const newTree = new Map(s.agentTree)
        newTree.delete(key)
        const isRoot =
          m.agent_path !== undefined && AgentPath.isRoot(m.agent_path)
        return {
          ...s,
          agentTree: newTree,
          totalCount: isRoot ? s.totalCount : Math.max(0, s.totalCount - 1),
        }
      })

    const agentIdForPath = (path: AgentPath): Effect.Effect<SessionID | undefined> =>
      Effect.map(Ref.get(state), (s) => s.agentTree.get(String(path))?.agent_id)

    const agentMetadataForThread = (id: SessionID): Effect.Effect<AgentMetadata | undefined> =>
      Effect.map(Ref.get(state), (s) => findByThreadId(s, id)?.[1])

    const liveAgents = (): Effect.Effect<ReadonlyArray<AgentMetadata>> =>
      Effect.map(Ref.get(state), (s) =>
        Array.from(s.agentTree.values()).filter(
          (m) =>
            m.agent_id !== undefined &&
            !(m.agent_path !== undefined && AgentPath.isRoot(m.agent_path)),
        ),
      )

    const updateLastTaskMessage = (id: SessionID, msg: string): Effect.Effect<void> =>
      Ref.update(state, (s) => {
        const found = findByThreadId(s, id)
        if (found === null) return s
        const [key, m] = found
        const newTree = new Map(s.agentTree)
        newTree.set(
          key,
          new AgentMetadata({
            agent_id: m.agent_id,
            agent_path: m.agent_path,
            agent_nickname: m.agent_nickname,
            agent_role: m.agent_role,
            last_task_message: msg,
          }),
        )
        return { ...s, agentTree: newTree }
      })

    return {
      reserveSpawnSlot,
      registerRootThread,
      releaseSpawnedThread,
      agentIdForPath,
      agentMetadataForThread,
      liveAgents,
      updateLastTaskMessage,
    }
  })

export * as AgentRegistry from "./registry"
