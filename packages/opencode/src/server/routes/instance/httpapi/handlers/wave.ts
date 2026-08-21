import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ActivePayload } from "../groups/wave"
import { Wave } from "@/wave/wave"
import { WaveLoop } from "@/wave/loop"

export const waveHandlers = HttpApiBuilder.group(InstanceHttpApi, "wave", (handlers) =>
  Effect.gen(function* () {
    const wave = yield* Wave.Service
    const loop = yield* WaveLoop.Service
    const action = (effect: Effect.Effect<void, unknown>) => effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    return handlers
      .handle("list", () => wave.listCampaigns())
      .handle("active", () => wave.readActive())
      .handle("setActive", (ctx: { payload: typeof ActivePayload.Type }) => wave.setActive(ctx.payload.id ?? null))
      .handle("read", (ctx) => wave.read(ctx.params.campaignID).pipe(Effect.mapError(() => new HttpApiError.NotFound({}))))
      .handle("notes", (ctx) => wave.readNotes(ctx.params.campaignID, ctx.params.wave))
      .handle("arm", () => action(loop.arm()))
      .handle("next", () => action(loop.next()))
      .handle("pause", () => action(loop.pause()))
      .handle("resume", () => action(loop.resume()))
      .handle("interrupt", () => action(loop.interrupt()))
      .handle("stop", () => action(loop.stop()))
  }),
)
