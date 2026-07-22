import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Project } from "@/project/project"
import { Worktree } from "@/worktree"
import z from "zod"
import { ProjectID } from "@/project/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest, runRequest } from "./trace"

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description:
          "Get a list of projects that have been opened with OpenCode. Pass worktrees=true to fold each git project's live worktrees (name, directory, branch) into the response — the unified projects+worktrees index.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    Project.Info.zod.and(
                      z.object({ worktrees: z.array(Worktree.Info.zod).optional() }).meta({ ref: "ProjectWorktrees" }),
                    ),
                  ),
                ),
              },
            },
          },
        },
      }),
      validator("query", z.object({ worktrees: z.enum(["true", "false"]).optional() })),
      async (c) => {
        const projects = Project.list()
        if (c.req.valid("query").worktrees !== "true") return c.json(projects)
        const enriched = await runRequest(
          "ProjectRoutes.list",
          c,
          Worktree.Service.use((svc) =>
            Effect.forEach(
              projects,
              (row) =>
                row.vcs === "git"
                  ? svc.listAt(row.worktree).pipe(
                      // catchCause, not catch: listAt THROWS NamedErrors
                      // (defects) for stale/broken project rows, and one
                      // dead row must never 500 the whole index.
                      Effect.catchCause(() => Effect.succeed([] as Worktree.Info[])),
                      Effect.map((worktrees) => ({ ...row, worktrees })),
                    )
                  : Effect.succeed({ ...row, worktrees: [] as Worktree.Info[] }),
              { concurrency: 4 },
            ),
          ),
        )
        return c.json(enriched)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await runRequest(
          "ProjectRoutes.initGit",
          c,
          Project.Service.use((svc) => svc.initGit({ directory: dir, project: prev })),
        )
        if (next.id === prev.id && next.vcs === prev.vcs && next.worktree === prev.worktree) return c.json(next)
        await InstanceRuntime.reloadInstance({ directory: dir, worktree: dir, project: next })
        return c.json(next)
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) =>
        jsonRequest("ProjectRoutes.update", c, function* () {
          const projectID = c.req.valid("param").projectID
          const body = c.req.valid("json")
          const svc = yield* Project.Service
          return yield* svc.update({ ...body, projectID })
        }),
    ),
)
