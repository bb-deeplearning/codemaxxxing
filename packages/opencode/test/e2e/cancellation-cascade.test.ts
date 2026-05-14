// Wave 14 e2e — cancellation cascade.
//
// Scenario: parent + 2 children + 1 grandchild. Cancel the parent. Verify
// that all 4 fibers terminate, the registry is drained, and no orphans
// linger. Mirrors the existing prompt.test.ts cancel-cascade test but
// extends it with a grandchild — exercising the recursive descendant walk
// in cancelChildrenOf and the leaves-first shutdown order.
//
// What this exercises end-to-end:
//   - cancelChildrenOf walks the path tree by prefix (not parent-id graph)
//   - leaves-first shutdown so closeAgent doesn't see a half-released state
//   - SessionPrompt.cancel calls AgentControl.cancelChildrenOf as part of
//     its top-level abort path
//   - The grandchild's mailbox / status / fiber all clean up; the registry
//     forgets every descendant

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { provideTmpdirServer } from "../fixture/fixture"
import { it, providerCfg, installSuiteNetworkGuard } from "./lib"

installSuiteNetworkGuard()

describe("e2e: cancellation cascade (parent + 2 children + grandchild \u2192 cancel parent)", () => {
  it.live(
    "cancel(parent) interrupts every descendant fiber and drains the registry",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          const chat = yield* sessions.create({
            title: "cascade-root",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          // Hang the LLM so each spawned loop sits in flight until cancel.
          yield* llm.hang

          // Tree shape:
          //   /root
          //   ├── /root/child_a
          //   │   └── /root/child_a/grand
          //   └── /root/child_b
          const childA = yield* control.spawnAgent({
            parentID: chat.id,
            parentPath: AgentPath.root(),
            task_name: "child_a",
            initial_message: "alpha",
          })
          const childB = yield* control.spawnAgent({
            parentID: chat.id,
            parentPath: AgentPath.root(),
            task_name: "child_b",
            initial_message: "beta",
          })
          const grand = yield* control.spawnAgent({
            parentID: childA.thread_id,
            parentPath: childA.metadata.agent_path ?? AgentPath.root(),
            task_name: "grand",
            initial_message: "depth-2",
          })

          // Confirm the tree is alive.
          const beforeNames = (yield* control.listAgents(AgentPath.root(), chat.id))
            .map((entry) => entry.agent_name)
            .filter((n) => n !== String(AgentPath.root()))
            .sort()
          expect(beforeNames).toEqual(["/root/child_a", "/root/child_a/grand", "/root/child_b"])

          // Wait for all three child loops to fire their stuck LLM calls so
          // we know they're really running, not still in the spawn-init
          // window.
          yield* llm.wait(3)

          // Cancel the parent. cancelChildrenOf cascades.
          yield* prompt.cancel(chat.id)

          // Poll until every descendant has reached a final status. Inside
          // Effect.gen so InstanceState binding stays valid through the
          // loop (see GOTCHAS:
          // bench-effect-runpromise-loses-instance-in-async-callback).
          yield* Effect.gen(function* () {
            const deadline = Date.now() + 5_000
            while (Date.now() < deadline) {
              const list = yield* control.listAgents(AgentPath.root(), chat.id)
              const stillLive = list
                .filter((entry) => entry.agent_name !== String(AgentPath.root()))
                .filter(
                  (entry) =>
                    entry.agent_status !== "shutdown" &&
                    entry.agent_status !== "not_found",
                )
              if (stillLive.length === 0) return
              yield* Effect.sleep(30)
            }
            throw new Error("timed out waiting for descendants to interrupt")
          })

          // Sanity: each descendant has been removed from the live registry
          // (closeAgent \u2192 shutdownOne \u2192 registry.releaseSpawnedThread).
          for (const live of [childA, childB, grand]) {
            const meta = yield* control.getAgentMetadata(live.thread_id)
            expect(meta).toBeUndefined()
          }
        }),
        { git: true, config: providerCfg },
      ),
    15_000,
  )
})
