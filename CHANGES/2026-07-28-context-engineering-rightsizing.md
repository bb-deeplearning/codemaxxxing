# Changes: Context-engineering rightsizing — judgment over rules, dedup over repetition

**Date**: 2026-07-28

Iteration 11 ([PROMPT_ITERATIONS/2026-07-28-context-engineering-rightsizing.md](../PROMPT_ITERATIONS/2026-07-28-context-engineering-rightsizing.md)). Second overhaul of the fable-5 era, applying the guidance iteration 10 missed: Anthropic's context-engineering article (2026-07-24, the "removed over 80% of Claude Code's system prompt" piece) and the residue of the fable field guide. Net deletion pass: rules that fought judgment (and one that fought the intended artifact workflow) removed, worked examples removed, prose stated 2-3× per assembled context deduplicated to single homes, and a second specimen of iteration 10's phantom-tool class (bash, gone from the model's view since Wave 4) purged from every prompt surface. The subagent delivery contract + ABORT protocol kept verbatim — the article's "highly important areas" carve-out.

## Prompt surfaces (line counts before → after)

- `session/prompt/anthropic.txt` — 101 → 56. Examples (TodoWrite/explore/code-ref) and the TodoWrite section deleted (tool description owns it); "NEVER create files" → working-artifacts judgment line (unblocks implementation notes, prototypes, plan docs); comment rules → the CC two-liner ("write code that reads like the surrounding code"); over-engineering block compressed to its judgment core; routing/ratchet dedup to pointers; new consolidated "# Harness" section; unknowns-surfacing sentence added; "Reserve Bash" → exec_command.
- `agent/prompt/general/anthropic.txt` — 70 → 48. Same treatment in the worker register; delivery-contract pointer, ABORT reference, Completing-the-task and Response-format blocks intact.
- `agent/prompt/explore.txt` — 75 → 52. Caps-lock prohibition block → two calm lines (toolset enforces read-only); phantom Bash bullet deleted (explore denies exec_command — it had no shell at all since Wave 4); parallel patterns compressed. Thoroughness levels, response format, reporting style + template kept (sonnet-5 low-effort register).
- `agent/prompt/multi-agent-root.txt` — 121 → 58. Sections duplicated verbatim in `agent-spawn.txt` (When to delegate / When NOT / Scoping / After you delegate / Subagents / Cost bodies) and mechanics stated in wait/pool tool descriptions deleted; cross-tool discipline kept and compressed (decide-before-spawning, writer isolation + brief requirements, mailbox drain, CC/coordinator/chain patterns, Limits, Wait timeouts, Model-routing pointer). All prose pins preserved.
- `agent/prompt/multi-agent-subagent.txt` — 91 → 66. Delivery contract + ABORT verbatim; context/spawn/messaging compressed; behavior-contract section 14 lines → 1 paragraph with every pinned token and the after-ABORT order intact.
- `agent/prompt/persistent-processes.txt` — 34 → 5. Bash-vs-exec_command framing (phantom since Wave 4) deleted; now the one-shot-vs-persistent split within exec_command + the spawn-time flags (`tty`, `detach`); operational detail deferred to the two tool descriptions.
- Phantom-bash idiom fixes, registers untouched: `agent/prompt/general/gemini.txt` (4 sites), `session/prompt/default.txt` (3), `codex.txt` (1), `kimi.txt` (2), `gemini.txt` (6, incl. the `[tool_call: bash ...]` example lines), `trinity.txt` (2). `gpt.txt` and `copilot-gpt-5.txt` bash mentions are shell-syntax/code-fence references — untouched.

## Audited, deliberately unchanged

`session/prompt/plan.txt`, `max-steps.txt`, `build-switch.txt`; `tool/agent-spawn/agent-spawn.txt` + process tool descriptions (tool descriptions are the designated single home); `~/.config/opencode/agent/worker.md` + `mule.md` (tier-appropriate explicit registers); non-Claude registers beyond the idiom fixes (the article's judgment guidance is scoped to Claude 5-gen models).

## Tests

`test/prose/subagent-prompts.test.ts`, `test/differential/prompt-prose.diff.test.ts`, `test/backward-compat/system-prompt-regression.test.ts`, `test/session/system.test.ts` — 100 pass / 0 fail at landing. No pin changes needed: the rewrite was constrained to preserve every pinned token, header, and section order.

## Per-machine config (`~/.config/opencode/` + `~/.claude/skills/`, bbtws; iris mirror pending)

- `AGENTS.md` — agent-browser discipline block (9 lines) → 3-line pointer at the skill, survival-critical minimum inline (worktree-scoped session id, close what you open). Escalation-ratchet sentence now single-homed here.
- `~/.claude/skills/agent-browser/SKILL.md` — new "## Machine discipline (bbtws)" section carrying the full six-rule block, loaded only when browser work starts.

## Docs

README (iteration table row 11, iteration count, explore section reworded off the deny-list claim, `general` pin corrected to Opus 5, stale `system.ts:101` ref → `:163`), `CHANGES/INDEX.md` rows, [PROMPT_ITERATIONS/2026-07-28-context-engineering-rightsizing.md](../PROMPT_ITERATIONS/2026-07-28-context-engineering-rightsizing.md), this file.
