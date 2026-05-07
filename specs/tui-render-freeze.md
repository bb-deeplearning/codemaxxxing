# TUI render-freeze investigation

# TUI render-freeze investigation

> **Status (as of 2026-05-07, late):** fourth manifestation found, fixed,
> AND a proactive sweep applied. The structural antipattern (flex-row
> with potentially-tall `<text>` primary cell) was audited across every
> TUI surface that renders agent-, MCP-, server-, or LSP-supplied
> strings, and a single shared sanitizer (`@tui/util/inline-safe`) is
> now applied at every confirmed risk site. Two body-content surfaces
> (todo-item, mcp/lsp sidebars) were restructured to drop flex-row
> entirely (absolute-marker pattern, same shape as the AssistantMessage
> marginalia fix in `23e0e84f6`). See "Proactive sweep" below for the
> full list of touch points.
>
> **Status (as of 2026-05-07):** fourth manifestation found and fixed.
> Same antipattern (flex-row + tall `<text>`), this time at the
> BlockTool header, triggered by MCP tools whose primitive string
> inputs (e.g. `chrome-devtools_evaluate_script`'s `function` arg) are
> multi-line / multi-KB. Fix is in the `input()` helper at the bottom
> of `routes/session/index.tsx` — collapses whitespace and caps the
> per-value display length so `<text>` stays one logical line.
> Activates when `generic_tool_output_visibility=true` (toggle in the
> command palette / kv store), which routes GenericTool through
> BlockTool instead of InlineTool.
>
> **Status (as of 2026-05-06):** root cause identified and fix shipped.
> The bug was a fork-only regression: a flex-row wrapping the body
> `<text>` of `UserMessage`, plus `wrapMode="word"` on the body text
> node — neither present in upstream. Confirmed via direct diff against
> `upstream/dev`. See **The antipattern** section below for the
> generalized lesson.

## TL;DR — the antipattern (read this first)

> **In opentui, never put a flex container around a child whose content
> can grow tall.** Any `flexDirection="row"` whose primary cell is a
> `<text>` that can wrap to many rows, or a syntax-highlighted block,
> or any other variable-tall content, will eventually exceed opentui's
> internal layout-measurement budget. When it does, paint stalls past
> the failing layout node and **everything subsequent** stops
> rendering. The session looks frozen until something else triggers a
> layout reset.

We hit this exact bug class **four times** in this investigation:

| # | Where | Trigger | Fixed in |
|---|---|---|---|
| 1 | AssistantMessage outer row wrapper (marginalia + body) | Write tool's 5KB syntax-highlighted file | `23e0e84f6` |
| 2 | BlockTool inner padding wrapper | Same | `bf03d6396` |
| 3 | UserMessage inner row wrapper (body + queued/timestamp pill) | Multi-KB pasted user text | `77dd69854` |
| 4 | BlockTool **header** row, via `input()` → `headerLine()` carrying multi-line MCP args | `chrome-devtools_evaluate_script` function arg (2.8KB / 81 newlines) with `generic_tool_output_visibility=true` | (latest session) |

### Why the mistake keeps getting made

Browser-CSS instinct. The canonical CSS pattern for "label left,
metadata right, same baseline" is `<row><text/><pill/></row>` with
`justifyContent="space-between"`. Browsers absorb this trivially —
retained-mode compositing, GPU reflow, decades of constraint-solver
optimization. opentui is naive measure-then-paint on a 2D character
grid; the same pattern that's free in a browser is O(W × H) per render
here, and silently fails past an undocumented budget.

### Companion antipattern: `wrapMode="word"` on user-pastable content

Runs a per-render word-boundary scan over the entire string. Already
removed from Shell tool output in `581c33992`; got reapplied to
UserMessage's body in the same fork-divergence wave. **Default
`wrapMode` (no attribute) for any text node that can hold
user-pastable / multi-KB content.** Upstream uses default wrap
everywhere; the fork should too.

### Audit checklist when touching the render hot path

1. `rg 'flexDirection="row"' packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` —
   for each hit, ask "could the primary child of this row ever be
   tall?" If yes, restructure as a column with vertical siblings, or
   absolute-position the secondary content. **Don't trust "the
   primary cell is just `headerLine`/`label`/etc." — chase the value
   to its source. If any caller is `input(props.input)` or otherwise
   user/tool-supplied, it can be multi-line / multi-KB regardless of
   how innocent the local code looks.**
2. `rg 'wrapMode="word"' packages/opencode/src/cli/cmd/tui/` —
   for each hit, ask "can this text node ever hold user-pasted or
   multi-KB content?" If yes, drop the attribute.
3. `git diff upstream/dev..HEAD -- <file>` — if the fork has structural
   nodes (boxes, rows, attributes) that upstream doesn't, in a
   render-hot-path component, that's a regression suspect by default.
   Burden of proof is on the fork to justify the divergence.
4. **Anything that interpolates a primitive string from
   `props.input.<arbitrary-mcp-key>` into a `<text>` node — sanitize
   it.** MCP servers can pass multi-line strings (JS function bodies,
   shell scripts, JSON blobs). Display-only stringification (the
   `input()` helper at the bottom of `index.tsx`) MUST collapse
   whitespace and cap length. The actual data on the part is preserved
   regardless.

## Symptom (historical)

The TUI silently **stops painting** at some content boundary inside a
session. Reactivity in the SDK/store keeps firing — new messages mount,
`AssistantMessage parts ref changed` log lines fire, `TextPart len`
deltas tick up — but **none of it appears on screen**. The screen freezes
at whatever was rendered before the boundary.

User-visible flavors of the same root bug:

- "Streaming stops mid-message, send a new message, suddenly a chunk
  that wasn't streamed appears."
- "Open the session in cmx → see hung state. Send a message → the next
  chunk of the OLD message appears. Open same session in upstream
  opencode → everything renders correctly."
- "I pasted a huge user message and now everything past it is frozen,
  and the rest of my user message appeared as if it was streamed back
  to me." (Render artifact: paint stalled mid-user-message; later
  layout pass released the queue and the trailing characters appeared
  alongside the assistant's response, looking like the model was
  echoing the paste.)

## What we know for certain

1. **The data is correct on disk.** Same DB renders fine in upstream
   opencode. Verified by querying SQLite directly:

   ```sh
   sqlite3 ~/.local/share/opencode/opencode.db \
     "SELECT id, json_extract(data, '$.role'), json_extract(data, '$.time.completed'), json_extract(data, '$.finish'), (SELECT COUNT(*) FROM part WHERE message_id = m.id) FROM message m WHERE session_id='SESSION_ID' ORDER BY id;"
   ```

2. **The store is correct.** `RENDER_DEBUG=1` instrumentation in
   `routes/session/index.tsx` proves new messages mount, parts ref
   changes fire, TextPart `len` deltas grow as expected. The bug is
   strictly in the **paint/layout** layer — opentui isn't drawing
   what Solid is computing.

3. **The boundary at which paint stops correlates with content
   structure**, not with timing. The latest repro suggests **content
   size of a single child is a trigger** (paste a huge user message
   → freeze; render a write-tool output of a 5KB JSON file →
   freeze).

4. **Same DB in upstream opencode = no bug.** Therefore the cause is a
   **fork-only structural diff** in the rendering layer, not in
   sync.tsx (byte-identical to upstream), not in sdk.tsx (only diff is
   a 32-event flush backstop that fires under heavy SSE — not the
   trigger here), not in event.ts (byte-identical), not in opentui
   itself (same version, no fork patches).

## Repro session IDs

| Session | Trigger | Notes |
|---|---|---|
| `ses_20e6b1c48ffeJKO2R6OGDPzq6T` | Reopen, mid-write-tool with toybox-noir.json (5KB) | Most-traced session; logs in `~/.local/share/opencode/log/2026-05-04T*.log` |
| `ses_20b10eb47ffeTLYi4BaUqq94UB` | Aborted assistant with 0 parts | Used to chase the abort-finalize bug |
| `ses_20b81cc84ffey5H6fAdlwYetyc` | Long debugging session | Renders OK now |
| `ses_20680f90dffeTHqjXupZN5kSRe` | **Pasted huge user message.** | Fixed in `77dd69854` (UserMessage row wrapper + `wrapMode="word"`) |
| `ses_1fcac88d3ffe1COu7LRdg2mw2w` | **Heavy `chrome-devtools_evaluate_script` usage with `generic_tool_output_visibility=true`.** | Fixed by sanitizing `input()` to collapse whitespace + cap length. The bug was the BlockTool header's flex-row receiving multi-line MCP function args via `headerLine(props)`. Symptoms: streaming halts mid-message; sending a new message reveals the rest of the prior chunk; even the `?` prompt input itself stops painting. |

## Architecture (read these before changing anything)

### Files in the rendering hot path

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — main
  render loop. `Session()` route, `<For each={messages()}>`,
  `UserMessage` and `AssistantMessage` components, `PART_MAPPING`,
  `TextPart` / `ReasoningPart` / `ToolPart`, `BlockTool`, `InlineTool`,
  per-tool components (`Write`, `Edit`, `Shell`, `WebSearch`, etc.).
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — the
  Prompt input + status strip (model identity row, breathing row,
  status row with hints/spinner/context bar).
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` — REST + SSE
  store. Byte-identical to upstream.
- `packages/opencode/src/cli/cmd/tui/context/sdk.tsx` — SSE event
  pipeline. Differs from upstream only in a 32-event flush backstop.
- `packages/opencode/src/cli/cmd/tui/context/event.ts` — workspace-
  filtered event subscription. Byte-identical to upstream.

### Data flow

1. `Session()` route mounts. `createEffect` fires
   `sync.session.sync(sessionID)` → REST loads up to 100 messages with
   their parts in one batch. `setStore(produce(...))` populates
   `sync.data.message[sessionID]` and `sync.data.part[messageID]`.
2. SSE events stream from server via `sdk.global.event()`. Events go
   through `handleEvent` in `sdk.tsx` (queued, batched at 16ms or
   when 32+ events pile up). On flush, events go through
   `event.subscribe` callbacks (workspace-filtered) which update the
   store via `produce()`.
3. The store (`sync.data.message[sessionID]`) is a Solid store proxy.
   Components subscribe via `messages()` memo and re-render reactively.
4. `<For each={messages()}>` iterates. Each message renders
   `UserMessage` or `AssistantMessage`. AssistantMessage renders parts
   via a unified `<For each={renderable()}>` loop (see commit
   `c97d00eee` for why a single For).

### Key reactive primitives

- `route.sessionID` — current session
- `messages()` memo at route level — `sync.data.message[sessionID] ?? EMPTY_MESSAGES`
- `messageCount = messages().length` — primitive that gates expensive cache rebuilds
- `message_meta` — single O(N) walk over messages, builds Maps for ordinal lookup, user-by-id index, first-in-turn set. Rebuilds when `messageCount()` changes (length is a primitive so Solid value-equality short-circuits per-delta)
- `messageTail` — single backward walk for `pending` + `lastAssistant`
- Per-message: `props.parts` reads `sync.data.part[message.id] ?? EMPTY_PARTS`
- `EMPTY_MESSAGES` / `EMPTY_PARTS` — frozen module-scope sentinels so the
  empty-fallback path doesn't allocate fresh arrays per render

### Performance baseline (commit 581c33992)

The fork is now strictly faster than upstream on the streaming hot path.
Per-streaming-delta cost:

- O(1) tail read for `pending` / `lastAssistant` (single fold)
- O(1) Map lookups for user/assistant ordinals (route-level cache)
- Zero RGBA allocations for spinner/logo per frame (pre-built tables)
- Zero per-cell memos in the message For (uses `Dynamic`, lookup is
  module-scope)

**Don't regress this.** The performance work took multiple rounds of
audit and the user has explicitly stated they will not go through it
again.

## What we tried — chronological, with what worked / what didn't

### 1. `hasVisibleParts` gate (commit `581c33992`)

- **Original code**: AssistantMessage body was wrapped in
  `<Show when={hasVisibleParts()}>` where `hasVisibleParts` checked for
  `text|tool|reasoning` parts.
- **Problem**: streaming assistants always start with a `step-start`
  part (which doesn't qualify). The body — including the streaming
  `<code>` element that owns the markdown-streaming buffer — stayed
  UNMOUNTED for ~500ms-2s until the first reasoning/text/tool part
  arrived. Then the body mounted with parts already populated and
  painted them in one frame instead of streaming.
- **Fix**: removed the gate. Render body unconditionally.
- **Result**: fixed the "stops streaming" symptom for new messages.

### 2. Server `halt()` doesn't finalize aborted messages (commit `bf03d6396`)

- **Problem**: when the user aborted a prompt, server `halt()` set
  `ctx.assistantMessage.error = MessageAbortedError` but did NOT set
  `time.completed` and did NOT persist via `session.updateMessage()`.
  Upstream's projector chain handled this via
  `SessionEvent.Step.Failed.Sync`, but the fork removed that event.
- **Result**: aborted messages on disk had `error` set but
  `time.completed` undefined. On TUI reopen, sync-v2's
  `activeAssistant()` kept matching them via `findLastIndex` on every
  subsequent SSE event for the session — turning O(1) into O(N) per
  event for the rest of the session lifetime.
- **Fix**: `halt()` now sets `time.completed`, `finish="error"`, and
  calls `session.updateMessage(ctx.assistantMessage)`.
- Also added a `case "session.error"` handler in sync-v2 so live
  aborts close the active assistant in the in-memory store too.

### 3. BlockTool inner wrapper (commit `bf03d6396`)

- **Problem**: BlockTool wrapped children in
  `<box paddingLeft={2} flexShrink={0}>`. Upstream renders children
  directly inside the outer box.
- **Fix**: removed the inner wrapper.
- **Result**: helped but DID NOT solve the freeze-past-large-content
  bug. Symptom persisted.
- **Lesson**: the user pointed out that text-only messages also froze,
  not just BlockTool children. Don't tunnel-vision on a single
  component when the symptom is universal.

### 4. AssistantMessage row wrapper (commit `23e0e84f6`)

- **Problem (confirmed by diagnostic strip)**: AssistantMessage
  wrapped its entire body in
  `<box flexDirection="row">` with marginalia (`width={5}`) on the
  left + body (`flexGrow={1} flexShrink={1}`) on the right. UserMessage
  had the same shape. **Upstream has no row wrapper** — parts render
  directly under a fragment.
- **Hypothesis**: opentui's flex pass can't lay out a flex-row whose
  body cell contains very tall content (write tool's syntax-highlighted
  multi-KB file = hundreds of rows). Once the body cell exceeds an
  internal measurement budget, the row's layout breaks and EVERY
  subsequent sibling stops painting.
- **Diagnostic**: stripped the row wrapper from both UserMessage and
  AssistantMessage. **The freeze stopped.** Confirmed.
- **Fix**: kept the visual (5-col gutter + marginalia pill) but
  re-implemented as a column box with `paddingLeft={5}` for the
  gutter + marginalia as `position="absolute" left={0} top=N` (top=0
  for UserMessage which has no first-child marginTop, top=1 for
  AssistantMessage to compensate for parts' marginTop=1). Absolute
  positioning sidesteps the flex pass entirely.

### 5. Closing summary order during streaming (commits `23e0e84f6` and `c97d00eee`)

This took two iterations and I got it wrong the first time.

- **Symptom**: closing summary appeared ABOVE the text on first open
  during streaming. Reopened session showed correct order.
- **First fix attempt (commit `23e0e84f6`)**: replaced
  `<Switch>/<Match>` (which conditionally mounts) with an
  always-mounted box + inner `<Show>` for content. **Theory**: opentui
  appends late-arriving children to parent's end. If summary box is
  always mounted, late text gets appended after summary →
  `[marginalia, summary, text]`. Wrong.
- **What actually happened**: the bug remained. Worse, in some cases
  the order was now `[marginalia, text, summary]` but with summary
  appearing visually ABOVE text in opentui's render (DOM order ≠
  visual order somehow).
- **Second fix attempt (commit `c97d00eee`)**: collapse parts +
  task-tool hint + user-error + closing summary into a SINGLE `<For>`
  over a derived `renderable` array. Order is determined by array
  index, not by mount timing of separate sibling
  `<For>`/`<Show>`/`<Switch>` components.
- **Result**: fixed for the test sessions at the time. But the
  underlying opentui ordering quirk is NOT understood — the fix
  works around it by funneling everything through one For loop.

### 6. Prompt indicator + context bar redesign (commit `c97d00eee`)

Cosmetic, no perf impact, doesn't bear on the freeze bug. Just listed
for completeness so a future agent doesn't re-investigate these as
suspects.

## What I'm now fairly sure ISN'T the cause

- The 32-event SSE backstop (`sdk.tsx:67`) — only fires under heavy
  live streaming, not on session reopen / user-message paste.
- `event.ts` workspace filter — byte-identical to upstream, both have
  it.
- `sync.tsx` REST loader — byte-identical to upstream.
- The `messages` `<For>` keying in the scrollbox — same as upstream.
- The marginalia row wrapper — proven to be A trigger, but the
  current code uses absolute positioning so this should be fully
  fixed.

## Current open hypothesis (untested, latest repro)

> "I pasted a huge user message and now it froze."

**Update (2026-05-06): hypothesis confirmed and fixed.** Root cause was
exactly as predicted in this section, plus a second fork-only delta
that compounded it. Both confirmed via `git diff upstream/dev..HEAD`:

1. UserMessage's body `<text>` had `wrapMode="word" flexShrink={1}` —
   neither attribute is on the upstream node. `wrapMode="word"` runs a
   per-render word-boundary scan; on a 4742-char paste it eats into the
   layout-measurement budget.
2. UserMessage wrapped its body text + queued/timestamp pill in a
   `flexDirection="row" justifyContent="space-between"` — upstream has
   no row wrapper at all (body, files, queued/timestamp stack
   vertically). This was the bigger culprit: same row-with-tall-body
   antipattern that broke AssistantMessage in `23e0e84f6`, just
   reintroduced at a deeper nesting level.

Fix:
- Dropped `wrapMode="word"` and `flexShrink={1}` from the body text
  node (matches upstream).
- Removed the inner row wrapper. Body text, files, queued, and
  timestamp now stack as vertical siblings inside the column box.
- Queued and timestamp render as their own right-aligned
  `flexDirection="row" justifyContent="flex-end"` rows beneath the
  body, mirroring AssistantMessage's closing-summary pattern. (Those
  rows are safe because their primary cell is short fixed-width text,
  not the multi-KB body.)

The load-bearing comment in AssistantMessage's marginalia
(`UserMessage's first child is a row box`) was updated to match the
new shape.

## Proactive sweep (2026-05-07)

After the fourth manifestation, a full audit of `flexDirection="row"`
sites across the TUI was performed. The shared sanitizer
`packages/opencode/src/cli/cmd/tui/util/inline-safe.ts` (`inlineSafe(s,
max=120)`) was added — collapses whitespace runs and caps length, so
any string passing through it can never trip the layout-budget freeze
even on narrow terminals.

### Sites that now sanitize via `inlineSafe`

| File | Site | Cap | Source of risk |
|---|---|---|---|
| `routes/session/index.tsx` | `headerLine()` (BlockTool header) | 120 | LLM-generated tool descriptions; MCP tool args |
| `routes/session/index.tsx` | `input()` (inline tool-arg display) | 120 | Same |
| `routes/session/permission.tsx` | `LabeledRule` `targetValue` consumer | 120 | Shell description, webfetch URL, websearch query, file paths |
| `routes/session/question.tsx` | tab-strip `q.header` | 60 | LLM-generated question header |
| `routes/session/question.tsx` | option `opt.label` | 200 | LLM-generated option text (kept generous — actionable content) |
| `routes/session/question.tsx` | option `opt.description` | 200 | Same |

### Sites restructured to drop flex-row

These had `<box flexDirection="row">` + body `<text>` carrying
unbounded LLM/server text, often with `wrapMode="word"` compounding
the cost. Same fix shape as the AssistantMessage marginalia in
commit `23e0e84f6`: marker becomes `position="absolute"` overlay in a
`paddingLeft={2}` gutter, body text wraps naturally in column flow
under default char-wrap.

| File | Was | Now |
|---|---|---|
| `component/todo-item.tsx` | flex-row + `wrapMode="word"` body | column + absolute marker |
| `feature-plugins/sidebar/mcp.tsx` | flex-row + `wrapMode="word"` body (MCP error text!) | column + absolute marker |
| `feature-plugins/sidebar/lsp.tsx` | flex-row body (long monorepo paths) | column + absolute marker |

### Sites audited and left alone (with reasoning)

- **`Spinner` (`component/spinner.tsx:29`)** — flex-row with `<text>{children}</text>`. Only consumers are inline tool labels, which are short by construction. Task tool's `content()` joins with literal `\n` (3 short lines max) — well below empirical threshold. Documented as a future concern but not changed.
- **`sidebar.tsx` session-stats rows** — `<text wrapMode="none">` on the value side; can't grow tall.
- **`feature-plugins/sidebar/files.tsx`** — already uses `wrapMode="none"` on file paths.
- **`feature-plugins/system/session-v2.tsx` attachments** — `flexWrap="wrap"` lets the row break across lines naturally; primary cell is short badge text (mime + filename), not LLM/MCP-supplied bulk.
- **`Toast` / dialogs (`ui/dialog-*.tsx`)** — column boxes, not flex-row.
- **`subagent-footer.tsx`** — header rows are short fixed-format text (token counts, costs).

## Diagnostic tools already in place

- `OPENCODE_DEBUG_RENDER=1` env var enables instrumentation in
  `~/.local/share/opencode/log/2026-05-*.log`. Filter via
  `tail -f "$(ls -t ~/.local/share/opencode/log/*.log | head -1)" | grep tui-render`.
- Logs `AssistantMessage mount/UNMOUNT`, `parts ref changed` (with
  prevLen/nextLen), `TextPart mount/UNMOUNT`, `TextPart len`
  milestones, `route.messages change` (with prevLen/nextLen/reKey),
  `route.pending change`, `route.lastAssistant change`,
  `UserMessage pending/queued change`.
- All gated on the env var; production cost is ~zero (one runtime
  branch per call site that's dead-code when the flag is off).

## Important "don't repeat this" lessons

1. **Don't tunnel-vision on a single component.** If the symptom
   appears with text content (not just tool blocks), the cause is
   universal across part types. Look at containers, not contents.
2. **Don't theorize about opentui's reconciliation order without
   testing.** I was confidently wrong twice about late-mount append
   behavior. The actual workaround that holds is "funnel everything
   through one `<For>` over an indexed array".
3. **Always cross-check against upstream before changing anything.**
   Multiple times the answer was "upstream just doesn't have this
   structure". `git diff upstream/dev..HEAD -- <path>` and
   `git show upstream/dev:<path>` are your friends.
4. **The user has zero patience for perf regressions.** Every change
   to the render hot path needs to maintain or improve per-delta
   cost. The standard is "strictly faster than upstream" — see
   commit `581c33992`'s commit message for the per-delta cost
   ranking.
5. **When the user says they tested, trust them.** They will tell
   you exactly what they see vs what they expect. Don't argue or
   re-theorize — get a fresh diagnostic log and re-anchor.
6. **The existing comments in `routes/session/index.tsx` are
   load-bearing.** They document why specific structural decisions
   were made (absolute marginalia, single For for renderable, etc.).
   Read them before changing the file.
7. **Closing-summary order in particular is fragile.** If you find
   yourself touching the closing summary, the ONLY known-good
   pattern is `{ kind: "summary" }` as the last item in the
   `renderable` For array. Do not split it back into a sibling
   `<Switch>`/`<Show>`.

## Quick-start for next session

```sh
# Verify the bug
bun dev -s ses_20680f90dffeTHqjXupZN5kSRe

# Capture render-side diagnostics
OPENCODE_DEBUG_RENDER=1 bun dev -s ses_20680f90dffeTHqjXupZN5kSRe
# In another terminal:
tail -f "$(ls -t ~/.local/share/opencode/log/*.log | head -1)" | grep tui-render

# Inspect on-disk state of the session's messages and parts
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT id, json_extract(data, '$.role'), json_extract(data, '$.time.completed'), json_extract(data, '$.finish'), (SELECT COUNT(*) FROM part WHERE message_id = m.id) AS parts FROM message m WHERE session_id='ses_20680f90dffeTHqjXupZN5kSRe' ORDER BY id;"

# Find which message contains the pasted text
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT message_id, length(json_extract(data, '$.text')) FROM part WHERE session_id='ses_20680f90dffeTHqjXupZN5kSRe' ORDER BY length(json_extract(data, '$.text')) DESC LIMIT 5;"

# Diff the rendering layer vs upstream (for context)
git diff upstream/dev..HEAD -- packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
git diff upstream/dev..HEAD -- packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
```

## Commit history of fix attempts

```
c97d00eee  fix(tui): unify message-body render order; redesign prompt indicator + context bar
23e0e84f6  fix(tui): unfreeze session render by replacing message flex-row with absolute marginalia
bf03d6396  fix(tui+server): unblock session render past BlockTool children + finalize aborted assistants
581c33992  perf(tui): make streaming render path strictly faster than upstream
```

All four landed on `wave-system` branch on 2026-05-05.
