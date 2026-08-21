import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ParseError, State, parse, serialize } from "./state"

const ROOT = ".wave"
const CAMPAIGNS = "campaigns"
const STATE_FILE = "STATE.md"

export class CampaignNotFound extends Schema.TaggedErrorClass<CampaignNotFound>()("@opencode/WaveCampaignNotFound", {
  campaign_id: Schema.String,
}) {}

export interface Interface {
  readonly listCampaigns: () => Effect.Effect<ReadonlyArray<string>>
  readonly getActive: () => Effect.Effect<Option.Option<string>>
  readonly setActive: (id: string | null) => Effect.Effect<void>
  readonly read: (id: string) => Effect.Effect<State, CampaignNotFound | ParseError>
  readonly readActive: () => Effect.Effect<Option.Option<State>>
  readonly write: (id: string, state: State) => Effect.Effect<void, CampaignNotFound>
  readonly update: (id: string, fn: (state: State) => State) => Effect.Effect<State, CampaignNotFound | ParseError>
  readonly readNotes: (id: string, wave: number) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Wave") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const root = (directory: string) => path.join(directory, ROOT)
    const campaignsRoot = (directory: string) => path.join(root(directory), CAMPAIGNS)
    const statePath = (directory: string, id: string) => path.join(campaignsRoot(directory), id, STATE_FILE)

    const listCampaigns = Effect.fn("Wave.listCampaigns")(function* () {
      const ctx = yield* InstanceState.context
      const entries = yield* Effect.promise(() => readdir(campaignsRoot(ctx.directory), { withFileTypes: true })).pipe(
        Effect.catch(() => Effect.succeed([])),
      )
      const campaigns = yield* Effect.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            Effect.promise(() => stat(statePath(ctx.directory, entry.name))).pipe(
              Effect.map(() => entry.name),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          ),
        { concurrency: 8 },
      )
      return campaigns.filter((id): id is string => id !== undefined).sort()
    })

    const getActive = Effect.fn("Wave.getActive")(function* () {
      const ctx = yield* InstanceState.context
      const value = yield* Effect.promise(() => readFile(path.join(root(ctx.directory), "active"), "utf8")).pipe(
        Effect.catch(() => Effect.succeed("")),
      )
      const id = value.trim()
      return id ? Option.some(id) : Option.none<string>()
    })

    const setActive = Effect.fn("Wave.setActive")(function* (id: string | null) {
      const ctx = yield* InstanceState.context
      yield* Effect.promise(() => mkdir(root(ctx.directory), { recursive: true }))
      if (id === null) {
        yield* Effect.promise(() => rm(path.join(root(ctx.directory), "active"), { force: true }))
        return
      }
      yield* Effect.promise(() => writeFile(path.join(root(ctx.directory), "active"), `${id}\n`, "utf8"))
    })

    const read = Effect.fn("Wave.read")(function* (id: string) {
      const ctx = yield* InstanceState.context
      const file = statePath(ctx.directory, id)
      const exists = yield* Effect.promise(() => stat(file)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)))
      if (!exists) return yield* new CampaignNotFound({ campaign_id: id })
      const text = yield* Effect.promise(() => readFile(file, "utf8"))
      return yield* parse(text)
    })

    const readActive = Effect.fn("Wave.readActive")(function* () {
      const active = yield* getActive()
      if (Option.isNone(active)) return Option.none<State>()
      return yield* read(active.value).pipe(Effect.map(Option.some), Effect.catch(() => Effect.succeed(Option.none<State>())))
    })

    const write = Effect.fn("Wave.write")(function* (id: string, state: State) {
      const ctx = yield* InstanceState.context
      const file = statePath(ctx.directory, id)
      const previous = yield* Effect.promise(() => readFile(file, "utf8"))
      yield* Effect.promise(() => writeFile(file, serialize(state, previous), "utf8"))
    })

    const update = Effect.fn("Wave.update")(function* (id: string, fn: (state: State) => State) {
      const state = yield* read(id)
      const next = fn(state)
      yield* write(id, next)
      return next
    })

    const readNotes = Effect.fn("Wave.readNotes")(function* (id: string, wave: number) {
      const ctx = yield* InstanceState.context
      const file = path.join(campaignsRoot(ctx.directory), id, "plan", "waves", `wave_${wave}`, "NOTES.md")
      return yield* Effect.promise(() => readFile(file, "utf8")).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<string>())),
      )
    })

    return Service.of({ listCampaigns, getActive, setActive, read, readActive, write, update, readNotes })
  }),
)

export const defaultLayer = layer

export * as Wave from "./wave"
