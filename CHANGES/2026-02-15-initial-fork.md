# Changes: Initial fork

**Date**: 2026-02-15
**Commit**: `abb154db540153403edb9e601c07cb232717d67b`
**Iteration**: [PROMPT_ITERATIONS/2026-02-15-initial-fork.md](../PROMPT_ITERATIONS/2026-02-15-initial-fork.md)

Comprehensive list of every modification in this fork relative to [anomalyco/opencode](https://github.com/anomalyco/opencode) `dev` branch. Prompt changes are detailed in the [iteration log](../PROMPT_ITERATIONS/2026-02-15-initial-fork.md).

## System prompts

Prompt changes are detailed in the [iteration log](../PROMPT_ITERATIONS/2026-02-15-initial-fork.md).

- `packages/opencode/src/session/prompt/anthropic.txt` — rebranded, added our behavioural guidelines
- `packages/opencode/src/session/prompt/plan.txt` — full iterative planning workflow
- `packages/opencode/src/tool/task.txt` — context isolation, subagent delegation guidance
- `packages/opencode/src/agent/prompt/explore.txt` — read-only enforcement, structured format

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
- **`general.md`** — custom general subagent prompt replacing the upstream behavior of inheriting the parent's system prompt verbatim. Now shipped natively — see [prompt-parity](2026-02-22-prompt-parity.md). This file remains as a reference.
- **`plan_structured.md`** — structured 4-phase planning pipeline (survey, organize, write, verify) with locked-down permissions. Read-only except `.opencode/plans/`. Full explore agent bash deny/allow rules
- **`wave_decompose.md`** — wave decomposition agent that takes a plan and produces the `.wave/` execution system. Read-only except `.wave/`. Produces `AGENT_INSTRUCTIONS.md`, `OVERVIEW.md`, `STATE.md`, and per-wave `WAVE.md` files

## New files

- **`README.md`** — completely rewritten for the fork (upstream README replaced)
- **`WAVES.md`** — rationale document explaining why waves work better than single long sessions for large tasks
- **`.wave/`** — wave executor state directory (produced by `wave_decompose` agent, consumed by wave execution sessions)

## Minor changes

- **`.gitignore`** — added `SYNC.md` to ignore list
