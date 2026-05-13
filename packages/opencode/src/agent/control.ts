import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { AgentPath, AgentPathInvalidError } from "./agent-path"
import { AgentMetadata } from "./metadata"
import { AgentStatus } from "./status"
import { LiveAgent } from "./live-agent"
import { InterAgentCommunication } from "./inter-agent-communication"
import { Mailbox } from "./mailbox"
import {
  AGENT_MAX_DEPTH,
  AGENT_MAX_THREADS,
  AgentLimitReachedError,
  AgentRegistry,
  NoNicknameAvailableError,
  PathAlreadyExistsError,
  exceedsThreadSpawnDepthLimit,
} from "./registry"

// AgentControl is the orchestration layer for codex's multi-agents-v2
// subsystem ported to opencode. It owns the per-tree AgentRegistry, every
// child agent's Mailbox, every child agent's status SubscriptionRef, and the
// fiber running each child's run loop.
//
// Codex source: codex-rs/core/src/agent/control.rs (1258 lines). We mirror
// the public surface — spawn / send / close / list / resolve / subscribe —
// minus codex-only concerns (rollout fork mode, exec policy inheritance,
// shell-snapshot inheritance) which either don't apply to opencode's runtime
// or land in later waves.
//
// Circular dependency resolution: the run loop that drives each child
// session lives inside SessionPrompt — but SessionPrompt depends on
// AgentControl (Wave 9) for v2 dispatch. To break the cycle, AgentControl
// exposes `registerRunLoop(fn)` that SessionPrompt's layer init calls.
// AgentControl stores the function in InstanceState and uses it during
// `spawnAgent`. See ADR.md in this wave's plan dir for the full rationale.

// Default nickname pool used when no role-specific candidates are configured.
// Wave 12 will lift role-aware candidate selection from
// `agent_nickname_candidates` (control.rs:82-97) once roles land; Wave 7
// keeps a single shared pool to exercise the registry's reservation path.
const DEFAULT_NICKNAME_CANDIDATES = [
  "plato",
  "newton",
  "hypatia",
  "euler",
  "lovelace",
  "turing",
  "noether",
  "ramanujan",
  "gauss",
  "bohr",
  "darwin",
  "curie",
  "feynman",
  "einstein",
  "pasteur",
  "linnaeus",
] as const

const ROOT_LAST_TASK_MESSAGE = "Main thread"

// SpawnEvent fires for every spawn lifecycle phase. Wave 7 surfaces these via
// `onSpawnEvent` callbacks; Wave 10 will mirror them to Bus events for
// EventV2 + downstream subscribers (TUI, analytics).
export type SpawnEvent =
  | { readonly type: "spawn_begin"; readonly sessionID: SessionID; readonly path: AgentPath }
  | {
      readonly type: "spawn_end"
      readonly sessionID: SessionID
      readonly path: AgentPath
      readonly metadata: AgentMetadata
    }
  | { readonly type: "spawn_error"; readonly path: AgentPath; readonly reason: string }
  | {
      readonly type: "shutdown"
      readonly sessionID: SessionID
      readonly path: AgentPath
      readonly previousStatus: AgentStatus
    }

export class AgentDepthExceededError extends Schema.TaggedErrorClass<AgentDepthExceededError>()(
  "AgentDepthExceededError",
  {
    depth: Schema.Number,
    max: Schema.Number,
  },
) {
  override get message(): string {
    return `Agent spawn depth ${this.depth} exceeds max=${this.max}`
  }
}

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()(
  "AgentNotFoundError",
  { session: SessionID },
) {
  override get message(): string {
    return `Agent not found: ${this.session}`
  }
}

export class AgentReferenceInvalidError extends Schema.TaggedErrorClass<AgentReferenceInvalidError>()(
  "AgentReferenceInvalidError",
  { reference: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cannot resolve agent reference '${this.reference}': ${this.reason}`
  }
}

export interface ListedAgent {
  readonly agent_name: string
  readonly agent_status: AgentStatus
  readonly last_task_message?: string
}

export interface SpawnAgentOptions {
  readonly fork_turns?: "none" | "all" | number
  // Future: model override, reasoning_effort override, environments. Wave 7
  // ships the option struct so callers can already pass it without breaking
  // the signature when later waves wire the fields.
}

export interface SpawnAgentInput {
  readonly parentID: SessionID
  readonly parentPath: AgentPath
  readonly task_name: string
  readonly agent_type?: string
  readonly initial_message: string
  readonly options?: SpawnAgentOptions
  // Override the default thread cap (AGENT_MAX_THREADS, currently undefined =
  // no cap). Wave 9 will plumb this from Config; for Wave 7 the caller
  // supplies it directly so tests can exercise the cap path.
  readonly max_threads?: number
}

export type SpawnError =
  | AgentLimitReachedError
  | AgentDepthExceededError
  | AgentPathInvalidError
  | PathAlreadyExistsError
  | NoNicknameAvailableError

export interface Interface {
  readonly registerRunLoop: (
    fn: (sessionID: SessionID) => Effect.Effect<unknown>,
  ) => Effect.Effect<void>
  readonly onSpawnEvent: (callback: (event: SpawnEvent) => void) => Effect.Effect<() => void>
  readonly registerSessionRoot: (id: SessionID) => Effect.Effect<void>
  readonly spawnAgent: (input: SpawnAgentInput) => Effect.Effect<LiveAgent, SpawnError>
  readonly sendInterAgentCommunication: (
    targetID: SessionID,
    comm: InterAgentCommunication,
  ) => Effect.Effect<void, AgentNotFoundError>
  readonly closeAgent: (
    id: SessionID,
  ) => Effect.Effect<{ readonly previous_status: AgentStatus }, AgentNotFoundError>
  readonly listAgents: (
    currentPath: AgentPath,
    pathPrefix?: string,
  ) => Effect.Effect<readonly ListedAgent[], AgentPathInvalidError>
  readonly resolveAgentReference: (
    currentPath: AgentPath,
    reference: string,
  ) => Effect.Effect<SessionID, AgentReferenceInvalidError>
  readonly getAgentMetadata: (id: SessionID) => Effect.Effect<AgentMetadata | undefined>
  readonly subscribeStatus: (
    id: SessionID,
  ) => Effect.Effect<SubscriptionRef.SubscriptionRef<AgentStatus>, AgentNotFoundError>
  readonly subscribeMailboxSeq: (
    id: SessionID,
  ) => Effect.Effect<SubscriptionRef.SubscriptionRef<number>, AgentNotFoundError>
  readonly hasPendingMailboxItems: (id: SessionID) => Effect.Effect<boolean>
  readonly drainMailbox: (id: SessionID) => Effect.Effect<readonly InterAgentCommunication[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentControl") {}

// Depth = number of segments after `/root`. `/root` is depth 0; `/root/a/b/c/d`
// is depth 4. Mirrors codex's `thread_spawn_depth` indirectly — codex tracks
// depth on `SubAgentSource::ThreadSpawn { depth }`, but the value derived from
// the path is the same and avoids carrying parallel state.
const pathDepth = (p: AgentPath): number => {
  const s = p as string
  if (s === "/root") return 0
  return s.split("/").length - 2
}

// Internal mutable state held in InstanceState. One instance per project
// directory; wired up exactly once and torn down with the directory's
// disposal.
interface InternalState {
  readonly registry: AgentRegistry.Interface
  readonly mailboxes: Map<SessionID, Mailbox.Interface>
  readonly statuses: Map<SessionID, SubscriptionRef.SubscriptionRef<AgentStatus>>
  readonly fibers: Map<SessionID, Fiber.Fiber<unknown, unknown>>
  readonly listeners: Set<(event: SpawnEvent) => void>
  readonly providerRef: Ref.Ref<((sessionID: SessionID) => Effect.Effect<unknown>) | undefined>
  readonly rootRef: Ref.Ref<SessionID | undefined>
  readonly scope: Scope.Scope
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const state = yield* InstanceState.make(
      Effect.fn("AgentControl.state")(function* () {
        const scope = yield* Scope.Scope
        const registry = yield* AgentRegistry.make()
        const mailboxes = new Map<SessionID, Mailbox.Interface>()
        const statuses = new Map<SessionID, SubscriptionRef.SubscriptionRef<AgentStatus>>()
        const fibers = new Map<SessionID, Fiber.Fiber<unknown, unknown>>()
        const listeners = new Set<(event: SpawnEvent) => void>()
        const providerRef = yield* Ref.make<
          ((sessionID: SessionID) => Effect.Effect<unknown>) | undefined
        >(undefined)
        const rootRef = yield* Ref.make<SessionID | undefined>(undefined)

        // On instance disposal, interrupt every live child fiber so siblings
        // never outlive the project. The forkIn(parentScope) below wires
        // children into this same scope, so this finalizer is belt-and-braces.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(fibers.values(), (fiber) => Fiber.interrupt(fiber), {
              concurrency: "unbounded",
              discard: true,
            })
            fibers.clear()
            mailboxes.clear()
            statuses.clear()
            listeners.clear()
          }),
        )

        return {
          registry,
          mailboxes,
          statuses,
          fibers,
          listeners,
          providerRef,
          rootRef,
          scope,
        } satisfies InternalState
      }),
    )

    const emit = (data: InternalState, event: SpawnEvent): Effect.Effect<void> =>
      Effect.sync(() => {
        for (const cb of data.listeners) {
          // Listeners are user-supplied; we swallow per-callback errors so a
          // misbehaving subscriber can't break the spawn flow.
          try {
            cb(event)
          } catch {
            // intentional swallow — listener errors are isolated.
          }
        }
      })

    const registerRunLoop = Effect.fn("AgentControl.registerRunLoop")(function* (
      fn: (sessionID: SessionID) => Effect.Effect<unknown>,
    ) {
      const data = yield* InstanceState.get(state)
      yield* Ref.set(data.providerRef, fn)
    })

    const onSpawnEvent = Effect.fn("AgentControl.onSpawnEvent")(function* (
      callback: (event: SpawnEvent) => void,
    ) {
      const data = yield* InstanceState.get(state)
      data.listeners.add(callback)
      return () => {
        data.listeners.delete(callback)
      }
    })

    const registerSessionRoot = Effect.fn("AgentControl.registerSessionRoot")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      yield* data.registry.registerRootThread(id)
      yield* Ref.set(data.rootRef, id)
      // Initialize a status for the root so `subscribeStatus(rootID)` works
      // and `listAgents` can report a status for root. Real status updates
      // for root come later when Wave 10 wires SessionEvent.
      if (!data.statuses.has(id)) {
        const status = yield* SubscriptionRef.make<AgentStatus>("running")
        data.statuses.set(id, status)
      }
    })

    const spawnAgent = Effect.fn("AgentControl.spawnAgent")(function* (input: SpawnAgentInput) {
      const data = yield* InstanceState.get(state)
      // 1. Compute child path. Failure here is AgentPathInvalidError from
      //    AgentPath.join (the leaf failed segment validation).
      const childPath = yield* AgentPath.join(input.parentPath, input.task_name)

      // 2. Depth check before reserving anything — cheap to fail fast.
      const depth = pathDepth(childPath)
      if (exceedsThreadSpawnDepthLimit(depth, AGENT_MAX_DEPTH)) {
        return yield* new AgentDepthExceededError({ depth, max: AGENT_MAX_DEPTH })
      }

      // 3. If parent is root, ensure the root is registered (idempotent).
      if (AgentPath.isRoot(input.parentPath)) {
        yield* registerSessionRoot(input.parentID)
      }

      const cap = input.max_threads ?? AGENT_MAX_THREADS

      // 4. Use acquireUseRelease so the slot is freed on any failure exit.
      //    `use` does the path/nickname reservation, child session creation,
      //    mailbox/status/fiber setup, and the registry commit.
      return yield* Effect.acquireUseRelease(
        data.registry.reserveSpawnSlot(cap),
        (reservation) =>
          Effect.gen(function* () {
            yield* reservation.reserveAgentPath(childPath)
            const nickname = yield* reservation.reserveAgentNicknameWithPreference(
              DEFAULT_NICKNAME_CANDIDATES,
            )

            const parent = yield* sessions.get(input.parentID)
            const child = yield* sessions.create({
              parentID: input.parentID,
              title: `${input.task_name} (@${nickname})`,
              agent: input.agent_type,
              // Inherit parent's permission ruleset. Wave 12 will overlay
              // role-specific permissions on top.
              permission: parent.permission,
            })

            yield* emit(data, { type: "spawn_begin", sessionID: child.id, path: childPath })

            const mailbox = yield* Mailbox.make()
            const status = yield* SubscriptionRef.make<AgentStatus>("pending_init")

            // Seed the mailbox with the initial message BEFORE forking the
            // run loop so the first iteration sees it on drain.
            yield* mailbox.send(
              new InterAgentCommunication({
                author: input.parentPath,
                recipient: childPath,
                content: input.initial_message,
                trigger_turn: true,
                sent_at: Date.now(),
              }),
            )

            const metadata = new AgentMetadata({
              agent_id: child.id,
              agent_path: childPath,
              agent_nickname: nickname,
              agent_role: input.agent_type,
              last_task_message: input.initial_message,
            })
            yield* reservation.commit(metadata)

            data.mailboxes.set(child.id, mailbox)
            data.statuses.set(child.id, status)

            const provider = yield* Ref.get(data.providerRef)
            const loopEffect: Effect.Effect<unknown> = provider ? provider(child.id) : Effect.never

            const fiber = yield* loopEffect.pipe(
              // onExit handles natural completion / error. Interrupts (from
              // closeAgent) are detected via Cause.hasInterrupts so we don't
              // overwrite the "shutdown" status that closeAgent set first.
              Effect.onExit((exit: Exit.Exit<unknown, unknown>) =>
                Effect.gen(function* () {
                  data.fibers.delete(child.id)
                  if (Exit.isSuccess(exit)) {
                    yield* SubscriptionRef.set(status, { completed: null })
                    return
                  }
                  if (Cause.hasInterrupts(exit.cause)) {
                    // Already shutdown by closeAgent; leave status alone.
                    return
                  }
                  yield* SubscriptionRef.set(status, {
                    errored: Cause.pretty(exit.cause),
                  })
                }),
              ),
              Effect.forkIn(data.scope),
            )
            data.fibers.set(child.id, fiber)

            // Mark as running once the fiber is in flight. The status may
            // already have transitioned (rare but possible if the run loop
            // body executed synchronously). Only overwrite from pending_init.
            const current = yield* SubscriptionRef.get(status)
            if (current === "pending_init") {
              yield* SubscriptionRef.set(status, "running")
            }
            const finalStatus = yield* SubscriptionRef.get(status)

            yield* emit(data, { type: "spawn_end", sessionID: child.id, path: childPath, metadata })

            return new LiveAgent({
              thread_id: child.id,
              metadata,
              status: finalStatus,
            })
          }),
        (reservation, exit) =>
          Exit.isFailure(exit)
            ? Effect.gen(function* () {
                yield* reservation.release()
                yield* emit(data, {
                  type: "spawn_error",
                  path: childPath,
                  reason: Cause.pretty(exit.cause),
                })
              })
            : Effect.void,
      )
    })

    const sendInterAgentCommunication = Effect.fn("AgentControl.sendInterAgentCommunication")(
      function* (targetID: SessionID, comm: InterAgentCommunication) {
        const data = yield* InstanceState.get(state)
        const mailbox = data.mailboxes.get(targetID)
        if (!mailbox) {
          yield* new AgentNotFoundError({ session: targetID })
          return
        }
        yield* mailbox.send(comm)
        yield* data.registry.updateLastTaskMessage(targetID, comm.content)
      },
    )

    const closeAgent = Effect.fn("AgentControl.closeAgent")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const meta = yield* data.registry.agentMetadataForThread(id)
      const status = data.statuses.get(id)
      // Idempotent: a previously-shutdown agent has been removed from the
      // registry but kept its status entry. Return shutdown without error.
      if (!meta) {
        if (status) {
          const current = yield* SubscriptionRef.get(status)
          if (current === "shutdown") return { previous_status: "shutdown" as const }
        }
        return yield* new AgentNotFoundError({ session: id })
      }
      // Reject root explicitly — closing root would terminate the user's
      // session. Codex's UI prevents this; we make it a typed error so the
      // tool layer can map it to a model-recoverable message.
      if (meta.agent_path && AgentPath.isRoot(meta.agent_path)) {
        return yield* new AgentNotFoundError({ session: id })
      }

      const previousStatus: AgentStatus = status
        ? yield* SubscriptionRef.get(status)
        : "not_found"

      // Find descendants by path-prefix walk. Ordered descendants-first so
      // the leaf shutdown happens before its parent — mirrors codex's
      // `shutdown_agent_tree` (control.rs:751-761) which collects
      // descendants then shuts them down individually.
      const targetPath = meta.agent_path
      const allLive = yield* data.registry.liveAgents()
      const descendants = targetPath
        ? allLive.filter(
            (m) =>
              m.agent_id !== undefined &&
              m.agent_id !== id &&
              m.agent_path !== undefined &&
              ((m.agent_path as string).startsWith((targetPath as string) + "/")),
          )
        : []

      for (const desc of descendants) {
        if (desc.agent_id) yield* shutdownOne(data, desc.agent_id, desc.agent_path)
      }
      yield* shutdownOne(data, id, targetPath)

      return { previous_status: previousStatus }
    })

    const shutdownOne = (
      data: InternalState,
      sessionId: SessionID,
      agentPath: AgentPath | undefined,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const status = data.statuses.get(sessionId)
        const previousStatus: AgentStatus = status
          ? yield* SubscriptionRef.get(status)
          : "not_found"
        // Set status to shutdown FIRST. The fiber's onExit checks for
        // interrupts and leaves status alone in that case — order matters
        // here to avoid a race where the interrupt's onExit would overwrite.
        if (status) yield* SubscriptionRef.set(status, "shutdown")

        const fiber = data.fibers.get(sessionId)
        if (fiber) {
          yield* Fiber.interrupt(fiber)
          data.fibers.delete(sessionId)
        }
        data.mailboxes.delete(sessionId)
        yield* data.registry.releaseSpawnedThread(sessionId)
        yield* emit(data, {
          type: "shutdown",
          sessionID: sessionId,
          path: agentPath ?? AgentPath.root(),
          previousStatus,
        })
      })

    const listAgents = Effect.fn("AgentControl.listAgents")(function* (
      currentPath: AgentPath,
      pathPrefix?: string,
    ) {
      const data = yield* InstanceState.get(state)
      const resolvedPrefix = pathPrefix
        ? yield* AgentPath.resolve(currentPath, pathPrefix)
        : undefined

      const out: ListedAgent[] = []

      // Root entry — included only when the prefix matches root (i.e.
      // unfiltered or prefix == /root). Mirrors codex `list_agents`
      // (control.rs:864-907).
      const rootID = yield* Ref.get(data.rootRef)
      if (rootID && (!resolvedPrefix || agentMatchesPrefix(AgentPath.root(), resolvedPrefix))) {
        const rootStatus = data.statuses.get(rootID)
        out.push({
          agent_name: String(AgentPath.root()),
          agent_status: rootStatus ? yield* SubscriptionRef.get(rootStatus) : "running",
          last_task_message: ROOT_LAST_TASK_MESSAGE,
        })
      }

      const live = yield* data.registry.liveAgents()
      // Codex sorts by agent_path then by agent_id; in our model paths are
      // always unique (registry rejects duplicates), so a single localeCompare
      // on path is sufficient for stable ordering. Mirrors the intent of
      // codex `list_agents` (control.rs:880-892) without the tie-break.
      const sorted = [...live].sort((a, b) =>
        String(a.agent_path ?? "").localeCompare(String(b.agent_path ?? "")),
      )

      for (const m of sorted) {
        if (!m.agent_id) continue
        if (resolvedPrefix && !agentMatchesPrefix(m.agent_path, resolvedPrefix)) continue
        const sub = data.statuses.get(m.agent_id)
        const status: AgentStatus = sub ? yield* SubscriptionRef.get(sub) : "not_found"
        const name = m.agent_path ? String(m.agent_path) : m.agent_id
        out.push({
          agent_name: name,
          agent_status: status,
          last_task_message: m.last_task_message,
        })
      }

      return out
    })

    const resolveAgentReference = Effect.fn("AgentControl.resolveAgentReference")(function* (
      currentPath: AgentPath,
      reference: string,
    ) {
      const data = yield* InstanceState.get(state)
      const resolved = yield* AgentPath.resolve(currentPath, reference).pipe(
        Effect.mapError((e) => new AgentReferenceInvalidError({ reference, reason: e.reason })),
      )
      // Root resolves via the rootRef set by registerSessionRoot.
      if (AgentPath.isRoot(resolved)) {
        const rootID = yield* Ref.get(data.rootRef)
        if (rootID) return rootID
        return yield* new AgentReferenceInvalidError({
          reference,
          reason: "root session has not been registered",
        })
      }
      const sid = yield* data.registry.agentIdForPath(resolved)
      if (sid) return sid
      return yield* new AgentReferenceInvalidError({
        reference,
        reason: `live agent path '${resolved}' not found`,
      })
    })

    const getAgentMetadata = Effect.fn("AgentControl.getAgentMetadata")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      return yield* data.registry.agentMetadataForThread(id)
    })

    const subscribeStatus = Effect.fn("AgentControl.subscribeStatus")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const ref = data.statuses.get(id)
      if (!ref) return yield* new AgentNotFoundError({ session: id })
      return ref
    })

    const subscribeMailboxSeq = Effect.fn("AgentControl.subscribeMailboxSeq")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const mailbox = data.mailboxes.get(id)
      if (!mailbox) return yield* new AgentNotFoundError({ session: id })
      return yield* mailbox.subscribe()
    })

    const hasPendingMailboxItems = Effect.fn("AgentControl.hasPendingMailboxItems")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const mailbox = data.mailboxes.get(id)
      if (!mailbox) return false
      return yield* mailbox.hasPending()
    })

    const drainMailbox = Effect.fn("AgentControl.drainMailbox")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const mailbox = data.mailboxes.get(id)
      if (!mailbox) return [] as readonly InterAgentCommunication[]
      return yield* mailbox.drain()
    })

    return Service.of({
      registerRunLoop,
      onSpawnEvent,
      registerSessionRoot,
      spawnAgent,
      sendInterAgentCommunication,
      closeAgent,
      listAgents,
      resolveAgentReference,
      getAgentMetadata,
      subscribeStatus,
      subscribeMailboxSeq,
      hasPendingMailboxItems,
      drainMailbox,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Session.defaultLayer))

// Mirrors codex `agent_matches_prefix` (control.rs:1217-1229). Returns true
// when the agent's path is exactly the prefix or sits underneath it as a
// strict descendant. Root prefix matches everything.
const agentMatchesPrefix = (agentPath: AgentPath | undefined, prefix: AgentPath): boolean => {
  if (AgentPath.isRoot(prefix)) return true
  if (!agentPath) return false
  const a = agentPath as string
  const p = prefix as string
  if (a === p) return true
  return a.startsWith(p + "/")
}

export * as AgentControl from "./control"
