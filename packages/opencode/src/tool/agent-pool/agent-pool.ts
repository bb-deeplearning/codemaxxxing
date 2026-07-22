// spawn_pool — D13 (actor-discipline-2026-05-20 Wave 6) — first-class
// fan-out primitive. Wraps spawn_agent × N + wait_agent + bookkeeping in
// one tool call. Per-root scoped via Tool.Context.sessionID + the
// AgentControl pool primitives (createPool / collectPool / closePoolMembers).
//
// Returns once the chosen collect strategy is satisfied (or timeout fires).
// Pool member spawning is non-atomic per WAVE.md gotcha 1 — partial
// failures land in the `failures` array; the call only short-circuits with
// `spawn_all_failed` when EVERY member failed to spawn.

import { Agent } from "@/agent/agent"
import { AgentControl } from "@/agent/control"
import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { AgentToolContext } from "../agents/current-path"
import DESCRIPTION from "./agent-pool.txt"

export const ID = "spawn_pool" as const
// Wave 3 (replace-bash-task-2026-05-15) precedent — every multi-agent v2
// tool collapses its per-call permission key onto "task" (mirror of
// EDIT_TOOLS where edit/write/apply_patch all consult "edit"). Saved
// `permission.task: { ... }` rules transparently gate spawn_pool. The
// wildcard `permission.task: { "*": "deny" }` strips spawn_pool from the
// active toolset (see permission/disabled.ts).
export const PermissionKey = "task" as const

export const Parameters = Schema.Struct({
  agent_type: Schema.String.annotate({
    description:
      "Which subagent definition to spawn for every member of the pool. Must be a spawnable subagent (mode in {subagent, all}, not hidden). Same eligibility rules as spawn_agent.",
  }),
  count: Schema.Number.annotate({
    description:
      "Number of workers to fan out. Must be > 0. Counts against the 64-process concurrent thread cap — pool size > 10 is almost always wrong.",
  }),
  message: Schema.String.annotate({
    description:
      "Common initial task body broadcast to every member. Overridden per-index by per_worker_messages when provided. Workers receive this as their first user message.",
  }),
  per_worker_messages: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional per-member initial messages. When provided, length MUST equal count; index i is the message for member i. Use when each worker needs a different task scope. Omit to broadcast the common `message` to all members.",
  }),
  collect: Schema.Union([
    Schema.Literal("all"),
    Schema.Literal("first"),
    Schema.Literal("any_n"),
  ]).annotate({
    description:
      "How to decide the call has produced its result. `all` waits for every member to deliver. `first` returns on the first deliverable and closes the rest. `any_n` returns when collect_n members have delivered, leaving the others alive.",
  }),
  collect_n: Schema.optional(Schema.Number).annotate({
    description:
      "Required when collect=\"any_n\". Must satisfy 1 <= collect_n <= count. Ignored for collect=\"all\" / \"first\".",
  }),
  pool_strategy: Schema.optional(
    Schema.Union([
      Schema.Literal("one_for_one"),
      Schema.Literal("one_for_all"),
      Schema.Literal("rest_for_one"),
    ]),
  ).annotate({
    description:
      "Erlang OTP-style supervision policy applied to every member. `one_for_one` (default) isolates failures. `one_for_all` tears down the entire pool on any failure. `rest_for_one` tears down members spawned after the failing one. Forwarded to each member's spawn_agent.",
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
      "Per-member failure policy forwarded to spawn_agent. `escalate` (default) surfaces a completion notification on terminal failure. `respawn` re-spawns the member at the same task_name (capped at 3 attempts). `ignore` swallows. `kill_pool` tears down the pool on member failure.",
  }),
  task_prefix: Schema.optional(Schema.String).annotate({
    description:
      "Leaf prefix for member task names. Members become `<task_prefix>_0`, `<task_prefix>_1`, … Defaults to `pool` — yielding `pool_0`, `pool_1`, etc. Pick a meaningful prefix when multiple pools coexist under the same parent.",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description:
      "Collect deadline in milliseconds. When the deadline fires before the collect strategy is satisfied, the call returns with `timed_out: true` and whatever deliverables landed in the window. Omit to block until the strategy is satisfied (use sparingly — tests should always pass an explicit value).",
  }),
  fork_turns: Schema.optional(Schema.String).annotate({
    description:
      "How much of your conversation history each member inherits. `all` (default) forks the full history; `none` starts fresh with only the initial message; a positive integer string like `3` forks the last N turns. Use `none` for self-contained tasks.",
  }),
  isolation: Schema.optional(Schema.Union([Schema.Literal("none"), Schema.Literal("worktree")])).annotate({
    description:
      "Filesystem isolation for every member. `worktree` gives each member its own git checkout on its own branch (named from the member task name), so N writers can run in parallel without trampling each other. Clean checkouts remove themselves when members finish; ones with commits are kept and each completion notification reports branch/ahead/dirty. Worktree creation is capped per project (disk ceiling) — a pool larger than the remaining budget fails with the ceiling message. Defaults to the agent type's configured isolation, else `none`. Read-only pools should stay in the shared directory.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// Decode the model's `fork_turns` argument into the AgentControl options
// shape (mirror of agent-spawn.ts:91-108). Defaults / `all` → "all"; `none`
// → "none"; positive integer string → number; everything else is a
// model-recoverable error so the call surfaces the typo to the model.
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

// One-shape error helper — every typed validation rejection maps to
// { metadata.error: <tag>, output: <reason> } so the model can branch on
// the tag without parsing the prose.
const errorOutput = (
  tag: string,
  reason: string,
): { title: string; metadata: { error: string; reason: string }; output: string } => ({
  title: `spawn_pool ${tag}`,
  metadata: { error: tag, reason },
  output: reason,
})

export const AgentPoolTool = Tool.define(
  ID,
  Effect.gen(function* () {
    const control = yield* AgentControl.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          // 1. count > 0
          if (params.count <= 0) {
            return errorOutput("count_invalid", "count must be > 0")
          }

          // 2. per_worker_messages.length === count when provided.
          if (
            params.per_worker_messages !== undefined &&
            params.per_worker_messages.length !== params.count
          ) {
            return errorOutput(
              "per_worker_messages_length",
              `per_worker_messages length ${params.per_worker_messages.length} must equal count ${params.count}`,
            )
          }

          // 3. collect="any_n" → collect_n provided AND 1 <= n <= count.
          if (params.collect === "any_n") {
            if (params.collect_n === undefined) {
              return errorOutput("collect_n_required", 'collect="any_n" requires collect_n')
            }
            if (params.collect_n <= 0 || params.collect_n > params.count) {
              return errorOutput(
                "collect_n_out_of_range",
                `collect_n ${params.collect_n} must satisfy 1 <= n <= count (${params.count})`,
              )
            }
          }

          // 4. agent_type must be a spawnable subagent (mode in {subagent,
          //    all}, not hidden). Mirrors agent-spawn.ts:172-184.
          const eligible = (yield* agents.list()).filter(
            (a) => (a.mode === "subagent" || a.mode === "all") && a.hidden !== true,
          )
          const match = eligible.find((a) => a.name === params.agent_type)
          if (!match) {
            const available = eligible.map((a) => a.name).join(", ")
            return errorOutput(
              "agent_type_invalid",
              `agent_type "${params.agent_type}" is not a spawnable subagent. Available: ${available}.`,
            )
          }

          // 5. fork_turns decode.
          const fork = decodeForkTurns(params.fork_turns)
          if (!fork.ok) {
            return errorOutput("fork_turns_invalid", fork.reason)
          }

          // 6. Resolve caller's canonical path (idempotent root-register).
          const parentPath = yield* AgentToolContext.currentAgentPath(control, ctx.sessionID)

          // 7. Permission gate — collapsed onto the "task" key.
          yield* ctx.ask({
            permission: PermissionKey,
            patterns: [`pool:${params.count}:${params.agent_type}`],
            always: ["*"],
            metadata: {
              agent_type: params.agent_type,
              count: params.count,
              collect: params.collect,
              parent_path: String(parentPath),
            },
          })

          // 7b. Spawn isolation (idea-worktrees, 2026-07-22) — one worktree
          // per member, created up front so every member's isolation object
          // rides CreatePoolInput and AgentControl stays mechanics-free.
          // The isolation PHASE is atomic (any create failure tears the
          // batch down and fails the call — the ceiling message tells the
          // model to shrink the pool); member SPAWNING stays non-atomic per
          // pool doctrine, and worktrees of failed spawns are removed.
          const isolationMode = params.isolation ?? match.isolation ?? "none"
          const prefix = params.task_prefix ?? "pool"
          let memberIsolation: AgentControl.CreatePoolInput["per_member_isolation"] = undefined
          if (isolationMode === "worktree") {
            const built = yield* Effect.promise(async () => {
              const [{ AppRuntime }, { Worktree }, { InstanceStore }] = await Promise.all([
                import("@/effect/app-runtime"),
                import("@/worktree"),
                import("@/project/instance-store"),
              ])
              const removeAll = (directories: string[]) =>
                AppRuntime.runPromise(
                  Worktree.Service.use((svc) =>
                    Effect.forEach(directories, (directory) => svc.remove({ directory }).pipe(Effect.ignore), {
                      concurrency: 2,
                    }),
                  ),
                ).catch(() => {})
              try {
                const value = await AppRuntime.runPromise(
                  Effect.gen(function* () {
                    const svc = yield* Worktree.Service
                    const store = yield* InstanceStore.Service
                    return yield* Effect.forEach(
                      Array.from({ length: params.count }, (_, i) => i),
                      (i) =>
                        Effect.gen(function* () {
                          const info = yield* svc.makeWorktreeInfo({ name: `${prefix}-${i}` })
                          yield* svc.createFromInfo(info)
                          const context = yield* store.load({ directory: info.directory })
                          return { directory: info.directory, branch: info.branch, context }
                        }),
                      { concurrency: 2 },
                    )
                  }),
                )
                return { ok: true as const, value, removeAll }
              } catch (error) {
                return {
                  ok: false as const,
                  reason: error instanceof Error ? error.message : String(error),
                  removeAll,
                }
              }
            })
            if (!built.ok) {
              return errorOutput("isolation_failed", `Could not create isolated checkouts: ${built.reason}`)
            }
            memberIsolation = built.value
          }

          // 8. Fan out.
          const result = yield* control.createPool({
            parentID: ctx.sessionID,
            parentPath,
            agent_type: params.agent_type,
            count: params.count,
            common_message: params.message,
            per_worker_messages: params.per_worker_messages,
            pool_strategy: params.pool_strategy,
            on_failure: params.on_failure,
            task_prefix: params.task_prefix,
            options: { fork_turns: fork.value },
            per_member_isolation: memberIsolation,
          })

          // 8b. Worktrees behind members that FAILED to spawn are orphans —
          // remove them (failures carry the member task_name, which encodes
          // the ordinal).
          if (memberIsolation && result.failures.length > 0) {
            const orphaned = result.failures
              .map((failure) => {
                const ordinal = Number(failure.task_name.slice(prefix.length + 1))
                return Number.isInteger(ordinal) ? memberIsolation[ordinal]?.directory : undefined
              })
              .filter((directory): directory is string => !!directory)
            if (orphaned.length > 0) {
              yield* Effect.promise(async () => {
                const [{ AppRuntime }, { Worktree }] = await Promise.all([
                  import("@/effect/app-runtime"),
                  import("@/worktree"),
                ])
                await AppRuntime.runPromise(
                  Worktree.Service.use((svc) =>
                    Effect.forEach(orphaned, (directory) => svc.remove({ directory }).pipe(Effect.ignore), {
                      concurrency: 2,
                    }),
                  ),
                ).catch(() => {})
              })
            }
          }

          // 9. Total spawn failure — short-circuit so the model sees a
          //    clear signal instead of waiting on a vacant pool.
          if (result.members.length === 0) {
            return errorOutput(
              "spawn_all_failed",
              `Every member failed to spawn (${result.failures.length} failures). First: ${result.failures[0]?.reason ?? "unknown"}`,
            )
          }

          // 10. Build collect strategy.
          const strategy: AgentControl.CollectStrategy =
            params.collect === "all"
              ? { type: "all" }
              : params.collect === "first"
                ? { type: "first" }
                : { type: "any_n", n: params.collect_n! }

          // 11. Drive the collect loop.
          const collected = yield* control.collectPool(
            result.pool_id,
            ctx.sessionID,
            strategy,
            params.timeout_ms,
          )

          // 12. collect="first" wins → close the rest. Survivor is the
          //     worker that delivered (worker_session_id).
          if (params.collect === "first" && collected.deliverables.length > 0) {
            yield* control.closePoolMembers(
              result.pool_id,
              ctx.sessionID,
              collected.deliverables[0]!.worker_session_id,
            )
          }

          // 13. Render the model-facing result.
          const checkoutFor = (memberPath: string) => {
            if (!memberIsolation) return undefined
            const leaf = memberPath.split("/").at(-1) ?? ""
            const ordinal = Number(leaf.slice(prefix.length + 1))
            const iso = Number.isInteger(ordinal) ? memberIsolation[ordinal] : undefined
            if (!iso) return undefined
            return { directory: iso.directory, ...(iso.branch ? { branch: iso.branch } : {}) }
          }
          return {
            title: `spawn_pool ${result.pool_id}`,
            metadata: {
              pool_id: result.pool_id,
              member_paths: result.members.map((m) => String(m.metadata.agent_path)),
              failure_count: result.failures.length,
              collected_count: collected.deliverables.length,
              timed_out: collected.timed_out,
              ...(memberIsolation
                ? {
                    member_checkouts: Object.fromEntries(
                      result.members.flatMap((m) => {
                        const checkout = checkoutFor(String(m.metadata.agent_path))
                        return checkout ? [[String(m.metadata.agent_path), checkout]] : []
                      }),
                    ),
                  }
                : {}),
            },
            output: JSON.stringify({
              pool_id: result.pool_id,
              deliverables: collected.deliverables.map((d) => ({
                worker: String(d.worker_path),
                content: d.content,
              })),
              failures: result.failures,
              timed_out: collected.timed_out,
              ...(memberIsolation
                ? {
                    checkouts: result.members.flatMap((m) => {
                      const checkout = checkoutFor(String(m.metadata.agent_path))
                      return checkout ? [{ worker: String(m.metadata.agent_path), ...checkout }] : []
                    }),
                  }
                : {}),
            }),
          }
        }),
    }
  }),
)

export * as AgentPool from "./agent-pool"
