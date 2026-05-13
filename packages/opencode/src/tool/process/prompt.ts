// Re-exports the model-facing prompt strings for the unified_exec tools.
// The prose itself lives in `.txt` files alongside the tool definitions
// (matching the `task.txt` / `shell.txt` pattern). Bun loads the text via
// the default-import-of-text-file convention, so `import x from "./y.txt"`
// returns the raw file contents.

import EXEC_COMMAND_PROMPT_TEXT from "./exec-command.txt"
import WRITE_STDIN_PROMPT_TEXT from "./write-stdin.txt"

export const EXEC_COMMAND_PROMPT = EXEC_COMMAND_PROMPT_TEXT
export const WRITE_STDIN_PROMPT = WRITE_STDIN_PROMPT_TEXT

export * as ProcessPrompt from "./prompt"
