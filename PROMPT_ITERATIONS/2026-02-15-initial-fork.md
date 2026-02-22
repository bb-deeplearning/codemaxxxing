# Iteration 1: Initial fork — baseline from Claude Code

**Date**: 2026-02-15
**Commit**: `abb154db540153403edb9e601c07cb232717d67b`

## Context

This wasn't a traditional observe-and-fix iteration. We switched from Claude Code to OpenCode as our harness and preferred Claude Code's prompting style as a baseline — OpenCode takes a more minimal approach to its system prompts, and we wanted the additional structure and guardrails that Claude Code's style provides. This was a preference, not a judgment on OpenCode's defaults.

## Research

We compared prompts across several harnesses to decide what to bring over and what to add:

- **Claude Code's system prompts** — primary reference for baseline style. We adopted its approach to anti-over-engineering guidelines, security awareness, blast radius awareness, and structured explore agent behavior.
- **Cline's system prompt** — cross-referenced for tool usage patterns and subagent delegation style.
- **Other harnesses** — surveyed how multiple harnesses prompt Gemini specifically (vs Claude), since our explore agent runs on Gemini 3 Flash. This informed the explore agent prompt structure — Gemini responds better to explicit prohibition lists, structured thoroughness levels, and concrete parallel tool call patterns than to the more implicit style Claude Code uses for its Haiku-based explore agent.

Beyond porting from Claude Code, we added new functionality that neither Claude Code nor OpenCode had:

- **Context isolation for subagents** — Claude Code's subagents have access to conversation history, so they don't need self-contained prompts. OpenCode's don't. We added explicit guidance requiring prompts to include absolute paths, code snippets, expected output format, and research-vs-code intent. This included good/bad prompt examples and overhead awareness (when to delegate vs use a direct tool call).
- **Explore agent prompt designed for Gemini** — not ported from Claude Code's Haiku-oriented explore prompt. We inferred the right prompting style from how other harnesses structure prompts for Gemini models.

## Solution

Full details in [CHANGES/2026-02-15-initial-fork.md](../CHANGES/2026-02-15-initial-fork.md). Summary:

- **Main prompt** (`anthropic.txt`): Adopted Claude Code's style — anti-over-engineering guidelines, security awareness (OWASP top 10), blast radius awareness, no time estimates, tightened tool usage policy with explore subagent preference for broad searches
- **Task tool** (`task.txt`): New — context isolation section, overhead awareness, self-contained prompt requirements with good/bad examples. Needed because our subagents don't share conversation history like Claude Code's do.
- **Explore agent** (`explore.txt`): Designed for Gemini — hard read-only enforcement with explicit prohibition lists, tool selection guidance, parallel tool call patterns, structured thoroughness levels (quick/medium/very thorough), machine-readable response format
- **Explore agent config** (`agent.ts`): Locked down bash with explicit deny/allow rules, rewrote description
- **Plan mode** (`plan.txt`): Full iterative planning workflow with explore-update-ask loop
- **Custom agents**: docs, general, plan_structured, wave_decompose

## Observe

With the baseline established, we monitored for behavioral issues that the ported/new prompts didn't cover. The main issue that surfaced was how the main agent delegates to the explore subagent — it sends one broad agent instead of multiple focused ones, and sometimes uses explore as a file reader. This became the focus of iteration 2.
