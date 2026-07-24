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
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "../tool"
import { AgentToolContext } from "../agents/current-path"
import { truncateHeadTail } from "../process/constants"
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
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Paths (absolute, or relative to the project root) whose contents are injected into the child's first message as attached-file blocks. Combine with fork_turns: 'none' to hand a self-contained child exactly the context it needs — no full-history cost, no hand-pasting file contents into the message. Oversized files are head/tail-elided.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      'Optional model override for the new agent, as "provider/model" (e.g. "anthropic/claude-sonnet-4-5"). Leave unset to use the agent type\'s configured model, else the model you are currently running. Only set when the user explicitly asks for a different model or the task clearly requires one. Unknown models fail the call.',
  }),
  reasoning_effort: Schema.optional(Schema.String).annotate({
    description:
      "Optional reasoning-effort variant for the model override (e.g. \"low\", \"high\"). Requires `model` to be set and must be one of that model's variants — invalid values fail the call and list the valid ones. Leave unset to use the model's default effort.",
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
  isolation: Schema.optional(Schema.Union([Schema.Literal("none"), Schema.Literal("worktree")])).annotate({
    description:
      "Filesystem isolation for this child. `worktree` gives the child its own git checkout on its own branch (named from task_name): its writes land there instead of your cwd, a clean checkout removes itself when the child finishes, and one with commits is kept — the completion notification then reports branch, commits ahead, and dirt so you can merge, send back, or discard. Defaults to the agent type's configured isolation, else `none` (shared cwd). Only worth paying for children that WRITE; read-only fan-outs should stay in the shared directory.",
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
    const provider = yield* Provider.Service

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
              let resolvedAgent: Agent.Info | undefined
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
                resolvedAgent = match
              }

              // Bug 3 fix (specs/tui-redesign.md known bugs): `model` /
              // `reasoning_effort` were declared but never forwarded.
              // Resolve + validate here, then thread the ref through
              // SpawnAgentInput.model → sessions.create → the child's
              // first-turn model selection (prompt.ts
              // injectMailboxMessages fresh-child fallback). Invalid
              // input fails the call — silently spawning a child on the
              // wrong model produces confidently wrong work.
              let modelOverride: AgentControl.SpawnAgentInput["model"] = undefined
              if (params.model !== undefined) {
                const parsed = Provider.parseModel(params.model)
                if (!parsed.providerID || !parsed.modelID) {
                  return errorOutput(
                    params.task_name,
                    "model_invalid",
                    `model must be a "provider/model" string (e.g. "anthropic/claude-sonnet-4-5"), got "${params.model}".`,
                  )
                }
                // getModel raises a defect on unknown provider/model —
                // catchCause folds any failure into the sentinel.
                const resolved = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(
                  Effect.map((m) => ({ ok: true as const, model: m })),
                  Effect.catchCause(() => Effect.succeed({ ok: false as const, model: undefined })),
                )
                if (!resolved.ok || resolved.model === undefined) {
                  return errorOutput(
                    params.task_name,
                    "model_unknown",
                    `Unknown model "${params.model}". Use "provider/model" for a configured provider, or leave model unset to use the agent type's default.`,
                  )
                }
                if (params.reasoning_effort !== undefined) {
                  // Same validation idiom as createUserMessage
                  // (prompt.ts): a variant is only valid when it exists
                  // on the resolved model's variants map.
                  const variants = Object.keys(resolved.model.variants ?? {})
                  if (!variants.includes(params.reasoning_effort)) {
                    return errorOutput(
                      params.task_name,
                      "reasoning_effort_invalid",
                      variants.length > 0
                        ? `reasoning_effort "${params.reasoning_effort}" is not a variant of ${params.model}. Valid values: ${variants.join(", ")}.`
                        : `model ${params.model} has no reasoning-effort variants; leave reasoning_effort unset.`,
                    )
                  }
                }
                modelOverride = {
                  providerID: parsed.providerID,
                  modelID: parsed.modelID,
                  variant: params.reasoning_effort,
                }
              } else if (params.reasoning_effort !== undefined) {
                return errorOutput(
                  params.task_name,
                  "reasoning_effort_invalid",
                  `reasoning_effort requires model to be set ("provider/model") so the value can be validated against that model's variants.`,
                )
              }

              const parentPath = yield* AgentToolContext.currentAgentPath(control, ctx.sessionID)

              // B4-4 (2026-07-18) — file attachments. Read at spawn time,
              // appended to the initial message as fenced blocks. Fail
              // fast on unreadable paths: silently spawning a child
              // WITHOUT the context it was promised produces confidently
              // wrong work, which is worse than no spawn.
              let initialMessage = params.message
              if (params.files !== undefined && params.files.length > 0) {
                const instanceCtx = yield* InstanceState.context
                const sections: string[] = []
                const failures: string[] = []
                for (const f of params.files) {
                  const abs = path.isAbsolute(f) ? f : path.resolve(instanceCtx.directory, f)
                  const text = yield* Effect.promise(() => Bun.file(abs).text()).pipe(
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                  if (text === undefined) {
                    failures.push(f)
                    continue
                  }
                  const capped = truncateHeadTail(text, 8_000)
                  sections.push(`[attached file: ${f}]\n\`\`\`\n${capped.text}\n\`\`\``)
                }
                if (failures.length > 0) {
                  return errorOutput(
                    params.task_name,
                    "files_unreadable",
                    `Could not read attached file(s): ${failures.join(", ")}. Fix the paths or drop them from files.`,
                  )
                }
                initialMessage = `${params.message}\n\n${sections.join("\n\n")}`
              }

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

              // Spawn isolation (idea-worktrees, 2026-07-22) — explicit param
              // wins, else the agent type's configured default, else none.
              // The worktree is created HERE (after the permission ask, so a
              // rejected spawn never mints a checkout) and the pre-built
              // isolation object rides SpawnAgentInput — AgentControl stays
              // free of worktree mechanics. createFromInfo awaits the full
              // readiness contract: populate, .worktreeinclude copy,
              // instance boot, start scripts.
              const isolationMode = params.isolation ?? resolvedAgent?.isolation ?? "none"
              let isolation: AgentControl.SpawnAgentInput["isolation"] = undefined
              if (isolationMode === "worktree") {
                const built = yield* Effect.promise(async () => {
                  const [{ AppRuntime }, { Worktree }, { InstanceStore }] = await Promise.all([
                    import("@/effect/app-runtime"),
                    import("@/worktree"),
                    import("@/project/instance-store"),
                  ])
                  return AppRuntime.runPromise(
                    Effect.gen(function* () {
                      const svc = yield* Worktree.Service
                      const store = yield* InstanceStore.Service
                      const info = yield* svc.makeWorktreeInfo({ name: params.task_name })
                      yield* svc.createFromInfo(info)
                      const context = yield* store.load({ directory: info.directory })
                      return { directory: info.directory, branch: info.branch, context }
                    }),
                  ).then(
                    (value) => ({ ok: true as const, value }),
                    (error) => ({
                      ok: false as const,
                      reason: error instanceof Error ? error.message : String(error),
                    }),
                  )
                })
                if (!built.ok) {
                  return errorOutput(
                    params.task_name,
                    "isolation_failed",
                    `Could not create an isolated checkout: ${built.reason}`,
                  )
                }
                isolation = built.value
              }

              const spawned = yield* control
                .spawnAgent({
                  parentID: ctx.sessionID,
                  parentPath,
                  task_name: params.task_name,
                  agent_type: params.agent_type,
                  initial_message: initialMessage,
                  model: modelOverride,
                  options: { fork_turns: fork.value },
                  on_failure: params.on_failure,
                  pool_strategy: params.pool_strategy,
                  isolation,
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
                // Never leave an orphan checkout behind a failed spawn.
                if (isolation) {
                  const directory = isolation.directory
                  yield* Effect.promise(async () => {
                    const [{ AppRuntime }, { Worktree }] = await Promise.all([
                      import("@/effect/app-runtime"),
                      import("@/worktree"),
                    ])
                    await AppRuntime.runPromise(
                      Worktree.Service.use((svc) => svc.remove({ directory })),
                    ).catch(() => {})
                  })
                }
                return errorOutput(params.task_name, spawned.tag, spawned.reason)
              }

              const canonical = String(spawned.live.metadata.agent_path ?? "")
              const nickname = spawned.live.metadata.agent_nickname
              const output = {
                task_name: canonical,
                nickname,
                ...(isolation
                  ? { checkout: { directory: isolation.directory, ...(isolation.branch ? { branch: isolation.branch } : {}) } }
                  : {}),
              }
              return {
                title: `spawn_agent ${canonical}`,
                metadata: {
                  task_name: canonical,
                  nickname,
                  child_session_id: spawned.live.thread_id,
                  ...(isolation
                    ? {
                        isolation: {
                          directory: isolation.directory,
                          ...(isolation.branch ? { branch: isolation.branch } : {}),
                        },
                      }
                    : {}),
                },
                output: JSON.stringify(output),
              }
            }),
    }
  }),
)

export * as AgentSpawn from "./agent-spawn"
