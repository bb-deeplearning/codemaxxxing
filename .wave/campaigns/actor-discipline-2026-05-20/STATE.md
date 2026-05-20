# Wave State

## Status

```yaml
campaign_id: actor-discipline-2026-05-20
plan_source: inline (conversation thread; ADR-009 phases 1-3 + Anthropic AI Engineer talk orchestrator pattern)
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 2
wave_status: pending
failure_kind: ""
retry_count: 0
verify_count: 1
user_question: ""
loop_state: armed
active_session_id: ses_1bb62be9dffe9x2YUajNk80YsK
active_session_kind: executor
total_waves: 10
session_count: 2
created: 2026-05-20
last_updated: 2026-05-20
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1bb7ad697ffepCG10H5HGsjNxr | bfe5e1db3 | Bootstrap: D5 extractor narrowing + safety net, D2 canonical-path injection, D3 self-close target optional, D9 already_terminated/path_invalid split. D6 root-hold deferred per WAVE.md §6 explicit allowance. INV-D-01..05, INV-D-07 green. Per-file 100% line coverage on control.ts/agent-close.ts/system.ts. |
| 1 | complete | ses_1bb62be9dffe9x2YUajNk80YsK | 1278d48be | Prose: D1 Delivery contract in multi-agent-subagent.txt; D7 Sibling coordination + D8 Limits in multi-agent-root.txt; D4 defer-edits in general/anthropic.txt, general/gemini.txt, explore.txt. New test/prose/subagent-prompts.test.ts (18 pass). INV-D-06 + INV-D-08 added to multi-agent-invariants.test.ts (23 pass / 0 fail). 6 tasks T1..T6 orchestrated via planner + per-task gen+eval pairs. 1 T5 pivot (negotiation stall → respawn with pre-agreed contract). All 59 CONTRACT criteria passed. |
| 2 | pending  | — | — | Validation: drive INV-D-01..08 to green. Reproduce ses_1c2e8d84affe... extractor failure and ses_1d84f236bffe... sibling deadlock end-to-end as regression tests. |
| 3 | pending  | — | — | Ask pattern (Phase 2A): correlation_id on send_message/followup_task; wait_for_reply variant on wait_agent; mandatory-timeout doctrine in prose. INV-D-09..11. |
| 4 | pending  | — | — | ABORT protocol (Phase 2B): structured ABORT prose for subagents; control.ts recognition + spawner notification with structured payload; generalize wave's set-phrase exits across all subagents. INV-D-12..14. |
| 5 | pending  | — | — | Supervision strategies (Phase 3A): on_failure + pool_strategy params on spawn_agent; loop-level recovery decisions. INV-D-15..17. |
| 6 | pending  | — | — | Spawn pool (Phase 3B): spawn_pool primitive + collect strategies (all/first/any_n). Permission key consults task. INV-D-18..20. |
| 7 | pending  | — | — | Lifecycle (Phase 3C): link/unlink for paired death; bounded mailboxes + backpressure. INV-D-21..23. |
| 8 | pending  | — | — | Behaviors (Phase 3D): declared per-agent_type behavior contracts + runtime validation harness. INV-D-24..26. |
| 9 | pending  | — | — | Observability + audit: D18 instrumentation (deliverable-arrival rate, safety-net firing rate, sibling-deadlock rate, subagent-tool-error rate); cross-wave NOTES.md audit for drift. Executor-solo. |
