// Tool IDs for the unified_exec tool family. The string values match codex
// exactly so model traces transfer cleanly: codex models call `exec_command`
// and `write_stdin` and we expose the same names.
//
// Wave 2 (replace-bash-task-2026-05-15) collapses the family's permission
// key onto `bash` (via SHELL_TOOLS in `permission/index.ts`). Saved
// `permission.bash: { ... }` rules — built up over months on the legacy
// shell tool — now transparently gate `exec_command` and `write_stdin`
// without user re-approval. The per-PID always-pattern set on first spawn
// (`pid:<process_id>`) registers under the same `bash` key so subsequent
// `write_stdin` calls auto-allow.
//
// Reference: PERMISSION_MAPPING.md § "Post-Wave-2 mapping (bash group)".

import { ShellID } from "../shell/id"

export const ExecCommandID = {
  ToolID: "exec_command" as const,
}

export const WriteStdinID = {
  ToolID: "write_stdin" as const,
}

// Wave 2: shared permission key with the legacy `bash` tool. SHELL_TOOLS
// in `@/permission` groups all three IDs onto this key in `disabled()` and
// `resolveTools()`.
export const PermissionKey = ShellID.ToolID

// Build the per-PID always-pattern. Used both at exec_command approval time
// (registered as `always`) and at write_stdin time (passed as `patterns`).
export function pidPattern(processId: number): string {
  return `pid:${processId}`
}

export * as ProcessTool from "./id"
