// Wave 13 backward-compat — the desktop / electron Pty consumers (HTTP +
// WebSocket) hit the same shapes the campaign inherited. The wave-2 addition
// of the optional `origin: "tui" | "model"` field to Pty.Info / Pty.CreateInput
// must remain INVISIBLE to legacy callers that never send it.
//
// The existing `test/server/httpapi-pty.test.ts` exercises the route surface
// end-to-end against a real PTY. This file pins down the schema-level
// guarantees that legacy serialized payloads (without `origin`) decode and
// re-encode cleanly.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Pty } from "../../src/pty"
import { PtyID } from "../../src/pty/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(Pty.defaultLayer, CrossSpawnSpawner.defaultLayer))

const decodeInfo = Schema.decodeUnknownSync(Pty.Info)
const decodeCreate = Schema.decodeUnknownSync(Pty.CreateInput)
const decodeUpdate = Schema.decodeUnknownSync(Pty.UpdateInput)

const legacyPtyJson = {
  id: "pty_legacy_term_1",
  title: "bash",
  command: "/bin/bash",
  args: [],
  cwd: "/legacy/dir",
  status: "running" as const,
  pid: 12345,
  // origin omitted — pre-wave-2 desktop snapshots never had this field
}

describe("Pty.Info schema backward compatibility", () => {
  it.live("decodes a legacy PTY snapshot that omits the origin field", () =>
    Effect.gen(function* () {
      const info = decodeInfo(legacyPtyJson)
      expect(info.id).toBe(PtyID.ascending("pty_legacy_term_1"))
      expect(info.title).toBe("bash")
      expect(info.command).toBe("/bin/bash")
      expect(info.cwd).toBe("/legacy/dir")
      expect(info.status).toBe("running")
      expect(info.origin).toBeUndefined()
    }),
  )

  it.live("decodes a snapshot that explicitly sets origin to either value", () =>
    Effect.gen(function* () {
      const tui = decodeInfo({ ...legacyPtyJson, origin: "tui" })
      const model = decodeInfo({ ...legacyPtyJson, origin: "model" })
      expect(tui.origin).toBe("tui")
      expect(model.origin).toBe("model")
    }),
  )

  it.live("rejects an unknown origin value", () =>
    Effect.gen(function* () {
      expect(() => decodeInfo({ ...legacyPtyJson, origin: "wat" })).toThrow()
    }),
  )

  it.live("rejects a non-positive pid", () =>
    Effect.gen(function* () {
      expect(() => decodeInfo({ ...legacyPtyJson, pid: 0 })).toThrow()
    }),
  )
})

describe("Pty.CreateInput / Pty.UpdateInput schemas backward compatibility", () => {
  it.live("CreateInput accepts the legacy shape (no origin)", () =>
    Effect.gen(function* () {
      const create = decodeCreate({
        command: "/usr/bin/env",
        args: ["sh", "-c", "echo hi"],
        cwd: "/legacy/dir",
        title: "demo",
        env: { FOO: "bar" },
      })
      expect(create.command).toBe("/usr/bin/env")
      expect(create.args).toEqual(["sh", "-c", "echo hi"])
      expect(create.title).toBe("demo")
      expect(create.env).toEqual({ FOO: "bar" })
      expect(create.origin).toBeUndefined()
    }),
  )

  it.live("CreateInput accepts an empty object (every field optional)", () =>
    Effect.gen(function* () {
      const empty = decodeCreate({})
      expect(empty.command).toBeUndefined()
      expect(empty.args).toBeUndefined()
      expect(empty.cwd).toBeUndefined()
      expect(empty.env).toBeUndefined()
      expect(empty.origin).toBeUndefined()
    }),
  )

  it.live("UpdateInput accepts the legacy shape (title + size, no extra keys)", () =>
    Effect.gen(function* () {
      const update = decodeUpdate({ title: "renamed", size: { rows: 24, cols: 80 } })
      expect(update.title).toBe("renamed")
      expect(update.size).toEqual({ rows: 24, cols: 80 })
    }),
  )

  it.live("UpdateInput rejects rows/cols below 1 (PositiveInt floor)", () =>
    Effect.gen(function* () {
      expect(() => decodeUpdate({ size: { rows: 0, cols: 80 } })).toThrow()
      expect(() => decodeUpdate({ size: { rows: 24, cols: 0 } })).toThrow()
    }),
  )
})

describe("Pty.Event schemas — legacy payloads unchanged", () => {
  it.live("Created event payload accepts a legacy Pty.Info (no origin)", () =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownSync(Pty.Event.Created.properties)({ info: legacyPtyJson })
      expect(decoded.info.id).toBe(PtyID.ascending("pty_legacy_term_1"))
      expect(decoded.info.origin).toBeUndefined()
    }),
  )

  it.live("Exited event payload preserves { id, exitCode }", () =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownSync(Pty.Event.Exited.properties)({
        id: PtyID.ascending("pty_x"),
        exitCode: 0,
      })
      expect(decoded.id).toBe(PtyID.ascending("pty_x"))
      expect(decoded.exitCode).toBe(0)
    }),
  )

  it.live("Deleted event payload preserves { id }", () =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownSync(Pty.Event.Deleted.properties)({ id: PtyID.ascending("pty_y") })
      expect(decoded.id).toBe(PtyID.ascending("pty_y"))
    }),
  )
})

describe("Pty.Service contract preserved for legacy callers", () => {
  it.live("list / get / create / remove still work for an origin-less spawn", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        if (process.platform === "win32") return // PTY is not supported on win32 in this test path
        const pty = yield* Pty.Service
        const initial = yield* pty.list()
        expect(initial).toEqual([])

        const info = yield* pty.create({
          command: "/usr/bin/env",
          args: ["sh", "-c", "sleep 5"],
          title: "legacy",
        })
        // Legacy callers never set `origin`. The service defaults the missing
        // value to "tui" (per wave-2's pty-onexit-auto-remove-tui-only fix).
        expect(info.origin).toBe("tui")
        expect(info.title).toBe("legacy")
        expect(info.command).toBe("/usr/bin/env")
        expect(info.status).toBe("running")

        const fetched = yield* pty.get(info.id)
        expect(fetched?.id).toBe(info.id)
        expect(fetched?.origin).toBe("tui")

        const listed = yield* pty.list()
        expect(listed.map((p) => p.id)).toEqual([info.id])

        yield* pty.remove(info.id)
        const after = yield* pty.list()
        expect(after).toEqual([])
      }),
    ),
  )
})
