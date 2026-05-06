# Changes: Wave system overhaul, TUI dashboard, render perf, drafting-table redesign

**Date**: 2026-05-06
**Iteration**: [PROMPT_ITERATIONS/2026-05-06-wave-system.md](../PROMPT_ITERATIONS/2026-05-06-wave-system.md)

Catch-up entry covering everything in the fork since the [caveman entry](2026-04-11-caveman-agent.md) on 2026-04-11. This includes a full wave system overhaul (verifier agent, retry/escalation FSM, dashboard, conversational user pauses), a TUI redesign called "drafting table", streaming render perf fixes that unfroze the message pane, and a handful of upstream-sync follow-ups.

## Wave system v2 — verifier, retry/escalation, dashboard, on-disk FSM

The largest area of work since the last entry. The wave system existed in skeleton form (a `wave_decompose` agent producing a `.wave/` directory; a `/execute-wave` slash command nudging the user to spawn the next wave manually). It now runs autonomously: a finite state machine spawns each wave's executor, retries on transient failure, escalates to a verifier agent that can patch the plan in place, and pauses conversationally when it needs the user.

### New agent: `wave_verify`

`custom_agents/wave_verify.md` — a primary agent that wraps both review and amendment. Two modes inferred from STATE.md:

- **Post-decompose** — `verify_count == 0`. Sanity-check the campaign before any executor wave runs. Probes reality (`<toolchain> --version`, dry-runs of verification commands) so the planner's blind-spot bugs (lockfile naming, deprecated flags, bad assertions) get caught at plan time rather than wave time.
- **Post-execution** — `wave_status: failed/plan_undoable`. Reads the executor's `NOTES.md`, decides patch vs rewrite vs ask user, applies the change in place, sets the wave back to `pending` so the loop respawns the executor against the corrected spec.

Cap: 3 verifier sessions per campaign. Force-escalates to USER QUESTION on the third amendment attempt.

Set-phrase exits: `PLAN OK` / `PLAN PATCHED` / `PLAN REWRITTEN` / `USER QUESTION: <summary>`.

Behaviorally constrained to `.wave/` writes (broad permissions for now, with explicit denies on `git push|reset --hard|rebase|stash|clean -fdx`, `sudo`, `rm -rf /*`).

### Rewritten `wave_plan` (renamed from `wave_decompose`)

`custom_agents/wave_plan.md` — substantially rewritten:

- AGENT_INSTRUCTIONS skeleton now bakes in: always-commit protocol, NOTES.md format spec, retry-on-entry handling, four set-phrase outcomes, conversational user-reply protocol.
- STATE.md schema extended with new fields: `failure_kind`, `retry_count`, `verify_count`, `user_question`, `active_session_kind`. Templates use `""` literal (never bare `key:`) so YAML round-trips cleanly.
- Input section makes `executor_model` optional — leave `""` to use codemaxxxing's default model resolution; agent asks once and never invents a model id.
- New "Handling user replies" section — `USER QUESTION` pauses the agent's turn, not its session. User replies in chat, same agent resumes mid-thread.
- Hard rule: `active_session_id` is loop-managed. Agents must never touch it.
- Slash command renamed: `/wave-plan` (was `/agent wave_decompose`) and pre-fills a prompt that explicitly says model is optional.

### Wave service infrastructure (Effect)

New per-directory service exposing campaign state + the auto-loop FSM:

- `packages/opencode/src/wave/wave.ts` — campaign service. `listCampaigns`, `getActive`, `setActive`, `read`, `readActive`, `write`, `update`. Per-instance state via `InstanceState.make`.
- `packages/opencode/src/wave/state.ts` — STATE.md schema + parser/serializer. New literals: `WaveStatus` adds `plan_undoable` + `awaiting_user`; `RowStatus` adds `undoable` + `paused`; new `FailureKind` literal (`""` | `transient` | `undoable` | `crash` | `cancelled`); new `SessionKind` literal (`""` | `executor` | `verifier`). New State fields: `failure_kind`, `retry_count`, `verify_count`, `user_question`, `active_session_kind`. Parser defaults all new fields safely if missing (back-compat with old STATE.md files).
- `packages/opencode/src/wave/loop.ts` — the FSM. ~600 lines. Owns: spawn decision logic (`spawnPerState`), executor spawn, verifier spawn, retry counting, crash detection + auto-commit, conversational pause handling, settle handler. Methods exposed: `init`, `arm`, `pause`, `resume`, `interrupt`, `stop`, `next`, `clearCancelled`, `clearQuestion`. Internal helpers + the bus subscriber wrapped inside `InstanceState.make` so the fiber binds to the directory's lifetime, not the first-HTTP-request scope.

### HTTP API + SDK

- `packages/opencode/src/server/routes/instance/httpapi/handlers/wave.ts` — exposes Wave + WaveLoop services over HTTP.
- `packages/opencode/src/server/routes/instance/httpapi/groups/wave.ts` — endpoint definitions.
- TUI uses HTTP exclusively (no direct service calls).

### Bootstrap integration

`packages/opencode/src/project/bootstrap.ts` — yields `WaveLoop.Service` at layer init and includes it in the eager-init forEach. Without this, `WaveLoop` only materializes lazily on the first `/wave/*` HTTP request, binding its bus subscriber to the request scope; the subscriber dies when the request ends. Bootstrap eager-init binds it to the directory's permanent scope instead.

### Dashboard (TUI)

- `packages/opencode/src/cli/cmd/tui/routes/wave/index.tsx` — full dashboard route. Header (campaign id + plan + executor + counts), loop strip (loop_state + wave_status + retry/verify counters + session badge), USER ATTENTION banner (when `wave_status: awaiting_user`), wave table (color-coded rows), contextual footer keybinds.
- `packages/opencode/src/cli/cmd/tui/context/wave.tsx` — wave context for the TUI. Lazy: no SSE subscription, no polling, no requests until something engages. SSE subscriber arms on first `refresh()`/`arm()` etc; polling is refcounted to route mounts. Exposes all loop methods over HTTP.
- `packages/opencode/src/cli/cmd/tui/app.tsx` — registered slash commands: `/wave` (dashboard), `/wave-plan` (start a campaign), `/wave-next` / `/wave-run` / `/wave-pause` / `/wave-stop`. Footer pill on home: status + `/wave` shortcut.

### Keybinds

| Key       | Action                                                         |
| --------- | -------------------------------------------------------------- |
| `↑↓` `jk` | Navigate wave rows                                             |
| `↵`       | Open the selected row's session in chat                        |
| `r`       | Arm (or resume from paused)                                    |
| `space`   | Pause                                                          |
| `n`       | Manually spawn next                                            |
| `i`       | Interrupt active session and mark wave cancelled               |
| `s`       | Stop the loop                                                  |
| `c`       | Clear cancelled wave back to pending                           |
| `q`       | Dismiss awaiting_user without responding                       |
| `v`       | View NOTES.md for the selected wave                            |
| `f5`      | Manual refresh                                                 |
| `esc`     | Back to home                                                   |

### Bug fixes folded in

- Verifier-vs-executor disambiguation via `Session.get(id).agent === "wave_verify"` (no in-memory state, persists across TUI restart).
- Auto-commit-on-crash: executor session dies mid-write → loop runs `git add -A && git commit -m "wave N (crashed): ..."`, bumps retry_count, falls through to retry/escalate.
- `interrupt()` no longer mis-categorizes user cancellation as "plan needs fixing" — sets `failure_kind: cancelled`, leaves retry_count alone, requires explicit `c` to resume.
- Spawn paths refuse to spawn while `active_session_id` is set (prevents concurrent agents editing the plan).
- Verifier crash escalation caps `verify_count` so user retries don't loop the verifier into another crash forever.
- `executor_model` empty string falls back to `Provider.defaultModel()` (same resolver as fresh sessions: config `model` → most-recent → first available).
- Cursor highlight in dashboard is reactive (`createMemo`-driven, was static).
- Active campaign pointer uses real on-disk state — nothing in-memory.

### Tests

- `packages/opencode/test/wave/wave.test.ts` — Wave service against real fs (campaign list, active pointer, read/write/update, missing-campaign error).
- `packages/opencode/test/wave/state.test.ts` — parse/serialize round-trips, missing required key errors, table cell escaping.

### Demo fixture

- `script/wave-demo-fixture.ts` — materializes a dummy mid-flight campaign for VHS demos / manual TUI inspection.
- `wave-pill.tape`, `wave-dashboard.tape` — VHS recordings.

### Architecture notes

Three principles drove every decision:

1. **State on disk, not in memory.** Every recovery path goes through STATE.md re-read. No in-memory accumulators. A session can die at any point and the next session resumes from exact state.
2. **Always commit.** Success, failure, undoable, paused, crash — all produce git commits. Working tree always clean between sessions. Failure commits stay local. Audit trail in `git log`.
3. **Loop owns active state.** `active_session_id` and `active_session_kind` are loop-managed. Agents update outcome fields (`wave_status`, `failure_kind`, `retry_count`, `user_question`); loop manages session-tracking fields. Bug class: when agents touched `active_session_id`, settle handler saw mismatches and skipped auto-spawns.

## TUI: drafting-table redesign

`packages/opencode/src/cli/cmd/tui/...` (multiple files):

Lighter, more information-dense chrome — easier to read over mosh + tmux on smaller windows. Most of it is subtraction:

- Panels lose their backgrounds and become single-cell left rules.
- Message blocks lose their closing rules.
- Tool calls collapse to `label · target · meta` instead of labeled separator lines.
- Speaker identity moves to a `u·1` / `a·1` mark in the left margin.
- Sidebar gains a small live stats block (messages / tokens / cost / duration).
- Prompt has a state-aware `▎` accent and a two-row status (identity + ephemeral hints) with a small usage meter.

Logo replaced with a `slant`-figlet wordmark (`codemaxxxing` rendered single-line with kerning) plus a subtle ignition→idle animation. Prompt spinner is a turbo spool (two braille turbines + boost gauge) instead of the upstream V12.

OSC terminal title: `codemaxxxing` on home, `cmx | <session>` in sessions.

Footers: `codema(xxx)ing for clauseo` (sidebar), `by clauseo` (home).

## TUI render perf + freeze fixes

Several commits dug into TUI render path issues during long streaming responses:

- `581c33992 perf(tui): make streaming render path strictly faster than upstream` — reworked the per-message render to skip work for already-rendered parts.
- `bf03d6396 fix(tui+server): unblock session render past BlockTool children + finalize aborted assistants` — a BlockTool with deeply nested children was blocking the render past it; aborted assistant turns weren't being finalized. Fixed both.
- `23e0e84f6 fix(tui): unfreeze session render by replacing message flex-row with absolute marginalia` — flex-row layout on message bodies was triggering opentui yoga re-flow on every part update; replaced with absolute-positioned marginalia outside the flex tree.
- `c97d00eee fix(tui): unify message-body render order; redesign prompt indicator + context bar` — consolidated render order across message types.
- `796099fce feat(tui): state-encoded prompt indicator + breathing-room padding` — prompt's left accent encodes input/agent/loading state via color + character.
- `e3637c8c4 docs(tui): write up the render-freeze investigation so far` — `specs/tui-render-freeze.md` documents the diagnosis and fixes for future reference.
- `77dd69854 fix(tui): unfreeze user-message render by removing inner flex-row + word-wrap on body text` — same root cause class as the assistant-message fix, applied to user messages.
- `adb93813a fix(tui/logo): regenerate codemaxxxing wordmark with figlet -k kerning to stop xxx zone bleeding into adjacent letters` — italic lean was pushing the leftmost `x` into `a`'s columns. Regenerated with `figlet -f slant -k`.

## Provider + flag fixes

- `204288ea4 fix(provider/anthropic): strip rejected structured-outputs-2025-11-13 beta` — Anthropic API was rejecting requests with this beta header set; stripped it.
- `6294707f2 fix(flag): default codemaxxxing channel to effect-httpapi backend` — the new HTTP API backend is now default (was opt-in).

## Misc

- `4eac798ad feat(tui): convert HEIC/HEIF attachments to JPEG before send` — Apple Photos drops are HEIC by default; auto-convert before send.
- `6e19e13e1 Allowed it to use summarised thinking lol` — flipped the summarised-thinking flag for opus.
- `02c1f6238 chore: remove /commit slash command` — replaced by AGENTS.md commit guidance + git workflow in main agent prompts.

## Upstream sync

`50dfe0e0b fork: re-apply codemaxxxing patches after upstream sync` plus `0b0fe1b05 fork: replace OpenCode brand with codemaxxxing in TUI chrome` — re-apply after `96f34b1c9 Merge remote-tracking branch 'upstream/dev' into sync-attempt`. `7e385f0f2 chore(sync): drop redundant transform.ts opus-4.7 patch` — upstream picked up our patch, dropped the local one.

## File inventory diff vs the previous state

### New files

- `custom_agents/wave_verify.md`
- `packages/opencode/src/wave/wave.ts`
- `packages/opencode/src/wave/loop.ts`
- `packages/opencode/src/wave/state.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/wave.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/wave.ts`
- `packages/opencode/src/cli/cmd/tui/routes/wave/index.tsx`
- `packages/opencode/src/cli/cmd/tui/context/wave.tsx`
- `packages/opencode/test/wave/wave.test.ts`
- `packages/opencode/test/wave/state.test.ts`
- `script/wave-demo-fixture.ts`
- `wave-pill.tape`, `wave-dashboard.tape`
- `specs/tui-render-freeze.md`

### Renamed

- `custom_agents/wave_decompose.md` → `custom_agents/wave_plan.md` (also rewritten)

### Removed

- `.opencode/command/commit.md` — superseded by AGENTS.md commit guidance

### Modified

- `packages/opencode/src/cli/cmd/tui/app.tsx` — wave slash commands + footer pill + palette entries
- `packages/opencode/src/project/bootstrap.ts` — added `WaveLoop` to eager-init list
- `packages/opencode/src/cli/logo.ts` — figlet `slant -k` regeneration
- `packages/opencode/src/cli/cmd/tui/component/logo.tsx` — corresponding render update
- (TUI-wide) drafting-table redesign + render-freeze fixes spread across session route, sidebar, message components, prompt
- `packages/opencode/src/provider/anthropic.ts` — structured-outputs beta strip
- `packages/opencode/src/flag/flag.ts` (or wherever `OPENCODE_HTTPAPI_BACKEND` is read) — default flip
