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
import { Identifier } from "@/id/id"
import { Effect, Result, Schema, Stream, SubscriptionRef } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./agent-wait.txt"
import { DEFAULT_WAIT_TIMEOUT_MS, clampWaitTimeout } from "./constants"

export const ID = "wait_agent" as const
export const PermissionKey = "wait_agent" as const

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

function formatResult(timed_out: boolean, timeoutMs: number) {
  const message = timed_out ? "Wait timed out." : "Wait completed."
  return {
    title: "wait_agent",
    metadata: { timeout_ms: timeoutMs, timed_out, message },
    output: JSON.stringify({ message, timed_out }),
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
                return formatResult(true, timeoutMs)
              }

              // Codex wait.rs:82-87 — if pending items already exist, skip
              // the watch and return immediately with timed_out=false.
              const pending = yield* control.hasPendingMailboxItems(ctx.sessionID)
              if (pending) {
                yield* control.emitWaitEnded(ctx.sessionID, callID, false)
                return formatResult(false, timeoutMs)
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
              return formatResult(timedOut, timeoutMs)
            }),
    }
  }),
)

export * as AgentWait from "./agent-wait"
