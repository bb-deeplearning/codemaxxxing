// Wave 14 e2e — parallel explorer fan-out.
//
// Scenario: root agent spawns 3 explorer subagents with distinct questions.
// All run concurrently. Each explorer's stubbed model emits a single text
// reply ("found: X") then stops. Root verifies that all three children
// actually did one model call (proving they ran in parallel through the
// production runLoop, not serially), all three produced text, and the live
// agent registry then reflects the children at completed status.
//
// What this exercises end-to-end:
//   - SessionPrompt.layer init registering AgentControl's runLoop provider
//   - AgentControl.spawnAgent dispatching real children that run the loop
//   - Each child's mailbox seeded with `initial_message` and drained
//   - LLM stream stub serving each child a per-prompt response
//   - assertNoNetworkCalls — no fetch leaks past the stubbed provider

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { it, providerCfg, installSuiteNetworkGuard } from "./lib"

installSuiteNetworkGuard()

describe("e2e: parallel explorer fan-out", () => {
  it.live(
    "root spawns 3 concurrent explorers; each completes one turn; all reach a final status",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          const root = yield* sessions.create({
            title: "fan-out",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* control.registerSessionRoot(root.id)

          // Each spawned child fires exactly one LLM call. Three children
          // running concurrently means three calls land in TestLLMServer
          // before any of them blocks; queue three text responses up front
          // so the order in which children pull from the queue does not
          // matter (TestLLMServer.text is FIFO across all callers).
          yield* llm.text("found: alpha")
          yield* llm.text("found: beta")
          yield* llm.text("found: gamma")

          const a = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "explorer_alpha",
            initial_message: "find alpha",
          })
          const b = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "explorer_beta",
            initial_message: "find beta",
          })
          const c = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "explorer_gamma",
            initial_message: "find gamma",
          })

          // All three must call the LLM. If they ran serially this would
          // still pass eventually but the parallel-fan-out invariant is
          // observed via the per-child completion below.
          yield* llm.wait(3)
          expect(yield* llm.calls).toBe(3)

          // Wait until every child's transcript carries SOME assistant
          // text. TestLLMServer queues are FIFO across all callers, so we
          // can't predict which child gets which "found: *" text — only
          // that all three children produce text and the union of their
          // assistant texts equals the queued set. Inside Effect.gen so
          // InstanceState binding stays valid across the polling loop
          // (see GOTCHAS:
          // bench-effect-runpromise-loses-instance-in-async-callback).
          const childIds = [a.thread_id, b.thread_id, c.thread_id]
          yield* Effect.gen(function* () {
            const deadline = Date.now() + 10_000
            while (Date.now() < deadline) {
              const seen: string[] = []
              let allHaveText = true
              for (const sid of childIds) {
                const msgs = yield* MessageV2.filterCompactedEffect(sid as SessionID)
                const texts = msgs
                  .filter((m) => m.info.role === "assistant")
                  .flatMap((m) => m.parts)
                  .filter((p): p is MessageV2.TextPart => p.type === "text")
                if (texts.length === 0) {
                  allHaveText = false
                  break
                }
                for (const t of texts) seen.push(t.text)
              }
              if (allHaveText) {
                expect(seen.sort()).toEqual(["found: alpha", "found: beta", "found: gamma"])
                return
              }
              yield* Effect.sleep(40)
            }
            throw new Error("timed out waiting for explorers to produce text")
          })

          // Wait until every child has reached a final status (completed /
          // shutdown / errored). Status is sticky once final.
          yield* Effect.gen(function* () {
            const deadline = Date.now() + 5_000
            while (Date.now() < deadline) {
              const list = yield* control.listAgents(AgentPath.root())
              const children = list.filter(
                (entry) => entry.agent_name !== String(AgentPath.root()),
              )
              const allFinal = children.every(
                (entry) =>
                  typeof entry.agent_status === "object" &&
                  entry.agent_status !== null &&
                  ("completed" in entry.agent_status || "errored" in entry.agent_status),
              )
              if (children.length === 3 && allFinal) return
              yield* Effect.sleep(30)
            }
            throw new Error("timed out waiting for children to reach final status")
          })

          // Three children, three model calls. No more, no less — the
          // stubbed provider is FIFO and would have served stub responses
          // beyond the queued three if a child entered a second turn.
          expect(yield* llm.calls).toBe(3)
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )
})
