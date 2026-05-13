# Tool surfaces — semantics from codex, prompts of equal rigor

You are implementing eight model-facing tools. Two things to lock in before reading further:

1. **Semantics match codex 1:1.** Param names, types, defaults, output shapes — verbatim. Models trained on codex traces transfer their tool-use behavior to ours when the surface matches. **Do not rename params. Do not change defaults. Do not change return shapes.**

2. **Prompt prose is yours, but at codex's depth.** Codex's `spawn_agent_tool_description_v2` is ~60 lines of operational guidance — when to delegate, when not to, how to design subtasks, parallel patterns, post-delegation conduct. That is the floor. Your descriptions teach the model to use the tool the way an expert would. Write them in codemaxxxing voice (terse, direct, no buzzwords), but cover the same operational ground. Read `PROMPT_ENGINEERING.md` for the discipline.

The "tone" notes earlier mean: write the prose in your voice, not codex's. They do not mean "write less prose." A two-sentence description is junior-tier and inadequate. Models do not know how to use these tools well by inspecting param names alone.

## unified_exec

### `exec_command`

**Inputs**
- `cmd: string` (required) — shell command to run
- `workdir?: string` — working directory; defaults to the turn cwd
- `shell?: string` — shell binary override; defaults to user's preferred shell
- `tty?: boolean` (default `false`) — allocate a PTY; required for `write_stdin` to send non-empty input later
- `yield_time_ms?: number` (default `10_000`) — how long to wait for output before returning
- `max_output_tokens?: number` — cap returned output (excess truncated head/tail)
- `login?: boolean` — only present when the agent allows login shells

(Skip codex's `sandbox_permissions`, `additional_permissions`, `justification`, `prefix_rule`, `environment_id` — opencode has no sandboxing layer and no environments concept. The opencode permission system handles approval; see Wave 12.)

**Returns**
```
{
  output: string                       // command output (head/tail truncated when over cap)
  wall_time_seconds: number            // elapsed time spent waiting
  session_id?: number                  // present iff process is still running; pass to write_stdin
  exit_code?: number                   // present iff process finished during this call
  chunk_id?: string                    // present iff partial output (still running)
  original_token_count?: number        // approx tokens before truncation
}
```

**Description must teach the model:**
- This is a *persistent* process tool — different from `shell` which is one-shot
- Use cases this exists for: REPLs (python, ipython, node, bun repl, psql, redis-cli), file watchers, dev servers, ssh sessions, long-running observables
- When you should use `shell` instead: short single-shot commands that don't need state preservation
- Why `tty: true` matters: without it, you cannot send stdin later (the connection is one-way)
- The `session_id` round-trip: when present in the return, the process is alive and you can re-enter via `write_stdin`
- The `yield_time_ms` knob: how to think about it (responsive REPLs vs long-running services)
- That sub-second polls are clamped to 250ms minimum and 30s maximum (give the model the budget)
- Output truncation is head+tail (model sees both prologue and tail) — affects how to interpret long outputs
- That stale `session_id`s (from a prior session, restarted opencode) will fail — re-spawn

### `write_stdin`

**Inputs**
- `session_id: number` (required) — process id from a prior `exec_command`
- `chars?: string` (default `""`) — bytes to write; empty means pure poll
- `yield_time_ms?: number` (default `250`) — see clamp rules below
- `max_output_tokens?: number` — cap returned output

**Yield-time clamps** (replicate `process_manager.rs:643-652` exactly):
- if `chars` is empty: `clamp(yield_time_ms, MIN_EMPTY_YIELD_TIME_MS=5000, max_write_stdin_yield_time_ms=300_000)`
- if `chars` non-empty: `min(max(yield_time_ms, MIN_YIELD_TIME_MS=250), MAX_YIELD_TIME_MS=30_000)`

**Behavior**
- Non-empty `chars` requires the process was spawned with `tty: true`. If not, return error `stdin is closed for this session; rerun exec_command with tty=true to keep stdin open`.
- After writing, sleep `100ms` to give the process time to react before polling.
- On exit, returns `exit_code`, drops `session_id` from the return shape, and releases the slot.

**Returns** — same shape as `exec_command`.

**Description must teach the model:**
- Empty `chars` is a pure poll — use it when you spawned something and want to check on it later
- Pure polls have a 5-second floor — models that spam-poll waste budget and get throttled
- For interactive REPLs: send a line of input, poll, read the result, send next line
- For dev-server/watcher style: spawn once with `tty: true`, then mostly empty polls when you want to see new output
- Don't poll a process you don't actually need output from; close it (no close tool exists; processes die when opencode exits or when LRU prunes them)
- If `session_id` is unknown, re-spawn — process probably died or got pruned

## multi_agents_v2

### `spawn_agent`

**Inputs**
- `message: string` (required) — initial task for the new agent
- `task_name: string` (required) — lowercase letters/digits/underscores; becomes the agent's canonical path component
- `agent_type?: string` — role name (`default`, `explorer`, `worker`, or any user-defined agent)
- `fork_turns?: string` (default `"all"`) — `"none"`, `"all"`, or a positive integer string for last-N turns of parent history
- `model?: string` — model override; **leave unset by default** (children inherit parent's model)
- `reasoning_effort?: string` — reasoning override; same defaults-inherit policy

**Returns**
```
{
  task_name: string         // canonical path, e.g. "/root/task1/task_3"
  nickname?: string         // user-facing nickname when not hidden
}
```

**Behavior**
- Returns immediately. Spawned agent runs concurrently in its own fiber under `AgentControl`.
- If parent task is `/root/task1` and you spawn with `task_name: "task_3"`, the child path is `/root/task1/task_3`.
- The child can be referenced from siblings by relative or canonical name.
- Spawn depth limit applies — if exceeded, error.
- Concurrency cap applies if configured — if exceeded, error.

**Description must teach the model the operational discipline of delegation.** This is the longest description in the campaign. It should cover, in your voice and structure:

- The mental model: spawn returns immediately, agents run concurrently in parallel fibers, you keep working while they do
- The naming model: `task_name` is the leaf component; the canonical path is `<your_path>/<task_name>`; sibling agents reference each other by relative or canonical path
- Inheritance: model + reasoning effort + workspace tools all inherit from the spawning agent unless overridden
- When to delegate: bounded sidecar tasks; parallel research; concurrent code-edit work on disjoint write sets; observer/worker patterns; debate or design review with multiple perspectives
- When NOT to delegate: the immediate next blocking step (do it locally, don't wait); tightly-coupled work; tasks too vague to scope cleanly; the same question you already delegated
- How to scope a delegated task: concrete output, well-defined deliverables, disjoint write sets when delegating code edits
- Coordination patterns: parallel fan-out for research; pipeline (A spawns B, B spawns C); debate (two agents `followup_task` each other); observer (one agent watches outputs of N workers via `wait_agent`)
- Cost awareness: each spawned agent makes its own LLM calls; cost adds up; don't spawn for trivia
- After delegation: don't sit on `wait_agent` reflexively; do useful local work in parallel; check in via `list_agents` or short `wait_agent` calls
- The role system: `default` for general work; `explorer` for codebase research (read-only-ish, fast); `worker` for code changes (assign disjoint write ownership)
- Limits: depth limit (recursion guard), concurrency cap (per-session)

This description IS the operating manual the model uses to decide how to wield the multi-agent surface. Junior prompts here lead to either runaway spawning or zero spawning. Take it seriously.

### `send_message`

**Inputs**
- `target: string` (required) — relative or canonical task name
- `message: string` (required) — message body

**Returns** — empty success object.

**Behavior**
- Queues the message in the target's mailbox.
- **Does NOT trigger a turn.** Target reads on its next natural turn or via `wait_agent`.
- For triggering, use `followup_task`.

**Description must teach the model:**
- This is fire-and-forget; the message lands in the target's inbox and the target sees it on its next turn
- Use this for context updates, FYI, status notes — things the recipient doesn't need to act on immediately
- Use `followup_task` (not `send_message`) when you actually need the recipient to do something next
- The recipient drains their entire mailbox at the start of each turn; messages from multiple senders interleave in delivery order

### `followup_task`

**Inputs** — same as `send_message`.

**Returns** — empty success object.

**Behavior**
- Queues the message AND wakes the target (sets `trigger_turn: true` on the InterAgentCommunication).
- If the target is mid-turn, the message is queued and used to start the target's next turn after the current one completes.
- Cannot target the root agent (errors).

**Description must teach the model:**
- This is the "wake them up and assign more work" tool
- Use after a child completes initial work and you want to give it the next sub-task instead of spawning a fresh agent (preserves context, avoids re-exploration)
- For mid-turn targets: message is queued and used as the next turn's input; no interruption
- Cannot target root — root is the user-facing surface, not a worker
- Difference from `send_message`: same delivery, different semantics — `send_message` is FYI, `followup_task` says "here's your next assignment"

### `wait_agent`

**Inputs**
- `timeout_ms?: number` (default `30_000`, clamped to `[min_wait_timeout_ms, MAX_WAIT_TIMEOUT_MS]`)

**Returns**
```
{
  message: string       // brief summary, NOT the actual mail content
  timed_out: boolean
}
```

**Behavior**
- Blocks the calling agent's tool call (not the whole loop) on the parent's mailbox seq watch.
- Returns when ANY mailbox update arrives (queued message or final-status notification).
- If timeout elapses with no update, `timed_out: true`.
- Returns ONLY the summary, not the actual mail. The agent reads mail on its next turn (drained via runLoop's mailbox drain step).

**Description must teach the model:**
- This blocks until a mailbox update from any live sibling — NOT until a specific agent finishes
- The return tells you something happened; the actual mail body shows up in your next turn's context
- Use sparingly: `wait_agent` blocks productive work; do non-overlapping local work first
- Default 30s timeout is intentionally not infinite; loop with `list_agents` checks if you need finer-grained polling
- Returns `timed_out: true` if no mail arrived — that's a signal to do other work or check `list_agents`

### `list_agents`

**Inputs**
- `path_prefix?: string` — optional task-path prefix (no trailing slash). Same relative/canonical syntax as `target`.

**Returns**
```
{
  agents: [
    { agent_name: string, agent_status: AgentStatus, last_task_message?: string }
    ...
  ]
}
```

**AgentStatus** = string `"pending_init" | "running" | "interrupted" | "shutdown" | "not_found"` OR object `{ completed: string | null }` OR `{ errored: string }`.

**Description must teach the model:**
- Snapshot of every live agent in your session tree
- Use to find idle / completed / failed agents before deciding what to do next
- `last_task_message` shows the most recent instruction received — good for "did I already ask this?"
- Filter with `path_prefix` to scope to a sub-tree
- Agents in `completed` state can still be reused via `followup_task` (they keep their context)

### `close_agent`

**Inputs**
- `target: string` (required) — relative or canonical name

**Returns**
```
{ previous_status: AgentStatus }
```

**Behavior**
- Cannot close root.
- Closes the target AND any open descendants reachable from the in-memory tree.
- Idempotent if target already shut down.

**Description must teach the model:**
- Close agents you're done with — they hold context budget and prevent the concurrency cap from being reclaimed
- Closes descendants too — closing a parent closes its children
- Cannot close root (root is your session)
- Returns the status the target had before close — useful for "did I close something that was still working?"

## Built-in agent role descriptions

Codex ships three roles in `agent/role.rs:357-414`. These descriptions are exposed to the model via the `agent_type` parameter (the model picks a role by reading these). Words matter — write expert prompts.

### `default`
Codex: "Default agent."
Ours: write 1-2 lines describing when to pick `default` (general work, no specialist constraints).

### `explorer`
Codex prose covers: fast read-heavy subagent for codebase questions; multiple in parallel for distinct questions; reuse for related; trust results to avoid redundant work.

Your description must teach the model:
- When to spawn an explorer vs do the lookup yourself (rule of thumb: scope is uncertain, multiple files involved, or you need patterns understood)
- That explorers are fast and read-only-ish — don't ask them to make changes
- Parallel-by-default for multiple distinct questions
- Trust results — don't redundantly re-explore the same area
- Reuse existing explorers via `followup_task` for related questions in the same area

### `worker`
Codex prose covers: production code execution; assign disjoint write ownership; tell workers they aren't alone in the codebase.

Your description must teach the model:
- When to use workers (concrete code-change tasks with clear ownership)
- Assign disjoint write scope per worker — file-level or module-level ownership
- Tell workers explicitly they aren't alone — they need to accommodate sibling changes
- For large refactors, decompose into independent worker tasks before spawning

## Output schema discipline

For all tools, the JSON schema written into the model's tool definition must:
- match codex's field names exactly (verified in tests against the literal JSON)
- mark required fields as required
- use `additionalProperties: false`
- have descriptions on every field

Tests in each tool's wave verify the schema shape with snapshot or structural assertions.

## Cross-references

- Schemas / param defaults: `CONSTANTS.md`
- Description-writing discipline (use cases, anti-patterns, prose structure): `PROMPT_ENGINEERING.md`
- System prompt awareness (how the agents themselves learn about these tools): `PROMPT_ENGINEERING.md` § "Agent system prompts"
