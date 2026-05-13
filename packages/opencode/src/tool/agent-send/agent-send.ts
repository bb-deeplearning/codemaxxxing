import { AgentControl } from "@/agent/control"
import DESCRIPTION from "./agent-send.txt"
import { Effect, Result, Schema } from "effect"
import * as Tool from "../tool"
import { AgentPath } from "@/agent/agent-path"
import { AgentToolContext } from "../agents/current-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"

// send_message — model-facing tool that queues a plain-text message into
// another agent's mailbox WITHOUT triggering a turn (codex parity:
// MessageDeliveryMode::QueueOnly in
// codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs).
// Companion tool followup_task uses the same delivery path with
// trigger_turn=true.
//
// Flow:
//   1. Reject empty/whitespace-only messages up front (codex parity:
//      message_tool.rs:49-55).
//   2. Resolve the calling session to its canonical AgentPath (currentPath).
//   3. Resolve the target reference (relative or absolute) to a SessionID.
//   4. Ask permission with the shared `send_message` key, target as pattern.
//   5. Build an InterAgentCommunication with trigger_turn=false and route it
//      via AgentControl into the recipient's mailbox.
//   6. Map AgentControl typed errors into model-recoverable strings on the
//      output channel — the model can read the failure and adjust.

export const ID = "send_message" as const
export const PermissionKey = "send_message" as const

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({
    description:
      "Recipient agent. Bare task name ('worker_b') resolves relative to your current path; canonical path ('/root/explorers/worker_b') is absolute. Both resolve via the same path machinery used by spawn_agent and list_agents.",
  }),
  message: Schema.String.annotate({
    description:
      "Plain text body. Must contain at least one non-whitespace character. The recipient sees this as a message from you (no need to identify yourself in the body) at the start of their next turn.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const AgentSendTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return () =>
      Effect.succeed({
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
            Effect.gen(function* () {
              // 1. Empty-message guard (codex message_tool.rs:49-55).
              if (params.message.trim().length === 0) {
                return {
                  title: `send_message ${params.target}`,
                  metadata: { target: params.target, error: "empty_message" },
                  output: "Empty message can't be sent to an agent",
                }
              }

              // 2. Derive sender's canonical path. Idempotently registers
              //    the calling session as root if it isn't already in the
              //    registry.
              const currentPath = yield* AgentToolContext.currentAgentPath(
                control,
                ctx.sessionID,
              )

              // 3. Resolve target reference into a SessionID. A typed
              //    failure here is a user-visible "I couldn't find that
              //    agent" — surface it to the model rather than crashing.
              const resolved = yield* Effect.result(
                control.resolveAgentReference(currentPath, params.target),
              )
              if (Result.isFailure(resolved)) {
                return {
                  title: `send_message ${params.target}`,
                  metadata: {
                    target: params.target,
                    error: "target_not_found",
                  },
                  output: resolved.failure.message,
                }
              }
              const targetSessionID = resolved.success

              // 4. Ask permission. Pattern is the user-facing target string;
              //    the always-allow key is "*" so a single approval covers
              //    any future send_message to any sibling for this session.
              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [params.target],
                always: ["*"],
                metadata: {
                  target: params.target,
                  message_length: params.message.length,
                },
              })

              // 5. Resolve recipient's canonical path from metadata. Falls
              //    back to AgentPath.root() for the (rare) root recipient
              //    case where metadata may lack a path.
              const targetMeta = yield* control.getAgentMetadata(targetSessionID)
              const recipientPath = targetMeta?.agent_path ?? AgentPath.root()

              const comm = new InterAgentCommunication({
                author: currentPath,
                recipient: recipientPath,
                content: params.message,
                trigger_turn: false,
                sent_at: Date.now(),
              })

              const sendResult = yield* Effect.result(
                control.sendInterAgentCommunication(targetSessionID, comm),
              )
              if (Result.isFailure(sendResult)) {
                return {
                  title: `send_message ${params.target}`,
                  metadata: {
                    target: params.target,
                    target_session_id: targetSessionID,
                    error: "send_failed",
                  },
                  output: sendResult.failure.message,
                }
              }

              return {
                title: `send_message ${params.target}`,
                metadata: {
                  target: params.target,
                  target_session_id: targetSessionID,
                  queued: true,
                },
                output: `Message queued for ${params.target}`,
              }
            }),
      })
  }),
)

export * as AgentSend from "./agent-send"
