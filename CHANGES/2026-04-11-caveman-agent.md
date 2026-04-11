# Changes: Caveman agent and terse subagent output

**Date**: 2026-04-11
**Iteration**: [PROMPT_ITERATIONS/2026-04-11-caveman-agent.md](../PROMPT_ITERATIONS/2026-04-11-caveman-agent.md)

New caveman custom agent (ultra-terse primary agent) and caveman output rules added to both subagent prompts. See the [iteration log](../PROMPT_ITERATIONS/2026-04-11-caveman-agent.md) for rationale.

## New files

- `.opencode/agent/caveman.md` — custom primary agent. 1:1 copy of `anthropic.txt` system prompt with caveman communication rules prepended. Ultra-terse output: drops articles, filler, pleasantries, hedging; abbreviates aggressively; arrows for causality; fragments OK. Code output stays normal. Auto-clarity exceptions for security warnings and destructive actions.

## Modified files

- `packages/opencode/src/agent/prompt/general/anthropic.txt` — added `# Caveman output rules` section to response format. Tailored for implementation reporting: terse status-log style, no progress narration, failure reports state what was tried and where blocked.
- `packages/opencode/src/agent/prompt/explore.txt` — added `# Caveman output rules` section to response format. Tailored for search findings: no search narration, lead with file path + line number, group by area not search order, no "I found" prefix.
