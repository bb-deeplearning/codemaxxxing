/* config hot-reload: the serve reacts to config file changes instead of
   demanding a restart.

   trigger 1 (process-level): a @parcel/watcher subscription on the global
   config dir (`Global.Path.config`, plus `Flag.OPENCODE_CONFIG_DIR` when
   set). node_modules and caches are ignored AT SUBSCRIBE TIME — plugin
   installs write thousands of files there and inotify pays per directory.

   trigger 2 (per-instance): `file.watcher.updated` frames on the GlobalBus
   whose file is a project config path (opencode.json(c) or .opencode/*) —
   only fires when the experimental project watcher is enabled.

   pipeline, both triggers: debounce → probe-load (a broken file mid-edit
   NEVER downgrades a live serve; previous config stays active) → diff into
   changed slices → flush only config-derived caches (the registry's config
   channel; mcp/lsp/plugin flush only when their slice moved) → publish
   `config.updated` per live directory → one honest log line.

   running turns hold the references they already resolved and finish on
   the old config; the next access rebuilds lazily from the new one.
   sessions, ptys, pending permissions, and sse streams are never touched —
   this is invalidation, not disposal, and `server.instance.disposed` never
   fires from here. */

import path from "path"
import { Context, Duration, Effect, Exit, Layer, Queue, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { FileWatcher } from "@/file/watcher"
import { InstanceStore } from "@/project/instance-store"
import { invalidateConfigDependents, type ConfigInvalidateScope } from "@/effect/instance-registry"
import { Config } from "./config"
import type { Info } from "./config"

const log = Log.create({ service: "config.reload" })

const DEBOUNCE = Duration.millis(300)
const RETRY_AFTER = Duration.seconds(3)

export const Event = {
  Updated: BusEvent.define(
    "config.updated",
    Schema.Struct({
      directory: Schema.String,
      changed: Schema.mutable(Schema.Array(Schema.String)),
    }),
  ),
}

/** Which reload slice a top-level config key belongs to. Everything not
 * named here is "core": flushed via the blanket channel on any change. */
const SLICE_OF_KEY: Record<string, ConfigInvalidateScope> = {
  mcp: "mcp",
  lsp: "lsp",
  plugin: "plugin",
  plugin_origins: "plugin",
}

export type ChangedSlices = { core: boolean; gated: ConfigInvalidateScope[] }

export function computeChangedSlices(previous: Info, next: Info): ChangedSlices {
  const gated = new Set<ConfigInvalidateScope>()
  let core = false
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const a = previous[key as keyof Info]
    const b = next[key as keyof Info]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    const slice = SLICE_OF_KEY[key]
    if (slice) gated.add(slice)
    else core = true
  }
  return { core, gated: [...gated] }
}

type Trigger =
  | { kind: "global"; paths: string[] }
  /** one bounded follow-up per global pass: instances whose bootstrap was
   * in flight during the pass are invisible to directories() (flushing an
   * in-flight boot deadlocks the ScopedCache key lock) and may have booted
   * on the pre-edit config. the retry flushes exactly the late arrivals. */
  | { kind: "global-retry"; changed: ChangedSlices; flushed: string[] }
  | { kind: "project"; directory: string }

const isProjectConfigPath = (file: string) =>
  /(^|\/)opencode\.jsonc?$/.test(file) || file.includes(`${path.sep}.opencode${path.sep}`)

const isSkillPath = (file: string) => /(^|\/)skills?\//.test(file)

export class Service extends Context.Service<Service, {}>()("@opencode/ConfigReload") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const store = yield* InstanceStore.Service
    const bus = yield* Bus.Service
    const bridge = yield* EffectBridge.make()
    const queue = yield* Queue.unbounded<Trigger>()

    const publish = (directory: string, changed: string[]) =>
      store
        .provide(
          { directory },
          bus.publish(Event.Updated, { directory, changed }),
        )
        .pipe(Effect.ignore)

    const flushAll = Effect.fnUntraced(function* (changed: ChangedSlices, label: string) {
      const names = [...(changed.core ? ["core"] : []), ...changed.gated]
      const directories = yield* store.directories()
      yield* Effect.promise(() =>
        Promise.all(directories.map((dir) => invalidateConfigDependents(dir, changed.gated))),
      )
      yield* Effect.forEach(directories, (dir) => publish(dir, names), { discard: true })
      log.info("config reloaded", { trigger: label, changed: names, instances: directories.length })
      return directories
    })

    const scheduleRetry = (changed: ChangedSlices, flushed: string[]) =>
      Effect.sleep(RETRY_AFTER).pipe(
        Effect.andThen(Queue.offer(queue, { kind: "global-retry", changed, flushed })),
        Effect.forkScoped,
      )

    const handleGlobal = Effect.fnUntraced(function* (paths: string[]) {
      // SKILL.md edits are not config parses; flush the blanket channel
      // (skill caches live there) without probing the config files.
      if (paths.length > 0 && paths.every(isSkillPath)) {
        const changed = { core: true, gated: [] as ConfigInvalidateScope[] }
        const flushed = yield* flushAll(changed, "skills")
        yield* scheduleRetry(changed, flushed)
        return
      }
      const result = yield* config.reloadGlobal()
      if (!result.ok) {
        log.warn("config change ignored, file does not parse; previous config stays active", {
          error: result.error,
        })
        return
      }
      const changed = computeChangedSlices(result.previous, result.next)
      if (!changed.core && changed.gated.length === 0) return
      const flushed = yield* flushAll(changed, "global")
      yield* scheduleRetry(changed, flushed)
    })

    const handleRetry = Effect.fnUntraced(function* (changed: ChangedSlices, flushed: string[]) {
      const lateArrivals = (yield* store.directories()).filter((dir) => !flushed.includes(dir))
      if (lateArrivals.length === 0) return
      const names = [...(changed.core ? ["core"] : []), ...changed.gated]
      yield* Effect.promise(() =>
        Promise.all(lateArrivals.map((dir) => invalidateConfigDependents(dir, changed.gated))),
      )
      yield* Effect.forEach(lateArrivals, (dir) => publish(dir, names), { discard: true })
      log.info("config reloaded", { trigger: "late-boot", changed: names, instances: lateArrivals.length })
    })

    const handleProject = Effect.fnUntraced(function* (directory: string) {
      // Capture the instance's current config BEFORE flushing, probe the
      // fresh merge, and only flush when it parses and actually differs.
      const previous = yield* store.provide({ directory }, config.get()).pipe(Effect.exit)
      if (Exit.isFailure(previous)) return
      yield* Effect.promise(() => invalidateConfigDependents(directory, []))
      const next = yield* store.provide({ directory }, config.get()).pipe(Effect.exit)
      if (Exit.isFailure(next)) {
        log.warn("project config change broke the merge; instance keeps lazy-rebuilding until it parses", {
          directory,
        })
        return
      }
      const changed = computeChangedSlices(previous.value, next.value)
      if (changed.gated.length > 0)
        yield* Effect.promise(() => invalidateConfigDependents(directory, changed.gated))
      const names = [...(changed.core ? ["core"] : []), ...changed.gated]
      yield* publish(directory, names.length > 0 ? names : ["core"])
      log.info("config reloaded", { trigger: "project", directory, changed: names })
    })

    // Debounced consumer: take one trigger, let the burst settle, drain the
    // rest, then process the batch as a unit.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const first = yield* Queue.take(queue)
          yield* Effect.sleep(DEBOUNCE)
          const rest = yield* Queue.takeAll(queue)
          const batch = [first, ...rest]
          const globalPaths = batch.flatMap((t) => (t.kind === "global" ? t.paths : []))
          if (batch.some((t) => t.kind === "global")) yield* handleGlobal(globalPaths)
          for (const t of batch) {
            if (t.kind === "global-retry") yield* handleRetry(t.changed, t.flushed)
          }
          for (const dir of new Set(batch.flatMap((t) => (t.kind === "project" ? [t.directory] : [])))) {
            yield* handleProject(dir)
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("config reload pass failed", { cause: String(cause) })),
          ),
        ),
      ),
    )

    // Trigger 1: global config dir watcher (process-level).
    const native = FileWatcher.native()
    if (native) {
      const roots = [...new Set([Global.Path.config, Flag.OPENCODE_CONFIG_DIR].filter(Boolean))] as string[]
      for (const root of roots) {
        const subscription = yield* Effect.promise(() =>
          native.subscribe(
            root,
            (err, events) => {
              if (err || events.length === 0) return
              const noise = /(\/node_modules\/|\.DS_Store$|tui\.json$|bun\.lock[b]?$|package(-lock)?\.json$)/
              const paths = events.map((e) => e.path).filter((p) => !noise.test(p))
              if (paths.length === 0) return
              bridge.fork(Queue.offer(queue, { kind: "global", paths }))
            },
            { ignore: [path.join(root, "node_modules"), path.join(root, ".git"), path.join(root, "cache")] },
          ),
        ).pipe(
          Effect.catch((error) => {
            log.error("config dir watch failed; hot-reload degraded to api-write-only", { root, error: String(error) })
            return Effect.succeed(undefined)
          }),
        )
        if (subscription) yield* Effect.addFinalizer(() => Effect.promise(() => subscription.unsubscribe()))
      }
      log.info("watching config for hot-reload", { roots })
    } else {
      log.warn("no watcher binding; config hot-reload disabled, restarts required")
    }

    // Trigger 2: project config files, via the (experimental) per-instance
    // file watcher's frames on the GlobalBus.
    const onFrame = (frame: Parameters<Parameters<typeof GlobalBus.on<"event">>[1]>[0]) => {
      if (frame.payload?.type !== "file.watcher.updated") return
      const file = (frame.payload.properties as { file?: string } | undefined)?.file
      if (!file || !isProjectConfigPath(file)) return
      if (!frame.directory || !path.isAbsolute(frame.directory)) return
      bridge.fork(Queue.offer(queue, { kind: "project", directory: frame.directory }))
    }
    GlobalBus.on("event", onFrame)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onFrame)))

    return Service.of({})
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Bus.defaultLayer))

export * as ConfigReload from "./reload"
