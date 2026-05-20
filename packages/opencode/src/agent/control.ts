import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
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
import { MailboxFullError } from "./mailbox"
import { Behaviors, BehaviorContract } from "./behaviors"
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

// D5 (actor-discipline-2026-05-20) — extract joined text from a message's
// parts. Filters out tool-call parts and thinking blocks; joins text parts
// with newline; trims. Shared by the extractor narrowing and the
// findMessage predicate so both apply the same "non-empty" rule.
const extractText = (parts: ReadonlyArray<unknown>): string =>
  parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim()

// D5 (actor-discipline-2026-05-20) — heuristic for "the child silently
// exited without delivering a meaningful result". Two cases trip the
// warning:
//   - Empty body: extractor walked every assistant message and found no
//     text. Common when the model emits thinking + tool-call only turns
//     and never produces text for the spawner.
//   - Status-line body: short (<200 chars), single-line, contains words
//     models reach for when wrapping up ("delivered", "complete", "done",
//     "closing"). Tuned to fire on the diagnostic-session-3 message
//     ("Report delivered to parent") while sparing legitimate short
//     deliverables that name files / values.
const STATUS_LINE_WORDS = /\b(delivered|complete|completed|done|no further|closing|closed)\b/i
const looksLikeMissingDeliverable = (body: string): boolean => {
  if (body.length === 0) return true
  if (body.length >= 200) return false
  if (body.includes("\n")) return false
  return STATUS_LINE_WORDS.test(body)
}

// D11 (actor-discipline-2026-05-20 Wave 4) — parse the ABORT set-phrase
// from the LAST non-empty line of the extracted body. Strict line anchor
// (^...$) on the last line avoids prose-vs-regex collisions per GOTCHA
// `word-boundary-regex-vs-prose-collisions`: an interior paragraph or
// quoted line mentioning `ABORT(...)` must NOT trigger a false positive.
// Matches lower_snake_case reasons (the regex enforces `[a-z_]+`); the
// runtime forwards unrecognized reasons verbatim — graceful degradation
// per WAVE.md Gotcha #2 (future iterations may add a strict whitelist).
// The match runs on the EXTRACTED body (joined text parts only — never
// tool-call payloads, per D5), so the parser never sees structured tool
// arguments. Sibling of `extractText` / `looksLikeMissingDeliverable`;
// the three independently inspect the same body string.
const parseAbortReason = (body: string): { reason: string; details: string } | undefined => {
  const trimmed = body.trimEnd()
  const idx = trimmed.lastIndexOf("\n")
  const lastLine = idx === -1 ? trimmed : trimmed.slice(idx + 1)
  const m = lastLine.match(/^ABORT\(([a-z_]+)\):\s*(.+?)\s*$/)
  return m ? { reason: m[1], details: m[2] } : undefined
}

// D5 (actor-discipline-2026-05-20) — render the parent-facing notification
// body. Three shapes:
//   - Warning case: structured ⚠️ block leading with the safety net, then
//     the extracted body (or "<no text emitted>"), then the status header.
//     The parent sees the warning FIRST so a grep / TUI scan catches the
//     missing-deliverable case immediately.
//   - Body case: header + blank line + body, matching the pre-D5 shape so
//     existing parsers / UIs render the same when the deliverable lands.
//   - Header-only case: bare status line (no body to inline).
const WARNING_LINE =
  "⚠️ Auto-extraction returned a short/likely-status message. Child did NOT call"
const buildNotificationBody = (
  header: string,
  body: string,
  needsWarning: boolean,
): string => {
  if (needsWarning) {
    return [
      WARNING_LINE,
      "send_message/followup_task to deliver. Last assistant text follows:",
      "",
      body.length > 0 ? body : "<no text emitted>",
      "",
      header,
    ].join("\n")
  }
  return body.length > 0 ? `${header}\n\n${body}` : header
}

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

// D12 (actor-discipline-2026-05-20 Wave 5) — supervision-strategy enums.
// `OnFailureStrategy` declares how the runtime reacts when a spawned
// child reaches a terminal non-completed status (errored / crashed):
//   - "escalate" (default) → forward the existing completion notification
//     to the spawner's mailbox. Today's implicit behavior.
//   - "respawn" → the runtime re-spawns the same task_name with a fresh
//     session id, capped at 3 attempts; on cap a final notification is
//     forwarded carrying a `respawn cap exceeded` note.
//   - "ignore" → swallow the failure silently (no completion notification).
//   - "kill_pool" → stub only this wave; Wave 6 wires pool semantics.
// `PoolStrategy` is stored on the per-child slot; Wave 6 wires when
// `spawn_pool` lands. Defaults are designed to match today's semantics
// so existing callers see NO behavior change.
export type OnFailureStrategy = "respawn" | "escalate" | "ignore" | "kill_pool"
export type PoolStrategy = "one_for_one" | "one_for_all" | "rest_for_one"

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
  // D12 (actor-discipline-2026-05-20 Wave 5) — defaults preserve current
  // behavior. `on_failure` defaults to "escalate" (today's implicit
  // semantics: a terminal errored child surfaces a completion
  // notification to the spawner). `pool_strategy` defaults to
  // "one_for_one"; stub-only this release — Wave 6 wires the pool
  // surface. See SpawnAgentInput's D12 type aliases above.
  readonly on_failure?: OnFailureStrategy
  readonly pool_strategy?: PoolStrategy
  // Wave 7 (D15) — per-spawn override of the child mailbox capacity.
  // Defaults to MAILBOX_DEFAULT_CAPACITY (32) when undefined. Used by
  // integration tests and the future spawn_agent `mailbox_cap` param
  // (Wave 7 T4) to force backpressure scenarios without queueing 33
  // messages. Production callers leave undefined.
  readonly mailbox_capacity?: number
  // D16 (actor-discipline-2026-05-20 Wave 8) — explicit override of the
  // declared behavior contract version for this child. When omitted the
  // runtime falls back to `Behaviors.resolveContract(agent_type)` which
  // returns the registered default version for the agent_type (today
  // `subagent_v1` for both `general` and `explore`). Pass `subagent_v2`
  // when an orchestrator wants the forward-compat semantics under the
  // same agent_type — both versions coexist in the registry per
  // INV-D-25. Undefined agent_type AND undefined behavior_version → no
  // contract is resolved → no validation fires at terminal-status time
  // (which is the correct behavior for unregistered agent_types per
  // WAVE.md gotcha 1).
  readonly behavior_version?: "subagent_v1" | "subagent_v2"
}

export type SpawnError =
  | AgentLimitReachedError
  | AgentDepthExceededError
  | AgentPathInvalidError
  | PathAlreadyExistsError
  | NoNicknameAvailableError

// D13 (actor-discipline-2026-05-20 Wave 6) — spawn_pool primitive surface.
// `createPool` fans N workers out under a shared pool_id. `collectPool`
// drains the caller's mailbox for deliverables authored by pool members.
// `listPoolMembers` / `closePoolMembers` expose membership for the tool
// surface (Wave 6 T2 wires `spawn_pool`). Pool member spawning is
// non-atomic per WAVE.md gotcha 1 — partial failures are surfaced via the
// `failures` array, never aborting the whole pool.
export interface CreatePoolInput {
  readonly parentID: SessionID
  readonly parentPath: AgentPath
  readonly agent_type?: string
  readonly count: number
  readonly task_prefix?: string
  readonly common_message: string
  readonly per_worker_messages?: ReadonlyArray<string>
  readonly pool_strategy?: PoolStrategy
  readonly on_failure?: OnFailureStrategy
  readonly options?: SpawnAgentOptions
  readonly max_threads?: number
}

export interface PoolMemberFailure {
  readonly task_name: string
  readonly error_tag: string
  readonly reason: string
}

export interface CreatePoolResult {
  readonly pool_id: string
  readonly members: ReadonlyArray<LiveAgent>
  readonly failures: ReadonlyArray<PoolMemberFailure>
}

export interface PoolDeliverable {
  readonly worker_path: AgentPath
  readonly worker_session_id: SessionID
  readonly content: string
  readonly delivered_at: number
}

export type CollectStrategy =
  | { readonly type: "all" }
  | { readonly type: "first" }
  | { readonly type: "any_n"; readonly n: number }

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
    flags?: { system?: boolean },
  ) => Effect.Effect<void, AgentNotFoundError | MailboxFullError>
  readonly closeAgent: (
    id: SessionID,
    callerID?: SessionID,
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
  // D10 (actor-discipline-2026-05-20 Wave 3) — peek into the caller's
  // mailbox for the first message carrying the given correlation_id.
  // Does NOT drain — the message stays in the mailbox so the normal
  // turn-boundary drain delivers it to the model. Used by wait_for_reply
  // to filter on correlation_id without consuming the mailbox. Per-root
  // scoped via the caller's sessionID.
  readonly findMailboxByCorrelationId: (
    id: SessionID,
    correlation_id: string,
  ) => Effect.Effect<InterAgentCommunication | undefined>
  readonly cancelChildrenOf: (parentID: SessionID) => Effect.Effect<void>
  // D9 (actor-discipline-2026-05-20) — has the path ever been registered
  // under the caller's root? Used by the close_agent tool to split the
  // failed-resolution error into `already_terminated` (path was once live,
  // now released) vs `path_invalid` (path was never registered — typo /
  // wrong root). Per-root scoped via senderID. Returns false when
  // senderID's slot is unknown OR the path was never registered.
  readonly wasKnownPath: (senderID: SessionID, path: AgentPath) => Effect.Effect<boolean>
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
  // D13 (actor-discipline-2026-05-20 Wave 6) — pool primitives. Every
  // method takes the caller's SessionID and resolves the per-root slot
  // via slotFor (mirrors the per-root scoping invariant the other reads
  // already follow).
  readonly createPool: (input: CreatePoolInput) => Effect.Effect<CreatePoolResult>
  readonly collectPool: (
    pool_id: string,
    callerID: SessionID,
    strategy: CollectStrategy,
    timeout_ms?: number,
  ) => Effect.Effect<{
    readonly deliverables: ReadonlyArray<PoolDeliverable>
    readonly timed_out: boolean
  }>
  readonly listPoolMembers: (
    pool_id: string,
    callerID: SessionID,
  ) => Effect.Effect<ReadonlyArray<SessionID>>
  readonly closePoolMembers: (
    pool_id: string,
    callerID: SessionID,
    except?: SessionID,
  ) => Effect.Effect<void>
  // D14 (actor-discipline-2026-05-20 Wave 7) — link primitives. Both
  // peers must resolve to the same per-root slot via callerID's
  // slotFor; cross-root pairs fail with AgentNotFoundError matching
  // the cross-root-send-rejection shape. Self-link is a no-op (no
  // self-edge stored). Re-link is a no-op (idempotent symmetric add).
  // Unlink of a non-linked pair is a no-op (no error per WAVE.md
  // gotcha 2). agentLinks returns the sorted SessionID[] of peers
  // `id` is linked to; empty when no links exist or callerID can't
  // resolve a slot.
  readonly linkAgents: (
    a: SessionID,
    b: SessionID,
    callerID: SessionID,
  ) => Effect.Effect<void, AgentNotFoundError>
  readonly unlinkAgents: (
    a: SessionID,
    b: SessionID,
    callerID: SessionID,
  ) => Effect.Effect<void>
  readonly agentLinks: (
    id: SessionID,
    callerID: SessionID,
  ) => Effect.Effect<readonly SessionID[]>
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
  // Sessions whose impending status="shutdown" transition the completion
  // watcher MUST swallow without firing a parent notification. Populated by
  // closeAgent BEFORE setting status, so the watcher's async stream handler
  // sees the entry by the time it processes the change. Entries are cleared
  // alongside the rest of the slot on per-root teardown / instance disposal.
  // See "Skip rule: closeAgent-triggered shutdown" in MESSAGE_SHAPES.md —
  // legacy behavior was an unconditional skip on every shutdown, which
  // stranded `wait_agent` whenever a child self-closed (the parent never
  // learned about the close and timed out).
  readonly skipCompletionNotification: Set<SessionID>
  // D5 (actor-discipline-2026-05-20) — per-child spawner path. Populated at
  // spawnAgent. Read by sendInterAgentCommunication to detect whether a
  // child's send is targeting its own spawner — that send marks the child
  // as having delivered. The completion watcher consults outgoingToSpawner
  // at terminal-status time to decide whether to prepend the safety-net
  // warning ("child never delivered via send_message/followup_task").
  readonly spawnerOf: Map<SessionID, AgentPath>
  readonly outgoingToSpawner: Set<SessionID>
  // D9 (actor-discipline-2026-05-20) — set of every path that has ever been
  // registered under this root, kept across release. The close_agent tool
  // consults this to distinguish "path was registered then terminated"
  // (success case → `already_terminated`) from "path was never registered"
  // (error case → `path_invalid`). Entries persist for the lifetime of the
  // root slot — re-creating a path between two waves is rare and the
  // distinction we care about is the model-facing one (was this a typo?).
  readonly knownPaths: Set<string>
  // D12 (actor-discipline-2026-05-20 Wave 5) — supervision-strategy
  // storage. Populated by spawnAgent after the child session is created;
  // read by the completion watcher at terminal-status time. Cleared with
  // the rest of the slot on per-root teardown / instance disposal.
  //   - `onFailureOf` — declared on_failure policy keyed by child SessionID.
  //   - `poolStrategyOf` — declared pool_strategy keyed by child SessionID
  //     (stub-only; Wave 6 wires).
  //   - `respawnCountByPath` — per-task_name respawn-attempt counter keyed
  //     by the child's canonical path-as-string. Cap is 3 (after which the
  //     watcher escalates with a `respawn cap exceeded` note).
  //   - `respawnInputByPath` — cached SpawnAgentInput keyed by path string
  //     so the watcher can re-invoke `spawnAgent` with the original
  //     parameters when on_failure=respawn fires.
  readonly onFailureOf: Map<SessionID, OnFailureStrategy>
  readonly poolStrategyOf: Map<SessionID, PoolStrategy>
  readonly respawnCountByPath: Map<string, number>
  readonly respawnInputByPath: Map<string, SpawnAgentInput>
  // D13 (actor-discipline-2026-05-20 Wave 6) — spawn_pool primitive
  // storage. `poolMembers` maps pool_id → ordered worker SessionIDs (the
  // order matches the createPool fan-out — caller index 0 is first).
  // `poolOf` is the reverse index: worker SessionID → pool_id (so a
  // single member-id lookup yields its pool). Both are cleared with the
  // rest of the slot on per-root teardown / instance disposal.
  readonly poolMembers: Map<string, ReadonlyArray<SessionID>>
  readonly poolOf: Map<SessionID, string>
  // D14 (actor-discipline-2026-05-20 Wave 7) — link primitives.
  // `links` is a symmetric adjacency map: when A and B are linked, the
  // entry exists on BOTH A's Set and B's Set. Symmetry is enforced by
  // the linkAgents/unlinkAgents methods — never construct one-sided
  // edges. `linkedDeathOf` is the cascade marker set: when the
  // completion watcher tears down a peer because its partner crashed,
  // the peer's SessionID lands here BEFORE closeAgent runs. The watcher
  // consults this set in the status-label branch to render
  // `linked_death` instead of plain `shutdown` so the parent's mailbox
  // notification surfaces the cascade cause. Both fields are cleared
  // alongside the rest of the slot on per-root teardown / instance
  // disposal — see the Session.Event.Deleted subscriber + the disposal
  // finalizer below.
  readonly links: Map<SessionID, Set<SessionID>>
  readonly linkedDeathOf: Set<SessionID>
  // D16 (actor-discipline-2026-05-20 Wave 8) — declared per-child
  // BehaviorContract registry. Populated at `spawnAgent` time via
  // `Behaviors.resolveContract(agent_type, behavior_version)`; absent
  // entries (unregistered agent_type / no agent_type at all) skip
  // validation entirely. The completion watcher reads this map at
  // terminal-status time, calls `Behaviors.computeViolations(...)`,
  // and attaches the machine-readable `behavior_violation` payload
  // onto the parent's InterAgentCommunication when violations
  // surface. Per-root scoped — same lifecycle as every other
  // PerRootData map; cleared in the Session.Event.Deleted subscriber
  // AND the instance-disposal finalizer below.
  readonly behaviorOf: Map<SessionID, BehaviorContract>
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
          slot.skipCompletionNotification.clear()
          slot.spawnerOf.clear()
          slot.outgoingToSpawner.clear()
          slot.knownPaths.clear()
          slot.onFailureOf.clear()
          slot.poolStrategyOf.clear()
          slot.respawnCountByPath.clear()
          slot.respawnInputByPath.clear()
          slot.poolMembers.clear()
          slot.poolOf.clear()
          slot.links.clear()
          slot.linkedDeathOf.clear()
          slot.behaviorOf.clear()
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
              data.skipCompletionNotification.clear()
              data.spawnerOf.clear()
              data.outgoingToSpawner.clear()
              data.knownPaths.clear()
              data.onFailureOf.clear()
              data.poolStrategyOf.clear()
              data.respawnCountByPath.clear()
              data.respawnInputByPath.clear()
              data.poolMembers.clear()
              data.poolOf.clear()
              data.links.clear()
              data.linkedDeathOf.clear()
              data.behaviorOf.clear()
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
          skipCompletionNotification: new Set(),
          spawnerOf: new Map(),
          outgoingToSpawner: new Set(),
          knownPaths: new Set([String(AgentPath.root())]),
          onFailureOf: new Map(),
          poolStrategyOf: new Map(),
          respawnCountByPath: new Map(),
          respawnInputByPath: new Map(),
          poolMembers: new Map(),
          poolOf: new Map(),
          links: new Map(),
          linkedDeathOf: new Set(),
          behaviorOf: new Map(),
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

    // Fork an agent's runLoop fiber and wire its lifecycle hooks. Used by
    // the initial spawn and by revival from sendInterAgentCommunication
    // when a trigger_turn message lands on a previously-completed agent.
    // The onExit closure handles three terminal cases:
    //   - success → status becomes { completed: null } (mailbox can revive)
    //   - interrupt → status untouched (caller controls — closeAgent path)
    //   - any other failure → status becomes { errored: <pretty cause> }
    // The `data.scope` parent ensures the fiber dies with the per-root slot
    // (and never outlives its registered root).
    const startAgentFiber = Effect.fn("AgentControl.startAgentFiber")(function* (
      data: InternalState,
      slot: PerRootData,
      sessionID: SessionID,
    ) {
      const provider = yield* Ref.get(providerRef)
      const loopEffect: Effect.Effect<unknown> = provider ? provider(sessionID) : Effect.never
      const status = slot.statuses.get(sessionID)
      const fiber = yield* loopEffect.pipe(
        Effect.onExit((exit: Exit.Exit<unknown, unknown>) =>
          Effect.gen(function* () {
            slot.fibers.delete(sessionID)
            if (!status) return
            if (Exit.isSuccess(exit)) {
              yield* SubscriptionRef.set(status, { completed: null })
              return
            }
            if (Cause.hasInterrupts(exit.cause)) return
            yield* SubscriptionRef.set(status, {
              errored: Cause.pretty(exit.cause),
            })
          }),
        ),
        Effect.forkIn(data.scope),
      )
      slot.fibers.set(sessionID, fiber)
      return fiber
    })

    const spawnAgent: (input: SpawnAgentInput) => Effect.Effect<LiveAgent, SpawnError> = Effect.fn(
      "AgentControl.spawnAgent",
    )(function* (input: SpawnAgentInput) {
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

            const mailbox = yield* Mailbox.make(input.mailbox_capacity)
            const status = yield* SubscriptionRef.make<AgentStatus>("pending_init")

            yield* mailbox.sendSystem(
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
            // D5 (actor-discipline-2026-05-20) — record this child's spawner
            // path so sendInterAgentCommunication can detect "child delivered
            // to spawner" sends and flip outgoingToSpawner. The completion
            // watcher reads outgoingToSpawner at terminal-status time to
            // decide whether to prepend the safety-net warning.
            slot.spawnerOf.set(child.id, input.parentPath)
            // D12 (actor-discipline-2026-05-20 Wave 5) — store the
            // declared supervision policies on the per-child slot. The
            // completion watcher reads `onFailureOf` at terminal-status
            // time to decide between escalate / respawn / ignore. The
            // `respawnInputByPath` cache lets the watcher re-invoke
            // spawnAgent with the original parameters when a respawn
            // fires. `respawnCountByPath` is initialised once per
            // task_name and bumped on each respawn (cap = 3 attempts).
            // `poolStrategyOf` is stored only here — Wave 6 wires.
            slot.onFailureOf.set(child.id, input.on_failure ?? "escalate")
            slot.poolStrategyOf.set(child.id, input.pool_strategy ?? "one_for_one")
            slot.respawnInputByPath.set(String(childPath), input)
            if (!slot.respawnCountByPath.has(String(childPath))) {
              slot.respawnCountByPath.set(String(childPath), 0)
            }
            // D9 (actor-discipline-2026-05-20) — record this path so the
            // close_agent tool can distinguish "already terminated" (the path
            // was once registered under this root, then released) from
            // "path invalid" (typo / wrong root). Entries persist after
            // release; the registry's path index is the live source of truth
            // and a re-spawn at the same path is rare enough that we accept
            // the "already_terminated → re-resolved live" transition.
            slot.knownPaths.add(String(childPath))
            // Index the child back to its root so future operations
            // (sendInterAgentCommunication, closeAgent, wait_agent) on
            // the child resolve to the right slot.
            data.sessionToRoot.set(child.id, slot.rootID)

            // Wave 8 (D16) — resolve declared behavior contract for this child.
            // Undefined when agent_type is undefined / unknown — no contract means
            // no runtime validation at terminal time. Stored per-child so spawn-time
            // version selection (default vs explicit) is locked in.
            const contract = Behaviors.resolveContract(input.agent_type, input.behavior_version)
            if (contract) slot.behaviorOf.set(child.id, contract)

            yield* startAgentFiber(data, slot, child.id)

            // Sibling completion watcher. Mirrors codex
            // maybe_start_completion_watcher (codex-rs/core/src/agent/control.rs:943-1015):
            // when this child reaches a final status, send a notification to
            // the parent's mailbox so wait_agent's seq watch wakes. Forked
            // into data.scope so the watcher dies with the per-root slot
            // (and never outlives the parent root).
            //
            // Codex stops at a JSON status notification because its V2 design
            // expects subagents to push results explicitly via send_message.
            // We diverge: ALSO fetch the child's last finished assistant
            // message body and inline it after the status line so the parent
            // sees the actual deliverable without the child having to remember
            // to send_message before going idle. Falls back to status-only
            // when no finished assistant message exists (early failure, etc).
            //
            // Skip rule on shutdown: closeAgent is the only path that sets
            // status to "shutdown". The watcher skips the notification only
            // when the parent already KNOWS about the close — detected via
            // `slot.skipCompletionNotification` (populated by closeAgent when
            // the caller is the target's strict ancestor, or when callerID
            // was not provided — legacy behavior). A self-close or a
            // sibling-/descendant-initiated close on a child SHOULD wake
            // the parent's wait_agent, so the notification fires normally
            // (with the "shutdown" label so the parent can tell it apart
            // from a natural exit). Was previously an unconditional skip —
            // see MESSAGE_SHAPES.md § "Skip rule: closeAgent-triggered
            // shutdown" and the original bug demo at ses_1ce9356abffep1L0TvDbD80uUO.
            //
            // Race rule (do NOT drop(1) the changes stream): a fast-failing
            // runLoop (e.g. Effect.die before any sleep) can flip status to
            // its terminal value BEFORE this watcher subscribes. Dropping
            // the initial emission then loses the only signal we'd ever
            // see. Instead we accept the initial emission and filter on
            // isFinal — pending_init / running / interrupted are skipped,
            // the next change is awaited.
            yield* Stream.runForEach(
              SubscriptionRef.changes(status),
              (next) =>
                Effect.gen(function* () {
                  if (!AgentStatus.isFinal(next)) return
                  const isShutdown = next === "shutdown"
                  if (isShutdown && slot.skipCompletionNotification.has(child.id)) {
                    return yield* Effect.interrupt
                  }
                  // D12 (actor-discipline-2026-05-20 Wave 5) — supervision
                  // policy dispatch. Inspect the child's declared
                  // `on_failure` policy when status is errored (non-
                  // shutdown, non-completed). Three branches that exit
                  // before the standard notification fires:
                  //   - respawn (count < 3) → send a transient_tool_error
                  //     notification with `attempt N/3`, increment the
                  //     per-path counter, release this child's slot state,
                  //     and re-invoke spawnAgent with the cached input.
                  //   - ignore → swallow the failure silently.
                  // A fourth branch sets `overrideAbortReason` to enrich
                  // the standard notification's abort_reason when the
                  // respawn cap is exceeded (escalate fall-through).
                  // `escalate` (default) and `kill_pool` (stub) fall
                  // through to the pre-D12 notification path unchanged.
                  const isErrored = !isShutdown && typeof next === "object" && "errored" in next
                  const childPolicy = slot.onFailureOf.get(child.id) ?? "escalate"
                  let overrideAbortReason: { reason: string; details: string } | undefined
                  if (isErrored && childPolicy === "ignore") {
                    return yield* Effect.interrupt
                  }
                  if (isErrored && childPolicy === "respawn") {
                    const pathKey = String(childPath)
                    const priorCount = slot.respawnCountByPath.get(pathKey) ?? 0
                    if (priorCount < 3) {
                      const attempt = priorCount + 1
                      const respawnNote = `Agent ${String(childPath)} reached status: errored`
                      yield* sendInterAgentCommunication(
                        input.parentID,
                        new InterAgentCommunication({
                          author: childPath,
                          recipient: input.parentPath,
                          content: respawnNote,
                          trigger_turn: false,
                          sent_at: Date.now(),
                          abort_reason: {
                            reason: "transient_tool_error",
                            details: `respawned after crash; attempt ${attempt}/3`,
                          },
                        }),
                        child.id,
                        { system: true },
                      ).pipe(Effect.catch(() => Effect.void))
                      slot.respawnCountByPath.set(pathKey, attempt)
                      const cachedInput = slot.respawnInputByPath.get(pathKey) ?? input
                      // Release this crashed child's per-slot state before
                      // re-spawning. The registry path index MUST be freed
                      // so `reservation.reserveAgentPath(childPath)` in
                      // the new spawn doesn't trip PathAlreadyExistsError.
                      // We KEEP respawnCountByPath + respawnInputByPath
                      // so subsequent crashes accumulate against the cap.
                      slot.mailboxes.delete(child.id)
                      slot.statuses.delete(child.id)
                      slot.fibers.delete(child.id)
                      slot.onFailureOf.delete(child.id)
                      slot.poolStrategyOf.delete(child.id)
                      slot.outgoingToSpawner.delete(child.id)
                      slot.spawnerOf.delete(child.id)
                      slot.skipCompletionNotification.delete(child.id)
                      yield* slot.registry.releaseSpawnedThread(child.id)
                      data.sessionToRoot.delete(child.id)
                      yield* spawnAgent(cachedInput).pipe(Effect.catch(() => Effect.void))
                      return yield* Effect.interrupt
                    }
                    // Cap exceeded: fall through to standard notification
                    // but enrich abort_reason so the spawner sees the
                    // escalation cause.
                    overrideAbortReason = {
                      reason: "transient_tool_error",
                      details: "respawn cap exceeded after 3 attempts",
                    }
                  }
                  const label = isShutdown
                    ? (slot.linkedDeathOf.has(child.id) ? "linked_death" : "shutdown")
                    : typeof next === "object" && "completed" in next
                      ? "completed"
                      : "errored"
                  // D5 (actor-discipline-2026-05-20) — extractor narrowing.
                  // Pre-D5 the predicate skipped any assistant message ending
                  // in `finish: "tool-calls"`, which silently dropped the
                  // entire deliverable when the model emitted text AND a
                  // close_agent (or any tool) call in the same turn. New
                  // shape: accept any assistant message whose joined text
                  // parts are non-empty, walking newest-first. Empty matches
                  // (tool-only / thinking-only turns) are filtered inside the
                  // predicate so findMessage keeps walking past them until it
                  // finds a non-empty body or runs out of messages.
                  //
                  // Wave 2 hardening (D5b) — two-pass walk. The Cidoo shape
                  // (`ses_1c2e8d84affeZ7t5g5LKveGDTo`) emitted the real
                  // deliverable in one assistant message (finish=tool-calls,
                  // ~5KB body) and then a TERSE follow-up status line in a
                  // second assistant message (finish=stop, "Done."). Pass-1
                  // (non-empty AND not a terse status line) finds the real
                  // deliverable. Pass-2 (any non-empty) is the fallback when
                  // the only message in the session IS a terse status line
                  // — that case still wants the body inlined alongside the
                  // ⚠️ warning so the parent sees what the child actually
                  // emitted.
                  const substantive = yield* sessions
                    .findMessage(child.id, (m) => {
                      if (m.info.role !== "assistant") return false
                      const text = extractText(m.parts)
                      return text.length > 0 && !looksLikeMissingDeliverable(text)
                    })
                    .pipe(Effect.orElseSucceed(() => Option.none<never>()))
                  const finalAssistant = Option.isSome(substantive)
                    ? substantive
                    : yield* sessions
                        .findMessage(child.id, (m) => {
                          if (m.info.role !== "assistant") return false
                          const text = extractText(m.parts)
                          return text.length > 0
                        })
                        .pipe(Effect.orElseSucceed(() => Option.none<never>()))
                  const body = Option.match(finalAssistant, {
                    onNone: () => "",
                    onSome: (msg) => extractText(msg.parts),
                  })
                  // D5 — safety-net warning. If the child never invoked
                  // send_message/followup_task with its spawner as recipient
                  // AND the extracted body is empty OR looks like a terse
                  // status line (short, single-line, contains cleanup-style
                  // words), prepend the structured warning so the parent can
                  // tell "subagent silently exited without delivering" apart
                  // from "subagent's deliverable IS this body". Heuristic
                  // tuned to fire on the diagnostic-session-3 message
                  // ("Report delivered to parent") while sparing legitimate
                  // short deliverables like
                  // "Found: /abs/path/file.ts:42 — checks expiry."
                  const childDelivered = slot.outgoingToSpawner.has(child.id)
                  const needsWarning = !childDelivered && looksLikeMissingDeliverable(body)
                  const header = `Agent ${String(childPath)} reached status: ${label}`
                  const content = buildNotificationBody(header, body, needsWarning)
                  // D11 (actor-discipline-2026-05-20 Wave 4) — parse the
                  // ABORT set-phrase from the LAST line of the extracted
                  // body. undefined when no ABORT line present (normal
                  // completion). The structured payload rides alongside
                  // the human-readable `content` — legacy consumers (TUI,
                  // log scrapers) still see the literal `ABORT(...):` text
                  // inside the body; supervisors dispatch on the parsed
                  // payload. Independent of safety-net warning logic;
                  // both passes inspect the same `body` separately.
                  const abortParsed = parseAbortReason(body)
                  // D12 (actor-discipline-2026-05-20 Wave 5) — when the
                  // respawn cap branch above set `overrideAbortReason`,
                  // it wins over the body-parsed value so the spawner
                  // sees the cap-exceeded escalation cause.
                  const effectiveAbortReason = overrideAbortReason ?? abortParsed
                  // Wave 8 (D16) — behavior contract validation at terminal status.
                  // Reads childDelivered (D5 tracker) + effectiveAbortReason (D11/D12).
                  // Surfaces a machine-readable behavior_violation payload on the
                  // notification when violations exist. Additive to D5's prose warning;
                  // both can fire on the same case. The validation is OBSERVER-only —
                  // spawn already returned cleanly; the orchestrator decides whether
                  // to pivot / retry / ignore based on the structured payload.
                  const behaviorContract = slot.behaviorOf.get(child.id)
                  const violations = Behaviors.computeViolations(behaviorContract, {
                    delivered: childDelivered,
                    abortReason: effectiveAbortReason,
                  })
                  const behavior_violation =
                    behaviorContract && violations.length > 0
                      ? {
                          contract_version: behaviorContract.version,
                          violations: violations.map((v) => ({
                            kind: v.kind as string,
                            detail: v.detail,
                          })),
                        }
                      : undefined
                  // The watcher's send may race with parent deletion. If the
                  // parent root is gone, sendInterAgentCommunication fails
                  // with AgentNotFoundError — absorb it; nothing to wake.
                  yield* sendInterAgentCommunication(
                    input.parentID,
                    new InterAgentCommunication({
                      author: childPath,
                      recipient: input.parentPath,
                      content,
                      trigger_turn: false,
                      sent_at: Date.now(),
                      abort_reason: effectiveAbortReason,
                      behavior_violation,
                    }),
                    child.id,
                    { system: true },
                  ).pipe(Effect.catch(() => Effect.void))
                  // D14 (actor-discipline-2026-05-20 Wave 7) — linked-death
                  // cascade. When this child reaches a terminal NON-shutdown
                  // status (completed / errored), every peer linked to it
                  // dies too. Iterate slot.links.get(child.id); for each
                  // peer that's still alive (status non-final, not already
                  // queued by another cascade), mark the peer in
                  // linkedDeathOf BEFORE closing so its watcher renders the
                  // status label as `linked_death` instead of bare
                  // `shutdown`. closeAgent runs with child.id as caller so
                  // it does NOT inherit the strict-ancestor skip
                  // optimisation — the peer's parent still needs the
                  // linked_death notification on its mailbox.
                  if (!isShutdown) {
                    const peers = slot.links.get(child.id)
                    if (peers && peers.size > 0) {
                      // Snapshot peer ids — closeAgent on each will
                      // mutate the underlying maps; iterate the copy.
                      const peerSnapshot = [...peers]
                      for (const peerID of peerSnapshot) {
                        if (peerID === child.id) continue
                        const peerStatus = slot.statuses.get(peerID)
                        if (!peerStatus) continue
                        const peerNow = yield* SubscriptionRef.get(peerStatus)
                        if (AgentStatus.isFinal(peerNow)) continue
                        if (slot.linkedDeathOf.has(peerID)) continue
                        slot.linkedDeathOf.add(peerID)
                        yield* closeAgent(peerID, child.id).pipe(
                          Effect.catch(() => Effect.void),
                        )
                      }
                      // Clear child.id from every peer's adjacency set,
                      // then drop child.id's own entry. The link is gone
                      // because the child is gone — leave no stale edges.
                      for (const peerID of peerSnapshot) {
                        const peerLinks = slot.links.get(peerID)
                        if (peerLinks) {
                          peerLinks.delete(child.id)
                          if (peerLinks.size === 0) slot.links.delete(peerID)
                        }
                      }
                      slot.links.delete(child.id)
                    }
                  }
                  // Shutdown is terminal — the fiber is gone, the mailbox
                  // (and therefore any revival possibility) is gone. Interrupt
                  // the watcher so it doesn't sit forever on a defunct status
                  // ref. For natural completion (`{completed: null}`) we keep
                  // watching: Bug 3's revival path can restart the runLoop
                  // fiber on a trigger_turn message, driving status through
                  // running → next terminal value, and the second cycle MUST
                  // still produce its own notification.
                  if (isShutdown) return yield* Effect.interrupt
                  // Non-shutdown terminal (completed / errored): do NOT
                  // interrupt. The revival path (sendInterAgentCommunication
                  // restarting the runLoop fiber on a trigger_turn message)
                  // drives status from {completed: null} → "running" → next
                  // terminal value. A self-interrupt here means subsequent
                  // revival cycles complete silently and the parent's
                  // wait_agent times out forever. The watcher dies on its
                  // own when status flips to "shutdown" (above) or when
                  // data.scope is destroyed (root deletion).
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
      function* (
        targetID: SessionID,
        comm: InterAgentCommunication,
        senderID: SessionID,
        flags?: { system?: boolean },
      ) {
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
        // Wave 7 (D15) — system path bypasses the user-mailbox capacity
        // cap so completion-watcher notifications + internal lifecycle
        // sends still reach the parent even when its mailbox is at
        // capacity. User-facing sends use the bounded `send` and surface
        // `MailboxFullError` upward; tool wrappers (agent-send /
        // agent-followup) translate that into a structured `mailbox_full`
        // retry hint per WAVE.md gotcha 5.
        if (flags?.system) {
          yield* mailbox.sendSystem(comm)
        } else {
          yield* mailbox.send(comm)
        }
        yield* slot.registry.updateLastTaskMessage(targetID, comm.content)
        // D5 (actor-discipline-2026-05-20) — safety-net tracking. If the
        // sender is a registered child AND the recipient is the sender's
        // spawner path, mark the child as having delivered. The completion
        // watcher consults this flag at terminal-status time to decide
        // whether to prepend the missing-deliverable warning.
        const spawnerPath = slot.spawnerOf.get(senderID)
        if (spawnerPath !== undefined && (comm.recipient as string) === (spawnerPath as string)) {
          slot.outgoingToSpawner.add(senderID)
        }
        // Codex parity: trigger_turn mail revives an idle agent.
        // codex-rs/core/src/session/handlers.rs:310-321 — after enqueueing,
        // if trigger_turn is true, codex calls
        // `maybe_start_turn_for_pending_work_with_sub_id` which spawns a
        // fresh task that drains the mailbox and runs a new turn. Codex's
        // session stays alive idle between turns; ours forks a fiber per
        // turn that exits on finish, so we revive by forking a fresh
        // runLoop fiber when:
        //   - the message wakes the recipient (trigger_turn=true), AND
        //   - the target is not the root (root never "completes"), AND
        //   - the target has no live fiber, AND
        //   - the previous status is final but not "shutdown" (closeAgent
        //     marks a permanent kill — don't resurrect explicitly-closed
        //     agents). The status reset to "running" lets the runLoop's
        //     normal Step.* events overwrite it as turns progress.
        if (comm.trigger_turn && targetID !== slot.rootID && !slot.fibers.has(targetID)) {
          const status = slot.statuses.get(targetID)
          if (status) {
            const current = yield* SubscriptionRef.get(status)
            if (AgentStatus.isFinal(current) && current !== "shutdown") {
              yield* SubscriptionRef.set(status, "running")
              yield* startAgentFiber(data, slot, targetID)
            }
          }
        }
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

    // Strict-ancestor predicate over canonical AgentPaths. Returns true when
    // `ancestor` is a proper prefix of `descendant` ("/root" is a strict
    // ancestor of every non-root path; nothing is a strict ancestor of
    // itself). Used by closeAgent to decide whether the caller of a close
    // already KNOWS about it — if so, the completion watcher skips the
    // parent notification (the legacy behavior for ALL closes); otherwise
    // it fires so the watching parent's wait_agent wakes.
    const isStrictAncestor = (ancestor: AgentPath, descendant: AgentPath): boolean => {
      const a = ancestor as string
      const d = descendant as string
      if (a === d) return false
      if (a === "/root") return d.startsWith("/root/")
      return d.startsWith(a + "/")
    }

    const closeAgent = Effect.fn("AgentControl.closeAgent")(function* (
      id: SessionID,
      callerID?: SessionID,
    ) {
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

      // Determine which sessions (target + descendants) the completion
      // watcher should swallow without notifying. Three cases:
      //
      //   - callerID undefined → preserve the pre-fix semantics (skip every
      //     shutdown). Tests that drive closeAgent without a caller, and
      //     the original integration spec at MESSAGE_SHAPES.md § "Skip
      //     rule", rely on this. Production callers always supply a caller.
      //   - callerID is a strict ancestor of the target's path → the
      //     ancestor itself drove the close (directly or via cascade) and
      //     therefore already knows. Skip the notification.
      //   - any other caller (self-close, sibling-close, descendant-close)
      //     → the parent does NOT know. The notification MUST fire so the
      //     parent's wait_agent wakes instead of running its full timeout.
      //
      // The skip flag is set BEFORE shutdownOne flips status to "shutdown"
      // because the watcher reads the set on the status change.
      const callerPath = callerID !== undefined
        ? (yield* slot.registry.agentMetadataForThread(callerID))?.agent_path ??
          (callerID === slot.rootID ? AgentPath.root() : undefined)
        : undefined
      const shouldSkip = (descendantPath: AgentPath | undefined): boolean => {
        if (callerID === undefined) return true
        if (!descendantPath || !callerPath) return false
        return isStrictAncestor(callerPath, descendantPath)
      }

      if (shouldSkip(targetPath)) slot.skipCompletionNotification.add(id)
      for (const desc of descendants) {
        if (desc.agent_id && shouldSkip(desc.agent_path)) {
          slot.skipCompletionNotification.add(desc.agent_id)
        }
      }

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

    const findMailboxByCorrelationId = Effect.fn("AgentControl.findMailboxByCorrelationId")(
      function* (id: SessionID, correlation_id: string) {
        const data = yield* InstanceState.get(state)
        const slot = slotFor(data, id)
        if (!slot) return undefined
        const mailbox = slot.mailboxes.get(id)
        if (!mailbox) return undefined
        const snapshot = yield* mailbox.peek()
        return snapshot.find((m) => m.correlation_id === correlation_id)
      },
    )

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
        // Pass parentID so closeAgent's caller-aware skip rule recognises
        // this as an ancestor-driven cascade and suppresses the per-child
        // completion notifications — the parent is the one tearing them
        // down, so the notification would just race the cancel itself.
        yield* closeAgent(child.agent_id, parentID).pipe(Effect.catch(() => Effect.void))
      }
    })

    // D9 (actor-discipline-2026-05-20) — has `path` ever been registered
    // under the caller's root? Used by the close_agent tool to disambiguate
    // a failed resolve into `already_terminated` (path was once live, now
    // released) vs `path_invalid` (path was never registered). Per-root
    // scoped via senderID — a path registered under root A is invisible to
    // a close from root B (mirrors the cross-root-send-rejection invariant).
    const wasKnownPath = Effect.fn("AgentControl.wasKnownPath")(function* (
      senderID: SessionID,
      path: AgentPath,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, senderID)
      if (!slot) return false
      return slot.knownPaths.has(String(path))
    })

    const emitWaitStarted = Effect.fn("AgentControl.emitWaitStarted")(function* (      sessionID: SessionID,
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

    // D13 (actor-discipline-2026-05-20 Wave 6) — spawn N pool members
    // under a shared pool_id. Per WAVE.md gotcha 1 the spawn is
    // non-atomic: a per-worker spawnAgent failure is caught into the
    // `failures` array so the remaining workers continue. Members are
    // recorded in `slot.poolMembers` keyed by pool_id; reverse index
    // `slot.poolOf` resolves a member id back to its pool.
    const createPool: (input: CreatePoolInput) => Effect.Effect<CreatePoolResult> = Effect.fn(
      "AgentControl.createPool",
    )(function* (input: CreatePoolInput) {
      const data = yield* InstanceState.get(state)
      const pool_id = Identifier.create("pool", "ascending")
      let slot = slotFor(data, input.parentID)
      if (!slot && AgentPath.isRoot(input.parentPath)) {
        slot = yield* ensureRootSlot(data, input.parentID)
      }
      if (!slot) {
        return { pool_id, members: [], failures: [] } as CreatePoolResult
      }
      const prefix = input.task_prefix ?? "pool"
      const members: LiveAgent[] = []
      const failures: PoolMemberFailure[] = []
      for (let i = 0; i < input.count; i++) {
        const task_name = `${prefix}_${i}`
        const initial_message =
          input.per_worker_messages?.[i] ?? input.common_message
        const result = yield* Effect.result(
          spawnAgent({
            parentID: input.parentID,
            parentPath: input.parentPath,
            task_name,
            agent_type: input.agent_type,
            initial_message,
            options: input.options,
            pool_strategy: input.pool_strategy,
            on_failure: input.on_failure,
            max_threads: input.max_threads,
          }),
        )
        if (result._tag === "Success") {
          members.push(result.success)
          slot.poolOf.set(result.success.thread_id, pool_id)
        } else {
          failures.push({
            task_name,
            error_tag: spawnErrorTag(result.failure),
            reason: (result.failure as { message?: string }).message ?? String(result.failure),
          })
        }
      }
      slot.poolMembers.set(
        pool_id,
        members.map((m) => m.thread_id),
      )
      return { pool_id, members, failures } as CreatePoolResult
    })

    // D13 (actor-discipline-2026-05-20 Wave 6) — drain the caller's
    // mailbox for deliverables authored by pool members. Filters out
    // completion notifications ("Agent <path> reached status: ...") so
    // only explicit send_message bodies count as deliverables. Loops
    // until the strategy is satisfied OR timeout_ms elapses. The shared
    // `collectedRef` is populated as messages arrive — on timeout we
    // snapshot it instead of re-walking the mailbox, so the timeout
    // branch never needs a second slot lookup (which could race a
    // concurrent root deletion).
    const collectPool = (
      pool_id: string,
      callerID: SessionID,
      strategy: CollectStrategy,
      timeout_ms?: number,
    ): Effect.Effect<{
      readonly deliverables: ReadonlyArray<PoolDeliverable>
      readonly timed_out: boolean
    }> =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        const slot = slotFor(data, callerID)
        if (!slot) {
          return { deliverables: [] as ReadonlyArray<PoolDeliverable>, timed_out: false }
        }
        const memberIDs = slot.poolMembers.get(pool_id) ?? []
        const memberPathByID = new Map<string, { path: AgentPath; sid: SessionID }>()
        for (const mid of memberIDs) {
          const meta = yield* slot.registry.agentMetadataForThread(mid)
          if (meta?.agent_path) {
            memberPathByID.set(String(meta.agent_path), { path: meta.agent_path, sid: mid })
          }
        }
        const mailbox = slot.mailboxes.get(callerID)
        if (!mailbox) {
          return { deliverables: [] as ReadonlyArray<PoolDeliverable>, timed_out: false }
        }
        const notify = yield* mailbox.subscribe()
        const collectedRef = yield* Ref.make(new Map<string, PoolDeliverable>())

        const isCompletionNotification = (content: string) =>
          content.startsWith("Agent ") && content.includes("reached status:")

        const drainSnapshot = Effect.gen(function* () {
          const snapshot = yield* mailbox.peek()
          const collected = yield* Ref.get(collectedRef)
          for (const msg of snapshot) {
            const authorKey = String(msg.author)
            const member = memberPathByID.get(authorKey)
            if (!member) continue
            if (collected.has(authorKey)) continue
            if (isCompletionNotification(msg.content)) continue
            collected.set(authorKey, {
              worker_path: member.path,
              worker_session_id: member.sid,
              content: msg.content,
              delivered_at: msg.sent_at,
            })
          }
          yield* Ref.set(collectedRef, collected)
        })

        const satisfied = (size: number) => {
          if (strategy.type === "all") return size >= memberIDs.length
          if (strategy.type === "first") return size >= 1
          return size >= strategy.n
        }

        const snapshotResult = (timedOut: boolean) =>
          Effect.gen(function* () {
            const collected = yield* Ref.get(collectedRef)
            const deliverables = [...collected.values()].sort(
              (a, b) => a.delivered_at - b.delivered_at,
            )
            return {
              deliverables: deliverables as ReadonlyArray<PoolDeliverable>,
              timed_out: timedOut,
            }
          })

        const loop = Effect.gen(function* () {
          while (true) {
            yield* drainSnapshot
            const collected = yield* Ref.get(collectedRef)
            if (satisfied(collected.size)) break
            yield* SubscriptionRef.changes(notify).pipe(
              Stream.drop(1),
              Stream.take(1),
              Stream.runDrain,
            )
          }
          return yield* snapshotResult(false)
        })

        if (timeout_ms === undefined) {
          return yield* loop
        }
        return yield* loop.pipe(
          Effect.timeout(Duration.millis(timeout_ms)),
          Effect.catchTag("TimeoutError", () => snapshotResult(true)),
        )
      })

    const listPoolMembers = Effect.fn("AgentControl.listPoolMembers")(function* (
      pool_id: string,
      callerID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, callerID)
      if (!slot) return [] as ReadonlyArray<SessionID>
      return (slot.poolMembers.get(pool_id) ?? []) as ReadonlyArray<SessionID>
    })

    const closePoolMembers = Effect.fn("AgentControl.closePoolMembers")(function* (
      pool_id: string,
      callerID: SessionID,
      except?: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, callerID)
      if (!slot) return
      const memberIDs = slot.poolMembers.get(pool_id) ?? []
      for (const mid of memberIDs) {
        if (mid === except) continue
        yield* closeAgent(mid, callerID).pipe(Effect.catch(() => Effect.void))
      }
    })

    // D14 (actor-discipline-2026-05-20 Wave 7) — link primitives. Per-root
    // scoped via callerID. Symmetric: link(A,B) === link(B,A); the edge
    // is stored on BOTH peers' Sets so cascade lookups from either side
    // see the partner. Cross-root pairs surface AgentNotFoundError
    // matching cross-root-send-rejection's shape. Self-link is a no-op
    // (no self-edge stored). Re-link is a no-op (Set.add is idempotent
    // by construction). The cascade lives in the completion watcher, not
    // here — these methods only manage the adjacency map.
    const linkAgents = Effect.fn("AgentControl.linkAgents")(function* (
      a: SessionID,
      b: SessionID,
      callerID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const callerSlot = slotFor(data, callerID)
      if (!callerSlot) return yield* new AgentNotFoundError({ session: callerID })
      const aRoot = data.sessionToRoot.get(a)
      const bRoot = data.sessionToRoot.get(b)
      if (!aRoot || aRoot !== callerSlot.rootID) {
        return yield* new AgentNotFoundError({ session: a })
      }
      if (!bRoot || bRoot !== callerSlot.rootID) {
        return yield* new AgentNotFoundError({ session: b })
      }
      // Self-link is a no-op — no self-edge stored. The user-facing
      // tool surface (Wave 7 T2) rejects self-link upfront with a
      // structured `self_link` error, but defending here keeps the
      // primitive safe against test-only callers.
      if (a === b) return
      const aSet = callerSlot.links.get(a) ?? new Set<SessionID>()
      const bSet = callerSlot.links.get(b) ?? new Set<SessionID>()
      aSet.add(b)
      bSet.add(a)
      callerSlot.links.set(a, aSet)
      callerSlot.links.set(b, bSet)
    })

    const unlinkAgents = Effect.fn("AgentControl.unlinkAgents")(function* (
      a: SessionID,
      b: SessionID,
      callerID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, callerID)
      if (!slot) return
      const aSet = slot.links.get(a)
      const bSet = slot.links.get(b)
      if (aSet) {
        aSet.delete(b)
        if (aSet.size === 0) slot.links.delete(a)
      }
      if (bSet) {
        bSet.delete(a)
        if (bSet.size === 0) slot.links.delete(b)
      }
    })

    const agentLinks = Effect.fn("AgentControl.agentLinks")(function* (
      id: SessionID,
      callerID: SessionID,
    ) {
      const data = yield* InstanceState.get(state)
      const slot = slotFor(data, callerID)
      if (!slot) return [] as readonly SessionID[]
      const set = slot.links.get(id)
      if (!set) return [] as readonly SessionID[]
      return [...set].sort() as readonly SessionID[]
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
      findMailboxByCorrelationId,
      cancelChildrenOf,
      wasKnownPath,
      emitWaitStarted,
      emitWaitEnded,
      createPool: createPool,
      collectPool: collectPool,
      listPoolMembers: listPoolMembers,
      closePoolMembers: closePoolMembers,
      linkAgents: linkAgents,
      unlinkAgents: unlinkAgents,
      agentLinks: agentLinks,
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
