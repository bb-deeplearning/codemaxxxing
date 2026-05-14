// list_agents — model-facing tool that returns a snapshot of every live
// agent in the session tree. Codex parity:
// codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs +
// codex-rs/core/src/tools/handlers/multi_agents_spec.rs:234-253 (schema)
// + :384-414 (output schema).
//
// Flow:
//   1. Resolve calling session to its canonical AgentPath (lazy-registers
//      the calling session as root if absent — same pattern as every other
//      multi-agent v2 tool).
//   2. Ask permission with shared `list_agents` key, prefix as pattern.
//   3. Delegate to AgentControl.listAgents which already handles the
//      relative-vs-canonical prefix resolution and the path-prefix filter.
//   4. Encode result.success as `{ agents: [{agent_name, agent_status,
//      last_task_message: string | null}] }` JSON to match codex's output
//      schema verbatim. last_task_message is normalised to null when the
//      registry has no message for an entry — codex marks the field
//      required so we never emit `undefined`.
//   5. Map AgentPathInvalidError into a model-recoverable shape so the
//      model can fix its prefix and retry.

import { AgentControl } from "@/agent/control"
import { Effect, Result, Schema } from "effect"
import * as Tool from "../tool"
import { AgentToolContext } from "../agents/current-path"
import DESCRIPTION from "./agent-list.txt"

export const ID = "list_agents" as const
// Wave 3 (replace-bash-task-2026-05-15): per-call key collapsed onto "task"
// (mirror of EDIT_TOOLS — see agent-spawn.ts comment).
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  path_prefix: Schema.optional(Schema.String).annotate({
    description:
      "Optional task-path prefix to scope the result. Bare task name ('worker_b') resolves relative to your current path; canonical path ('/root/explorers') is absolute. No trailing slash. Omit to list every agent in the tree (root included).",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const AgentListTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const currentPath = yield* AgentToolContext.currentAgentPath(control, ctx.sessionID)

          yield* ctx.ask({
            permission: PermissionKey,
            patterns: [params.path_prefix ?? "*"],
            always: ["*"],
            metadata: { path_prefix: params.path_prefix ?? null },
          })

          const result = yield* Effect.result(
            control.listAgents(currentPath, ctx.sessionID, params.path_prefix),
          )
          if (Result.isFailure(result)) {
            return {
              title: "list_agents",
              metadata: {
                error: "invalid_prefix",
                reason: result.failure.reason,
                path_prefix: params.path_prefix ?? null,
              },
              output: result.failure.message,
            }
          }

          const agents = result.success.map((a) => ({
            agent_name: a.agent_name,
            agent_status: a.agent_status,
            last_task_message: a.last_task_message ?? null,
          }))

          return {
            title: `list_agents (${agents.length})`,
            metadata: {
              agent_count: agents.length,
              path_prefix: params.path_prefix ?? null,
            },
            output: JSON.stringify({ agents }),
          }
        }),
    }
  }),
)

export * as AgentList from "./agent-list"
