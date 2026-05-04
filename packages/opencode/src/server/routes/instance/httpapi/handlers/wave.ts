import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Wave } from "@/wave/wave"
import { WaveLoop } from "@/wave/loop"
import { InstanceHttpApi } from "../api"
import type { SetActivePayload } from "../groups/wave"

export const waveHandlers = HttpApiBuilder.group(InstanceHttpApi, "wave", (handlers) =>
  Effect.gen(function* () {
    const wave = yield* Wave.Service
    const loop = yield* WaveLoop.Service

    const ok = { ok: true } as const

    return handlers
      .handle("listCampaigns", () =>
        Effect.gen(function* () {
          const campaigns = yield* wave.listCampaigns()
          return { campaigns }
        }),
      )
      .handle("getActive", () =>
        Effect.gen(function* () {
          const active = yield* wave.getActive()
          return { campaign_id: Option.getOrNull(active) }
        }),
      )
      .handle("setActive", (ctx: { payload: typeof SetActivePayload.Type }) =>
        Effect.gen(function* () {
          yield* wave.setActive(ctx.payload.campaign_id)
          return ok
        }),
      )
      .handle("readActive", () =>
        Effect.gen(function* () {
          const state = yield* wave.readActive()
          return { state: Option.getOrNull(state) }
        }),
      )
      .handle("read", (ctx: { params: { id: string } }) =>
        wave.read(ctx.params.id).pipe(Effect.catch(() => Effect.fail(new HttpApiError.NotFound()))),
      )
      .handle("loopArm", () => loop.arm().pipe(Effect.as(ok)))
      .handle("loopPause", () => loop.pause().pipe(Effect.as(ok)))
      .handle("loopResume", () => loop.resume().pipe(Effect.as(ok)))
      .handle("loopInterrupt", () => loop.interrupt().pipe(Effect.as(ok)))
      .handle("loopStop", () => loop.stop().pipe(Effect.as(ok)))
      .handle("loopNext", () => loop.next().pipe(Effect.as(ok)))
  }),
)
