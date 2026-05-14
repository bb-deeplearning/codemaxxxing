# Wave State

## Status

```yaml
campaign_id: replace-bash-task-2026-05-15
plan_source: inline-prompt
executor_agent: caveman
executor_model: ""
executor_variant: ""
current_wave: 7
wave_status: all_complete
failure_kind: ""
retry_count: 0
verify_count: 1
user_question: ""
loop_state: armed
active_session_id: ses_1d73a96ffffegAtNmwPYklYmW7
active_session_kind: executor
total_waves: 7
session_count: 7
created: 2026-05-15
last_updated: 2026-05-15
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1d816765cffetHaX40einkd5VR | d27484e73 | Survey + invariant seed + behavioral baseline + integration test scaffold + 4 GOTCHAS appended |
| 1 | complete | ses_1d7f5dad8ffelIuY1LFHsX2V9E | 7b4d4960d | Scanner extracted to `tool/shell/scan.ts`; corpus diff + 64-concurrent + 1000-fuzz green; 1 GOTCHA added |
| 2 | complete | ses_1d7da4d78ffehhKWpPH28gdOLr | 4f88777b1 | exec_command + write_stdin → permission key `bash`; SHELL_TOOLS group in disabled() + resolveTools; differential 4×10 BC tuples green; 5 invariants unskipped; 3 GOTCHAS added |
| 3 | complete | ses_1d7a31ec0ffeIZAoXKc33aFkxw | a58017029 | spawn_agent + 5 friends → permission key `task`; MULTI_AGENT_TOOLS group in disabled() + resolveTools; describeSpawnAgent filter → task; agent.ts plan/explore dual-write; differential 4×2 BC tuples green; 3 invariants unskipped + 1 stress; 1 GOTCHA added |
| 4 | complete | ses_1d77620ccffe7kZkjEtVMFkHjJ | 7eb1dbf2a | Drop `tool.shell` and `tool.task` from registry builtin; plugin hook bridge (legacy-then-new dispatch); 6 invariants + snapshot diff unskipped; 4 plugin contracts; bench best-by-p99 (-29% p99); GOTCHA addendum |
| 5 | complete | ses_1d749e807ffemSJTGhrmeVZo3l | c45e6e014 | Migrated git safety + PR creation + file-op restriction prose into `exec_command.txt` (verbatim modulo bash → exec_command); no spawn_agent prose change (task.txt content already covered by v2 agent-spawn.txt); 4 invariants unskipped; differential test 7/7 green; bench within budget (12393 ≤ 14428 upper) |
| 6 | complete | ses_1d73a96ffffegAtNmwPYklYmW7 | — | Full BC re-run 33/33; perf trend across waves 0..6 within budget (largest non-improvement +2.9% on exec_command.exec.p50, well under 5% p50 budget); plugin-bridge re-verify 4/4; spec doc shipped at specs/replace-bash-task.md; CHANGES.md created at repo root; perf-final-report.md + bc-verification.md + perf-trend.md + wave_6.json artifacts written; scan.bench.ts test-infra fix for post-W4 bash-not-in-builtin |
