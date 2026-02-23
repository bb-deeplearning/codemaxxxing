# Iteration 4: Anthropic inquiry mode — distinguish questions from directives

**Date**: 2026-02-23

## Discovery

Claude defaults to implementation mode. When a user discusses trade-offs, asks how something works, or says something "should" change, Claude starts editing files immediately instead of discussing first. The user has to explicitly say "don't implement yet" to get a conversation.

The Gemini prompt already handles this with a formal "Directives vs Inquiries" paradigm (added in iteration 3). Claude needed the same behavioral constraint but adapted to its prompting style.

## Research

The Gemini prompt's approach uses named paradigms and prescriptive framing — formal categories, explicit default assumptions, rigid rules. Per LEARNINGS.md Observations 11 and 27, this works for Gemini because it responds well to structured taxonomies and positive instructions.

Claude doesn't need the scaffolding. It responds well to direct prohibitive instructions and conversational framing. The Anthropic prompt already uses patterns like "NEVER propose changes to code you haven't read" and "Don't add features beyond what was asked" — short, direct behavioral constraints.

The design decision: no named paradigm, no formal taxonomy. Instead, a direct behavioral instruction with concrete signal words for when to act vs when to discuss.

## Solution

Added a `# Responding to requests` section to `packages/opencode/src/session/prompt/anthropic.txt`, placed between "Professional objectivity" and "Task Management" — before task management because this determines _whether_ you enter task mode at all.

The section:

```
# Responding to requests
Not every user message is a request to write code. When the user asks how something works, discusses trade-offs, or explores ideas, respond with analysis and explanation — do not start modifying files. Only make changes when the user gives a clear instruction to do so (e.g. "fix this", "add X", "refactor Y"). When the instruction is ambiguous — the user says something "should" change or "might need" updating — clarify intent before acting. For clear directives, work autonomously without unnecessary confirmation.
```

Key style differences from the Gemini version:

- No named paradigm (no "Directives" / "Inquiries" labels)
- Prohibitive framing: "do not start modifying files" vs Gemini's prescriptive "research and analyze"
- Concrete signal words for when to act ("fix this", "add X", "refactor Y")
- Shorter — Claude doesn't need the scaffolding
- Preserves the trust-based "work autonomously" for clear cases

## Observe

- Does Claude stop jumping to implementation when asked "how does X work?" or "I think X could be cleaner"?
- Does it still act autonomously on clear directives ("fix the bug in X", "add Y to Z")?
- Does it correctly identify ambiguous cases and ask for clarification?
- Does this interact well with the existing "Professional objectivity" section (which encourages investigation over instinctive confirmation)?
