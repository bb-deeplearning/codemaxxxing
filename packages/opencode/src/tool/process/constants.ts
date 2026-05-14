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
  abortNote?: string
}): string {
  const sections: string[] = []
  sections.push(`Wall time: ${(opts.wallMs / 1000).toFixed(4)} seconds`)
  if (opts.exitCode !== undefined) sections.push(`Process exited with code ${opts.exitCode}`)
  if (opts.sessionId !== undefined) sections.push(`Process running with session ID ${opts.sessionId}`)
  if (opts.originalTokenCount !== undefined && opts.originalTokenCount > 0) {
    sections.push(`Original token count: ${opts.originalTokenCount}`)
  }
  if (opts.abortNote) sections.push(opts.abortNote)
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
