import type { MiddlewareHandler } from "hono"
import { Effect } from "effect"
import { WithInstance } from "@/project/with-instance"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { AppRuntime } from "@/effect/app-runtime"
import { Session } from "@/session/session"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { getWorkspaceRouteSessionID, isSessionHomeRoute } from "@/server/shared/workspace-routing"

// A bare loop verb (no ?directory=, no x-opencode-directory) must land on
// the session's HOME instance — the loop runs on the instance that
// receives the POST, and a wrong-cwd lap is the dual-lap family's
// surviving residual. Same rule as the effect backend's workspace-routing
// middleware (parity mandate).
async function sessionHomeDirectory(method: string, url: URL): Promise<string | undefined> {
  if (!isSessionHomeRoute(method, url.pathname)) return undefined
  const sessionID = getWorkspaceRouteSessionID(url)
  if (!sessionID) return undefined
  return AppRuntime.runPromise(
    Session.Service.use((svc) => svc.get(sessionID)).pipe(
      Effect.map((session) => session.directory),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
  ).catch(() => undefined)
}

export function InstanceMiddleware(workspaceID?: WorkspaceID): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url)
    const raw =
      c.req.query("directory") ||
      c.req.header("x-opencode-directory") ||
      (await sessionHomeDirectory(c.req.method, url)) ||
      process.cwd()
    const directory = AppFileSystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    return WorkspaceContext.provide({
      workspaceID,
      async fn() {
        return WithInstance.provide({
          directory,
          async fn() {
            return next()
          },
        })
      },
    })
  }
}
