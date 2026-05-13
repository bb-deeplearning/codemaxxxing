# Wave State

## Status

```yaml
campaign_id: codex-parity-2026-05-13
plan_source: specs/codex-parity-handoff.html
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 0
wave_status: pending
failure_kind: ""
retry_count: 0
verify_count: 1
user_question: ""
loop_state: armed
active_session_id: ses_1ddf9a317ffeN0tLVQcQQuQonU
active_session_kind: verifier
total_waves: 16
session_count: 0
created: 2026-05-13
last_updated: 2026-05-13
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | pending  | — | — | test infra + perf baseline + LLM stub |
| 1 | pending  | — | — | head/tail buffer port from codex |
| 2 | pending  | — | — | Pty.Service extensions (read primitive + LRU + origin) |
| 3 | pending  | — | — | tool/process.ts (exec_command + write_stdin) |
| 4 | pending  | — | — | Process tool TUI part renderer |
| 5 | pending  | — | — | Mailbox + AgentPath + InterAgentCommunication primitives |
| 6 | pending  | — | — | Agent registry (depth, concurrency cap, nickname pool) |
| 7 | pending  | — | — | AgentControl service (spawn/send/close/list) |
| 8 | pending  | — | — | Six multi-agent v2 tools (parallel sub-agents) |
| 9 | pending  | — | — | runLoop integration (dispatch swap + mailbox drain) |
| 10 | pending  | — | — | EventV2 + Bus events for agent lifecycle |
| 11 | pending  | — | — | TUI subagent enhancements (status, mailbox renderer) |
| 12 | pending  | — | — | Permission integration + agent system prompt fragments |
| 13 | pending  | — | — | Backward compat verification (legacy snapshot, task tool, pty consumer) |
| 14 | pending  | — | — | E2E integration tests + final perf audit |
| 15 | pending  | — | — | Spec doc at specs/codex-parity.md |
