// Wave 13 backward-compat — system prompt assembly. The wave-12 capability
// hint dispatcher (`SystemPrompt.capabilityHints`) added three new fragments
// that gate on agent permissions. Pre-campaign callers — agents whose
// permission ruleset denies every wave-12 key — must keep getting a
// fragment-free hint list. Otherwise legacy compaction / title / summary
// agents leak the operational manuals they were never authorized to use,
// which inflates input token counts and changes model behavior.
//
// Complementary to test/session/system-backward-compat.test.ts: that file
// asserts the built-in deny-only agents (compaction / title / summary) get
// zero hints. This file widens the coverage to user-defined agents,
// per-key gating, and the build / general / explore positive cases so a
// wave-N regression that flips a default lands here loudly.

import PROMPT_PERSISTENT_PROCESSES from "../../src/agent/prompt/persistent-processes.txt"
import PROMPT_MULTI_AGENT_ROOT from "../../src/agent/prompt/multi-agent-root.txt"
import PROMPT_MULTI_AGENT_SUBAGENT from "../../src/agent/prompt/multi-agent-subagent.txt"

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SystemPrompt.defaultLayer, Agent.defaultLayer))

// Keys that the wave-12 dispatcher checks. A pre-campaign agent ruleset
// won't mention any of these; the capabilityHints function should return an
// empty array for any agent whose effective permission for each key is
// "deny".
const NEW_PERMISSION_KEYS = [
  "exec_command",
  "spawn_agent",
  "send_message",
  "wait_agent",
  "followup_task",
  "list_agents",
  "close_agent",
] as const

function legacyAgent(overrides?: Partial<Agent.Info>): Agent.Info {
  // Synthesize a "user agent from before the campaign" — wildcard deny across
  // every wave-12 key and no wave-12-specific allow. Mirrors how a custom
  // agent block in opencode.json with `permission: { "*": "allow" }` and no
  // explicit wave-12 entries would compose against the post-campaign
  // defaults (which set every wave-12 key to "ask"; with the user wildcard
  // last in the merge the user wildcard wins as "allow"). To simulate a TRUE
  // deny-only legacy agent we explicitly deny every new key.
  return {
    name: "legacy-user-agent",
    description: "Pre-campaign custom agent baseline",
    mode: "primary",
    options: {},
    permission: Permission.fromConfig({
      "*": "allow",
      ...Object.fromEntries(NEW_PERMISSION_KEYS.map((k) => [k, "deny"])),
    }),
    ...overrides,
  }
}

describe("system prompt capability hints — pre-campaign baseline", () => {
  it.live("a custom agent denying every wave-12 key receives zero fragments", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(legacyAgent())
      expect(hints).toEqual([])
    }).pipe(withTmpdirInstance()),
  )

  it.live("a subagent denying every wave-12 key receives zero fragments", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(legacyAgent({ mode: "subagent" }))
      expect(hints).toEqual([])
    }).pipe(withTmpdirInstance()),
  )

  it.live("the built-in plan agent — which the campaign explicitly opts out of wave-12 — receives zero fragments", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plan = yield* agents.get("plan")
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(plan)
      expect(hints).toEqual([])
    }).pipe(withTmpdirInstance()),
  )
})

describe("system prompt capability hints — wave-12 positive cases", () => {
  it.live("the built-in build agent (primary, all allow) receives all three fragments", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(build)
      expect(hints).toContain(PROMPT_PERSISTENT_PROCESSES)
      expect(hints).toContain(PROMPT_MULTI_AGENT_ROOT)
      // build is mode=primary, so the SUBAGENT manual is suppressed —
      // root-vs-subagent voices are mutually exclusive.
      expect(hints).not.toContain(PROMPT_MULTI_AGENT_SUBAGENT)
      expect(hints).toHaveLength(2)
    }).pipe(withTmpdirInstance()),
  )

  it.live("the built-in general agent (subagent, all allow) receives processes + subagent (no root)", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const general = yield* agents.get("general")
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(general)
      expect(hints).toContain(PROMPT_PERSISTENT_PROCESSES)
      expect(hints).toContain(PROMPT_MULTI_AGENT_SUBAGENT)
      expect(hints).not.toContain(PROMPT_MULTI_AGENT_ROOT)
    }).pipe(withTmpdirInstance()),
  )

  it.live("the built-in explore agent (subagent, partial coordination allow) receives only the subagent fragment", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const explore = yield* agents.get("explore")
      const prompt = yield* SystemPrompt.Service
      const hints = yield* prompt.capabilityHints(explore)
      expect(hints).toContain(PROMPT_MULTI_AGENT_SUBAGENT)
      // explore denies exec_command and spawn_agent.
      expect(hints).not.toContain(PROMPT_PERSISTENT_PROCESSES)
      expect(hints).not.toContain(PROMPT_MULTI_AGENT_ROOT)
      expect(hints).toHaveLength(1)
    }).pipe(withTmpdirInstance()),
  )
})

describe("system prompt capability hints — per-key gating", () => {
  it.live("primary agent allowing only exec_command gets persistent-processes only", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const agent = legacyAgent({
        permission: Permission.fromConfig({
          "*": "allow",
          spawn_agent: "deny",
          send_message: "deny",
          wait_agent: "deny",
          followup_task: "deny",
          list_agents: "deny",
          close_agent: "deny",
        }),
      })
      const hints = yield* prompt.capabilityHints(agent)
      expect(hints).toEqual([PROMPT_PERSISTENT_PROCESSES])
    }).pipe(withTmpdirInstance()),
  )

  it.live("primary agent allowing only spawn_agent gets multi-agent-root only", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const agent = legacyAgent({
        permission: Permission.fromConfig({
          "*": "allow",
          exec_command: "deny",
          send_message: "deny",
          wait_agent: "deny",
          followup_task: "deny",
          list_agents: "deny",
          close_agent: "deny",
        }),
      })
      const hints = yield* prompt.capabilityHints(agent)
      expect(hints).toEqual([PROMPT_MULTI_AGENT_ROOT])
    }).pipe(withTmpdirInstance()),
  )

  it.live("subagent allowing only send_message gets multi-agent-subagent only", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const agent = legacyAgent({
        mode: "subagent",
        permission: Permission.fromConfig({
          "*": "allow",
          exec_command: "deny",
          spawn_agent: "deny",
          wait_agent: "deny",
          followup_task: "deny",
          list_agents: "deny",
          close_agent: "deny",
        }),
      })
      const hints = yield* prompt.capabilityHints(agent)
      expect(hints).toEqual([PROMPT_MULTI_AGENT_SUBAGENT])
    }).pipe(withTmpdirInstance()),
  )

  it.live("an `ask`-action permission still triggers fragment injection (deny is the cutoff)", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const agent = legacyAgent({
        permission: Permission.fromConfig({
          "*": "deny",
          exec_command: "ask",
        }),
      })
      const hints = yield* prompt.capabilityHints(agent)
      // The model needs the manual when prompted to use the tool, even if
      // the user has to approve the call interactively. Wave-12 docs this in
      // system.ts:54-58.
      expect(hints).toEqual([PROMPT_PERSISTENT_PROCESSES])
    }).pipe(withTmpdirInstance()),
  )
})
