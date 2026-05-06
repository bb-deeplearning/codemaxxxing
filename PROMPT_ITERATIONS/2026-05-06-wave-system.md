# Iteration 7: Wave system overhaul — verifier agent + retry/escalation FSM + conversational user pause

**Date**: 2026-05-06

## Discovery

The original wave system (iteration 1, "Initial fork") shipped a single `wave_decompose` agent that produced a `.wave/` directory with `AGENT_INSTRUCTIONS.md`, `OVERVIEW.md`, `STATE.md`, and `waves/wave_N/WAVE.md` per wave. A `/execute-wave` slash command nudged the user to spawn the next wave manually. The user pressed Enter, the executor agent ran one wave, committed, and stopped. Repeat until done.

It worked for the happy path. It collapsed in three real failure modes that surfaced during a small e2e test (a Bun + TypeScript todo CLI):

1. **Spec drift caught at execution time, not plan time.** The planner asserted "`bun run typecheck` exits 0 on an empty project" — false (TS18003). The planner instructed the scaffold sub-agent to ignore `bun.lockb` — but Bun 1.3 writes `bun.lock` (text). These weren't bugs in the executor; they were stale assumptions the planner baked into the spec. The first wave failed verification, and there was no recovery path. The campaign was stuck until manual intervention.

2. **No amendment workflow.** When the executor identified the spec was wrong (and it could — caveman correctly noted the two flaws above in STATE.md notes), there was no machinery for fixing the spec mid-flight. WAVE.md and OVERVIEW.md were treated as immutable artifacts of the planning step. The user had three options: re-decompose the entire campaign (wasteful), hand-edit WAVE.md off-protocol (fragile), or abandon waves and do the work manually.

3. **No conversational user channel.** When the executor hit ambiguity (an option it couldn't decide alone), there was no way to surface it. The agent either guessed or stopped silently. Stopping silently meant the user noticed nothing changed; guessing meant the wave produced the wrong thing and failed verification later.

Underlying all three: the system modelled software work as plan → execute → done. That's waterfall, and waterfall doesn't survive contact with reality. The plan needed to be a living document, the execution loop needed feedback paths back to amendment, and the user needed a first-class channel for the cases the system couldn't resolve alone.

## Research

### Geoffrey Huntley's Ralph loop ([ghuntley.com/ralph](https://ghuntley.com/ralph/), [github.com/ghhuntley/how-to-ralph-wiggum](https://github.com/ghhuntley/how-to-ralph-wiggum))

Same core insight as our wave system (fresh context per chunk, state on disk) but with a critical mechanic our system was missing:

**Two prompts, one loop, mutable plan.** Ralph swaps a `PROMPT.md` between PLANNING mode (gap analysis: specs vs code → updates `IMPLEMENTATION_PLAN.md`, no implementation) and BUILDING mode (pick top task → implement → test → commit → update plan). The implementation plan is rewritten by the agent as it learns. AGENTS.md is also self-modified when operational learnings emerge.

This collapsed an entire taxonomy of "what agents do we need" into one role with two prompts. The early drafts of our v2 design had separate agents for plan-review, decomposition-review, wave-review, amendment, fact-checking — five new agents, five new sessions, five more failure modes. Ralph proves you don't need that. One agent with broad mandate ("look at the system, decide what's needed, edit accordingly") is enough.

### Token cost of agent fragmentation

Adding 5 new agents would mean 5 more sessions per campaign, each rehydrating context, each re-reading WAVE.md and surrounding docs. For a 3-wave campaign that's 18+ sessions of orchestration overhead for ~3 sessions of actual work. Geoff calls multi-agent multiplexing "a red hot mess" for the same reason microservices became one — non-deterministic units make coordination harder, not easier.

### Conversational pause vs transactional answer

OpenAI's Codex / Anthropic's Claude Code both end the session when an agent asks a question; the user has to start a new session to "answer". This is fine for simple yes/no but bad for ambiguous decisions where the user needs the agent's full context to decide.

We instead let the agent stop its turn (commit, update STATE) without ending the session. The session stays alive. The user opens the session in chat, reads the rich contextual question (the agent was instructed to write A/B/C options + constraints in chat above the set phrase), and replies normally. The same agent picks up the reply mid-conversation and continues. No new session, no context rehydration, no STATE.md edit dance.

### Atomic readability

This was already a principle in the original wave_decompose prompt. We doubled down. Every document the executor loads must be readable in full — no pagination. `OVERVIEW.md`, `WAVE.md`, `NOTES.md` all sized to fit in one read. If a file would force the agent to paginate, it's wrong-sized; split it.

### Failure-kind classification

Borrowed from PostgreSQL error codes: distinguish transient (retry will help) from non-transient (retry won't help). The executor self-reports: `WAVE FAILED` for transient (its own bug, fresh session might do better), `PLAN UNDOABLE` for non-transient (spec is wrong, no amount of retrying will help). The loop branches on this — transient retries, undoable escalates straight to verifier.

Mis-classification was a worry. Mitigation: even if executor says transient, after 3 retries the loop escalates to verifier anyway. So worst case is wasting 3 sessions discovering what 1 amend would've caught.

### Reset vs continue on retry

If a wave failed mid-write, the working tree has partial output. Two choices on retry: reset (wipe partial work, restart fresh) or continue (build on partial). Neither is universally correct. We push the decision to the executor — on entry, if `NOTES.md` exists, the executor reads prior attempts and chooses, recording its decision in NOTES.md. Reset uses `git revert --no-commit <prior-failure-shas>`; continue is a no-op.

This relies on "always commit even on failure" being non-negotiable. Without it, the working tree state is unrepresented and reset/continue is impossible to reason about.

## Solution

Iterated through three commits over one day. Each round responded to a real failure mode in the test campaign.

### Round 1: verifier agent + retry/escalation FSM (`7d48d5314`)

**`custom_agents/wave_verify.md` (new)** — a primary agent with broad permissions (`edit/write/bash: "*": allow` minus destructive git ops). Two contexts inferred from STATE.md:

- POST-DECOMPOSE — sanity-check fresh campaign, probe reality (`<toolchain> --version`, dry-runs of verification commands), patch spec drift before execution.
- POST-EXECUTION — read NOTES.md, decide patch / rewrite / ask user, apply edit, set wave back to pending.

Four set-phrase exits: `PLAN OK` / `PLAN PATCHED` / `PLAN REWRITTEN` / `USER QUESTION: <summary>`.

**`custom_agents/wave_plan.md` (rewritten)** — substantial overhaul:

- AGENT_INSTRUCTIONS skeleton bakes in always-commit protocol with prefixed messages (`wave N: success` / `wave N (failed): reason` / etc.), NOTES.md format spec, retry-on-entry handling, four set-phrase outcomes, conversational user-reply protocol.
- STATE.md schema extended: `failure_kind`, `retry_count`, `verify_count`, `user_question`. Templates use `""` literal (not bare `key:`) to avoid YAML null-colon bugs.
- `executor_model` documented as optional — leave `""` to use default model resolution; agent asks once if user didn't mention, never invents a model id.
- New "Handling user replies" section — USER QUESTION pauses the agent's turn, not the session. User replies in chat, same agent resumes.

**Loop FSM** (`packages/opencode/src/wave/loop.ts`) — set up the spawn decision matrix, retry counting, verifier invocation, conversational pause handling, settle-handler routing. Crash auto-commit (executor crash → loop runs `git add -A && git commit -m "wave N (crashed): ..."`, bumps retry_count, falls through to retry/escalate).

### Round 2: three FSM bugs caught in review (`611c7b4cb`)

The user reviewed the design against a stated principle ("plan is not perfect; when an issue arises, fix the plan and go forward") and identified three places where behavior violated it:

1. **Infinite verifier respawn on crash.** Verifier crashes → escalate to awaiting_user. User clears user_question and toggles wave_status back to failed (to retry). Loop sees failed + retry_count >= cap → spawn verifier → crash again → repeat. Fix: on verifier-crash escalation, also bump `verify_count` to cap so subsequent spawns hit the verify-cap branch and re-escalate with a clearer message.

2. **Interrupt mis-categorized as plan issue.** User pressed `i` → loop set `wave_status: failed` + `retry_count: cap`. Next re-arm spawned the verifier. The system mis-read user cancellation ("user wants to stop") as plan-needs-fixing. Fix: new `failure_kind: cancelled` variant. interrupt() sets it, leaves retry_count alone. Spawn paths refuse cancelled waves. User must explicitly clear with `c` keybind to resume.

3. **Concurrent spawn race.** spawnPerState (called from `arm()` and the settle handler) didn't check `active_session_id` before spawning. Timing windows could spawn a second agent while the first was still running — two agents editing the plan concurrently produces incoherent state. Fix: defensive `if (current.active_session_id !== null) return` at top of every spawn function.

### Round 3: subscriber lifetime (`aa04e20e1`) + active_session_id ownership (`0b5d8f51b`)

After the first end-to-end test, two more bug classes surfaced:

**Subscriber dying after first request.** Verifier session emitted PLAN PATCHED, went idle — and nothing happened. No spawnNext, no log entry from the loop. Diagnosis: `Effect.forkScoped` binds the subscriber fiber to the scope active when the layer's effect first runs. The WaveLoop layer was first materialized inside an HTTP handler-layer construction (the first `/wave/*` request), so the forkScoped fiber was bound to that request's scope. When the request ended, the scope was disposed, the fiber was interrupted — even though the layer instance stayed cached in `memoMap`. Subsequent requests got the cached layer with a dead subscriber inside.

Evidence in the session log:

```
09:07:27 +29ms subscribing session.status
09:07:27 +8ms unsubscribing session.status
09:07:28 +35ms subscribing session.status
09:07:28 +1ms unsubscribing session.status
```

Two subscribe-then-unsubscribe pairs, both lasting <10ms, then nothing.

Fix: follow the FileWatcher pattern (`packages/opencode/src/file/watcher.ts`) — wrap the long-running setup (bus subscriber + spawn helpers + the prompt forks they trigger) inside `InstanceState.make`. The `ScopedCache` binds the resulting fiber to the directory instance's lifetime. Add `WaveLoop.init()` and call it from `InstanceBootstrap.run` so the subscriber starts at directory open.

**Executor clearing active_session_id.** After the subscriber fix, wave 1 ran to completion but wave 2 didn't auto-spawn. STATE.md showed `active_session_id: null` and the executor's protocol in AGENT_INSTRUCTIONS.md included `active_session_id: null` on every outcome. The executor's turn ends BEFORE the session truly idles, so when the loop's settle handler fires:

```ts
if (state.active_session_id !== evt.properties.sessionID) return
```

it sees `null !== "ses_..."` → returns early → no spawnNext.

Same bug class as the verifier issue we'd already fixed for awaiting_user. Generalized the rule: `active_session_id` is loop-managed. Every outcome's STATE update was rewritten to leave it alone. Both `wave_plan.md` and `wave_verify.md` got a bold "loop-managed. Never touch it." preamble at the top of their State update protocols.

There's a wrinkle: existing campaigns had AGENT_INSTRUCTIONS.md generated by the OLD wave_plan template, frozen in the campaign directory. Re-decomposing or hand-patching is required for those.

## Observe

Watch for these behaviors:

- **Auto-advance between waves.** Press `r` once. Every wave completion should auto-spawn the next without user intervention. If you have to press `n` between waves, something's wrong — most likely cause is an old AGENT_INSTRUCTIONS.md still telling the executor to clear `active_session_id`.
- **Verifier first-arm.** New campaigns should have the verifier run first (verify_count == 0 trigger), before any executor wave. If the executor spawns first, the post-decompose check is missing — STATE.md probably has verify_count > 0 from a stale fixture.
- **Verifier reality probes.** When the verifier runs post-decompose, it should run cheap shell commands to validate planner assumptions. If it just reads files and approves without probing, the prompt isn't taking. We should see things like `<toolchain> --version` and dry-runs of verification commands in the chat log.
- **NOTES.md format compliance.** On any non-success outcome, the executor should append to `waves/wave_N/NOTES.md` with the structured format (Session, Commit, Date, Decision-on-entry, What happened, What failed, Diagnosis, Tried in-session, Recommendation). Free-form prose dumps mean the format isn't sticking.
- **Conversational pause flow.** When an agent emits USER QUESTION, the dashboard should show the banner, the chat should have a rich contextual question (not just the one-line summary), and replying in chat should resume the same agent mid-thread without spawning a new session. Watch for: (a) agent ending the session instead of pausing, (b) reply being treated as a fresh prompt with no context, (c) new session being spawned for the reply.
- **Set-phrase compliance.** Every agent turn should end with exactly one of the set phrases. Drift here means the prompt's "must be the last line" rule isn't taking. If we see prose after the set phrase, agent is over-explaining.
- **Crash recovery.** Kill a wave session mid-flight. Loop should detect the crash on next settle, auto-commit any dirty tree, mark the wave failed with `failure_kind: crash`, and either retry (if under cap) or escalate to verifier. Watch for stuck `wave_status: running` states — that means the settle handler didn't react.
- **Verify cap.** A campaign that requires 3+ amendments should hit the cap and surface a USER QUESTION. If we see verify_count climbing past 3, the cap isn't taking and we'll churn until the user manually intervenes.
- **Cancelled state behavior.** Press `i` mid-wave. State should show `failure_kind: cancelled`. Pressing `r` afterwards should NOT auto-retry (spawn refusal). Pressing `c` should clear cancelled and allow `r` to retry. Watch for: silent auto-retry after cancel (means the spawn-refusal guard isn't working).
- **Subscriber lifetime.** At cmx startup, the bus log should show `session.status subscribing` once per open directory and stay subscribed (no immediate unsubscribe). If you see subscribe-then-unsubscribe pairs at startup, the InstanceState binding isn't taking and we're back to the original bug.

## Architectural choices worth recording

### One verifier, broad mandate

Earlier drafts had separate agents for plan-review, decomposition-review, wave-review, amendment, and grounding probes. The current design collapses all five roles into the verifier and lets the executor self-report failure kind. Token-cheaper, fewer prompts to maintain, fewer failure modes. Trade-off: the verifier prompt is broader and less guided per situation, but its broad mandate ("look at the system and decide what's needed") matches Ralph's two-mode pattern and works in practice.

### Mutable plan, frozen instructions

`AGENT_INSTRUCTIONS.md` is the stable entry point — generated once by `wave_plan`, never modified. `WAVE.md` and `OVERVIEW.md` are mutable — the verifier can edit them in place. This split protects the bootstrap protocol (a fresh session always knows how to start) while letting the spec evolve under reality.

### Conversational pauses, not stop-and-restart

`USER QUESTION` could end the session and have the user "answer" via STATE.md edit. Conversational resume is much better UX: the agent's full context for the question is right there in the chat, and the user replies in their natural channel. The session stays alive between the agent's pause and the user's reply.

### Loop owns active_session_id

The loop sets `active_session_id` when it spawns. Agents must never write to it. If an agent clears it as part of its end-of-turn STATE update, the loop's settle handler sees a mismatch and skips the auto-spawn. Found this the hard way after wave 1 → wave 2 transitions kept getting stuck. Fixed by giving the loop sole ownership and updating both prompts to call this out explicitly.

### Always commit, even on failure

Every wave session — success, failure, undoable, crash, paused — produces a git commit. The earlier system only committed on success. Failures left the working tree dirty, NOTES.md got lost across retries, and the loop couldn't tell partial work from complete work. Always-commit gives a clean tree between sessions, full git audit trail, and a deterministic resume point. Minor cost: some `wave N (failed)` noise in `git log`.

### Per-directory subscriber, not global

`InstanceState.make` binds the bus subscriber's fiber to the directory's lifetime. Without this, the subscriber dies when the layer is first materialized inside an HTTP handler scope. Trade-off: each open directory has its own subscriber filtering global session events. Per-event cost is microseconds, bounded by directories × session events. Negligible.
