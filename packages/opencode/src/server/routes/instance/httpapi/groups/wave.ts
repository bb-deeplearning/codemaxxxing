import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { State } from "@/wave/state"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/wave"

export const WavePaths = {
  listCampaigns: `${root}/campaigns`,
  getActive: `${root}/active`,
  setActive: `${root}/active`,
  readActive: `${root}/active/state`,
  read: `${root}/campaigns/:id`,
  arm: `${root}/loop/arm`,
  pause: `${root}/loop/pause`,
  resume: `${root}/loop/resume`,
  interrupt: `${root}/loop/interrupt`,
  stop: `${root}/loop/stop`,
  next: `${root}/loop/next`,
} as const

export const ListCampaignsResponse = Schema.Struct({ campaigns: Schema.Array(Schema.String) }).annotate({
  identifier: "WaveListCampaignsResponse",
})

export const ActiveResponse = Schema.Struct({ campaign_id: Schema.NullOr(Schema.String) }).annotate({
  identifier: "WaveActiveResponse",
})

export const SetActivePayload = Schema.Struct({ campaign_id: Schema.NullOr(Schema.String) }).annotate({
  identifier: "WaveSetActivePayload",
})

export const ReadActiveResponse = Schema.Struct({ state: Schema.NullOr(State) }).annotate({
  identifier: "WaveReadActiveResponse",
})

export const OkResponse = Schema.Struct({ ok: Schema.Literal(true) }).annotate({ identifier: "WaveOkResponse" })

export const WaveApi = HttpApi.make("wave").add(
  HttpApiGroup.make("wave")
    .add(
      HttpApiEndpoint.get("listCampaigns", WavePaths.listCampaigns, {
        success: described(ListCampaignsResponse, "Campaign IDs (sorted)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wave.listCampaigns",
          summary: "List wave campaigns",
          description: "Returns the IDs of all campaigns under .wave/campaigns/ that have a STATE.md.",
        }),
      ),
      HttpApiEndpoint.get("getActive", WavePaths.getActive, {
        success: described(ActiveResponse, "Active campaign id (or null)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wave.getActive",
          summary: "Get active campaign",
          description: "Reads the .wave/active pointer.",
        }),
      ),
      HttpApiEndpoint.post("setActive", WavePaths.setActive, {
        payload: SetActivePayload,
        success: described(OkResponse, "Active pointer updated"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wave.setActive",
          summary: "Set active campaign",
          description: "Writes the .wave/active pointer; null clears it.",
        }),
      ),
      HttpApiEndpoint.get("readActive", WavePaths.readActive, {
        success: described(ReadActiveResponse, "Parsed STATE.md for the active campaign (or null)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wave.readActive",
          summary: "Read active campaign state",
          description: "Returns the parsed STATE.md for whichever campaign .wave/active points at.",
        }),
      ),
      HttpApiEndpoint.get("read", WavePaths.read, {
        params: { id: Schema.String },
        success: described(State, "Parsed STATE.md"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wave.read",
          summary: "Read campaign state",
          description: "Returns the parsed STATE.md for a specific campaign id.",
        }),
      ),
      HttpApiEndpoint.post("loopArm", WavePaths.arm, {
        success: described(OkResponse, "Loop armed"),
      }).annotateMerge(OpenApi.annotations({ identifier: "wave.loop.arm", summary: "Arm the auto-loop" })),
      HttpApiEndpoint.post("loopPause", WavePaths.pause, {
        success: described(OkResponse, "Loop paused"),
      }).annotateMerge(OpenApi.annotations({ identifier: "wave.loop.pause", summary: "Pause the auto-loop" })),
      HttpApiEndpoint.post("loopResume", WavePaths.resume, {
        success: described(OkResponse, "Loop resumed"),
      }).annotateMerge(OpenApi.annotations({ identifier: "wave.loop.resume", summary: "Resume the auto-loop" })),
      HttpApiEndpoint.post("loopInterrupt", WavePaths.interrupt, {
        success: described(OkResponse, "Current wave interrupted"),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "wave.loop.interrupt", summary: "Interrupt the current wave" }),
      ),
      HttpApiEndpoint.post("loopStop", WavePaths.stop, {
        success: described(OkResponse, "Loop stopped + current interrupted"),
      }).annotateMerge(OpenApi.annotations({ identifier: "wave.loop.stop", summary: "Stop the loop and interrupt" })),
      HttpApiEndpoint.post("loopNext", WavePaths.next, {
        success: described(OkResponse, "Next wave spawned"),
      }).annotateMerge(OpenApi.annotations({ identifier: "wave.loop.next", summary: "Spawn the next wave" })),
    )
    .annotateMerge(OpenApi.annotations({ title: "wave", description: "Wave campaign + auto-loop control." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
