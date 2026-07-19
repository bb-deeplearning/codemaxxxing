import { Config } from "@/config/config"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([...BusEvent.effectPayloads(), ...SyncEvent.effectPayloads()]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

export const GlobalFsQuery = Schema.Struct({
  path: Schema.optional(Schema.String),
})

const GlobalFsEntry = Schema.Struct({
  name: Schema.String,
  absolute: Schema.String,
  hidden: Schema.Boolean,
})

const GlobalFsListing = Schema.Struct({
  path: Schema.String,
  parent: Schema.NullOr(Schema.String),
  home: Schema.String,
  entries: Schema.Array(GlobalFsEntry),
}).annotate({ identifier: "GlobalFsListing" })

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  fs: "/global/fs",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  reload: "/global/reload",
  restart: "/global/restart",
} as const

const GlobalReloadResult = Schema.Struct({
  instances: Schema.Number,
})

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("fs", GlobalPaths.fs, {
        query: GlobalFsQuery,
        success: described(GlobalFsListing, "Directory listing"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.fs.list",
          summary: "List directories",
          description:
            "List the subdirectories of a directory on the server host. Defaults to the server user's home directory. Read-only; directories only.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(Config.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: Config.Info,
        success: described(Config.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version or latest if not specified.",
        }),
      ),
      HttpApiEndpoint.post("reload", GlobalPaths.reload, {
        success: described(GlobalReloadResult, "Reload result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.reload",
          summary: "Reload config, skills, and MCP servers",
          description:
            "Flush every config-derived cache (skills, MCP, providers, agents) on all live instances and rescan from disk. MCP and LSP servers reconnect. Sessions and PTYs are untouched.",
        }),
      ),
      HttpApiEndpoint.post("restart", GlobalPaths.restart, {
        success: described(Schema.Boolean, "Restart scheduled"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.restart",
          summary: "Restart the serve process",
          description:
            "Respond, dispose instances cleanly, then exit; the process supervisor relaunches the serve. In-flight turns on this host abort. Clients resync over SSE.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
