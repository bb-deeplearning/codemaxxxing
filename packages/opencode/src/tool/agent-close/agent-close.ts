import { Effect, Result, Schema } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import * as Tool from "../tool"
import { AgentToolContext } from "../agents/current-path"
import DESCRIPTION from "./agent-close.txt"

// close_agent — model-facing tool to shut down a spawned subagent (and its
// descendants). Mirrors codex
// codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs.
//
// Operating order (matches codex close_agent.rs:37-50):
//   1. Resolve the target via AgentControl.resolveAgentReference. Rejects
//      with a model-recoverable string when the reference is invalid (root
//      not registered, path malformed, no such live agent).
//   2. Reject root explicitly. Root is the user's session; closing it would
//      end the conversation. Codex returns
//      `FunctionCallError::RespondToModel("root is not a spawned agent")`;
//      we mirror the model-facing wording.
//   3. ctx.ask permission with key `close_agent`. Per
//      MESSAGE_SHAPES.md, the permission key matches the tool name.
//   4. Call AgentControl.closeAgent — the cascade to descendants happens
//      inside that method; this tool is one call.
//
// Return shape: `{ previous_status }`, the status the target held just
// before close. Codex multi_agents_spec.rs:465-477 spec.

export const ID = "close_agent" as const
export const PermissionKey = "close_agent" as const

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({
    description:
      "Agent to close. Relative path from your current location (e.g. `worker_a`) or canonical absolute path (e.g. `/root/explorers/worker_a`). Cannot be `/root` — root is your session and is rejected.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const AgentCloseTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
            Effect.gen(function* () {
              const currentPath = yield* AgentToolContext.currentAgentPath(
                control,
                ctx.sessionID,
              )

              const resolved = yield* control
                .resolveAgentReference(currentPath, params.target)
                .pipe(Effect.result)
              if (Result.isFailure(resolved)) {
                return {
                  title: `close_agent ${params.target}`,
                  metadata: {
                    error: "invalid_target",
                    target: params.target,
                    reason: resolved.failure.reason,
                  },
                  output: resolved.failure.message,
                }
              }
              const targetID = resolved.success
              const meta = yield* control.getAgentMetadata(targetID)

              // Reject root explicitly. Mirrors codex close_agent.rs:43-51.
              if (meta?.agent_path !== undefined && AgentPath.isRoot(meta.agent_path)) {
                return {
                  title: `close_agent ${params.target}`,
                  metadata: { error: "root_target", target: params.target },
                  output: "root is not a spawned agent",
                }
              }

              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [params.target],
                always: ["*"],
                metadata: { target: params.target, target_session_id: targetID },
              })

              // After a successful resolveAgentReference + non-root check, the
              // target is in the registry. AgentControl.closeAgent only fails
              // with AgentNotFoundError (resolve already proved otherwise) or
              // root rejection (handled above), so it can't fail here. Fold
              // the impossible typed error into a defect via Effect.orDie.
              const { previous_status } = yield* control.closeAgent(targetID).pipe(Effect.orDie)
              return {
                title: `close_agent ${params.target}`,
                metadata: {
                  target: params.target,
                  target_session_id: targetID,
                  previous_status,
                },
                output: JSON.stringify({ previous_status }),
              }
            }),
    }
  }),
)

export * as AgentClose from "./agent-close"
