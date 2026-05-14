// Wave 13 backward-compat — synthetic legacy session fixture parses cleanly
// through every MessageV2.Part variant and round-trips through Session.Service
// without information loss. Guards against any wave_*-introduced field that
// would break old-row deserialization.
//
// Fixture lives at ./snapshot/legacy-session.json and is hand-built (see the
// `_comment` field for the why). The loader hydrates the rows via
// SyncEvent.run for sessions (preserves the fixture IDs the way the
// pre-campaign codepath would have written them) and Session.updateMessage /
// updatePart for messages and parts.

import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Bus } from "../../src/bus"
import { InstanceState } from "../../src/effect/instance-state"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
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

// All sessions in the fixture share one project; we remap their directory to
// the per-test tmpdir so the InstanceContext lookup works. Everything else
// (slug, agent, parentID, permission, model, time) is preserved verbatim.
const sessionsByID = new Map(fixture.sessions.map((s) => [s.id, s]))

// The bun:sqlite test DB is shared across `it.instance` calls in a single
// process. Each round-trip test mints a fresh suffix so the same fixture can
// hydrate side by side without colliding on session.id / message.id / part.id
// primary keys. Schema-decode tests use the verbatim fixture IDs.
let suffixCounter = 0
const nextSuffix = () => `_${(suffixCounter += 1).toString(36)}`

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

const hydrate = Effect.fn("legacy-session.test.hydrate")(function* (directory: string) {
  const sync = yield* SyncEvent.Service
  const session = yield* Session.Service
  // The fixture's projectID is a placeholder; remap it to the live test
  // instance's project_id so the SessionTable's FK constraint resolves.
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
    const decoded = Schema.decodeUnknownSync(MessageV2.Info)(remapped) as MessageV2.Info
    yield* session.updateMessage(decoded)
  }

  for (const fp of fixture.parts) {
    const remapped = remap(fp, ["id", "sessionID", "messageID", "tail_start_id"], suffix)
    const decoded = Schema.decodeUnknownSync(MessageV2.Part)(remapped) as MessageV2.Part
    yield* session.updatePart(decoded)
  }

  return suffix
})

describe("schema parsing", () => {
  it.live("Session.Info decodes the legacy root session record", () =>
    Effect.gen(function* () {
      const fs = sessionsByID.get("ses_legacy_root")!
      const info = Schema.decodeUnknownSync(Session.Info)({
        ...fs,
        directory: "/tmp/decode-only",
        permission: fs.permission,
      }) as Session.Info
      expect(info.id).toBe(SessionID.descending("ses_legacy_root"))
      expect(info.parentID).toBeUndefined()
      expect(info.permission).toBeDefined()
      expect(info.permission!.length).toBeGreaterThan(0)
      // Pre-campaign permission keys only — no exec_command / spawn_agent / send_message / etc.
      const keys = info.permission!.map((r) => r.permission)
      for (const banned of [
        "exec_command",
        "write_stdin",
        "spawn_agent",
        "send_message",
        "followup_task",
        "wait_agent",
        "list_agents",
        "close_agent",
      ]) {
        expect(keys).not.toContain(banned)
      }
    }),
  )

  it.live("Session.Info decodes a child session with parentID set and no permission", () =>
    Effect.gen(function* () {
      const fs = sessionsByID.get("ses_legacy_child")!
      const info = Schema.decodeUnknownSync(Session.Info)({
        ...fs,
        directory: "/tmp/decode-only",
      }) as Session.Info
      expect(info.id).toBe(SessionID.descending("ses_legacy_child"))
      expect(info.parentID).toBe(SessionID.descending("ses_legacy_root"))
      expect(info.permission).toBeUndefined()
    }),
  )

  it.live("MessageV2.Info decodes user and assistant messages", () =>
    Effect.gen(function* () {
      for (const fm of fixture.messages) {
        const info = Schema.decodeUnknownSync(MessageV2.Info)(fm) as MessageV2.Info
        expect(info.role).toBe(fm.role)
        expect(info.id).toBe(MessageID.ascending(fm.id))
      }
    }),
  )

  // Every variant the campaign promised to keep stable in BACKWARD_COMPAT.md.
  // If a future wave adds a required field to any variant, this loop catches
  // it (the fixture won't have the field; decode throws).
  const expectedVariants = [
    "text",
    "subtask",
    "reasoning",
    "file",
    "tool",
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "compaction",
  ] as const

  for (const variant of expectedVariants) {
    it.live(`MessageV2.Part decodes the legacy ${variant} variant`, () =>
      Effect.gen(function* () {
        const part = fixture.parts.find((p) => p.type === variant)
        expect(part).toBeDefined()
        const decoded = Schema.decodeUnknownSync(MessageV2.Part)(part!) as MessageV2.Part
        expect(decoded.type).toBe(variant)
      }),
    )
  }

  it.live("legacy SubtaskPart parses without the wave-9 protocol marker", () =>
    Effect.gen(function* () {
      const part = fixture.parts.find((p): p is FixturePart & { type: "subtask" } => p.type === "subtask")!
      expect("protocol" in part).toBe(false)
      const decoded = Schema.decodeUnknownSync(MessageV2.Part)(part) as MessageV2.SubtaskPart
      expect(decoded.protocol).toBeUndefined()
    }),
  )

  it.live("every fixture part appears in the discriminated union", () =>
    Effect.gen(function* () {
      const seen = new Set(fixture.parts.map((p) => p.type as (typeof expectedVariants)[number]))
      for (const variant of expectedVariants) expect(seen.has(variant)).toBe(true)
    }),
  )
})

describe("session loading round-trip", () => {
  it.instance("Session.get returns each hydrated row matching the fixture", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const suffix = yield* hydrate(ti.directory)
      const session = yield* Session.Service

      const root = yield* session.get(
        SessionID.descending(remapID("ses_legacy_root", suffix)),
      )
      expect(root.id).toBe(SessionID.descending(remapID("ses_legacy_root", suffix)))
      expect(root.title).toBe("Legacy root session (no parent)")
      expect(root.agent).toBe("build")
      expect(root.parentID).toBeUndefined()
      expect(root.permission).toBeDefined()
      expect(root.directory).toBe(ti.directory)

      const child = yield* session.get(
        SessionID.descending(remapID("ses_legacy_child", suffix)),
      )
      expect(child.parentID).toBe(SessionID.descending(remapID("ses_legacy_root", suffix)))
      expect(child.permission).toBeUndefined()
    }),
  )

  it.instance("Session.children returns the child session under its root", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const suffix = yield* hydrate(ti.directory)
      const session = yield* Session.Service
      const kids = yield* session.children(
        SessionID.descending(remapID("ses_legacy_root", suffix)),
      )
      expect(kids.map((k) => k.id)).toEqual([SessionID.descending(remapID("ses_legacy_child", suffix))])
    }),
  )

  it.instance("Session.messages returns every message + part, ordered by id", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const suffix = yield* hydrate(ti.directory)
      const session = yield* Session.Service

      const messages = yield* session.messages({
        sessionID: SessionID.descending(remapID("ses_legacy_root", suffix)),
      })
      const ids = messages.map((m) => m.info.id)
      expect(ids).toEqual([
        MessageID.ascending(remapID("msg_user_1", suffix)),
        MessageID.ascending(remapID("msg_assistant_1", suffix)),
        MessageID.ascending(remapID("msg_assistant_compaction", suffix)),
      ])

      const assistantTurn = messages.find(
        (m) => m.info.id === MessageID.ascending(remapID("msg_assistant_1", suffix)),
      )!
      const partTypes = assistantTurn.parts.map((p) => p.type).sort()
      // Every variant the assistant turn carries — sorted so the assertion is
      // order-stable independent of insert order.
      expect(partTypes).toEqual(
        (
          [
            "agent",
            "file",
            "patch",
            "reasoning",
            "retry",
            "snapshot",
            "step-finish",
            "step-start",
            "subtask",
            "text",
            "tool",
            "tool",
            "tool",
            "tool",
            "tool",
          ] as MessageV2.Part["type"][]
        ).sort(),
      )

      const compactionMsg = messages.find(
        (m) => m.info.id === MessageID.ascending(remapID("msg_assistant_compaction", suffix)),
      )!
      expect(compactionMsg.parts).toHaveLength(1)
      const compactionPart = compactionMsg.parts[0] as MessageV2.CompactionPart
      expect(compactionPart.type).toBe("compaction")
      expect(compactionPart.tail_start_id).toBe(MessageID.ascending(remapID("msg_assistant_1", suffix)))
    }),
  )

  it.instance("legacy SubtaskPart round-trips without a protocol field", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const suffix = yield* hydrate(ti.directory)
      const session = yield* Session.Service
      const messages = yield* session.messages({
        sessionID: SessionID.descending(remapID("ses_legacy_root", suffix)),
      })
      const subtask = messages
        .flatMap((m) => m.parts)
        .find((p): p is MessageV2.SubtaskPart => p.type === "subtask")!
      expect(subtask.protocol).toBeUndefined()
      expect(subtask.agent).toBe("explore")
      expect(subtask.description).toBe("Find auth tests")
    }),
  )

  it.instance("hydrating the child session preserves its parent linkage end-to-end", () =>
    Effect.gen(function* () {
      const ti = yield* TestInstance
      const suffix = yield* hydrate(ti.directory)
      const session = yield* Session.Service
      const childMessages = yield* session.messages({
        sessionID: SessionID.descending(remapID("ses_legacy_child", suffix)),
      })
      expect(childMessages.map((m) => m.info.id)).toEqual([MessageID.ascending(remapID("msg_user_child", suffix))])
      expect(childMessages[0].parts[0].type).toBe("text")
    }),
  )
})
