# Wave State

## Status

```yaml
campaign_id: codex-parity-2026-05-13
plan_source: specs/codex-parity-handoff.html
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
active_session_id: ses_1dd2597d1ffejgt1r5DVLW37j2
active_session_kind: executor
total_waves: 16
session_count: 7
created: 2026-05-13
last_updated: 2026-05-13
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1ddf0b362ffeqjfZEjlxQOOWzM | ac1aaa03a | test infra + perf baseline + LLM stub captured (11 metrics) |
| 1 | complete | ses_1ddcdc9e6ffei2VYQ076XlTdj5 | 8e85ac82c | head/tail buffer port: 22 tests, 100% line+branch coverage, perf 0.64x baseline |
| 2 | complete | ses_1ddbb2c9cffeFED7lzFG4z84J5 | 5112fa9df | Pty.Service extensions: read race + LRU + origin + terminateAll, 38 tests, 99% coverage (only win32 branch uncovered), no perf regression |
| 3 | complete | ses_1dd96575affeZ6JNxe9M4bVoak | 47a506e14 | exec_command + write_stdin tools: 76 tests across schema/behavior/integration, ~99% line coverage on touched files, codex-quality prompts |
| 4 | complete | ses_1dd52940effeiPrvcnsgnW511R | f24c48713 | Process + ProcessWriteStdin TUI renderers: 22 tests, 100% line coverage, perf within budget (best-of-3 to suppress opentui render noise) |
| 5 | complete | ses_1dd3497d0ffec4zjYC3huPH7Ov | 1d93e7eef | Mailbox + AgentPath + InterAgentCommunication: 68 tests, 100% line coverage on all three files, p99 wakeup ~193µs (PERF.md target: 5ms) |
| 6 | complete | ses_1dd2597d1ffejgt1r5DVLW37j2 | — | Agent registry + metadata + nickname pool: 70 tests, 100% line coverage on all three files, perf p99 reserveSpawnSlot.then.commit ~29µs / agentIdForPath.lookup ~7.5µs / liveAgents.snapshot ~11µs |
| 7 | pending  | — | — | AgentControl service (spawn/send/close/list) |
| 8 | pending  | — | — | Six multi-agent v2 tools (parallel sub-agents) |
| 9 | pending  | — | — | runLoop integration (dispatch swap + mailbox drain) |
| 10 | pending  | — | — | EventV2 + Bus events for agent lifecycle |
| 11 | pending  | — | — | TUI subagent enhancements (status, mailbox renderer) |
| 12 | pending  | — | — | Permission integration + agent system prompt fragments |
| 13 | pending  | — | — | Backward compat verification (legacy snapshot, task tool, pty consumer) |
| 14 | pending  | — | — | E2E integration tests + final perf audit |
| 15 | pending  | — | — | Spec doc at specs/codex-parity.md |
