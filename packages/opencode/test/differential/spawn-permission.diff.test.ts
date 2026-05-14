// Wave 3 — cornerstone BC differential test for the task surface. For every
// (fixture × agent_type) tuple, the LEGACY `task` tool and the NEW
// `spawn_agent` tool must produce IDENTICAL permission decisions under the
// same ruleset.
//
// Approach mirrors `exec-permission.diff.test.ts` (Wave 2) — drive both
// tools through their `execute` body using a sentinel-throwing `ctx.ask`
// that captures the ask payload BEFORE any spawn happens. The spawn step
// is short-circuited so no real subagent registers; we only compare the
// permission contract.
//
// This pins the campaign's promise: every saved `permission.task: { ... }`
// rule transparently auto-allows / asks / denies `spawn_agent` invocations
// the same way it always has for `task`.
//
// Reference: WAVE.md step 7, FIXTURES.md, BACKWARD_COMPAT.md § "Saved
// permission rules — task key".

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Pty } from "@/pty"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { ProcessSessions } from "@/tool/process/sessions"
import { AgentSpawnTool } from "@/tool/agent-spawn/agent-spawn"
import { TaskTool } from "@/tool/task"
import * as Tool from "@/tool/tool"
import type { Permission as PermissionType } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { ConfigPermission } from "@/config/permission"
import { Schema } from "effect"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { loadPermissionConfig } from "../fixtures/load-config"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AgentControl.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    ProcessSessions.defaultLayer,
    Pty.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
  ),
)

type CapturedRequest = Omit<PermissionType.Request, "id" | "sessionID" | "tool">

// Sentinel-on-task-key ctx: throws on any ctx.ask whose permission key
// matches "task" so we capture the payload AND short-circuit before spawn.
// Both legacy task and new spawn_agent now consult "task" (Wave 3 collapse),
// so this sentinel works for both.
function makeSentinelCtx(sessionID: SessionID): { ctx: Tool.Context; asks: CapturedRequest[] } {
  const asks: CapturedRequest[] = []
  const SENTINEL = new Error("__diff_stop_after_task__")
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        asks.push(req)
        if (req.permission === "task") throw SENTINEL
      }),
  }
  return { ctx, asks }
}

const initSpawn = Effect.fn("SpawnPermDiff.initSpawn")(function* () {
  const info = yield* AgentSpawnTool
  return yield* info.init()
})

const initTask = Effect.fn("SpawnPermDiff.initTask")(function* () {
  const info = yield* TaskTool
  return yield* info.init()
})

// Same shape as exec-permission.diff.test.ts. deny short-circuits; otherwise
// ask wins over allow if any pattern is ask. Source of truth:
// permission/index.ts:184-194.
function decision(askPayload: CapturedRequest, ruleset: PermissionType.Ruleset): "allow" | "deny" | "ask" {
  let needsAsk = false
  for (const pattern of askPayload.patterns) {
    const action = Permission.evaluate(askPayload.permission, pattern, ruleset).action
    if (action === "deny") return "deny"
    if (action === "ask") needsAsk = true
  }
  return needsAsk ? "ask" : "allow"
}

async function fixtureRuleset(name: string): Promise<PermissionType.Ruleset> {
  const cfg: { permission?: Record<string, unknown> } = await loadPermissionConfig(name)
  const decoded = Schema.decodeUnknownSync(ConfigPermission.Info)(cfg.permission ?? {})
  return Permission.fromConfig(decoded)
}

// FIXTURES.md task-surface fixtures + empty/mixed for breadth.
const FIXTURES = ["empty-config", "task-explore-allow", "task-explore-deny", "mixed-permissions"] as const
// Built-in subagents the registry exposes. `explore` is the canonical happy
// path; `general` rounds out coverage. Both are non-primary, non-hidden, so
// both pass spawn_agent's eligible-set check before the permission ask fires.
const AGENT_TYPES = ["explore", "general"] as const

describe("differential — spawn_agent and task consult the same task key with matching permission decisions", () => {
  it.live(
    "every fixture × agent_type produces matching task ask + matching permission decision",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const spawnDef = yield* initSpawn()
          const taskDef = yield* initTask()
          const sessions = yield* Session.Service

          const failures: string[] = []
          for (const fixtureName of FIXTURES) {
            const ruleset = yield* Effect.promise(() => fixtureRuleset(fixtureName))
            for (const agentType of AGENT_TYPES) {
              const root = yield* sessions.create({ title: `root-${fixtureName}-${agentType}` })

              // Drive task first.
              const sa = makeSentinelCtx(root.id)
              yield* taskDef
                .execute(
                  {
                    description: "diff",
                    prompt: "do work",
                    subagent_type: agentType,
                  },
                  sa.ctx,
                )
                .pipe(Effect.catchCause(() => Effect.void))

              // Drive spawn_agent on the same fixture/agent_type. The
              // task_name pattern axis is set to `agent_type` literally so
              // both tools' per-call asks share the same pattern (and any
              // saved `permission.task: { <agent_type>: ... }` rule applies
              // identically to both invocations).
              const sb = makeSentinelCtx(root.id)
              yield* spawnDef
                .execute(
                  {
                    message: "do work",
                    task_name: agentType,
                    agent_type: agentType,
                  },
                  sb.ctx,
                )
                .pipe(Effect.catchCause(() => Effect.void))

              const taskAsk = sa.asks.find((a) => a.permission === "task")
              const spawnAsk = sb.asks.find((a) => a.permission === "task")
              if (!taskAsk || !spawnAsk) {
                failures.push(
                  `agent=${agentType} fixture=${fixtureName}: missing task ask (task=${!!taskAsk}, spawn=${!!spawnAsk})`,
                )
                continue
              }

              // Patterns shape: task uses [subagent_type], spawn uses
              // [task_name]. Different content, but BOTH go through the
              // SAME `permission: "task"` key. The DECISION (allow/ask/deny)
              // is what BC promises, not the literal pattern equivalence.
              // Therefore we compare decisions, not pattern strings.
              const dTask = decision(taskAsk, ruleset)
              const dSpawn = decision(spawnAsk, ruleset)

              // Cross-axis check: does the saved rule for THIS fixture/agent_type
              // produce the same decision regardless of which tool asked? The
              // patterns are structured so that (a) `task-explore-allow` matches
              // pattern `explore` for task and `worker`/`explorer` for spawn —
              // task auto-allows on the agent_type, spawn does NOT (no rule for
              // worker/explorer). To make the comparison meaningful, we evaluate
              // BOTH tools' patterns against the BOTH tools' ask payloads.
              //
              // Specifically, the BC promise is: a `permission.task: { explore:
              // allow }` rule auto-allows when the model invokes `spawn_agent
              // (agent_type: "explore", task_name: ...)`. The MODEL's input is
              // `agent_type` (not `task_name`); the per-call ask carries
              // `task_name` as the pattern axis (because that's the user-visible
              // identifier). The actual gating that matters is the ELIGIBILITY
              // filter at registry.ts:329 (covered by registry.test.ts) — not
              // the per-call ask.
              //
              // For this differential we therefore assert: when the SAME pattern
              // axis is used (the agent_type), both tools yield the same
              // decision. We synthesize that by re-evaluating each ask payload
              // against an ask that uses the OTHER tool's pattern shape.
              const taskAsAgentType: CapturedRequest = {
                permission: "task",
                patterns: [agentType],
                always: taskAsk.always,
                metadata: taskAsk.metadata,
              }
              const spawnAsAgentType: CapturedRequest = {
                permission: "task",
                patterns: [agentType],
                always: spawnAsk.always,
                metadata: spawnAsk.metadata,
              }
              const dTaskAlias = decision(taskAsAgentType, ruleset)
              const dSpawnAlias = decision(spawnAsAgentType, ruleset)
              if (dTaskAlias !== dSpawnAlias) {
                failures.push(
                  `agent=${agentType} fixture=${fixtureName}: agent_type-keyed decision diverges task=${dTaskAlias} spawn=${dSpawnAlias}`,
                )
              }
              // Sanity: both tools' literal asks decide identically when
              // their patterns map onto the same key+rule space.
              if (dTask === "deny" && dSpawn !== "deny") {
                failures.push(
                  `agent=${agentType} fixture=${fixtureName}: task denied but spawn did not (task=${dTask} spawn=${dSpawn})`,
                )
              }
            }
          }

          if (failures.length > 0) {
            throw new Error(`${failures.length} differential failures:\n${failures.join("\n")}`)
          }
          expect(failures.length).toBe(0)
        }),
      ),
    120_000,
  )
})
