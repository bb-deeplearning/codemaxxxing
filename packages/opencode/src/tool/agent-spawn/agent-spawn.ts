// spawn_agent — model-facing v2 multi-agent spawn tool. Codex parity:
// codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs +
// codex-rs/core/src/tools/handlers/multi_agents_spec.rs:64-98 (schema) /
// :659-697 (description floor).
//
// Returns immediately with the spawned child's canonical task_name and
// nickname; the child runs in its own fiber under AgentControl. All typed
// errors from AgentControl.spawnAgent (depth, limit, path-invalid,
// path-already-exists, no-nickname) are mapped to model-recoverable
// strings — mirrors codex's FunctionCallError::RespondToModel pattern.

import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { AgentToolContext } from "../agents/current-path"
import DESCRIPTION from "./agent-spawn.txt"

export const ID = "spawn_agent" as const
// Wave 3 (replace-bash-task-2026-05-15): per-call permission key collapsed
// onto "task" — mirror of EDIT_TOOLS where edit/write/apply_patch all
// consult "edit". Saved `permission.task: { ... }` rules transparently
// gate spawn_agent (and the 5 v2 friend tools). Saved per-friend rules
// (`permission.spawn_agent: ...`) silently stop matching; documented in
// BACKWARD_COMPAT.md § "Out of scope" + Wave 6 spec doc.
//
// D12 (actor-discipline-2026-05-20 Wave 5) — the schema below adds two
// supervision-strategy parameters (`on_failure`, `pool_strategy`).
// Defaults are designed to match today's implicit behavior so existing
// callers see NO surface change: omitting both is equivalent to
// `on_failure: "escalate"` + `pool_strategy: "one_for_one"`. The literal
// sets mirror `OnFailureStrategy` and `PoolStrategy` from
// `@/agent/control`; consult that module for the runtime semantics.
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  message: Schema.String.annotate({
    description:
      "Initial plain-text task for the new agent. Be concrete: state the deliverable, the scope, and the format you want back. The child sees this as its first user message and starts working from it immediately.",
  }),
  task_name: Schema.String.annotate({
    description:
      "Lowercase letters, digits, and underscores only. Becomes the leaf component of the canonical path: if your path is /root/explorers, task_name=worker_a yields /root/explorers/worker_a. Pick names that mean something — they show up in list_agents and you'll reference them later.",
  }),
  agent_type: Schema.String.annotate({
    description: "Which subagent to spawn. Must be one of the agent types listed below.",
  }),
  fork_turns: Schema.optional(Schema.String).annotate({
    description:
      "How much of your conversation history the child inherits. `all` (default) forks the full history; `none` starts the child fresh with only the initial message; a positive integer string like `3` forks the last N turns. Use `none` for self-contained tasks; `all` when the child needs your full context.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Optional model override for the new agent. Leave unset to inherit the parent's model — this is the preferred default. Only set when the user explicitly asks for a different model or the task clearly requires one.",
  }),
  reasoning_effort: Schema.optional(Schema.String).annotate({
    description:
      "Optional reasoning effort override for the new agent. Leave unset to inherit the parent's reasoning effort. Only set when the task clearly requires more or less reasoning than the parent's default.",
  }),
  on_failure: Schema.optional(
    Schema.Union([
      Schema.Literal("respawn"),
      Schema.Literal("escalate"),
      Schema.Literal("ignore"),
      Schema.Literal("kill_pool"),
    ]),
  ).annotate({
    description:
      "How the runtime supervises this child's terminal failure (D12). `escalate` (default) = today's behavior: forward an errored notification to your mailbox. `respawn` = the runtime re-spawns the child at the same task_name with a fresh session id (capped at 3 attempts, then escalates with a respawn-cap-exceeded notification). `ignore` = swallow the failure silently (no completion notification). `kill_pool` is stub-only in this release; Wave 6 wires pool semantics.",
  }),
  pool_strategy: Schema.optional(
    Schema.Union([
      Schema.Literal("one_for_one"),
      Schema.Literal("one_for_all"),
      Schema.Literal("rest_for_one"),
    ]),
  ).annotate({
    description:
      "Pool failure semantics (D12, stub-only this release). Stored on the per-child slot for Wave 6 to read when `spawn_pool` lands. `one_for_one` (default) isolates failures; `one_for_all` will tear down the entire pool on any single failure; `rest_for_one` will tear down pool members spawned after the failing one. Today this param has no runtime effect beyond being stored.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// Decode the model's `fork_turns` argument into the AgentControl options
// shape. Mirrors codex spawn.rs:243-277:
//   - undefined / "" / "all" → "all"
//   - "none" → "none"
//   - positive integer string → parsed number
//   - "0" / non-numeric → model-recoverable error string
const decodeForkTurns = (
  raw: string | undefined,
): { ok: true; value: "none" | "all" | number | undefined } | { ok: false; reason: string } => {
  if (raw === undefined) return { ok: true, value: undefined }
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: true, value: undefined }
  const lower = trimmed.toLowerCase()
  if (lower === "none") return { ok: true, value: "none" }
  if (lower === "all") return { ok: true, value: "all" }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n) || String(n) !== trimmed || n <= 0) {
    return {
      ok: false,
      reason: "fork_turns must be `none`, `all`, or a positive integer string",
    }
  }
  return { ok: true, value: n }
}

// Map every typed AgentControl.SpawnError into a single model-recoverable
// shape: { error: <tag>, reason: <message> }. The model reads `output` to
// decide its next move; metadata.error gives the TUI / logs a stable tag.
const errorOutput = (
  task_name: string,
  tag: string,
  reason: string,
): {
  title: string
  metadata: { error: string; reason: string; task_name: string }
  output: string
} => ({
  title: `spawn_agent ${task_name}`,
  metadata: { error: tag, reason, task_name },
  output: reason,
})

// Tag the typed SpawnError into a stable model-facing string so the model
// can branch on `metadata.error` without parsing the prose. One arm per
// tag; reused across every error path.
export const errorTagFor = (
  e:
    | { _tag: "AgentDepthExceededError" }
    | { _tag: "AgentLimitReachedError" }
    | { _tag: "AgentPathInvalidError" }
    | { _tag: "PathAlreadyExistsError" }
    | { _tag: "NoNicknameAvailableError" },
): string => {
  switch (e._tag) {
    case "AgentDepthExceededError":
      return "depth_exceeded"
    case "AgentLimitReachedError":
      return "limit_reached"
    case "AgentPathInvalidError":
      return "path_invalid"
    case "PathAlreadyExistsError":
      return "path_exists"
    case "NoNicknameAvailableError":
      return "no_nickname"
  }
}

export const AgentSpawnTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
            Effect.gen(function* () {
              const fork = decodeForkTurns(params.fork_turns)
              if (!fork.ok) {
                return errorOutput(params.task_name, "fork_turns_invalid", fork.reason)
              }

              // Validate agent_type against the actual subagent-eligible set.
              // Eligible = mode in {"subagent", "all"} AND not hidden. Built-ins
              // yield `explore` + `general` only. Primary agents (build, plan)
              // and hidden internals (compaction, title, summary) are rejected.
              if (params.agent_type !== undefined) {
                const eligible = (yield* agents.list()).filter(
                  (a) => (a.mode === "subagent" || a.mode === "all") && a.hidden !== true,
                )
                const match = eligible.find((a) => a.name === params.agent_type)
                if (!match) {
                  const available = eligible.map((a) => a.name).join(", ")
                  return errorOutput(
                    params.task_name,
                    "agent_type_invalid",
                    `agent_type "${params.agent_type}" is not a spawnable subagent. Available: ${available}.`,
                  )
                }
              }

              const parentPath = yield* AgentToolContext.currentAgentPath(control, ctx.sessionID)

              yield* ctx.ask({
                permission: PermissionKey,
                patterns: [params.task_name],
                always: ["*"],
                metadata: {
                  task_name: params.task_name,
                  agent_type: params.agent_type ?? "default",
                  parent_path: String(parentPath),
                },
              })

              const spawned = yield* control
                .spawnAgent({
                  parentID: ctx.sessionID,
                  parentPath,
                  task_name: params.task_name,
                  agent_type: params.agent_type,
                  initial_message: params.message,
                  options: { fork_turns: fork.value },
                  on_failure: params.on_failure,
                  pool_strategy: params.pool_strategy,
                })
                .pipe(
                  Effect.map((live) => ({ kind: "ok" as const, live })),
                  Effect.catch((e) =>
                    Effect.succeed({
                      kind: "err" as const,
                      tag: errorTagFor(e),
                      reason: e.message,
                    }),
                  ),
                )

              if (spawned.kind === "err") {
                return errorOutput(params.task_name, spawned.tag, spawned.reason)
              }

              const canonical = String(spawned.live.metadata.agent_path ?? "")
              const nickname = spawned.live.metadata.agent_nickname
              const output = { task_name: canonical, nickname }
              return {
                title: `spawn_agent ${canonical}`,
                metadata: {
                  task_name: canonical,
                  nickname,
                  child_session_id: spawned.live.thread_id,
                },
                output: JSON.stringify(output),
              }
            }),
    }
  }),
)

export * as AgentSpawn from "./agent-spawn"
