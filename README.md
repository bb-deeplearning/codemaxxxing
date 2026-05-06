# codemaxxxing

![codemaxxxing](./hero.png)

An opinionated, heavily-customized fork of [OpenCode](https://github.com/anomalyco/opencode) ([docs](https://opencode.ai/docs)). This isn't a product — it's our daily coding tool, used internally for all development on [Clauseo](https://clauseo.chat) and other [bbdeeplearning.systems](https://bbdeeplearning.systems) projects.

Three things differ substantially from upstream:

- **[Wave runner](#wave-runner)** — a finite state machine that drives large tasks across many fresh AI sessions. Auto-retry, in-flight plan amendment, conversational pauses when the agent needs us, full git audit trail.
- **[TUI](#tui)** — a "drafting table" redesign of the chrome (subtraction over addition), state-encoded prompt indicator, figlet wordmark, custom turbo-spool spinner, and a dedicated wave campaign dashboard.
- **[Prompts](#prompts)** — rewritten system prompts (Anthropic + Gemini + default), native general subagent prompts, locked-down explore agent, custom primary agents (caveman, plan_structured, wave_plan, wave_verify), aggressive subagent parallelism.

The rest of the README walks through each pillar and then how to install. There's also a separate [WAVES.md](./WAVES.md) for the full wave-runner algorithm.

## Wave runner

Long agent sessions degrade. The context window is a sliding window — early details rot, compaction makes knowledge shallow, late-stage errors compound. The wave runner splits large tasks across many small fresh sessions, persists progress on disk as a finite state machine, and recovers from failures by patching the plan or asking us — all without us babysitting between waves.

Three agents:

- `wave_plan` decomposes a plan markdown file into a campaign directory under `.wave/campaigns/<id>/`.
- `wave_verify` sanity-checks the campaign before any wave runs (probes reality with cheap shell commands to catch planner blind spots), and re-amends it whenever a wave fails because the spec was wrong.
- An executor agent (caveman, build, our choice) runs each wave: reads its `WAVE.md`, dispatches sub-agents, runs verification, commits, updates state.

A loop in `packages/opencode/src/wave/loop.ts` orchestrates everything. After we arm it once, every wave completion auto-spawns the next, transient failures auto-retry up to 3 times, and `PLAN UNDOABLE` outcomes auto-escalate to the verifier. When an agent needs user input it pauses conversationally — the session stays alive, we reply in chat, the same agent resumes mid-thread. Every outcome (success, failure, undoable, paused, crash) produces a git commit, so the working tree is always clean between sessions and we have a full audit trail in `git log`.

**Workflow**:

1. **Plan.** Write a plan in plain markdown anywhere, or use `/mode plan` (iterative) or `/agent plan_structured` (4-phase pipeline) to produce one in `.opencode/plans/`.

2. **Decompose.** New session, switch to wave_plan via the `/wave-plan` slash command. The slash pre-fills a prompt asking for the plan path and executor agent. Model is optional — leave unspecified to use codemaxxxing's default.

   ```
   /wave-plan
   Decompose @.opencode/plans/my-plan.md. Executor agent: caveman.
   ```

   This produces `.wave/campaigns/<id>/`. No source code is modified.

3. **Arm and walk away.** Open `/wave` in the TUI. Press `r`. The verifier runs first (sanity-checks the campaign). Then the executor spawns wave 0, runs it, commits, advances state. The loop sees the settle, spawns wave 1. Repeats until `all_complete`.

4. **Respond to questions.** When the dashboard shows a USER ATTENTION banner, press `↵` on the wave row to open the session in chat. Read the agent's full contextual question, reply normally. The agent picks up the reply and continues.

Read more: [WAVES.md](./WAVES.md) for the full algorithm, FSM states, set phrases, recovery paths, and architectural choices.

## TUI

![codemaxxxing](./screenshot.gif)

Lighter, more information-dense chrome — easier to read over mosh + tmux on smaller windows, and personal preference. Not a feature, just our taste.

Most of it is subtraction: panels lose their backgrounds and become single-cell left rules, message blocks lose their closing rules, tool calls collapse to `label · target · meta` instead of labeled separator lines. Speaker identity moves to a `u·1` / `a·1` mark in the left margin. Sidebar gains a small live stats block (messages / tokens / cost / duration). Prompt has a state-aware `▎` accent and a two-row status (identity + ephemeral hints) with a small usage meter.

Logo is a `slant`-figlet wordmark with a subtle ignition→idle animation; the prompt spinner is a turbo spool (two braille turbines + boost gauge) instead of the upstream V12. Sidebar footer reads `codema(xxx)ing for clauseo`, home footer `by clauseo`, OSC terminal title `codemaxxxing` (home) or `cmx | <session>` (sessions).

The recording above shows codemaxxxing in toybox-noir theme with the caveman agent active, mid-response — the spinner is the turbo spool.

Also:

- Collapsible web search and code search result displays
- `/wave` slash command — opens the wave campaign dashboard
- `/wave-plan`, `/wave-run`, `/wave-pause`, `/wave-stop`, `/wave-next` slash commands — campaign control surface
- Wave footer pill on home — shows active campaign + status when one exists
- Permissions and questions from nested subagent sessions (not just direct children) now surface correctly in the TUI (was a real bug — grandchildren+ silently swallowed prompts)

## Prompts

We keep iteration logs in [`PROMPT_ITERATIONS/`](./PROMPT_ITERATIONS/) and corresponding change lists in [`CHANGES/`](./CHANGES/). The reason isn't process discipline — it's that we forget what we tried. When something starts misbehaving again, the logs are how we find what we already learned. Each iteration follows the same structure:

1. **Discovery** — what behavior is going wrong, with concrete examples
2. **Research** — how Claude Code, Cursor, Ralph, and community patterns handle it
3. **Solution** — exact files changed and why
4. **Observe** — what to watch for to know if it worked

A full index of files differing from upstream is in [`CHANGES/INDEX.md`](./CHANGES/INDEX.md).

| Iteration                                                      | Date       | Focus                                                                                     |
| -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| [1](./PROMPT_ITERATIONS/2026-02-15-initial-fork.md)            | 2026-02-15 | Initial fork: anti-over-engineering, explore lockdown, context isolation, plan mode       |
| [2](./PROMPT_ITERATIONS/2026-02-22-explore-delegation.md)      | 2026-02-22 | Explore agent delegation: split broad tasks into parallel focused agents, stop code dumps |
| [3](./PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) | 2026-02-22 | Prompt parity: Gemini system prompt rewrite, native general subagent prompts              |
| [4](./PROMPT_ITERATIONS/2026-02-23-anthropic-inquiry-mode.md)  | 2026-02-23 | Anthropic inquiry mode: distinguish questions from directives                             |
| [5](./PROMPT_ITERATIONS/2026-02-24-qwen-prompt-sync.md)        | 2026-02-24 | Default prompt sync: full codemaxxxing prompt for GLM and non-Claude models               |
| [6](./PROMPT_ITERATIONS/2026-04-11-caveman-agent.md)           | 2026-04-11 | Caveman agent: ultra-terse primary agent, terse subagent output rules                     |
| [7](./PROMPT_ITERATIONS/2026-05-06-wave-system.md)             | 2026-05-06 | Wave system overhaul: verifier agent, retry/escalation FSM, conversational user pause     |

### System prompts

The Anthropic, Gemini, and default (GLM/Qwen/other) system prompts have all been rewritten with our flavour:

- **Anti-over-engineering** — don't add features, abstractions, error handling, or comments beyond what was asked
- **Inquiry vs directive awareness** — distinguish questions and discussions from action requests; don't start implementing when the user is exploring ideas
- **Security awareness** — actively watch for OWASP top 10 vulnerabilities in generated code
- **No time estimates** — never predict how long tasks will take
- **Blast radius awareness** — freely take reversible actions, flag destructive ones before proceeding
- **Parallelism** — the prompts encourage parallel tool calls and parallel subagent launches wherever independent work exists. This keeps sessions shorter, context cleaner, and is what makes patterns like the wave runner practical.

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

Both are read-only — they never modify source code. Both produce plans with the same required sections: context, codebase analysis, approach, changes, dead ends, verification, and dependencies. Either plan can be fed into the wave runner.

Use `/mode plan` when you're still figuring out what you want — you have a rough idea but need to talk through the approach, explore tradeoffs, and refine scope as you go. Use `plan_structured` when you already know what needs to happen and just need the agent to survey the codebase and document the execution path.

### Subagent permissions

The explore agent's bash access is locked down with explicit deny rules for destructive commands (`rm`, `git push`, `npm install`, etc.) while allowing read-only commands (`ls`, `find`, `git log`, etc.).

### Caveman agent

A custom primary agent that produces ultra-terse output — ~75% fewer output tokens while keeping full technical accuracy. Based on [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman). Switch to it via the agent selector.

The system prompt is a 1:1 copy of `anthropic.txt` with caveman communication rules prepended. Rules are sourced from the caveman skill's core SKILL.md (ultra mode: abbreviations, arrows, fragments) and the compress skill's SKILL.md (granular remove/preserve/structure spec). The TodoWrite examples are rewritten in caveman style for consistency.

The `build` agent remains the default for normal conversational use. We use `caveman` when we want maximum speed and token efficiency and don't need verbose explanations.

Both the general and explore subagent prompts also have caveman output rules — tailored to each agent's role:

- **General subagent**: terse implementation reporting. No progress narration. State file changed, what changed, why. Failure reports state what was tried and where blocked.
- **Explore subagent**: terse search findings. No search narration. Lead with file path + line number. Group by area, not search order.

Subagent caveman rules are always active regardless of which primary agent is selected — they reduce token usage in agent-to-agent communication where no human reads the output.

### Custom agents

The `general` subagent prompt now ships natively (see [General subagent](#general-subagent) above). The remaining custom agents in `custom_agents/` need to be copied to your config directory:

```bash
cp custom_agents/docs.md custom_agents/plan_structured.md custom_agents/wave_plan.md custom_agents/wave_verify.md ~/.config/opencode/agent/
```

- **docs** — technical documentation writer with specific style constraints (short chunks, imperative headings, relaxed tone)
- **general** — custom system prompt for the general subagent. Now shipped natively (iteration 3) — this file remains as a reference. See [General subagent](#general-subagent) above.
- **plan_structured** — structured planning with a 4-phase pipeline: survey (parallel explore subagents), organize, write, verify. You provide the task upfront; the agent's value-add is thorough codebase survey and structured documentation. Asks questions on genuine ambiguities. Read-only — never modifies source code.
- **wave_plan** — wave decomposition. Takes a plan markdown file and produces a campaign under `.wave/campaigns/<id>/` — `AGENT_INSTRUCTIONS.md`, `OVERVIEW.md`, `STATE.md`, and per-wave `WAVE.md` files. Read-only outside `.wave/`. Loop-managed after the first decomposition. See [Wave runner](#wave-runner) above.
- **wave_verify** — wave review + amendment. Auto-runs after every decomposition (sanity-checks the plan against reality) and again whenever a wave fails in a way that suggests the spec itself is wrong. Patches the plan in place, escalates to user if it can't decide alone. Broad permissions; behaviorally constrained to `.wave/`. See [Wave runner](#wave-runner) above.

## If you ever fork this

The prompts contain our identity. If you happen to be using this — fork it, change the identity in these files first:

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
