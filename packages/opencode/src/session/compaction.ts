import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "@/util/token"
import * as Log from "@opencode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema, Cause } from "effect"
import * as Stream from "effect/Stream"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { LLM } from "./llm"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
      // Enrichment fields are absent on serves older than 2026-08; clients treat them as optional.
      trigger: Schema.optional(Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")])),
      overflow: Schema.optional(Schema.Boolean),
      tokensBefore: Schema.optional(Schema.Number),
      durationMs: Schema.optional(Schema.Number),
      summaryChars: Schema.optional(Schema.Number),
      tailStartID: Schema.optional(MessageID),
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
const DEGENERATE_MIN_SUMMARY_CHARS = 500
const DEGENERATE_MIN_HEAD_MESSAGES = 6
// Prefire starts once usage crosses this fraction of the usable window (and compaction
// has not fired yet), giving background pass-1 runway to finish before the hard line.
const PREFIRE_LEAD = 0.9
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, exact rulings — or "(none)"]

## Progress
### Done
- [completed work, with file paths — or "(none)"]

### In Progress
- [current work and its exact state — or "(none)"]

### Blocked
- [blockers, with exact error strings — or "(none)"]

## Key Decisions
- [decision and why — or "(none)"]

## Ruled Out
- [approach tried or considered and rejected, and why — or "(none)"]

## Live State
- [running processes/servers (session ids, pids, ports), spawned agents still working, detached daemons, uncommitted changes, questions awaiting the user — or "(none)"]

## Next Steps
- [ordered next actions — or "(none)"]

## Critical Context
- [technical facts, exact error strings, discovered gotchas, open questions — or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, ids, and identifiers when known; never paraphrase an identifier.
- Mark unverified assumptions with "(hypothesis)".
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

// A summary too small or off-template to plausibly carry the state of the history it
// replaces. Summaries here are anchors — every later compaction "updates" the previous
// one, so a degenerate summary would poison the session permanently. An empty summary is
// always degenerate; the template and size floors only apply to conversations big enough
// that a tiny summary cannot be honest, and the template check only when the built-in
// prompt (which mandates the template) was used.
function isDegenerateSummary(input: { text: string | undefined; headCount: number; customPrompt: boolean }) {
  if (!input.text) return true
  if (input.headCount < DEGENERATE_MIN_HEAD_MESSAGES) return false
  if (!input.customPrompt && !input.text.includes("## Goal")) return true
  return input.text.length < DEGENERATE_MIN_SUMMARY_CHARS
}

// Sticky per-session guard after a deterministic compaction failure (history too large
// to fit even stripped, or a degenerate summary twice in a row). Retrying the same input
// on the same model cannot succeed, so without this every subsequent turn re-attempts and
// re-fails the same compaction. Cleared by a model switch, a manual compact, or a later
// success; process-lifetime only. Module-scoped (not layer-scoped) deliberately: the
// service layer is constructed once per runtime and the server routes, run loop, and
// module exports run in different runtimes — session IDs are host-globally unique, so one
// process-wide map keyed by session is the correct scope.
const suppressed = new Map<string, { modelID: string; reason: "too_large" | "degenerate" }>()
function suppression(sessionID: SessionID, modelID: string) {
  const entry = suppressed.get(sessionID)
  if (!entry) return undefined
  if (entry.modelID !== modelID) {
    suppressed.delete(sessionID)
    return undefined
  }
  return entry
}

// Prefire two-pass state. Pass-1 speculatively summarizes the head in the background
// once usage crosses PREFIRE_LEAD of the usable window; at compaction time pass-2 anchors
// the cached note (<previous-summary>) and summarizes only the delta, so the blocking
// call prefills a few turns instead of the whole history. Module-scoped for the same
// multi-runtime reason as `suppressed`. An entry stays valid while it remains a PREFIX of
// the current head (the head only grows between prefires); prune mutations and reverts
// change the stamp and invalidate it.
type PrefireEntry = {
  note1: string
  headEndID: MessageID
  stamp: string
  modelID: string
}
const prefireCache = new Map<string, PrefireEntry>()
const prefireInflight = new Set<string>()

// Identity + mutation stamp for a head slice: message ids, part counts, and the newest
// prune stamp. Completed turns are immutable except for pruning, so this is cheap and
// sufficient to detect anything that would make a cached pass-1 note lie.
function prefireStamp(messages: MessageV2.WithParts[]) {
  return messages
    .map((m) => {
      const compacted = m.parts.reduce(
        (max, p) =>
          p.type === "tool" && p.state.status === "completed" && p.state.time.compacted
            ? Math.max(max, p.state.time.compacted)
            : max,
        0,
      )
      return `${m.info.id}:${m.parts.length}:${compacted}`
    })
    .join("|")
}

// Index in `head` up to which `entry` covers it, or undefined when the entry is stale
// (model switch, revert, prune, or any divergence from the cached prefix).
function prefireCut(entry: PrefireEntry, head: MessageV2.WithParts[], modelID: string) {
  if (entry.modelID !== modelID) return undefined
  const cut = head.findIndex((m) => m.info.id === entry.headEndID)
  if (cut === -1) return undefined
  if (prefireStamp(head.slice(0, cut + 1)) !== entry.stamp) return undefined
  return cut
}

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
    sessionID?: SessionID
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly prefire: (input: {
    sessionID: SessionID
    tokens: MessageV2.Assistant["tokens"]
    model: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    liveState?: string[]
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
  | LLM.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
      sessionID?: SessionID
    }) {
      if (input.sessionID && suppression(input.sessionID, input.model.id)) return false
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    // Background pass-1: summarize the current head into a cached note before the
    // auto-compact line is reached. Fire-and-forget from the run loop (Effect.ignore +
    // forkIn(scope)); every failure path just skips the cache and compaction falls back
    // to the ordinary single-pass. Produces no session messages and no events.
    const prefire = Effect.fn("SessionCompaction.prefire")(function* (input: {
      sessionID: SessionID
      tokens: MessageV2.Assistant["tokens"]
      model: { providerID: ProviderID; modelID: ModelID }
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.prefire === false) return
      if (cfg.compaction?.auto === false) return
      if (suppression(input.sessionID, input.model.modelID)) return
      if (prefireInflight.has(input.sessionID)) return
      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(input.model.providerID, input.model.modelID)
      const count =
        input.tokens.total ||
        input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
      const limit = usable({ cfg, model })
      if (limit === 0) return
      if (count < limit * PREFIRE_LEAD || count >= limit) return

      const messages = yield* MessageV2.filterCompactedEffect(input.sessionID)
      const prior = completedCompactions(messages)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: messages.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      if (!selected.head.length) return
      const existing = prefireCache.get(input.sessionID)
      if (existing && prefireCut(existing, selected.head, model.id) !== undefined) return
      if (existing) prefireCache.delete(input.sessionID)
      const user = messages.findLast((m) => m.info.role === "user")
      if (!user || user.info.role !== "user") return
      const userInfo = user.info

      prefireInflight.add(input.sessionID)
      yield* Effect.gen(function* () {
        const compacting = yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )
        const prompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
        const msgs = structuredClone(selected.head)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
          stripMedia: true,
          toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
        })
        const started = Date.now()
        const note1 = yield* llm
          .stream({
            agent,
            user: userInfo,
            system: [],
            tools: {},
            model,
            sessionID: input.sessionID,
            retries: 1,
            messages: [
              ...modelMessages,
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
              },
            ],
          })
          .pipe(
            Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
            Stream.map((e) => e.text),
            Stream.mkString,
          )
        if (
          isDegenerateSummary({
            text: note1.trim() || undefined,
            headCount: selected.head.length,
            customPrompt: compacting.prompt !== undefined,
          })
        ) {
          log.warn("prefire produced a degenerate note, not caching", { sessionID: input.sessionID })
          return
        }
        prefireCache.set(input.sessionID, {
          note1,
          headEndID: selected.head.at(-1)!.info.id,
          stamp: prefireStamp(selected.head),
          modelID: model.id,
        })
        log.info("prefire cached", {
          sessionID: input.sessionID,
          headCount: selected.head.length,
          ms: Date.now() - started,
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.warn("prefire failed", { sessionID: input.sessionID, error: Cause.squash(cause) }),
          ),
        ),
        Effect.ensuring(Effect.sync(() => prefireInflight.delete(input.sessionID))),
      )
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      liveState?: string[]
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Prefire pass-2: when a background pass-1 note covers a prefix of the head, anchor
      // it and summarize only the uncovered delta. Stale entries (model switch, revert,
      // prune) fall back to the full single-pass without ceremony.
      const prefired = (() => {
        const entry = prefireCache.get(input.sessionID)
        if (!entry) return undefined
        const cut = prefireCut(entry, selected.head, model.id)
        if (cut === undefined) {
          prefireCache.delete(input.sessionID)
          log.info("prefire stale, falling back to single-pass", { sessionID: input.sessionID })
          return undefined
        }
        return { entry, cut }
      })()
      if (prefired) {
        log.info("prefire hit", {
          sessionID: input.sessionID,
          covered: prefired.cut + 1,
          headCount: selected.head.length,
        })
      }
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const buildInputs = Effect.fn("SessionCompaction.buildInputs")(function* (useCache: boolean) {
        const cache = useCache ? prefired : undefined
        const anchor = cache ? cache.entry.note1 : previousSummary
        const head = cache ? selected.head.slice(cache.cut + 1) : selected.head
        const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary: anchor, context: compacting.context })
        const msgs = structuredClone(head)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
          stripMedia: true,
          toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
        })
        return { nextPrompt, modelMessages }
      })
      let inputs = yield* buildInputs(prefired !== undefined)
      const ctx = yield* InstanceState.context
      const startedAt = Date.now()
      const tokensBefore = (() => {
        for (let i = input.messages.length - 1; i >= 0; i--) {
          const info = input.messages[i].info
          if (info.role !== "assistant" || info.summary) continue
          const total =
            info.tokens.input + info.tokens.output + info.tokens.reasoning + info.tokens.cache.read + info.tokens.cache.write
          if (total > 0) return total
        }
        return undefined
      })()

      const attempt = Effect.fn("SessionCompaction.attempt")(function* (attemptInputs: {
        nextPrompt: string
        modelMessages: Effect.Success<ReturnType<typeof MessageV2.toModelMessagesEffect>>
      }) {
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = yield* processor.process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            ...attemptInputs.modelMessages,
            {
              role: "user",
              content: [{ type: "text", text: attemptInputs.nextPrompt }],
            },
          ],
          model,
        })
        return { processor, result }
      })

      const readSummary = Effect.fn("SessionCompaction.readSummary")(function* (id: MessageID) {
        const found = (yield* session.messages({ sessionID: input.sessionID })).find((item) => item.info.id === id)
        return found ? summaryText(found) : undefined
      })

      const degenerate = (text: string | undefined) =>
        isDegenerateSummary({ text, headCount: selected.head.length, customPrompt: compacting.prompt !== undefined })

      const failAttempt = Effect.fn("SessionCompaction.failAttempt")(function* (
        handle: { message: MessageV2.Assistant },
        message: string,
      ) {
        handle.message.error = { name: "UnknownError", data: { message } }
        handle.message.finish = "error"
        yield* session.updateMessage(handle.message)
      })

      let run = yield* attempt(inputs)
      if (run.result === "continue" && degenerate(yield* readSummary(run.processor.message.id))) {
        log.warn("degenerate summary, retrying", { sessionID: input.sessionID })
        yield* failAttempt(run.processor, "Compaction produced a degenerate summary; retried with a fresh attempt")
        if (prefired) {
          // The cached pass-1 note may be the poison; retry from the full head instead.
          prefireCache.delete(input.sessionID)
          inputs = yield* buildInputs(false)
        }
        run = yield* attempt(inputs)
        if (run.result === "continue" && degenerate(yield* readSummary(run.processor.message.id))) {
          yield* failAttempt(
            run.processor,
            "Compaction produced a degenerate summary twice; automatic compaction is paused for this session until the model changes or a manual compact succeeds",
          )
          suppressed.set(input.sessionID, { modelID: model.id, reason: "degenerate" })
          return "stop"
        }
      }
      const processor = run.processor
      const result = run.result

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        suppressed.set(input.sessionID, { modelID: model.id, reason: "too_large" })
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            // Structural re-anchor: the state below is read from the runtime (todo table,
            // live agent tree), not from the summary, so a sloppy summary cannot strand a
            // running subagent or an open todo list. The recall pointer is always true —
            // the full pre-compaction transcript stays in storage.
            const stateLines = input.liveState ?? []
            const block = [
              "<post-compaction-state>",
              ...(stateLines.length ? ["Live state snapshotted at compaction time:", ...stateLines, ""] : []),
              "The recall tool searches this session's full pre-compaction history, including cleared tool outputs, when the summary above lacks a detail you need.",
              "</post-compaction-state>",
              "",
            ].join("\n")
            const text =
              block +
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        suppressed.delete(input.sessionID)
        prefireCache.delete(input.sessionID)
        const summary = yield* readSummary(processor.message.id)
        EventV2.run(SessionEvent.Compaction.Ended.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          text: summary ?? "",
          include: selected.tail_start_id,
        })
        yield* bus.publish(Event.Compacted, {
          sessionID: input.sessionID,
          trigger: input.auto ? ("auto" as const) : ("manual" as const),
          overflow: input.overflow === true,
          tokensBefore,
          durationMs: Date.now() - startedAt,
          summaryChars: (summary ?? "").length,
          tailStartID: selected.tail_start_id,
        })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      if (!input.auto) suppressed.delete(input.sessionID)
      if (input.auto) {
        const entry = suppression(input.sessionID, input.model.modelID)
        if (entry) {
          log.warn("auto compaction suppressed", { sessionID: input.sessionID, reason: entry.reason })
          return
        }
      }
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      EventV2.run(SessionEvent.Compaction.Started.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        reason: input.auto ? "auto" : "manual",
      })
    })

    return Service.of({
      isOverflow,
      prune,
      prefire,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
