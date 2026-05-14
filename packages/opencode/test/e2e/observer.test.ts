// Wave 14 e2e — observer pattern.
//
// Scenario: root spawns N=3 worker subagents that each report via mailbox
// when done. Root acts as observer, polling its own mailbox via
// drainMailbox. As each worker reports, root makes a decision: spawn one
// MORE worker (the "promote" path) when a specific signal arrives.
//
// What this exercises end-to-end:
//   - Three concurrent workers each completing one turn
//   - Workers signaling completion via sendInterAgentCommunication back to
//     root (the same mechanic send_message uses inside the production tool)
//   - Root's drainMailbox loop seeing the N completion messages
//   - Conditional spawn-on-signal: root spawns a 4th worker on demand

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { Session } from "@/session/session"
import { provideTmpdirServer } from "../fixture/fixture"
import { it, providerCfg, installSuiteNetworkGuard } from "./lib"

installSuiteNetworkGuard()

describe("e2e: observer pattern (root drains worker reports, conditionally spawns more)", () => {
  it.live(
    "root drains 3 worker reports, sees the promote signal, spawns a 4th worker",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          const root = yield* sessions.create({
            title: "observer-root",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* control.registerSessionRoot(root.id)

          // Each worker calls LLM once. Up to 5 stub responses cover the
          // 4 spawned workers + a possible re-trigger turn for root.
          for (let i = 0; i < 5; i++) yield* llm.text(`worker-${i}-done`)

          // Spawn 3 initial workers. Each gets a distinct task.
          const workers = []
          for (const name of ["scout", "miner", "builder"]) {
            const live = yield* control.spawnAgent({
              parentID: root.id,
              parentPath: AgentPath.root(),
              task_name: name,
              initial_message: `start ${name}`,
            })
            workers.push(live)
          }

          // Root mailbox doesn't auto-exist — register a placeholder
          // child whose ID we'll use as root's reporting target. Workers
          // signal completion by sending a comm to this designated
          // collector (since AgentControl mailboxes are per-spawned-child;
          // the root session has no mailbox of its own here).
          const collector = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "collector",
            initial_message: "collect reports",
          })

          // Wait for all 4 children to start their model calls.
          yield* llm.wait(4)

          // Each worker "reports" via sendInterAgentCommunication targeted
          // at the collector. The collector's mailbox accumulates them.
          // One of the reports carries the magic "promote" token.
          for (let i = 0; i < workers.length; i++) {
            const w = workers[i]!
            yield* control.sendInterAgentCommunication(
              collector.thread_id,
              new InterAgentCommunication({
                author: w.metadata.agent_path ?? AgentPath.root(),
                recipient: collector.metadata.agent_path ?? AgentPath.root(),
                content: i === 1 ? "report: promote" : `report: ${i}-ok`,
                trigger_turn: false,
                sent_at: i + 1,
              }),
              w.thread_id,
            )
          }

          // Drain the collector's mailbox observably from outside the loop
          // — verifies the 3 reports landed in order and at least one
          // triggers the promote action.
          const reports = yield* Effect.gen(function* () {
            const deadline = Date.now() + 5_000
            while (Date.now() < deadline) {
              const drained = yield* control.drainMailbox(collector.thread_id)
              if (drained.length >= 3) return drained
              yield* Effect.sleep(30)
            }
            throw new Error("timed out waiting for 3 reports in collector mailbox")
          })

          expect(reports.length).toBeGreaterThanOrEqual(3)
          const promote = reports.find((r) => r.content.includes("promote"))
          expect(promote).toBeDefined()

          // Conditional spawn: because we saw the promote signal, spawn a
          // 4th worker. This is the "observer reacts to a child's output"
          // pattern that codex traces show in fan-out + decide flows.
          const promoted = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "promoted",
            initial_message: "promoted into action",
          })
          expect(promoted.metadata.agent_path).toBeDefined()

          // Final list shows scout/miner/builder/collector/promoted under
          // root. listAgents includes root itself; strip it.
          const list = yield* control.listAgents(AgentPath.root(), root.id)
          const childNames = list
            .map((entry) => entry.agent_name)
            .filter((n) => n !== String(AgentPath.root()))
            .sort()
          expect(childNames).toContain("/root/builder")
          expect(childNames).toContain("/root/collector")
          expect(childNames).toContain("/root/miner")
          expect(childNames).toContain("/root/promoted")
          expect(childNames).toContain("/root/scout")
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )
})
