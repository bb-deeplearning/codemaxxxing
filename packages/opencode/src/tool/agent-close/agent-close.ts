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
// Wave 3 (replace-bash-task-2026-05-15): per-call key collapsed onto "task"
// (mirror of EDIT_TOOLS — see agent-spawn.ts comment).
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  // D3 (actor-discipline-2026-05-20) — target is OPTIONAL. When omitted (or
  // explicitly undefined), the tool resolves to the caller's canonical path
  // (self-close). The model frequently knows it wants to close itself but
  // doesn't know its own canonical path; making `target` optional removes
  // the failure mode where the model passes `agent_type` instead.
  target: Schema.optional(
    Schema.String.annotate({
      description:
        "Agent to close. Relative path from your current location (e.g. `worker_a`) or canonical absolute path (e.g. `/root/explorers/worker_a`). Cannot be `/root` — root is your session and is rejected. Omit to close the caller (self-close).",
    }),
  ),
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
              // D3 (actor-discipline-2026-05-20) — self-close when target
              // is omitted. The caller's canonical path is the target.
              // String() encodes the AgentPath brand back to its "/root/..."
              // form so resolveAgentReference can match it absolutely.
              const target = params.target ?? String(currentPath)

              const resolved = yield* control
                .resolveAgentReference(currentPath, target, ctx.sessionID)
                .pipe(Effect.result)
              if (Result.isFailure(resolved)) {
                // D9 (actor-discipline-2026-05-20) — split failed
                // resolution into `already_terminated` (path was once
                // registered under this root, now released) vs
                // `path_invalid` (path was never registered). The
                // already_terminated branch is the success case from the
                // model's perspective — a re-close on a self-terminated
                // child should look like a no-op, not an error.
                const resolvedPath = yield* AgentPath.resolve(currentPath, target).pipe(
                  Effect.result,
                )
                const wasKnown = Result.isSuccess(resolvedPath)
                  ? yield* control.wasKnownPath(ctx.sessionID, resolvedPath.success)
                  : false
                if (wasKnown) {
                  return {
                    title: `close_agent ${target}`,
                    metadata: {
                      error: "already_terminated",
                      target,
                      previous_status: "shutdown",
                    },
                    output: JSON.stringify({
                      error: "already_terminated",
                      previous_status: "shutdown",
                    }),
                  }
                }
                return {
                  title: `close_agent ${target}`,
                  metadata: {
                    error: "path_invalid",
                    target,
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
                  title: `close_agent ${target}`,
                  metadata: { error: "root_target", target },
                  output: "root is not a spawned agent",
                }
              }

              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [target],
                always: ["*"],
                metadata: { target, target_session_id: targetID },
              })

              // After a successful resolveAgentReference + non-root check, the
              // target is in the registry. AgentControl.closeAgent only fails
              // with AgentNotFoundError (resolve already proved otherwise) or
              // root rejection (handled above), so it can't fail here. Fold
              // the impossible typed error into a defect via Effect.orDie.
              //
              // Pass `ctx.sessionID` as the caller so the completion watcher
              // only suppresses its notification when the caller is the
              // target's strict ancestor. A self-close (caller === target) or
              // a sibling-/descendant-close therefore wakes the target's
              // parent's wait_agent instead of leaving it to time out — the
              // bug demoed at ses_1ce9356abffep1L0TvDbD80uUO.
              const { previous_status } = yield* control
                .closeAgent(targetID, ctx.sessionID)
                .pipe(Effect.orDie)
              return {
                title: `close_agent ${target}`,
                metadata: {
                  target,
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
