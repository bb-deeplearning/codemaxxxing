import { AppRuntime } from "@/effect/app-runtime"
import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { Worktree } from "@/worktree"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const worktreeSvc = yield* Worktree.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* (ctx: { query: { worktrees?: boolean } }) {
      const projects = yield* svc.list()
      if (!ctx.query.worktrees) return projects
      return yield* Effect.forEach(
        projects,
        (row) =>
          row.vcs === "git"
            ? worktreeSvc.listAt(row.worktree).pipe(
                // catchCause, not catch: listAt THROWS NamedErrors (defects)
                // for stale/broken project rows, and one dead row must never
                // 500 the whole index.
                Effect.catchCause(() => Effect.succeed([] as Worktree.Info[])),
                Effect.map((worktrees) => ({ ...row, worktrees })),
              )
            : Effect.succeed({ ...row, worktrees: [] as Worktree.Info[] }),
        { concurrency: 4 },
      )
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID })
    })

    return handlers.handle("list", list).handle("current", current).handle("initGit", initGit).handle("update", update)
  }),
)
