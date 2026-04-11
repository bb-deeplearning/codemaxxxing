# Iteration 6: Caveman agent and terse subagent output

**Date**: 2026-04-11

## Discovery

LLM output is verbose by default. Even with the existing "short and concise" instruction in `anthropic.txt`, the model produces preamble ("Sure! I'd be happy to help..."), hedging ("it might be worth considering..."), self-narration ("I'm going to...", "Let me..."), and filler words (just, really, basically, actually). This wastes output tokens, slows response generation, and makes responses harder to scan.

The problem is worse for subagent communication. The general and explore subagents report back to a parent agent — no human reads their output. Yet they produce the same verbose prose: narrating their search process, explaining code they've already included as snippets, throat-clearing before findings. Every wasted token in a subagent response lands in the parent agent's context window and stays there.

## Research

### Caveman skill ([JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman))

A Claude Code skill that constrains LLM output to terse, caveman-like speech. 15k+ GitHub stars. Key claims:

- ~65-75% output token reduction across benchmarks (range: 22-87%)
- Full technical accuracy preserved — only prose fluff removed
- Three intensity levels: lite (professional but no fluff), full (drop articles, fragments OK), ultra (abbreviate everything, arrows for causality, maximum compression)

The repo contains four skills:

1. **`caveman/SKILL.md`** — core communication rules. Drop articles, filler, pleasantries, hedging. Fragments OK. Short synonyms. Technical terms exact.
2. **`caveman-compress/SKILL.md`** — the most granular compression spec. Explicit lists of what to remove (articles, filler, hedging, redundant phrasing, connective fluff) and what to preserve exactly (code blocks, inline code, URLs, file paths, commands, technical terms, proper nouns, dates, env vars). Structure preservation rules (headings, bullet hierarchy, tables).
3. **`skills/caveman-commit/SKILL.md`** — terse Conventional Commits format. Not relevant to general communication.
4. **`skills/caveman-review/SKILL.md`** — one-line code review format. Not relevant to general communication.

### Academic support

A March 2026 paper ["Brevity Constraints Reverse Performance Hierarchies in Language Models"](https://arxiv.org/abs/2604.00025) found that constraining large models to brief responses improved accuracy by 26 percentage points on certain benchmarks. Verbosity is not just a cost problem — it can actually hurt quality.

### Agent-to-agent communication

No prior art found on applying caveman-style compression specifically to subagent output. Existing approaches either compress the instructions (reducing input tokens) or compress the model's user-facing output. Compressing subagent responses is a natural extension — the consumer is another model, not a human, so readability constraints are even looser.

## Solution

Three files changed/created:

### `.opencode/agent/caveman.md` (new)

Custom primary agent defined via the markdown agent config system. Frontmatter sets `mode: primary` so it appears in the agent selector alongside `build` and `plan`.

The system prompt is a 1:1 copy of `anthropic.txt` with a caveman communication section prepended after the identity block. The caveman section merges rules from two repo sources:

- **From `caveman/SKILL.md`** (ultra mode): abbreviations list, strip conjunctions, arrows for causality, one-word-when-enough rule, pattern template, examples, auto-clarity exceptions (security warnings and destructive ops get full prose), boundary rule (code stays normal)
- **From `caveman-compress/SKILL.md`** (compression mechanics): explicit remove list (articles, filler, pleasantries, hedging, redundant phrasing, connective fluff, throat-clearing, self-narration), explicit preserve list (code blocks, inline code, URLs, file paths, commands, technical terms, proper nouns, dates, env vars, error messages), structure preservation (headings, bullet hierarchy, numbered lists, tables)

The TodoWrite examples from `anthropic.txt` were rewritten in caveman style to avoid contradicting the communication rules.

Commit and review skills were excluded — they're separate task-specific tools, not communication style.

### `packages/opencode/src/agent/prompt/general/anthropic.txt` (modified)

Added a `# Caveman output rules` section after the existing response format rules. Tailored for the general subagent's role as a task executor reporting to a parent agent:

- **What to remove**: same base list as the main caveman agent, plus "progress narration" — general subagents tend to narrate their implementation process step by step, which the parent doesn't need
- **What to preserve**: focused on what the parent agent actually needs — code blocks as implementation evidence, absolute file paths for tool calls, error messages for debugging
- **How to compress**: same abbreviation and arrow rules, plus subagent-specific guidance — "state file, what changed, why" for success reports; "what was tried, where blocked, what parent should check" for failures
- **Examples**: implementation reporting ("Added auth middleware at path:line. Checks JWT. Handles expired tokens → 401.") and task-blocked scenarios ("Task blocked. DB config not found at expected path. Searched dirs — no matches. Parent: check actual config location.")
- **Boundary**: code output stays normal

### `packages/opencode/src/agent/prompt/explore.txt` (modified)

Added a `# Caveman output rules` section after the existing response format rules. Tailored for the explore agent's role as a read-only search agent:

- **What to remove**: same base list, plus explore-specific anti-patterns — "narrating your search" (parent doesn't need search logs), "explaining what code does when the snippet is included" (parent can read code), "restating the question before answering"
- **What to preserve**: focused on search evidence — code snippets as evidence, absolute file paths, line numbers (critical for parent navigation), function/class/variable names in backticks
- **How to compress**: same abbreviation and arrow rules, plus explore-specific guidance — "lead with file path + line number, then finding", "group by area not search order", "no 'I found' prefix"
- **Examples**: location-annotated findings format and explicit negative reporting ("No session mgmt found in dirs X, Y, Z.")
- No boundary rule needed — explore never writes code

## Observe

Watch for these behaviors:

- Does the caveman agent actually produce terse output, or does it drift back to verbose prose after a few turns?
- Are subagent responses noticeably shorter? Measure token counts on a few representative tasks before/after.
- Does the parent agent handle terse subagent responses correctly, or does it ask follow-up questions due to insufficient detail?
- Is the explore agent too terse? The existing "concise snippets, not file dumps" rule already pushed toward brevity — caveman on top of that might over-compress findings.
- Does the general subagent's failure reporting still give the parent enough to act on, or does caveman compression strip useful context?
- Do the TodoWrite examples in caveman style actually teach the model the right behavior, or does it need more examples?
