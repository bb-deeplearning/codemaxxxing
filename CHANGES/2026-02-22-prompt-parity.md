# Changes: Prompt parity — Gemini system prompt, general subagent prompts

**Date**: 2026-02-22
**Iteration**: [PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md](../PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md)

Gemini system prompt rewrite, native general subagent prompts for both Anthropic and Gemini, and source code changes to resolve subagent prompts by model. See the [iteration log](../PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) and [LEARNINGS.md](../PROMPT_ITERATIONS/2026-02-22-prompt-parity/LEARNINGS.md) for research and rationale.

## Source code

- `packages/opencode/src/agent/agent.ts` — added `Agent.resolvePrompt()` for model-specific general subagent prompt selection; custom agents via `.opencode/agent/` config still take precedence
- `packages/opencode/src/session/llm.ts` — changed prompt resolution to use `Agent.resolvePrompt()`

## Prompts

See [iteration log](../PROMPT_ITERATIONS/2026-02-22-prompt-parity/ITERATION.md) for full details on each prompt.

- `packages/opencode/src/session/prompt/gemini.txt` — complete rewrite with our flavour, adapted for Gemini's response patterns
- `packages/opencode/src/agent/prompt/general/anthropic.txt` — based on `custom_agents/general.md`, modified for parity with main `anthropic.txt`, now ships natively
- `packages/opencode/src/agent/prompt/general/gemini.txt` — Gemini-adapted equivalent of the Anthropic subagent prompt, crafted from LEARNINGS.md research
