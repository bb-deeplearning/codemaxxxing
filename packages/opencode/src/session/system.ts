import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"

import PROMPT_PERSISTENT_PROCESSES from "@/agent/prompt/persistent-processes.txt"
import PROMPT_MULTI_AGENT_ROOT from "@/agent/prompt/multi-agent-root.txt"
import PROMPT_MULTI_AGENT_SUBAGENT from "@/agent/prompt/multi-agent-subagent.txt"

import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { AgentToolContext } from "@/tool/agents/current-path"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { SessionID } from "@/session/schema"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  // capabilityHints (D2 actor-discipline-2026-05-20): sessionID is optional
  // for backward compatibility with existing callers that don't have one
  // (assembly-order regression tests, prompt-render benches). When supplied
  // AND the agent is a subagent AND the subagent fragment is being injected,
  // we append a per-spawn "Your canonical path" block templated with the
  // agent's `/root/<task_name>` path so the subagent knows how to address
  // itself (close_agent(target: "<path>"), send_message author = <path>).
  readonly capabilityHints: (
    agent: Agent.Info,
    sessionID?: SessionID,
  ) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

// Wave 12 — capability hint dispatcher. Each fragment is gated on the agent's
// effective permission for the relevant tool key. Mirrors codex's
// `multi_agent_v2.{root_agent,subagent}_usage_hint_text` injection in
// `core/src/session/multi_agents.rs`. We additionally gate the persistent-
// process fragment on `exec_command` permission so an agent that has the
// tools surfaced gets the operational manual.
//
// "has the permission" = effective wildcard action is not "deny". An "ask"
// action still triggers injection: the user is prompted at call time but the
// model needs to know when the tool is appropriate. Denied agents (compaction
// / title / summary; user opt-outs) get an empty fragment list — the legacy
// system prompt assembly is unchanged for them.
function permitted(agent: Agent.Info, key: string): boolean {
  return Permission.evaluate(key, "*", agent.permission).action !== "deny"
}

// D2 (actor-discipline-2026-05-20) — per-spawn canonical-path block appended
// to the subagent fragment. Rendered LAST in the capability hints array so
// the subagent's most recent guidance is the operational manual + their own
// address. The leading newline keeps the per-spawn block visually separated
// from the static multi-agent-subagent.txt content when both render.
const renderCanonicalPathBlock = (path: string): string =>
  [
    "",
    "## Your canonical path",
    "",
    `You are operating as \`${path}\`. To close yourself:`,
    "",
    `  close_agent(target: "${path}")`,
    "  # or just omit the target; defaults to self.",
  ].join("\n")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const control = yield* AgentControl.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      capabilityHints: Effect.fn("SystemPrompt.capabilityHints")(function* (
        agent: Agent.Info,
        sessionID?: SessionID,
      ) {
        const hints: string[] = []
        if (permitted(agent, "exec_command")) hints.push(PROMPT_PERSISTENT_PROCESSES)
        // Root-agent guidance only fires for agents that can hold the user-
        // facing root role (primary or all) AND can spawn. Subagents see the
        // subagent fragment instead even when they happen to also have spawn
        // permission (a depth-2 subagent that spawns its own children still
        // operates under "you are a subagent" rules).
        if (agent.mode !== "subagent" && permitted(agent, "spawn_agent")) hints.push(PROMPT_MULTI_AGENT_ROOT)
        // Subagent guidance fires when the agent can communicate back to the
        // tree (send or wait). An agent with neither has no coordination
        // surface and doesn't need the subagent operational manual.
        if (agent.mode === "subagent" && (permitted(agent, "send_message") || permitted(agent, "wait_agent"))) {
          hints.push(PROMPT_MULTI_AGENT_SUBAGENT)
          // D2 (actor-discipline-2026-05-20) — per-spawn canonical path. The
          // subagent fragment is the only fragment whose addressee changes
          // per-spawn; templating happens here at render time rather than
          // baking placeholders into the .txt file. Skipped when sessionID
          // is omitted (legacy callers — assembly-order tests, benches) and
          // when the agent's canonical path resolves to root (defensive —
          // a subagent should never have root's path, but the
          // currentAgentPath lazy-register helper returns root for an
          // unknown session).
          if (sessionID !== undefined) {
            const path = yield* AgentToolContext.currentAgentPath(control, sessionID)
            const pathStr = String(path)
            if (pathStr !== "/root") {
              hints.push(renderCanonicalPathBlock(pathStr))
            }
          }
        }
        return hints
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(AgentControl.defaultLayer),
)

export * as SystemPrompt from "./system"
