// write_stdin — model-facing tool that writes input to a process spawned by
// exec_command and returns recent output. Codex parity:
// codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs.
//
// Permission caching: write_stdin shares permission key `exec_command` with
// the spawn tool. The first exec_command call registers `pid:<process_id>`
// as an "always" pattern; subsequent write_stdin calls evaluate the same
// permission with that pattern and find the always-allow rule, so no
// re-prompt fires per process.

import { Pty } from "@/pty"
import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { ProcessSessions } from "./sessions"
import { PermissionKey, WriteStdinID, pidPattern } from "./id"
import { WRITE_STDIN_PROMPT } from "./prompt"
import {
  DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
  POST_WRITE_STDIN_SLEEP_MS,
  approxTokenCount,
  clampEmptyPollYieldTime,
  clampWriteYieldTime,
} from "./constants"
import { PositiveInt } from "@/util/schema"

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
    description: "Cap returned output length. Excess truncates head+tail.",
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

              // Non-empty input requires a TTY (codex parity:
              // process_manager.rs:619-621 returns StdinClosed). Pure polls
              // work either way — the model can still drain output from a
              // non-tty session.
              const start = Date.now()
              if (chars.length > 0) {
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

              const yieldTimeMs =
                chars.length === 0 ? clampEmptyPollYieldTime(requestedYield) : clampWriteYieldTime(requestedYield)
              const read = yield* pty.read(session.ptyId, session.cursor, yieldTimeMs, 1024 * 1024)
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

              yield* sessions.setCursor(params.session_id, read.cursor)
              const decoded = new TextDecoder().decode(read.output)
              const exited = read.exited
              if (exited) yield* sessions.remove(params.session_id)

              const metadata: Record<string, unknown> = {
                wall_time_seconds: wallMs / 1000,
                original_token_count: approxTokenCount(decoded),
                ...(exited && read.exitCode !== undefined
                  ? { exit_code: read.exitCode }
                  : { session_id: params.session_id }),
              }

              return {
                title: `write_stdin ${params.session_id}`,
                metadata,
                output: decoded || "(no output)",
              }
            }),
        }
      })
  }),
)
