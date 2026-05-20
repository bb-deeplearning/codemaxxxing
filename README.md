# codemaxxxing

![codemaxxxing](./hero.png)

the question driving everything here is simple: how large a task can I hand off and leave running in the background while I do something else? every iteration — the prompts, the wave runner FSM, the OTP-style multi-agent actor system (supervision, links, bounded mailboxes, behavior contracts), the persistent processes, the observability metrics, the integration invariants — is in service of pushing the answer further. the actor-discipline work that just landed was itself a 6-hour unsupervised wave campaign: 10 waves, 35 generator+evaluator pairs, the harness orchestrating itself end-to-end while I worked on something else. that's where the current answer sits. it isn't a product or a configurable platform; it's an instrument, and every hour spent on it expands the radius of work I can hand off.

this repo plays two roles in chasing that. it's the daily tool I use to build things at [clauseo](https://clauseo.chat) and other [bbdeeplearning.systems](https://bbdeeplearning.systems) projects, and it's the surface where I experiment with how to build longer-running agents at all. the multi-agent actor system, persistent process tools, integration-invariants discipline, durable wave campaigns — these are experimental shapes that prove out here first, then get adapted into clauseo's production agents. nothing in this README is load-bearing dogma; it's the current iteration, and some of it will get re-litigated when the next model ships or a campaign surfaces something I got wrong. shares a file tree with [opencode](https://github.com/anomalyco/opencode) and very little else — the architecture has diverged on every surface I cared about.

what I wanted that the upstream defaults didn't give:

- a way to drive multi-hour, multi-session tasks without sitting on the keyboard. a finite state machine on disk with auto-retry, conversational user pauses, and a full git audit trail. → [**wave runner**](#wave-runner).
- subagents that behave like real actors instead of fire-and-forget RPC calls — concurrent, addressable, supervisable, with mailboxes, links, bounded queues, and per-agent_type behavior contracts. erlang/otp/akka conceptual lineage adapted for LLM constraints. → [**multi-agent actor system**](#multi-agent-architecture).
- shell tools that hold state between calls so REPLs keep their imports, dev servers stay running while I observe their logs, file watchers report new diagnostics as edits land. → [**persistent processes**](#persistent-processes).
- a TUI that's readable on the setup I actually live in (mosh + tmux + iPad over hotel wifi on a long flight). lighter chrome, more density, a wave campaign dashboard so the FSM is observable. → [**drafting-table TUI**](#tui).
- system prompts that don't over-engineer, don't moralise, distinguish questions from action requests, and parallelize aggressively. constantly reworked — nine iterations and counting, because the right prompt for Opus 4.6 isn't the right prompt for Opus 4.7. → [**rewritten prompts**](#prompts).

the rest of the README walks through each one and how to install. there's a separate [WAVES.md](./WAVES.md) for the full wave-runner algorithm, [GOTCHAS.md](./GOTCHAS.md) for the sharp edges accumulated along the way, and per-campaign engineering references in [specs/](./specs/).

## wave runner

long agent sessions degrade. the context window is a sliding window. early details rot, compaction makes knowledge shallow, late-stage errors compound. the wave runner splits large tasks across many small fresh sessions, persists progress on disk as a finite state machine, and recovers from failures by patching the plan or asking me. no babysitting between waves.

three agents:

- `wave_plan` decomposes a plan markdown file into a campaign directory under `.wave/campaigns/<id>/`.
- `wave_verify` sanity-checks the campaign before any wave runs (probes reality with cheap shell commands to catch planner blind spots), and re-amends it whenever a wave fails because the spec was wrong.
- an executor agent (caveman, build, my choice) runs each wave. reads its `WAVE.md`, dispatches sub-agents, runs verification, commits, updates state.

a loop in `packages/opencode/src/wave/loop.ts` orchestrates everything. after I arm it once, every wave completion auto-spawns the next, transient failures auto-retry up to 3 times, and `PLAN UNDOABLE` outcomes auto-escalate to the verifier. when an agent needs user input it pauses conversationally. the session stays alive, I reply in chat, the same agent resumes mid-thread. every outcome (success, failure, undoable, paused, crash) produces a git commit, so the working tree is always clean between sessions and I have a full audit trail in `git log`.

**workflow**:

1. **plan.** write a plan in plain markdown anywhere, or use `/mode plan` (iterative) or `/agent plan_structured` (4-phase pipeline) to produce one in `.opencode/plans/`.

2. **decompose.** new session, switch to wave_plan via the `/wave-plan` slash command. the slash pre-fills a prompt asking for the plan path and executor agent. model is optional, leave unspecified to use codemaxxxing's default.

   ```
   /wave-plan
   Decompose @.opencode/plans/my-plan.md. Executor agent: caveman.
   ```

   this produces `.wave/campaigns/<id>/`. no source code is modified.

3. **arm and walk away.** open `/wave` in the TUI. press `r`. the verifier runs first (sanity-checks the campaign). then the executor spawns wave 0, runs it, commits, advances state. the loop sees the settle, spawns wave 1. repeats until `all_complete`.

4. **respond to questions.** when the dashboard shows a USER ATTENTION banner, press `↵` on the wave row to open the session in chat. read the agent's full contextual question, reply normally. the agent picks up the reply and continues.

### orchestrated waves

per-wave executors aren't limited to single-session runs. for non-trivial waves the executor itself spawns subagents: a **planner** that breaks the wave into PLAN.json tasks (one file or one tight bundle per task), then per-task **generator + evaluator** pairs that build and grade independently. the executor's role is supervisor — it watches for set-phrases and reads CONTRACT.json but never grades criteria directly. the evaluator is asymmetric and adversarial, judging only the OUTPUT (never the generator's reasoning trace), using tools (greps, type-checks, `bun test`, verify recipes) to verify behavior rather than inspect code.

this is the discipline that lets a wave with 5-15 file changes ship in one orchestrated session without a human review pass: the per-task evaluator catches the bugs the generator missed, the orchestrator drafts CONTRACT.json upfront from the wave spec (pre-agreed contract pattern), and disjoint-write tasks run in parallel via the multi-agent surface. the actor-discipline campaign (iteration 9) validated this shape across 10 waves: 35 generator+evaluator pairs, 340 contract criteria, zero pivots in Phase 3, T2+T3+T4 3-way parallelized in Wave 8. each wave's full orchestration trace lives in `.wave/campaigns/<id>/waves/wave_N/NOTES.md`.

self-evaluation is a trap (a builder tuned to be self-critical doesn't critique). orchestrated waves always spawn a separate evaluator subagent; the generator never grades its own work. the same agent never holds both roles.

read more: [WAVES.md](./WAVES.md) for the full algorithm, FSM states, set phrases, recovery paths, and architectural choices.

## multi-agent architecture

upstream's `task` is fire-and-forget. parent calls task, child runs to completion, parent gets back a single text string. no channel back during execution. no concurrent siblings. no observable status. no supervision. fine for "go grep the codebase". falls apart for everything else I kept wanting to do: parallel fan-out with N explorers, observer + worker patterns, debate between two framings, long-running siblings the parent checks in on later, fault tolerance when one of those siblings crashes mid-flight.

I replaced it with a real actor system. ten tools, all backed by an `AgentControl` service with per-root agent registry, per-session bounded mailboxes, supervision strategies, link cascades, and per-`agent_type` behavior contracts. erlang/otp/akka conceptual lineage adapted for LLM constraints — `on_failure: respawn` mirrors OTP supervisor `restart: permanent`, `pool_strategy: one_for_all` is OTP one_for_all, `link_agents`/`unlink_agents` are erlang `link/1`/`unlink/1`. deliberately NOT imported: lifecycle hooks (preStart/postStop don't help LLM subagents), deep escalation chains (LLM cost makes them expensive), or persistence (state lives in messages, not in subagent memory across crashes).

### the ten tools, grouped

**lifecycle**

| Tool | What it does |
|---|---|
| `spawn_agent` | fire-and-keep-running. returns immediately with the child's canonical path. parent keeps working. accepts `on_failure: respawn / escalate / ignore / kill_pool` and `pool_strategy: one_for_one / one_for_all / rest_for_one`. |
| `close_agent` | release a slot. cascades through descendants. `target` is optional (self-close); returns `already_terminated` (success — child exited before close arrived) vs `path_invalid` (model bug — wrong path). |

**messaging**

| Tool | What it does |
|---|---|
| `send_message` | FYI queue. message lands in recipient's mailbox; recipient sees it on their next turn. optional `correlation_id` pairs request to reply. returns `mailbox_full` with `retry_after_ms` hint on overflow. |
| `followup_task` | queue AND wake. recipient picks up the work immediately. same `correlation_id` + `mailbox_full` shape as `send_message`. |

**waits**

| Tool | What it does |
|---|---|
| `wait_agent` | block on any mailbox update. emits `missing_timeout` warning when `timeout_ms` is omitted, `timeout_clamped` when above the 600000ms cap. |
| `wait_for_reply` | targeted variant. blocks until a mailbox message carrying the matching `correlation_id` arrives. wakes only on the matching reply; ignores unrelated mailbox traffic. |

**fan-out**

| Tool | What it does |
|---|---|
| `spawn_pool` | declarative N-worker fan-out under a shared pool_id. three collect strategies: `all` (wait for every member), `first` (race; runtime closes losers), `any_n` (quorum — return when K members deliver, leave the rest alive). non-atomic spawning — failures land in a `failures[]` array. |

**linking**

| Tool | What it does |
|---|---|
| `link_agents` | forge a bidirectional symmetric paired-death edge between two peers. when either terminates non-gracefully (crash, runtime error, close from above), the runtime cascades the death to every linked partner with the `linked_death` label. |
| `unlink_agents` | drop the edge. symmetric + idempotent. |

**introspection**

| Tool | What it does |
|---|---|
| `list_agents` | snapshot of every live agent in your session tree. status, last instruction. cheap. |

### runtime model

the spawn tree is depth-limited (4 levels under `/root`). each agent runs in its own fiber, makes its own LLM calls, can spawn its own descendants. siblings push results to each other via `send_message` or `followup_task`; results land in the recipient's mailbox and get drained automatically at the start of the recipient's next turn (shown as `[from <author>] ...` prefixed entries).

a sibling watcher fiber forks at every spawn. when the child reaches a final, non-shutdown status, the watcher posts a completion notification to the parent's mailbox. parent's `wait_agent` wakes within milliseconds.

### supervision

`spawn_agent` accepts `on_failure` to declare what happens when a child terminates non-gracefully: `escalate` (default; the runtime forwards the completion notification with terminal status), `respawn` (re-spawn at the same task_name with a fresh session id, capped at 3 attempts then escalates with `transient_tool_error`), `ignore` (swallow the failure silently — no completion notification; use for fire-and-forget probes), `kill_pool` (cascade to the pool — applies to pool members only).

`pool_strategy` controls how a failure in one pool member affects siblings (OTP-style): `one_for_one` (default; failures are isolated), `one_for_all` (any single failure tears down the entire pool), `rest_for_one` (any failure tears down members spawned after the failing one).

### bounded mailboxes

every agent's mailbox is bounded (default 32 user messages). sends to a full mailbox return `{ error: "mailbox_full", retry_after_ms: 250 }` instead of queueing. callers retry with backoff or use `followup_task` to wake the recipient so it drains. completion notifications from terminating subagents bypass the cap — your subagent crashing always notifies you regardless of mailbox state.

backpressure surfaces context rot before it cascades. the alternative — unbounded mailboxes — lets a stuck subagent's inbox accumulate hundreds of messages while the supervisor thinks everything is fine; the bound makes that situation visible as a tool error the model can react to.

### behavior contracts

each `agent_type` declares a `BehaviorContract` (e.g. `general` requires `send_message_to_spawner` before terminating; `explore` requires read-only completion). at terminal-status time the runtime computes `BehaviorViolation`s against the declared contract and attaches them to the parent's notification as a `behavior_violation` struct. observer-only — spawn returns successfully regardless; the orchestrator decides whether to pivot, retry, or abort.

custom agents declared in `.opencode/agent/` inherit no contract by default. per-spawn override via `spawn_agent(..., behavior_version: "subagent_v2")`.

### per-root scoping

per-root scoping is the structural invariant. two chat sessions opened against the same project don't see each other's subagents. each registered root gets its own slot (registry, mailboxes, statuses, fibers, supervision policies, links, behaviors). a `sessionToRoot` index resolves any session id to its root in O(1). every service method routes through the slot resolver before doing anything.

### the delivery contract

subagents MUST deliver their result via `send_message` or `followup_task` to their spawner before calling `close_agent`. text-extraction from the subagent's final assistant message is a fallback, not the primary path. when the safety net fires (subagent terminated silently with no substantive body), the parent's notification is prepended with a ⚠️ warning so the gap is visible loudly instead of silently shipping a one-line cleanup as the deliverable.

subagents can also emit `ABORT(<reason>): <details>` as their last assistant line. the runtime parses the set-phrase line-anchored to the LAST non-empty line, populates a structured `abort_reason: { reason, details }` field on the parent's notification, continues with the human-readable text. six reasons in the enum: `spec_wrong`, `transient_tool_error`, `out_of_scope`, `context_full`, `approach_failed`, `user_question`. orchestrators pivot on `approach_failed`; the rest are observer signals.

### observability

four bus events under the `agent.metric.*` prefix surface the rates worth watching:

- **`deliverable_arrival_rate`** — fraction of subagent completions whose deliverable reached the spawner via explicit send or auto-extraction (NOT via the safety net). target: ~1.0; close to 0 means subagents are silently failing.
- **`safety_net_firing_rate`** — count of safety-net warnings per completion. inverse twin. >0.1 over rolling window of 20+ is the canary that prompts aren't teaching the delivery contract.
- **`sibling_deadlock_rate`** — count of `wait_agent`/`wait_for_reply` calls that exited via timeout. surfaces blocked-on-message-that-never-arrives shapes live.
- **`subagent_tool_error_rate`** — count of multi-agent tool calls that returned a tool-recoverable error. context-rot canary.

four pure rate helpers (`deliverableArrivalRate`, `safetyNetFiringRate`, `siblingDeadlockRate`, `subagentToolErrorRate`) compose with `Array.prototype.filter` / `slice` to scope by time window or session. consumers subscribe via `Bus.Service.subscribeCallback`; failure to attach is silent and safe.

### integration invariants

scenario-level coverage lives at `packages/opencode/test/integration/multi-agent-invariants.test.ts`. 45 invariants — 17 pre-existing (multi-root scoping, child-completion-wakes-parent, cross-root-send-rejection, session-deletion-cleanup, parent-close-cascades) plus 28 D-series (delivery contract, sibling coordination, ask pattern, ABORT protocol, supervision, pools, links, bounded mailboxes, behavior contracts, observability). each `it.instance` walks the scenario the invariant describes and asserts what a user would observe. every wave touching multi-agent code must add at least one invariant before its production code lands.

coverage alone is necessary but not sufficient. the harness is what catches the composed-primitives bugs (multi-chat collision, wait_agent never waking, agent_type not validated, silent delivery failure when child emits text + close_agent in the same turn, sibling deadlock when both peers wait on broadcasts that don't exist) that 100% line coverage missed.

### engineering references

- [specs/actor-discipline.md](./specs/actor-discipline.md) — full surface as of iteration 9. supervision, pools, links, bounded mailboxes, behavior contracts, observability, integration invariants discipline.
- [specs/codex-parity.md](./specs/codex-parity.md) — original 6-tool port that preceded actor-discipline.
- [specs/codex-parity-hardening.md](./specs/codex-parity-hardening.md) — per-root scoping + completion watcher fixes after the initial port.

## persistent processes

upstream's `bash` is one-shot. every call spawns a fresh process and exits when the command does. fine for `ls`, `git status`, `mkdir`. useless for REPLs, dev servers, file watchers, anything that holds state.

I replaced it with two tools backed by a 64-process PTY pool.

| Tool | What it does |
|---|---|
| `exec_command` | spawn a process. returns the initial output plus a `session_id`. process stays alive past the call. |
| `write_stdin` | re-enter a session. send input (with `chars`), poll for output (with empty `chars`), or both. |

state stays between calls. boot a Python REPL once, load imports once, run 50 expressions against the same in-memory state. spin up `next dev`, edit a file, poll for new log lines as the server reacts. tail `kubectl logs -f` in one slot while the main thread does other work.

operational guarantees: 64-process LRU pool, head/tail-buffered output (50/50 split inside 1 MiB so the model always sees both prologue and recent activity), yield-time clamps tuned to keep REPLs responsive and prevent spam-polling (5s floor on empty polls, 250ms floor on input-sending writes, 30s ceiling everywhere). `tty: true` is required if you intend to send stdin later; without it the connection is one-way.

the model-spawned PTYs persist past process exit so the model can drain final output via a follow-up empty poll. desktop-spawned PTYs (from the TUI terminal pane) keep their old auto-remove-on-exit behavior. distinguished by an `origin: "tui" | "model"` field on `Pty.Info`.

engineering reference: [specs/codex-parity.md](./specs/codex-parity.md).

## tool surface

the model's tool list no longer shows `bash` or `task`. they're covered by `exec_command` plus `write_stdin` for shell work and the [ten multi-agent tools](#multi-agent-architecture) for agent orchestration. cleaner: no decision overload, no near-duplicate tools competing for the same intent.

saved permissions keep working without edits. permission key collapse:

- `SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]` all consult permission key `bash`. saved `permission.bash: { "git *": "allow" }` rules transparently gate the new tools.
- `MULTI_AGENT_TOOLS = ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "wait_for_reply", "list_agents", "close_agent", "spawn_pool", "link_agents", "unlink_agents"]` all consult permission key `task`. saved `permission.task: { "explore": "allow" }` gates every member.

mirror of the existing `EDIT_TOOLS` precedent (where `edit`, `write`, `apply_patch` all consult permission key `edit`).

`tools: { bash: false }` and `tools: { task: false }` now hide every member of their respective group from the model's tool list. pre-campaign they hid only the literally-named tool.

plugin migration: `tool.definition` hooks keyed on `bash` or `task` continue to fire via a bridge in `tool/registry.ts:407-421`. mutations land on `exec_command` or `spawn_agent`'s description automatically. `tool.execute` hooks must migrate to the new IDs explicitly. execution semantics differ between the pairs (one-shot vs persistent for shell; single-shot vs concurrent-interactive for agents) and bridging would break plugin expectations.

`shell.ts` and `task.ts` are not deleted. both remain importable and callable from internal code. they're just no longer advertised to the model.

engineering reference: [specs/replace-bash-task.md](./specs/replace-bash-task.md).

## tui

![codemaxxxing](./screenshot.gif)

lighter, more information-dense chrome. shaped for the setup I actually live in: mosh + tmux over hotel wifi on an iPad, sometimes splitscreen with notes or a browser, sometimes a 60-column window because the keyboard takes half the screen. every wasted line is a line of session history I can't see. personal preference, not a feature — but the constraints drove the shape.

most of it is subtraction. panels lose their backgrounds and become single-cell left rules. message blocks lose their closing rules. tool calls collapse to `label · target · meta` instead of labeled separator lines. speaker identity moves to a `u·1` / `a·1` mark in the left margin. sidebar gains a small live stats block (messages, tokens, cost, duration). prompt has a state-aware `▎` accent and a two-row status (identity + ephemeral hints) with a small usage meter.

logo is a `slant`-figlet wordmark with a subtle ignition to idle animation. prompt spinner is a turbo spool (two braille turbines plus a boost gauge) instead of the upstream V12. sidebar footer reads `codema(xxx)ing for clauseo`. home footer `by clauseo`. OSC terminal title `codemaxxxing` (home) or `cmx | <session>` (sessions).

the recording above shows codemaxxxing in toybox-noir theme with the caveman agent active, mid-response. the spinner is the turbo spool.

also:

- collapsible web search and code search result displays
- semantic rendering of multi-agent v2 tool calls (spawn / send / wait / list show as proper components, not just JSON blobs)
- cross-agent mailbox messages render distinct from regular user input, prefixed with `[from <author_path>]`
- per-session subagent status strip in the footer when concurrent siblings are live (4 fields: total, running, completed, errored)
- subagent navigation works at any depth, not just direct children of root
- **flush queued messages on demand.** hit Enter while a turn is running, the message lands in the session log with a ` queued ` badge as today. press `<leader> ⏎` (default `ctrl+x` then `return`) to interrupt the current model stream and process the whole queue immediately. partial assistant text and in-flight tool calls are preserved on the abort so the model sees what it was in the middle of doing, then the queued messages, then responds. footer hint reads `esc interrupt · <leader> ⏎ flush N queued` when applicable. configurable via `keybinds.session_flush_queued`. see [flush-queued change notes](./CHANGES/2026-05-18-flush-queued.md).
- `/wave` slash command for the wave campaign dashboard
- `/wave-plan`, `/wave-run`, `/wave-pause`, `/wave-stop`, `/wave-next` slash commands for campaign control
- wave footer pill on home shows active campaign + status when one exists

## prompts

I keep iteration logs in [`PROMPT_ITERATIONS/`](./PROMPT_ITERATIONS/) and corresponding change lists in [`CHANGES/`](./CHANGES/). the reason isn't process discipline. it's that I forget what I tried. when something starts misbehaving again, the logs are how I find what I already learned. each iteration follows the same structure:

1. **discovery**. what behavior is going wrong, with concrete examples.
2. **research**. how I've thought about it, what patterns I've seen elsewhere.
3. **solution**. exact files changed and why.
4. **observe**. what to watch for to know if it worked.

prompts are alive here. the right framing for Opus 4.6 isn't the right framing for Opus 4.7 — 4.7 stopped inferring implicit contracts and I had to rewrite the multi-agent prose to state the delivery contract literally (iteration 9). every model release prompts a re-evaluation; sections get added, deleted, reframed. nine iterations in, the prompts barely resemble the upstream defaults.

a full index of files differing from upstream is in [`CHANGES/INDEX.md`](./CHANGES/INDEX.md).

| Iteration                                                      | Date       | Focus                                                                                            |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| [1](./PROMPT_ITERATIONS/2026-02-15-initial-fork.md)            | 2026-02-15 | Initial fork: anti-over-engineering, explore lockdown, context isolation, plan mode              |
| [2](./PROMPT_ITERATIONS/2026-02-22-explore-delegation.md)      | 2026-02-22 | Explore agent delegation: split broad tasks into parallel focused agents, stop code dumps        |
| [3](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) | 2026-02-22 | Prompt parity: Gemini system prompt rewrite, native general subagent prompts                     |
| [4](./PROMPT_ITERATIONS/2026-02-23-anthropic-inquiry-mode.md)  | 2026-02-23 | Anthropic inquiry mode: distinguish questions from directives                                    |
| [5](./PROMPT_ITERATIONS/2026-02-24-qwen-prompt-sync.md)        | 2026-02-24 | Default prompt sync: full codemaxxxing prompt for GLM and non-Claude models                      |
| [6](./PROMPT_ITERATIONS/2026-04-11-caveman-agent.md)           | 2026-04-11 | Caveman agent: ultra-terse primary agent, terse subagent output rules                            |
| [7](./PROMPT_ITERATIONS/2026-05-06-wave-system.md)             | 2026-05-06 | Wave system overhaul: verifier agent, retry/escalation FSM, conversational user pause            |
| [8](./PROMPT_ITERATIONS/2026-05-13-multi-agent-and-tool-overhaul.md) | 2026-05-13 | Multi-agent architecture + tool surface overhaul: replaced `task` and `bash` from the model's view |
| [9](./PROMPT_ITERATIONS/2026-05-20-actor-discipline.md) | 2026-05-20 | Actor discipline: delivery contract prose, ask pattern + ABORT protocol, supervision + pools + links + bounded mailboxes + behavior contracts, observability metrics |

### system prompts

the Anthropic, Gemini, and default (GLM/Qwen/other) system prompts have all been rewritten with my flavour:

- **anti-over-engineering**. don't add features, abstractions, error handling, or comments beyond what was asked.
- **inquiry vs directive awareness**. distinguish questions and discussions from action requests. don't start implementing when the user is exploring ideas.
- **security awareness**. actively watch for OWASP top 10 vulnerabilities in generated code.
- **no time estimates**. never predict how long tasks will take.
- **blast radius awareness**. freely take reversible actions, flag destructive ones before proceeding.
- **parallelism**. the prompts encourage parallel tool calls and parallel subagent launches wherever independent work exists. this keeps sessions shorter, context cleaner, and is what makes patterns like the wave runner practical.

the Gemini prompt is adapted for Gemini's response patterns: prescriptive framing over prohibitions, context efficiency guidance, Directives/Inquiries distinction, Research-Strategy-Execution lifecycle. see [iteration 3](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) and the [research learnings](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/LEARNINGS.md) for the rationale.

### capability hint fragments

`SystemPrompt.capabilityHints(agent)` at `packages/opencode/src/session/system.ts:101` injects up to three fragments into the system prompt at session bootstrap, based on the agent's effective permission set:

| Fragment | When injected |
|---|---|
| `persistent-processes.txt` | agent has `exec_command` permission != deny |
| `multi-agent-root.txt` | `agent.mode !== "subagent"` AND `spawn_agent` permission != deny |
| `multi-agent-subagent.txt` | `agent.mode === "subagent"` AND (`send_message` OR `wait_agent`) permission != deny |

agents with a tool denied don't see hints about that tool. compaction, title, and summary agents (which deny everything wildcard-wise) get an empty hint list. their existing system prompts are unchanged.

### general subagent

in upstream OpenCode, the general subagent inherits its system prompt from the parent verbatim. I ship native general subagent prompts (one for Anthropic models, one for Gemini) purpose-built for task execution with anti-over-engineering rules and structured reporting back to the parent. model selection happens automatically via `Agent.resolvePrompt()` in `agent.ts`. custom agents defined via `.opencode/agent/` config still take precedence.

### explore agent

the explore agent prompt has been overhauled for speed and strictness:

- hard read-only enforcement with an explicit deny list for destructive commands
- parallel tool call patterns for faster search
- structured thoroughness levels (quick / medium / very thorough)
- machine-readable response format (absolute paths, code snippets, explicit negatives)
- concise findings. key function signatures and critical logic, not entire file dumps.

the main agent's delegation to explore has been tuned to prevent context bloat (iteration 2):

- broad questions are split into multiple parallel explore agents, each targeting one area or concern
- the main agent uses Read directly when it already knows file paths, instead of wasting an explore agent on file reading
- explore agents are always given a thoroughness level and starting-point directories

my setup uses Claude Opus 4.7 as the primary model with the explore agent specifically running on Gemini 3.1 Pro Preview. to use this, add the following to your `opencode.json`:

```json
{
  "agent": {
    "explore": {
      "model": "google/gemini-3.1-pro-preview"
    }
  }
}
```

the explore prompt is structured to account for that pairing. consequences on different model setups are not tested.

### plan mode

both plan modes (the built-in `/mode plan` and the `plan_structured` custom agent) produce self-contained markdown plans in `.opencode/plans/`. these plans are designed to be picked up by fresh agents with zero context from the planning session.

the built-in plan mode (`/mode plan`) is iterative. it pair-plans with you: explores the codebase, updates the plan incrementally, asks you questions when it hits ambiguities only you can resolve. it loops (explore, update, ask) until the plan is complete. good for open-ended tasks where the scope needs discussion.

the `plan_structured` custom agent is a linear pipeline. you provide the task definition upfront, and it runs a 4-phase workflow: survey the codebase with parallel explore subagents, organize findings and identify gaps, write the full plan, then verify file paths and snippets are accurate. it works with you directly and asks questions on genuine ambiguities, but its value-add is the thorough autonomous survey and structured documentation, not problem discovery. good for well-defined tasks where you know what you want and need the codebase mapped out.

both are read-only. they never modify source code. both produce plans with the same required sections: context, codebase analysis, approach, changes, dead ends, verification, and dependencies. either plan can be fed into the wave runner.

use `/mode plan` when you're still figuring out what you want. you have a rough idea but need to talk through the approach, explore tradeoffs, and refine scope as you go. use `plan_structured` when you already know what needs to happen and just need the agent to survey the codebase and document the execution path.

### subagent permissions

the explore agent's bash access is locked down with explicit deny rules for destructive commands (`rm`, `git push`, `npm install`, etc.) while allowing read-only commands (`ls`, `find`, `git log`, etc.). per-built-in defaults for the new multi-agent and persistent-process tools live at `packages/opencode/src/agent/agent.ts:107-301`. `build` and `general` allow everything; `explore` allows messaging but not spawning or closing; `plan` denies all new tools; `compaction`, `title`, and `summary` deny everything wildcard-wise.

### caveman agent

a custom primary agent that produces ultra-terse output. about 75% fewer output tokens while keeping full technical accuracy. based on [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman). switch to it via the agent selector.

the system prompt is a 1:1 copy of `anthropic.txt` with caveman communication rules prepended. rules are sourced from the caveman skill's core SKILL.md (ultra mode: abbreviations, arrows, fragments) and the compress skill's SKILL.md (granular remove/preserve/structure spec). the TodoWrite examples are rewritten in caveman style for consistency.

the `build` agent remains the default for normal conversational use. I use `caveman` when I want maximum speed and token efficiency and don't need verbose explanations.

both the general and explore subagent prompts also have caveman output rules, tailored to each agent's role:

- **general subagent**. terse implementation reporting. no progress narration. state file changed, what changed, why. failure reports state what was tried and where blocked.
- **explore subagent**. terse search findings. no search narration. lead with file path + line number. group by area, not search order.

subagent caveman rules are always active regardless of which primary agent is selected. they reduce token usage in agent-to-agent communication where no human reads the output.

### custom agents

the `general` subagent prompt now ships natively (see [general subagent](#general-subagent) above). the remaining custom agents in `custom_agents/` need to be copied to your config directory:

```bash
cp custom_agents/docs.md custom_agents/plan_structured.md custom_agents/wave_plan.md custom_agents/wave_verify.md ~/.config/opencode/agent/
```

- **docs**. technical documentation writer with specific style constraints (short chunks, imperative headings, relaxed tone).
- **general**. custom system prompt for the general subagent. now shipped natively (iteration 3). this file remains as a reference.
- **plan_structured**. structured planning with a 4-phase pipeline: survey (parallel explore subagents), organize, write, verify. you provide the task upfront; the agent's value-add is thorough codebase survey and structured documentation. asks questions on genuine ambiguities. read-only.
- **wave_plan**. wave decomposition. takes a plan markdown file and produces a campaign under `.wave/campaigns/<id>/` (`AGENT_INSTRUCTIONS.md`, `OVERVIEW.md`, `STATE.md`, and per-wave `WAVE.md` files). read-only outside `.wave/`. loop-managed after the first decomposition.
- **wave_verify**. wave review + amendment. auto-runs after every decomposition (sanity-checks the plan against reality) and again whenever a wave fails in a way that suggests the spec itself is wrong. patches the plan in place, escalates to user if it can't decide alone. broad permissions; behaviorally constrained to `.wave/`.

## knowledge base and integration discipline

two artifacts that emerged from the campaigns and have outsized value going forward.

[`GOTCHAS.md`](./GOTCHAS.md) is the sharp-edges knowledge base. each entry is one painful debugging session distilled to a fix pattern. progressive disclosure: load the indexes first (`Read GOTCHAS.md limit=200` for about 4 KB), then jump to specific entries by slug with offset reads. covers Effect v4 renames, Bus and InstanceState lifetime traps, opentui render antipatterns, Bun coverage quirks, PTY origin gating, perf bench methodology, permission routing, the D5 extractor's terse-follow-up-status-line edge case, the D11 ABORT parser's last-line-only anchor. read before doing the matching kind of work; you'll save the same hours I did.

`INTEGRATION_INVARIANTS.md` (per-campaign, lives in each campaign's archive under `.wave/campaigns/<id>/plan/`) plus the test harness at `packages/opencode/test/integration/` is the discipline. each invariant names a scenario the system must hold. each `it.instance` walks the scenario and asserts what a user would observe. coverage is necessary; the harness is sufficient. the structural bugs that survived 100% line coverage in the codex-parity campaign (multi-chat collision, wait_agent never waking, agent_type not validated) and the actor-discipline campaign (silent delivery failure when subagent emits text + close_agent in the same turn, sibling deadlock when peers wait on broadcasts that don't exist) are the empirical proof. the harness now holds 45 invariants — 17 pre-existing scoping/lifecycle plus 28 D-series covering delivery contract, sibling coordination, ask pattern, ABORT protocol, supervision, pools, links, bounded mailboxes, behavior contracts, observability. future work touching multi-agent or tool-surface code must add at least one invariant before its production code lands.

## if you ever fork this

the prompts contain my identity. if you happen to be using this, fork it, change the identity in these files first:

- `packages/opencode/src/session/prompt/anthropic.txt`. name, org, and identity in the Anthropic system prompt.
- `packages/opencode/src/session/prompt/qwen.txt`. same for the default prompt (GLM, Qwen, and other non-specifically-matched models).
- `packages/opencode/src/session/prompt/gemini.txt`. same for the Gemini system prompt.
- `packages/opencode/src/agent/prompt/explore.txt`. explore agent identity.
- `packages/opencode/src/agent/prompt/general/anthropic.txt`. Anthropic general subagent identity.
- `packages/opencode/src/agent/prompt/general/gemini.txt`. Gemini general subagent identity.

## installation

### from source (development)

```bash
bun dev
```

### standalone binary

```bash
# build
./packages/opencode/script/build.ts --single

# make executable
chmod +x ./packages/opencode/dist/opencode-darwin-arm64/bin/opencode

# or

chmod +x ./packages/opencode/dist/opencode-darwin-x64/bin/opencode

# symlink to PATH
ln -sf "$(pwd)/packages/opencode/dist/opencode-darwin-arm64/bin/opencode" ~/.local/bin/codemaxxxing

# or

ln -sf "$(pwd)/packages/opencode/dist/opencode-darwin-x64/bin/opencode" ~/.local/bin/codemaxxxing
```

make sure `~/.local/bin` is in your `PATH`. if not, add to your `.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## license

same as upstream OpenCode. see [LICENSE](./LICENSE).
