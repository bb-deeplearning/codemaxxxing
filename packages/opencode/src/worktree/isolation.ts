/* spawn isolation, the settle half (idea-worktrees, 2026-07-22).

   Registers AgentControl's checkout settler with the worktree-backed
   implementation. AgentControl deliberately never names the worktree
   services (the registerRunLoop precedent — function pointers over layer
   deps, so custom test layers stay cheap); this module is the production
   wiring for the other end of that pointer.

   What the settler does, at an isolated child's terminal status:
   - clean checkout (no commits ahead of the default branch, no dirt) →
     removed silently, branch included. Nothing to review, nothing to groom.
   - anything else → kept, and the returned line carries branch / commits
     ahead / dirt / +N -N so the completion notification tells the parent
     exactly what to merge, send back, or discard.

   Worktree service calls run under a SYNTHESIZED primary-instance ref (the
   project's main checkout) so primary-relative operations resolve correctly
   no matter which instance the completion watcher's fiber inherited. */

import { Context, Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { AgentControl } from "@/agent/control"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { makeRuntime } from "@/effect/run-service"
import { Worktree } from "."

const log = Log.create({ service: "worktree.isolation" })

export interface Interface {
  readonly registered: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeIsolation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    const worktree = yield* Worktree.Service
    const projects = yield* Project.Service

    yield* control.registerCheckoutSettler((isolation) =>
      Effect.gen(function* () {
        const diff = yield* worktree.diff({ directory: isolation.directory })
        if (diff.commits === 0 && !diff.dirty) {
          yield* worktree.remove({ directory: isolation.directory })
          yield* projects
            .removeSandbox(isolation.context.project.id, isolation.directory)
            .pipe(Effect.catch(() => Effect.void))
          log.info("isolated checkout removed clean", { directory: isolation.directory })
          return { line: "[checkout: clean — removed]", removed: true }
        }
        const bits = [
          isolation.branch ? `branch ${isolation.branch}` : "detached",
          `${diff.commits} commit${diff.commits === 1 ? "" : "s"} ahead of ${diff.base}`,
          diff.dirty ? "dirty" : "clean tree",
          `+${diff.additions} -${diff.deletions}`,
        ]
        log.info("isolated checkout kept", { directory: isolation.directory, branch: isolation.branch })
        return {
          line: `[checkout kept: ${bits.join(" · ")} — merge, send back, or discard: ${isolation.directory}]`,
          removed: false,
        }
      }).pipe(
        Effect.provideService(InstanceRef, {
          directory: isolation.context.project.worktree,
          worktree: isolation.context.project.worktree,
          project: isolation.context.project,
        }),
      ),
    )

    return Service.of({ registered: () => Effect.succeed(true) })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AgentControl.defaultLayer),
  Layer.provide(Worktree.appLayer),
  Layer.provide(Project.defaultLayer),
)

/* the facade runtime provides InstanceLayer itself; memoMap dedupes, so the
   AgentControl this registers into IS the one every route handler and tool
   uses. */
const { runPromise } = makeRuntime(Service, defaultLayer.pipe(Layer.provide(InstanceLayer.layer)))

/** Force the layer to construct. Services build lazily on first facade use
 * and NOTHING consumes WorktreeIsolation — without this call a serve
 * process never registers the settler and isolated checkouts are left in
 * place at terminal status (see GOTCHAS
 * `configreload-lazy-service-runtime-never-constructs`). Call once from
 * server boot; failures log, never block listen. */
export const init = () =>
  runPromise(() => Effect.void).catch((error) =>
    log.error("worktree isolation settler failed to register", { error: String(error) }),
  )

export * as WorktreeIsolation from "./isolation"
