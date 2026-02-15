# codemaxxxing

An opinionated fork of [OpenCode](https://github.com/anomalyco/opencode) ([docs](https://opencode.ai/docs)), used internally for all development on [Clauseo](https://clauseo.chat) and other [bbdeeplearning.systems](https://bbdeeplearning.systems) projects.

Rewritten system prompts, aggressive subagent parallelism, stricter permissions, and custom agents — including a [wave executor](#wave-executor-workflow) for breaking large tasks across fresh sessions. The prompts and agents are portable to stock OpenCode; the fork adds the prompt and agent changes that make them work well.

## What's different

### System prompts

The core system prompt has been rewritten with stronger opinions:

- **Anti-over-engineering** — don't add features, abstractions, error handling, or comments beyond what was asked
- **Security awareness** — actively watch for OWASP top 10 vulnerabilities in generated code
- **No time estimates** — never predict how long tasks will take
- **Blast radius awareness** — freely take reversible actions, flag destructive ones before proceeding
- **Parallelism** — the prompts encourage parallel tool calls and parallel subagent launches wherever independent work exists. This keeps sessions shorter, context cleaner, and is what makes patterns like the wave executor practical.

### Explore agent

The explore agent prompt has been overhauled for speed and strictness:

- Hard read-only enforcement with an explicit deny list for destructive commands
- Parallel tool call patterns for faster search
- Structured thoroughness levels (quick / medium / very thorough)
- Machine-readable response format (absolute paths, code snippets, explicit negatives)

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

Four custom agents live in `custom_agents/`. Copy them to your config directory to use them:

```bash
cp custom_agents/*.md ~/.config/opencode/agent/
```

- **docs** — technical documentation writer with specific style constraints (short chunks, imperative headings, relaxed tone)
- **general** — custom system prompt for the general subagent. In upstream OpenCode, the general subagent inherits its system prompt from the parent verbatim. This replaces that with a purpose-built prompt focused on task execution, anti-over-engineering, and structured reporting back to the parent agent.
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

**Sessions 3 to N — Execute.** New session for each wave. Same prompt every time:

```
Execute the next wave per @.wave/AGENT_INSTRUCTIONS.md
```

The agent reads `STATE.md` to find the current wave, loads only what it needs, executes, verifies, updates state, and stops. Start a new session and repeat until `wave_status: all_complete`.

Read more: [Why waves instead of plan-and-build](./WAVES.md)

### UI

- Custom ASCII art logo
- Rebranded TUI sidebar and exit screen

## Before you use this

The prompts contain my identity. If you're forking this for yourself, update these files before using:

- `packages/opencode/src/session/prompt/anthropic.txt` — name, org, and identity in the main system prompt
- `packages/opencode/src/agent/prompt/explore.txt` — agent identity
- `custom_agents/general.md` — subagent identity

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

# Symlink to PATH
ln -sf "$(pwd)/packages/opencode/dist/opencode-darwin-arm64/bin/opencode" ~/.local/bin/codemaxxxing
```

Make sure `~/.local/bin` is in your `PATH`. If not, add to your `.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## License

Same as upstream OpenCode — see [LICENSE](./LICENSE).
