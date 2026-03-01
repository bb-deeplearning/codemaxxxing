# codemaxxxing

An opinionated fork of [OpenCode](https://github.com/anomalyco/opencode) ([docs](https://opencode.ai/docs)), used internally for all development on [Clauseo](https://clauseo.chat) and other [bbdeeplearning.systems](https://bbdeeplearning.systems) projects.

Rewritten system prompts, aggressive subagent parallelism, stricter permissions, and custom agents — including a [wave executor](#wave-executor-workflow) for breaking large tasks across fresh sessions. The prompts and agents are portable to stock OpenCode; the fork adds the prompt and agent changes that make them work well.

## Prompt iteration

The core value of this fork is iterative prompt tuning. We observe model behavior during daily use, identify recurring failure patterns, research how other harnesses handle the same problems, change the prompts, and repeat. Each iteration follows a consistent structure:

1. **Discovery** — what behavior is going wrong, with concrete examples
2. **Research** — how Claude Code, Cursor, and community patterns handle it
3. **Solution** — exact files changed and why
4. **Observe** — what to watch for to know if it worked

Iteration logs live in [`PROMPT_ITERATIONS/`](./PROMPT_ITERATIONS/) and corresponding change lists in [`CHANGES/`](./CHANGES/). A full index of files differing from upstream is in [`CHANGES/INDEX.md`](./CHANGES/INDEX.md).

| Iteration                                                      | Date       | Focus                                                                                     |
| -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| [1](./PROMPT_ITERATIONS/2026-02-15-initial-fork.md)            | 2026-02-15 | Initial fork: anti-over-engineering, explore lockdown, context isolation, plan mode       |
| [2](./PROMPT_ITERATIONS/2026-02-22-explore-delegation.md)      | 2026-02-22 | Explore agent delegation: split broad tasks into parallel focused agents, stop code dumps |
| [3](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) | 2026-02-22 | Prompt parity: Gemini system prompt rewrite, native general subagent prompts              |
| [4](./PROMPT_ITERATIONS/2026-02-23-anthropic-inquiry-mode.md)  | 2026-02-23 | Anthropic inquiry mode: distinguish questions from directives                             |
| [5](./PROMPT_ITERATIONS/2026-02-24-qwen-prompt-sync.md)        | 2026-02-24 | Default prompt sync: full codemaxxxing prompt for GLM and non-Claude models               |

## What's different

### System prompts

The Anthropic, Gemini, and default (GLM/Qwen/other) system prompts have all been rewritten with our flavour:

- **Anti-over-engineering** — don't add features, abstractions, error handling, or comments beyond what was asked
- **Inquiry vs directive awareness** — distinguish questions and discussions from action requests; don't start implementing when the user is exploring ideas
- **Security awareness** — actively watch for OWASP top 10 vulnerabilities in generated code
- **No time estimates** — never predict how long tasks will take
- **Blast radius awareness** — freely take reversible actions, flag destructive ones before proceeding
- **Parallelism** — the prompts encourage parallel tool calls and parallel subagent launches wherever independent work exists. This keeps sessions shorter, context cleaner, and is what makes patterns like the wave executor practical.

The Gemini prompt is adapted for Gemini's response patterns — prescriptive framing over prohibitions, context efficiency guidance, Directives/Inquiries distinction, Research-Strategy-Execution lifecycle. See [iteration 3](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) and the [research learnings](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/LEARNINGS.md) for the rationale.

### General subagent

In upstream OpenCode, the general subagent inherits its system prompt from the parent verbatim. We now ship native general subagent prompts — one for Anthropic models, one for Gemini — purpose-built for task execution with anti-over-engineering rules and structured reporting back to the parent agent. Model selection happens automatically via `Agent.resolvePrompt()` in `agent.ts`. Custom agents defined via `.opencode/agent/` config still take precedence.

### Explore agent

The explore agent prompt has been overhauled for speed and strictness:

- Hard read-only enforcement with an explicit deny list for destructive commands
- Parallel tool call patterns for faster search
- Structured thoroughness levels (quick / medium / very thorough)
- Machine-readable response format (absolute paths, code snippets, explicit negatives)
- Concise findings — key function signatures and critical logic, not entire file dumps

The main agent's delegation to explore has been tuned to prevent context bloat (iteration 2):

- Broad questions are split into multiple parallel explore agents, each targeting one area or concern
- The main agent uses Read directly when it already knows file paths, instead of wasting an explore agent on file reading
- Explore agents are always given a thoroughness level and starting-point directories

Our setup uses Claude Opus 4.6 as the primary model with the explore agent specifically running on Gemini 3 Flash. To use this, add the following to your `opencode.json`:

```json
{
  "agent": {
    "explore": {
      "model": "google/gemini-3-flash-preview"
    }
  }
}
```

The explore prompt is structured to account for that pairing. Consequences on different model setups are not tested.

### Plan mode

Both plan modes — the built-in `/mode plan` and the `plan_structured` custom agent — produce self-contained markdown plans in `.opencode/plans/`. These plans are designed to be picked up by fresh agents with zero context from the planning session.

The built-in plan mode (`/mode plan`) is iterative. It pair-plans with you: explores the codebase, updates the plan incrementally, and asks you questions when it hits ambiguities only you can resolve. It loops — explore, update, ask — until the plan is complete. Good for open-ended tasks where the scope needs discussion.

The `plan_structured` custom agent is a linear pipeline. You provide the task definition upfront, and it runs a 4-phase workflow: survey the codebase with parallel explore subagents, organize findings and identify gaps, write the full plan, then verify file paths and snippets are accurate. It works with you directly and asks questions on genuine ambiguities, but its value-add is the thorough autonomous survey and structured documentation — not problem discovery. Good for well-defined tasks where you know what you want and need the codebase mapped out.

Both are read-only — they never modify source code. Both produce plans with the same required sections: context, codebase analysis, approach, changes, dead ends, verification, and dependencies. Either plan can be fed into the wave decomposer.

Use `/mode plan` when you're still figuring out what you want — you have a rough idea but need to talk through the approach, explore tradeoffs, and refine scope as you go. Use `plan_structured` when you already know what needs to happen and just need the agent to survey the codebase and document the execution path.

### Subagent permissions

The explore agent's bash access is locked down with explicit deny rules for destructive commands (`rm`, `git push`, `npm install`, etc.) while allowing read-only commands (`ls`, `find`, `git log`, etc.).

### Custom agents

The `general` subagent prompt now ships natively (see [General subagent](#general-subagent) above). The remaining custom agents in `custom_agents/` still need to be copied to your config directory:

```bash
cp custom_agents/docs.md custom_agents/plan_structured.md custom_agents/wave_decompose.md ~/.config/opencode/agent/
```

- **docs** — technical documentation writer with specific style constraints (short chunks, imperative headings, relaxed tone)
- **general** — custom system prompt for the general subagent. Now shipped natively (iteration 3) — this file remains as a reference. See [General subagent](#general-subagent) above.
- **plan_structured** — structured planning with a 4-phase pipeline: survey (parallel explore subagents), organize, write, verify. You provide the task upfront; the agent's value-add is thorough codebase survey and structured documentation. Asks questions on genuine ambiguities. Read-only — never modifies source code.
- **wave_decompose** — wave decomposition mode. Takes a plan and produces the `.wave/` execution system — a stateless, progressive-disclosure-based wave executor that breaks large tasks into fresh-session-sized chunks. See [Wave executor workflow](#wave-executor-workflow) below.

### Wave executor workflow

Long agent sessions degrade. The context window is a sliding window — early details rot, compaction makes knowledge shallow, and late-stage errors compound. The wave executor solves this by splitting large tasks across fresh sessions, with progress tracked on disk as a finite state machine.

Each session loads only what it needs (progressive disclosure), executes one wave, verifies it, and stops. A fresh session picks up exactly where the last one left off.

**Session 1 — Plan.** Brainstorm and decide on the approach. Switch to either plan mode — the built-in iterative plan mode or the `plan_structured` custom agent:

```
/mode plan
```

or

```
/agent plan_structured
```

Either works. Discuss the task, explore the codebase, and iterate. The plan lands in `.opencode/plans/` as a self-contained markdown file with exact file paths, current implementations, constraints, and verification criteria.

**Session 2 — Decompose.** New session. Switch to the wave decomposer and point it at the plan:

```
/agent wave_decompose
Decompose the plan in @.opencode/plans/my-plan.md
```

This produces the `.wave/` directory — `AGENT_INSTRUCTIONS.md`, `OVERVIEW.md`, `STATE.md`, and `waves/wave_N/WAVE.md` for each wave. No source code is modified.

**Sessions 3 to N — Execute.** New session for each wave. Use the built-in `/execute-wave` slash command (or `/wave`) — it switches to the build agent, opens a new session, and pre-fills the prompt with `.wave/AGENT_INSTRUCTIONS.md` attached as context. Press Enter to send.

The agent reads `STATE.md` to find the current wave, loads only what it needs, executes, verifies, updates state, and stops. Start a new session and repeat until `wave_status: all_complete`.

Read more: [Why waves instead of plan-and-build](./WAVES.md)

### UI

- Custom ASCII art logo
- Rebranded TUI sidebar and exit screen
- Collapsible web search and code search result displays in TUI
- `/execute-wave` (alias `/wave`) slash command — switches to build agent, opens new session with wave prompt and file context pre-filled

### Bug fixes

- Permissions and questions from nested subagent sessions (not just direct children) now surface correctly in the TUI

## Before you use this

The prompts contain our identity. If you're forking this for yourself, update these files:

- `packages/opencode/src/session/prompt/anthropic.txt` — name, org, and identity in the Anthropic system prompt
- `packages/opencode/src/session/prompt/qwen.txt` — same for the default prompt (GLM, Qwen, and other non-specifically-matched models)
- `packages/opencode/src/session/prompt/gemini.txt` — same for the Gemini system prompt
- `packages/opencode/src/agent/prompt/explore.txt` — explore agent identity
- `packages/opencode/src/agent/prompt/general/anthropic.txt` — Anthropic general subagent identity
- `packages/opencode/src/agent/prompt/general/gemini.txt` — Gemini general subagent identity

## Installation

### From source (development)

```bash
bun dev
```

### Standalone binary

```bash
# Build
./packages/opencode/script/build.ts --single

# Make executable
chmod +x ./packages/opencode/dist/opencode-darwin-arm64/bin/opencode

#or

chmod +x ./packages/opencode/dist/opencode-darwin-x64/bin/opencode

# Symlink to PATH
ln -sf "$(pwd)/packages/opencode/dist/opencode-darwin-arm64/bin/opencode" ~/.local/bin/codemaxxxing

#or

ln -sf "$(pwd)/packages/opencode/dist/opencode-darwin-x64/bin/opencode" ~/.local/bin/codemaxxxing

```

Make sure `~/.local/bin` is in your `PATH`. If not, add to your `.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## License

Same as upstream OpenCode — see [LICENSE](./LICENSE).
