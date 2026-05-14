// Wave 13 backward-compat — replaying a legacy session through Session.Service
// must NOT emit any post-campaign event types (agent.* lifecycle, step.*,
// shell.*, etc.). Subscribers wired to the wave-10 EventV2 / Bus event
// surface for new event types should see zero traffic during pure
// session-load activity. If a wave-N regression spuriously fires an agent
// event from inside a projector or a session getter, this test catches it.
//
// We exercise only the legacy data flow: hydrate a session via
// `Session.updateMessage` / `Session.updatePart`. No prompt loop, no
// AgentControl, no PTY. Then we assert the subscribed-to event categories
// stay empty.

import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Bus } from "../../src/bus"
import { InstanceState } from "../../src/effect/instance-state"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session/session"
import { SyncEvent } from "../../src/sync"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import legacy from "./snapshot/legacy-session.json"

interface FixtureSession {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  agent?: string
  parentID?: string
  model?: { id: string; providerID: string; variant?: string }
  time: { created: number; updated: number }
  permission?: unknown
}

interface FixtureMessage {
  id: string
  sessionID: string
  role: "user" | "assistant"
  agent: string
  [key: string]: unknown
}

interface FixturePart {
  id: string
  sessionID: string
  messageID: string
  type: string
  [key: string]: unknown
}

interface Fixture {
  sessions: FixtureSession[]
  messages: FixtureMessage[]
  parts: FixturePart[]
}

const fixture = legacy as unknown as Fixture

let suffixCounter = 0
const nextSuffix = () => `_replay_${(suffixCounter += 1).toString(36)}`

function remapID(id: string, suffix: string) {
  return `${id}${suffix}`
}

function remap<T>(record: T, fields: (keyof T & string)[], suffix: string): T {
  const out = { ...record } as Record<string, unknown>
  for (const key of fields) {
    const value = out[key]
    if (typeof value === "string") {
      out[key] = remapID(value, suffix)
    }
  }
  return out as T
}

const it = testEffect(
  Layer.mergeAll(Session.defaultLayer, Bus.layer, SyncEvent.layer.pipe(Layer.provide(Bus.layer))),
)

const hydrate = Effect.fn("event-replay.test.hydrate")(function* (directory: string) {
  const sync = yield* SyncEvent.Service
  const session = yield* Session.Service
  const ctx = yield* InstanceState.context
  const suffix = nextSuffix()

  for (const fs of fixture.sessions) {
    const remapped = remap(fs, ["id", "parentID"], suffix)
    const decoded = Schema.decodeUnknownSync(Session.Info)({
      ...remapped,
      directory,
      projectID: ctx.project.id,
      ...(fs.permission ? { permission: fs.permission as Permission.Ruleset } : {}),
    }) as Session.Info
    yield* sync.run(Session.Event.Created, { sessionID: decoded.id, info: decoded })
  }

  for (const fm of fixture.messages) {
    const remapped = remap(fm, ["id", "sessionID", "parentID"], suffix)
    yield* session.updateMessage(Schema.decodeUnknownSync(MessageV2.Info)(remapped) as MessageV2.Info)
  }

  for (const fp of fixture.parts) {
    const remapped = remap(fp, ["id", "sessionID", "messageID", "tail_start_id"], suffix)
    yield* session.updatePart(Schema.decodeUnknownSync(MessageV2.Part)(remapped) as MessageV2.Part)
  }
})

// Bus event types added by waves 10 / 11 / 12 — these must NOT fire during
// legacy hydration (the legacy data flow has no agent lifecycle, no PTY,
// no step events).
const POST_CAMPAIGN_EVENT_PREFIXES = [
  "agent.spawn.",
  "agent.closed",
  "agent.wait.",
  "agent.message.",
  "session.next.agent.spawn.",
  "session.next.agent.closed",
  "session.next.agent.wait.",
  "session.next.agent.message.",
  "session.next.shell.",
  "session.next.step.",
  "session.next.tool.",
  "session.next.text.",
  "session.next.reasoning.",
  "session.next.compaction.",
  "pty.",
] as const

describe("legacy session replay does not emit post-campaign event types", () => {
  it.instance("subscribing to all bus events during hydration yields no agent / step / shell / pty events", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const seen: { type: string; properties: unknown }[] = []
      // SyncEvent.run publishes via the top-level `ProjectBus.publish`
      // helper (sync/index.ts:311), which lives on a different runtime
      // from the testEffect Bus.Service. The wave-3 GOTCHA
      // [bus-subscribe-helper-vs-service-method-cross-runtime-mismatch]
      // applies in reverse here: subscribe through the top-level helper
      // to match the publisher's runtime.
      const off = Bus.subscribeAll((event) => {
        seen.push({ type: (event as { type: string }).type, properties: event })
      })
      // Brief settle so the subscription attaches before publishes start.
      yield* Effect.sleep(20)
      yield* hydrate(ti.directory)
      yield* Effect.sleep(50)
      off()

      const banned = seen.filter((evt) =>
        POST_CAMPAIGN_EVENT_PREFIXES.some((prefix) => evt.type.startsWith(prefix)),
      )
      expect(banned).toEqual([])
    }),
  )

  it.instance("legacy hydration only emits the four legacy event types we expect", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const seen: string[] = []
      const off = Bus.subscribeAll((event) => {
        seen.push((event as { type: string }).type)
      })
      yield* Effect.sleep(20)
      yield* hydrate(ti.directory)
      yield* Effect.sleep(50)
      off()

      // The legacy hydration codepath emits four event types only:
      //   - session.created (per session in fixture)
      //   - session.updated (per session, conditional on workspaces flag)
      //   - message.updated (per message in fixture)
      //   - message.part.updated (per part in fixture)
      const allowed = new Set(["session.created", "session.updated", "message.updated", "message.part.updated"])
      const unexpected = seen.filter((t) => !allowed.has(t))
      expect(unexpected).toEqual([])

      // Sanity check: the expected events DID fire. If the bus stayed
      // empty entirely we'd be asserting a vacuous truth.
      expect(seen.filter((t) => t === "session.created")).toHaveLength(fixture.sessions.length)
      expect(seen.filter((t) => t === "message.updated")).toHaveLength(fixture.messages.length)
      expect(seen.filter((t) => t === "message.part.updated")).toHaveLength(fixture.parts.length)
    }),
  )
})

describe("subscribing to a specific post-campaign event during legacy replay sees nothing", () => {
  // Spot check on the highest-traffic post-campaign event types: the
  // agent.* family (added in wave 10). A typed Bus.subscribe to any of
  // these against the legacy data flow should yield zero events.
  for (const eventName of ["agent.spawn.started", "agent.closed", "agent.message.sent"] as const) {
    it.instance(`Bus.subscribe(${eventName}) sees no events during legacy hydration`, () =>
      Effect.gen(function* () {
        const ti = yield* TestInstance
        const collected: unknown[] = []
        // Construct a minimal Definition to subscribe with — we don't need
        // the full schema for receive-only assertion. Bus keys typed
        // PubSubs by `def.type`; any def with the matching type gets the
        // events.
        const def = { type: eventName, properties: Schema.Unknown } as unknown as Parameters<typeof Bus.subscribe>[0]
        const off = Bus.subscribe(def, (evt) => {
          collected.push(evt)
        })
        yield* Effect.sleep(20)
        yield* hydrate(ti.directory)
        yield* Effect.sleep(100)
        off()
        expect(collected).toEqual([])
      }),
    )
  }
})
