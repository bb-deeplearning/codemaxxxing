# Changes: Anthropic inquiry mode — distinguish questions from directives

**Date**: 2026-02-23
**Iteration**: [PROMPT_ITERATIONS/2026-02-23-anthropic-inquiry-mode.md](../PROMPT_ITERATIONS/2026-02-23-anthropic-inquiry-mode.md)

Added a "Responding to requests" section to the Anthropic system prompt to prevent Claude from jumping to implementation when the user is asking a question or discussing an approach. Adapted from the Gemini prompt's Directives/Inquiries paradigm but rewritten in Claude's prohibitive/conversational style. See the [iteration log](../PROMPT_ITERATIONS/2026-02-23-anthropic-inquiry-mode.md) for rationale.

## Prompts

- `packages/opencode/src/session/prompt/anthropic.txt` — added `# Responding to requests` section between "Professional objectivity" and "Task Management"
