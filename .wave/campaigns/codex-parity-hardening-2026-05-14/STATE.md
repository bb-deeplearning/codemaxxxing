# Wave State

## Status

```yaml
campaign_id: codex-parity-hardening-2026-05-14
plan_source: inline-prompt
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
active_session_id: ses_1dab5d497ffeqTcXWqL9ALEVZV
active_session_kind: executor
total_waves: 6
session_count: 1
created: 2026-05-14
last_updated: 2026-05-14
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1dab5d497ffeqTcXWqL9ALEVZV | 18932fbcd | scaffold + bug-3 audit (B+X applied: enum-scoped regex + agent_type fixes); 2 new GOTCHAS |
| 1 | pending  | — | — | bug 1 — per-root scoping in AgentControl (TDD-first, 3 multi-root invariants) |
| 2 | pending  | — | — | bug 2 — completion watcher (TDD-first, 3 completion invariants) |
| 3 | pending  | — | — | audit pass — apply remaining invariants (cascade, drain-under-concurrent-sends, pty-cleanup) |
| 4 | pending  | — | — | backward compat verification + perf audit + final report |
| 5 | pending  | — | — | spec doc at specs/codex-parity-hardening.md |
