# Changes: Default prompt sync — full codemaxxxing prompt for GLM and non-Claude models

**Date**: 2026-02-24
**Iteration**: [PROMPT_ITERATIONS/2026-02-24-qwen-prompt-sync.md](../PROMPT_ITERATIONS/2026-02-24-qwen-prompt-sync.md)

Replaced the stripped-down default prompt (`qwen.txt`) with the full codemaxxxing prompt. Previously, any model that didn't match `claude`, `gemini-`, `gpt-`, or `trinity` in the routing logic fell through to a minimal prompt without any of our fork's behavioral tuning. This affected GLM models and any other non-specifically-matched providers. The original stripping was a workaround for tool hallucination in Jul 2025 — the underlying issue was fixed in Sep 2025 (PR #2499) but the prompt was never restored. See the [iteration log](../PROMPT_ITERATIONS/2026-02-24-qwen-prompt-sync.md) for the full history.

## Prompts

- `packages/opencode/src/session/prompt/qwen.txt` — replaced with full codemaxxxing prompt (synced from `anthropic.txt`)
