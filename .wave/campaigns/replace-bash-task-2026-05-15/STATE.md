# Wave State

## Status

```yaml
campaign_id: replace-bash-task-2026-05-15
plan_source: inline-prompt
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
active_session_id: ses_1d7f5dad8ffelIuY1LFHsX2V9E
active_session_kind: executor
total_waves: 7
session_count: 2
created: 2026-05-15
last_updated: 2026-05-15
```

## Wave Progress

| Wave | Status   | Session | Commit | Notes |
|------|----------|---------|--------|-------|
| 0 | complete | ses_1d816765cffetHaX40einkd5VR | d27484e73 | Survey + invariant seed + behavioral baseline + integration test scaffold + 4 GOTCHAS appended |
| 1 | complete | ses_1d7f5dad8ffelIuY1LFHsX2V9E | — | Scanner extracted to `tool/shell/scan.ts`; corpus diff + 64-concurrent + 1000-fuzz green; 1 GOTCHA added |
| 2 | pending  | — | — | Wire scanner into `exec_command`, align permission key to `bash`, add SHELL_TOOLS category |
| 3 | pending  | — | — | Align spawn_agent + 5 friends permission gating to `task`, add MULTI_AGENT_TOOLS category |
| 4 | pending  | — | — | Drop `tool.shell` and `tool.task` from registry builtin array; plugin hook bridge |
| 5 | pending  | — | — | Migrate `shell.txt` and `task.txt` prose into new tool descriptions via shared template |
| 6 | pending  | — | — | Full BC re-run, perf aggregate, plugin re-verify, spec doc + ship |
