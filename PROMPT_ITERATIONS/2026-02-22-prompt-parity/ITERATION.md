# Iteration 3: Prompt parity — Gemini system prompt, general subagent prompts, Anthropic subagent prompt

**Date**: 2026-02-22

## Discovery

Three issues surfaced after iterations 1-2 established the Anthropic main prompt and explore agent:

1. **Gemini system prompt needed our flavour.** The upstream `gemini.txt` was still the OpenCode default — minimal, prescriptive in the wrong places, and missing our customisations from `anthropic.txt`. We're mostly Opus/Sonnet-geared but have been testing Gemini 3.1 for tasks too, so the Gemini prompt needed the same treatment.

2. **General subagent inherited the parent's system prompt verbatim.** Upstream OpenCode's general agent has no `prompt` field — it falls back to the parent's full system prompt. This means a Claude general subagent received the entire `anthropic.txt`, including instructions about docs lookup and TodoWrite emphasis that are irrelevant to a task-executing subagent. We had a custom agent in `custom_agents/general.md` that addressed this, but it required manual installation to `~/.config/opencode/agent/`.

3. **No Gemini-specific subagent prompt existed.** Even after solving #2, the general subagent prompt was designed for Claude's response patterns. Gemini needs prescriptive framing (positive instructions over prohibitions), explicit context efficiency guidance, and a structured development lifecycle — insights captured in the LEARNINGS.md research.

## Research

Extensive research was conducted to inform the Gemini prompt design. Full findings are in [LEARNINGS.md](LEARNINGS.md). Key sources:

- **OpenCode upstream source** — prompt selection in `system.ts`, prompt assembly in `llm.ts`, provider transforms in `transform.ts`. Compared the upstream Anthropic and Gemini prompts to understand the nuances between how OpenCode prompts each model family differently.
- **Gemini CLI source** (`github.com/google-gemini/gemini-cli`) — how Google's own engineers and model creators prompt Gemini: compositional prompt architecture with ~20 render functions, runtime feature flags, context efficiency section, Directives/Inquiries paradigm, Research-Strategy-Execution lifecycle
- **Theo Browne's Gemini 3.1 Pro review** (February 2026) — tool calling failure modes, 100-line chunked reads, loop detection, guidelines having outsized effect on Gemini, over-prompting causing deliberation overhead
- **Convex leaderboard data** — Gemini jumped from 89% to ~95% with guidelines (largest improvement of any model tested)

Key design decisions informed by research:

- **Prescriptive over prohibitive framing** (Observation 27): Gemini responds better to "Keep changes scoped to the request" than "Don't add features beyond what was asked." Both the Gemini main prompt and subagent prompt use positive instructions throughout.
- **Context Efficiency section** (Observation 10): Unique to the Gemini CLI, absent from all OpenCode prompts. Teaches the model about its own token economics — reducing sequential reads, combining turns, preferring grep over reading files individually. Added to both Gemini prompts.
- **Directives vs Inquiries** (Observation 11): Formalized distinction between action requests and analysis requests. Helps Gemini avoid modifying files when asked "how does X work?"
- **Research-Strategy-Execution lifecycle** (Observation 26): Nested inner loop (Plan-Act-Validate) within each execution sub-task. More structure than Anthropic needs but measurably improves Gemini's output quality.
- **Explain Before Acting** (Observation 24): Gemini tends toward silent tool invocation. Explicit mandate to narrate intent before tool calls.
- **Scope Discipline** (Observation 21, 29): Gemini deletes files outside task scope more than Claude. Explicit "Do not modify or delete files outside the scope of the current task" added.
- **TodoWrite included** (Observation 4, 18): Upstream deliberately excluded TodoWrite from Gemini. Our research suggests this was wrong — the model was likely RL'd on planning but not planning tools. Including it with explicit structure addresses the gap.

## Solution

### Source code change: Native general subagent prompt resolution (`agent.ts`, `llm.ts`)

Previously, the general subagent had no `prompt` field, so it inherited the parent's system prompt. We added `Agent.resolvePrompt()` in `agent.ts:318-325` which:

- Returns the agent's `prompt` if set (custom agents still work)
- For the native general agent, selects `PROMPT_GENERAL_ANTHROPIC` if the model ID contains "claude", otherwise `PROMPT_GENERAL_GEMINI`
- Returns `undefined` for other agents (they fall through to their own prompts for custom agents, or the system prompt as a final fallback)

`llm.ts:68` now calls `Agent.resolvePrompt()` instead of directly reading `input.agent.prompt`. This eliminates the manual step of installing `custom_agents/general.md` to `~/.config/opencode/agent/`.

### Gemini main system prompt (`packages/opencode/src/session/prompt/gemini.txt`)

Complete rewrite. Changed from 155-line upstream prescriptive-but-unfocused prompt to 218-line prompt with feature parity to our `anthropic.txt`, adapted for Gemini's response patterns:

**Added** (not in upstream):

- codemaxxxing identity and docs lookup
- Core Mandates: Security & Integrity, Context Efficiency, Engineering Standards, Scope Discipline, Directives vs Inquiries, Explain Before Acting, Professional Objectivity
- Development Lifecycle: Research-Strategy-Execution with nested Plan-Act-Validate
- Task Management with TodoWrite and examples
- Reversibility and blast radius
- Tool Delegation with explore agent patterns and parallel examples
- Code References with `file_path:line_number` pattern
- Time estimate prohibition

**Removed** (from upstream):

- "New Applications" workflow (2-page app scaffolding procedure)
- "Operational Guidelines > Security and Safety Rules" section (moved to Core Mandates)
- "Interaction Details" section (help command, bug reporting)
- "Final Reminder" paragraph (research shows over-prompting hurts newer Gemini models)
- Verbose examples (replaced with concise versions)

**Reframed** (prohibitive to prescriptive):

- "Don't add features beyond what was asked" -> "Keep changes scoped to the request"
- "Don't add error handling for impossible scenarios" -> "Trust internal code and framework guarantees"
- "Don't create helpers for one-time operations" -> "Prefer inline logic for one-time operations"

### Anthropic general subagent prompt (`packages/opencode/src/agent/prompt/general/anthropic.txt`)

Based on `custom_agents/general.md`, modified to give behavioral parity with the main `anthropic.txt`:

- Professional objectivity section (anti-sycophancy adapted for subagent context)
- Over-engineering avoidance with full anti-pattern list
- Blast radius awareness (flag destructive actions in response rather than checking with user)
- Tool delegation with explore agent patterns
- Structured response format: detailed writeup, absolute paths, code snippets, explicit failure reporting
- `<system-reminder>` awareness

### Gemini general subagent prompt (`packages/opencode/src/agent/prompt/general/gemini.txt`)

New file. Crafted from learnings — the Gemini-adapted equivalent of the Anthropic subagent prompt:

- Core Mandates structure: Security & Integrity, Context Efficiency, Engineering Standards, Scope Discipline, Directives vs Inquiries, Professional Objectivity
- Development Lifecycle with Research-Strategy-Execution and nested Plan-Act-Validate
- Prescriptive framing throughout
- Context efficiency guidance (read sufficient ranges, parallel searches, combine turns)
- Same response format as Anthropic subagent (absolute paths, code snippets, failure reporting)

## Observe

Watch for these behaviors:

- Does Gemini's main prompt perform comparably to Anthropic's in daily use? Key metrics: follows TodoWrite, avoids over-engineering, narrates before tool calls, validates changes before declaring done.
- Does the Gemini general subagent stay scoped to tasks or does it still exhibit scope creep?
- Does the context efficiency guidance actually reduce sequential 100-line read patterns?
- Does the Directives/Inquiries distinction prevent unwanted file modifications on "how does X work" questions?
- Is there a regression from removing the "Final Reminder" paragraph?
- Do custom agents defined in `.opencode/agent/` config still override the native prompts correctly?
