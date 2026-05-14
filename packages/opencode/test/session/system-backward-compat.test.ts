// Wave 12 backward-compat — a session whose agent has every new wave-12
// permission denied must produce a system prompt indistinguishable from
// pre-wave-12. The legacy assembly is `[...env, ...instructions, ...(skills
// ? [skills] : [])]`. The wave-12 assembly appends `...capabilityHints`. For
// agents without new permissions the fourth layer must contribute zero
// entries — otherwise the legacy compaction / title / summary / opt-out
// agents leak fragments they were never authorized to use.
//
// This test exercises the actual built-in agent permission rulesets from
// `agent/agent.ts` (not synthetic ones) so a future wave that alters the
// wildcard-deny baseline of compaction/title/summary will fail loudly here.

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

const it = testEffect(
  // The default layer composition gives us the real built-in agent rulesets
  // from `agent/agent.ts`, the real Skill loader, and the real SystemPrompt
  // service — closer to "what a session actually sees" than a hand-crafted
  // Agent.Info would give.
  Layer.mergeAll(SystemPrompt.defaultLayer, Agent.defaultLayer),
)

const DENY_ONLY_AGENTS = ["compaction", "title", "summary"] as const

describe("session.system wave-12 backward compat", () => {
  for (const name of DENY_ONLY_AGENTS) {
    it.live(`${name} agent receives zero capability hint fragments`, () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const agent = yield* agents.get(name)
        expect(agent).toBeDefined()
        const prompt = yield* SystemPrompt.Service
        const hints = yield* prompt.capabilityHints(agent!)
        expect(hints).toEqual([])
      }).pipe(withTmpdirInstance()),
    )
  }
})
