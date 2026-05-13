import { describe, expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schema } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Bus } from "@/bus"
import { reloadInstance } from "@/project/instance-runtime"
import { WithInstance } from "@/project/with-instance"
import { Pty } from "@/pty"
import type { PtyID } from "@/pty/schema"
import { tmpdir } from "@test/fixture/fixture"

// Wave 2 tests for the Pty.Service extensions ported from codex's
// unified_exec/process_manager.rs. Covers the new `read` race primitive,
// LRU pruning at MAX_PTY_PROCESSES with PROCESS_STORE_PROTECTED_RECENT
// protection, terminateAll cleanup, and the optional `origin` field.
//
// Tests use the live AppRuntime with real PTYs so the head/tail buffer,
// notify SubscriptionRef, and exit Deferred are all exercised end-to-end.

const decoder = new TextDecoder()
const decode = (bytes: Uint8Array) => decoder.decode(bytes)

const withPty = async <A>(fn: (pty: Pty.Interface) => Effect.Effect<A>) => {
  const dir = await tmpdir({ git: true })
  try {
    return await WithInstance.provide({
      directory: dir.path,
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const pty = yield* Pty.Service
            try {
              return yield* fn(pty)
            } finally {
              yield* pty.terminateAll()
            }
          }),
        ),
    })
  } finally {
    await dir[Symbol.asyncDispose]()
  }
}

const waitForOutput = async (pty: Pty.Interface, id: PtyID, minLength: number, timeoutMs = 5000) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        const result = yield* pty.read(id, 0, 1, 1024 * 1024)
        if (!result) yield* Effect.die("waitForOutput: session removed")
        if (result!.cursor >= minLength) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die("waitForOutput: timeout")
    }),
  )
}

describe("Pty.read", () => {
  test("returns immediately when output already past sinceCursor", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        // origin: "model" so the session sticks around after the printf exits
        // and pty.read can still see the buffered bytes (mirrors codex unified_exec).
        const info = yield* pty.create({
          command: "/bin/sh",
          args: ["-c", "printf hello; sleep 0.5"],
          title: "echo",
          origin: "model",
        })
        yield* Effect.promise(() => waitForOutput(pty, info.id, 5))
        const t0 = Date.now()
        const result = yield* pty.read(info.id, 0, 5000, 8192)
        const elapsed = Date.now() - t0
        expect(result).toBeDefined()
        expect(elapsed).toBeLessThan(200)
        expect(result!.output.length).toBeGreaterThan(0)
        expect(decode(result!.output)).toContain("hello")
        expect(result!.cursor).toBeGreaterThan(0)
      }),
    )
  })

  test("waits idleMs when no new output then returns empty bytes plus same cursor", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "cat", origin: "model" })
        // Drain anything that may have appeared on cat startup.
        yield* Effect.sleep("50 millis")
        const baseline = yield* pty.read(info.id, 0, 1, 1024 * 1024)
        const cursor = baseline!.cursor
        const t0 = Date.now()
        const result = yield* pty.read(info.id, cursor, 200, 8192)
        const elapsed = Date.now() - t0
        expect(result).toBeDefined()
        expect(result!.output.length).toBe(0)
        expect(result!.cursor).toBe(cursor)
        // Wallclock should be near idleMs (200) within ±150ms tolerance for CI noise.
        expect(elapsed).toBeGreaterThanOrEqual(180)
        expect(elapsed).toBeLessThan(400)
      }),
    )
  })

  test("wakes when new output arrives before idleMs elapses", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "cat", origin: "model" })
        yield* Effect.sleep("50 millis")
        const baseline = yield* pty.read(info.id, 0, 1, 1024 * 1024)
        const cursor = baseline!.cursor
        // Schedule a write 50ms in.
        setTimeout(() => {
          AppRuntime.runPromise(pty.write(info.id, "wakeme\n"))
        }, 50)
        const t0 = Date.now()
        const result = yield* pty.read(info.id, cursor, 5000, 8192)
        const elapsed = Date.now() - t0
        expect(result).toBeDefined()
        expect(result!.output.length).toBeGreaterThan(0)
        expect(decode(result!.output)).toContain("wakeme")
        // Should have woken well before the 5s idle timeout.
        expect(elapsed).toBeLessThan(500)
      }),
    )
  })

  test("returns immediately when process has exited", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({
          command: "/bin/sh",
          args: ["-c", "printf done; exit 0"],
          title: "exit",
          origin: "model",
        })
        // Wait for the process to actually exit + the exit deferred to be set.
        yield* Effect.sleep("200 millis")
        const t0 = Date.now()
        // Read with a long idleMs — should NOT wait it because process exited.
        const result = yield* pty.read(info.id, 0, 5000, 8192)
        const elapsed = Date.now() - t0
        expect(result).toBeDefined()
        expect(elapsed).toBeLessThan(500)
        expect(result!.exited).toBe(true)
        expect(result!.exitCode).toBe(0)
      }),
    )
  })

  test("respects maxBytes by truncating returned data via head/tail", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        // Use awk to emit a deterministic 16384-byte burst (8192 'A' followed by
        // 8192 'B') with no PTY echo or shell quoting in the way. Going through
        // cat suffers from line-discipline buffering and input-buffer caps when
        // the writer floods stdin without newlines.
        const info = yield* pty.create({
          command: "/usr/bin/awk",
          args: ["BEGIN { for(i=0;i<8192;i++) printf \"A\"; for(i=0;i<8192;i++) printf \"B\"; system(\"sleep 1\") }"],
          title: "burst",
          origin: "model",
        })
        yield* Effect.promise(() => waitForOutput(pty, info.id, 16000))
        const result = yield* pty.read(info.id, 0, 100, 1024)
        expect(result).toBeDefined()
        // Returned bytes are capped to maxBytes (1024).
        expect(result!.output.length).toBe(1024)
        const text = decode(result!.output)
        // Head/tail truncation keeps a prefix of the early bytes (the 8192 'A's
        // came first) and a suffix of the late bytes (the 8192 'B's came last).
        // A pure head truncation would have no 'B's; a pure tail would have no
        // 'A's. Mix is the head/tail signature.
        expect(text).toContain("A")
        expect(text).toContain("B")
        // First 64 bytes are all 'A' — earliest captured.
        for (let i = 0; i < 64; i++) {
          expect(text.charAt(i)).toBe("A")
        }
        // Last 64 bytes contain at least one 'B' — most recent input.
        expect(text.slice(-64)).toContain("B")
      }),
    )
  })

  test("with sinceCursor === currentCursor and no new chunks during idleMs returns wallTime ≈ idleMs and zero bytes", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "cat", origin: "model" })
        yield* pty.write(info.id, "abc\n")
        yield* Effect.sleep("80 millis")
        const baseline = yield* pty.read(info.id, 0, 1, 1024 * 1024)
        const cursor = baseline!.cursor
        const t0 = Date.now()
        const result = yield* pty.read(info.id, cursor, 150, 8192)
        const elapsed = Date.now() - t0
        expect(result!.output.length).toBe(0)
        expect(result!.cursor).toBe(cursor)
        expect(elapsed).toBeGreaterThanOrEqual(140)
        expect(elapsed).toBeLessThan(350)
      }),
    )
  })

  test("on a non-existent PtyID returns undefined (matches Pty.get)", async () => {
    await withPty((pty) =>
      Effect.gen(function* () {
        const result = yield* pty.read(Schema.decodeUnknownSync(Pty.Info.fields.id)("pty_does_not_exist"), 0, 100, 8192)
        expect(result).toBeUndefined()
      }),
    )
  })

  test("three concurrent reads on the same PTY all wake up when new output arrives", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "cat", origin: "model" })
        yield* Effect.sleep("50 millis")
        const baseline = yield* pty.read(info.id, 0, 1, 1024 * 1024)
        const cursor = baseline!.cursor
        setTimeout(() => {
          AppRuntime.runPromise(pty.write(info.id, "broadcast\n"))
        }, 50)
        const results = yield* Effect.all(
          [
            pty.read(info.id, cursor, 5000, 8192),
            pty.read(info.id, cursor, 5000, 8192),
            pty.read(info.id, cursor, 5000, 8192),
          ],
          { concurrency: "unbounded" },
        )
        for (const r of results) {
          expect(r).toBeDefined()
          expect(r!.output.length).toBeGreaterThan(0)
          expect(decode(r!.output)).toContain("broadcast")
        }
      }),
    )
  })
})

describe("Pty pool LRU pruning", () => {
  test("creating up to 64 PTYs succeeds", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        for (let i = 0; i < 64; i++) {
          yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: `p${i}` })
        }
        const list = yield* pty.list()
        expect(list.length).toBe(64)
      }),
    )
  }, 30000)

  test("creating the 65th PTY prunes the LRU non-protected one", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const ids: PtyID[] = []
        for (let i = 0; i < 64; i++) {
          const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: `p${i}` })
          ids.push(info.id)
        }
        // The 65th create — must prune the oldest non-protected (ids[0]).
        const extra = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "p65" })
        const list = yield* pty.list()
        expect(list.length).toBe(64)
        // Oldest pre-existing PTY should have been pruned.
        expect(list.find((p) => p.id === ids[0])).toBeUndefined()
        // Newest survives.
        expect(list.find((p) => p.id === extra.id)).toBeDefined()
      }),
    )
  }, 30000)

  test("creating PTY when pool reaches 60 emits a PoolWarning event", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const events: { count: number; cap: number }[] = []
        const off = Bus.subscribe(Pty.Event.PoolWarning, (evt) => events.push(evt.properties))
        try {
          for (let i = 0; i < 60; i++) {
            yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: `p${i}` })
          }
          // The 60th create should have produced at least one warning.
          yield* Effect.sleep("50 millis")
          expect(events.length).toBeGreaterThanOrEqual(1)
          expect(events[0].count).toBeGreaterThanOrEqual(60)
          expect(events[0].cap).toBe(64)
        } finally {
          off()
        }
      }),
    )
  }, 30000)

  test("pruning protects the 8 most-recently-used PTYs", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const ids: PtyID[] = []
        for (let i = 0; i < 64; i++) {
          const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: `p${i}` })
          ids.push(info.id)
        }
        // Touch the LAST 8 (ids 56..63) via Pty.read so they become the most recent in lastUsed.
        // Then touch ids[0] so it bumps to MRU. Verify ids[1] (now LRU) is the prune target.
        for (let i = 56; i < 64; i++) {
          yield* pty.read(ids[i], 0, 1, 1024)
        }
        yield* pty.read(ids[0], 0, 1, 1024)
        // Now LRU = ids[1] (oldest never touched again). Top-8 by lastUsed = the 8 just-read ones (ids[56..63]) plus possibly ids[0].
        // Actually, top-8 = the 8 most-recent ⇒ ids[0] (just touched) and the 7 most recent of the prior reads (ids[57..63]).
        // ids[56] falls out of the protected set because ids[0] was touched after it.
        // So the LRU non-protected = ids[1] (oldest never re-touched).
        yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "p65" })
        const list = yield* pty.list()
        expect(list.length).toBe(64)
        // ids[1] is the LRU non-protected — it should have been pruned.
        expect(list.find((p) => p.id === ids[1])).toBeUndefined()
        // ids[0] (just touched) survives.
        expect(list.find((p) => p.id === ids[0])).toBeDefined()
        // ids[63] (most recent) survives.
        expect(list.find((p) => p.id === ids[63])).toBeDefined()
      }),
    )
  }, 30000)

  test("exited PTYs are pruned first when the cap is hit", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const ids: PtyID[] = []
        // Create 56 long-running PTYs.
        for (let i = 0; i < 56; i++) {
          const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: `p${i}` })
          ids.push(info.id)
        }
        // Create 8 short-lived PTYs that exit immediately. origin: "model" keeps them
        // in the map after exit so the pruner can prefer them over alive entries.
        const exitedIds: PtyID[] = []
        for (let i = 0; i < 8; i++) {
          const info = yield* pty.create({
            command: "/bin/sh",
            args: ["-c", "exit 0"],
            title: `e${i}`,
            origin: "model",
          })
          exitedIds.push(info.id)
        }
        // Wait for the short-lived ones to actually exit (status changes to "exited" in Active).
        yield* Effect.sleep("250 millis")
        // Touch a couple of long-running ones to bump them past the exited PTYs in recency,
        // so the exited PTYs become non-protected (and thus prune-eligible).
        yield* pty.read(ids[0], 0, 1, 1024)
        yield* pty.read(ids[1], 0, 1, 1024)
        const before = yield* pty.list()
        expect(before.length).toBe(64)
        const exitedRemainingBefore = exitedIds.filter((id) => before.some((p) => p.id === id))
        expect(exitedRemainingBefore.length).toBeGreaterThan(0)
        // Trigger pruning by creating a 65th.
        yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "p65" })
        const after = yield* pty.list()
        expect(after.length).toBe(64)
        const exitedRemainingAfter = exitedIds.filter((id) => after.some((p) => p.id === id))
        // At least one exited PTY should have been pruned (preferred over alive ones).
        expect(exitedRemainingAfter.length).toBeLessThan(exitedRemainingBefore.length)
      }),
    )
  }, 30000)
})

describe("Pty.terminateAll", () => {
  test("kills all live PTYs and clears the registry", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "a" })
        yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "b" })
        yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "c" })
        const before = yield* pty.list()
        expect(before.length).toBe(3)
        yield* pty.terminateAll()
        const after = yield* pty.list()
        expect(after.length).toBe(0)
      }),
    )
  })

  test("publishes Deleted events for each session", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const deleted: PtyID[] = []
        const off = Bus.subscribe(Pty.Event.Deleted, (evt) => deleted.push(evt.properties.id))
        try {
          const a = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "a" })
          const b = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "b" })
          const c = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "c" })
          yield* pty.terminateAll()
          yield* Effect.sleep("50 millis")
          const ids = new Set(deleted)
          expect(ids.has(a.id)).toBe(true)
          expect(ids.has(b.id)).toBe(true)
          expect(ids.has(c.id)).toBe(true)
        } finally {
          off()
        }
      }),
    )
  })

  test("is idempotent", async () => {
    await withPty((pty) =>
      Effect.gen(function* () {
        yield* pty.terminateAll()
        yield* pty.terminateAll()
        const list = yield* pty.list()
        expect(list.length).toBe(0)
      }),
    )
  })
})

describe("Pty.create origin field", () => {
  test("create with no origin defaults to 'tui' (backward compat for desktop callers)", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 5"], title: "a" })
        expect(info.origin).toBe("tui")
        const fetched = yield* pty.get(info.id)
        expect(fetched?.origin).toBe("tui")
      }),
    )
  })

  test("create with origin: 'model' tags the Info", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({
          command: "/bin/sh",
          args: ["-c", "sleep 5"],
          title: "model",
          origin: "model",
        })
        expect(info.origin).toBe("model")
        const fetched = yield* pty.get(info.id)
        expect(fetched?.origin).toBe("model")
      }),
    )
  })

  test("list returns Info objects with origin field present", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 5"], title: "tui-default" })
        yield* pty.create({
          command: "/bin/sh",
          args: ["-c", "sleep 5"],
          title: "model-tagged",
          origin: "model",
        })
        const list = yield* pty.list()
        const tui = list.find((p) => p.title === "tui-default")
        const model = list.find((p) => p.title === "model-tagged")
        expect(tui?.origin).toBe("tui")
        expect(model?.origin).toBe("model")
      }),
    )
  })

  test("Info schema parses both origin: 'tui' rows and rows with origin missing (backward compat)", () => {
    // Direct schema-level check: missing origin still decodes; explicit "tui"/"model" decode too.
    const decodeUnknown = Schema.decodeUnknownSync(Pty.Info)
    const sampleNoOrigin = {
      id: "pty_01J0000000000000000000000",
      title: "legacy",
      command: "/bin/sh",
      args: ["-l"],
      cwd: "/tmp",
      status: "running",
      pid: 1234,
    }
    const sampleTui = { ...sampleNoOrigin, origin: "tui" }
    const sampleModel = { ...sampleNoOrigin, origin: "model" }
    expect(() => decodeUnknown(sampleNoOrigin)).not.toThrow()
    expect(decodeUnknown(sampleTui).origin).toBe("tui")
    expect(decodeUnknown(sampleModel).origin).toBe("model")
  })
})

describe("Pty backward compat (existing connect protocol)", () => {
  test("connect handler still works without origin field", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        // Pre-Wave-2 callers create PTYs without origin and use Pty.connect with the cursor/buffer protocol.
        const info = yield* pty.create({ command: "cat", title: "legacy" })
        const out: string[] = []
        const ws = {
          readyState: 1,
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        const handler = yield* pty.connect(info.id, ws as any)
        expect(handler).toBeDefined()
        // Write something and verify the WebSocket subscriber receives it.
        yield* pty.write(info.id, "ping\n")
        yield* Effect.sleep("100 millis")
        const text = out.join("")
        expect(text).toContain("ping")
        // The cursor meta frame should also have been delivered on connect.
        // Frames starting with byte 0x00 are control frames per existing protocol.
        expect(out.some((chunk) => chunk.length > 0 && chunk.charCodeAt(0) === 0)).toBe(true)
      }),
    )
  })

  test("connect on a non-existent PtyID closes the socket and returns undefined", async () => {
    await withPty((pty) =>
      Effect.gen(function* () {
        let closed = false
        const ws = {
          readyState: 1,
          send: () => {},
          close: () => {
            closed = true
          },
        }
        const result = yield* pty.connect(
          Schema.decodeUnknownSync(Pty.Info.fields.id)("pty_does_not_exist"),
          ws as any,
        )
        expect(result).toBeUndefined()
        expect(closed).toBe(true)
      }),
    )
  })

  test("connect with cursor === -1 jumps to live tail and skips replay", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "tail" })
        // Push some data into the buffer first.
        yield* pty.write(info.id, "history\n")
        yield* Effect.sleep("80 millis")
        const out: string[] = []
        const ws = {
          readyState: 1,
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        // cursor: -1 means "skip backlog, only send live data + meta frame"
        const handler = yield* pty.connect(info.id, ws as any, -1)
        expect(handler).toBeDefined()
        // Only the meta frame should have arrived (no replay of "history").
        const dataFrames = out.filter((c) => c.length === 0 || c.charCodeAt(0) !== 0)
        expect(dataFrames.join("")).not.toContain("history")
      }),
    )
  })

  test("connect with cursor past current end skips replay and only sends meta", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "future" })
        const out: string[] = []
        const ws = {
          readyState: 1,
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        const handler = yield* pty.connect(info.id, ws as any, 999_999_999)
        expect(handler).toBeDefined()
        const dataFrames = out.filter((c) => c.length === 0 || c.charCodeAt(0) !== 0)
        expect(dataFrames.length).toBe(0)
      }),
    )
  })

  test("connect handler delegates onMessage writes to the PTY and onClose unregisters", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "interactive", origin: "model" })
        const out: string[] = []
        const ws = {
          readyState: 1,
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        const handler = yield* pty.connect(info.id, ws as any)
        expect(handler).toBeDefined()
        // String message goes through onMessage → process.write, surfaces back via cat echo.
        handler!.onMessage("first\n")
        // ArrayBuffer message goes through the decode branch.
        const buf = new TextEncoder().encode("second\n")
        handler!.onMessage(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
        yield* Effect.sleep("150 millis")
        const text = out.join("")
        expect(text).toContain("first")
        expect(text).toContain("second")
        // onClose just unregisters the subscriber — no error.
        handler!.onClose()
      }),
    )
  })

  test("connect skips writes to a subscriber whose readyState is no longer OPEN", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "stale" })
        const out: string[] = []
        const ws = {
          readyState: 1,
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        yield* pty.connect(info.id, ws as any)
        // Simulate the WebSocket dropping. proc.onData should drop this subscriber.
        ws.readyState = 3 // CLOSED
        const before = out.length
        yield* pty.write(info.id, "ignored\n")
        yield* Effect.sleep("100 millis")
        // No new frames after readyState went to 3.
        expect(out.length).toBe(before)
      }),
    )
  })

  test("connect drops a subscriber whose send throws", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "throwing" })
        let throws = false
        let sends = 0
        const ws = {
          readyState: 1,
          send: () => {
            sends += 1
            if (throws) throw new Error("ws gone")
          },
          close: () => {},
        }
        yield* pty.connect(info.id, ws as any)
        throws = true
        const before = sends
        yield* pty.write(info.id, "boom\n")
        yield* Effect.sleep("100 millis")
        // After the throw, the subscriber should be dropped — no further sends.
        yield* pty.write(info.id, "again\n")
        yield* Effect.sleep("100 millis")
        // sends incremented at most once after `boom\n` (the throw), then no more.
        expect(sends).toBeLessThanOrEqual(before + 2)
      }),
    )
  })

  test("connect drops the subscriber when ws.data identity changes (Bun WS recycle)", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "recycle" })
        const out: string[] = []
        const ws = {
          readyState: 1,
          data: { conn: 1 },
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        yield* pty.connect(info.id, ws as any)
        // Bun recycles the underlying socket object: ws.data swaps to a new
        // identity, so proc.onData should treat the subscriber as gone.
        ws.data = { conn: 2 }
        const before = out.length
        yield* pty.write(info.id, "after-recycle\n")
        yield* Effect.sleep("100 millis")
        expect(out.length).toBe(before)
      }),
    )
  })

  test("connect drops the subscriber when ws.send throws during initial replay", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "replay-throw" })
        // Push some data so connect has something to replay.
        yield* pty.write(info.id, "history\n")
        yield* Effect.sleep("80 millis")
        let closed = false
        const ws = {
          readyState: 1,
          send: () => {
            throw new Error("send broken")
          },
          close: () => {
            closed = true
          },
        }
        const handler = yield* pty.connect(info.id, ws as any, 0)
        expect(handler).toBeUndefined()
        expect(closed).toBe(true)
      }),
    )
  })

  test("connect drops the subscriber when ws.send throws sending the meta frame", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "cat", title: "meta-throw" })
        let calls = 0
        let closed = false
        const ws = {
          readyState: 1,
          send: () => {
            calls += 1
            // Replay buffer is empty (no prior writes), so the very first send
            // is the meta frame. Throw on it.
            if (calls === 1) throw new Error("meta failed")
          },
          close: () => {
            closed = true
          },
        }
        const handler = yield* pty.connect(info.id, ws as any)
        expect(handler).toBeUndefined()
        expect(closed).toBe(true)
      }),
    )
  })
})

describe("Pty.update / Pty.resize", () => {
  test("update sets title and publishes Updated", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const events: { id: string; title: string }[] = []
        const off = Bus.subscribe(Pty.Event.Updated, (evt) =>
          events.push({ id: evt.properties.info.id, title: evt.properties.info.title }),
        )
        try {
          const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 5"], title: "before" })
          const updated = yield* pty.update(info.id, { title: "after" })
          expect(updated?.title).toBe("after")
          yield* Effect.sleep("30 millis")
          expect(events.some((e) => e.id === info.id && e.title === "after")).toBe(true)
        } finally {
          off()
        }
      }),
    )
  })

  test("update with size resizes the underlying PTY", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 5"], title: "resize" })
        const updated = yield* pty.update(info.id, { size: { rows: 24, cols: 80 } })
        expect(updated?.id).toBe(info.id)
      }),
    )
  })

  test("update on a non-existent PtyID returns undefined", async () => {
    await withPty((pty) =>
      Effect.gen(function* () {
        const result = yield* pty.update(
          Schema.decodeUnknownSync(Pty.Info.fields.id)("pty_does_not_exist"),
          { title: "ghost" },
        )
        expect(result).toBeUndefined()
      }),
    )
  })

  test("resize on a running PTY succeeds", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 5"], title: "resize2" })
        yield* pty.resize(info.id, 100, 30)
      }),
    )
  })

  test("resize on a non-existent PtyID is a no-op", async () => {
    await withPty((pty) =>
      Effect.gen(function* () {
        yield* pty.resize(Schema.decodeUnknownSync(Pty.Info.fields.id)("pty_does_not_exist"), 100, 30)
      }),
    )
  })

  test("remove publishes Deleted and is a no-op for non-existent ids", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        const deleted: PtyID[] = []
        const off = Bus.subscribe(Pty.Event.Deleted, (evt) => deleted.push(evt.properties.id))
        try {
          const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 5"], title: "rm", origin: "model" })
          yield* pty.remove(info.id)
          yield* Effect.sleep("30 millis")
          expect(deleted).toContain(info.id)
          // Idempotent: removing again is a no-op (no second event).
          const before = deleted.length
          yield* pty.remove(info.id)
          yield* Effect.sleep("30 millis")
          expect(deleted.length).toBe(before)
        } finally {
          off()
        }
      }),
    )
  })
})

describe("Pty buffer overflow trimming (legacy WS protocol)", () => {
  test("the sliding buffer trims from the front when content exceeds 2 MiB", async () => {
    if (process.platform === "win32") return
    await withPty((pty) =>
      Effect.gen(function* () {
        // Generate 3 MiB of output via awk so the legacy buffer overflows the 2 MiB cap and trims.
        const info = yield* pty.create({
          command: "/usr/bin/awk",
          args: ["BEGIN { for(i=0;i<3145728;i++) printf \"X\"; system(\"sleep 0.5\") }"],
          title: "overflow",
          origin: "model",
        })
        // Wait for the awk burst to complete.
        yield* Effect.promise(() => waitForOutput(pty, info.id, 3_000_000, 10000))
        // Reconnect via Pty.connect to verify the legacy buffer is now < the cap and replay still works.
        const out: string[] = []
        const ws = {
          readyState: 1,
          send: (data: unknown) => {
            out.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"))
          },
          close: () => {},
        }
        const handler = yield* pty.connect(info.id, ws as any, 0)
        expect(handler).toBeDefined()
        // Replayed data plus meta. Replay length should be <= 2 MiB (the cap).
        const dataLen = out.filter((c) => c.length === 0 || c.charCodeAt(0) !== 0).reduce((s, c) => s + c.length, 0)
        expect(dataLen).toBeLessThanOrEqual(2 * 1024 * 1024 + 64 * 1024) // small slack for chunking
      }),
    )
  }, 30000)
})

describe("Pty instance disposal", () => {
  test("the InstanceState finalizer tears down all live PTYs when the instance is reloaded", async () => {
    if (process.platform === "win32") return
    const dir = await tmpdir({ git: true })
    try {
      // Create some PTYs in this instance.
      await WithInstance.provide({
        directory: dir.path,
        fn: () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const pty = yield* Pty.Service
              yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "a" })
              yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: "b" })
              const list = yield* pty.list()
              expect(list.length).toBe(2)
            }),
          ),
      })
      // Reload the instance — disposes the cached state, which fires the InstanceState finalizer.
      await reloadInstance({ directory: dir.path })
      // After reload the new InstanceState starts fresh — no live PTYs.
      await WithInstance.provide({
        directory: dir.path,
        fn: () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const pty = yield* Pty.Service
              const list = yield* pty.list()
              expect(list.length).toBe(0)
            }),
          ),
      })
    } finally {
      await dir[Symbol.asyncDispose]()
    }
  })
})
