import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { ExecCommandTool } from "./process/exec-command"
import { WriteStdinTool } from "./process/write-stdin"
import { ProcessSessions } from "./process/sessions"
import { AgentSpawnTool } from "./agent-spawn/agent-spawn"
import { AgentSendTool } from "./agent-send/agent-send"
import { AgentFollowupTool } from "./agent-followup/agent-followup"
import { AgentWaitTool } from "./agent-wait/agent-wait"
import { AgentListTool } from "./agent-list/agent-list"
import { AgentCloseTool } from "./agent-close/agent-close"
import { AgentControl } from "@/agent/control"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { Schema } from "effect"
import z from "zod"
import { ZodOverride } from "@/util/effect-zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { Pty } from "@/pty"

const log = Log.create({ service: "tool.registry" })

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | Provider.Service
  | LSP.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
  | Pty.Service
  | ProcessSessions.Service
  | AgentControl.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const execcommand = yield* ExecCommandTool
    const writestdin = yield* WriteStdinTool
    const agentspawn = yield* AgentSpawnTool
    const agentsend = yield* AgentSendTool
    const agentfollowup = yield* AgentFollowupTool
    const agentwait = yield* AgentWaitTool
    const agentlist = yield* AgentListTool
    const agentclose = yield* AgentCloseTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools define their args as a raw Zod shape. Wrap the
          // derived Zod object in a `Schema.declare` so it slots into the
          // Schema-typed framework, and annotate with `ZodOverride` so the
          // walker emits the original Zod object for LLM JSON Schema.
          const zodParams = z.object(def.args)
          const parameters = Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success).annotate({
            [ZodOverride]: zodParams,
          })
          return {
            id,
            parameters,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => toolCtx.ask(req),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: "",
                  output: out.truncated ? out.content : output,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          execcommand: Tool.init(execcommand),
          writestdin: Tool.init(writestdin),
          agentspawn: Tool.init(agentspawn),
          agentsend: Tool.init(agentsend),
          agentfollowup: Tool.init(agentfollowup),
          agentwait: Tool.init(agentwait),
          agentlist: Tool.init(agentlist),
          agentclose: Tool.init(agentclose),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            // tool.shell — model surface dropped Wave 4 of replace-bash-task-2026-05-15;
            // exec_command + write_stdin replace it. Internal callers can still
            // resolve via `import { ShellTool } from "@/tool/shell"` directly.
            // The `shell` binding above (line 220) and `state.task: tool.task` at
            // the end of this object both stay so legacy code paths continue to
            // compile. The plugin-hook bridge in `tools()` below dispatches
            // tool.definition events with toolID="bash" for exec_command and
            // write_stdin so plugins keying on the legacy ID continue to mutate
            // the new tools' descriptions.
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            // tool.task — model surface dropped Wave 4 of replace-bash-task-2026-05-15;
            // spawn_agent + 5 v2 friends (send_message, followup_task,
            // wait_agent, list_agents, close_agent) replace it. Internal
            // callers (none today, but kept for plugin reactivation) can
            // still resolve via `named().task` — the `task: tool.task`
            // self-reference at the bottom of this return object still
            // wires that up. The plugin-hook bridge in `tools()` below
            // dispatches tool.definition events with toolID="task" for
            // spawn_agent + the 5 friends so plugins keying on the legacy
            // ID continue to mutate their descriptions.
            tool.fetch,
            tool.todo,
            tool.search,
            tool.skill,
            tool.patch,
            tool.execcommand,
            tool.writestdin,
            tool.agentspawn,
            tool.agentsend,
            tool.agentfollowup,
            tool.agentwait,
            tool.agentlist,
            tool.agentclose,
            ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
            ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    // Mirror of describeTask for spawn_agent. Filter to subagent-eligible
    // (mode !== "primary"), not hidden, and not deny-permissioned. Built-ins
    // yield `explore` + `general` only. User-defined subagent / all -mode
    // agents flow through naturally.
    //
    // Wave 3 (replace-bash-task-2026-05-15): filter consults the "task"
    // permission key (was "spawn_agent"). Symmetric with describeTask
    // immediately above. Saved `permission.task: { explore: deny }` rules
    // now filter explore from BOTH tools' enumerations consistently.
    const describeSpawnAgent = Effect.fn("ToolRegistry.describeSpawnAgent")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary" && item.hidden !== true)
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return input.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }

          // Wave 4 (replace-bash-task-2026-05-15) — plugin hook bridge.
          // Tools whose model-facing surface replaces a dropped legacy
          // tool ALSO dispatch a tool.definition event under the legacy
          // ID so plugins keying on `bash` / `task` continue to mutate
          // the new tools' descriptions. Bridge dispatches LEGACY FIRST
          // so its mutations land on `output` before the new-id hook
          // sees the same reference (per WAVE.md gotcha 3 — reversing
          // the order would let the legacy hook clobber the new one).
          //
          // Only `tool.definition` is bridged. `tool.execute.before` /
          // `tool.execute.after` (fired from `session/prompt.ts`) are
          // NOT bridged because execution semantics differ between
          // bash (one-shot) and exec_command (persistent PTY); a plugin
          // wrapping bash execution would mishandle exec_command's
          // PID/yield semantics. Documented as a plugin migration
          // boundary in BACKWARD_COMPAT.md "Out of scope".
          //
          // Bridge map is per-new-id → legacy-id, mirroring the
          // SHELL_TOOLS / MULTI_AGENT_TOOLS group routing in
          // permission/index.ts. Adding a new bridged tool means adding
          // a row here AND extending the relevant group constant.
          const legacyId =
            tool.id === ExecCommandTool.id || tool.id === WriteStdinTool.id
              ? ShellTool.id
              : tool.id === AgentSpawnTool.id ||
                  tool.id === AgentSendTool.id ||
                  tool.id === AgentFollowupTool.id ||
                  tool.id === AgentWaitTool.id ||
                  tool.id === AgentListTool.id ||
                  tool.id === AgentCloseTool.id
                ? TaskTool.id
                : null
          if (legacyId) {
            yield* plugin.trigger("tool.definition", { toolID: legacyId }, output)
          }

          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          return {
            id: tool.id,
            description: [
              output.description,
              // tool.id === TaskTool.id branch: dead code after Wave 4
              // dropped tool.task from `builtin` — `filtered` no longer
              // contains a tool whose id matches TaskTool.id. Left for
              // plugin reactivation paths that might re-register the
              // legacy task tool via `Plugin.tool` overrides; harmless
              // when dead because the boolean short-circuits to undefined
              // and `.filter(Boolean)` drops it.
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === AgentSpawnTool.id ? yield* describeSpawnAgent(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Pty.defaultLayer),
    Layer.provide(ProcessSessions.defaultLayer),
    Layer.provide(AgentControl.defaultLayer),
  ),
)

export * as ToolRegistry from "./registry"
