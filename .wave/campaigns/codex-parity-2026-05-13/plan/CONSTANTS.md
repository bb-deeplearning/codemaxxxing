# Constants — verbatim port from codex

These are the numeric constants that govern unified_exec and multi_agents_v2 behavior in codex. Port them with the SAME values. Do not invent your own. Source: `codex-rs/core/src/unified_exec/mod.rs:61-72` and `codex-rs/core/src/tools/handlers/multi_agents_common.rs:30-33`.

## unified_exec

```ts
export const MIN_YIELD_TIME_MS = 250
export const MIN_EMPTY_YIELD_TIME_MS = 5_000
export const MAX_YIELD_TIME_MS = 30_000
export const DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000  // 5 min
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024  // 1 MiB
export const UNIFIED_EXEC_OUTPUT_MAX_TOKENS = UNIFIED_EXEC_OUTPUT_MAX_BYTES / 4
export const MAX_UNIFIED_EXEC_PROCESSES = 64
export const WARNING_UNIFIED_EXEC_PROCESSES = 60
export const POST_WRITE_STDIN_SLEEP_MS = 100   // process.rs grace after write
export const EARLY_EXIT_GRACE_PERIOD_MS = 150  // process.rs:33
export const POST_EXIT_CLOSE_WAIT_CAP_MS = 50  // process_manager.rs:1080
export const TRAILING_OUTPUT_GRACE_MS = 100    // async_watcher.rs:27
export const UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES = 8192  // async_watcher.rs:35
export const PROCESS_STORE_PROTECTED_RECENT = 8  // process_manager.rs:1224
export const PROCESS_ID_RANGE_MIN = 1_000        // process_manager.rs:348
export const PROCESS_ID_RANGE_MAX = 100_000      // process_manager.rs:348
```

## Tool defaults (from `shell_spec.rs` and `unified_exec.rs:63-69`)

```ts
export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000   // unified_exec.rs:64
export const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250  // unified_exec.rs:68
export const DEFAULT_TTY = false                   // unified_exec.rs:71
```

## multi_agents_v2

```ts
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000      // multi_agents_common.rs:32
export const MIN_WAIT_TIMEOUT_MS_FALLBACK = 1      // wait.rs:56 — clamp(1, MAX)
export const MAX_WAIT_TIMEOUT_MS = 600_000         // value of MAX_MULTI_AGENT_V2_WAIT_TIMEOUT_MS in codex config (10 min)
export const DEFAULT_MIN_WAIT_TIMEOUT_MS = 1_000   // value of DEFAULT_MULTI_AGENT_V2_MIN_WAIT_TIMEOUT_MS in codex config
```

## Environment variables (from `process_manager.rs:61-72`)

These are injected into every PTY spawned by exec_command. Match exactly:

```ts
export const UNIFIED_EXEC_ENV: ReadonlyArray<readonly [string, string]> = [
  ["NO_COLOR", "1"],
  ["TERM", "dumb"],
  ["LANG", "C.UTF-8"],
  ["LC_CTYPE", "C.UTF-8"],
  ["LC_ALL", "C.UTF-8"],
  ["COLORTERM", ""],
  ["PAGER", "cat"],
  ["GIT_PAGER", "cat"],
  ["GH_PAGER", "cat"],
  ["CODEX_CI", "1"],   // we will name this OPENCODE_CI for our flavor
] as const
```

Note: replace `CODEX_CI` with `OPENCODE_CI` since this is our environment marker, not codex's. Everything else is verbatim.

## Mailbox / agent path

- AgentPath root literal: `"/root"` (codex `AgentPath::ROOT`)
- AgentPath separator: `"/"`
- Spawn depth starts at: `1` (root has implicit depth 0; first level subagent is depth 1)
- Default `agent_max_depth`: `4` (codex `Config::agent_max_depth` default; verify in `agent/registry.rs` callers)
- Default `agent_max_threads`: configurable; if unset, no cap (mirror codex behavior)

## TUI render budgets (we set these — codex has no equivalent)

These are codemaxxxing-specific perf budgets. Wave 0 measures baseline; Wave 11 must not exceed:

- Per-streaming-chunk render time: target ≤ 1.5× baseline (sliding-buffer-only era)
- Sibling spinner overhead: ≤ 5ms per concurrent sibling on the parent's render path
- Mailbox drain check (per-turn): ≤ 1ms with empty mailbox

These bounds are verified in `test/perf/` runs every wave from Wave 11 onward.
