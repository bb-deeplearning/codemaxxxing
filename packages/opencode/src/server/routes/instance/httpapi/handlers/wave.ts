import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ActivePayload } from "../groups/wave"
import { Wave } from "@/wave/wave"

export const waveHandlers = HttpApiBuilder.group(InstanceHttpApi, "wave", (handlers) =>
  Effect.gen(function* () {
    const wave = yield* Wave.Service
    return handlers
      .handle("list", () => wave.listCampaigns())
      .handle("active", () => wave.readActive())
      .handle("setActive", (ctx: { payload: typeof ActivePayload.Type }) => wave.setActive(ctx.payload.id ?? null))
      .handle("read", (ctx) => wave.read(ctx.params.campaignID).pipe(Effect.mapError(() => new HttpApiError.NotFound({}))))
      .handle("notes", (ctx) => wave.readNotes(ctx.params.campaignID, ctx.params.wave))
  }),
)
