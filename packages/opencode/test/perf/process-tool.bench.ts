import { afterAll, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { Pty } from "../../src/pty"
import { ProcessSessions } from "../../src/tool/process/sessions"
import { ExecCommandTool } from "../../src/tool/process/exec-command"
import { WriteStdinTool } from "../../src/tool/process/write-stdin"
import * as Tool from "../../src/tool/tool"
import type { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { bench, type BenchResult } from "../lib/perf"

// Wave 3 perf bench. Two metrics, both measured against new code only (no
// wave_0 baseline metric to compare against — these surfaces are new in
// wave 3). Output recorded for future regression checks in subsequent waves
// that touch the same hot path.

const allResults: Record<string, BenchResult> = {}

const wavePerfFile = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "codex-parity-2026-05-13",
  "artifacts",
  "perf",
  "wave_3.json",
)

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  return proc.success ? proc.stdout.toString().trim() : "unknown"
}

function makeCtx(): { ctx: Tool.Context; asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> } {
  const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_perf_process"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asks.push(input)
      }),
  }
  return { ctx, asks }
}

afterAll(async () => {
  if (Object.keys(allResults).length === 0) return
  await fs.mkdir(path.dirname(wavePerfFile), { recursive: true })
  const payload = {
    captured_at: new Date().toISOString(),
    git_sha: gitSha(),
    bun_version: Bun.version,
    metrics: allResults,
  }
  await Bun.write(wavePerfFile, JSON.stringify(payload, null, 2))
})

test(
  "bench: process.exec_command.short_command",
  async () => {
    if (process.platform === "win32") return
    const dir = path.join(os.tmpdir(), `process-bench-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const result = await WithInstance.provide({
        directory: dir,
        fn: async () => {
          return AppRuntime.runPromise(
            Effect.gen(function* () {
              const exec = yield* ExecCommandTool
              const def = yield* exec.init()
              return yield* Effect.promise(async () => {
                return await bench(
                  { samples: 20, warmup: 3, label: "process.exec_command.short_command" },
                  async () => {
                    const { ctx } = makeCtx()
                    const out = await AppRuntime.runPromise(
                      def.execute(
                        {
                          cmd: `${process.execPath} -e "process.exit(0)"`,
                          yield_time_ms: 5_000,
                        },
                        ctx,
                      ),
                    )
                    if (out.metadata.exit_code !== 0) throw new Error("expected exit 0")
                  },
                )
              })
            }),
          )
        },
      })
      allResults[result.label] = result
      expect(result.samples).toBeGreaterThan(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
  120_000,
)

test(
  "bench: process.write_stdin.poll_with_data",
  async () => {
    if (process.platform === "win32") return
    const dir = path.join(os.tmpdir(), `process-bench-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const result = await WithInstance.provide({
        directory: dir,
        fn: async () => {
          return AppRuntime.runPromise(
            Effect.gen(function* () {
              const exec = yield* ExecCommandTool
              const writeStdin = yield* WriteStdinTool
              const execDef = yield* exec.init()
              const writeDef = yield* writeStdin.init()

              // Spawn an echo process once outside the bench loop.
              const { ctx } = makeCtx()
              const echoCmd = `${process.execPath} -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { for (const line of d.split('\\n')) { if (line) process.stdout.write('got:' + line + '\\n') } })"`
              const spawn = yield* execDef.execute({ cmd: echoCmd, tty: true, yield_time_ms: 250 }, ctx)
              const sid = spawn.metadata.session_id as number

              const result = yield* Effect.promise(async () => {
                return await bench(
                  { samples: 30, warmup: 5, label: "process.write_stdin.poll_with_data" },
                  async () => {
                    const out = await AppRuntime.runPromise(
                      writeDef.execute(
                        {
                          session_id: sid,
                          chars: "x\n",
                          yield_time_ms: 250,
                        },
                        ctx,
                      ),
                    )
                    if (typeof out.output !== "string") throw new Error("expected string output")
                  },
                )
              })

              const pty = yield* Pty.Service
              yield* pty.terminateAll()
              return result
            }),
          )
        },
      })
      allResults[result.label] = result
      expect(result.samples).toBeGreaterThan(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
  180_000,
)
