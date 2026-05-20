# Wave State

## Status

```yaml
campaign_id: actor-discipline-2026-05-20
plan_source: inline (conversation thread; ADR-009 phases 1-3 + Anthropic AI Engineer talk orchestrator pattern)
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 7
wave_status: pending
failure_kind: ""
retry_count: 0
verify_count: 1
user_question: ""
loop_state: armed
active_session_id: ses_1bad425a0ffee9XS2fbYUNAC6d
active_session_kind: executor
total_waves: 10
session_count: 7
created: 2026-05-20
last_updated: 2026-05-20
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1bb7ad697ffepCG10H5HGsjNxr | bfe5e1db3 | Bootstrap: D5 extractor narrowing + safety net, D2 canonical-path injection, D3 self-close target optional, D9 already_terminated/path_invalid split. D6 root-hold deferred per WAVE.md §6 explicit allowance. INV-D-01..05, INV-D-07 green. Per-file 100% line coverage on control.ts/agent-close.ts/system.ts. |
| 1 | complete | ses_1bb62be9dffe9x2YUajNk80YsK | 1278d48be | Prose: D1 Delivery contract in multi-agent-subagent.txt; D7 Sibling coordination + D8 Limits in multi-agent-root.txt; D4 defer-edits in general/anthropic.txt, general/gemini.txt, explore.txt. New test/prose/subagent-prompts.test.ts (18 pass). INV-D-06 + INV-D-08 added to multi-agent-invariants.test.ts (23 pass / 0 fail). 6 tasks T1..T6 orchestrated via planner + per-task gen+eval pairs. 1 T5 pivot (negotiation stall → respawn with pre-agreed contract). All 59 CONTRACT criteria passed. |
| 2 | complete | ses_1bb496396ffeVoJ9Zbezn1sXkA | 4fda52548 | Validation: INV-D-01..08 + 2 regressions all green. T1 ABORT(spec_wrong) → orchestrator landed D5b two-pass extractor hardening inline (control.ts:820-859) + GOTCHAS entry. Reproduces ses_1c2e8d84affe + ses_1d84f236bffe Demo 2 end-to-end. 3 tasks orchestrated via planner + per-task gen+eval pairs. 29/29 contract criteria passed. Full multi-agent-invariants.test.ts: 25/0. Prose suite: 21/0. |
| 3 | complete | ses_1bb308ef6ffeA3UiI4m70jbr9i | 39ffe0e2f | Ask pattern (Phase 2A): correlation_id on send_message/followup_task + InterAgentCommunication schema; wait_for_reply variant on wait_agent (same file, second Tool.define); mandatory-timeout doctrine in multi-agent-root.txt + subagent mirror. INV-D-09..11 added (28/0 invariants total). 4 tasks orchestrated via planner + per-task gen+eval pairs. 1 T3 C6 orchestrator-adjudication (registry-wiring literal-grep too strict for established convention). 41/41 contract criteria passed. Inline coverage hardening: mailbox.peek + control.findMailboxByCorrelationId + wait_for_reply orphan tests. Per-file 100% line coverage on all modified files except pre-existing send_failed branch in agent-send.ts (not introduced by this wave). Prose suite: 27/0. |
| 4 | complete | ses_1bb04b0daffeSUR0CnF29k7wGI | 8c16cbc7d | ABORT protocol (Phase 2B): D11 schema (`abort_reason` optional struct on InterAgentCommunication); D11 runtime parser (`parseAbortReason` line-anchored regex at control.ts:221) + completion-watcher populates structured payload; D11 prose (`## ABORT` section with six reasons + format + last-line constraint in multi-agent-subagent.txt; brief refs in general/anthropic.txt, general/gemini.txt, explore.txt; ORCHESTRATOR_PROTOCOL.md cross-ref). INV-D-12..14 added (31/0 invariants total). New Wave 4 ABORT prose grep block (38/0 prose total). 4 tasks across attempts 1+2: T1+T2 from attempt 1 (crashed mid-orchestration; rolled forward); T3+T4 from attempt 2 (planner-skipped, pre-agreed contracts, 0 pivots). 38/38 contract criteria passed. Per-file 100% line coverage on inter-agent-communication.ts (100%) and control.ts (100% lines; 94.78% functions = pre-existing Schema.TaggedErrorClass gap per GOTCHA). GOTCHAS entry `agentcontrol-d11-abort-line-parser-last-line-only` registered. |
| 5 | complete | ses_1baf41a10ffeZ422LtQm8VsmkF | 209ce3e63 | Supervision strategies (Phase 3A): D12 control.ts runtime (OnFailureStrategy/PoolStrategy types + SpawnAgentInput extension + PerRootData 4 new maps + spawnAgent policy storage + completion-watcher respawn/ignore/cap-exceeded/escalate dispatch + 6 D12 it.live tests). D12 agent-spawn.ts tool (Schema.optional+Union+Literal for 4+3 enums + execute passthrough + 9 it.live tests). INV-D-15..17 integration invariants + `## Supervision strategies (D12)` section in agent-spawn.txt. 3 tasks T1+T2+T3 orchestrated via pre-agreed-contracts + per-task gen+eval pairs; 0 pivots. T1 evaluator self-closed mid-grade (C1-C7 only) → orchestrator inline-adjudicated C8-C12 + 2 recipe-shape adjustments per Wave 4 T2 precedent. T2 + T3 evaluators stayed alive through all criteria (explicit "STAY ALIVE" reminder in spawn message). 31/31 CONTRACT criteria passed. multi-agent-invariants: 34/0 (was 31). |
| 6 | complete | ses_1bad425a0ffee9XS2fbYUNAC6d | 991721ef6 | Spawn pool (Phase 3B): D13 control.ts pool primitives (CreatePoolInput/CreatePoolResult/PoolMemberFailure/PoolDeliverable interfaces + CollectStrategy + PerRootData.poolMembers/poolOf + createPool/collectPool/listPoolMembers/closePoolMembers methods + 17 D13 it.live tests). D13 NEW tool dir packages/opencode/src/tool/agent-pool/ (agent-pool.ts 278 lines + agent-pool.txt 109 lines + agent-pool.test.ts 698 lines, 21 tests, 100/100 coverage). D13 wiring: MULTI_AGENT_TOOLS 7→8 (added spawn_pool); registry.ts import+Tool.init+builtin+legacy-bridge; multi-agent-root.txt "Routers and pools" subsection. INV-D-18..20 integration invariants (multi-agent-invariants.test.ts: 34→37). 4 tasks T1-T4 orchestrated via pre-agreed-contracts + per-task gen+eval pairs; 0 pivots. 47/47 CONTRACT criteria passed (T1: 12; T2: 12; T3: 12; T4: 11). 2 inline-adjudications on C10 recipes (T1: column-extraction bug; T3: pre-existing baseline structurally <100%) — both follow Wave 4/5 Schema.TaggedErrorClass precedent. |
| 7 | pending  | — | — | Lifecycle (Phase 3C): link/unlink for paired death; bounded mailboxes + backpressure. INV-D-21..23. |
| 8 | pending  | — | — | Behaviors (Phase 3D): declared per-agent_type behavior contracts + runtime validation harness. INV-D-24..26. |
| 9 | pending  | — | — | Observability + audit: D18 instrumentation (deliverable-arrival rate, safety-net firing rate, sibling-deadlock rate, subagent-tool-error rate); cross-wave NOTES.md audit for drift. Executor-solo. |
