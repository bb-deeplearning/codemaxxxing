import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { AgentPath } from "@/agent/agent-path"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { currentAgentPath } from "./current-path"
import { disposeAllInstances, provideTmpdirInstance } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    AgentControl.defaultLayer,
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const installNeverLoop = Effect.gen(function* () {
  const control = yield* AgentControl.Service
  yield* control.registerRunLoop(() => Effect.never)
})

describe("currentAgentPath", () => {
  it.live("returns AgentPath.root() and lazy-registers an unknown session as root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const control = yield* AgentControl.Service

        // Pre-condition: root not registered yet, so no metadata, no rootRef.
        const before = yield* control.getAgentMetadata(root.id)
        expect(before).toBeUndefined()

        const path = yield* currentAgentPath(control, root.id)
        expect(String(path)).toBe(String(AgentPath.root()))

        // Post-condition: root is now registered — resolveAgentReference
        // can resolve the root path back to this session id.
        const resolved = yield* control.resolveAgentReference(AgentPath.root(), "/root")
        expect(resolved).toBe(root.id)
      }),
    ),
  )

  it.live("returns the agent_path of a registered sub-agent without re-registering root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const control = yield* AgentControl.Service
        yield* control.registerSessionRoot(root.id)

        const child = yield* control.spawnAgent({
          parentID: root.id,
          parentPath: AgentPath.root(),
          task_name: "worker_a",
          initial_message: "do x",
        })

        const path = yield* currentAgentPath(control, child.thread_id)
        expect(String(path)).toBe("/root/worker_a")
      }),
    ),
  )

  it.live("re-registering root via the helper is idempotent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "root" })
        const control = yield* AgentControl.Service

        // Two consecutive helper calls on the same fresh root id must each
        // succeed. The second call sees existing metadata and short-circuits
        // to AgentPath.root() — but the rootRef must still resolve.
        const p1 = yield* currentAgentPath(control, root.id)
        const p2 = yield* currentAgentPath(control, root.id)
        expect(String(p1)).toBe("/root")
        expect(String(p2)).toBe("/root")

        const resolved = yield* control.resolveAgentReference(AgentPath.root(), "/root")
        expect(resolved).toBe(root.id)
      }),
    ),
  )

  it.live("an unknown random session id (not registered, not spawned) lazy-registers as root", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* installNeverLoop
        const control = yield* AgentControl.Service
        const fakeId = SessionID.make("ses_fake_root")

        const path = yield* currentAgentPath(control, fakeId)
        expect(String(path)).toBe("/root")

        // The fake id is now bound to the root reference.
        const resolved = yield* control.resolveAgentReference(AgentPath.root(), "/root")
        expect(resolved).toBe(fakeId)
      }),
    ),
  )
})
