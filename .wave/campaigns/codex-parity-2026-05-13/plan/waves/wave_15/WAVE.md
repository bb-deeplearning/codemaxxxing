# Wave 15 — Spec doc

**Prior waves:** 0-14. All code shipped, all tests green, perf within budget, backward compat verified.

**Also read:** `OVERVIEW.md`. (No code constraints relevant; this is documentation.)

## Goal

Write the formal spec at `specs/codex-parity.md` documenting what shipped. Match the tone of existing specs (`specs/tui-render-freeze.md` is a good template — terse, code-grounded, file:line references where useful).

## Tasks

### 1. Read existing specs for tone

`specs/tui-render-freeze.md`, `specs/project.md`. Match the voice.

### 2. Write the spec

Sections to cover:

- **Summary** — one paragraph. What shipped, what changed.
- **unified_exec** — tool surface (link to source files), constants (link to `CONSTANTS.md` if you want or inline), behavior, backward compat
- **multi_agents_v2** — tool surface, agent role system, mailbox semantics, coordination patterns, backward compat
- **TUI changes** — what's new in the session route, footer, dialogs; perf characteristics
- **System prompts** — the new fragments, when they inject, what they teach
- **Permissions** — new keys, default policies per built-in agent
- **Performance** — link to `artifacts/perf-final-report.md` from Wave 14; summarize: nothing regressed beyond budget
- **Backward compatibility** — what's guaranteed; what users notice (nothing if they don't use the new tools)
- **Testing** — how the campaign was verified (TDD throughout, 100% coverage on touched code, perf measured, no live LLM in perf)

### 3. Reference the campaign

At the bottom: link to `.wave/campaigns/codex-parity-2026-05-13/` as the campaign archive. Future readers can replay the wave-by-wave decisions if needed.

## Gotchas

1. **No marketing copy.** This is a technical spec. "We are excited to introduce..." is wrong tone. "ships X" is right tone.

2. **Link, don't inline.** If the constants table is in `CONSTANTS.md`, link to it. The spec is the entry point, not the duplicating source.

3. **Don't re-explain implementation details that the code already documents.** The code is the spec; this doc summarizes the surface and the contract.

## Verification

```bash
cd /Users/rohan/Documents/Personal/codemaxxxing
test -f specs/codex-parity.md
# Optional: render with markdown linter if one is configured
```

## Files

New:
- `specs/codex-parity.md`

Modified: none.
