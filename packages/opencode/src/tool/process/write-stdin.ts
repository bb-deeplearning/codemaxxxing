// write_stdin — model-facing tool that writes input to a process spawned by
// exec_command and returns recent output. Codex parity:
// codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs.
//
// Permission caching: write_stdin shares permission key `bash` with the
// spawn tool (Wave 2 of replace-bash-task-2026-05-15 collapsed both onto
// the legacy bash key so saved `permission.bash` rules transparently
// gate the unified_exec family). The first exec_command call registers
// `pid:<process_id>` as an "always" pattern under bash; subsequent
// write_stdin calls evaluate the same permission with that pattern and
// find the always-allow rule, so no re-prompt fires per process.

import { Pty } from "@/pty"
import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { ProcessSessions } from "./sessions"
import { PermissionKey, WriteStdinID, pidPattern } from "./id"
import { WRITE_STDIN_PROMPT } from "./prompt"
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
  POST_WRITE_STDIN_SLEEP_MS,
  approxTokenCount,
  clampEmptyPollYieldTime,
  clampWriteYieldTime,
  formatExecResponse,
  stripAnsi,
  truncateHeadTail,
} from "./constants"
import { NonNegativeInt, PositiveInt } from "@/util/schema"

export const Parameters = Schema.Struct({
  session_id: PositiveInt.annotate({
    description:
      "Identifier of the running unified exec session, returned by an earlier exec_command call. Pass the same number to continue interacting with the spawned process.",
  }),
  chars: Schema.optional(Schema.String).annotate({
    description:
      "Bytes to write to stdin. Empty (or omitted) makes the call a pure poll: no input is sent, the call simply waits for new output.",
  }),
  yield_time_ms: Schema.optional(PositiveInt).annotate({
    description:
      "How long to wait (ms) for output before returning. For non-empty chars: clamped to [250, 30000]. For empty polls: clamped to [5000, 300000] — pure polls have a 5-second floor that prevents spam-polling.",
  }),
  max_output_tokens: Schema.optional(PositiveInt).annotate({
    description: "Cap returned output length. Excess truncates head+tail with an explicit elision marker.",
  }),
  since_cursor: Schema.optional(NonNegativeInt).annotate({
    description:
      "Non-destructive range re-read: return retained buffer bytes from this cursor instead of the session's live cursor, immediately (no yield wait), without advancing the live cursor. Use the cursor_start/cursor_end metadata from earlier calls to target elided output.",
  }),
  strip_ansi: Schema.optional(Schema.Boolean).annotate({
    description:
      "Strip ANSI escape sequences (colors, spinners, cursor control) from the captured output. Raw bytes stay in the session buffer. Defaults to false.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const WriteStdinTool = Tool.define(
  WriteStdinID.ToolID,
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const sessions = yield* ProcessSessions.Service

    return () =>
      Effect.gen(function* () {
        return {
          description: WRITE_STDIN_PROMPT,
          parameters: Parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const session = yield* sessions.get(params.session_id)
              if (!session) {
                return {
                  title: `write_stdin ${params.session_id}`,
                  metadata: { session_id: params.session_id, error: "unknown_session" },
                  output: `Unknown process id ${params.session_id}`,
                }
              }

              // Confirm the underlying PTY is still alive and gather current
              // tty status. If it was pruned by the LRU pool between calls
              // the sessions.get above would normally have already dropped
              // the entry via the Pty.Event.Deleted subscription, but a race
              // is possible — check defensively here too.
              const ptyInfo = yield* pty.get(session.ptyId)
              if (!ptyInfo) {
                yield* sessions.remove(params.session_id)
                return {
                  title: `write_stdin ${params.session_id}`,
                  metadata: { session_id: params.session_id, error: "unknown_session" },
                  output: `Unknown process id ${params.session_id}`,
                }
              }

              const chars = params.chars ?? ""
              const requestedYield = params.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS
              const processExited = ptyInfo.status === "exited"

              // Re-evaluate permission. The pid-pattern registered by the
              // initial exec_command's `always` will satisfy this without
              // re-prompting; if the user picked "once" then this asks
              // afresh. Pass the same `pid:<id>` always-pattern so the
              // user's "always" choice here also caches per-process.
              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [pidPattern(params.session_id)],
                always: [pidPattern(params.session_id)],
                metadata: {
                  session_id: params.session_id,
                  chars_length: chars.length,
                },
              })

              const start = Date.now()
              let note: string | undefined
              if (chars.length > 0 && processExited) {
                // Truthfulness: the old path answered "stdin is closed;
                // rerun with tty=true" for processes that were simply dead —
                // wrong diagnosis AND wrong remedy. Skip the write, fall
                // through to a drain, and report the exit honestly.
                note = "Input not delivered: process had already exited."
              }
              if (chars.length > 0 && !processExited) {
                // Non-empty input requires a TTY (codex parity:
                // process_manager.rs:619-621 returns StdinClosed). Pure polls
                // work either way — the model can still drain output from a
                // non-tty session.
                if (!session.tty) {
                  return {
                    title: `write_stdin ${params.session_id}`,
                    metadata: {
                      session_id: params.session_id,
                      error: "stdin_closed",
                      wall_time_seconds: (Date.now() - start) / 1000,
                    },
                    output: "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
                  }
                }
                yield* pty.write(session.ptyId, chars)
                yield* Effect.sleep(`${POST_WRITE_STDIN_SLEEP_MS} millis`)
              }

              // Range re-reads return already-retained bytes: no collect
              // window, no clamp floor, no cursor advance. Live polls keep
              // the clamped collect-until-deadline semantics.
              const rangeRead = params.since_cursor !== undefined
              const startCursor = params.since_cursor ?? session.cursor
              const yieldTimeMs = rangeRead
                ? 0
                : chars.length === 0
                  ? clampEmptyPollYieldTime(requestedYield)
                  : clampWriteYieldTime(requestedYield)
              const read = yield* pty.read(session.ptyId, startCursor, yieldTimeMs, 1024 * 1024)
              const wallMs = Date.now() - start

              if (!read) {
                yield* sessions.remove(params.session_id)
                return {
                  title: `write_stdin ${params.session_id}`,
                  metadata: {
                    session_id: params.session_id,
                    error: "unknown_session",
                    wall_time_seconds: wallMs / 1000,
                  },
                  output: `Unknown process id ${params.session_id}`,
                }
              }

              if (!rangeRead) yield* sessions.setCursor(params.session_id, read.cursor)
              const decodedRaw = new TextDecoder().decode(read.output)
              const decoded = params.strip_ansi ? stripAnsi(decodedRaw) : decodedRaw
              const exited = read.exited
              // Exited sessions are NOT removed here: the entry stays for
              // since_cursor range re-reads until the LRU pruner (or the
              // Pty.Event.Deleted subscription in sessions.ts) reclaims it.
              // Repeat polls of a dead session are idempotent — exit_code
              // plus whatever remains past the cursor.

              const original_token_count = approxTokenCount(decoded)
              const capped = truncateHeadTail(decoded, params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS)
              const metadata: Record<string, unknown> = {
                wall_time_seconds: wallMs / 1000,
                original_token_count,
                session_id: params.session_id,
                cursor_start: startCursor,
                cursor_end: read.cursor,
                ...(rangeRead ? { range_read: true } : {}),
                ...(capped.omittedBytes > 0 ? { omitted_bytes: capped.omittedBytes } : {}),
                ...(note ? { input_not_delivered: true } : {}),
                ...(exited && read.exitCode !== undefined ? { exit_code: read.exitCode } : {}),
              }

              return {
                title: `write_stdin ${params.session_id}`,
                metadata,
                output: formatExecResponse({
                  wallMs,
                  output: capped.text,
                  originalTokenCount: original_token_count,
                  exitCode: exited && read.exitCode !== undefined ? read.exitCode : undefined,
                  sessionId: params.session_id,
                  note,
                }),
              }
            }),
        }
      })
  }),
)
