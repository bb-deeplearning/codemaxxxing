// Wave 14 e2e — permission denial.
//
// Scenario: a session whose permission ruleset denies `spawn_agent` runs
// the model loop. Because the deny rule has a wildcard pattern, the
// resolveTools step in `LLM.stream` removes `spawn_agent` from the active
// tool set entirely — the model never sees it as an option. When the
// (stubbed) model nonetheless tries to call it, the AI SDK routes the
// call through the `invalid` tool wrapper which surfaces "tool not
// available" back to the model. The model emits a follow-up text and the
// loop exits cleanly. No AgentControl child is ever created.
//
// What this exercises end-to-end:
//   - Permission.disabled removes wildcard-deny tools from the model's
//     active set (`session/llm.ts:451`)
//   - InvalidTool wraps unknown tool calls without crashing the loop
//     (`tool/invalid.ts`)
//   - Permission.merge(agent.permission, session.permission) honors
//     session-level deny rules
//   - The session keeps streaming text after a denial — no leaked fibers,
//     no stuck status, no AgentControl child created

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { provideTmpdirServer } from "../fixture/fixture"
import { it, providerCfg, installSuiteNetworkGuard } from "./lib"

installSuiteNetworkGuard()

describe("e2e: permission denial (spawn_agent denied via ruleset; loop continues cleanly)", () => {
  it.live(
    "spawn_agent stripped from active tools; model's attempt routes to invalid; loop continues",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service

          // Session permission rule denies spawn_agent specifically. The
          // build agent's defaults allow it, but session permission is
          // merged on top of agent permission and wins for the matching
          // permission key. The wildcard pattern triggers the
          // resolveTools-side filter that removes the tool entirely.
          const chat = yield* sessions.create({
            title: "deny-spawn",
            permission: [
              { permission: "spawn_agent", pattern: "*", action: "deny" },
            ],
          })

          // Two scripted responses:
          //   1. tool_calls: spawn_agent  (will be routed to invalid)
          //   2. text: "denied. falling back."
          yield* llm.tool("spawn_agent", { message: "do work", task_name: "denied_one" })
          yield* llm.text("denied. falling back.")

          // Seed a user message and run the loop.
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "spawn a worker" }],
          })

          const result = yield* prompt.loop({ sessionID: chat.id })
          expect(result.info.role).toBe("assistant")

          // Two model calls — tool_calls + the followup text.
          expect(yield* llm.calls).toBeGreaterThanOrEqual(2)

          // Verify the tool call landed under the `invalid` wrapper, with
          // the spawn_agent name surfaced in the input — proves the AI SDK
          // could not route to spawn_agent (filtered out at resolveTools).
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const invalidTool = msgs
            .filter((m) => m.info.role === "assistant")
            .flatMap((m) => m.parts)
            .find(
              (p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "invalid",
            )
          expect(invalidTool).toBeDefined()
          if (invalidTool && invalidTool.state.status === "completed") {
            const input = invalidTool.state.input as { tool?: string; error?: string }
            expect(input.tool).toBe("spawn_agent")
            expect(input.error).toContain("spawn_agent")
            // The error message lists what tools ARE available — confirm
            // the v2 surface is intact apart from spawn_agent.
            expect(input.error).toContain("send_message")
            expect(input.error).toContain("list_agents")
            // And spawn_agent is not in the available list.
            expect(input.error).not.toMatch(/Available tools:.*?\bspawn_agent\b/)
          }

          // The model's followup text persists in the transcript.
          const followup = msgs
            .filter((m) => m.info.role === "assistant")
            .flatMap((m) => m.parts)
            .filter((p): p is MessageV2.TextPart => p.type === "text")
            .find((p) => p.text.includes("falling back"))
          expect(followup).toBeDefined()

          // No AgentControl child got created — the registry is empty.
          const live = (yield* control.listAgents(AgentPath.root()))
            .map((entry) => entry.agent_name)
            .filter((n) => n !== String(AgentPath.root()))
          expect(live).toEqual([])
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )
})
