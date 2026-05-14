// Wave 14 e2e — sequential worker pipeline.
//
// Scenario: root spawns worker_a for phase-1 work. After phase-1's text
// reply lands, root spawns worker_b for phase-2 with phase-1's result
// passed via initial_message. Verifies sequential delegation with context
// handoff: worker_a's deliverable is materially observable in worker_b's
// transcript via the spawn-time mailbox seed.

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

describe("e2e: worker pipeline (phase-1 \u2192 phase-2 with context handoff)", () => {
  it.live(
    "phase-2 worker receives phase-1's output via initial_message",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          const root = yield* sessions.create({
            title: "pipeline-root",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* control.registerSessionRoot(root.id)

          // Two sequential model responses — one per worker, served FIFO.
          yield* llm.text("phase-1 result: cache key bug at file.ts:42")
          yield* llm.text("phase-2 ack: applied fix from cache key bug at file.ts:42")

          const phaseOne = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "phase_one",
            initial_message: "investigate the cache key bug",
          })

          // Wait until phase-1 produces an assistant text response.
          const phaseOneText = yield* Effect.gen(function* () {
            const deadline = Date.now() + 8_000
            while (Date.now() < deadline) {
              const msgs = yield* MessageV2.filterCompactedEffect(phaseOne.thread_id as SessionID)
              const text = msgs
                .filter((m) => m.info.role === "assistant")
                .flatMap((m) => m.parts)
                .filter((p): p is MessageV2.TextPart => p.type === "text")
                .find((p) => p.text.startsWith("phase-1 result"))
              if (text) return text.text
              yield* Effect.sleep(40)
            }
            throw new Error("timed out waiting for phase-1 result")
          })

          // Spawn phase-2 with phase-1's text as the initial message — the
          // canonical "pipe the deliverable into the next stage" pattern.
          const phaseTwo = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "phase_two",
            initial_message: `Apply this fix: ${phaseOneText}`,
          })

          // Verify phase-2's user-side mailbox-drained transcript carries
          // phase-1's deliverable verbatim.
          yield* Effect.gen(function* () {
            const deadline = Date.now() + 8_000
            while (Date.now() < deadline) {
              const msgs = yield* MessageV2.filterCompactedEffect(phaseTwo.thread_id as SessionID)
              const userText = msgs
                .filter((m) => m.info.role === "user")
                .flatMap((m) => m.parts)
                .filter((p): p is MessageV2.TextPart => p.type === "text")
                .find((p) => p.text.includes("cache key bug at file.ts:42"))
              if (userText) return
              yield* Effect.sleep(40)
            }
            throw new Error("phase-2 never received phase-1's deliverable")
          })

          // Verify phase-2 also produced its assistant ack.
          yield* Effect.gen(function* () {
            const deadline = Date.now() + 8_000
            while (Date.now() < deadline) {
              const msgs = yield* MessageV2.filterCompactedEffect(phaseTwo.thread_id as SessionID)
              const ack = msgs
                .filter((m) => m.info.role === "assistant")
                .flatMap((m) => m.parts)
                .filter((p): p is MessageV2.TextPart => p.type === "text")
                .find((p) => p.text.startsWith("phase-2 ack"))
              if (ack) return
              yield* Effect.sleep(40)
            }
            throw new Error("timed out waiting for phase-2 ack")
          })

          // Two model calls total — one per worker, in order.
          expect(yield* llm.calls).toBe(2)

          // listAgents reports both children.
          const list = yield* control.listAgents(AgentPath.root(), root.id)
          const names = list.map((entry) => entry.agent_name).sort()
          expect(names).toContain("/root/phase_one")
          expect(names).toContain("/root/phase_two")
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )
})
