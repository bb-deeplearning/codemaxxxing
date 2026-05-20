// wait_agent — model-facing tool that blocks the calling agent's tool call
// (not the whole loop) on its mailbox seq watch. Codex parity:
// codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs.
//
// Behavior:
//   - Validate timeout_ms (>0) and clamp into [MIN, MAX].
//   - Ask permission with the shared "wait_agent" key.
//   - If the calling session has no mailbox (e.g. root before children are
//     spawned), fall back to a plain sleep-then-timeout — graceful
//     degradation instead of a typed error.
//   - If the mailbox already holds queued items, return immediately with
//     timed_out=false.
//   - Otherwise race a SubscriptionRef.changes stream against the timeout.
//     Whichever wins decides timed_out.
//
// Wave 10: a paired Wait.Started / Wait.Ended event surfaces on the bus
// around the body so subscribers (TUI, plugins) see when an agent is
// blocked. Emission goes through AgentControl.emitWait* so the lifecycle is
// centralized in one service.
//
// The return body is a SUMMARY string ("Wait timed out." / "Wait completed.")
// — not the mail content. Wave 9's runLoop drains the actual mail before the
// next turn so the model reads it then.

import { AgentControl } from "@/agent/control"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { Identifier } from "@/id/id"
import { Effect, Option, Result, Schema, Stream, SubscriptionRef } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./agent-wait.txt"
import WAIT_FOR_REPLY_DESCRIPTION from "./wait-for-reply.txt"
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, clampWaitTimeout } from "./constants"

export const ID = "wait_agent" as const
// Wave 3 (replace-bash-task-2026-05-15): per-call key collapsed onto "task"
// (mirror of EDIT_TOOLS — see agent-spawn.ts comment).
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  // Codex's WaitArgs uses i64 — the >0 check happens in the handler body so
  // the model receives a model-recoverable RespondToModel error, not a hard
  // schema rejection. We mirror that: accept any integer, validate inside.
  timeout_ms: Schema.optional(Schema.Int).annotate({
    description:
      "How long (ms) to block waiting for a mailbox update. Defaults to 30000. Clamped to [1000, 600000]. A non-positive value returns a model-recoverable error.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// D10 (actor-discipline-2026-05-20 Wave 3) — when warning is set, the
// metadata.warning field tags either "missing_timeout" (caller omitted
// timeout_ms) or "timeout_clamped" (caller specified a value above the
// max cap). The call still completes normally — informational only.
function formatResult(timed_out: boolean, timeoutMs: number, warning?: string) {
  const message = timed_out ? "Wait timed out." : "Wait completed."
  const metadata: Record<string, unknown> = { timeout_ms: timeoutMs, timed_out, message }
  if (warning) metadata.warning = warning
  const payload: Record<string, unknown> = { message, timed_out }
  if (warning) payload.warning = warning
  return {
    title: "wait_agent",
    metadata,
    output: JSON.stringify(payload),
  }
}

export const AgentWaitTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
            Effect.gen(function* () {
              const requested = params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS
              if (requested <= 0) {
                return {
                  title: "wait_agent",
                  metadata: {
                    error: "invalid_timeout",
                    timeout_ms: requested,
                  },
                  output: "timeout_ms must be greater than zero",
                }
              }
              // D10 (actor-discipline-2026-05-20 Wave 3) — mandatory-timeout
              // doctrine. Missing or above-cap timeouts emit a warning tag
              // in the result; the call still completes normally.
              const warning =
                params.timeout_ms === undefined
                  ? "missing_timeout"
                  : requested > MAX_WAIT_TIMEOUT_MS
                    ? "timeout_clamped"
                    : undefined
              const timeoutMs = clampWaitTimeout(requested)

              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [`timeout:${timeoutMs}`],
                always: ["*"],
                metadata: { timeout_ms: timeoutMs },
              })

              // Stable lifecycle id pairing Wait.Started ↔ Wait.Ended.
              // Use ctx.callID when present (real tool invocation); generate
              // an ascending id when absent (test contexts pass "").
              const callID = ctx.callID && ctx.callID.length > 0
                ? ctx.callID
                : Identifier.create("wait", "ascending")

              yield* control.emitWaitStarted(ctx.sessionID, callID, timeoutMs)

              // Subscribe to the mailbox seq for the calling session.
              // Root and other not-yet-mailboxed sessions return
              // AgentNotFoundError — fall back to a plain sleep + timed_out
              // so the model gets a sensible answer rather than an error.
              const seqRef = yield* Effect.result(
                control.subscribeMailboxSeq(ctx.sessionID),
              )
              if (Result.isFailure(seqRef)) {
                yield* Effect.sleep(`${timeoutMs} millis`)
                yield* control.emitWaitEnded(ctx.sessionID, callID, true)
                return formatResult(true, timeoutMs, warning)
              }

              // Codex wait.rs:82-87 — if pending items already exist, skip
              // the watch and return immediately with timed_out=false.
              const pending = yield* control.hasPendingMailboxItems(ctx.sessionID)
              if (pending) {
                yield* control.emitWaitEnded(ctx.sessionID, callID, false)
                return formatResult(false, timeoutMs, warning)
              }

              // Race: next mailbox seq change vs timeout. SubscriptionRef.changes
              // emits the current value first, so drop(1) skips it and we wait
              // for the next update only.
              const changesEffect = Stream.runDrain(
                SubscriptionRef.changes(seqRef.success).pipe(Stream.drop(1), Stream.take(1)),
              ).pipe(Effect.map(() => "changed" as const))

              const timeoutEffect = Effect.sleep(`${timeoutMs} millis`).pipe(
                Effect.map(() => "timeout" as const),
              )

              const outcome = yield* Effect.raceAll([changesEffect, timeoutEffect])
              const timedOut = outcome === "timeout"
              yield* control.emitWaitEnded(ctx.sessionID, callID, timedOut)
              return formatResult(timedOut, timeoutMs, warning)
            }),
    }
  }),
)

// D10 (actor-discipline-2026-05-20 Wave 3) — wait_for_reply variant.
// Targeted wait on a specific correlation_id. Wakes only when a mailbox
// message carrying the matching id arrives (or is already pending);
// non-matching messages advance seq but do NOT satisfy the filter.
export const WaitForReplyID = "wait_for_reply" as const

export const WaitForReplyParameters = Schema.Struct({
  correlation_id: Schema.String.annotate({
    description:
      "The correlation_id this wait targets. Wakes ONLY when a mailbox message carrying this exact id arrives (or is already pending). Set by send_message/followup_task's correlation_id parameter on the upstream request.",
  }),
  timeout_ms: Schema.optional(Schema.Int).annotate({
    description:
      "How long (ms) to wait for a matching reply. Defaults to 30000. Clamped to [1000, 600000]. A non-positive value returns a model-recoverable error.",
  }),
})

export type WaitForReplyParameters = Schema.Schema.Type<typeof WaitForReplyParameters>

function formatReplyResult(
  msg: InterAgentCommunication | undefined,
  timeoutMs: number,
  correlation_id: string,
) {
  if (msg) {
    return {
      title: `wait_for_reply ${correlation_id}`,
      metadata: { correlation_id, timeout_ms: timeoutMs, timed_out: false, matched: true },
      output: JSON.stringify({
        message: msg.content,
        timed_out: false,
        correlation_id,
        author: String(msg.author),
      }),
    }
  }
  return {
    title: `wait_for_reply ${correlation_id}`,
    metadata: { correlation_id, timeout_ms: timeoutMs, timed_out: true, matched: false },
    output: JSON.stringify({
      message: "No reply received before timeout.",
      timed_out: true,
      correlation_id,
    }),
  }
}

export const AgentWaitForReplyTool = Tool.define(
  WaitForReplyID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return {
      description: WAIT_FOR_REPLY_DESCRIPTION,
      parameters: WaitForReplyParameters,
      execute: (params: WaitForReplyParameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const requested = params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS
          if (requested <= 0) {
            return {
              title: `wait_for_reply ${params.correlation_id}`,
              metadata: {
                error: "invalid_timeout",
                timeout_ms: requested,
                correlation_id: params.correlation_id,
              },
              output: "timeout_ms must be greater than zero",
            }
          }
          const timeoutMs = clampWaitTimeout(requested)

          yield* ctx.ask({
            permission: PermissionKey,
            patterns: [`correlation:${params.correlation_id}`],
            always: ["*"],
            metadata: {
              correlation_id: params.correlation_id,
              timeout_ms: timeoutMs,
            },
          })

          // Fast path: matching message already queued.
          const already = yield* control.findMailboxByCorrelationId(
            ctx.sessionID,
            params.correlation_id,
          )
          if (already) return formatReplyResult(already, timeoutMs, params.correlation_id)

          // Subscribe to seq changes. AgentNotFoundError → root with no
          // mailbox → fall through to timeout (same shape as wait_agent).
          const seqRef = yield* Effect.result(
            control.subscribeMailboxSeq(ctx.sessionID),
          )
          if (Result.isFailure(seqRef)) {
            yield* Effect.sleep(`${timeoutMs} millis`)
            return formatReplyResult(undefined, timeoutMs, params.correlation_id)
          }

          // Race: each seq change re-scans the mailbox for a matching
          // correlation_id; on match we return. Other messages (no
          // correlation_id, or different correlation_id) advance seq but
          // do not satisfy the filter — the loop continues until either a
          // matching message arrives or the timer fires.
          const stream = SubscriptionRef.changes(seqRef.success).pipe(Stream.drop(1))
          const filterEffect = Stream.runHead(
            stream.pipe(
              Stream.mapEffect(() =>
                control.findMailboxByCorrelationId(ctx.sessionID, params.correlation_id),
              ),
              Stream.filter((m): m is InterAgentCommunication => m !== undefined),
            ),
          ).pipe(Effect.map((opt) => ({ kind: "matched" as const, msg: Option.getOrUndefined(opt) })))

          const timeoutEffect = Effect.sleep(`${timeoutMs} millis`).pipe(
            Effect.map(() => ({ kind: "timeout" as const })),
          )

          const outcome = yield* Effect.raceAll([filterEffect, timeoutEffect])
          if (outcome.kind === "matched") {
            return formatReplyResult(outcome.msg, timeoutMs, params.correlation_id)
          }
          return formatReplyResult(undefined, timeoutMs, params.correlation_id)
        }),
    }
  }),
)

export * as AgentWait from "./agent-wait"
