import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Event } from "./event"

const log = Log.create({ service: "server" })

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                log.warn("global disposal failed", { cause })
              }),
            ),
          )
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

/** The restart button: respond first, then dispose cleanly (bounded — a
 * wedged instance must not block the exit) and leave. the process
 * supervisor (systemd Restart=always / launchd KeepAlive) brings the serve
 * back; clients resync over sse. this is the ONLY sanctioned way to
 * restart a serve remotely — no ssh, no new trust surface. */
export function scheduleProcessExit(runPromise: (effect: Effect.Effect<void, never, InstanceStore.Service>) => Promise<void>) {
  setTimeout(() => {
    const graceful = runPromise(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })).catch(() => undefined)
    const deadline = new Promise((resolve) => setTimeout(resolve, 3000))
    void Promise.race([graceful, deadline]).then(() => {
      log.info("restart requested via api; exiting for supervisor relaunch")
      process.exit(0)
    })
  }, 200)
}

export * as GlobalLifecycle from "./global-lifecycle"
