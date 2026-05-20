# Overview

## What this campaign does

Implements ADR-009 (treat the multi-agent surface as a disciplined actor system) across all three phases, using the planner/generator/evaluator orchestration pattern from Anthropic's AI Engineer talk on long-running agents (May 2026). Each non-bootstrap wave's executor (`caveman`) orchestrates three subagent roles per the talk's pattern; the campaign delivers the actor-discipline patterns as the artefact of that orchestration.

Two bugs motivated this campaign. Both are reproducible from session diagnostics:

1. **Multi-agent delivery contract failure** (`ses_1c2e8d84affeZ7t5g5LKveGDTo`). Subagent emitted text + `close_agent` in same turn → message `finish: "tool-calls"` → auto-extractor (`src/agent/control.ts:712-716`) skipped the report → parent received one-line cleanup as the "deliverable." Cascaded: path-fragile self-close (`agent_type` used instead of canonical path), tool-error-as-success rationalisation, race between completion notification and pending sends.
2. **Sibling-coordination deadlock** (`ses_1d84f236bffeEWmrmOhp6SoLma` Demo 2). Two siblings (`/root/prosecutor`, `/root/defense`) addressed openings to a shared parent then idled waiting for each other's openings. No broadcast primitive exists; messages are unicast; prompts never said so. Idled until user noticed.

Compounded by Opus 4.7 migration: the model now interprets prompts literally and will not infer implicit contracts. Implicit "your text response IS the deliverable" framing is exactly the kind the new model won't rescue.

## What ships

Across 10 waves grouped into four phases:

- **Phase 0 (Wave 0)** — bootstrap: harness floor (extractor narrowing, canonical-path injection, safety net, root-hold, close_agent semantics, self-close). Executor-solo; no orchestration. Lands the safety net BEFORE orchestrated waves rely on subagent delivery.
- **Phase 1 (Waves 1-2)** — delivery contract prose + integration invariants. Rewrites subagent prompts to state the contract literally; adds sibling-coordination patterns + limits-of-actor-model section; drives INV-D-01..08 to green.
- **Phase 2 (Waves 3-4)** — ask pattern + ABORT protocol. Adds `correlation_id` to messages; `wait_for_reply` variant; mandatory-timeout doctrine. Structured ABORT reasons replace ad-hoc failure rationalisation. INV-D-09..14.
- **Phase 3 (Waves 5-8)** — supervision strategies + spawn_pool + linking + bounded mailboxes + per-agent_type behaviors. The full Erlang/Akka surface adapted to LLM constraints. INV-D-15..26.
- **Phase 4 (Wave 9)** — observability instrumentation + cross-wave NOTES.md audit. The "sit with the model, read the traces" discipline made systematic.

## Existing infrastructure (current state)

Multi-agent surface (`packages/opencode/src/`):

- `agent/control.ts:695-762` — completion-watcher fiber + auto-extractor. The bug surface for D5. Predicate at `712-716` skips `finish: "tool-calls"`; extractor body at `718-728` joins text parts of the matched message.
- `agent/mailbox.ts` — per-session append-only queue with monotonic seq for `wait_agent` wake-ups. Unbounded today; D15 adds bounds.
- `agent/inter-agent-communication.ts` — `InterAgentCommunication` schema. Has `author`, `recipient`, `content`, `trigger_turn`, `sent_at`. D10 adds optional `correlation_id`; D11 adds optional `abort_reason` payload.
- `agent/agent-path.ts` — `/root/<task_name>` canonical paths.
- `session/system.ts:101-116` — `capabilityHints` dispatcher. Three fragments gated by effective permissions: `persistent-processes.txt`, `multi-agent-root.txt`, `multi-agent-subagent.txt`. D2 templates the agent's canonical path into the subagent fragment per-spawn.
- `session/llm.ts:103-116` — final system-prompt assembly. The order is agent-prompt → environment → AGENTS.md → skills → capability hints → user-system.
- `session/prompt.ts:1451-1502` — mailbox drain at top of every turn. Drained items become synthetic `UserPart`s prefixed `[from <author>]`.

Six-tool API (`packages/opencode/src/tool/`):

- `agent-spawn/`, `agent-send/`, `agent-followup/`, `agent-wait/`, `agent-list/`, `agent-close/`. All consult permission key `task` (post-Iteration 8 replace-bash-task wave 3 collapse).
- `agent-close/agent-close.ts:60-68` — returns `error: "invalid_target"` for both "wrong path" and "self-terminated child." D9 splits into `path_invalid` vs `already_terminated`. D3 makes `target` optional → caller is target.

Subagent prompts (`packages/opencode/src/agent/prompt/`):

- `multi-agent-root.txt` (72 lines) — root agent guidance. D7 adds "Sibling coordination"; D8 adds "Limits of the actor model."
- `multi-agent-subagent.txt` (37 lines) — subagent guidance. D1 rewrites "Final answer" (lines 35-37) → "Delivery contract" with literal tool-call sequence. D4 prepends a "Your canonical path" injection block (templated by D2).
- `general/anthropic.txt` (119 lines) — Claude-flavor general subagent prompt. Lines 1 and 46-53 carry the "your text response IS the deliverable" implication that D1 supersedes. D4 defer-edits.
- `general/gemini.txt` — Gemini-flavor general subagent prompt. Same shape as anthropic.txt; same defer-edits.
- `explore.txt` (106 lines) — read-only research subagent. Lines 1 and 47-56 carry similar implication; same defer-edits.
- `persistent-processes.txt` — persistent PTY capability hint. Unchanged by this campaign.

Wave system (`packages/opencode/src/wave/`):

- `loop.ts` — the FSM that spawns wave sessions. Sets `active_session_id` and `active_session_kind` on spawn; clears on settle. Per Iteration 7 round 3: agents MUST NOT touch these fields.
- `state.ts` — STATE.md read/write.
- Custom agent definitions at repo-root `./custom_agents/wave_plan.md` and `./custom_agents/wave_verify.md` — the planner and verifier roles at the campaign level. NOT the same as the per-wave planner subagent the executor spawns (those are `general` with role-specific prompts).

Integration invariant harness (`packages/opencode/test/integration/`):

- `multi-agent-invariants.test.ts` (944 lines) — Iteration 8 hardening harness. Per-root scoping, child-completion-wakes-parent, cross-root-send-rejection, session-deletion-cleanup, parent-close-cascades-to-children, and others. This campaign EXTENDS the catalog with INV-D-01..26; does not replace.

Tests live alongside this harness. The pattern: `testEffect(Layer.mergeAll(...))` → `it.instance("invariant-slug", ...)`. See `test/AGENTS.md` for `tmpdir` / `provideTmpdirInstance` / `it.instance` mechanics.

## Hard constraints

- **No deletions.** All ADR-009 changes are additive (new params with defaults, new tools, new prose sections) or surgical (extractor predicate change, error-tag split). Existing six-tool API surface stays compatible.
- **Permission keys collapse onto `task`.** Any new multi-agent tool (e.g. `spawn_pool` in Wave 6) consults permission key `task`, not its own ID. Mirrors `EDIT_TOOLS`/`SHELL_TOOLS`/`MULTI_AGENT_TOOLS` precedent from replace-bash-task campaign.
- **Per-root scoping is non-negotiable.** Every new AgentControl method takes a `senderID: SessionID` parameter and resolves the caller's root. Mirror the Iteration 8 hardening pattern. Multi-chat-same-project must keep working (see `multi-root-isolation` invariant).
- **No Drizzle migrations.** All state lives in-memory or in existing tables. `correlation_id` and `abort_reason` are optional fields on `InterAgentCommunication`; existing rows remain valid.
- **No prompt-cache invalidation surprises.** The capability hints render LAST. Changes to the subagent hint affect cache-key suffix, not the cached agent-prompt or environment block. Per-spawn path injection (D2) is in the hint — acceptable; the rest of the prompt cache stays stable.
- **No subagent self-evaluation.** ANTHROPIC_HARNESS_LEARNINGS.md § "Self-evaluation is a trap" is the authority. Orchestrated waves must spawn a separate evaluator subagent; the generator never grades its own work, and the executor never grades the generator's work directly (executor's role is supervisor — it watches for set-phrases and reads CONTRACT.json, but does not score criteria).
- **The 5 prompt files stay in their current locations.** No file moves. D1 rewrites `multi-agent-subagent.txt` in place; D4 defer-edits the three base prompts in place; D7/D8 add sections to `multi-agent-root.txt` in place.
- **Working tree clean between waves.** Commit on every outcome. Failure commits are local audit trail.

## Campaign hot paths

The hot paths this campaign touches:

1. **`agent/control.ts:712-716` extractor predicate** — runs once per child completion. D5 changes filter shape (drop tool parts, walk back if empty). Hot during heavy fan-out work.
2. **`session/system.ts:capabilityHints`** — runs once per session bootstrap. D2 adds per-spawn path templating in the subagent fragment. Small cost.
3. **`agent/mailbox.ts` send/recv** — runs on every message. D15 adds bounded-queue check; small cost.
4. **`session/prompt.ts:1451-1502` mailbox drain** — runs at top of every turn. Unaffected by this campaign (already efficient).
5. **`agent/control.ts:spawnAgent`** — runs once per spawn. D12 adds on_failure + pool_strategy plumbing; D14 adds link table updates. Both small.

No baseline perf bench needed for this campaign — the changes are not on the hot perf paths exercised by `codex-parity` benches. Wave 9 instrumentation adds metric emission per D18; that itself must be cheap (small counter increments, no blocking IO).

## Cross-cutting reference docs

Read on every relevant wave (the WAVE.md tells you which):

- `OVERVIEW.md` (this file) — every wave reads.
- `ORCHESTRATOR_PROTOCOL.md` — required for every orchestrated wave (1-8).
- `ANTHROPIC_HARNESS_LEARNINGS.md` — read once at campaign start; reference when designing new orchestration shapes.
- `INTEGRATION_INVARIANTS.md` — INV-D-01..26 catalog. Every wave that touches a multi-agent surface reads this.
- `PROMPT_SURFACES.md` — single source of truth for which prompt file owns which guidance. Prose waves (Wave 1) MUST consult before editing.
- `REFERENCES.md` — file paths, prior campaigns, repo file:line references, diagnostic-session IDs.
- `RUBRIC_GUIDE.md` — how to author / read per-wave `RUBRIC.json` files. Both wave_plan (drafting) and wave_verify (reviewing) consume this.

## Sequencing

Sequential. Each wave depends on prior waves' artefacts:

- Wave 0 lands the floor. Critical: extractor narrowing (D5) and safety net (D5) must exist BEFORE Wave 1 starts orchestrating subagents, or orchestration silently swallows subagent failures.
- Wave 1 lands the prose. After Wave 1, future subagents (including those Wave 2+ spawns) read prompts that explicitly state the delivery contract.
- Wave 2 validates Wave 0 + Wave 1 by driving INV-D-01..08 green. If Wave 2 fails, Wave 0 or 1 is incomplete.
- Waves 3-8 add Phase 2 and Phase 3 features in dependency order: ask pattern (3) → ABORT (4) → supervision (5) → pools (6) → lifecycle (7) → behaviors (8). Each can use the orchestration discipline established in Waves 0-2.
- Wave 9 closes out with observability + audit.

No internal parallelism within a wave EXCEPT within the orchestration discipline (planner → N gen+eval pairs in parallel for tasks with disjoint write sets). Cross-wave parallelism is not supported by the wave loop.

## Glossary

- **Delivery contract** — the rule that subagents MUST deliver their result via `send_message`/`followup_task` to their spawner. Text-extraction is a fallback. (ADR-009 D1.)
- **Canonical path** — `/root/<task_name>` or deeper. The stable address of an agent. (D2.)
- **Orchestrator** — the wave executor (`caveman`) running an orchestrated wave. Reads WAVE.md, spawns planner subagent, then per-task generator + evaluator pairs. Watches for set-phrases. Never grades criteria directly.
- **Planner subagent** — `general` agent the executor spawns first. Reads WAVE.md, breaks the wave into PLAN.json tasks (one file or one tight bundle per task). Emits `PLAN READY` on completion.
- **Generator subagent** — `general` agent the executor spawns per task. Negotiates CONTRACT.json with evaluator, builds per criterion, commits per criterion, sends evaluator on completion of each.
- **Evaluator subagent** — `general` agent the executor spawns per task. Reads PLAN.json + RUBRIC.json, negotiates CONTRACT.json with generator, grades each criterion via running the verify recipe (tests, type-checks, file-greps), reports back via `send_message`.
- **PLAN.json** — written by planner subagent at runtime. Per-wave decomposition into tasks.
- **CONTRACT.json** — written by generator+evaluator pair during negotiation phase. Per-task agreement on criteria + per-criterion grading status.
- **RUBRIC.json** — drafted by `wave_plan` (at campaign decomposition) and reviewed by `wave_verify`. Per-wave grading rubric. Lives at `waves/wave_N/RUBRIC.json` (created during the campaign decomposition step but seeded as a stub for the executor to fill — see RUBRIC_GUIDE.md).
- **Pivot** — orchestrator's response to evaluator's `ABORT(approach_failed)`. Revert the task's commits, refine the generator's spawn prompt with the evaluator's recommendation, respawn the pair.
- **ABORT(reason)** — structured failure set-phrase from a subagent. Reasons: `spec_wrong`, `transient_tool_error`, `out_of_scope`, `context_full`, `approach_failed`, `user_question`. Mirrors wave system's set-phrases.
- **INV-D-N** — integration invariant in the catalog (INTEGRATION_INVARIANTS.md). Slug used as test name in `multi-agent-invariants.test.ts`.
