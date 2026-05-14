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
  Stream,
  SubscriptionRef,
} from "effect"
import { Identifier } from "@/id/id"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { NonNegativeInt } from "@/util/schema"
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
// subsystem ported to opencode. It owns one PerRootData slot per registered
// root session: each root has its OWN AgentRegistry, mailboxes, statuses,
// and run-loop fibers. Wave 1 generalised the per-INSTANCE state of Wave 7
// to per-ROOT state so two chats opened against the same project no longer
// share a registry / mailbox map.
//
// Codex source: codex-rs/core/src/agent/control.rs lines 130-136 (per-root
// invariant). Codex creates one registry per root tree; sharing one across
// roots was the Wave 0 bug.

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

// Wave 10 — bus events. Two-channel emission per lifecycle moment:
//   - EventV2.run(SessionEvent.Agent.*) — sourced log under
//     "session.next.agent.*". Persisted to the event log; auto-published on
//     the project bus by the sync runtime.
//   - Bus.publish(Event.*) — in-process pub/sub under "agent.*". TUI / plugin
//     consumers subscribe here.
export const Event = {
  SpawnStarted: BusEvent.define(
    "agent.spawn.started",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      call_id: Schema.String,
      task_name: Schema.String,
      child_path: AgentPath,
      agent_type: Schema.String.pipe(Schema.optional),
      prompt: Schema.String,
    }),
  ),
  SpawnEnded: BusEvent.define(
    "agent.spawn.ended",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      call_id: Schema.String,
      task_name: Schema.String,
      child_path: AgentPath,
      agent_type: Schema.String.pipe(Schema.optional),
      child_session_id: SessionID.pipe(Schema.optional),
      child_nickname: Schema.String.pipe(Schema.optional),
      status: AgentStatus,
      error: Schema.String.pipe(Schema.optional),
    }),
  ),
  Closed: BusEvent.define(
    "agent.closed",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      agent_path: AgentPath,
      previous_status: AgentStatus,
    }),
  ),
  WaitStarted: BusEvent.define(
    "agent.wait.started",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      call_id: Schema.String,
      timeout_ms: NonNegativeInt,
    }),
  ),
  WaitEnded: BusEvent.define(
    "agent.wait.ended",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      call_id: Schema.String,
      timed_out: Schema.Boolean,
    }),
  ),
  MessageSent: BusEvent.define(
    "agent.message.sent",
    Schema.Struct({
      sessionID: SessionID,
      timestamp: NonNegativeInt,
      sender_path: AgentPath,
      target_session_id: SessionID,
      target_path: AgentPath,
      message_length: NonNegativeInt,
      trigger_turn: Schema.Boolean,
    }),
  ),
}

// Inbound subscription adapters — BusEvent.Definition shapes that match the
// auto-registered types from `SessionEvent.Step.*` and `Session.Event.*` so
// we can subscribe via Bus.subscribe with a precise payload type.
//
// SessionEvent.* uses EventV2.define (has `.Sync.type` / `.Sync.properties`).
// Session.Event.* uses SyncEvent.define directly (has `.type` / `.properties`
// with no `.Sync` indirection). The two shapes look identical at the
// Inbound layer — the Definition object only needs `type` + `properties`.
export const Inbound = {
  StepStarted: {
    type: SessionEvent.Step.Started.Sync.type,
    properties: SessionEvent.Step.Started.Sync.properties,
  } as const,
  StepEnded: {
    type: SessionEvent.Step.Ended.Sync.type,
    properties: SessionEvent.Step.Ended.Sync.properties,
  } as const,
  SessionDeleted: {
    type: Session.Event.Deleted.type,
    properties: Session.Event.Deleted.properties,
  } as const,
}

const newCallID = () => Identifier.create("call", "ascending")

export const spawnErrorTag = (cause: unknown): string => {
  if (cause instanceof AgentDepthExceededError) return "depth_exceeded"
  if (cause instanceof AgentLimitReachedError) return "limit_reached"
  if (cause instanceof AgentPathInvalidError) return "path_invalid"
  if (cause instanceof PathAlreadyExistsError) return "path_exists"
  if (cause instanceof NoNicknameAvailableError) return "no_nickname"
  return "unknown"
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
}

export interface SpawnAgentInput {
  readonly parentID: SessionID
  readonly parentPath: AgentPath
  readonly task_name: string
  readonly agent_type?: string
  readonly initial_message: string
  readonly options?: SpawnAgentOptions
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
  readonly registerSessionRoot: (id: SessionID) => Effect.Effect<void>
  readonly spawnAgent: (input: SpawnAgentInput) => Effect.Effect<LiveAgent, SpawnError>
  readonly sendInterAgentCommunication: (
    targetID: SessionID,
    comm: InterAgentCommunication,
    senderID: SessionID,
  ) => Effect.Effect<void, AgentNotFoundError>
  readonly closeAgent: (
    id: SessionID,
  ) => Effect.Effect<{ readonly previous_status: AgentStatus }, AgentNotFoundError>
  readonly listAgents: (
    currentPath: AgentPath,
    senderID: SessionID,
    pathPrefix?: string,
  ) => Effect.Effect<readonly ListedAgent[], AgentPathInvalidError>
  readonly resolveAgentReference: (
    currentPath: AgentPath,
    reference: string,
    senderID: SessionID,
  ) => Effect.Effect<SessionID, AgentReferenceInvalidError>
  readonly getAgentMetadata: (id: SessionID) => Effect.Effect<AgentMetadata | undefined>
  readonly subscribeStatus: (
    id: SessionID,
  ) => Effect.Effect<SubscriptionRef.SubscriptionRef<AgentStatus>, AgentNotFoundError>
  readonly subscribeMailboxSeq: (
    id: SessionID,
  ) => Effect.Effect<SubscriptionRef.SubscriptionRef<number>, AgentNotFoundError>
  readonly hasPendingMailboxItems: (id: SessionID) => Effect.Effect<boolean>
  readonly hasPendingTriggerTurn: (id: SessionID) => Effect.Effect<boolean>
  readonly drainMailbox: (id: SessionID) => Effect.Effect<readonly InterAgentCommunication[]>
  readonly cancelChildrenOf: (parentID: SessionID) => Effect.Effect<void>
  readonly emitWaitStarted: (
    sessionID: SessionID,
    callID: string,
    timeoutMs: number,
  ) => Effect.Effect<void>
  readonly emitWaitEnded: (
    sessionID: SessionID,
    callID: string,
    timedOut: boolean,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentControl") {}

const pathDepth = (p: AgentPath): number => {
  const s = p as string
  if (s === "/root") return 0
  return s.split("/").length - 2
}

// Per-root data — one slot per registered root session. Each root gets its
// own registry, mailboxes, statuses, fibers map. Multi-level subagent trees
// (root spawns A, A spawns B, ...) all live in the SAME root's slot; the
// `sessionToRoot` index in InternalState resolves any session id to its root.
interface PerRootData {
  readonly rootID: SessionID
  readonly registry: AgentRegistry.Interface
  readonly mailboxes: Map<SessionID, Mailbox.Interface>
  readonly statuses: Map<SessionID, SubscriptionRef.SubscriptionRef<AgentStatus>>
  readonly fibers: Map<SessionID, Fiber.Fiber<unknown, unknown>>
}

interface InternalState {
  readonly perRoot: Map<SessionID, PerRootData>
  // Index from any session (root or subagent) back to its root id.
  // Populated on registerSessionRoot and on each spawnAgent (child id → root id).
  readonly sessionToRoot: Map<SessionID, SessionID>
  readonly scope: Scope.Scope
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    // providerRef MUST live at LAYER scope (NOT InstanceState) — see GOTCHA
    // `agentcontrol-providerref-must-live-in-layer-not-instancestate`. The
    // closure is instance-agnostic; SessionPrompt's layer init registers it
    // before any Instance is bound.
    const providerRef = yield* Ref.make<
      ((sessionID: SessionID) => Effect.Effect<unknown>) | undefined
    >(undefined)

    const state = yield* InstanceState.make(
      Effect.fn("AgentControl.state")(function* () {
        const scope = yield* Scope.Scope
        const ctx = yield* InstanceState.context
        const perRoot = new Map<SessionID, PerRootData>()
        const sessionToRoot = new Map<SessionID, SessionID>()

        // Status mapping mirrors codex `agent_status_from_event`. Status
        // resolution walks every per-root slot — Step.* arrives keyed only
        // on the agent's session id, so we look up its root, then its slot.
        const applyToStatus = (sessionID: SessionID, next: AgentStatus | null) =>
          Effect.gen(function* () {
            if (next === null) return
            const rootID = sessionToRoot.get(sessionID)
            if (!rootID) return
            const data = perRoot.get(rootID)
            if (!data) return
            const ref = data.statuses.get(sessionID)
            if (!ref) return
            const current = yield* SubscriptionRef.get(ref)
            if (AgentStatus.isFinal(current) && current !== "interrupted") return
            yield* SubscriptionRef.set(ref, next)
          })

        yield* Effect.forkScoped(
          bus
            .subscribe(Inbound.StepStarted)
            .pipe(
              Stream.runForEach((evt) =>
                applyToStatus(
                  evt.properties.sessionID,
                  AgentStatus.fromSessionEvent({ type: "turn_started" }),
                ),
              ),
            )
            .pipe(Effect.provideService(InstanceRef, ctx)),
        )
        yield* Effect.forkScoped(
          bus
            .subscribe(Inbound.StepEnded)
            .pipe(
              Stream.runForEach((evt) =>
                applyToStatus(
                  evt.properties.sessionID,
                  AgentStatus.fromSessionEvent({ type: "turn_complete" }),
                ),
              ),
            )
            .pipe(Effect.provideService(InstanceRef, ctx)),
        )

        // Wave 1 — per-root teardown subscriber. When a root session is
        // deleted (Session.Service.remove), interrupt every fiber in that
        // root's slot, drop its maps, and remove sessionToRoot entries
        // pointing at this root. RootB and other roots are unaffected.
        //
        // Subscribe via the top-level `Bus.subscribe` helper so the
        // subscription lands on the SAME memoMap'd Bus.Service that
        // `ProjectBus.publish` uses (sync.run → ProjectBus.publish for
        // Session.Event.Deleted). The in-effect `bus.subscribe(...)` in the
        // existing Step.Started/Ended subscribers above only sees events
        // published via the layer-local Bus.Service — fine for those
        // because production processor.ts publishes through the same
        // local-bus path. SyncEvent's path is different: it goes through
        // the cross-runtime helper, which only the top-level subscribe
        // helper can read.
        const offSessionDeleted = Bus.subscribe(Inbound.SessionDeleted, (evt) => {
          const deletedID = evt.properties.sessionID as SessionID
          const slot = perRoot.get(deletedID)
          if (!slot) return
          // Interrupt fibers via runPromise — fire-and-forget. We don't
          // have an Effect runtime to await here; the map mutations below
          // are synchronous regardless.
          for (const fiber of slot.fibers.values()) {
            void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {})
          }
          slot.fibers.clear()
          slot.mailboxes.clear()
          slot.statuses.clear()
          perRoot.delete(deletedID)
          for (const [sid, rid] of sessionToRoot.entries()) {
            if (rid === deletedID) sessionToRoot.delete(sid)
          }
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => offSessionDeleted()))

        // Belt-and-braces finalizer on instance disposal — interrupts every
        // live fiber across every root. The forkIn(parentScope) below wires
        // children into this scope, so the per-root sessionDeleted path and
        // this finalizer compose cleanly.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const data of perRoot.values()) {
              yield* Effect.forEach(data.fibers.values(), (fiber) => Fiber.interrupt(fiber), {
                concurrency: "unbounded",
                discard: true,
              })
              data.fibers.clear()
              data.mailboxes.clear()
              data.statuses.clear()
            }
            perRoot.clear()
            sessionToRoot.clear()
          }),
        )

        return {
          perRoot,
          sessionToRoot,
          scope,
        } satisfies InternalState
      }),
    )

    // Helper — get or create the per-root slot for `id`. Idempotent:
    // returns the existing slot if already registered.
    //
    // Wave 2: the root also gets its OWN Mailbox so wait_agent invoked from
    // root can wake on completion-watcher notifications. Pre-Wave 2 the root
    // had no mailbox and wait_agent fell back to a plain timeout sleep —
    // that's exactly the path Bug 2 left in place forever.
    const ensureRootSlot = (data: InternalState, id: SessionID) =>
      Effect.gen(function* () {
        const existing = data.perRoot.get(id)
        if (existing) return existing
        const registry = yield* AgentRegistry.make()
        yield* registry.registerRootThread(id)
        const status = yield* SubscriptionRef.make<AgentStatus>("running")
        const mailbox = yield* Mailbox.make()
        const slot: PerRootData = {
          rootID: id,
          registry,
          mailboxes: new Map([[id, mailbox]]),
          statuses: new Map([[id, status]]),
          fibers: new Map(),
        }
        data.perRoot.set(id, slot)
        data.sessionToRoot.set(id, id)
        return slot
      })

    // Resolve a session id → its per-root slot. Returns undefined when the
    // session has never been registered (or its root was torn down).
    const slotFor = (data: InternalState, id: SessionID): PerRootData | undefined => {
      const rootID = data.sessionToRoot.get(id)
      if (!rootID) return undefined
      return data.perRoot.get(rootID)
    }

    const registerRunLoop = Effect.fn("AgentControl.registerRunLoop")(function* (
      fn: (sessionID: SessionID) => Effect.Effect<unknown>,
    ) {
      yield* Ref.set(providerRef, fn)
    })

    const registerSessionRoot = Effect.fn("AgentControl.registerSessionRoot")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      yield* ensureRootSlot(data, id)
    })

    const spawnAgent = Effect.fn("AgentControl.spawnAgent")(function* (input: SpawnAgentInput) {
      const data = yield* InstanceState.get(state)
      const callID = newCallID()
      // 1. Compute child path. Failure here is AgentPathInvalidError from
      //    AgentPath.join (the leaf failed segment validation).
      const childPath = yield* AgentPath.join(input.parentPath, input.task_name).pipe(
        Effect.tapError((cause) =>
          emitSpawnEnded({
            sessionID: input.parentID,
            call_id: callID,
            task_name: input.task_name,
            child_path: AgentPath.from(
              `${input.parentPath as string}/${input.task_name}`,
            ).pipe(
              Effect.catch(() => Effect.succeed(AgentPath.root())),
            ),
            agent_type: input.agent_type,
            status: "not_found",
            error: spawnErrorTag(cause),
          }),
        ),
      )

      // 2. Depth check before reserving anything.
      const depth = pathDepth(childPath)
      if (exceedsThreadSpawnDepthLimit(depth, AGENT_MAX_DEPTH)) {
        yield* emitSpawnEnded({
          sessionID: input.parentID,
          call_id: callID,
          task_name: input.task_name,
          child_path: Effect.succeed(childPath),
          agent_type: input.agent_type,
          status: "not_found",
          error: "depth_exceeded",
        })
        return yield* new AgentDepthExceededError({ depth, max: AGENT_MAX_DEPTH })
      }

      // 3. Resolve the parent's root slot. If the parent isn't registered
      //    AND the parent path is /root, lazy-register it (idempotent).
      //    Subagent → sub-subagent spawns rely on the sessionToRoot index
      //    populated when the parent was originally spawned.
      let parentRoot = slotFor(data, input.parentID)
      if (!parentRoot && AgentPath.isRoot(input.parentPath)) {
        parentRoot = yield* ensureRootSlot(data, input.parentID)
      }
      if (!parentRoot) {
        // Parent unknown and not root — this is a programming error; the
        // caller must register the root first or pass a known parent id.
        // Fail with the same error shape as cross-root rejection.
        return yield* new AgentDepthExceededError({ depth, max: AGENT_MAX_DEPTH })
      }
      const slot = parentRoot

      const cap = input.max_threads ?? AGENT_MAX_THREADS

      // 4. Use acquireUseRelease so the slot is freed on any failure exit.
      return yield* Effect.acquireUseRelease(
        slot.registry.reserveSpawnSlot(cap),
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
              permission: parent.permission,
            })

            yield* emitSpawn({
              event: Event.SpawnStarted,
              sync: SessionEvent.Agent.Spawn.Started.Sync,
              data: {
                sessionID: input.parentID,
                timestamp: Date.now(),
                call_id: callID,
                task_name: input.task_name,
                child_path: childPath,
                agent_type: input.agent_type,
                prompt: input.initial_message,
              },
            })

            const mailbox = yield* Mailbox.make()
            const status = yield* SubscriptionRef.make<AgentStatus>("pending_init")

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

            slot.mailboxes.set(child.id, mailbox)
            slot.statuses.set(child.id, status)
            // Index the child back to its root so future operations
            // (sendInterAgentCommunication, closeAgent, wait_agent) on
            // the child resolve to the right slot.
            data.sessionToRoot.set(child.id, slot.rootID)

            const provider = yield* Ref.get(providerRef)
            const loopEffect: Effect.Effect<unknown> = provider ? provider(child.id) : Effect.never

            const fiber = yield* loopEffect.pipe(
              Effect.onExit((exit: Exit.Exit<unknown, unknown>) =>
                Effect.gen(function* () {
                  slot.fibers.delete(child.id)
                  if (Exit.isSuccess(exit)) {
                    yield* SubscriptionRef.set(status, { completed: null })
                    return
                  }
                  if (Cause.hasInterrupts(exit.cause)) {
                    return
                  }
                  yield* SubscriptionRef.set(status, {
                    errored: Cause.pretty(exit.cause),
                  })
                }),
              ),
              Effect.forkIn(data.scope),
            )
            slot.fibers.set(child.id, fiber)

            // Sibling completion watcher. Mirrors codex
            // maybe_start_completion_watcher (codex-rs/core/src/agent/control.rs:943-1015):
            // when this child reaches a final status, send a notification to
            // the parent's mailbox so wait_agent's seq watch wakes. Forked
            // into data.scope so the watcher dies with the per-root slot
            // (and never outlives the parent root).
            //
            // Skip on shutdown: closeAgent is the only path that sets status
            // to "shutdown"; the parent invoked the close itself, so a
            // notification here would be confusing. See MESSAGE_SHAPES.md
            // § "Skip rule: closeAgent-triggered shutdown".
            yield* Stream.runForEach(
              SubscriptionRef.changes(status).pipe(Stream.drop(1)),
              (next) =>
                Effect.gen(function* () {
                  if (!AgentStatus.isFinal(next)) return
                  if (next === "shutdown") return yield* Effect.interrupt
                  const label =
                    typeof next === "object" && "completed" in next
                      ? "completed"
                      : "errored"
                  // The watcher's send may race with parent deletion. If the
                  // parent root is gone, sendInterAgentCommunication fails
                  // with AgentNotFoundError — absorb it; nothing to wake.
                  yield* sendInterAgentCommunication(
                    input.parentID,
                    new InterAgentCommunication({
                      author: childPath,
                      recipient: input.parentPath,
                      content: `Agent ${String(childPath)} reached status: ${label}`,
                      trigger_turn: false,
                      sent_at: Date.now(),
                    }),
                    child.id,
                  ).pipe(Effect.catch(() => Effect.void))
                  yield* Effect.interrupt
                }),
            ).pipe(Effect.forkIn(data.scope))

            const current = yield* SubscriptionRef.get(status)
            if (current === "pending_init") {
              yield* SubscriptionRef.set(status, "running")
            }
            const finalStatus = yield* SubscriptionRef.get(status)

            yield* emitSpawn({
              event: Event.SpawnEnded,
              sync: SessionEvent.Agent.Spawn.Ended.Sync,
              data: {
                sessionID: input.parentID,
                timestamp: Date.now(),
                call_id: callID,
                task_name: input.task_name,
                child_path: childPath,
                agent_type: input.agent_type,
                child_session_id: child.id,
                child_nickname: nickname,
                status: finalStatus,
              },
            })

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
                const errOpt = Cause.findErrorOption(exit.cause)
                yield* emitSpawnEnded({
                  sessionID: input.parentID,
                  call_id: callID,
                  task_name: input.task_name,
                  child_path: Effect.succeed(childPath),
                  agent_type: input.agent_type,
                  status: "not_found",
                  error: spawnErrorTag(errOpt._tag === "Some" ? errOpt.value : exit.cause),
                })
              })
            : Effect.void,
      )
    })

    function emitSpawn<P extends Record<string, unknown>>(input: {
      event:
        | typeof Event.SpawnStarted
        | typeof Event.SpawnEnded
      sync: typeof SessionEvent.Agent.Spawn.Started.Sync | typeof SessionEvent.Agent.Spawn.Ended.Sync
      data: P
    }): Effect.Effect<void> {
      return Effect.gen(function* () {
        try {
          EventV2.run(input.sync, input.data as never)
        } catch {
          // intentional swallow.
        }
        yield* bus.publish(input.event, input.data as never).pipe(Effect.ignore)
      })
    }

    function emitSpawnEnded(input: {
      sessionID: SessionID
      call_id: string
      task_name: string
      child_path: Effect.Effect<AgentPath, never>
      agent_type?: string
      status: AgentStatus
      error?: string
    }): Effect.Effect<void> {
      return Effect.gen(function* () {
        const childPath = yield* input.child_path
        const data = {
          sessionID: input.sessionID,
          timestamp: Date.now(),
          call_id: input.call_id,
          task_name: input.task_name,
          child_path: childPath,
          agent_type: input.agent_type,
          status: input.status,
          error: input.error,
        }
        try {
          EventV2.run(SessionEvent.Agent.Spawn.Ended.Sync, data as never)
        } catch {
          // intentional swallow.
        }
        yield* bus.publish(Event.SpawnEnded, data).pipe(Effect.ignore)
      })
    }

    const sendInterAgentCommunication = Effect.fn("AgentControl.sendInterAgentCommunication")(
      function* (targetID: SessionID, comm: InterAgentCommunication, senderID: SessionID) {
        const data = yield* InstanceState.get(state)
        // Cross-root rejection. Sender and target must belong to the SAME
        // root's slot — otherwise the target either doesn't exist for this
        // sender (different chat / root) or has been torn down.
        const senderRoot = data.sessionToRoot.get(senderID)
        const targetRoot = data.sessionToRoot.get(targetID)
        if (!targetRoot || !senderRoot || senderRoot !== targetRoot) {
          yield* new AgentNotFoundError({ session: targetID })
          return
        }
        // Invariant: perRoot[rootID] and sessionToRoot[*]→rootID are kept
        // in lockstep — registerSessionRoot/spawnAgent set both atomically,
        // the deletion handler clears both. The non-null assertion documents
        // that invariant rather than carrying an unreachable defensive branch
        // (per STYLE.md: "Don't add validation for scenarios that can't happen").
        const slot = data.perRoot.get(targetRoot)!
        const mailbox = slot.mailboxes.get(targetID)
        if (!mailbox) {
          yield* new AgentNotFoundError({ session: targetID })
          return
        }
        yield* mailbox.send(comm)
        yield* slot.registry.updateLastTaskMessage(targetID, comm.content)
        // Surface the inter-agent communication on the bus.
        const sourceID = (yield* lookupSessionForPath(slot, comm.author)) ?? targetID
        const eventData = {
          sessionID: sourceID,
          timestamp: Date.now(),
          sender_path: comm.author,
          target_session_id: targetID,
          target_path: comm.recipient,
          message_length: comm.content.length,
          trigger_turn: comm.trigger_turn,
        }
        try {
          EventV2.run(SessionEvent.Agent.Message.Sent.Sync, eventData as never)
        } catch {
          // intentional swallow.
        }
        yield* bus.publish(Event.MessageSent, eventData).pipe(Effect.ignore)
      },
    )

    // Resolve a SessionID for a canonical AgentPath within a single root's
    // slot. Returns undefined when the path is not registered in this slot.
    const lookupSessionForPath = (slot: PerRootData, path: AgentPath) =>
      Effect.gen(function* () {
        if (AgentPath.isRoot(path)) return slot.rootID
        return yield* slot.registry.agentIdForPath(path)
      })

    const closeAgent = Effect.fn("AgentControl.closeAgent")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return yield* new AgentNotFoundError({ session: id })

      const meta = yield* slot.registry.agentMetadataForThread(id)
      const status = slot.statuses.get(id)
      // Idempotent: a previously-shutdown agent has been released from the
      // registry but its status SubscriptionRef is retained at "shutdown"
      // (shutdownOne sets status="shutdown" before releasing meta). The
      // sessionToRoot entry stays, so slotFor still finds the slot. Return
      // shutdown without error so a re-close is a no-op for the caller.
      // Invariant: when meta is undefined here, status exists at "shutdown"
      // (closeAgent is the only path that sets meta=undefined, and rejects
      // root before reaching this branch — every non-root close goes through
      // shutdownOne which writes status first). Per STYLE.md "don't validate
      // for scenarios that can't happen".
      if (!meta) return { previous_status: "shutdown" as const }
      // Reject root explicitly.
      if (meta.agent_path && AgentPath.isRoot(meta.agent_path)) {
        return yield* new AgentNotFoundError({ session: id })
      }

      const previousStatus: AgentStatus = status
        ? yield* SubscriptionRef.get(status)
        : "not_found"

      const targetPath = meta.agent_path
      const allLive = yield* slot.registry.liveAgents()
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
        if (desc.agent_id) yield* shutdownOne(slot, desc.agent_id, desc.agent_path)
      }
      yield* shutdownOne(slot, id, targetPath)

      return { previous_status: previousStatus }
    })

    const shutdownOne = (
      slot: PerRootData,
      sessionId: SessionID,
      agentPath: AgentPath | undefined,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const status = slot.statuses.get(sessionId)
        const previousStatus: AgentStatus = status
          ? yield* SubscriptionRef.get(status)
          : "not_found"
        if (status) yield* SubscriptionRef.set(status, "shutdown")

        const fiber = slot.fibers.get(sessionId)
        if (fiber) {
          yield* Fiber.interrupt(fiber)
          slot.fibers.delete(sessionId)
        }
        slot.mailboxes.delete(sessionId)
        yield* slot.registry.releaseSpawnedThread(sessionId)

        const eventData = {
          sessionID: sessionId,
          timestamp: Date.now(),
          agent_path: agentPath ?? AgentPath.root(),
          previous_status: previousStatus,
        }
        try {
          EventV2.run(SessionEvent.Agent.Closed.Sync, eventData as never)
        } catch {
          // intentional swallow.
        }
        yield* bus.publish(Event.Closed, eventData).pipe(Effect.ignore)
      })

    const listAgents = Effect.fn("AgentControl.listAgents")(function* (
      currentPath: AgentPath,
      senderID: SessionID,
      pathPrefix?: string,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, senderID)
      if (!slot) return [] as readonly ListedAgent[]

      const resolvedPrefix = pathPrefix
        ? yield* AgentPath.resolve(currentPath, pathPrefix)
        : undefined

      const out: ListedAgent[] = []

      // Root entry — included only when the prefix matches root.
      if (!resolvedPrefix || agentMatchesPrefix(AgentPath.root(), resolvedPrefix)) {
        const rootStatus = slot.statuses.get(slot.rootID)
        out.push({
          agent_name: String(AgentPath.root()),
          agent_status: rootStatus ? yield* SubscriptionRef.get(rootStatus) : "running",
          last_task_message: ROOT_LAST_TASK_MESSAGE,
        })
      }

      const live = yield* slot.registry.liveAgents()
      const sorted = [...live].sort((a, b) =>
        String(a.agent_path ?? "").localeCompare(String(b.agent_path ?? "")),
      )

      for (const m of sorted) {
        if (!m.agent_id) continue
        if (resolvedPrefix && !agentMatchesPrefix(m.agent_path, resolvedPrefix)) continue
        const sub = slot.statuses.get(m.agent_id)
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
      senderID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const resolved = yield* AgentPath.resolve(currentPath, reference).pipe(
        Effect.mapError((e) => new AgentReferenceInvalidError({ reference, reason: e.reason })),
      )
      const slot = slotFor(data, senderID)
      if (!slot) {
        return yield* new AgentReferenceInvalidError({
          reference,
          reason: "root session has not been registered",
        })
      }
      // Root resolves via the slot's rootID.
      if (AgentPath.isRoot(resolved)) {
        return slot.rootID
      }
      const sid = yield* slot.registry.agentIdForPath(resolved)
      if (sid) return sid
      return yield* new AgentReferenceInvalidError({
        reference,
        reason: `live agent path '${resolved}' not found`,
      })
    })

    const getAgentMetadata = Effect.fn("AgentControl.getAgentMetadata")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return undefined
      return yield* slot.registry.agentMetadataForThread(id)
    })

    const subscribeStatus = Effect.fn("AgentControl.subscribeStatus")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return yield* new AgentNotFoundError({ session: id })
      const ref = slot.statuses.get(id)
      if (!ref) return yield* new AgentNotFoundError({ session: id })
      return ref
    })

    const subscribeMailboxSeq = Effect.fn("AgentControl.subscribeMailboxSeq")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return yield* new AgentNotFoundError({ session: id })
      const mailbox = slot.mailboxes.get(id)
      if (!mailbox) return yield* new AgentNotFoundError({ session: id })
      return yield* mailbox.subscribe()
    })

    const hasPendingMailboxItems = Effect.fn("AgentControl.hasPendingMailboxItems")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return false
      const mailbox = slot.mailboxes.get(id)
      if (!mailbox) return false
      return yield* mailbox.hasPending()
    })

    const hasPendingTriggerTurn = Effect.fn("AgentControl.hasPendingTriggerTurn")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return false
      const mailbox = slot.mailboxes.get(id)
      if (!mailbox) return false
      return yield* mailbox.hasPendingTriggerTurn()
    })

    const drainMailbox = Effect.fn("AgentControl.drainMailbox")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, id)
      if (!slot) return [] as readonly InterAgentCommunication[]
      const mailbox = slot.mailboxes.get(id)
      if (!mailbox) return [] as readonly InterAgentCommunication[]
      return yield* mailbox.drain()
    })

    const cancelChildrenOf = Effect.fn("AgentControl.cancelChildrenOf")(function* (
      parentID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, parentID)
      if (!slot) return
      const meta = yield* slot.registry.agentMetadataForThread(parentID)
      const parentPath: AgentPath | undefined =
        meta?.agent_path ?? (parentID === slot.rootID ? AgentPath.root() : undefined)
      if (!parentPath) return

      const prefix =
        (parentPath as string) === "/root" ? "/root/" : (parentPath as string) + "/"

      const live = yield* slot.registry.liveAgents()
      const descendants = live
        .filter(
          (m) =>
            m.agent_id !== undefined &&
            m.agent_id !== parentID &&
            m.agent_path !== undefined &&
            (m.agent_path as string).startsWith(prefix),
        )
        .sort((a, b) =>
          ((b.agent_path as string) ?? "").split("/").length -
          ((a.agent_path as string) ?? "").split("/").length,
        )

      for (const child of descendants) {
        if (!child.agent_id) continue
        yield* closeAgent(child.agent_id).pipe(Effect.catch(() => Effect.void))
      }
    })

    const emitWaitStarted = Effect.fn("AgentControl.emitWaitStarted")(function* (
      sessionID: SessionID,
      callID: string,
      timeoutMs: number,
    ) {
      const data = {
        sessionID,
        timestamp: Date.now(),
        call_id: callID,
        timeout_ms: timeoutMs,
      }
      try {
        EventV2.run(SessionEvent.Agent.Wait.Started.Sync, data as never)
      } catch {
        // intentional swallow.
      }
      yield* bus.publish(Event.WaitStarted, data).pipe(Effect.ignore)
    })

    const emitWaitEnded = Effect.fn("AgentControl.emitWaitEnded")(function* (
      sessionID: SessionID,
      callID: string,
      timedOut: boolean,
    ) {
      const data = {
        sessionID,
        timestamp: Date.now(),
        call_id: callID,
        timed_out: timedOut,
      }
      try {
        EventV2.run(SessionEvent.Agent.Wait.Ended.Sync, data as never)
      } catch {
        // intentional swallow.
      }
      yield* bus.publish(Event.WaitEnded, data).pipe(Effect.ignore)
    })

    return Service.of({
      registerRunLoop,
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
      hasPendingTriggerTurn,
      drainMailbox,
      cancelChildrenOf,
      emitWaitStarted,
      emitWaitEnded,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Session.defaultLayer),
  Layer.provide(Bus.defaultLayer),
)

const agentMatchesPrefix = (agentPath: AgentPath | undefined, prefix: AgentPath): boolean => {
  if (AgentPath.isRoot(prefix)) return true
  if (!agentPath) return false
  const a = agentPath as string
  const p = prefix as string
  if (a === p) return true
  return a.startsWith(p + "/")
}

export * as AgentControl from "./control"
