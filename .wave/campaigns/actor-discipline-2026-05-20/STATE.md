# Wave State

## Status

```yaml
campaign_id: actor-discipline-2026-05-20
plan_source: inline (conversation thread; ADR-009 phases 1-3 + Anthropic AI Engineer talk orchestrator pattern)
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 1
wave_status: pending
failure_kind: ""
retry_count: 0
verify_count: 1
user_question: ""
loop_state: armed
active_session_id: ses_1bb7ad697ffepCG10H5HGsjNxr
active_session_kind: executor
total_waves: 10
session_count: 1
created: 2026-05-20
last_updated: 2026-05-20
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1bb7ad697ffepCG10H5HGsjNxr | TBD | Bootstrap: D5 extractor narrowing + safety net, D2 canonical-path injection, D3 self-close target optional, D9 already_terminated/path_invalid split. D6 root-hold deferred per WAVE.md §6 explicit allowance. INV-D-01..05, INV-D-07 green. Per-file 100% line coverage on control.ts/agent-close.ts/system.ts. |
| 1 | pending  | — | — | Prose: rewrite multi-agent-subagent.txt "Final answer" → "Delivery contract" (D1); add sibling-coordination + limits sections in multi-agent-root.txt (D7, D8); defer-edits in general/anthropic.txt, general/gemini.txt, explore.txt (D4); 4.7 literalism adaptation (D4). First orchestrated wave. |
| 2 | pending  | — | — | Validation: drive INV-D-01..08 to green. Reproduce ses_1c2e8d84affe... extractor failure and ses_1d84f236bffe... sibling deadlock end-to-end as regression tests. |
| 3 | pending  | — | — | Ask pattern (Phase 2A): correlation_id on send_message/followup_task; wait_for_reply variant on wait_agent; mandatory-timeout doctrine in prose. INV-D-09..11. |
| 4 | pending  | — | — | ABORT protocol (Phase 2B): structured ABORT prose for subagents; control.ts recognition + spawner notification with structured payload; generalize wave's set-phrase exits across all subagents. INV-D-12..14. |
| 5 | pending  | — | — | Supervision strategies (Phase 3A): on_failure + pool_strategy params on spawn_agent; loop-level recovery decisions. INV-D-15..17. |
| 6 | pending  | — | — | Spawn pool (Phase 3B): spawn_pool primitive + collect strategies (all/first/any_n). Permission key consults task. INV-D-18..20. |
| 7 | pending  | — | — | Lifecycle (Phase 3C): link/unlink for paired death; bounded mailboxes + backpressure. INV-D-21..23. |
| 8 | pending  | — | — | Behaviors (Phase 3D): declared per-agent_type behavior contracts + runtime validation harness. INV-D-24..26. |
| 9 | pending  | — | — | Observability + audit: D18 instrumentation (deliverable-arrival rate, safety-net firing rate, sibling-deadlock rate, subagent-tool-error rate); cross-wave NOTES.md audit for drift. Executor-solo. |
