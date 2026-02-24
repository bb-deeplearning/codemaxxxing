# Iteration 5: Default prompt sync — give GLM and other non-Claude models the full prompt

**Date**: 2026-02-24

## Discovery

GLM models (GLM-5, GPT-OSS-120B, GPT-OSS-20B) configured via the `glm-vertex` provider were getting a stripped-down system prompt (`qwen.txt`) instead of the full codemaxxxing prompt. This meant they had none of our fork's behavioral tuning: no anti-over-engineering, no inquiry vs directive awareness, no professional objectivity, no task management coaching, no blast radius awareness.

The prompt routing in `system.ts` matches models by ID substring — `claude` gets `anthropic.txt`, `gemini-` gets `gemini.txt`, `gpt-` gets `beast.txt`, etc. Anything that doesn't match falls through to `qwen.txt` (variable name: `PROMPT_ANTHROPIC_WITHOUT_TODO`). GLM models hit this default.

## Research

### Why `qwen.txt` existed at all

Traced the git history to understand the split:

1. **Jul 2025** — Dax added the TodoWrite tool and baked coaching into `anthropic.txt`.
2. **Jul 2025** (commit `df03e182d`, "strip todo tool instructions from non anthropic models") — Qwen models were hallucinating tool calls (`todo_write`, `TodoWrite`) because the system prompt mentioned todo instructions but the tool wasn't in their tool list. Dax created `qwen.txt` as a copy of the anthropic prompt minus the todo coaching, and made it the default for all non-Claude models.
3. **Sep 2025** — Issue #2498 asked to re-enable the todo tool for Qwen. PR #2499 re-enabled the tool for all models. But nobody re-added the prompt instructions.

So `qwen.txt` was a hallucination-prevention measure that became stale. The tool now exists for all models (registered in `registry.ts` without model gating), but the prompt coaching was never restored.

### Whether GLM models need different prompting

Searched for GLM-specific prompting guidance. Findings:

- The GLM-5 paper describes dedicated "Agentic RL" post-training for tool calling and multi-step workflows. GLM-5 scores 50.4% on HLE w/ Tools, beating Claude Opus (43.4%). These models are built for agentic tool use.
- GLM-5 API guides state "GLM-5 responds very well to system prompts" with no caveats about needing different styles.
- Community consensus: prompt style differences between frontier models have narrowed. When you tighten the spec, all models improve.
- GitHub issue #1336 commenter noted GLM models are "heavily trained using Claude Code" — they already expect Claude-style agentic prompts.

No evidence that GLM models need a stripped-down or differently-structured prompt.

## Solution

Replaced `qwen.txt` content with the full codemaxxxing prompt — identical to `anthropic.txt`. This gives all non-specifically-matched models (GLM, Qwen, and any future models that fall through to the default) the same behavioral tuning as Claude:

- Anti-over-engineering rules
- Professional objectivity
- Inquiry vs directive awareness
- Task management coaching with TodoWrite examples
- Blast radius awareness
- Explore agent delegation patterns
- Code reference format

**File changed**: `packages/opencode/src/session/prompt/qwen.txt` — full replacement with `anthropic.txt` content.

No routing logic changes. The `system.ts` provider function still falls through to `PROMPT_ANTHROPIC_WITHOUT_TODO` for unmatched models — the variable name is now misleading (it's no longer "without todo"), but renaming it would be a larger refactor for no behavioral benefit.

## Observe

- Do GLM models use TodoWrite appropriately when given multi-step tasks?
- Do they respect inquiry mode (not implementing when asked "how does X work?")?
- Do they follow anti-over-engineering constraints?
- Any tool hallucination issues? (The original reason for the split — should not recur since the tool is now registered for all models.)
- Token budget impact? The full prompt is longer than the old `qwen.txt` — watch for context window pressure on smaller models.
