import * as path from "node:path"
import { Bus } from "@/bus"
import { Effect, Layer, Context, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Pty } from "@/pty"
import type { PtyID } from "@/pty/schema"
import { PROCESS_ID_RANGE_MAX, PROCESS_ID_RANGE_MIN } from "./constants"

// Process-session bookkeeping shared between exec_command and write_stdin.
//
// The model sees a numeric `session_id` (matching codex's process_id, range
// [1000, 100_000)), but our Pty.Service is keyed by PtyID strings. This
// service holds the bidirectional mapping plus the per-session byte cursor
// the next write_stdin uses as `sinceCursor`, all in InstanceState so the
// state dies with the project instance.
//
// The Pty.Event.Deleted subscription drops entries when the pty pool prunes
// or terminates a session, so write_stdin's lookup misses surface as a clean
// "Unknown process id N" rather than a stale ptyID dangling in the map.

// Touch path so the import is referenced (avoids a lint warning) and the
// bun-coverage-line1-quirk fix above stays meaningful.
const _separator = path.sep

export interface Session {
  processId: number
  ptyId: PtyID
  tty: boolean
  cursor: number
}

interface State {
  sessions: Map<number, Session>
  byPty: Map<PtyID, number>
}

export interface Interface {
  readonly allocate: (input: { ptyId: PtyID; tty: boolean }) => Effect.Effect<Session>
  readonly get: (processId: number) => Effect.Effect<Session | undefined>
  readonly setCursor: (processId: number, cursor: number) => Effect.Effect<void>
  readonly remove: (processId: number) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Session>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProcessSessions") {}

// Random pid drawn from [PROCESS_ID_RANGE_MIN, PROCESS_ID_RANGE_MAX). Codex
// also uses random ids in production (process_manager.rs:347-348) so model
// traces don't depend on call order. Collisions resolve via a re-roll.
function nextProcessId(taken: Set<number>): number {
  for (;;) {
    const span = PROCESS_ID_RANGE_MAX - PROCESS_ID_RANGE_MIN
    const id = Math.floor(Math.random() * span) + PROCESS_ID_RANGE_MIN
    if (!taken.has(id)) return id
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ProcessSessions.state")(function* () {
        const s: State = {
          sessions: new Map<number, Session>(),
          byPty: new Map<PtyID, number>(),
        }

        // Drop entries whose underlying pty was pruned or terminated. Without
        // this hook a write_stdin lookup would return a Session whose ptyId
        // no longer resolves in Pty.Service — write_stdin handles that case
        // gracefully but the bookkeeping leak would grow unbounded over time.
        yield* Effect.forkScoped(
          Stream.runForEach(bus.subscribe(Pty.Event.Deleted), ({ properties }) =>
            Effect.sync(() => {
              const pid = s.byPty.get(properties.id)
              if (pid === undefined) return
              s.byPty.delete(properties.id)
              s.sessions.delete(pid)
            }),
          ),
        )

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            s.sessions.clear()
            s.byPty.clear()
          }),
        )

        return s
      }),
    )

    const allocate = Effect.fn("ProcessSessions.allocate")(function* (input: { ptyId: PtyID; tty: boolean }) {
      const s = yield* InstanceState.get(state)
      const taken = new Set(s.sessions.keys())
      const processId = nextProcessId(taken)
      const session: Session = {
        processId,
        ptyId: input.ptyId,
        tty: input.tty,
        cursor: 0,
      }
      s.sessions.set(processId, session)
      s.byPty.set(input.ptyId, processId)
      return session
    })

    const get = Effect.fn("ProcessSessions.get")(function* (processId: number) {
      const s = yield* InstanceState.get(state)
      return s.sessions.get(processId)
    })

    const setCursor = Effect.fn("ProcessSessions.setCursor")(function* (processId: number, cursor: number) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(processId)
      if (session) session.cursor = cursor
    })

    const remove = Effect.fn("ProcessSessions.remove")(function* (processId: number) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(processId)
      if (!session) return
      s.sessions.delete(processId)
      s.byPty.delete(session.ptyId)
    })

    const list = Effect.fn("ProcessSessions.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from(s.sessions.values())
    })

    return Service.of({ allocate, get, setCursor, remove, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as ProcessSessions from "./sessions"
