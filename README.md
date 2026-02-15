# codemaxxxing

A highly opinionated fork of [OpenCode](https://github.com/anomalyco/opencode) ([docs](https://opencode.ai/docs)), used internally for all development on [Clauseo](https://clauseo.chat) and other [bbdeeplearning.systems](https://bbdeeplearning.systems) projects.

This is an ongoing effort to tweak, configure, and personalise OpenCode for our own working methods. It's a public repository — feel free to use it if you find it useful.

## What's different

### System prompts

The core system prompt has been rewritten with stronger opinions:

- **Anti-over-engineering** — don't add features, abstractions, error handling, or comments beyond what was asked
- **Security awareness** — actively watch for OWASP top 10 vulnerabilities in generated code
- **No time estimates** — never predict how long tasks will take
- **Blast radius awareness** — freely take reversible actions, flag destructive ones before proceeding

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

Plan mode has been restructured around an iterative loop — explore, update the plan, ask the user — instead of the original monolithic approach. Plans are written to `.opencode/plans/` as self-contained markdown files designed to be executed by fresh agents with no context from the planning session. Includes required sections: context, codebase analysis, approach, changes, dead ends, verification, and dependencies.

### Subagent permissions

The explore agent's bash access is locked down with explicit deny rules for destructive commands (`rm`, `git push`, `npm install`, etc.) while allowing read-only commands (`ls`, `find`, `git log`, etc.).

### Custom agents

Three custom agents live in `custom_agents/`. Copy them to your config directory to use them:

```bash
cp custom_agents/*.md ~/.config/opencode/agent/
```

- **docs** — technical documentation writer with specific style constraints (short chunks, imperative headings, relaxed tone)
- **general** — custom system prompt for the general subagent. In upstream OpenCode, the general subagent inherits its system prompt from the parent verbatim. This replaces that with a purpose-built prompt focused on task execution, anti-over-engineering, and structured reporting back to the parent agent.
- **plan_structured** — an alternative non-iterative plan mode (WIP)

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
