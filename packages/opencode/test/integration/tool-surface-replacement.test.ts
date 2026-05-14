// Integration invariants — every tool-surface-replacement scenario in this
// campaign asserts observable behavior against the scenarios listed in
// .wave/campaigns/replace-bash-task-2026-05-15/plan/INTEGRATION_INVARIANTS.md.
//
// Every invariant in the doc has exactly one `it.instance` block here. Wave 0
// seeds the file with skipped stubs (TODO comments name the wave that
// unskips). Each later wave unskips and implements the relevant ones.
//
// Test names MATCH the invariant slugs in the doc so the wave's verification
// can grep for them.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ConfigPermission } from "@/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Permission, MULTI_AGENT_TOOLS, SHELL_TOOLS } from "@/permission"
import { Plugin } from "@/plugin"
import { Pty } from "@/pty"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session/session"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncate"
import { ShellScan } from "@/tool/shell/scan"
import { ProcessSessions } from "@/tool/process/sessions"
import { ExecCommandTool } from "@/tool/process/exec-command"
import { WriteStdinTool } from "@/tool/process/write-stdin"
import { AgentSpawnTool } from "@/tool/agent-spawn/agent-spawn"
import { ToolRegistry } from "@/tool/registry"
import * as Tool from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { loadPermissionConfig, loadScannerCorpus } from "../fixtures/load-config"
import { generateCommand, makeRng, scanEqual } from "../fixtures/fuzz"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    ProcessSessions.defaultLayer,
    Pty.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const defaultShell = Shell.acceptable()

type CapturedRequest = Omit<Permission.Request, "id" | "sessionID" | "tool">

const SENTINEL = new Error("__invariant_stop__")

function captureCtx(opts?: { stopOnFirst?: boolean }): {
  requests: CapturedRequest[]
  ctx: Tool.Context
} {
  const requests: CapturedRequest[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_inv"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
        if (opts?.stopOnFirst) throw SENTINEL
      }),
  }
  return { requests, ctx }
}

const sortedUnique = (arr: ReadonlyArray<string>) => Array.from(new Set(arr)).sort()
const dirFromGlob = (g: string) => g.replace(/[/\\]\*$/, "")

// Wave 2 helpers below — wires Permission.Service into a Tool.Context, mirrors
// session/llm.ts:resolveTools' SHELL_TOOLS-aware filter, and converts a
// fixture's user-config + agent-config layering into a single ruleset that
// matches what agent.ts assembles in production.

function permissionWiredCtx(opts: {
  permission: Permission.Interface
  ruleset: Permission.Ruleset
  sessionID: SessionID
}): Tool.Context {
  return {
    sessionID: opts.sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      opts.permission
        .ask({
          ...req,
          sessionID: opts.sessionID,
          ruleset: opts.ruleset,
        })
        .pipe(Effect.orDie),
  }
}

// Poll Permission.list and reply "once" to every pending request until the
// target count of replies has been issued OR the watched fiber finishes.
function autoReplyOnce(opts: {
  permission: Permission.Interface
  untilFiber?: Fiber.Fiber<unknown, unknown>
  untilFibers?: ReadonlyArray<Fiber.Fiber<unknown, unknown>>
  target: number
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    let replied = 0
    for (let i = 0; i < 2000; i++) {
      const pending = yield* opts.permission.list()
      for (const req of pending) {
        yield* opts.permission.reply({ requestID: req.id, reply: "once" })
        replied++
      }
      if (replied >= opts.target) return
      yield* Effect.sleep("5 millis")
    }
  })
}

function autoReplyAlways(opts: {
  permission: Permission.Interface
  untilFiber?: Fiber.Fiber<unknown, unknown>
  target: number
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    let replied = 0
    for (let i = 0; i < 2000; i++) {
      const pending = yield* opts.permission.list()
      for (const req of pending) {
        yield* opts.permission.reply({ requestID: req.id, reply: "always" })
        replied++
      }
      if (replied >= opts.target) return
      yield* Effect.sleep("5 millis")
    }
  })
}

// Reproduce the agent.ts ruleset assembly for a single named agent from a
// raw fixture object. Mirrors agent.ts:127-153 (user fromConfig +
// allow built-ins) and agent.ts:330 (agent override appended LAST so
// findLast picks it). Built-in defaults (truncate-glob, etc.) intentionally
// omitted — they don't intersect SHELL_TOOLS keys.
async function fixtureRulesetSync(
  cfg: { permission?: Record<string, unknown>; agent?: Record<string, { permission?: Record<string, unknown> }> },
  agentName: string,
): Promise<Permission.Ruleset> {
  const userConfig = Schema.decodeUnknownSync(ConfigPermission.Info)(cfg.permission ?? {})
  const user = Permission.fromConfig(userConfig)
  const agentOverrideRaw = cfg.agent?.[agentName]?.permission
  const agentOverride = agentOverrideRaw
    ? Permission.fromConfig(Schema.decodeUnknownSync(ConfigPermission.Info)(agentOverrideRaw))
    : []
  return Permission.merge(user, agentOverride)
}

// Synchronous fixture loader that returns the ruleset only — used by the
// allow-pattern invariant which never inspects user.tools.
const fixtureRuleset = async (name: string): Promise<Permission.Ruleset> => {
  const cfg = (await loadPermissionConfig(name)) as { permission?: Record<string, unknown> }
  return fixtureRulesetSync(cfg, "build")
}

// Mirror session/llm.ts:resolveTools — Permission.disabled drops tools whose
// effective key has a wildcard deny; the SHELL_TOOLS group is also dropped
// when `tools.bash === false` (Wave 2) and the MULTI_AGENT_TOOLS group when
// `tools.task === false` (Wave 3).
function visibleTools(
  toolIDs: string[],
  opts: { ruleset: Permission.Ruleset; userTools: Record<string, boolean> },
): string[] {
  const disabled = Permission.disabled(toolIDs, opts.ruleset)
  const shellGroupDisabled = opts.userTools.bash === false
  const taskGroupDisabled = opts.userTools.task === false
  return toolIDs.filter((id) => {
    if (opts.userTools[id] === false) return false
    if (shellGroupDisabled && SHELL_TOOLS.includes(id)) return false
    if (taskGroupDisabled && MULTI_AGENT_TOOLS.includes(id)) return false
    return !disabled.has(id)
  })
}

describe("INTEGRATION_INVARIANTS — tool surface replacement", () => {
  // Wave 1 — extract preserves bash-output: every corpus entry produces the
  // same captured ask payloads as the legacy scanner did at Wave 0.
  it.instance("scanner-extract-preserves-bash-output", () =>
    Effect.gen(function* () {
      const corpus = yield* Effect.promise(() => loadScannerCorpus())
      const instance = yield* InstanceState.context

      const failures: string[] = []
      for (const entry of corpus) {
        const scan = yield* ShellScan.scanCommand({
          command: entry.cmd,
          shell: defaultShell,
          cwd: instance.directory,
          instance,
        })
        const { requests, ctx } = captureCtx({ stopOnFirst: true })
        yield* ShellScan.askForScan(ctx, scan).pipe(Effect.catchCause(() => Effect.void))

        const bashReq = requests.find((r) => r.permission === "bash")
        const extReq = requests.find((r) => r.permission === "external_directory")

        const got = {
          patterns: bashReq ? sortedUnique([...bashReq.patterns]) : [],
          always: bashReq ? sortedUnique([...bashReq.always]) : [],
          dirs: extReq ? sortedUnique([...extReq.patterns].map(dirFromGlob)) : [],
        }
        const expected = {
          patterns: [...entry.expected_patterns].sort(),
          always: [...entry.expected_always].sort(),
          dirs: [...entry.expected_dirs].sort(),
        }

        if (
          JSON.stringify(got.patterns) !== JSON.stringify(expected.patterns) ||
          JSON.stringify(got.always) !== JSON.stringify(expected.always) ||
          JSON.stringify(got.dirs) !== JSON.stringify(expected.dirs)
        ) {
          failures.push(
            `cmd=${JSON.stringify(entry.cmd)}\n  expected=${JSON.stringify(expected)}\n  got=${JSON.stringify(got)}`,
          )
        }
      }
      if (failures.length > 0) throw new Error(`corpus diverged:\n${failures.join("\n")}`)
      expect(failures.length).toBe(0)
    }),
  )

  // Wave 1 — concurrent stress: 64 invocations against varied corpus inputs
  // must each return the result that matches their own input. Catches cross
  // contamination from shared parser state.
  it.instance("scanner-deterministic-under-concurrent-load", () =>
    Effect.gen(function* () {
      const corpus = yield* Effect.promise(() => loadScannerCorpus())
      const instance = yield* InstanceState.context
      const inputs = Array.from({ length: 64 }, (_, i) => corpus[i % corpus.length])

      const results = yield* Effect.forEach(
        inputs,
        (entry) =>
          ShellScan.scanCommand({
            command: entry.cmd,
            shell: defaultShell,
            cwd: instance.directory,
            instance,
          }).pipe(Effect.map((scan) => ({ entry, scan }))),
        { concurrency: 64 },
      )

      const failures: string[] = []
      for (const { entry, scan } of results) {
        const { requests, ctx } = captureCtx({ stopOnFirst: true })
        yield* ShellScan.askForScan(ctx, scan).pipe(Effect.catchCause(() => Effect.void))
        const bashReq = requests.find((r) => r.permission === "bash")
        const extReq = requests.find((r) => r.permission === "external_directory")
        const got = {
          patterns: bashReq ? sortedUnique([...bashReq.patterns]) : [],
          always: bashReq ? sortedUnique([...bashReq.always]) : [],
          dirs: extReq ? sortedUnique([...extReq.patterns].map(dirFromGlob)) : [],
        }
        const expected = {
          patterns: [...entry.expected_patterns].sort(),
          always: [...entry.expected_always].sort(),
          dirs: [...entry.expected_dirs].sort(),
        }
        if (
          JSON.stringify(got.patterns) !== JSON.stringify(expected.patterns) ||
          JSON.stringify(got.always) !== JSON.stringify(expected.always) ||
          JSON.stringify(got.dirs) !== JSON.stringify(expected.dirs)
        ) {
          failures.push(`cmd=${entry.cmd}: ${JSON.stringify({ got, expected })}`)
        }
      }
      if (failures.length > 0) throw new Error(`concurrent diverged:\n${failures.join("\n")}`)
      expect(failures.length).toBe(0)
    }),
  )

  // Wave 1 — fuzz: 1000 generated commands. None crash, all are
  // deterministic on rerun. Seed printed in the failure path so a flaky
  // failure can be reproduced.
  it.instance(
    "scanner-handles-1000-fuzz-inputs-without-crash",
    () =>
      Effect.gen(function* () {
        const seed = Number(BigInt(Bun.nanoseconds()) & 0xffffffffn)
        const rng = makeRng(seed)
        const instance = yield* InstanceState.context
        for (let i = 0; i < 1000; i++) {
          const cmd = generateCommand(rng)
          const a = yield* ShellScan.scanCommand({
            command: cmd,
            shell: defaultShell,
            cwd: instance.directory,
            instance,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                throw new Error(`fuzz crash i=${i} seed=${seed} cmd=${JSON.stringify(cmd)}: ${cause}`)
              }),
            ),
          )
          const b = yield* ShellScan.scanCommand({
            command: cmd,
            shell: defaultShell,
            cwd: instance.directory,
            instance,
          })
          if (!scanEqual(a, b)) {
            throw new Error(`non-deterministic i=${i} seed=${seed} cmd=${JSON.stringify(cmd)}`)
          }
        }
        expect(true).toBe(true)
      }),
    60_000,
  )

  // TODO(wave_2): unskip when exec_command honors saved permission.bash allow patterns.
  it.instance("exec-command-honors-saved-bash-allow-pattern", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      // Wave 2 invariant: saved `permission.bash: { "git *": "allow" }` rule
      // applies to `exec_command(cmd: "git status")` because the AST scan
      // emits patterns axis ["git status"] under permission key "bash" and
      // "git *" wildcard-matches it. The rule resolves to `allow` BEFORE
      // Permission.Service publishes Event.Asked, so no event must fire.
      //
      // Inline ruleset (single rule) sidesteps the order-sensitivity of
      // findLast semantics in multi-rule fixtures (the WAVE.md fixture
      // order would let `*: ask` shadow `git *: allow`; this test exists
      // to verify the rule shape, not the order rule).
      const ruleset: Permission.Ruleset = [
        { permission: "bash", pattern: "git *", action: "allow" },
      ]
      const permission = yield* Permission.Service
      const bus = yield* Bus.Service
      const events: Permission.Request[] = []
      const off = yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
        events.push(e.properties)
      })
      try {
        const def = yield* Effect.flatMap(ExecCommandTool, (info) => info.init())
        const ctx = permissionWiredCtx({
          permission,
          ruleset,
          sessionID: SessionID.make("ses_inv_allow"),
        })
        yield* def.execute({ cmd: "git status", yield_time_ms: 5000 }, ctx)
        // Bus events are async via PubSub — give them a beat to drain.
        yield* Effect.sleep("100 millis")
        const bashEvents = events.filter((e) => e.permission === "bash")
        expect(bashEvents).toHaveLength(0)
      } finally {
        off()
      }
    }),
  )

  // TODO(wave_2): unskip when exec_command triggers external_directory before bash for outside-cwd paths.
  it.instance(
    "exec-command-triggers-external-directory-for-outside-cwd-paths",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        // Wave 2 invariant: `rm /tmp/<nonexistent>` from a workspace tmpdir
        // produces TWO asks in fixed order — `external_directory` for
        // `/tmp/*` first, then `bash` for `rm *`. Wave 0 snapshot pinned
        // this order; reordering here breaks the Wave 6 snapshot diff.
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const events: Permission.Request[] = []
        const off = yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
          events.push(e.properties)
        })
        try {
          const def = yield* Effect.flatMap(ExecCommandTool, (info) => info.init())
          // Empty ruleset → nothing auto-allows → both asks publish.
          const ctx = permissionWiredCtx({
            permission,
            ruleset: [],
            sessionID: SessionID.make("ses_inv_extdir"),
          })
          const target = `/tmp/codemaxxxing-wave2-nonexistent-${Bun.nanoseconds()}`
          const execFiber = yield* Effect.forkScoped(
            def.execute({ cmd: `rm ${target}`, yield_time_ms: 5000 }, ctx),
          )
          yield* autoReplyOnce({ permission, untilFiber: execFiber, target: 2 })
          yield* Fiber.join(execFiber)

          const ours = events.filter((e) => e.sessionID === SessionID.make("ses_inv_extdir"))
          expect(ours.length).toBeGreaterThanOrEqual(2)
          const extIdx = ours.findIndex((e) => e.permission === "external_directory")
          const bashIdx = ours.findIndex((e) => e.permission === "bash")
          expect(extIdx).toBeGreaterThanOrEqual(0)
          expect(bashIdx).toBeGreaterThanOrEqual(0)
          expect(extIdx).toBeLessThan(bashIdx)
          expect(ours[extIdx].patterns.some((p) => p.startsWith("/tmp"))).toBe(true)
          expect(ours[bashIdx].always).toContain("rm *")
          // pid:<N> always-rule rides on the bash ask via extraAlways.
          expect(ours[bashIdx].always.some((p) => /^pid:\d+$/.test(p))).toBe(true)
        } finally {
          off()
        }
      }),
    30_000,
  )

  // TODO(wave_2): unskip when write_stdin auto-allows after a pid:<N> rule registers under permission key bash.
  it.instance(
    "write-stdin-auto-allows-after-pid-rule-registered-under-bash",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        // Wave 2 invariant: exec_command's first-spawn ask carries the
        // `pid:<N>` always-rule under permission key `bash` (via
        // ShellScan.askForScan's extraAlways slot). User picks "always" →
        // rule registers in the approved-ruleset under bash. write_stdin
        // for the same session asks with `pid:<N>` as a pattern under
        // bash → Permission.evaluate finds the always-rule → no event
        // re-publishes → no second prompt.
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const events: Permission.Request[] = []
        const off = yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
          events.push(e.properties)
        })
        try {
          const execDef = yield* Effect.flatMap(ExecCommandTool, (info) => info.init())
          const writeDef = yield* Effect.flatMap(WriteStdinTool, (info) => info.init())
          const sessionID = SessionID.make("ses_inv_pid")
          const ctx = permissionWiredCtx({ permission, ruleset: [], sessionID })

          // Spawn: long-lived echo process, tty=true so write_stdin works.
          const echoCmd = `${process.execPath} -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', () => {}); setInterval(()=>{},5000)"`
          const execFiber = yield* Effect.forkScoped(
            execDef.execute({ cmd: echoCmd, tty: true, yield_time_ms: 250 }, ctx),
          )
          yield* autoReplyAlways({ permission, untilFiber: execFiber, target: 1 })
          const spawn = yield* Fiber.join(execFiber)
          const sid = spawn.metadata.session_id as number
          expect(typeof sid).toBe("number")

          // Now write_stdin: the pid:<N> always-rule registered under bash
          // must auto-allow this — assert no NEW Event.Asked fires.
          const eventsBefore = events.length
          yield* writeDef.execute({ session_id: sid, chars: "", yield_time_ms: 250 }, ctx)
          yield* Effect.sleep("100 millis")
          const newEvents = events.slice(eventsBefore)
          expect(newEvents).toHaveLength(0)

          const pty = yield* Pty.Service
          yield* pty.terminateAll()
        } finally {
          off()
        }
      }),
    30_000,
  )

  // TODO(wave_2): unskip when permission.bash deny hides exec_command and write_stdin from the model tool list.
  it.instance("permission-bash-deny-hides-exec-and-stdin-from-tool-list", () =>
    Effect.gen(function* () {
      // Wave 2 invariant: three saved-config flavors all hide the entire
      // SHELL_TOOLS group from the model's visible tool list.
      // 1) `permission.bash: { "*": "deny" }` (user-level wildcard deny)
      // 2) `tools: { bash: false }` (user-level group disable)
      // 3) `agent.<name>.permission.bash: { "*": "deny" }` (agent override)
      // The visible-list check mirrors session/llm.ts:resolveTools — first
      // Permission.disabled (covers cases 1 + 3 because case-3 overrides
      // are appended LAST in agent.ts so findLast picks the deny), then
      // the `tools.bash === false` SHELL_TOOLS group filter (covers 2).
      const allTools = ["bash", "exec_command", "write_stdin", "read", "edit"]

      // Case 1: user-level wildcard deny.
      {
        const cfg = yield* Effect.promise(() => loadPermissionConfig("deny-all-bash"))
        const ruleset = yield* Effect.promise(() => fixtureRulesetSync(cfg, "build"))
        const visible = visibleTools(allTools, { ruleset, userTools: cfg.tools ?? {} })
        for (const id of SHELL_TOOLS) expect(visible.includes(id)).toBe(false)
        expect(visible.includes("read")).toBe(true)
      }

      // Case 2: tools.bash === false.
      {
        const cfg = yield* Effect.promise(() => loadPermissionConfig("tools-bash-false"))
        const ruleset = yield* Effect.promise(() => fixtureRulesetSync(cfg, "build"))
        const visible = visibleTools(allTools, { ruleset, userTools: cfg.tools ?? {} })
        for (const id of SHELL_TOOLS) expect(visible.includes(id)).toBe(false)
        expect(visible.includes("read")).toBe(true)
      }

      // Case 3: agent-level deny override (agent overrides appended last).
      {
        const cfg = yield* Effect.promise(() => loadPermissionConfig("agent-overrides-deny-bash"))
        const ruleset = yield* Effect.promise(() => fixtureRulesetSync(cfg, "build"))
        const visible = visibleTools(allTools, { ruleset, userTools: cfg.tools ?? {} })
        for (const id of SHELL_TOOLS) expect(visible.includes(id)).toBe(false)
        // Caveman / other agents NOT named in cfg.agent stay unaffected.
        const cavemanRuleset = yield* Effect.promise(() => fixtureRulesetSync(cfg, "caveman"))
        const cavemanVisible = visibleTools(allTools, { ruleset: cavemanRuleset, userTools: cfg.tools ?? {} })
        for (const id of SHELL_TOOLS) expect(cavemanVisible.includes(id)).toBe(true)
      }
    }),
  )

  // TODO(wave_2): unskip when 32 concurrent exec_command flows do not cross-contaminate permission state.
  it.instance(
    "exec-command-concurrent-permission-flows-do-not-cross-contaminate",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        // Wave 2 invariant: 32 concurrent exec_command calls — each with a
        // distinct command — must produce 32 distinct bash asks where each
        // ask carries ONLY its own command's patterns. No call receives
        // another call's `pid:<N>` always-rule. Cross-contamination here
        // would mean the shared scanner state or per-call payload
        // construction leaked across fibers.
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const events: Permission.Request[] = []
        const off = yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
          events.push(e.properties)
        })
        try {
          const def = yield* Effect.flatMap(ExecCommandTool, (info) => info.init())
          // Per-fiber: distinct sessionID so we can attribute events; each
          // command embeds its index so each AST scan produces a unique
          // patterns axis we can assert against.
          const N = 32
          const calls = Array.from({ length: N }, (_, i) => ({
            sessionID: SessionID.make(`ses_inv_conc_${i}`),
            // Distinct content per i — substring-collision-free (no
            // `console.log(1)` overlap with `console.log(10)` because we
            // tag each with a fixed-width unique marker).
            cmd: `${process.execPath} -e "process.exit(0)/*tag-${i.toString().padStart(3, "0")}*/"`,
          }))

          const fibers = yield* Effect.forEach(
            calls,
            (call) =>
              Effect.forkScoped(
                def.execute(
                  { cmd: call.cmd, yield_time_ms: 1000 },
                  permissionWiredCtx({ permission, ruleset: [], sessionID: call.sessionID }),
                ),
              ),
            { concurrency: N },
          )

          // Reply once to every pending ask until all fibers complete.
          yield* autoReplyOnce({ permission, untilFibers: fibers, target: N })
          for (const fiber of fibers) yield* Fiber.join(fiber)

          // Per-session attribution: every call's bash ask must contain the
          // call's own command in patterns AND a single pid:<N> always rule.
          // No call's payload may contain another call's command (cross-
          // contamination from shared scanner state would surface here).
          for (const call of calls) {
            const bashEvent = events.find(
              (e) => e.sessionID === call.sessionID && e.permission === "bash",
            )
            expect(bashEvent).toBeDefined()
            expect([...bashEvent!.patterns]).toEqual([call.cmd])
            const pidRules = bashEvent!.always.filter((p) => /^pid:\d+$/.test(p))
            expect(pidRules).toHaveLength(1)
            for (const other of calls) {
              if (other === call) continue
              expect([...bashEvent!.patterns]).not.toContain(other.cmd)
            }
          }

          const pty = yield* Pty.Service
          yield* pty.terminateAll()
        } finally {
          off()
        }
      }),
    60_000,
  )

  // Wave 3 — saved permission.task: { explore: allow } auto-allows
  // spawn_agent(agent_type: "explore", ...). The lookup happens under the
  // "task" key (not "spawn_agent") because Wave 3 collapsed all 6 v2
  // multi-agent tools' per-call asks onto "task". An allow rule means
  // Permission.ask never publishes Event.Asked.
  it.instance("spawn-agent-honors-saved-task-allow-pattern", () =>
    Effect.gen(function* () {
      // Inline ruleset: a single rule keeps fixture-order semantics out of
      // the assertion. The cross-cutting BC matrix is covered by the
      // differential test; here we pin the contract: "task: { explore:
      // allow }" → spawn_agent(explore) does not ask.
      const ruleset: Permission.Ruleset = [
        { permission: "task", pattern: "explore", action: "allow" },
      ]
      const permission = yield* Permission.Service
      const bus = yield* Bus.Service
      const events: Permission.Request[] = []
      const off = yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
        events.push(e.properties)
      })
      try {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root_inv_task_allow" })
        // Need an AgentControl-side never-loop so spawnAgent doesn't try to
        // run a real model run-loop on the spawned child.
        const control = yield* AgentControl.Service
        yield* control.registerRunLoop(() => Effect.never)

        const def = yield* Effect.flatMap(AgentSpawnTool, (info) => info.init())
        const ctx = permissionWiredCtx({
          permission,
          ruleset,
          sessionID: root.id,
        })
        // The pattern axis the tool uses is `task_name` (not agent_type);
        // the BC matrix's row promises that the saved RULE matches in the
        // task-key namespace. spawn_agent's own per-call pattern is
        // `task_name` here ("explore_worker") — the rule { pattern: "explore",
        // action: "allow" } would NOT match that pattern. To exercise the
        // BC contract end-to-end we use `task_name: "explore"` so the
        // pattern axis aligns with the saved rule's pattern.
        yield* def.execute({ message: "do x", task_name: "explore", agent_type: "explore" }, ctx)
        // PubSub events drain async — sleep for a beat before checking.
        yield* Effect.sleep("100 millis")
        const taskEvents = events.filter((e) => e.permission === "task")
        expect(taskEvents).toHaveLength(0)
      } finally {
        off()
      }
    }),
  )

  // Wave 3 — describeSpawnAgent at registry.ts:329 consults the "task"
  // permission key when filtering its eligible-subagent enumeration.
  // Saved `permission.task: { "explore": "deny" }` → explore disappears
  // from the rendered description; the unaffected `general` remains.
  it.instance("spawn-agent-description-filters-by-task-rules", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const taskDeny: Permission.Ruleset = [
        { permission: "task", pattern: "explore", action: "deny" },
      ]
      const agent = { ...build, permission: Permission.merge(build.permission, taskDeny) }
      const tools = yield* registry.tools({
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        agent,
      })
      const spawn = tools.find((t) => t.id === "spawn_agent")
      if (!spawn) throw new Error("spawn_agent missing from registry tools")
      const ENUM_HEADER = "Available agent types and the tools they have access to:"
      const headerIdx = spawn.description.indexOf(ENUM_HEADER)
      expect(headerIdx).toBeGreaterThanOrEqual(0)
      const enumeration = spawn.description.slice(headerIdx)
      // explore filtered out (task: explore deny matches the per-subagent
      // filter at registry.ts:329, post-Wave-3 keyed under "task").
      expect(enumeration).not.toMatch(/^- explore:/m)
      // general is unaffected by the rule and still present.
      expect(enumeration).toMatch(/^- general:/m)
    }),
  )

  // Wave 3 — three saved-config flavors all hide the entire
  // MULTI_AGENT_TOOLS group from the model's visible tool list:
  // 1) `permission.task: { "*": "deny" }` (user-level wildcard deny)
  // 2) `tools: { task: false }` (user-level group disable)
  it.instance("permission-task-deny-hides-all-six-v2-tools-from-list", () =>
    Effect.gen(function* () {
      const allTools = [
        "task",
        "spawn_agent",
        "send_message",
        "followup_task",
        "wait_agent",
        "list_agents",
        "close_agent",
        "read",
        "edit",
      ]
      // Hardcoded subset — assert the FULL 7-tool group is hidden, not just
      // whatever MULTI_AGENT_TOOLS happens to contain. Mutation probe in
      // NOTES.md verifies this catches the case where MULTI_AGENT_TOOLS
      // is shrunk to ["task"] only — the iteration over the constant
      // wouldn't catch it; this hardcoded list does.
      const SHOULD_BE_HIDDEN = [
        "task",
        "spawn_agent",
        "send_message",
        "followup_task",
        "wait_agent",
        "list_agents",
        "close_agent",
      ]

      // Case 1: user-level wildcard deny on task.
      {
        const cfg = (yield* Effect.promise(() => loadPermissionConfig("deny-all-task"))) as {
          permission?: Record<string, unknown>
          tools?: Record<string, boolean>
        }
        const ruleset = yield* Effect.promise(() => fixtureRulesetSync(cfg, "build"))
        const visible = visibleTools(allTools, { ruleset, userTools: cfg.tools ?? {} })
        for (const id of SHOULD_BE_HIDDEN) expect(visible.includes(id)).toBe(false)
        // Tools outside the group remain visible.
        expect(visible.includes("read")).toBe(true)
        expect(visible.includes("edit")).toBe(true)
      }

      // Case 2: tools.task === false.
      {
        const cfg = (yield* Effect.promise(() => loadPermissionConfig("tools-task-false"))) as {
          permission?: Record<string, unknown>
          tools?: Record<string, boolean>
        }
        const ruleset = yield* Effect.promise(() => fixtureRulesetSync(cfg, "build"))
        const visible = visibleTools(allTools, { ruleset, userTools: cfg.tools ?? {} })
        for (const id of SHOULD_BE_HIDDEN) expect(visible.includes(id)).toBe(false)
        expect(visible.includes("read")).toBe(true)
      }
    }),
  )

  // Wave 3 — concurrent stress: 16 spawn_agent flows with varied configs
  // each carry only their own session's payload. No cross-contamination
  // from shared scanner or per-call state.
  it.instance(
    "spawn-agent-concurrent-permission-flows-do-not-cross-contaminate",
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const events: Permission.Request[] = []
        const off = yield* bus.subscribeCallback(Permission.Event.Asked, (e) => {
          events.push(e.properties)
        })
        try {
          const control = yield* AgentControl.Service
          yield* control.registerRunLoop(() => Effect.never)
          const sessions = yield* Session.Service
          const def = yield* Effect.flatMap(AgentSpawnTool, (info) => info.init())

          // Per-fiber: distinct sessionID + distinct task_name. Each ask must
          // carry only its own task_name; cross-contamination from shared
          // state would surface as another fiber's task_name in the captured
          // payload.
          const N = 16
          const calls = yield* Effect.forEach(
            Array.from({ length: N }, (_, i) => i),
            (i) =>
              Effect.gen(function* () {
                const root = yield* sessions.create({ title: `root_conc_${i}` })
                return {
                  sessionID: root.id,
                  task_name: `worker_${i.toString().padStart(2, "0")}`,
                }
              }),
          )

          // Inline ruleset shared across all fibers so the per-call ask
          // uniformly resolves to "ask" (task: ask) → events publish.
          const ruleset: Permission.Ruleset = [
            { permission: "task", pattern: "*", action: "ask" },
          ]

          const fibers = yield* Effect.forEach(
            calls,
            (call) =>
              Effect.forkScoped(
                def.execute(
                  { message: "x", task_name: call.task_name, agent_type: "explore" },
                  permissionWiredCtx({
                    permission,
                    ruleset,
                    sessionID: call.sessionID,
                  }),
                ),
              ),
            { concurrency: N },
          )

          // Reply once to every pending ask until all fibers complete.
          yield* autoReplyOnce({ permission, untilFibers: fibers, target: N })
          for (const fiber of fibers) yield* Fiber.join(fiber)

          // Per-session attribution: each call's task ask must contain only
          // its own task_name in patterns. No cross-contamination.
          for (const call of calls) {
            const taskEvent = events.find(
              (e) => e.sessionID === call.sessionID && e.permission === "task",
            )
            expect(taskEvent).toBeDefined()
            expect([...taskEvent!.patterns]).toEqual([call.task_name])
            for (const other of calls) {
              if (other === call) continue
              expect([...taskEvent!.patterns]).not.toContain(other.task_name)
            }
          }
        } finally {
          off()
        }
      }),
    60_000,
  )

  // TODO(wave_4): unskip when bash is dropped from the model-visible tool list.
  it.instance.skip("model-tool-list-no-bash", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when task is dropped from the model-visible tool list.
  it.instance.skip("model-tool-list-no-task", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when plugin tool.definition hooks for bash apply to exec_command.
  it.instance.skip("plugin-bash-hook-applies-to-exec-command", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when plugin tool.definition hooks for task apply to spawn_agent.
  it.instance.skip("plugin-task-hook-applies-to-spawn-agent", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when ShellTool stays importable + executable from internal code despite being unadvertised.
  it.instance.skip("legacy-shell-tool-still-runnable-from-internal-code", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_4): unskip when TaskTool stays importable + executable from internal code despite being unadvertised.
  it.instance.skip("legacy-task-tool-still-runnable-from-internal-code", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the git safety protocol fragment verbatim in exec_command.txt.
  it.instance.skip("prose-migration-preserves-git-safety-protocol", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the PR creation flow fragment verbatim in exec_command.txt.
  it.instance.skip("prose-migration-preserves-pr-creation-flow", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when prose migration preserves the spawn_agent eligible-subagent-types listing.
  it.instance.skip("prose-migration-preserves-spawn-agent-eligible-list", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_5): unskip when migrated exec_command + spawn_agent descriptions stay within the prompt token budget.
  it.instance.skip("prompt-token-count-within-budget", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_6): unskip when every BACKWARD_COMPAT.md fixture × invocation tuple produces the expected outcome.
  it.instance.skip("bc-matrix-fully-green", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )

  // TODO(wave_6): unskip when the aggregated perf trend table shows no metric drifting beyond the per-wave budget.
  it.instance.skip("perf-trend-no-creep", () =>
    Effect.gen(function* () {
      yield* Effect.void
    }),
  )
})
