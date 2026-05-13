import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { lazy } from "@opencode-ai/core/util/lazy"
import { Plugin } from "@/plugin"
import { Shell } from "@/shell/shell"
import type { Proc } from "#pty"
import * as Log from "@opencode-ai/core/util/log"
import { PtyID } from "./schema"
import { HeadTailBuffer } from "./head-tail-buffer"
import { Deferred, Effect, Layer, Context, Schema, Stream, SubscriptionRef, Types } from "effect"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, PositiveInt, withStatics } from "@/util/schema"

const log = Log.create({ service: "pty" })

const BUFFER_LIMIT = 1024 * 1024 * 2
const BUFFER_CHUNK = 64 * 1024
const encoder = new TextEncoder()

// Codex constants ported verbatim from codex-rs/core/src/unified_exec/mod.rs
// (see CONSTANTS.md in the wave plan). These live here per MESSAGE_SHAPES.md
// § "Constants split" — Pty.Service consumes them, downstream waves and tests
// import from this module. All exported, none module-private.
export const MAX_UNIFIED_EXEC_PROCESSES = 64
export const WARNING_UNIFIED_EXEC_PROCESSES = 60
export const PROCESS_STORE_PROTECTED_RECENT = 8
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024
export const EARLY_EXIT_GRACE_PERIOD_MS = 150
export const POST_EXIT_CLOSE_WAIT_CAP_MS = 50
export const TRAILING_OUTPUT_GRACE_MS = 100
export const UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES = 8192
export const PROCESS_ID_RANGE_MIN = 1_000
export const PROCESS_ID_RANGE_MAX = 100_000

// Module-private monotonic counter for `Active.lastUsed`. Date.now() has only
// millisecond resolution; LRU pruning needs a strict total order so two PTYs
// created back-to-back have a deterministic age relationship. A bare counter
// is the simplest mechanism that satisfies both production behavior and the
// determinism the LRU tests require.
let lastUsedSeq = 0
const tickLastUsed = () => ++lastUsedSeq

type Socket = {
  readyState: number
  data?: unknown
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

type Active = {
  info: Info
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Map<unknown, Socket>
  // Wave 2 additions. The legacy `buffer`/`cursor` powers the WebSocket replay
  // protocol used by desktop terminal panes. The fields below feed the new
  // `Pty.read` race primitive and the LRU pruner without disturbing that path.
  headTail: HeadTailBuffer
  byteCursor: number
  notify: SubscriptionRef.SubscriptionRef<number>
  exitDeferred: Deferred.Deferred<{ exitCode: number }>
  exited: boolean
  exitCode?: number
  lastUsed: number
}

type State = {
  dir: string
  sessions: Map<PtyID, Active>
}

// WebSocket control frame: 0x00 + UTF-8 JSON.
const meta = (cursor: number) => {
  const json = JSON.stringify({ cursor })
  const bytes = encoder.encode(json)
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

const pty = lazy(() => import("#pty"))

export const Info = Schema.Struct({
  id: PtyID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  pid: PositiveInt,
  origin: Schema.optional(Schema.Literals(["tui", "model"])),
})
  .annotate({ identifier: "Pty" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const CreateInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  origin: Schema.optional(Schema.Literals(["tui", "model"])),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  size: Schema.optional(
    Schema.Struct({
      rows: PositiveInt,
      cols: PositiveInt,
    }),
  ),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const Event = {
  Created: BusEvent.define("pty.created", Schema.Struct({ info: Info })),
  Updated: BusEvent.define("pty.updated", Schema.Struct({ info: Info })),
  Exited: BusEvent.define("pty.exited", Schema.Struct({ id: PtyID, exitCode: NonNegativeInt })),
  Deleted: BusEvent.define("pty.deleted", Schema.Struct({ id: PtyID })),
  PoolWarning: BusEvent.define(
    "pty.pool_warning",
    Schema.Struct({
      count: PositiveInt,
      cap: PositiveInt,
    }),
  ),
}

export interface ReadResult {
  output: Uint8Array
  cursor: number
  exited: boolean
  exitCode?: number
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info | undefined>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info | undefined>
  readonly remove: (id: PtyID) => Effect.Effect<void>
  readonly resize: (id: PtyID, cols: number, rows: number) => Effect.Effect<void>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void>
  readonly read: (
    id: PtyID,
    sinceCursor: number,
    idleMs: number,
    maxBytes: number,
  ) => Effect.Effect<ReadResult | undefined>
  readonly terminateAll: () => Effect.Effect<void>
  readonly connect: (
    id: PtyID,
    ws: Socket,
    cursor?: number,
  ) => Effect.Effect<{ onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Pty") {}

// Drain the head/tail buffer for bytes between (sinceCursor, byteCursor], capped
// at `maxBytes` via a fresh head/tail truncation when the slice is too large.
// Side-effect-free; safe to call from sync paths.
function drainSince(session: Active, sinceCursor: number, maxBytes: number): ReadResult {
  const totalRetained = session.headTail.retainedBytes()
  const startPos = session.byteCursor - totalRetained
  const wantStart = Math.max(sinceCursor, startPos)
  const wantEnd = session.byteCursor

  if (wantEnd <= wantStart) {
    return {
      output: new Uint8Array(0),
      cursor: wantEnd,
      exited: session.exited,
      exitCode: session.exitCode,
    }
  }

  const allBytes = session.headTail.toBytes()
  const offset = wantStart - startPos
  let slice = offset === 0 ? allBytes : allBytes.subarray(offset)
  if (slice.length > maxBytes) {
    const truncBuf = new HeadTailBuffer(maxBytes)
    truncBuf.pushChunk(slice)
    slice = truncBuf.toBytes()
  }

  return {
    output: slice,
    cursor: wantEnd,
    exited: session.exited,
    exitCode: session.exitCode,
  }
}

// Mirrors codex `process_id_to_prune_from_meta`
// (codex-rs/core/src/unified_exec/process_manager.rs:1215-1241):
// protect the PROCESS_STORE_PROTECTED_RECENT most-recently-used; among the
// rest, prefer an exited PTY (LRU first); otherwise pick the LRU non-protected
// alive one. Returns the PtyID to prune or undefined if every entry is
// protected (only possible with strictly fewer than PROTECTED_RECENT total,
// which never happens at the cap).
function pickPruneTarget(s: State): PtyID | undefined {
  if (s.sessions.size < MAX_UNIFIED_EXEC_PROCESSES) return undefined

  const meta = Array.from(s.sessions.entries()).map(([id, active]) => ({
    id,
    lastUsed: active.lastUsed,
    exited: active.exited,
  }))

  const byRecency = [...meta].sort((a, b) => b.lastUsed - a.lastUsed)
  const protectedIds = new Set(byRecency.slice(0, PROCESS_STORE_PROTECTED_RECENT).map((m) => m.id))

  const byLru = [...meta].sort((a, b) => a.lastUsed - b.lastUsed)
  const exitedTarget = byLru.find((m) => !protectedIds.has(m.id) && m.exited)
  if (exitedTarget) return exitedTarget.id
  const lruTarget = byLru.find((m) => !protectedIds.has(m.id))
  return lruTarget?.id
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const plugin = yield* Plugin.Service

    function teardown(session: Active) {
      try {
        session.process.kill()
      } catch {}
      for (const [sub, ws] of session.subscribers.entries()) {
        try {
          if (sock(ws) === sub) ws.close()
        } catch {}
      }
      session.subscribers.clear()
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Pty.state")(function* (ctx) {
        const state = {
          dir: ctx.directory,
          sessions: new Map<PtyID, Active>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const session of state.sessions.values()) {
              teardown(session)
            }
            state.sessions.clear()
          }),
        )

        return state
      }),
    )

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (!session) return
      s.sessions.delete(id)
      log.info("removing session", { id })
      teardown(session)
      yield* bus.publish(Event.Deleted, { id: session.info.id })
    })

    const list = Effect.fn("Pty.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from(s.sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      const s = yield* InstanceState.get(state)
      return s.sessions.get(id)?.info
    })

    const prune = Effect.fn("Pty.prune")(function* (s: State) {
      const target = pickPruneTarget(s)
      if (!target) return
      const session = s.sessions.get(target)
      if (!session) return
      s.sessions.delete(target)
      log.info("pruning session", { id: target, exited: session.exited })
      teardown(session)
      yield* bus.publish(Event.Deleted, { id: target })
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const s = yield* InstanceState.get(state)

      // Codex prunes BEFORE inserting (process_manager.rs:830-840). This keeps
      // the cap a hard ceiling rather than a soft target.
      yield* prune(s)

      const bridge = yield* EffectBridge.make()
      const cfg = yield* config.get()
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(cfg.shell)
      const args = input.args || []
      if (Shell.login(command)) {
        args.push("-l")
      }

      const cwd = input.cwd || s.dir
      const shell = yield* plugin.trigger("shell.env", { cwd }, { env: {} })
      const env = {
        ...process.env,
        ...input.env,
        ...shell.env,
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
      } as Record<string, string>

      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      log.info("creating session", { id, cmd: command, args, cwd })

      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() =>
        spawn(command, args, {
          name: "xterm-256color",
          cwd,
          env,
        }),
      )

      const notify = yield* SubscriptionRef.make(0)
      const exitDeferred = yield* Deferred.make<{ exitCode: number }>()

      const info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
        origin: input.origin ?? "tui",
      } as const
      const session: Active = {
        info,
        process: proc,
        buffer: "",
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Map(),
        headTail: new HeadTailBuffer(),
        byteCursor: 0,
        notify,
        exitDeferred,
        exited: false,
        lastUsed: tickLastUsed(),
      }
      s.sessions.set(id, session)
      proc.onData((chunk) => {
        session.cursor += chunk.length

        for (const [key, ws] of session.subscribers.entries()) {
          if (ws.readyState !== 1) {
            session.subscribers.delete(key)
            continue
          }
          if (sock(ws) !== key) {
            session.subscribers.delete(key)
            continue
          }
          try {
            ws.send(chunk)
          } catch {
            session.subscribers.delete(key)
          }
        }

        session.buffer += chunk
        if (session.buffer.length > BUFFER_LIMIT) {
          const excess = session.buffer.length - BUFFER_LIMIT
          session.buffer = session.buffer.slice(excess)
          session.bufferCursor += excess
        }

        // Wave 2: feed the head/tail buffer in parallel and wake any read()s
        // waiting on the cursor SubscriptionRef. byteCursor and the legacy
        // string-unit cursor diverge for non-ASCII input — the new path
        // operates exclusively on bytes per codex semantics.
        const bytes = encoder.encode(chunk)
        session.headTail.pushChunk(bytes)
        session.byteCursor += bytes.length
        session.lastUsed = tickLastUsed()
        bridge.fork(SubscriptionRef.set(notify, session.byteCursor))
      })
      proc.onExit(({ exitCode }) => {
        if (session.info.status === "exited") return
        log.info("session exited", { id, exitCode })
        session.info.status = "exited"
        session.exited = true
        session.exitCode = exitCode
        bridge.fork(Deferred.succeed(exitDeferred, { exitCode }))
        bridge.fork(bus.publish(Event.Exited, { id, exitCode }))
        // Legacy TUI/desktop callers expect the session to vanish from
        // Pty.list once the process exits. Model-spawned PTYs (unified_exec)
        // mirror codex semantics: the entry stays so the tool can still read
        // final output and the LRU pruner can prefer exited entries.
        if (session.info.origin === "tui") {
          bridge.fork(remove(id))
        }
      })
      yield* bus.publish(Event.Created, { info })

      // Per codex (process_manager.rs:861-867): emit a soft warning once the
      // pool crosses WARNING_UNIFIED_EXEC_PROCESSES so callers can surface a
      // gentle "you have a lot of background processes" hint to the user.
      if (s.sessions.size >= WARNING_UNIFIED_EXEC_PROCESSES) {
        yield* bus.publish(Event.PoolWarning, {
          count: s.sessions.size,
          cap: MAX_UNIFIED_EXEC_PROCESSES,
        })
      }

      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (!session) return
      if (input.title) {
        session.info.title = input.title
      }
      if (input.size) {
        session.process.resize(input.size.cols, input.size.rows)
      }
      yield* bus.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const resize = Effect.fn("Pty.resize")(function* (id: PtyID, cols: number, rows: number) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (session && session.info.status === "running") {
        session.process.resize(cols, rows)
      }
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (session && session.info.status === "running") {
        session.process.write(data)
        session.lastUsed = tickLastUsed()
      }
    })

    const read = Effect.fn("Pty.read")(function* (
      id: PtyID,
      sinceCursor: number,
      idleMs: number,
      maxBytes: number,
    ) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (!session) return undefined

      session.lastUsed = tickLastUsed()

      // Fast path: already past the requested cursor or process exited.
      // Mirrors codex collect_output_until_deadline's drain-first loop entry
      // at process_manager.rs:1093-1100.
      if (session.byteCursor > sinceCursor || session.exited) {
        return drainSince(session, sinceCursor, maxBytes)
      }

      // Race three wakeup sources. Codex's loop equivalent at
      // process_manager.rs:1125-1143: cursor-advance via `output_notify`,
      // idle-deadline via `tokio::time::sleep`, and process-exit via the
      // cancellation token. We collapse to a single race rather than the
      // loop because a single read() returns whatever's available now;
      // multi-call collection lives at the tool layer (Wave 3).
      yield* Effect.raceAll([
        SubscriptionRef.changes(session.notify).pipe(
          Stream.dropWhile((c) => c <= sinceCursor),
          Stream.take(1),
          Stream.runDrain,
        ),
        Effect.sleep(`${idleMs} millis`),
        Deferred.await(session.exitDeferred).pipe(Effect.asVoid),
      ])

      return drainSince(session, sinceCursor, maxBytes)
    })

    const terminateAll = Effect.fn("Pty.terminateAll")(function* () {
      const s = yield* InstanceState.get(state)
      const ids = Array.from(s.sessions.keys())
      for (const id of ids) {
        const session = s.sessions.get(id)
        if (!session) continue
        s.sessions.delete(id)
        teardown(session)
        yield* bus.publish(Event.Deleted, { id })
      }
    })

    const connect = Effect.fn("Pty.connect")(function* (id: PtyID, ws: Socket, cursor?: number) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (!session) {
        ws.close()
        return
      }
      log.info("client connected to session", { id })

      const sub = sock(ws)
      session.subscribers.delete(sub)
      session.subscribers.set(sub, ws)

      const cleanup = () => {
        session.subscribers.delete(sub)
      }

      const start = session.bufferCursor
      const end = session.cursor
      const from =
        cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

      const data = (() => {
        if (!session.buffer) return ""
        if (from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()

      if (data) {
        try {
          for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
            ws.send(data.slice(i, i + BUFFER_CHUNK))
          }
        } catch {
          cleanup()
          ws.close()
          return
        }
      }

      try {
        ws.send(meta(end))
      } catch {
        cleanup()
        ws.close()
        return
      }

      return {
        onMessage: (message: string | ArrayBuffer) => {
          session.process.write(typeof message === "string" ? message : new TextDecoder().decode(message))
        },
        onClose: () => {
          log.info("client disconnected from session", { id })
          cleanup()
        },
      }
    })

    return Service.of({ list, get, create, update, remove, resize, write, read, terminateAll, connect })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Pty from "."
