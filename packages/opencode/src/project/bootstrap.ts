import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { Global } from "@opencode-ai/core/global"
import { ShareNext } from "@/share/share-next"
import { WaveLoop } from "@/wave/loop"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const waveLoop = yield* WaveLoop.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, file, fileWatcher, vcs, snapshot, project, waveLoop],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))

      // B4-3 (2026-07-18) — detached-process journal reconcile. Every
      // `exec_command { detach: true }` spawn records its pid in a global
      // journal; on startup we drop entries whose pid is gone and report
      // the survivors for THIS project so force-quit no longer produces
      // invisible orphan daemons (the ps-hunt from the 2026-07-17 report).
      yield* Effect.promise(async () => {
        const path = await import("node:path")
        const journalPath = path.join(Global.Path.data, "detached-processes.json")
        const journal = (await Bun.file(journalPath)
          .json()
          .catch(() => [])) as Array<{ pid: number; cmd: string; dir: string; started_at: number; log: string }>
        if (journal.length === 0) return []
        const alive = journal.filter((entry) => {
          try {
            process.kill(entry.pid, 0)
            return true
          } catch {
            return false
          }
        })
        if (alive.length !== journal.length) {
          await Bun.write(journalPath, JSON.stringify(alive, null, 2))
        }
        return alive.filter((entry) => entry.dir === ctx.directory)
      }).pipe(
        Effect.flatMap((orphans) =>
          orphans.length === 0
            ? Effect.void
            : Effect.logWarning("detached processes from a previous instance still alive", {
                orphans: orphans.map((o) => `pid ${o.pid}: ${o.cmd} (log: ${o.log})`),
              }),
        ),
        Effect.catchCause((cause) => Effect.logWarning("detached journal reconcile failed", { cause })),
      )
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Bus.layer,
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
    WaveLoop.defaultLayer,
  ]),
)

export * as InstanceBootstrap from "./bootstrap"
