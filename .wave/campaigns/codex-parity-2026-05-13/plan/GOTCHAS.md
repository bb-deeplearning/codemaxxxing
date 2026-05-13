# Gotchas — append-only knowledge base

This file is APPEND-ONLY by every wave's executor. If you hit a sharp edge — a regression, a non-obvious bug, a performance landmine, a framework quirk that took >15 minutes to figure out — write it here BEFORE you finish the wave so the next executor doesn't pay the same cost.

## How to read

On wave entry, after reading STATE.md and OVERVIEW.md, **read this file end-to-end**. Match every entry against the surfaces your wave touches. If any entry applies to your work, the entry is your work — don't relearn it.

## How to write

When you discover something worth recording:

1. Add a new section at the BOTTOM of the file (preserve existing entries verbatim).
2. Use the format below.
3. Commit your gotchas as part of the wave's outcome commit.

### Entry format

```markdown
## [<short slug>] <one-line title>

**Discovered in:** wave_<N>
**Date:** YYYY-MM-DD
**Surfaces affected:** <which files / which subsystem / what kind of work triggers it>
**Severity:** <perf-regression | correctness-bug | DX-trap | API-quirk>

### Symptom

<what you saw, observably, that was wrong or surprising>

### Root cause

<one paragraph explaining why>

### Fix pattern

<concrete: how to avoid this in future code, with a one-line code example if helpful>

### Reference

<link to specs/, commits, or external docs that have the long-form story>

---
```

Keep entries terse. Two paragraphs is plenty. Link to the long-form source (a spec doc, a commit, a wave's NOTES.md) for depth — don't restate it here.

---

## [tui-flex-row-with-tall-text] opentui freezes when a flex-row contains a tall `<text>` child

**Discovered in:** pre-campaign (4 separate regressions over 2 weeks; documented in `specs/tui-render-freeze.md`)
**Surfaces affected:** any TUI rendering touching `routes/session/index.tsx`, `BlockTool`, `InlineTool`, message body components, anything rendering MCP / LLM / user-pasted text
**Severity:** perf-regression (catastrophic — paint stalls past the failing node, looks like total session freeze)

### Symptom

Streaming visually halts mid-message. Reactivity in Solid keeps firing into the store (verified with `RENDER_DEBUG=1`), new messages mount, deltas accumulate — but **none of it appears on screen**. The screen freezes at whatever was rendered before the boundary. Sending a new message reveals the next chunk of the prior frozen content. Same data renders fine in upstream OpenCode.

### Root cause

opentui is a naive measure-then-paint renderer on a 2D character grid. A `<box flexDirection="row">` whose primary cell is a `<text>` that can wrap to many rows (or a syntax-highlighted block, or any variable-tall content) silently exceeds opentui's internal layout-measurement budget. When it does, paint stalls past the failing node and **everything subsequent stops rendering** — later parts in the same message, later messages, even unrelated UI elsewhere on screen.

The CSS-style `<row><text/><pill/></row>` with `justifyContent="space-between"` pattern that's free in browsers (retained-mode compositing, GPU reflow) is O(W × H) per render in opentui and silently fails past an undocumented budget.

This bug class hit the codebase **four times** in two weeks before the proactive sweep (commits `23e0e84f6`, `bf03d6396`, `77dd69854`, plus `568da2532`).

### Fix pattern

- **Never wrap a child whose content can grow tall in `<box flexDirection="row">`.**
- Stack as vertical siblings instead. Or use absolute positioning for fixed-width chrome (e.g. marginalia in a left gutter — pattern in `23e0e84f6`).
- **Don't use `wrapMode="word"` on text nodes that can hold user-pastable / multi-KB content.** Default wrap is correct.
- **Sanitize any string that flows from `props.input.<arbitrary-key>` into a `<text>` node** — collapse whitespace, cap length. Use `@tui/util/inline-safe` (`packages/opencode/src/cli/cmd/tui/util/inline-safe.ts`).

### Audit checklist when touching the render hot path

1. `rg 'flexDirection="row"' packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — for each hit, ask "could the primary child of this row ever be tall?" If yes, restructure.
2. `rg 'wrapMode="word"' packages/opencode/src/cli/cmd/tui/` — for each hit, ask "can this text node ever hold user-pasted or multi-KB content?" If yes, drop the attribute.
3. `git diff upstream/dev..HEAD -- <file>` — if the fork has structural nodes (boxes, rows, attributes) that upstream doesn't in a render-hot-path component, that's a regression suspect by default. Burden of proof is on the fork.
4. Anything that interpolates an arbitrary string into a `<text>` node — sanitize via `inline-safe`.

### Reference

- Full investigation: `specs/tui-render-freeze.md` (487 lines, four manifestations + proactive sweep)
- Sanitizer: `packages/opencode/src/cli/cmd/tui/util/inline-safe.ts`
- Key fix commits: `23e0e84f6`, `bf03d6396`, `77dd69854`, `568da2532`

---
