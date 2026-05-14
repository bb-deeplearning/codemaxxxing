# Wave State

## Status

```yaml
campaign_id: codex-parity-hardening-2026-05-14
plan_source: inline-prompt
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 0
wave_status: awaiting_user
failure_kind: ""
retry_count: 0
verify_count: 1
user_question: "wave 0 spec test 1 regex matches prose (bug-3 audit cannot pass) + 21 pre-existing typecheck errors block 'zero errors' verification — see NOTES.md for 3+3 options"
loop_state: armed
active_session_id: ses_1dab5d497ffeqTcXWqL9ALEVZV
active_session_kind: executor
total_waves: 6
session_count: 0
created: 2026-05-14
last_updated: 2026-05-14
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | paused   | ses_1dab5d497ffeqTcXWqL9ALEVZV | — | see user_question (regex/prose conflict + 21 pre-existing typecheck errors); NOTES.md attempt 1 |
| 1 | pending  | — | — | bug 1 — per-root scoping in AgentControl (TDD-first, 3 multi-root invariants) |
| 2 | pending  | — | — | bug 2 — completion watcher (TDD-first, 3 completion invariants) |
| 3 | pending  | — | — | audit pass — apply remaining invariants (cascade, drain-under-concurrent-sends, pty-cleanup) |
| 4 | pending  | — | — | backward compat verification + perf audit + final report |
| 5 | pending  | — | — | spec doc at specs/codex-parity-hardening.md |
