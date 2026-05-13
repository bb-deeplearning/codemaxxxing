# Wave 11 — TUI subagent enhancements

**Prior waves:** 0-10. Multi-agent surface is live and emits lifecycle events.

**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `MESSAGE_SHAPES.md`, `PERF.md`, `BACKWARD_COMPAT.md`, **`GOTCHAS.md` (you read this on entry)**, **`/Users/rohan/Documents/Personal/codemaxxxing/specs/tui-render-freeze.md`** (the long-form story behind the flex-row antipattern — read BEFORE touching any opentui structure).

**Cross-agent message shape is fixed in `MESSAGE_SHAPES.md`** — Wave 9 produces synthetic `MessageV2.UserPart` with `metadata.from`, `metadata.sent_at`, `metadata.trigger_turn`. Wave 11 renders them. Do not re-design the shape here.

**Touch points:**
- `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` (201 lines) — existing subagent navigation footer
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` (2915 lines) — main session route. **READ THE PERF COMMENTS FIRST** (lines 134-154, 163-170, 240-242, 1554-1779). This file has hand-tuned reactivity. Adding work in the wrong place causes O(N²) regressions during streaming.
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-subagent.tsx` (26 lines) — subagent action dialog
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` (543 lines) — sync store. Already has every per-session field keyed by sessionID. **No schema changes needed.**

## Goal

Surface multi-agent v2 state in the TUI: live status per sibling, mailbox messages rendered in the recipient's transcript, navigation between siblings stays cheap, no perf regressions on the render hot path.

This wave is the highest-risk for perf in the campaign because the file under modification is already on a perf knife edge with one streaming session, and we're adding N concurrent updaters.

## Tasks

### 1. Status per sibling in subagent-footer

The footer (`subagent-footer.tsx`) already shows `(index of N)`. Add live status: running / waiting / completed / errored, sourced from `sync.data.session_status` (which already exists; check Wave 10's emission lands here via the existing event→sync pipeline).

If the existing `session_status` plumbing covers this for free, great. If it doesn't surface AgentStatus specifically (it might only surface the session's busy/idle state), extend it minimally.

### 2. Mailbox message rendering

When a sibling sends a message via `send_message` or `followup_task`, Wave 9's runLoop drains it into the recipient's context per the shape in `MESSAGE_SHAPES.md`: synthetic `MessageV2.UserPart` with `metadata.from = AgentPath`, `metadata.sent_at`, `metadata.trigger_turn`, and text body `"[from <author>]: <content>"`. The existing UserMessage renderer in `index.tsx` would render this as ordinary user input.

Add a discriminator: if a UserPart has `metadata.from`, render with a visual marker (e.g. `← from @worker_1`) that distinguishes it from real user input. Match the existing visual language; small chrome, not a new pane. Strip the `[from ...]: ` prefix from the displayed text since the chrome already shows the source.

### 3. Dialog updates

`dialog-subagent.tsx` is 26 lines today and only has "open subagent's session". Add status display + close-from-dialog action (calls `close_agent` via the SDK).

### 4. Lattice / nav helpers

The existing keybindings (`session.parent`, `session.child.next/previous/first`) work for sequential navigation. With concurrent siblings, consider whether a tree view is needed or whether the existing pagination suffices. **Default: do nothing extra.** The existing nav handles N siblings the same way it handles 1. Skip this unless Wave 14's E2E findings show a clear UX gap.

### 5. Perf measurement (the load-bearing part of this wave)

Run the TUI render bench from Wave 0 (`session-render.bench.ts`) with two scenarios:
- Single session, 100 streaming chunks (the existing baseline)
- 4 concurrent siblings, 100 streaming chunks each (interleaved)

The 4-sibling case must stay within `1.5× single-session p50, 1.6× single-session p99` per `PERF.md`. If you exceed, the wave fails.

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_11.json` with both metrics.

## Gotchas

1. **opentui flex-row + tall text = catastrophic freeze.** Four prior regressions documented in `GOTCHAS.md` § `[tui-flex-row-with-tall-text]` and `specs/tui-render-freeze.md`. Mailbox messages from siblings can carry multi-KB content (tool output that one sibling forwards to another). The renderer must NOT wrap them in a flex-row. Sanitize with `@tui/util/inline-safe` if rendering as a header/preview; stack vertically if rendering full body.

2. **Re-read the perf comments at `index.tsx` lines 134-154, 240-242, 1554-1779 before touching anything.** They explain why specific patterns exist (frozen empty arrays for memo identity stability, single-walk derivations, BFS only when needed). New work in this file must respect these patterns.

2. **Don't introduce new memos in the per-message render scope.** If a derived value is per-session (not per-message), compute it once at the route level. If it's per-message, prefer inline computation over a memo unless it's expensive.

3. **`sync.data.session_status` is keyed by sessionID.** Reading status for the current sibling is O(1). Reading status for ALL siblings is O(siblings) — fine.

4. **Mailbox-message rendering must not allocate per render.** The `metadata.from` field is on the part itself; rendering should branch on that field, not on a derived memo. Match the existing UserMessage component pattern.

5. **Dialog updates are not on the render hot path.** They open on user interaction. Don't worry about dialog perf; do worry about footer perf (rendered on every streaming chunk).

6. **Backward compat.** Sessions without siblings render exactly as before. The new code paths are gated on `parentID !== undefined` or on `metadata.from !== undefined`. Verify with a test: a single-session view's render path is unchanged.

7. **`stripAnsi` for mail content** — sibling messages may contain ANSI from tool output. Use `stripAnsi` on the rendered preview just like the Bash renderer does.

8. **opentui render scheduling.** opentui batches renders to terminal frame rate (60fps default). N concurrent updaters that each set state in the same tick coalesce into a single render. This is good for perf — verify the bench reflects coalesced behavior, not synchronous re-render per update.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/cli/cmd/tui/routes/session/

bun test --coverage src/cli/cmd/tui/routes/session/subagent-footer.tsx
bun test --coverage src/cli/cmd/tui/routes/session/dialog-subagent.tsx
# index.tsx coverage: only assert 100% on the touched FUNCTIONS (the file is huge);
# use targeted coverage check on the diff lines.

# Render bench within budget
bun test test/perf/session-render.bench.ts  # re-run from baseline location
bun -e "
  const { compareToBaseline } = await import('./test/lib/perf.ts')
  const wave = JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_11.json').text())
  const r = compareToBaseline(wave.metrics['session.render.steady'], '../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json', 'session.render.steady')
  if (!r.passed) { console.error(r.reasons); process.exit(1) }
  // 4-sibling vs single-session check
  const single = wave.metrics['session.render.steady'].p50
  const four = wave.metrics['session.render.steady.4_siblings'].p50
  if (four > single * 1.5) { console.error('4-sibling render too slow:', four, 'vs single:', single); process.exit(1) }
"
```

All exit 0.

## Files

New: any new test files; possibly `packages/opencode/test/perf/multi-agent-render.bench.ts` for the 4-sibling case.

Modified:
- `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-subagent.tsx`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_11.json` (new artifact)
