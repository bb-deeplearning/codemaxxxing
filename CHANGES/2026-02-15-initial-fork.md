# Changes: Initial fork

**Date**: 2026-02-15
**Commit**: `abb154db540153403edb9e601c07cb232717d67b`

Comprehensive list of every modification in this fork relative to [anomalyco/opencode](https://github.com/anomalyco/opencode) `dev` branch.

## System prompts

### Main system prompt (`packages/opencode/src/session/prompt/anthropic.txt`)

- Rebranded identity from "OpenCode" to "codemaxxxing" with Rohan Shiralkar / bbdeeplearning.systems attribution
- Removed upstream help text (ctrl+p hint, GitHub issue link)
- Added self-referencing docs lookup for both "codemaxxxing" and "OpenCode" questions
- Added "Never give time estimates" rule
- Added anti-over-engineering guidelines: no unnecessary features, abstractions, error handling, comments, or type annotations beyond what was asked
- Added security awareness: OWASP top 10 vulnerability watchlist
- Added blast radius awareness: freely take reversible actions, flag destructive ones before proceeding
- Added backwards-compatibility hack avoidance: delete unused code instead of renaming to `_var` or adding `// removed`
- Tightened tool usage policy: prefer explore subagent for broad codebase searches, explicit context isolation rules for subagent prompts
- Reorganized and condensed tone/style section

### Plan mode prompt (`packages/opencode/src/session/prompt/plan.txt`)

- Replaced minimal "do not edit" reminder with a full iterative planning workflow
- Added the explore-update-ask loop: explore with subagents, update plan incrementally, ask user on ambiguities
- Added self-contained plan requirements: exact file paths, code snippets, patterns, dead ends, rationale, verification, dependencies
- Added required plan structure sections: Context, Codebase Analysis, Approach, Changes, Dead Ends, Verification, Dependencies
- Added question guidelines: never ask what you could find by reading code, batch related questions
- Plans write to `.opencode/plans/` — the only writable location in plan mode

### Task tool prompt (`packages/opencode/src/tool/task.txt`)

- Added context isolation section: each subagent starts with zero context, prompts must be self-contained with absolute paths, code snippets, and expected output format
- Added overhead awareness: delegate when work benefits from isolation or parallelism, not for single tool calls
- Added bad/good prompt examples
- Added "always include a short description (3-5 words)" requirement
- Restructured when-to-use and when-not-to-use guidance

### Explore agent prompt (`packages/opencode/src/agent/prompt/explore.txt`)

- Rebranded identity to codemaxxxing exploration agent
- Added explicit read-only enforcement with prohibition list (no Write, Edit, touch, mv, cp, redirect operators)
- Added tool selection guidance with allowed/denied bash commands
- Added speed and parallelism section with concrete parallel patterns
- Added structured thoroughness levels: quick (1-3 calls), medium (5-10 calls), very thorough (no limit)
- Added machine-readable response format: absolute paths, code snippets, relevance ordering, explicit negatives, no emojis

## Agent configuration (`packages/opencode/src/agent/agent.ts`)

### General agent

- Rewrote description to emphasize isolated context, self-contained prompts, and when to prefer explore over general

### Explore agent

- Rewrote description to emphasize read-only nature and when to use vs direct Grep/Glob
- Locked down bash permissions with explicit deny/allow rules:
  - **Denied**: `rm`, `rmdir`, `mkdir`, `touch`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `git add/commit/push/reset/checkout/merge/rebase/stash/clean`, `npm install/run`, `yarn`, `pnpm`, `bun install`, `pip install`, `brew`, `wget`
  - **Allowed**: `ls`, `find`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `du`, `tree`, `diff`, `sort`, `uniq`, `cut`, `which`, `echo`, `pwd`, `realpath`, `basename`, `dirname`, `git log/diff/show/blame/status/branch/rev-parse/ls-files/ls-tree/config`

## TUI changes

### Logo (`packages/opencode/src/cli/logo.ts`, `packages/opencode/src/cli/cmd/tui/component/logo.tsx`)

- Replaced upstream two-column logo with three-section layout (top + left/mid/right columns)
- Custom ASCII art spelling "codemaxxxing"

### Sidebar (`packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`)

- Changed branding from "Open **Code**" to "**codemaxxxing**"

### Exit screen (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`)

- Replaced multi-line logo exit message with compact 3-line block art
- Changed resume command from `opencode -s` to `codemaxxxing -s`

### Web search display (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`)

- Replaced inline one-line display with collapsible block view
- Shows result count, titles, domains, dates, and authors
- Click to expand/collapse result list

### Code search display (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`)

- Replaced inline one-line display with collapsible block view
- Shows result count, titles, and domains
- Click to expand/collapse result list

### Nested subagent permissions (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`)

- Fixed permission and question prompts from nested subagent sessions (grandchildren+)
- Changed `children()` to `descendants()` using recursive traversal so permissions and questions from arbitrarily deep subagent trees surface in the parent session

### `/execute-wave` slash command (`packages/opencode/src/cli/cmd/tui/app.tsx`)

- Registered `/execute-wave` (alias `/wave`) in the TUI command system
- Sets agent to "build", navigates to home, pre-fills prompt with wave execution text
- Attaches `.wave/AGENT_INSTRUCTIONS.md` as a file context part with proper `file://` URL
- Uses `setTimeout(0)` + `promptRef` to set the prompt after the Home component mounts, avoiding the module-level `once` guard in `home.tsx` that blocks `initialPrompt` on re-mount

## Custom agents (`custom_agents/`)

Four custom agent configs, intended to be copied to `~/.config/opencode/agent/`:

- **`docs.md`** — technical documentation writer with style constraints (short chunks, imperative headings, relaxed tone, no trailing semicolons in code snippets)
- **`general.md`** — custom general subagent prompt replacing the upstream behavior of inheriting the parent's system prompt verbatim. Purpose-built for task execution with anti-over-engineering rules and structured reporting format
- **`plan_structured.md`** — structured 4-phase planning pipeline (survey, organize, write, verify) with locked-down permissions. Read-only except `.opencode/plans/`. Full explore agent bash deny/allow rules
- **`wave_decompose.md`** — wave decomposition agent that takes a plan and produces the `.wave/` execution system. Read-only except `.wave/`. Produces `AGENT_INSTRUCTIONS.md`, `OVERVIEW.md`, `STATE.md`, and per-wave `WAVE.md` files

## New files

- **`README.md`** — completely rewritten for the fork (upstream README replaced)
- **`WAVES.md`** — rationale document explaining why waves work better than single long sessions for large tasks
- **`.wave/`** — wave executor state directory (produced by `wave_decompose` agent, consumed by wave execution sessions)

## Minor changes

- **`.gitignore`** — added `SYNC.md` to ignore list
