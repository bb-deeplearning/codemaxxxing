# Wave 7 — Notes

## Attempt 1 — success (WAVE COMPLETE)

**Session:** ses_1baa634f8ffekzzWm8TzMpfknn
**Settle commit:** 3347ac552
**Date:** 2026-05-20
**Decision on entry:** first attempt
**Orchestration:** pre-agreed contracts (PLAN.json + CONTRACT.json drafted by /root before subagent dispatch) + sequential T1 → parallel T2+T3 → sequential T4 gen+eval pairs. 0 pivots.

## Pattern: pre-agreed-contract + T2/T3 parallelization

Wave 5/6 NOTES.md established the pre-agreed-contract pattern (orchestrator drafts CONTRACT.json criteria with deterministic verify recipes; gen+eval skip negotiation, run straight to build+grade). Wave 7 attempt 1 applied this end-to-end AND added Wave 6's first true cross-task parallelization: T2 and T3 have disjoint write sets (T2 → agent-link/ + permission + registry; T3 → agent-send/ + agent-followup/) AND both depend only on T1. After T1 landed, T2 and T3 ran 4 subagents concurrently (gen+eval × 2). Net effect: wall-clock saving of one full task cycle; 0 pivots across 8 subagent sessions for T2+T3+T4.

## Orchestration trace

| Subagent | Path | Role | Outcome | Commits | Pivots |
|---|---|---|---|---|---|
| linnaeus | `/root/t1_gen` | generator | WAVE TASK DONE (T1 control.ts + mailbox.ts foundation) | ebfaaf30b | 0 |
| lovelace | `/root/t1_eval` | evaluator | WAVE TASK GREEN 14/14 | 7cf330ec0 (contract) | 0 |
| pasteur | `/root/t2_gen` | generator | WAVE TASK DONE (T2 agent-link tool + wiring) | 1d5006b70 | 0 |
| noether | `/root/t2_eval` | evaluator | WAVE TASK GREEN 13/13 | 69164d539 (contract) | 0 |
| ramanujan | `/root/t3_gen` | generator | WAVE TASK DONE (T3 agent-send/followup mailbox_full) | fb835c3a4 | 0 |
| newton | `/root/t3_eval` | evaluator | WAVE TASK GREEN 9/9 | e23178d3b (contract) | 0 |
| euler | `/root/t4_gen` | generator | WAVE TASK DONE (T4 INV-D-21..23 + prose) | 59ae09523 | 0 |
| bohr | `/root/t4_eval` | evaluator | WAVE TASK GREEN 11/11 | 8f38777d0 (contract) | 0 |

## Verification results (orchestrator-run at settle)

| Surface | Result |
|---|---|
| `bun typecheck` | exit 0 (tsgo --noEmit clean) |
| `bun lint` (repo root, oxlint) | 0 errors / 3147 pre-existing warnings |
| `bun test src/agent/mailbox.test.ts src/agent/control.test.ts src/tool/agent-link/agent-link.test.ts src/tool/agent-send/agent-send.test.ts src/tool/agent-followup/agent-followup.test.ts src/permission/disabled.test.ts src/tool/registry.test.ts` | 213 pass / 0 fail / 588 expects in 9.32s |
| `bun test --coverage src/agent/mailbox.test.ts` → mailbox.ts | 95.65% functions / 100.00% lines (function% gap = Schema.TaggedErrorClass GOTCHA, MailboxFullError class) |
| `bun test --coverage src/agent/control.test.ts` → control.ts | 93.15% functions / 100.00% lines (function% gap = pre-existing Schema.TaggedErrorClass GOTCHA) |
| `bun test --coverage src/tool/agent-link/agent-link.test.ts` → agent-link.ts | 100.00% functions / 100.00% lines |
| `bun test --coverage src/tool/agent-send/agent-send.test.ts` → agent-send.ts | 100.00% functions / 100.00% lines |
| `bun test --coverage src/tool/agent-followup/agent-followup.test.ts` → agent-followup.ts | 100.00% functions / 100.00% lines |
| `bun test ./test/integration/multi-agent-invariants.test.ts` | 40 pass / 0 fail / 201 expects (was 37; +3 for INV-D-21/22/23) |
| `bun test ./test/prose/subagent-prompts.test.ts` | 48 pass / 0 fail / 48 expects |
| `bun test -t 'INV-D-21'` | 1 pass / 39 filtered / 0 fail / 10 expects |
| `bun test -t 'INV-D-22'` | 1 pass / 39 filtered / 0 fail / 10 expects |
| `bun test -t 'INV-D-23'` | 1 pass / 39 filtered / 0 fail / 3 expects |
| PLAN.json + CONTRACT.json artefacts | present at `waves/wave_7/` |
| CONTRACT.json totals | T1: 14/14 signed at ebfaaf30b; T2: 13/13 signed at 1d5006b70; T3: 9/9 signed at fb835c3a4; T4: 11/11 signed at 59ae09523 |

## What shipped (Wave 7 — Phase 3C: lifecycle primitives)

- **T1 — control.ts + mailbox.ts foundation (ebfaaf30b):**
  - **D15 mailbox.ts bounded queue:** `MAILBOX_DEFAULT_CAPACITY = 32` top-level const exported. `MailboxFullError extends Schema.TaggedErrorClass` with `capacity: Schema.Number` field. `Mailbox.make(capacity?: number)` accepts optional capacity (defaults to 32). `Interface.send` returns `Effect<number, MailboxFullError>` — atomically checks `messages.length >= capacity` before enqueue. `Interface.sendSystem` returns `Effect<number>` — bypasses cap (system-notification slot per WAVE.md gotcha 5 option (a), implemented as same queue with bypass-flag semantics).
  - **D14 control.ts link primitives:** `PerRootData` gains `links: Map<SessionID, Set<SessionID>>` (symmetric, entry on both peers' Sets) + `linkedDeathOf: Set<SessionID>` (marks sessions closed by link cascade so completion-watcher overrides label). Both initialized in `ensureRootSlot`; cleared in BOTH the Session.Event.Deleted subscriber AND the disposal finalizer. New Interface methods: `linkAgents(a, b, callerID)` (per-root scoped via slotFor; cross-root → AgentNotFoundError; self-link → no-op; idempotent), `unlinkAgents(a, b, callerID)` (idempotent, no error on unlinked pair), `agentLinks(id, callerID)` (returns sorted SessionID[] of peers).
  - **D15 sendInterAgentCommunication mailbox-full propagation:** signature extended with `flags?: { system?: boolean }`. When `flags?.system === true` → routes to `mailbox.sendSystem` (bypasses cap); otherwise → `mailbox.send` returns Effect<void, AgentNotFoundError | MailboxFullError>. Internal callers (completion-watcher main send + respawn-cap branch + spawnAgent seed message) ALL opt into `system: true` so notifications survive backpressure.
  - **D14 linked-death cascade in completion-watcher:** when child reaches terminal NON-shutdown (errored OR completed), iterates `slot.links.get(child.id)`, marks each peer in `linkedDeathOf`, calls `closeAgent(peer, child.id)`. Watcher's `label` is overridden to `"linked_death"` when `isShutdown=true AND slot.linkedDeathOf.has(child.id)` — the peer's notification body header reads "reached status: linked_death" instead of "reached status: shutdown".
  - **Tests:** D14 describe block in control.test.ts (8 it.live tests: link/unlink basic, symmetry, idempotent, cross-root rejection, agentLinks empty, cascade on errored, cascade on completed, unlink-before-crash → no cascade). D15 describe block in control.test.ts (4 it.live tests: send fails MailboxFullError at cap; system bypasses; drain frees cap; completion-watcher uses system path). New tests in mailbox.test.ts for capacity + sendSystem (4+ tests). Full mailbox.test.ts + control.test.ts: 149 pass / 0 fail.
- **T2 — agent-link tool (1d5006b70):**
  - **D14 agent-link/agent-link.ts:** TWO exported Tool.define values mirroring agent-wait.ts precedent. `LINK_ID = "link_agents" as const`, `UNLINK_ID = "unlink_agents" as const`, `PermissionKey = "task" as const`. Parameters Schema.Struct({ target_a: required String, target_b: required String }). Execute body for LinkAgentsTool: resolve both targets via `control.resolveAgentReference`, branch on target_not_found; reject self-link (`tag = "self_link"`); ctx.ask permission; call `control.linkAgents` wrapped in Effect.result; on AgentNotFoundError → `tag = "cross_root"`; success → `{ linked: true }`. UnlinkAgentsTool mirrors EXCEPT no self-link rejection (no-op anyway), calls `control.unlinkAgents`, success → `{ unlinked: true }`.
  - **D14 agent-link.txt:** Codex-quality description in codemaxxxing voice, both tools documented in one file with ## sections; >=60 lines covering when-to-use / when-not / linking-semantics (symmetric + idempotent) / cross-root / unlinking / cost.
  - **D14 agent-link.test.ts:** 14 it.live/it.instance tests covering ID/PermissionKey, Schema decode happy/failure, link happy path, self-link rejection, cross-root rejection, ctx.ask invoked, target_not_found for both targets, unlink happy path, unlink-on-unlinked no-op, unlink cross-root, unlink target_not_found. Real AgentControl; no mocks.
  - **D14 wiring:** `MULTI_AGENT_TOOLS` 8→10 (added "link_agents" + "unlink_agents" after "spawn_pool"); permission/disabled.test.ts extended with both new IDs in canonical-order + wildcard-deny tests; tool/registry.ts imports LinkAgentsTool + UnlinkAgentsTool, adds tool.linkagents + tool.unlinkagents, extends legacy-bridge OR chain.
- **T3 — agent-send + agent-followup mailbox_full handling (fb835c3a4):**
  - **D15 agent-send.ts:** existing Effect.result branch extended; when failure tag is "MailboxFullError" → `{ metadata: { target, target_session_id, error: "mailbox_full", retry_after_ms: 250 }, output: "Mailbox full for ${target}; retry after ~250ms or use followup_task to wake recipient to drain" }`. AgentNotFoundError path preserved as `error: "send_failed"`.
  - **D15 agent-followup.ts:** `.pipe(Effect.orDie)` REPLACED with `Effect.result`; MailboxFullError → mailbox_full shape (wording adjusted: "followup_task does NOT bypass backpressure"); AgentNotFoundError → "send_failed" (now reachable, defensive surface).
  - **D15 tests:** agent-send.test.ts gains 3 tests (mailbox_full end-to-end, queued=true regression, target_not_found regression). agent-followup.test.ts gains 3 tests (mailbox_full, root_target regression, queued=true). Both .ts files: 100% line coverage. 30 pass / 0 fail / 97 expect() calls. Tests use `mailbox_capacity` override on spawnAgent (the T1 surface for per-spawn capacity).
- **T4 — INV-D-21..23 invariants + bounded-mailbox prose (59ae09523):**
  - **INV-D-21-link-paired-death-on-either-crash:** spawn /root/peer_a + /root/peer_b; linkAgents; crash one via Effect.die in its runLoop; within 500ms peer's status transitions to shutdown AND parent's mailbox notification carries header "reached status: linked_death". Symmetric + unlink-before-crash variants.
  - **INV-D-22-bounded-mailbox-rejects-on-overflow:** spawn root + child at small mailbox cap (test override); send N+1 calls; (N+1)th returns Effect.result failure with MailboxFullError; drain frees cap; recovery works.
  - **INV-D-23-bounded-mailbox-does-not-block-completion-notification:** parent mailbox set to near-cap; child terminates; completion notification arrives despite backpressure (system path bypass verified end-to-end).
  - **multi-agent-root.txt:** new bullet in `## Limits` section about bounded mailboxes + backpressure + completion-notification bypass.
  - **multi-agent-subagent.txt:** new paragraph after `wait_for_reply` bullet about mailbox_full handling (retry with backoff; followup_task to wake).
  - **prose/subagent-prompts.test.ts:** extended with assertions on the new prose AND on agent-link.txt presence + link-related substrings.

## Observations for future waves

- **Pre-agreed-contract pattern at scale.** Wave 4 attempt 2 introduced it; Waves 5, 6, 7 used it end-to-end. Net: 0 pivots across 28 subagent sessions for T1-T4 in Wave 7 — every task one commit-grade cycle. Recommendation: continue for Wave 8.
- **Cross-task parallelization works.** T2 + T3 ran 4 subagents concurrently after T1 landed. Disjoint writes are the precondition — easy to verify from PLAN.json's `writes` arrays. Recommendation: Wave 8 should parallelize wherever T-dependencies allow.
- **STAY ALIVE doctrine continues to prevent premature self-close.** All 4 evaluators stayed alive through all criteria. No mid-grade self-close incidents. The explicit "STAY ALIVE until WAVE TASK GREEN AND orchestrator acknowledges" instruction in every evaluator spawn message is essential.
- **Recipe-shape adjustments documented per criterion.** T4 evaluator inline-adjudicated C2/C3 (awk range-start matched preceding comment line — re-verified via sed-line-range grep) and C11 (--stat=200 adjustment per T3 precedent). All adjustments preserved the assertion's intent.
- **Schema.TaggedErrorClass function% drift propagated to mailbox.ts.** Adding `MailboxFullError extends Schema.TaggedErrorClass` to mailbox.ts pulls mailbox.ts from 100% funcs into 95.65% funcs (still 100% lines). Documented in T1 evidence; covered by existing GOTCHA `schema-class-function-coverage`. No new GOTCHA needed.
- **No new GOTCHAs discovered.** Existing entries covered everything: `agentcontrol-providerref-must-live-in-layer-not-instancestate` (per-root slot pattern for the 2 new link maps), `schema-class-function-coverage` (the funcs% gaps on both mailbox.ts and control.ts), `bun-test-coverage-source-file-arg-runs-zero-tests` + `bun-coverage-aggregation-flake` (single-file coverage discipline), `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` (link_agents + unlink_agents collapse onto "task").
- **Total Wave 7 contract criteria: 47/47 passed.** T1: 14; T2: 13; T3: 9; T4: 11. Comparable to Wave 6's 47/47 across 4 tasks.
