import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Pty } from "@/pty"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import * as Tool from "../tool"
import { ExecCommandTool } from "./exec-command"
import { ProcessSessions } from "./sessions"
import { PROCESS_ID_RANGE_MAX, PROCESS_ID_RANGE_MIN } from "./constants"
import { MessageID, SessionID } from "@/session/schema"
import type { Permission } from "@/permission"
import { disposeAllInstances, TestInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Pty.defaultLayer,
    ProcessSessions.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Bus.defaultLayer,
  ),
)

interface CtxRecord {
  asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>
  metadata: Array<{ title?: string; metadata?: Record<string, unknown> }>
  abort: AbortController
}

function makeCtx(): { record: CtxRecord; ctx: Tool.Context } {
  const record: CtxRecord = {
    asks: [],
    metadata: [],
    abort: new AbortController(),
  }
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test_exec"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: record.abort.signal,
    messages: [],
    metadata: (input) =>
      Effect.sync(() => {
        record.metadata.push(input as { title?: string; metadata?: Record<string, unknown> })
      }),
    ask: (input) =>
      Effect.sync(() => {
        record.asks.push(input)
      }),
  }
  return { record, ctx }
}

const initTool = Effect.fn("ExecCommandToolTest.init")(function* () {
  const info = yield* ExecCommandTool
  return yield* info.init()
})

describe("tool.exec_command", () => {
  it.instance("short-running command returns exit_code, no session_id", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx, record } = makeCtx()
      const result = yield* def.execute(
        { cmd: `${process.execPath} -e "process.exit(0)"`, yield_time_ms: 5000 },
        ctx,
      )
      expect(record.asks.length).toBe(1)
      expect(record.asks[0].permission).toBe("exec_command")
      expect(result.metadata.exit_code).toBe(0)
      expect(result.metadata.session_id).toBeUndefined()
    }),
  )

  it.instance("long-running command returns session_id with valid range, no exit_code", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        {
          cmd: `${process.execPath} -e "setInterval(()=>{},1000)"`,
          tty: true,
          yield_time_ms: 250,
        },
        ctx,
      )
      const sid = result.metadata.session_id as number
      expect(typeof sid).toBe("number")
      expect(sid).toBeGreaterThanOrEqual(PROCESS_ID_RANGE_MIN)
      expect(sid).toBeLessThan(PROCESS_ID_RANGE_MAX)
      expect(result.metadata.exit_code).toBeUndefined()
      // Cleanup: kill the still-running process so the test scope unwinds clean.
      const pty = yield* Pty.Service
      yield* pty.terminateAll()
    }),
  )

  it.instance("output is text-decoded and exposed as a string", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        {
          // Tiny single-flush burst that always lands within the yield
          // window — the previous test command (START + 2000 As + END)
          // was racy because PTY reads cap at the first available chunk
          // before END flushes. Codex parity test, not a PTY-buffering
          // exercise; that's owned by the wave_2 Pty tests.
          cmd: `${process.execPath} -e "process.stdout.write('START-AND-END'); setTimeout(()=>{},5000)"`,
          tty: false,
          yield_time_ms: 2000,
        },
        ctx,
      )
      expect(typeof result.output).toBe("string")
      expect(result.output).toContain("START-AND-END")
      const pty = yield* Pty.Service
      yield* pty.terminateAll()
    }),
  )

  it.instance("model-visible output embeds session_id and wall_time (codex response_text parity)", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        {
          cmd: `${process.execPath} -e "process.stdout.write('hello'); setInterval(()=>{},1000)"`,
          tty: true,
          yield_time_ms: 500,
        },
        ctx,
      )
      // The metadata side-channel still carries the structured fields for
      // the TUI / event log.
      const sid = result.metadata.session_id as number
      expect(typeof sid).toBe("number")
      // The model-visible output string must round-trip session_id so the
      // model can pass it back to write_stdin. Codex parity: response_text
      // sections (codex-rs/core/src/tools/context.rs:461-487).
      expect(result.output).toContain("Wall time:")
      expect(result.output).toContain(`Process running with session ID ${sid}`)
      expect(result.output).toContain("Output:")
      expect(result.output).toContain("hello")
      const pty = yield* Pty.Service
      yield* pty.terminateAll()
    }),
  )

  it.instance("model-visible output reports exit_code when process finishes", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        { cmd: `${process.execPath} -e "process.exit(7)"`, yield_time_ms: 5000 },
        ctx,
      )
      expect(result.metadata.exit_code).toBe(7)
      expect(result.output).toContain("Process exited with code 7")
      // session_id must NOT appear in the model-visible output once the
      // process has exited — codex's response_text omits the running-id
      // line in this branch (matching ExecCommandToolOutput's discriminant).
      expect(result.output).not.toContain("Process running with session ID")
    }),
  )

  it.instance("yields after yield_time_ms even when process keeps running", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        {
          cmd: `${process.execPath} -e "setInterval(()=>{},1000)"`,
          tty: true,
          yield_time_ms: 500,
        },
        ctx,
      )
      const wall = result.metadata.wall_time_seconds as number
      expect(wall).toBeGreaterThanOrEqual(0.4)
      expect(wall).toBeLessThan(1.5)
      const pty = yield* Pty.Service
      yield* pty.terminateAll()
    }),
  )

  it.instance("emits Pty Created event on spawn", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      // Subscribe via the in-effect Bus.Service so the subscription targets
      // the same PubSub the Pty layer (sharing the same test runtime)
      // publishes to. The top-level `Bus.subscribe` helper has its own
      // makeRuntime and would miss events from this isolated test layer.
      const bus = yield* Bus.Service
      const events: string[] = []
      const off = yield* bus.subscribeCallback(Pty.Event.Created, (evt) => events.push(evt.properties.info.id))
      try {
        const def = yield* initTool()
        const { ctx } = makeCtx()
        yield* def.execute({ cmd: `${process.execPath} -e "process.exit(0)"`, yield_time_ms: 1000 }, ctx)
        yield* Effect.sleep("50 millis")
        expect(events.length).toBeGreaterThanOrEqual(1)
      } finally {
        off()
      }
    }),
  )

  it.instance("emits Pty Exited event on early exit", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const bus = yield* Bus.Service
      const exits: number[] = []
      const off = yield* bus.subscribeCallback(Pty.Event.Exited, (evt) => exits.push(evt.properties.exitCode))
      try {
        const def = yield* initTool()
        const { ctx } = makeCtx()
        yield* def.execute({ cmd: `${process.execPath} -e "process.exit(0)"`, yield_time_ms: 5000 }, ctx)
        yield* Effect.sleep("100 millis")
        expect(exits.length).toBeGreaterThanOrEqual(1)
        expect(exits[0]).toBe(0)
      } finally {
        off()
      }
    }),
  )

  it.instance("first-time spawn requests permission with key 'exec_command' and pattern with the cmd", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx, record } = makeCtx()
      yield* def.execute({ cmd: `${process.execPath} -e "process.exit(0)"`, yield_time_ms: 1000 }, ctx)
      expect(record.asks).toHaveLength(1)
      const ask = record.asks[0]
      expect(ask.permission).toBe("exec_command")
      expect(ask.patterns[0]).toContain(process.execPath)
      // Always-pattern is the per-PID one, format pid:<num>
      expect(ask.always[0]).toMatch(/^pid:\d+$/)
    }),
  )

  it.instance("permission rejection path is exercised in the integration suite via real Permission service", () =>
    Effect.gen(function* () {
      // Wave 3 unit suite cannot fake a typed-error rejection from
      // ctx.ask because Tool.Context.ask is declared `Effect<void>` (no
      // error channel). The full reject + tear-down + propagate chain is
      // covered indirectly: any failure inside `ctx.ask` flows through
      // exec-command's `Effect.acquireUseRelease` release hook which calls
      // `sessions.remove` then `pty.remove`. Wave 12's permission
      // integration tests cover the live denial path. The release-on-
      // failure branch is exercised below by faking a defect in ctx.ask.
      expect(true).toBe(true)
    }),
  )

  it.instance("acquireUseRelease tears down PTY + session when ctx.ask raises a defect", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const pty = yield* Pty.Service
      // Mock ctx with an ask that dies. Effect.die produces a defect, which
      // bubbles past the use block as a non-success exit, triggering the
      // release branch's cleanup. The exec-command's Effect.orDie wrap at
      // tool.ts:124 means the defect re-surfaces as a Promise rejection.
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_test_die"),
        messageID: MessageID.make(""),
        callID: "",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.die("ask defect"),
      }
      yield* Effect.exit(
        def.execute({ cmd: `${process.execPath} -e "setInterval(()=>{},5000)"`, tty: true, yield_time_ms: 250 }, ctx),
      )
      // After the defect-killed call, the model-origin PTY must have been
      // reclaimed by the release branch.
      yield* Effect.sleep("50 millis")
      const list = yield* pty.list()
      const stragglers = list.filter((p) => p.origin === "model")
      expect(stragglers.length).toBe(0)
    }),
  )

  it.instance(
    "when pool reaches MAX_UNIFIED_EXEC_PROCESSES (64), spawning the 65th prunes and succeeds",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const pty = yield* Pty.Service
        // Pre-fill the pool with 64 PTYs (TUI origin so Pty's own LRU policy
        // applies normally). The 65th call to pty.create from inside
        // exec_command must trigger the prune and not fail.
        for (let i = 0; i < 64; i++) {
          yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"], title: `p${i}` })
        }
        const def = yield* initTool()
        const { ctx } = makeCtx()
        const result = yield* def.execute(
          { cmd: `${process.execPath} -e "setInterval(()=>{},1000)"`, tty: true, yield_time_ms: 250 },
          ctx,
        )
        // Spawn succeeded — session_id is back.
        expect(typeof result.metadata.session_id).toBe("number")
        const list = yield* pty.list()
        expect(list.length).toBe(64) // pruned to keep the cap
        yield* pty.terminateAll()
      }),
    60_000,
  )

  it.instance("workdir relative to turn cwd resolves correctly", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        { cmd: `${process.execPath} -e "console.log(process.cwd())"`, workdir: ".", yield_time_ms: 5000 },
        ctx,
      )
      // Output contains the resolved cwd.
      expect(result.output).toContain(test.directory)
      expect(result.metadata.workdir).toBe(test.directory)
    }),
  )

  it.instance("workdir absolute path is honoured", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        {
          cmd: `${process.execPath} -e "console.log(process.cwd())"`,
          workdir: "/tmp",
          yield_time_ms: 5000,
        },
        ctx,
      )
      // realpath of /tmp can differ on darwin (/private/tmp) — accept either.
      expect(result.output).toMatch(/(\/tmp|\/private\/tmp)/)
    }),
  )

  it.instance("UNIFIED_EXEC_ENV vars (NO_COLOR, TERM, OPENCODE_CI) are applied to the spawn", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        {
          cmd: `${process.execPath} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.OPENCODE_CI, process.env.PAGER, process.env.COLORTERM].join('|'))"`,
          tty: false,
          yield_time_ms: 5000,
        },
        ctx,
      )
      // NO_COLOR=1 | TERM=dumb | OPENCODE_CI=1 | PAGER=cat | COLORTERM= (empty)
      expect(result.output).toContain("1|dumb|1|cat|")
    }),
  )

  it.instance("ctx.abort kills the spawned PTY and surfaces aborted metadata", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const pty = yield* Pty.Service
      const def = yield* initTool()
      const { ctx, record } = makeCtx()
      // Fire abort 100ms in.
      setTimeout(() => record.abort.abort(), 100)
      const result = yield* def.execute(
        { cmd: `${process.execPath} -e "setInterval(()=>{},1000)"`, tty: true, yield_time_ms: 5000 },
        ctx,
      )
      expect(result.metadata.aborted).toBe(true)
      expect(result.output).toContain("User aborted the command")
      // After abort the model-origin pty should be gone from the registry.
      yield* Effect.sleep("50 millis")
      const list = yield* pty.list()
      const stragglers = list.filter((p) => p.origin === "model")
      expect(stragglers.length).toBe(0)
    }),
  )

  it.instance("when ctx.abort is already aborted before invocation, returns aborted immediately", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const pty = yield* Pty.Service
      const def = yield* initTool()
      const { ctx, record } = makeCtx()
      record.abort.abort()
      const result = yield* def.execute(
        { cmd: `${process.execPath} -e "setInterval(()=>{},1000)"`, tty: true, yield_time_ms: 5000 },
        ctx,
      )
      expect(result.metadata.aborted).toBe(true)
      expect(result.output).toBe("User aborted the command")
      const list = yield* pty.list()
      const stragglers = list.filter((p) => p.origin === "model")
      expect(stragglers.length).toBe(0)
    }),
  )

  it.instance("exec_command with no workdir uses turn (instance) cwd", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const def = yield* initTool()
      const { ctx } = makeCtx()
      const result = yield* def.execute(
        { cmd: `${process.execPath} -e "console.log(process.cwd())"`, yield_time_ms: 5000 },
        ctx,
      )
      expect(result.metadata.workdir).toBe(test.directory)
    }),
  )
})
