// exec_command — model-facing persistent-PTY spawn tool. Codex parity:
// codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs.
//
// Operating order matches the WAVE.md gotcha #1: allocate the PTY first
// (cheap), then `ctx.ask` with `pid:<id>` registered as the always-pattern,
// then on rejection tear the PTY down. On approval, subsequent write_stdin
// calls evaluate `bash` permission with pattern `pid:<id>` and find the
// always-allow rule from this approval — no re-prompt per process.
//
// Wave 2 (replace-bash-task-2026-05-15): the permission ask now goes
// through `ShellScan.askForScan` so saved `permission.bash` rules — built
// up over months on the legacy bash tool — gate `exec_command` the same
// way they always have for `bash`. The `pid:<id>` always-rule is appended
// to the AST-derived `always` set via `extraAlways`.

import { Plugin } from "@/plugin"
import { Pty } from "@/pty"
import { Effect, Exit, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Shell } from "@/shell/shell"
import { ShellScan } from "../shell/scan"
import * as Tool from "../tool"
import { ProcessSessions } from "./sessions"
import { ExecCommandID, pidPattern } from "./id"
import { EXEC_COMMAND_PROMPT } from "./prompt"
import { DEFAULT_EXEC_YIELD_TIME_MS, DEFAULT_TTY, UNIFIED_EXEC_ENV, approxTokenCount, formatExecResponse } from "./constants"
import { PositiveInt } from "@/util/schema"
import path from "path"

// Parameters mirror codex shell_spec.rs:28-110 verbatim — same field names,
// same defaults, same optionality. The `cmd` field is the only required one.
export const Parameters = Schema.Struct({
  cmd: Schema.String.annotate({
    description:
      "The shell command to run. Passed to the user's default shell as a single string; quoting and globbing follow shell rules.",
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description:
      "Directory to run the command in. Absolute path or path relative to the turn cwd. Defaults to the turn cwd.",
  }),
  shell: Schema.optional(Schema.String).annotate({
    description:
      "Override the shell binary used to interpret the command. Defaults to the user's configured shell. Most commands shouldn't override this.",
  }),
  tty: Schema.optional(Schema.Boolean).annotate({
    description:
      "Allocate a TTY. REQUIRED to send stdin via write_stdin later. Defaults to false; set true for REPLs and dev servers that emit colored output or need keystrokes.",
  }),
  yield_time_ms: Schema.optional(PositiveInt).annotate({
    description:
      "How long to wait (ms) for output before returning. Clamped to [250, 30000]. Defaults to 10000. Use shorter values for chatty REPL prompts; longer for cold-starting dev servers.",
  }),
  max_output_tokens: Schema.optional(PositiveInt).annotate({
    description:
      "Cap returned output length. Excess truncates head+tail. Defaults to the configured truncation policy budget.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// Executable head extracted for the spawn title. Mirrors codex's intent:
// take the first token as the executable so the title shows "git" or
// "node" rather than a long string.
function commandHead(cmd: string): string {
  const trimmed = cmd.trim()
  const firstSpace = trimmed.indexOf(" ")
  if (firstSpace === -1) return trimmed
  return trimmed.slice(0, firstSpace)
}

// Build the env applied to the spawn. Order matters: process.env (lowest),
// plugin shell.env (mid), UNIFIED_EXEC_ENV (highest). Codex's overlay
// always wins — see process_manager.rs:95-100 (apply_unified_exec_env).
function buildEnv(base: NodeJS.ProcessEnv, pluginEnv: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") merged[k] = v
  }
  for (const [k, v] of Object.entries(pluginEnv)) merged[k] = v
  for (const [k, v] of UNIFIED_EXEC_ENV) merged[k] = v
  return merged
}

export const ExecCommandTool = Tool.define(
  ExecCommandID.ToolID,
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const plugin = yield* Plugin.Service
    const sessions = yield* ProcessSessions.Service
    const config = yield* Config.Service
    // ShellScan transitively yields ChildProcessSpawner (cygpath) and
    // AppFileSystem.Service (isDir + normalizePath). Capture them in the
    // outer closure so execute()'s R stays `never` per the GOTCHA
    // `tool-define-execute-r-must-be-never-capture-services-in-closure`.
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const scanProvide = <A, E>(eff: Effect.Effect<A, E, ChildProcessSpawner | AppFileSystem.Service>) =>
      eff.pipe(Effect.provideService(ChildProcessSpawner, spawner), Effect.provideService(AppFileSystem.Service, fs))

    return () =>
      Effect.gen(function* () {
        // Resolve the configured shell ONCE at init (not per call). Wave 2
        // optimization: `Config.get()` is an InstanceState lookup; calling
        // it on the per-call hot path adds Effect-yield overhead that p99
        // amplified well beyond the bench budget. The configured shell is
        // immutable for the lifetime of the tool definition; per-call
        // override via `params.shell` still wins. Stays inside the inner
        // gen (NOT the outer Tool.define closure) because Config.get reads
        // InstanceState — only the inner runs with `Instance.current` bound.
        const cfg = yield* config.get()
        const defaultShell = Shell.acceptable(cfg.shell)
        return {
          description: EXEC_COMMAND_PROMPT,
          parameters: Parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const tty = params.tty ?? DEFAULT_TTY
              const yieldTimeMs = params.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? path.isAbsolute(params.workdir)
                  ? params.workdir
                  : path.resolve(instanceCtx.directory, params.workdir)
                : instanceCtx.directory

              const pluginShell = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
                { env: {} },
              )
              const env = buildEnv(process.env, pluginShell.env)
              const head = commandHead(params.cmd)

              // Scan happens BEFORE acquireUseRelease so the AST parse and
              // walk run in parallel with the tool's own setup overhead.
              // The scan needs the `instanceCtx` for cwd-vs-instance checks
              // and `shellBinary` for bash/powershell sniffing.
              const shellBinary = params.shell ?? defaultShell
              const scan = yield* scanProvide(
                ShellScan.scanCommand({
                  command: params.cmd,
                  shell: shellBinary,
                  cwd,
                  instance: instanceCtx,
                }),
              )

              // Acquire the PTY + ProcessSession together so the release
              // hook fires on any non-success exit (defect from
              // ctx.ask-rejection, fiber interruption, etc) and reclaims
              // the slot in the 64-cap pool plus the byPty bookkeeping
              // entry. The acquire ordering is fixed by codex's gotcha
              // (#1 in WAVE.md): allocate the pty first so the
              // `pid:<id>` always-pattern is meaningful at ctx.ask time.
              return yield* Effect.acquireUseRelease(
                Effect.gen(function* () {
                  const info = yield* pty.create({
                    command: params.shell ?? undefined,
                    args: ["-c", params.cmd],
                    cwd,
                    env,
                    title: `exec ${head}`,
                    origin: "model",
                  })
                  const session = yield* sessions.allocate({ ptyId: info.id, tty })
                  return { info, session }
                }),
                ({ info, session }) =>
                  Effect.gen(function* () {
                    yield* ShellScan.askForScan(ctx, scan, {
                      extraAlways: [pidPattern(session.processId)],
                      metadata: {
                        cmd: params.cmd,
                        workdir: cwd,
                        tty,
                      },
                    })

                    // Already-aborted: short-circuit before reading.
                    // The release hook below won't see this as an exit
                    // failure (we return a success), so we tear down
                    // the PTY inline.
                    if (ctx.abort.aborted) {
                      yield* sessions.remove(session.processId)
                      yield* pty.remove(info.id)
                      return {
                        title: `exec ${head}`,
                        metadata: { cmd: params.cmd, aborted: true },
                        output: "User aborted the command",
                      }
                    }

                    const start = Date.now()
                    const abort = Effect.callback<"abort">((resume) => {
                      if (ctx.abort.aborted) return resume(Effect.succeed("abort"))
                      const handler = () => resume(Effect.succeed("abort"))
                      ctx.abort.addEventListener("abort", handler, { once: true })
                      return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
                    })
                    const outcome = yield* Effect.raceAll([
                      pty
                        .read(info.id, 0, yieldTimeMs, 1024 * 1024)
                        .pipe(Effect.map((r) => ({ kind: "read" as const, r }))),
                      abort.pipe(Effect.map(() => ({ kind: "abort" as const }))),
                    ])
                    const wallMs = Date.now() - start

                    if (outcome.kind === "abort") {
                      // Capture whatever bytes already landed before
                      // killing — useful in transcripts.
                      const final = yield* pty
                        .read(info.id, 0, 1, 1024 * 1024)
                        .pipe(Effect.orElseSucceed(() => undefined))
                      const decoded = final?.output ? new TextDecoder().decode(final.output) : ""
                      yield* sessions.remove(session.processId)
                      yield* pty.remove(info.id)
                      return {
                        title: `exec ${head}`,
                        metadata: {
                          wall_time_seconds: wallMs / 1000,
                          cmd: params.cmd,
                          workdir: cwd,
                          tty,
                          aborted: true,
                          original_token_count: approxTokenCount(decoded),
                        },
                        output: formatExecResponse({
                          wallMs,
                          output: decoded,
                          originalTokenCount: approxTokenCount(decoded),
                          abortNote: "User aborted the command",
                        }),
                      }
                    }

                    const read = outcome.r
                    const decoded = read?.output ? new TextDecoder().decode(read.output) : ""
                    if (read) yield* sessions.setCursor(session.processId, read.cursor)

                    const original_token_count = approxTokenCount(decoded)
                    const exited = read?.exited ?? false
                    if (exited) yield* sessions.remove(session.processId)

                    const metadata: Record<string, unknown> = {
                      wall_time_seconds: wallMs / 1000,
                      cmd: params.cmd,
                      workdir: cwd,
                      tty,
                      original_token_count,
                      ...(exited && read?.exitCode !== undefined ? { exit_code: read.exitCode } : {}),
                      ...(!exited ? { session_id: session.processId } : {}),
                    }

                    return {
                      title: `exec ${head}`,
                      metadata,
                      output: formatExecResponse({
                        wallMs,
                        output: decoded,
                        originalTokenCount: original_token_count,
                        exitCode: exited && read?.exitCode !== undefined ? read.exitCode : undefined,
                        sessionId: !exited ? session.processId : undefined,
                      }),
                    }
                  }),
                ({ info, session }, exit) =>
                  // Cleanup on early failure (defect from rejection, interrupt, etc).
                  // On success exits, the use block already chose whether to keep or
                  // release the PTY (alive → keep, exited → drop session entry only,
                  // aborted → both released).
                  Exit.isFailure(exit)
                    ? Effect.gen(function* () {
                        yield* sessions.remove(session.processId)
                        yield* pty.remove(info.id)
                      })
                    : Effect.void,
              )
            }),
        }
      })
  }),
)
