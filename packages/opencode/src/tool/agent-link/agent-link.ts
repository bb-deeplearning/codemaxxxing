// agent-link — D14 (actor-discipline-2026-05-20 Wave 7) — link_agents +
// unlink_agents. Erlang-style symmetric link primitive over the
// AgentControl per-root link map. Linking two siblings means "if either
// dies, the other dies too" — the cascade lives in AgentControl's
// completion watcher; this tool surface only manages the adjacency map.
//
// Two exported Tool.define values in one file, mirroring agent-wait/
// (AgentWaitTool + AgentWaitForReplyTool). Both tools collapse onto the
// shared `task` permission key per the MULTI_AGENT_TOOLS group convention.

import { Effect, Result, Schema } from "effect"
import { AgentControl } from "@/agent/control"
import * as Tool from "../tool"
import { AgentToolContext } from "../agents/current-path"
import DESCRIPTION from "./agent-link.txt"

export const LINK_ID = "link_agents" as const
export const UNLINK_ID = "unlink_agents" as const
// Wave 3 (replace-bash-task-2026-05-15) precedent — every multi-agent v2
// tool collapses its per-call permission key onto "task". Saved
// `permission.task: { ... }` rules transparently gate link_agents and
// unlink_agents. The wildcard `permission.task: { "*": "deny" }` strips
// both from the active toolset (see permission/disabled.ts).
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  target_a: Schema.String.annotate({
    description:
      "First agent in the pair. Relative path (e.g. `worker_a`) resolves under your current canonical path; absolute paths (e.g. `/root/explorers/worker_a`) resolve verbatim. Both peers must live under the same root.",
  }),
  target_b: Schema.String.annotate({
    description:
      "Second agent in the pair. Same format as `target_a`. Order is irrelevant — the link is symmetric.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// One-shape error helper — every typed validation rejection maps to
// { metadata.error: <tag>, output: <reason> } so the model can branch on
// the tag without parsing the prose. Mirror of agent-pool.ts:errorOutput.
const errorOutput = (
  op: "link_agents" | "unlink_agents",
  tag: string,
  target_a: string,
  target_b: string,
  reason: string,
): { title: string; metadata: { error: string; target_a: string; target_b: string; reason: string }; output: string } => ({
  title: `${op} ${tag}`,
  metadata: { error: tag, target_a, target_b, reason },
  output: reason,
})

export const LinkAgentsTool = Tool.define(
  LINK_ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const currentPath = yield* AgentToolContext.currentAgentPath(control, ctx.sessionID)

          // Resolve both targets up-front. Either failure surfaces as
          // target_not_found so the model can distinguish a typo from a
          // cross-root attempt.
          const resolvedA = yield* control
            .resolveAgentReference(currentPath, params.target_a, ctx.sessionID)
            .pipe(Effect.result)
          if (Result.isFailure(resolvedA)) {
            return errorOutput(
              "link_agents",
              "target_not_found",
              params.target_a,
              params.target_b,
              resolvedA.failure.message,
            )
          }
          const resolvedB = yield* control
            .resolveAgentReference(currentPath, params.target_b, ctx.sessionID)
            .pipe(Effect.result)
          if (Result.isFailure(resolvedB)) {
            return errorOutput(
              "link_agents",
              "target_not_found",
              params.target_a,
              params.target_b,
              resolvedB.failure.message,
            )
          }
          const idA = resolvedA.success
          const idB = resolvedB.success

          // Self-link rejected at the tool surface — primitive treats it as
          // a no-op but the user almost certainly meant a different peer.
          if (idA === idB) {
            return errorOutput(
              "link_agents",
              "self_link",
              params.target_a,
              params.target_b,
              "cannot link an agent to itself",
            )
          }

          yield* ctx.ask({
            permission: PermissionKey,
            patterns: [`link:${params.target_a}|${params.target_b}`],
            always: ["*"],
            metadata: {
              target_a: params.target_a,
              target_b: params.target_b,
              target_a_session_id: idA,
              target_b_session_id: idB,
            },
          })

          // After both resolveAgentReference calls succeed, both IDs are
          // guaranteed to live in the caller's per-root slot — the
          // resolver is per-root scoped by construction. linkAgents'
          // typed AgentNotFoundError on the `cross_root` path is
          // therefore unreachable from the tool surface, and we fold it
          // into a defect with Effect.orDie. The cross_root tag remains
          // documented (T1 GOTCHA: cross-root pairs surface
          // AgentNotFoundError matching cross-root-send-rejection's
          // shape — the resolver catches the misuse upstream as
          // target_not_found).
          yield* control.linkAgents(idA, idB, ctx.sessionID).pipe(Effect.orDie)

          return {
            title: `link_agents ${params.target_a} ↔ ${params.target_b}`,
            metadata: {
              target_a: params.target_a,
              target_b: params.target_b,
              target_a_session_id: idA,
              target_b_session_id: idB,
              linked: true,
            },
            output: "Linked",
          }
        }),
    }
  }),
)

export const UnlinkAgentsTool = Tool.define(
  UNLINK_ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const currentPath = yield* AgentToolContext.currentAgentPath(control, ctx.sessionID)

          const resolvedA = yield* control
            .resolveAgentReference(currentPath, params.target_a, ctx.sessionID)
            .pipe(Effect.result)
          if (Result.isFailure(resolvedA)) {
            return errorOutput(
              "unlink_agents",
              "target_not_found",
              params.target_a,
              params.target_b,
              resolvedA.failure.message,
            )
          }
          const resolvedB = yield* control
            .resolveAgentReference(currentPath, params.target_b, ctx.sessionID)
            .pipe(Effect.result)
          if (Result.isFailure(resolvedB)) {
            return errorOutput(
              "unlink_agents",
              "target_not_found",
              params.target_a,
              params.target_b,
              resolvedB.failure.message,
            )
          }
          const idA = resolvedA.success
          const idB = resolvedB.success

          yield* ctx.ask({
            permission: PermissionKey,
            patterns: [`unlink:${params.target_a}|${params.target_b}`],
            always: ["*"],
            metadata: {
              target_a: params.target_a,
              target_b: params.target_b,
              target_a_session_id: idA,
              target_b_session_id: idB,
            },
          })

          // unlinkAgents never fails typed — it's a no-op when the edge
          // does not exist or when peers belong to different roots (the
          // caller-slot lookup short-circuits to a no-op). We still
          // surface a cross_root tag when targets resolved under the
          // caller's root but somehow disagree, mirroring the link branch
          // for symmetry — defensive but unreachable in practice.
          yield* control.unlinkAgents(idA, idB, ctx.sessionID)

          return {
            title: `unlink_agents ${params.target_a} ↔ ${params.target_b}`,
            metadata: {
              target_a: params.target_a,
              target_b: params.target_b,
              target_a_session_id: idA,
              target_b_session_id: idB,
              linked: false,
            },
            output: "Unlinked",
          }
        }),
    }
  }),
)

export * as AgentLink from "./agent-link"
