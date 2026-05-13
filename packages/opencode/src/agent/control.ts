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

// Wave 10 — bus events. Two-channel emission per lifecycle moment:
//   - EventV2.run(SessionEvent.Agent.*) — sourced log under
//     "session.next.agent.*". Persisted to the event log; auto-published on
//     the project bus by the sync runtime.
//   - Bus.publish(Event.*) — in-process pub/sub under "agent.*". TUI / plugin
//     consumers subscribe here. Type-safe payload shapes documented below.
//
// Two type prefixes ("session.next.agent.*" vs "agent.*") avoid collision
// with the auto-registration that SyncEvent.init performs on EventV2 defs
// (sync/index.ts:210). Both definitions stay live in the BusEvent registry
// and surface in the SDK.
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
// auto-registered types from `SessionEvent.Step.*` so we can subscribe
// directly via Bus.subscribe with a precise payload type. The `type` strings
// match what SyncEvent.init registers on the bus (sync/index.ts:210). We
// don't call BusEvent.define here (the auto-registration already did) so we
// don't collide; we just construct the Definition shape locally.
//
// These are public so tests can publish onto the same PubSub the
// AgentControl subscriber listens to without going through EventV2.run
// (which uses a separate, shared runtime that test layers don't share —
// see GOTCHAS.md `bus-subscribe-helper-vs-service-method-cross-runtime-mismatch`).
export const Inbound = {
  StepStarted: {
    type: SessionEvent.Step.Started.Sync.type,
    properties: SessionEvent.Step.Started.Sync.properties,
  } as const,
  StepEnded: {
    type: SessionEvent.Step.Ended.Sync.type,
    properties: SessionEvent.Step.Ended.Sync.properties,
  } as const,
}

const newCallID = () => Identifier.create("call", "ascending")

// Stable model-facing error tag derived from a SpawnError class. Surfaces
// on Agent.Spawn.Ended bus events as `error: <tag>` so subscribers branch
// without parsing prose. Exported for direct unit testing of the
// classification — the `no_nickname` arm is structurally defensive (the
// registry's nickname pool recycles via reset suffixes, so spawn never
// surfaces NoNicknameAvailableError under current configuration), and
// only direct invocation can exercise it.
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
  readonly hasPendingTriggerTurn: (id: SessionID) => Effect.Effect<boolean>
  readonly drainMailbox: (id: SessionID) => Effect.Effect<readonly InterAgentCommunication[]>
  // Wave 9: cascade cancel — interrupt every live agent whose canonical path
  // sits beneath `parentID`'s subtree. Used by SessionPrompt.cancel to bring
  // down v2-spawned children when the user aborts the parent session.
  // Idempotent: closing an agent whose mailbox or fiber is already gone is a
  // no-op, mirroring `closeAgent`.
  readonly cancelChildrenOf: (parentID: SessionID) => Effect.Effect<void>
  // Wave 10: emit a paired Wait.Started/Wait.Ended around an outer wait
  // operation. The wait_agent tool calls this so the bus events are produced
  // by the AgentControl service (centralized lifecycle bookkeeping) rather
  // than by every consumer that wants to time a wait.
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
//
// `providerRef` lives at LAYER scope (not InstanceState), because
// SessionPrompt's layer init registers the run-loop provider once at layer
// build time when no Instance is yet bound. The function itself is
// instance-agnostic (it returns an Effect that resolves InstanceState.context
// internally at execution time), so sharing one provider across every
// instance the layer serves is safe and matches how SessionPrompt's `loop`
// closure already behaves.
interface InternalState {
  readonly registry: AgentRegistry.Interface
  readonly mailboxes: Map<SessionID, Mailbox.Interface>
  readonly statuses: Map<SessionID, SubscriptionRef.SubscriptionRef<AgentStatus>>
  readonly fibers: Map<SessionID, Fiber.Fiber<unknown, unknown>>
  readonly rootRef: Ref.Ref<SessionID | undefined>
  readonly scope: Scope.Scope
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const providerRef = yield* Ref.make<
      ((sessionID: SessionID) => Effect.Effect<unknown>) | undefined
    >(undefined)

    const state = yield* InstanceState.make(
      Effect.fn("AgentControl.state")(function* () {
        const scope = yield* Scope.Scope
        const ctx = yield* InstanceState.context
        const registry = yield* AgentRegistry.make()
        const mailboxes = new Map<SessionID, Mailbox.Interface>()
        const statuses = new Map<SessionID, SubscriptionRef.SubscriptionRef<AgentStatus>>()
        const fibers = new Map<SessionID, Fiber.Fiber<unknown, unknown>>()
        const rootRef = yield* Ref.make<SessionID | undefined>(undefined)

        // Wave 10 status derivation. Forking the bus subscriber INSIDE
        // InstanceState.make binds it to the per-instance scope (so the
        // fiber dies on instance disposal). The captured InstanceContext is
        // re-injected via `Effect.provideService(InstanceRef, ctx)` so any
        // sub-effect that reads InstanceState (Bus.subscribe internally
        // reads its own InstanceState) sees the right Instance binding —
        // ALS context isn't reliably preserved across Effect.forkScoped on
        // every scheduler implementation.
        //
        // Status mapping mirrors codex `agent_status_from_event`
        // (codex-rs/core/src/agent/status.rs:6-21): turn_started → running,
        // turn_complete → completed. Final statuses (shutdown / completed /
        // errored) are sticky — a late Step.* must not flip a closed agent
        // back to running.
        const applyToStatus = (sessionID: SessionID, next: AgentStatus | null) =>
          Effect.gen(function* () {
            if (next === null) return
            const ref = statuses.get(sessionID)
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
          }),
        )

        return {
          registry,
          mailboxes,
          statuses,
          fibers,
          rootRef,
          scope,
        } satisfies InternalState
      }),
    )

    const registerRunLoop = Effect.fn("AgentControl.registerRunLoop")(function* (
      fn: (sessionID: SessionID) => Effect.Effect<unknown>,
    ) {
      yield* Ref.set(providerRef, fn)
    })

    const registerSessionRoot = Effect.fn("AgentControl.registerSessionRoot")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      yield* data.registry.registerRootThread(id)
      yield* Ref.set(data.rootRef, id)
      // Initialize a status for the root so `subscribeStatus(rootID)` works
      // and `listAgents` can report a status for root.
      if (!data.statuses.has(id)) {
        const status = yield* SubscriptionRef.make<AgentStatus>("running")
        data.statuses.set(id, status)
      }
    })

    const spawnAgent = Effect.fn("AgentControl.spawnAgent")(function* (input: SpawnAgentInput) {
      const data = yield* InstanceState.get(state)
      const callID = newCallID()
      // 1. Compute child path. Failure here is AgentPathInvalidError from
      //    AgentPath.join (the leaf failed segment validation).
      const childPath = yield* AgentPath.join(input.parentPath, input.task_name).pipe(
        Effect.tapError((cause) =>
          // Failed before we could even fire Spawn.Started. Emit a single
          // Spawn.Ended carrying the rejection so subscribers see a paired
          // lifecycle even on path-validation failure.
          emitSpawnEnded({
            sessionID: input.parentID,
            call_id: callID,
            task_name: input.task_name,
            // Best-effort path: the parent + task_name as a string. The
            // AgentPath schema would reject it, so we synthesize a literal
            // and brand it. Subscribers care about the task_name + error
            // tag here; the path is informational.
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

      // 2. Depth check before reserving anything — cheap to fail fast.
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

            // Spawn.Started fires AFTER child session creation (so we have
            // a real conversation_id available for downstream subscribers
            // that want to subscribe to that session) but BEFORE forking
            // the run loop (mirrors codex spawn.rs:68-81).
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

            const provider = yield* Ref.get(providerRef)
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
                // Pluck the first typed failure out of the cause to tag it.
                // Effect v4 exposes this via `Cause.findErrorOption`.
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

    // Internal helper for the dual EventV2 + Bus emission. Both fire under
    // separate type prefixes so subscribers can choose either channel
    // (sourced log vs ephemeral pub/sub).
    function emitSpawn<P extends Record<string, unknown>>(input: {
      event:
        | typeof Event.SpawnStarted
        | typeof Event.SpawnEnded
      sync: typeof SessionEvent.Agent.Spawn.Started.Sync | typeof SessionEvent.Agent.Spawn.Ended.Sync
      data: P
    }): Effect.Effect<void> {
      return Effect.gen(function* () {
        // EventV2 sourced log. Best-effort: if the SyncEvent runtime isn't
        // available (test env without preload, or flag off) the call is a
        // no-op. We don't want logging failures to break the spawn flow.
        try {
          EventV2.run(input.sync, input.data as never)
        } catch {
          // intentional swallow — projection failure shouldn't kill spawn.
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
      function* (targetID: SessionID, comm: InterAgentCommunication) {
        const data = yield* InstanceState.get(state)
        const mailbox = data.mailboxes.get(targetID)
        if (!mailbox) {
          yield* new AgentNotFoundError({ session: targetID })
          return
        }
        yield* mailbox.send(comm)
        yield* data.registry.updateLastTaskMessage(targetID, comm.content)
        // Wave 10: surface the inter-agent communication on the bus so the
        // TUI / plugins can render in-flight traffic. Aggregate is the
        // sender (sessionID = author session); receiver fields carry the
        // target IDs.
        const senderID = (yield* lookupSessionForPath(data, comm.author)) ?? targetID
        const eventData = {
          sessionID: senderID,
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

    // Resolve a SessionID for a canonical AgentPath, including root. Returns
    // undefined when the path is not registered (e.g. the sender is a path
    // not currently held in the registry — rare but legal during cascade).
    const lookupSessionForPath = (data: InternalState, path: AgentPath) =>
      Effect.gen(function* () {
        if (AgentPath.isRoot(path)) return yield* Ref.get(data.rootRef)
        return yield* data.registry.agentIdForPath(path)
      })

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

        // Wave 10: emit Agent.Closed on both channels. Aggregate sessionID
        // is the closed agent itself so the projection lands in the closed
        // agent's history.
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

    const hasPendingTriggerTurn = Effect.fn("AgentControl.hasPendingTriggerTurn")(function* (
      id: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const mailbox = data.mailboxes.get(id)
      if (!mailbox) return false
      return yield* mailbox.hasPendingTriggerTurn()
    })

    const drainMailbox = Effect.fn("AgentControl.drainMailbox")(function* (id: SessionID) {
      const data = yield* InstanceState.get(state)
      const mailbox = data.mailboxes.get(id)
      if (!mailbox) return [] as readonly InterAgentCommunication[]
      return yield* mailbox.drain()
    })

    const cancelChildrenOf = Effect.fn("AgentControl.cancelChildrenOf")(function* (
      parentID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      // Determine the parent's canonical path. Three cases:
      //  - parent is a registered agent → its metadata's agent_path
      //  - parent is the registered root → AgentPath.root()
      //  - parent is neither (a regular session that never spawned children)
      //    → no descendants to cancel; bail.
      const meta = yield* data.registry.agentMetadataForThread(parentID)
      const rootID = yield* Ref.get(data.rootRef)
      const parentPath: AgentPath | undefined =
        meta?.agent_path ?? (parentID === rootID ? AgentPath.root() : undefined)
      if (!parentPath) return

      const prefix =
        (parentPath as string) === "/root" ? "/root/" : (parentPath as string) + "/"

      const live = yield* data.registry.liveAgents()
      // Iterate descendants leaves-first so each shutdownOne sees its own
      // metadata before its parent's closeAgent cascade rips it out from
      // under it. Sort by path-depth descending — deeper paths first.
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
        // closeAgent itself cascades, but a leaves-first iteration plus the
        // idempotent shortcut at the top of closeAgent (returns shutdown when
        // the registry slot is already released) keeps each invocation cheap.
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

// AgentControl.defaultLayer self-provides its deps so that consumers of
// `defaultLayer` (production AppRuntime, every existing test layer that
// uses ToolRegistry.defaultLayer) don't need to be updated when this
// service grows new requirements. Bus.layer is included so the in-effect
// bus subscriber wires up against the same Bus.Service that consumers see
// when they `yield* Bus.Service` against a test runtime that includes
// Bus.defaultLayer (mergeAll dedupes by service tag — outer Bus wins).
export const defaultLayer = layer.pipe(
  Layer.provide(Session.defaultLayer),
  Layer.provide(Bus.defaultLayer),
)

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
