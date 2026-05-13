// Tool IDs and the shared permission key for the unified_exec tool family.
// The string values match codex exactly so model traces transfer cleanly:
// codex models call `exec_command` and `write_stdin` and we expose the same
// names. Both share permission key `exec_command` (per MESSAGE_SHAPES.md
// § "Permission keys") — the per-PID always-pattern set on first spawn
// (`pid:<process_id>`) authorises subsequent write_stdin calls.

export const ExecCommandID = {
  ToolID: "exec_command" as const,
}

export const WriteStdinID = {
  ToolID: "write_stdin" as const,
}

// Single permission key gating both tools. The exec_command first-spawn
// approval registers the always-pattern `pid:<process_id>` so subsequent
// write_stdin calls evaluate as already-allowed without re-asking.
export const PermissionKey = "exec_command" as const

// Build the per-PID always-pattern. Used both at exec_command approval time
// (registered as `always`) and at write_stdin time (passed as `patterns`).
export function pidPattern(processId: number): string {
  return `pid:${processId}`
}

export * as ProcessTool from "./id"
