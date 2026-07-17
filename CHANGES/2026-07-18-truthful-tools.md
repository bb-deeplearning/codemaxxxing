# Changes: Truthful tools — terminal contract fixes + agent forensics + harness flow redesign

**Date**: 2026-07-18

Field-driven fix batch. A primary-source bug report from a long dogfooding session (plus live reproduction in-session) showed that both fork-built tool surfaces systematically LIE about state: exec_command reported exited processes as running, write_stdin blamed tty configuration for dead processes, killed agents vanished from the registry without a trace, and `max_output_tokens` was a dead parameter in both process tools. Root theme: every lie forces the model into a defensive extra call, and those compound into the short-turn polling posture that defeats the point of the multi-agent surface.

Three batches landed. Batch 4 (design-level: abort blast radius, root-wake, `detach`, spawn attachments, `wait_for_reply` drain race, reasoning-only-turn guard) is deliberately deferred pending design discussion.

## Batch 4 — harness flow redesign (landed same day after design discussion)

All six Batch 4 items were greenlit and shipped:

- **B4-1 — esc no longer kills the tree.** `SessionPrompt.cancel` (prompt.ts) stopped calling `cancelChildrenOf`; a user abort cancels the FOREGROUND turn only. Children keep running and a `reportSurvivorsOf` system note ("Turn aborted. N agent(s) still running, unaffected…") lands in the parent's mailbox — deliberately via `sendSystem`, NOT the root-wake path, so an abort never spins up a fresh turn. `cancelChildrenOf` remains as the explicit kill-tree primitive (INV-D-29 still covers it); the tree dies only with the instance, session deletion, or explicit closes. Test rewritten: `test/session/prompt.test.ts` "cancel leaves v2 children running and posts a survivors report".
- **B4-2 — root auto-wake on mailbox activity.** The single guard that excluded root from revival (`targetID !== slot.rootID`) gets a root-side counterpart: any root-targeted message invokes a `registerRootWake` callback registered by SessionPrompt, which enters via `ensureRunning` (BusyError → clean no-op; the in-flight turn's per-step drain picks the message up). Additionally the runLoop exit path defers exit for ROOT sessions when ANY mail is pending (`hasPendingMail`), so deliverables landing on a turn's final step produce another step. Result: idle roots integrate child results unattended — first finisher wakes root while siblings keep working. Escape hatch: `OPENCODE_ROOT_WAKE=0`.
- **B4-3 — `detach: true` + pid journal.** exec_command gains a daemon path: `node:child_process` spawn with `detached: true` (own session, no controlling terminal — structurally immune to the leader-exit SIGHUP that killed `&` children and raced `nohup`), stdout/stderr to `<data>/detached-logs/<ts>-<cmd>.log`, pid recorded in `<data>/detached-processes.json`. Bootstrap reconciles the journal on startup (drops dead pids) and logs surviving orphans for the current project — force-quit no longer produces invisible zombie dev servers.
- **B4-4 — `files` param on spawn_agent.** Paths are read at spawn time (Bun.file, instance-relative, head/tail-elided per file) and appended to the child's first message as `[attached file: …]` fenced blocks. `fork_turns: "none" + files: [...]` is the new cheap-precise delegation default; unreadable paths fail the spawn (`files_unreadable`) instead of silently under-informing the child.
- **B4-5 — `wait_for_reply` drain-race fix.** `drainMailbox` records drained correlation ids per session (FIFO ring, 64); `wait_for_reply` consults `wasCorrelationDrained` before waiting and returns `already_delivered: true` ("check the [from ...] messages above") instead of the guaranteed false timeout.
- **B4-6 — reasoning-only-turn guard.** The runLoop exit path detects a finished turn whose final assistant message has reasoning but zero visible text and zero tool calls (the "returned thinking and it died" stall, observed 3× on 2026-07-17/18). Recovery: one synthetic `[system recovery]` user turn (anchored: names the last tool call, forbids apology/recap, demands a concrete action); a second consecutive stall attaches a visible ⚠️ notice to the dead message and stops. `agent.metric.reasoning_only_turn` bus event fires either way (`recovered`, `attempt`).

New invariants: INV-D-32 (abort leaves children running + survivors note), INV-D-33 (root-targeted send invokes root-wake; child-targeted does not), INV-D-34 (post-drain wait_for_reply answers already_delivered). Docs updated: `exec-command.txt` (detach), `agent-spawn.txt` (files), `wait-for-reply.txt` (already_delivered). Second pre-existing failure found via stash-check and NOT touched: `test/session/compaction.test.ts` "falls back to full summary when retained tail media exceeds preserve token budget".

## Batch 1 — truthful terminal

- **`Pty.read` is now a collect-until-deadline loop** (`src/pty/index.ts`). The old single race returned on the FIRST byte past the cursor, so any command that produced output before exiting was reported "running" with no exit_code (`pwd` at 0.028s, `seq 1 3000; exit 7` under a 30s yield) and bursts truncated mid-stream (841/3000 lines). The dead grace constants from the codex port (`TRAILING_OUTPUT_GRACE_MS` — declared Wave 2, referenced nowhere) are now wired: exit wins the race after a trailing-output grace so fast commands return complete output AND exit code in one call. `Active.exitedAt` gates the grace to freshly-exited processes; `idleMs <= 0` degrades to a pure drain (range re-reads).
- **`exec_command` clamps `yield_time_ms`** ([250, 30000]) as always documented; previously only write_stdin clamped.
- **Dead-process writes report the death, not a tty problem** (`write-stdin.ts`). Old: input to an exited session returned "stdin is closed; rerun exec_command with tty=true" — wrong diagnosis AND remedy. New: "Input not delivered: process had already exited." plus a drain and the exit_code (`input_not_delivered: true` in metadata).

## Batch 2 — honest output

- **`max_output_tokens` actually works** (both tools). It was declared in both schemas and read by neither; `DEFAULT_MAX_OUTPUT_TOKENS` was exported and unused. Now: head/tail byte-budget truncation with an explicit `…[elided ~N bytes of output; re-read with since_cursor to recover]…` marker and `omitted_bytes` metadata (`truncateHeadTail` in constants.ts).
- **`since_cursor` range re-reads on write_stdin.** Non-destructive (live cursor untouched), immediate (no yield wait, no clamp floor), targeting any retained byte range — the recovery path for elided middles that previously required re-running commands. `cursor_start`/`cursor_end` now ride in every response's metadata.
- **Sessions survive exit.** Reporting an exit no longer deletes the ProcessSessions entry; exited sessions stay drainable/range-readable (idempotent repeat polls) until the LRU pruner or `Pty.Event.Deleted` reclaims them. `formatExecResponse` says so: "Session ID N (exited; buffer retained for since_cursor re-reads until pruned)". `session_id` is now always present; `exit_code` presence is the aliveness discriminator.
- **`strip_ansi` opt-in param** (both tools). `tty: false` still allocates a real PTY (spawn path is PTY-only), so programs always see isatty=true and emit spinner/SGR noise regardless of the `TERM=dumb` env overlay — the stripper cleans the model-visible capture; raw bytes stay in the buffer.

## Batch 3 — agent forensics

- **Registry tombstones with cause** (`src/agent/control.ts`). `shutdownOne` used to delete the registry entry outright, so killed/closed agents were ABSENT from `list_agents` (the docs promised a `shutdown` status that could never be observed; live repro: a user interrupt killed a running explorer and `list_agents` showed only `/root`). Now every release writes an `AgentTombstone` (per-root, FIFO-capped at 32) and `listAgents` appends them: status `shutdown`, `cause` (`closed` / `killed_by_user_abort` / `linked_death`), `previous_status` (running = killed mid-flight), and the victim's `last_task_message`. `closeAgent` threads an optional cause; `linkedDeathOf` wins over the supplied cause.
- **Killed-mid-flight report on abort.** `cancelChildrenOf` (the `SessionPrompt.cancel` → user-abort cascade) suppresses per-child completion notifications by design; it now posts ONE consolidated system note (`sendSystem`, bypasses the mailbox cap) to the parent: "⚠️ User abort killed N in-flight agent(s):" with per-victim path + pre-death status. The parent's next turn starts with the casualty list instead of discovering corpses.
- **Completion notifications carry the child's session id.** `[child session: <id> — transcript retained on disk]` appended after the body (child Sessions are never deleted by close/abort — confirmed no `Session.remove` in any teardown path). Parents can audit the real transcript instead of trusting the child's self-reported summary (observed failure: child claimed 59 issues, file had 60). Appended AFTER the body so the TUI `STATUS_HEADER_RE` and the pool-collect filter (both key on the header line) are unaffected.

## Doc updates

`exec-command.txt` / `write-stdin.txt` rewritten to the new contracts (return shapes, exit discriminator, range-read + elision-recovery patterns, daemonization matrix: plain `&` dies at leader exit via kernel SIGHUP, `nohup` races leader lifetime, `disown` in a held tty session survives even opencode restarts). `agent-list.txt` documents tombstones.

## Tests

- `src/tool/process/*`: 87 pass (new: elision marker, strip_ansi e2e + unit, range re-read, dead-input truth, post-exit retention idempotency; updated: exit-keeps-session_id contract).
- `src/agent/control.test.ts` + `src/tool/agent-close` + `agent-list`: 192 pass (7 vanish-contract assertions updated to tombstones).
- `test/integration/multi-agent-invariants.test.ts`: 48 pass — new `INV-D-29-user-abort-tombstones-victims-and-reports-them`, `INV-D-30-closed-agent-tombstones-with-cause-closed`, `INV-D-31-completion-notification-carries-child-session-id`; `multi-root-isolation` extended to assert tombstones are per-root.
- `bun typecheck` clean.
- **Pre-existing failure (NOT this change, verified via stash):** `tool-surface-replacement.test.ts > model-tool-list-snapshot-matches-post-Wave-4-shape` — the frozen May-15 baseline predates the `github-pr-search`/`github-triage` builtins; the test rejects any post-baseline builtin by design.

## Diagnostic session evidence (harness bugs found, not yet fixed)

Logged for Batch 4 design work:

1. **Reasoning-only terminal turns.** Twice in one session the model emitted a thinking block and the stream ended with no text/tool calls; the runLoop accepted it as a clean turn end (no log ERROR, normal token accounting). Guard belongs at `session/prompt.ts:1560-1565` / `:1802` (`finished` computation): a final assistant step with reasoning but zero text AND zero tool calls should trigger a capped synthetic continue + visible warning.
2. **`wait_for_reply` drain race.** A correlated reply that arrives before `wait_for_reply` is called gets drained at the turn boundary and can never match — guaranteed timeout (live-confirmed with probe-cid-42). Correlation matching needs a same-turn drained-history index.
3. **Edit-tool non-exact match.** An `edit` call whose oldString did NOT exist verbatim was applied anyway via partial match, leaving a duplicated stale block (caught by immediate re-read). Exact-match contract needs enforcement or the fuzzy path needs a diff-echo.
