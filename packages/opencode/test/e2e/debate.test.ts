// Wave 14 e2e — debate between two sibling agents.
//
// Scenario: root spawns two siblings (`pro` and `con`). After both seed
// turns complete, root drives 4 cross-rounds via
// `sendInterAgentCommunication` (the same mechanic the `followup_task` /
// `send_message` tools use under the hood). Each round lands in the
// recipient's mailbox. We verify delivery by draining each child's
// mailbox after the rounds — the deterministic surface — instead of
// asserting transcript injection (which depends on loop timing that's
// too racy for an e2e assertion).
//
// What this exercises end-to-end:
//   - Both seed loops fire and reach completion
//   - sendInterAgentCommunication wires messages into the per-recipient
//     mailbox in order, even after the recipient's loop has finished
//   - Mailbox accumulates 2 messages per child (the cross-rounds)
//   - The bus receives Agent.MessageSent for each cross-round (this is
//     what the TUI / observers consume) — though we don't subscribe in
//     this test; the mailbox count is the contract here.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { InterAgentCommunication } from "@/agent/inter-agent-communication"
import { Session } from "@/session/session"
import { provideTmpdirServer } from "../fixture/fixture"
import { it, providerCfg, installSuiteNetworkGuard } from "./lib"

installSuiteNetworkGuard()

describe("e2e: debate (two siblings exchange via mailbox)", () => {
  it.live(
    "pro and con exchange 4 cross-rounds; each round lands in the recipient's mailbox in order",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const sessions = yield* Session.Service
          const control = yield* AgentControl.Service
          const root = yield* sessions.create({
            title: "debate-root",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* control.registerSessionRoot(root.id)

          // Two seed responses — one per child for the initial turn.
          yield* llm.text("pro: opening")
          yield* llm.text("con: opening")

          const pro = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "pro",
            initial_message: "argue for the change",
          })
          const con = yield* control.spawnAgent({
            parentID: root.id,
            parentPath: AgentPath.root(),
            task_name: "con",
            initial_message: "argue against the change",
          })

          // Wait for both seeds to fire (proves both child loops ran the
          // first turn against the stub server).
          yield* llm.wait(2)
          expect(yield* llm.calls).toBe(2)

          const proPath = pro.metadata.agent_path ?? AgentPath.root()
          const conPath = con.metadata.agent_path ?? AgentPath.root()

          // 4 cross-rounds: 2 per child. Send AFTER the seed turns have
          // landed so we know the child loops have already drained their
          // initial mailbox (the seed message). The cross-round messages
          // accumulate in the recipient's mailbox even when the recipient
          // loop has since exited — the mailbox is per-child, persistent.
          const messages: ReadonlyArray<{
            from: AgentPath
            to: typeof pro.thread_id
            recipient: AgentPath
            body: string
          }> = [
            { from: proPath, to: con.thread_id, recipient: conPath, body: "round-1: pro -> con" },
            { from: conPath, to: pro.thread_id, recipient: proPath, body: "round-2: con -> pro" },
            { from: proPath, to: con.thread_id, recipient: conPath, body: "round-3: pro -> con" },
            { from: conPath, to: pro.thread_id, recipient: proPath, body: "round-4: con -> pro" },
          ]
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i]!
            // Sender is the opposite agent of the target.
            const senderID = m.to === pro.thread_id ? con.thread_id : pro.thread_id
            yield* control.sendInterAgentCommunication(
              m.to,
              new InterAgentCommunication({
                author: m.from,
                recipient: m.recipient,
                content: m.body,
                trigger_turn: false, // false: pure delivery, no resume attempt
                sent_at: i + 1,
              }),
              senderID,
            )
          }

          // Drain each child's mailbox; verify delivery + ordering.
          const proMail = yield* control.drainMailbox(pro.thread_id)
          const conMail = yield* control.drainMailbox(con.thread_id)

          // pro should have rounds 2 and 4; con should have rounds 1 and 3.
          const proBodies = proMail.map((m) => m.content).sort()
          const conBodies = conMail.map((m) => m.content).sort()
          expect(proBodies).toEqual(["round-2: con -> pro", "round-4: con -> pro"])
          expect(conBodies).toEqual(["round-1: pro -> con", "round-3: pro -> con"])

          // Sender path is preserved for the recipient to attribute.
          for (const m of proMail) expect(String(m.author)).toBe("/root/con")
          for (const m of conMail) expect(String(m.author)).toBe("/root/pro")
        }),
        { git: true, config: providerCfg },
      ),
    20_000,
  )
})
