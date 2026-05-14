# Wave State

## Status

```yaml
campaign_id: codex-parity-2026-05-13
plan_source: specs/codex-parity-handoff.html
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 16
wave_status: all_complete
failure_kind: ""
retry_count: 0
verify_count: 0
user_question: ""
loop_state: armed
active_session_id: ses_1dbc6f958ffekOK6SXqlmBjywQ
active_session_kind: executor
total_waves: 16
session_count: 16
created: 2026-05-13
last_updated: 2026-05-14
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
| 7 | complete | ses_1dd139792ffeolvWi0IIwoE1qn | 6e379be37 | AgentControl service: 80 tests across status/live-agent/control, 100% line coverage on all three files (verified via lcov), perf p50 spawn 403µs / send 17µs / list(16) 12µs |
Six multi-agent v2 tools (spawn/send/followup/wait/list/close) + shared currentAgentPath helper: 172 wave-8 tests, 100% line+branch on all 8 new files, registry + permission defaults wired, integration test walks all six in sequence
| 9 | complete | ses_1dcbb89d3ffe0EQ4B6do4NnUYx | 12aa8deaf | runLoop integration: SubtaskPart `protocol: "v2"` marker, AgentControl.registerRunLoop + drainMailbox + hasPendingTriggerTurn + cancelChildrenOf, parent cancel cascades to children, mailbox drained at top of every iteration, 7 new prompt-test scenarios cover legacy/v2/drain/empty/cancel/spawn-fail/trigger-defer + slugify, control.ts 100% line, perf p50 8.5µs (baseline 19.5µs) within budget |
| 10 | complete | ses_1dc85d4b8ffeEurxIqQy062Fjn | 9bb594a3e | EventV2 + Bus events for agent lifecycle (Spawn.Started/Ended, Closed, Wait.Started/Ended, Message.Sent), status derivation from Step.Started/Ended, onSpawnEvent removed, 100% line coverage on touched files |
| 11 | complete | ses_1dc4f7beeffeQVk1kqm9V8DUPf | 79b832071 | TUI subagent enhancements: subagent-status helper, SubagentFooterView (with status display), MailboxMessage component, dialog-subagent close action, all four touched files at 100% line coverage; multi-agent-render bench p50 4-sibling 1.30× single (cap 1.5×); helper+view / wrapper file split documented in GOTCHAS |
| 12 | complete | ses_1dc2c9350ffe0wFF7JqqvODXfB | 95f150e7c | Permission integration + agent system prompt fragments: per-built-in overrides for all 7 new keys (build/general allow, plan/compaction/title/summary deny, explore allows coordination subset and denies destructive); SystemPrompt.capabilityHints helper gated on agent mode + permission, three new fragments (persistent-processes, multi-agent-root, multi-agent-subagent) injected post-skills; 100% line coverage on wave-touched code in agent.ts + system.ts; backward-compat test asserts compaction/title/summary receive zero hints |
| 13 | complete | ses_1dc1ad967fferifotQdujyeJ3p | 68401b382 | Backward compat verification: 62 tests across 6 files (legacy-session schema+round-trip, legacy task tool envelope, pty consumer schemas, system prompt regression, plugin hooks, event replay), synthetic legacy-session.json fixture exercises every MessageV2.Part variant, 4 pre-existing test failures on codemaxxxing branch are not regressions, manual smoke procedure documented in test/backward-compat/manual-smoke.md, 2 new GOTCHAS appended (syncevent-publish runtime mismatch, ID-brand string coercion) |
| 14 | complete | ses_1dbf253f8ffeQcPCzBZticVzXP | 845816bbc | E2E suite (10 scenario files + final perf audit): parallel-explorers, worker-pipeline, debate, observer, persistent-repl, long-running-server, cancellation-cascade, permission-denial, concurrent-perf-invariants (4-sibling ≤1.6× + mailbox p99 ≤5ms), memory-load (16 agents × 4 turns, RSS delta ≤160 MiB); 12 tests pass; perf-final-report.md aggregates baseline + 10 wave files, all baseline metrics within budget; 2 new GOTCHAS appended (permission wildcard-deny removes tools, e2e perf median-of-N) |
| 15 | complete | ses_1dbc6f958ffekOK6SXqlmBjywQ | — | spec doc shipped at specs/codex-parity.md (375 lines, tone-matched to specs/tui-render-freeze.md, links to plan/CONSTANTS.md + plan/TOOL_SCHEMAS.md + plan/MESSAGE_SHAPES.md + plan/PERF.md + plan/BACKWARD_COMPAT.md + artifacts/perf-final-report.md, file:line refs throughout) — campaign complete
