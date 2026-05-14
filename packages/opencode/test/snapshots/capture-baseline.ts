// Wave 0 sub-agent C — behavioral baseline snapshot capture.
//
// Writes 14 files into
// `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/`:
//
//   - tool-list-{build,caveman,explore,general,plan}.json
//       The output of `ToolRegistry.tools({...})` for each agent, projected to
//       `[{ id, descriptionTokens }]` and sorted by id.
//   - permission-prompts/{bash-git-status,bash-rm-tmp,bash-cd-home,
//       exec-command-git-status,spawn-agent-explore}.json
//       The Permission.Request payload published as `Permission.Event.Asked`,
//       captured by stubbing `ctx.ask` and short-circuiting before any real
//       spawn. `bash-rm-tmp` / `bash-cd-home` produce TWO requests in order
//       (external_directory then bash) per BACKWARD_COMPAT.md § "File-touch
//       detection" — wrapped as { requests: [...] }.
//   - prompt-prose/{bash-description,exec-command-description,task-description,
//       spawn-agent-description}.txt
//       The rendered description string the model sees. For task and
//       spawn-agent, rendered through the `build` agent so describeTask /
//       describeSpawnAgent expand the per-subagent listing consistently.
//
// Token-count proxy: `description.length` (byte length). The repo currently
// ships no tokenizer wrapper; PERF.md § "Prompt token budget" treats this
// as a proxy and Wave 5 will revisit if a real tokenizer lands.
//
// Caveman agent fixture: bound to repo root because
// `.opencode/agent/caveman.md` lives there. WAVE.md gotcha 8.
//
// Run from packages/opencode/:
//   bun run test/snapshots/capture-baseline.ts

import path from "path"
import { Effect } from "effect"
import { AppRuntime, type AppServices } from "../../src/effect/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { ToolRegistry } from "../../src/tool/registry"
import { Agent } from "../../src/agent/agent"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import type * as Tool from "../../src/tool/tool"
import type { Permission } from "../../src/permission"

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")
const ARTIFACTS = path.join(
  REPO_ROOT,
  ".wave",
  "campaigns",
  "replace-bash-task-2026-05-15",
  "artifacts",
  "snapshots",
)

const STUB_MODEL = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

type CapturedAsk = Omit<Permission.Request, "id" | "sessionID" | "tool">

// Make a Tool.Context whose `ask` records the request and (optionally) throws
// a sentinel after `stopAfter` calls to short-circuit before the spawn. The
// payload pushed to `requests` is identical to what `Permission.Event.Asked`
// would publish (Permission.ask wraps it with an id + sessionID and bus-
// publishes the same fields).
function captureCtx(
  sessionID: SessionID,
  requests: CapturedAsk[],
  stopAfter?: number,
): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
        if (stopAfter !== undefined && requests.length >= stopAfter) throw SENTINEL
      }),
  }
}

// Project a Tool.Def onto the snapshot row and sort. Token-count proxy is
// `description.length` per the spec; later waves can swap in a real tokenizer
// without changing the file shape.
function projectToolList(tools: ReadonlyArray<{ id: string; description: string }>) {
  return tools
    .map((t) => ({ id: t.id, descriptionTokens: t.description.length }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

const SENTINEL = new Error("capture-baseline: stop after first ctx.ask")

// Substitute pid:<actual-number> with the literal placeholder pid:<N> so the
// snapshot is stable across runs. Per WAVE.md gotcha 7 / spec.
function stripPid(req: CapturedAsk): CapturedAsk {
  const replace = (s: string) => s.replace(/^pid:\d+$/, "pid:<N>")
  return {
    ...req,
    patterns: req.patterns.map(replace),
    always: req.always.map(replace),
    metadata: req.metadata,
  }
}

const captureToolList = (agentName: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const agent = yield* agents.get(agentName)
    const tools = yield* registry.tools({ ...STUB_MODEL, agent })
    return projectToolList(tools)
  })

// Swallow both typed errors and defects (the sentinel comes through as a
// defect because tool.execute is wrapped in Effect.orDie). v4 names:
// `Effect.catch` replaces `catchAll`; `Effect.catchCause` covers both arms.
const swallow = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.catchCause(eff, () => Effect.void)

// Resolve a tool's execute fn by looking it up in the registry's per-agent
// `tools()` output. This routes through the registry's defaultLayer which
// transitively provides every dep (CrossSpawnSpawner, Pty, etc.) the tool
// needs. Yielding the tool's `Effect` directly would leave the spawner
// unsatisfied because AppLayer doesn't list it at top level.
const toolDef = (toolID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const tools = yield* registry.tools({ ...STUB_MODEL, agent: build })
    const found = tools.find((t) => t.id === toolID)
    if (!found) throw new Error(`tool ${toolID} not present`)
    return found
  })

const captureBashGitStatus = Effect.gen(function* () {
  const def = yield* toolDef("bash")
  const requests: CapturedAsk[] = []
  // Single bash ask for `git status` — stop right after.
  const ctx = captureCtx(SessionID.make("ses_capture"), requests, 1)
  yield* swallow(def.execute({ command: "git status", description: "git status" }, ctx))
  return requests
})

const captureBashRmTmp = Effect.gen(function* () {
  const def = yield* toolDef("bash")
  const requests: CapturedAsk[] = []
  // Two asks expected: external_directory then bash. Per BACKWARD_COMPAT.md
  // § "File-touch detection" the order matters — captured in invocation order.
  const ctx = captureCtx(SessionID.make("ses_capture"), requests, 2)
  yield* swallow(def.execute({ command: "rm /tmp/foo", description: "remove tmp file" }, ctx))
  return requests
})

const captureBashCdHome = Effect.gen(function* () {
  const def = yield* toolDef("bash")
  const requests: CapturedAsk[] = []
  // cd-only commands skip the bash patterns branch (shell.ts:402) so only the
  // external_directory ask fires. Stop after 1 so the actual `cd` never runs.
  const ctx = captureCtx(SessionID.make("ses_capture"), requests, 1)
  yield* swallow(def.execute({ command: "cd /home/user", description: "cd home" }, ctx))
  return requests
})

const captureExecCommandGitStatus = Effect.gen(function* () {
  const def = yield* toolDef("exec_command")
  const requests: CapturedAsk[] = []
  // exec_command allocates the PTY before ctx.ask (see exec-command.ts:114).
  // Throwing the sentinel inside ask triggers the acquireUseRelease cleanup
  // hook, so the PTY is released before this Effect returns.
  const ctx = captureCtx(SessionID.make("ses_capture"), requests, 1)
  yield* swallow(def.execute({ cmd: "git status", yield_time_ms: 250 }, ctx))
  return requests
})

const captureSpawnAgentExplore = Effect.gen(function* () {
  // Fresh session so spawn_agent's parent path resolves to /root.
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "snapshot-root" })
  const def = yield* toolDef("spawn_agent")
  const requests: CapturedAsk[] = []
  const ctx = captureCtx(root.id, requests, 1)
  yield* swallow(def.execute({ message: "snap", task_name: "snap", agent_type: "explore" }, ctx))
  return requests
})

const renderDescription = (toolID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const tools = yield* registry.tools({ ...STUB_MODEL, agent: build })
    const found = tools.find((t) => t.id === toolID)
    if (!found) throw new Error(`tool ${toolID} not present in build's tool list`)
    return found.description
  })

const writeJson = async (rel: string, value: unknown) => {
  const out = path.join(ARTIFACTS, rel)
  await Bun.write(out, JSON.stringify(value, null, 2) + "\n")
}

const writeText = async (rel: string, value: string) => {
  const out = path.join(ARTIFACTS, rel)
  await Bun.write(out, value)
}

// AppRuntime accepts any effect whose requirements are a subset of AppServices.
// TypeScript's variance check on Effect.R collapses similarly-named Service
// types and rejects the assignment; cast through `AppServices` so the call
// site type-checks while preserving the success type.
const run = <A>(eff: Effect.Effect<A, never, never>): Promise<A> =>
  AppRuntime.runPromise(eff as Effect.Effect<A, never, AppServices>)

const main = async () => {
  // Bind the script's instance to the repo root. The repo's
  // `.opencode/agent/caveman.md` is loaded from this directory, so the same
  // Agent.Service instance can answer .get("caveman") alongside the built-in
  // build/plan/general/explore agents. Per WAVE.md gotcha 8.
  return WithInstance.provide({
    directory: REPO_ROOT,
    fn: async () => {
      // tool-list snapshots — one per agent.
      for (const name of ["build", "caveman", "explore", "general", "plan"] as const) {
        const list = await run(captureToolList(name) as Effect.Effect<unknown, never, never> as Effect.Effect<{ id: string; descriptionTokens: number }[], never, never>)
        await writeJson(`tool-list-${name}.json`, list)
      }

      // permission-prompts.
      const bashGit = await run(captureBashGitStatus as Effect.Effect<CapturedAsk[], never, never>)
      await writeJson("permission-prompts/bash-git-status.json", bashGit[0])

      const bashRm = await run(captureBashRmTmp as Effect.Effect<CapturedAsk[], never, never>)
      await writeJson("permission-prompts/bash-rm-tmp.json", { requests: bashRm })

      const bashCd = await run(captureBashCdHome as Effect.Effect<CapturedAsk[], never, never>)
      // cd-only commands skip the bash patterns branch (shell.ts:402) — so
      // this typically produces ONLY external_directory. Wrap as { requests }
      // so the file shape matches bash-rm-tmp.json (later waves diff this).
      await writeJson("permission-prompts/bash-cd-home.json", { requests: bashCd })

      const execGit = await run(captureExecCommandGitStatus as Effect.Effect<CapturedAsk[], never, never>)
      // pid:<actual-pid> in `always` would change every run — substitute the
      // literal placeholder so the snapshot is stable.
      await writeJson(
        "permission-prompts/exec-command-git-status.json",
        execGit[0] ? stripPid(execGit[0]) : null,
      )

      const spawn = await run(captureSpawnAgentExplore as Effect.Effect<CapturedAsk[], never, never>)
      await writeJson("permission-prompts/spawn-agent-explore.json", spawn[0])

      // prompt-prose — rendered through the build agent so describeTask /
      // describeSpawnAgent attach a consistent per-subagent listing.
      const bashDesc = await run(renderDescription("bash") as Effect.Effect<string, never, never>)
      await writeText("prompt-prose/bash-description.txt", bashDesc)

      const execDesc = await run(renderDescription("exec_command") as Effect.Effect<string, never, never>)
      await writeText("prompt-prose/exec-command-description.txt", execDesc)

      const taskDesc = await run(renderDescription("task") as Effect.Effect<string, never, never>)
      await writeText("prompt-prose/task-description.txt", taskDesc)

      const spawnDesc = await run(renderDescription("spawn_agent") as Effect.Effect<string, never, never>)
      await writeText("prompt-prose/spawn-agent-description.txt", spawnDesc)
    },
  })
}

main()
  .then(async () => {
    await AppRuntime.dispose()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error(err)
    await AppRuntime.dispose().catch(() => undefined)
    process.exit(1)
  })
