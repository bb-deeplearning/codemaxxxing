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

## [bun-coverage-line1-quirk] bun's `--coverage` reports the first import line as 0 hits

**Discovered in:** wave_0
**Date:** 2026-05-13
**Surfaces affected:** any new file that needs to report 100% line coverage on `bun test --coverage`
**Severity:** DX-trap

### Symptom

`bun test --coverage path/to/foo.test.ts` shows ~99% line coverage on `foo.ts` even when every executable line in the file is exercised. The lcov data shows `DA:1,0` (line 1, 0 hits) for the first import statement.

### Root cause

Bun's V8-backed coverage instruments differently depending on the import shape and order. A default-style import (`import path from "path"`) on line 1, or a comment on line 1, can report as 0 hits even though the import is evaluated. Reordering the imports so that line 1 is something like `import * as fs from "node:fs/promises"` (namespace import from a node-prefixed builtin) makes it report correctly.

### Fix pattern

If you see "100% on harness" verification fail at ~99% line coverage with only line 1 missing:

1. Reorder imports so line 1 is `import * as <name> from "node:<builtin>"` rather than a default import or a comment.
2. Don't waste cycles trying other shapes — the order is the lever.

### Reference

- See `packages/opencode/test/lib/perf.ts` line 1 for the working order.

---

## [opentui-testRender-leak] `testRender` from `@opentui/solid` allocates native resources per call

**Discovered in:** wave_0
**Date:** 2026-05-13
**Surfaces affected:** TUI bench files in `test/perf/baseline/*.bench.tsx`, future Wave 4 + Wave 11 TUI benches
**Severity:** perf-regression (unbounded memory growth across iterations)

### Symptom

A benchmark that calls `testRender` per sample (e.g. measuring "first paint" cold-mount time) grows memory monotonically. After 50+ iterations the bench process is multi-GB. No error — just slow and eventually OOM.

### Root cause

`testRender` returns `{ renderer, ... }` where `renderer` is a `TestRenderer` (`@opentui/core/testing`) backed by native opentui resources. There is no automatic teardown when the JS handle goes out of scope. Each call leaves the prior renderer alive.

### Fix pattern

Always call `handle.renderer.destroy()` between iterations of any bench that re-mounts:

```tsx
const firstPaint = await bench({ samples: 30, ... }, async () => {
  const handle = await testRender(() => <MyComponent />, { width: 100, height: 40 })
  await handle.renderOnce()
  handle.renderer.destroy()
})
```

For "steady state" benches, mount once outside the bench loop and only call `renderOnce()` inside — but still `destroy()` after the bench finishes.

### Reference

- Working example: `packages/opencode/test/perf/baseline/session-render.bench.tsx`
- TestRenderer types: `@opentui/core/testing/test-renderer.d.ts` (has `destroy(): void`)

---

## [schema-class-function-coverage] `Schema.TaggedErrorClass` keeps function% below 100% even at 100% line coverage

**Discovered in:** wave_0
**Date:** 2026-05-13
**Surfaces affected:** any new file with a `Schema.TaggedErrorClass` that needs to pass coverage checks
**Severity:** DX-trap (false-positive coverage gap)

### Symptom

A file with a `Schema.TaggedErrorClass` shows function% at ~92% even after every observable behavior is tested (constructor invoked, message getter read, instance methods exercised). Bun's `--coverage` summary shows `91.67 | 100.00` (functions/lines).

### Root cause

`Schema.TaggedErrorClass()` synthesizes class members at definition time (e.g. internal `_tag` accessors, `pipe`, equality helpers). Bun's V8 coverage counts them as functions but they aren't directly callable from user code. Function% ceiling for files containing one such class is roughly `(N - 1) / N` where N is the total function count.

### Fix pattern

For wave verification, target 100% **line** coverage rather than function coverage. The campaign's bar is "100% line + branch" — function coverage is a lossy proxy. If a wave's verification step checks "100% on file X" and you see 100% lines + ~90% functions because of a TaggedErrorClass, it's passing the real constraint.

### Reference

- Example: `packages/opencode/test/lib/perf.ts` (`BenchBudgetExceededError`) hits 100% line / 93% function
- Example: `packages/opencode/test/lib/stub-provider.ts` (`NetworkCalledError`) hits 100% line / 89% function

---
