# Iteration 2: Explore agent delegation patterns

**Date**: 2026-02-22

## Discovery

The explore agent itself works well when given focused tasks. The problem is how the main agent delegates to it. Three failure patterns observed in daily use:

1. **One broad agent instead of multiple focused ones.** The main agent sends a single explore agent a sweeping prompt like "find how auth works — look at JWT, sessions, permissions, middleware, and the user model" instead of splitting into 3-4 parallel agents each targeting one concern. The explore agent runs on Gemini 3 Flash — a smaller, faster model with a large context window but less reasoning capability than the primary model. When given a broad mandate it reads too many files, fills its context with irrelevant code, and returns shallow or incomplete answers.

2. **Using explore as a file reader.** The main agent sometimes tells the explore agent "give me all the code from session.ts, cleanup.ts, and scheduler.ts" — using it as a glorified `cat`. This wastes an agent invocation, doubles context cost (explore reads the files into its context, copies them into the response, then the main agent has them too), and adds zero intelligence. The main agent could have just used Read directly.

3. **Raw code dumps instead of findings.** Even when the explore agent is given a reasonable question, it sometimes returns entire file contents in its response instead of concise findings with file paths and line numbers. The main agent then has hundreds of lines of raw code in its context that it may not need.

## Research

We examined how other coding harnesses handle explore/search subagents:

### Claude Code (v2.1.50, via [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts))

- Explore agent is called a "file search specialist" and is described as "meant to be a fast agent that returns output as quickly as possible"
- Runs on Haiku (their smallest model) — same asymmetric pattern as our Opus + Flash setup
- Has a generic "launch multiple agents concurrently whenever possible" instruction but nothing explore-specific about splitting broad tasks
- The conditional delegation prompt says "use explore when task needs more than 3 queries" but doesn't address how to scope each agent
- **Gap**: Same problem we have. No guidance on splitting broad exploration or avoiding code dumps. They likely get away with it because Haiku is specifically tuned for their system

### Cursor (Dynamic Context Discovery blog, Jan 2026)

- Architectural approach: write long tool outputs to files on disk, let the agent selectively grep/read what it needs
- Reduced total agent tokens by 47% in A/B testing
- Key insight: "Dynamic context discovery is far more token-efficient" — don't dump everything into context, let the consumer pull what it needs
- **Takeaway**: The right long-term fix is architectural (output-to-file), but prompt-level changes can address the immediate behavior

### Community: sub-agent-patterns skill ([playbooks.com](https://playbooks.com/skills/jezweb/claude-skills/sub-agent-patterns))

- Most detailed community guidance on subagent delegation
- States explicitly: "The primary value of sub-agents isn't specialization — it's keeping your main context clean"
- Recommends batch sizing: 5-8 items per agent, multiple agents in parallel
- Model quality warning: "Testing showed significant quality differences" between Haiku and Sonnet — Haiku produced wrong values, incorrect patterns. Directly validates our concern about Flash + broad scope
- 5-step delegation template: read, verify, check, evaluate, fix — structured, not open-ended

### CodeDelegator paper (Tencent, [arXiv:2601.14914](https://arxiv.org/pdf/2601.14914))

- "Using a single agent for both [planning and implementation] leads to context pollution from debugging traces and intermediate failures"
- Their fix: strict role separation. The delegator never executes, only writes specs

### Summary

Nobody has solved this at the prompt level specifically for explore agents. The innovations are architectural (Cursor's file-based context) or in community patterns (batch sizing, structured templates). Claude Code has the same vague guidance we did and works around it by model tuning. For our setup (primary model + smaller explore model), we need to go further than any existing harness at the prompt level.

## Solution

Four files changed:

### `packages/opencode/src/tool/task.txt`

Added a dedicated "Explore agent delegation" section with five rules:

- Ask questions, don't request code dumps. If you know the file paths, use Read directly
- Split broad exploration into multiple parallel explore agents, each targeting one concern or area (not individual files)
- Expect findings back (paths, line numbers, brief explanations), not raw code
- Always specify a thoroughness level so the explore agent knows how deep to go
- Give starting points (directories, file patterns) so the agent doesn't search blindly

Replaced the "Good" example that demonstrated the exact anti-pattern (one agent asked to cover JWT + sessions + permissions) with:

- A focused single-agent example
- A parallel split example showing 3 agents each targeting one area

### `packages/opencode/src/session/prompt/anthropic.txt`

Updated the tool usage policy's explore guidance to include:

- "prefer multiple focused agents in parallel over one broad agent"
- "do not use explore to read files you already know the path to — use Read directly"
- Replaced the generic "codebase structure" example with a parallel auth exploration example

### `packages/opencode/src/agent/agent.ts`

Appended to the explore agent description:

- "Works best with focused scope — for broad questions, prefer spawning multiple explore agents in parallel, each targeting a specific area"
- "Do not use as a file reader — if you know the paths, use Read directly"

### `packages/opencode/src/agent/prompt/explore.txt`

Changed the response format rule from encouraging full code inclusion to:

- "Include only the relevant code — key function signatures, critical logic blocks, configuration values. NEVER reproduce entire file contents. The parent agent can Read specific files if it needs more."

## Observe

Watch for these behaviors in the next week of use:

- Does the main agent actually split broad exploration into parallel agents? Or does it still default to one?
- Does the main agent still use explore to read known files, or does it use Read directly?
- Are explore agent responses more concise (findings + paths) vs raw code dumps?
- Is there a quality regression from the explore agent being too terse? (We may have over-corrected — if findings are too sparse the main agent may need to send follow-up agents)
- Do the starting-point hints in explore prompts actually improve search efficiency?

If the splitting behavior improves but explore agents are returning too little context, the next iteration should adjust the explore.txt response format to clarify what "concise" means — key function bodies are fine, entire 200-line files are not.
