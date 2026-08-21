import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { State } from "@/wave/state"
import { described } from "./metadata"

const root = "/wave"

export const WavePaths = {
  list: root,
  active: `${root}/active`,
  read: `${root}/:campaignID`,
  notes: `${root}/:campaignID/notes/:wave`,
} as const

export const ActivePayload = Schema.Struct({ id: Schema.optional(Schema.String) })

export const WaveApi = HttpApi.make("wave").add(
  HttpApiGroup.make("wave").add(
    HttpApiEndpoint.get("list", WavePaths.list, {
      success: described(Schema.Array(Schema.String), "Wave campaigns"),
    }).annotateMerge(OpenApi.annotations({ summary: "List wave campaigns" })),
    HttpApiEndpoint.get("active", WavePaths.active, {
      success: described(Schema.OptionFromNullOr(State), "Active wave campaign"),
    }).annotateMerge(OpenApi.annotations({ summary: "Read active wave campaign" })),
    HttpApiEndpoint.post("setActive", WavePaths.active, {
      payload: ActivePayload,
      success: Schema.Void,
    }).annotateMerge(OpenApi.annotations({ summary: "Select active wave campaign" })),
    HttpApiEndpoint.get("read", WavePaths.read, {
      params: { campaignID: Schema.String },
      success: described(State, "Wave campaign state"),
      error: HttpApiError.NotFound,
    }).annotateMerge(OpenApi.annotations({ summary: "Read wave campaign state" })),
    HttpApiEndpoint.get("notes", WavePaths.notes, {
      params: { campaignID: Schema.String, wave: Schema.NumberFromString },
      success: described(Schema.OptionFromNullOr(Schema.String), "Wave notes"),
    }).annotateMerge(OpenApi.annotations({ summary: "Read wave notes" })),
  ),
)
