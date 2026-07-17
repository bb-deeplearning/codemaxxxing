// Constants ported verbatim from codex's unified_exec subsystem
// (codex-rs/core/src/unified_exec/mod.rs and tools/handlers/unified_exec.rs).
// See .wave/campaigns/codex-parity-2026-05-13/plan/CONSTANTS.md for the
// authoritative list and per-constant codex source line.
//
// These live with the tool surface (per MESSAGE_SHAPES.md § "Constants split"):
// the Pty service owns the buffer / pool / pruning constants; the tool owns
// the yield-time clamps, defaults, and the exec environment overlay.

// Yield-time clamps (process_manager.rs:643-652).
export const MIN_YIELD_TIME_MS = 250
export const MAX_YIELD_TIME_MS = 30_000
export const MIN_EMPTY_YIELD_TIME_MS = 5_000

// Default ceiling for empty-poll (background terminal) yield time, used
// when the model omits the parameter or chooses something larger than the
// ceiling. Codex calls this `max_write_stdin_yield_time_ms`. 5 minutes.
export const DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000

// Per-tool default yield times (unified_exec.rs:63-69).
export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000
export const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250
export const DEFAULT_TTY = false

// Output cap (mod.rs:67). Mirrors Pty's UNIFIED_EXEC_OUTPUT_MAX_BYTES; we
// re-export here because tools work in token units, not bytes.
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000

// Sleep after writing non-empty input before polling for output, giving the
// child a window to react (process_manager.rs:626).
export const POST_WRITE_STDIN_SLEEP_MS = 100

// Process-id allocation range. Codex uses [1000, 100000) so the model sees
// short, memorable session_ids (process_manager.rs:348).
export const PROCESS_ID_RANGE_MIN = 1_000
export const PROCESS_ID_RANGE_MAX = 100_000

// Environment overlay applied to every exec_command spawn. Matches codex
// process_manager.rs:61-72 verbatim except for the marker var: codex sets
// CODEX_CI; opencode's flavor uses OPENCODE_CI so child processes can detect
// they're running under our tool harness.
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
  ["OPENCODE_CI", "1"],
] as const

// Approx-token estimate. Codex uses bytes/4; we replicate so reported
// `original_token_count` matches when the same output flows through both.
export function approxTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 4)
}

// ANSI escape stripper for captured output. Opt-in via the tools'
// `strip_ansi` parameter — the raw bytes stay in the PTY buffer for TTY
// passthrough and range re-reads; only the model-visible capture is cleaned.
// Two alternations: OSC sequences (`ESC ] ... BEL` / `ESC ] ... ESC \`) first
// so they are not partially consumed by the CSI branch, then CSI plus
// single-char ESC sequences (covers spinner staples like `ESC[2K`, `ESC[1G`,
// cursor-hide `ESC[?25l`, and SGR color runs).
const ANSI_RE = new RegExp(
  [
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    "[\\u001B\\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><~]",
  ].join("|"),
  "g",
)
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

// Token-budget head/tail truncation with an explicit elision marker. The
// tool docs have promised "excess truncates head+tail" since the codex-parity
// campaign; this makes the promise real. Half the byte budget (tokens × 4)
// keeps the prologue, half keeps the most recent tail, and the marker tells
// the model exactly how many bytes were dropped — an honest gap instead of a
// silent one. Byte-slicing can split a multi-byte UTF-8 sequence at either
// edge; the non-fatal decoder degrades those to replacement chars, which is
// acceptable at an elision boundary.
export function truncateHeadTail(text: string, maxTokens: number): { text: string; omittedBytes: number } {
  const budget = maxTokens * 4
  const bytes = Buffer.from(text, "utf-8")
  if (bytes.length <= budget) return { text, omittedBytes: 0 }
  const headBudget = Math.floor(budget / 2)
  const tailBudget = budget - headBudget
  const omittedBytes = bytes.length - budget
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, headBudget))
  const tail = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(bytes.length - tailBudget))
  return {
    text: `${head}\n…[elided ~${omittedBytes} bytes of output; re-read with since_cursor to recover]…\n${tail}`,
    omittedBytes,
  }
}

// Build the model-visible tool response. Codex parity:
// codex-rs/core/src/tools/context.rs:461-487 (ExecCommandToolOutput::response_text).
// The model only sees the tool's `output` string (metadata is a side channel
// for the TUI / event log) — without this header the model never learns the
// `session_id` it needs to round-trip into write_stdin. Sections appear in
// the same order as codex so trace transfer keeps working.
export function formatExecResponse(opts: {
  wallMs: number
  output: string
  exitCode?: number
  sessionId?: number
  originalTokenCount?: number
  note?: string
}): string {
  const sections: string[] = []
  sections.push(`Wall time: ${(opts.wallMs / 1000).toFixed(4)} seconds`)
  if (opts.exitCode !== undefined) sections.push(`Process exited with code ${opts.exitCode}`)
  if (opts.sessionId !== undefined) {
    // Exited sessions stay drainable (range re-reads) until the LRU pruner
    // reclaims them — say so instead of the old contract where reporting an
    // exit destroyed the session and a re-poll returned "Unknown process id".
    sections.push(
      opts.exitCode === undefined
        ? `Process running with session ID ${opts.sessionId}`
        : `Session ID ${opts.sessionId} (exited; buffer retained for since_cursor re-reads until pruned)`,
    )
  }
  if (opts.originalTokenCount !== undefined && opts.originalTokenCount > 0) {
    sections.push(`Original token count: ${opts.originalTokenCount}`)
  }
  if (opts.note) sections.push(opts.note)
  sections.push("Output:")
  sections.push(opts.output.length > 0 ? opts.output : "(no output)")
  return sections.join("\n")
}

// Yield-time clamp for non-empty stdin writes. Mirrors process_manager.rs:646
// and :650 — at least MIN_YIELD_TIME_MS, at most MAX_YIELD_TIME_MS.
export function clampWriteYieldTime(yieldTimeMs: number): number {
  return Math.min(Math.max(yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS)
}

// Yield-time clamp for empty polls. Mirrors process_manager.rs:648 — clamp
// into [MIN_EMPTY_YIELD_TIME_MS, max] inclusive. The cap defaults to
// DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS but is configurable in codex via
// `max_write_stdin_yield_time_ms`. We accept the cap as a parameter so tests
// can shorten it without forking the function.
export function clampEmptyPollYieldTime(
  yieldTimeMs: number,
  maxMs: number = DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
): number {
  const lowered = Math.max(yieldTimeMs, MIN_YIELD_TIME_MS)
  if (lowered < MIN_EMPTY_YIELD_TIME_MS) return MIN_EMPTY_YIELD_TIME_MS
  if (lowered > maxMs) return maxMs
  return lowered
}

export * as ProcessConstants from "./constants"
