import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Effect, Layer, Option, Path, Schema } from "effect"
import { NodePath } from "@effect/platform-node"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { State, parse, serialize } from "./state"

// Wave campaign service — per-directory state for the wave executor system.
//
// A campaign is a decomposed plan under .wave/campaigns/<id>/. The active
// pointer .wave/active names which campaign the TUI dashboard + executor
// operate on. Multiple campaigns coexist; switching is lightweight (rewrite
// the pointer).
//
// Canonical state lives in <campaign>/STATE.md (see ./state). This service
// reads, writes, and lists. It does NOT spawn wave sessions or own the
// auto-loop FSM — those live in ./loop, layered on top.
//
// External edits (the wave executor agent updates STATE.md directly via the
// Edit tool during a session) are not observed via the bus. Consumers that
// need fresh state after an agent turn should re-read explicitly. This is
// intentional: a global file watcher would add overhead for a directory most
// projects do not use.

const ROOT_DIR = ".wave"
const ACTIVE_FILE = "active"
const CAMPAIGNS_DIR = "campaigns"
const STATE_FILE = "STATE.md"

export const Event = {
  Updated: BusEvent.define(
    "wave.updated",
    Schema.Struct({
      campaign_id: Schema.String,
    }),
  ),
  ActiveChanged: BusEvent.define(
    "wave.active_changed",
    Schema.Struct({
      campaign_id: Schema.NullOr(Schema.String),
    }),
  ),
}

export class CampaignNotFound extends Schema.TaggedErrorClass<CampaignNotFound>()("@opencode/WaveCampaignNotFound", {
  campaign_id: Schema.String,
}) {}

export interface Interface {
  readonly listCampaigns: () => Effect.Effect<ReadonlyArray<string>>
  readonly getActive: () => Effect.Effect<Option.Option<string>>
  readonly setActive: (id: string | null) => Effect.Effect<void>
  readonly read: (id: string) => Effect.Effect<State, CampaignNotFound>
  readonly readActive: () => Effect.Effect<Option.Option<State>>
  readonly write: (id: string, state: State) => Effect.Effect<void, CampaignNotFound>
  readonly update: (id: string, fn: (state: State) => State) => Effect.Effect<State, CampaignNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Wave") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const pathSvc = yield* Path.Path
    const bus = yield* Bus.Service

    const paths = yield* InstanceState.make(
      Effect.fn("Wave.paths")(function* () {
        const ctx = yield* InstanceState.context
        const root = pathSvc.join(ctx.directory, ROOT_DIR)
        const campaignsRoot = pathSvc.join(root, CAMPAIGNS_DIR)
        const activePath = pathSvc.join(root, ACTIVE_FILE)
        const campaignDir = (id: string) => pathSvc.join(campaignsRoot, id)
        const statePath = (id: string) => pathSvc.join(campaignDir(id), STATE_FILE)
        return { root, campaignsRoot, activePath, campaignDir, statePath }
      }),
    )

    const listCampaigns = Effect.fn("Wave.listCampaigns")(function* () {
      const { campaignsRoot } = yield* InstanceState.get(paths)
      const entries = yield* fs.readDirectory(campaignsRoot).pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const checked = yield* Effect.all(
        entries.map((name) =>
          fs.exists(pathSvc.join(campaignsRoot, name, STATE_FILE)).pipe(
            Effect.catch(() => Effect.succeed(false)),
            Effect.map((ok) => (ok ? name : null)),
          ),
        ),
        { concurrency: 8 },
      )
      return checked.filter((x): x is string => x !== null).sort()
    })

    const getActive = Effect.fn("Wave.getActive")(function* () {
      const { activePath } = yield* InstanceState.get(paths)
      const text = yield* fs.readFileString(activePath).pipe(Effect.catch(() => Effect.succeed("")))
      const id = text.trim()
      return id ? Option.some(id) : Option.none<string>()
    })

    const setActive = Effect.fn("Wave.setActive")(function* (id: string | null) {
      const { root, activePath } = yield* InstanceState.get(paths)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.catch(() => Effect.void))
      if (id === null) {
        yield* fs.remove(activePath).pipe(Effect.catch(() => Effect.void))
        yield* bus.publish(Event.ActiveChanged, { campaign_id: null })
        return
      }
      yield* fs.writeFileString(activePath, `${id}\n`).pipe(Effect.orDie)
      yield* bus.publish(Event.ActiveChanged, { campaign_id: id })
    })

    const read = Effect.fn("Wave.read")(function* (id: string) {
      const { statePath } = yield* InstanceState.get(paths)
      const file = statePath(id)
      const exists = yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!exists) return yield* new CampaignNotFound({ campaign_id: id })
      const text = yield* fs.readFileString(file).pipe(Effect.orDie)
      return yield* parse(text).pipe(Effect.orDie)
    })

    const readActive = Effect.fn("Wave.readActive")(function* () {
      const active = yield* getActive()
      if (Option.isNone(active)) return Option.none<State>()
      return yield* read(active.value).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<State>())),
      )
    })

    const write = Effect.fn("Wave.write")(function* (id: string, next: State) {
      const { statePath } = yield* InstanceState.get(paths)
      const file = statePath(id)
      const exists = yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!exists) return yield* new CampaignNotFound({ campaign_id: id })
      const previous = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
      yield* fs.writeFileString(file, serialize(next, previous || undefined)).pipe(Effect.orDie)
      yield* bus.publish(Event.Updated, { campaign_id: id })
    })

    const update = Effect.fn("Wave.update")(function* (id: string, fn: (state: State) => State) {
      const current = yield* read(id)
      const next = fn(current)
      yield* write(id, next)
      return next
    })

    return Service.of({ listCampaigns, getActive, setActive, read, readActive, write, update })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
  Layer.provide(Bus.defaultLayer),
)

export * as Wave from "./wave"
