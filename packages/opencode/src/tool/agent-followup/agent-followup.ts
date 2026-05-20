import { AgentControl } from "@/agent/control"
import DESCRIPTION from "./agent-followup.txt"
import { Effect, Result, Schema } from "effect"
import * as Tool from "../tool"
import { AgentPath } from "@/agent/agent-path"
import { AgentToolContext } from "../agents/current-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"

// followup_task — model-facing tool that queues a message into a sibling/child
// mailbox AND wakes the recipient (trigger_turn = true). Codex parity:
// codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs +
// shared message_tool.rs (lines 78-87 enforce the no-root-target rule).
//
// Differs from send_message only in the trigger_turn semantics. The reject-
// root check is the codex-mandated safety: root is the user-facing surface,
// not a worker, so it cannot be assigned tasks.

export const ID = "followup_task" as const
// Wave 3 (replace-bash-task-2026-05-15): per-call key collapsed onto "task"
// (mirror of EDIT_TOOLS — see agent-spawn.ts comment).
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({
    description:
      "Recipient agent. Either a bare task name like 'worker_b' (resolved relative to your current path) or a canonical path like '/root/explorers/worker_b' (absolute). Cannot be '/root' — tasks can't be assigned to root.",
  }),
  message: Schema.String.annotate({
    description:
      "The follow-up assignment for the recipient. They will receive this as the user input for their next turn and act on it. Be concrete: state what you want done and what you expect back. Empty / whitespace-only messages are rejected.",
  }),
  correlation_id: Schema.optional(Schema.String).annotate({
    description:
      "Optional correlation id pairing this followup with a future reply. When set, the recipient's `wait_for_reply` can target this id to wake only on the matching response. Omit for plain assignments.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const AgentFollowupTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return () =>
      Effect.succeed({
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
            Effect.gen(function* () {
              // 1. Reject empty / whitespace-only messages BEFORE any
              //    resolution — saves a registry round-trip on garbage input.
              //    Codex equivalent: message_tool.rs:49-56 (message_content).
              if (params.message.trim().length === 0) {
                return {
                  title: `followup_task ${params.target}`,
                  metadata: { error: "empty_message", target: params.target },
                  output: "Empty message can't be sent to an agent",
                }
              }

              const currentPath = yield* AgentToolContext.currentAgentPath(
                control,
                ctx.sessionID,
              )

              // 2. Resolve target. Wrap in Effect.result so AgentReferenceInvalidError
              //    becomes a model-recoverable string instead of a defect.
              //    See GOTCHAS effect-v4-either-renamed-to-result.
              const resolved = yield* Effect.result(
                control.resolveAgentReference(currentPath, params.target, ctx.sessionID),
              )
              if (Result.isFailure(resolved)) {
                return {
                  title: `followup_task ${params.target}`,
                  metadata: {
                    error: "reference_invalid",
                    target: params.target,
                    reason: resolved.failure.reason,
                  },
                  output: resolved.failure.message,
                }
              }
              const targetSessionID = resolved.success

              const targetMeta = yield* control.getAgentMetadata(targetSessionID)
              const targetPath = targetMeta?.agent_path

              // 3. Reject root target AFTER resolution, BEFORE ctx.ask. We
              //    don't want to ask permission for an action we'll refuse.
              //    Codex equivalent: message_tool.rs:78-87.
              if (targetPath !== undefined && AgentPath.isRoot(targetPath)) {
                return {
                  title: `followup_task ${params.target}`,
                  metadata: { error: "root_target", target: params.target },
                  output: "Tasks can't be assigned to the root agent",
                }
              }

              // 4. Permission gate. Pattern is the raw target string the
              //    model used so the user sees the same name they reviewed.
              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [params.target],
                always: ["*"],
                metadata: {
                  target: params.target,
                  message_length: params.message.length,
                },
              })

              // 5. Build and send. trigger_turn is true by definition — that's
              //    the entire point of followup_task vs send_message.
              //    sendInterAgentCommunication can only fail with
              //    AgentNotFoundError (missing mailbox). At this point we've
              //    just resolved the path against the live registry; the
              //    mailbox cannot disappear between those two synchronous
              //    steps, so the typed error is unreachable. We fold it into
              //    a defect via Effect.orDie rather than carrying a dead
              //    branch — the underlying invariant is in AgentControl.
              const comm = new InterAgentCommunication({
                author: currentPath,
                recipient: targetPath ?? AgentPath.root(),
                content: params.message,
                trigger_turn: true,
                sent_at: Date.now(),
                correlation_id: params.correlation_id,
              })

              yield* control
                .sendInterAgentCommunication(targetSessionID, comm, ctx.sessionID)
                .pipe(Effect.orDie)

              return {
                title: `followup_task ${params.target}`,
                metadata: {
                  target: params.target,
                  target_session_id: targetSessionID,
                  trigger_turn: true,
                  queued: true,
                },
                output: `Followup task queued for ${params.target} (will trigger next turn)`,
              }
            }),
      })
  }),
)

export * as AgentFollowup from "./agent-followup"
