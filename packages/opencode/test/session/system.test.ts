import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Agent } from "../../src/agent/agent"
import { AgentControl } from "../../src/agent/control"
import { AgentPath } from "../../src/agent/agent-path"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  Layer.mergeAll(
    SystemPrompt.layer.pipe(
      Layer.provide(
        Layer.succeed(
          Skill.Service,
          Skill.Service.of({
            get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
            all: () => Effect.succeed(skills),
            dirs: () => Effect.succeed([]),
            available: () => Effect.succeed(skills),
          }),
        ),
      ),
      // D2 (actor-discipline-2026-05-20) — SystemPrompt's layer now requires
      // AgentControl so capabilityHints can resolve the caller's canonical
      // path for the per-spawn block. Tests that don't exercise the
      // sessionID arg get the same behaviour as before (no path block).
      Layer.provide(AgentControl.defaultLayer),
    ),
    // Expose Session + AgentControl as test-callable services so the D2
    // it.instance tests can spawn a real subagent to resolve a non-root
    // canonical path. The layers self-supply Config / CrossSpawnSpawner.
    Session.defaultLayer,
    AgentControl.defaultLayer,
  ),
)

describe("session.system", () => {
  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
    }),
  )

  it.effect("skills output is undefined when the agent denies the skill permission", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const denied: Agent.Info = {
        name: "denied",
        mode: "primary",
        permission: Permission.fromConfig({ skill: "deny" }),
        options: {},
      }
      expect(yield* prompt.skills(denied)).toBeUndefined()
    }),
  )

  it.instance("environment renders the working directory, worktree, platform, and date", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const result = yield* prompt.environment({
        api: { id: "claude-3-7" },
        providerID: "anthropic",
      } as never)
      expect(result).toHaveLength(1)
      const text = result[0]
      expect(text).toContain("Working directory:")
      expect(text).toContain("Workspace root folder:")
      expect(text).toContain("Platform:")
      expect(text).toContain("anthropic/claude-3-7")
    }),
  )
})

describe("session.system provider dispatch", () => {
  // provider() is a pure switchboard; cover every model id branch so that
  // adding a new provider in a future wave forces a conscious test update.
  const cases: { id: string; expectIncludes: string }[] = [
    { id: "gpt-4-turbo", expectIncludes: "" },
    { id: "o1-mini", expectIncludes: "" },
    { id: "o3-pro", expectIncludes: "" },
    { id: "gpt-3.5-codex", expectIncludes: "" },
    { id: "gpt-3.5", expectIncludes: "" },
    { id: "gemini-1.5", expectIncludes: "" },
    { id: "claude-sonnet-4", expectIncludes: "" },
    { id: "Trinity-1", expectIncludes: "" },
    { id: "moonshot-Kimi", expectIncludes: "" },
    { id: "unknown-model", expectIncludes: "" },
  ]
  for (const { id } of cases) {
    it.effect(`provider returns a non-empty prompt array for ${id}`, () =>
      Effect.gen(function* () {
        const prompts = SystemPrompt.provider({ api: { id }, providerID: "x" } as never)
        expect(prompts).toHaveLength(1)
        expect(typeof prompts[0]).toBe("string")
        expect(prompts[0].length).toBeGreaterThan(0)
      }),
    )
  }
})

// Wave 12 — capability hint fragments. Three fragments injected into the
// system message based on the agent's permission ruleset and mode. See
// PROMPT_ENGINEERING.md § "Required new system fragments".

const PERSISTENT_PROCESSES_MARKER = "Persistent processes"
const ROOT_AGENT_MARKER = "Multi-agent coordination — root agent"
const SUBAGENT_MARKER = "Multi-agent coordination — subagent"

const agentWith = (overrides: Partial<Agent.Info>): Agent.Info => ({
  name: overrides.name ?? "test",
  mode: overrides.mode ?? "primary",
  permission: overrides.permission ?? [],
  options: overrides.options ?? {},
  ...overrides,
})

describe("session.system capability hints", () => {
  it.effect("Fragment A injected when agent has exec_command allowed", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({ exec_command: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(PERSISTENT_PROCESSES_MARKER))).toBe(true)
    }),
  )

  it.effect("Fragment A injected when exec_command is `ask` (still teachable)", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({ exec_command: "ask" }),
        }),
      )
      expect(hints.some((text) => text.includes(PERSISTENT_PROCESSES_MARKER))).toBe(true)
    }),
  )

  it.effect("Fragment A omitted when exec_command is denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({ exec_command: "deny" }),
        }),
      )
      expect(hints.some((text) => text.includes(PERSISTENT_PROCESSES_MARKER))).toBe(false)
    }),
  )

  it.effect("Fragment B injected for primary mode + spawn_agent allowed", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({ spawn_agent: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(ROOT_AGENT_MARKER))).toBe(true)
    }),
  )

  it.effect("Fragment B omitted for subagent mode even with spawn_agent allowed", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ spawn_agent: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(ROOT_AGENT_MARKER))).toBe(false)
    }),
  )

  it.effect("Fragment B omitted for primary mode when spawn_agent denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({ spawn_agent: "deny" }),
        }),
      )
      expect(hints.some((text) => text.includes(ROOT_AGENT_MARKER))).toBe(false)
    }),
  )

  it.effect("Fragment C injected for subagent mode with send_message allowed", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ send_message: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(SUBAGENT_MARKER))).toBe(true)
    }),
  )

  it.effect("Fragment C injected for subagent mode with wait_agent allowed even when send_message denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ send_message: "deny", wait_agent: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(SUBAGENT_MARKER))).toBe(true)
    }),
  )

  it.effect("Fragment C omitted for subagent mode when both send_message and wait_agent denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ send_message: "deny", wait_agent: "deny" }),
        }),
      )
      expect(hints.some((text) => text.includes(SUBAGENT_MARKER))).toBe(false)
    }),
  )

  it.effect("Fragment C omitted for primary mode even with send_message allowed", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({ send_message: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(SUBAGENT_MARKER))).toBe(false)
    }),
  )

  it.effect("`all`-mode agent with spawn_agent + exec_command allowed receives Fragment A and Fragment B", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "all",
          permission: Permission.fromConfig({ exec_command: "allow", spawn_agent: "allow" }),
        }),
      )
      expect(hints.some((text) => text.includes(PERSISTENT_PROCESSES_MARKER))).toBe(true)
      expect(hints.some((text) => text.includes(ROOT_AGENT_MARKER))).toBe(true)
    }),
  )

  it.effect("agent with no relevant permissions returns an empty fragment list (backward compat)", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "primary",
          permission: Permission.fromConfig({
            "*": "deny",
            exec_command: "deny",
            spawn_agent: "deny",
            send_message: "deny",
            wait_agent: "deny",
          }),
        }),
      )
      expect(hints).toEqual([])
    }),
  )

  it.effect("hint output is stable across calls (no side effects)", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const agent = agentWith({
        mode: "primary",
        permission: Permission.fromConfig({ exec_command: "allow", spawn_agent: "allow" }),
      })
      const first = yield* prompt.capabilityHints(agent)
      const second = yield* prompt.capabilityHints(agent)
      expect(first).toEqual(second)
    }),
  )

  // D2 (actor-discipline-2026-05-20) — per-spawn canonical-path block. The
  // subagent fragment is followed by a templated block naming the agent's
  // canonical path when (a) sessionID is supplied AND (b) the path is not
  // root. The block teaches the model how to self-close. Pre-D2 the
  // subagent had no way to know its own canonical path; this is the fix.
  it.instance("D2: subagent fragment is followed by a canonical-path block when sessionID resolves", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      // Spawn a real subagent so currentAgentPath resolves to /root/worker.
      yield* control.registerRunLoop(() => Effect.never)
      const root = yield* sessions.create({ title: "root" })
      yield* control.registerSessionRoot(root.id)
      const child = yield* control.spawnAgent({
        parentID: root.id,
        parentPath: AgentPath.root(),
        task_name: "worker",
        initial_message: ".",
      })

      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ send_message: "allow" }),
        }),
        child.thread_id,
      )
      // Subagent fragment is in the list AND so is the per-spawn path block.
      const joined = hints.join("\n\n")
      expect(joined.includes(SUBAGENT_MARKER)).toBe(true)
      expect(joined).toContain("/root/worker")
      expect(joined).toContain("Your canonical path")
      expect(joined).toContain(`close_agent(target: "/root/worker")`)
    }),
  )

  it.instance("D2: omitting sessionID does NOT append the canonical-path block (backward compat)", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ send_message: "allow" }),
        }),
      )
      const joined = hints.join("\n\n")
      expect(joined.includes(SUBAGENT_MARKER)).toBe(true)
      expect(joined).not.toContain("Your canonical path")
    }),
  )

  it.instance("D2: sessionID that resolves to root path does NOT append the block (defensive)", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* AgentControl.Service
      // A bare root session — currentAgentPath returns AgentPath.root().
      const root = yield* sessions.create({ title: "root" })
      yield* control.registerSessionRoot(root.id)

      const prompt = yield* SystemPrompt.Service
      // Even with subagent mode and a sessionID, root's path means we skip
      // the block — root is the user's session, not a subagent address.
      const hints = yield* prompt.capabilityHints(
        agentWith({
          mode: "subagent",
          permission: Permission.fromConfig({ send_message: "allow" }),
        }),
        root.id,
      )
      const joined = hints.join("\n\n")
      expect(joined.includes(SUBAGENT_MARKER)).toBe(true)
      expect(joined).not.toContain("Your canonical path")
    }),
  )
})
