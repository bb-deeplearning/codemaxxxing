# TUI redesign

Implementation contract for the codemaxxxing TUI overhaul. The winning direction is **afterglow** (`design/deck/frames/glow.ts`), picked off the contact sheet after four competing directions. The deck is the living spec — frames are the source of truth, this file is the contract for porting them into the real TUI.

---

## Register

Smooth, cool, sexy. The organizing idea: **information has temperature** — live things glow, finished things cool to embers, failures burn. There are no hard edges anywhere; no borders, blocks, bars, or badges. Structure is made of fades: rules dissolve, diff washes bleed out, collapsed output sinks into the dark, the cursor is the brightest thing on screen.

---

## Hold these constraints

Each one is verifiable. A port that breaks any of these is wrong, whatever it looks like.

1. **Theme-token purity.** Every color is a theme token or an interpolation between two tokens (`mix`). Zero hex literals in any surface code — `design/deck/verify.ts:54-58` greps frame sources for `#[0-9a-fA-F]{6}` and fails the run on any hit. The design must survive every bundled + user theme: verify.ts proves it with 448 renders (14 frames × 8 themes × 2 modes × 2 widths), checking exact cell geometry and no throws. Port this enforcement pattern to the TUI: same gauntlet, same zero-hex rule.
2. **Transparent-background degradation.** Backgrounds are optional in the palette (`design/deck/theme.ts:29-33`). Every bg-dependent device degrades to fg-only: `bleed` returns a plain span when `t.bg` is undefined (`glow.ts:34`), and fades target `t.bg ?? t.muted` everywhere. `lucent-orng` is the canonical transparent case — if it holds there, it holds.
3. **Perf / mosh budget.** Static paint only. Motion is allowed in at most the cursor + one live line (the busy sentence). No per-frame color churn — the kinetic feel comes from static gradients, not animation. opentui discipline per GOTCHAS: single `<text>` with spans, never N sibling text nodes (`opentui-multi-text-node-vs-single-baseline-cap`); no flex-row around potentially-tall children (`tui-flex-row-with-tall-text`, `specs/tui-render-freeze.md`); memoize derived strings.
4. **Narrow-first.** Every surface must hold at 64 cols (phone over mosh). The deck renders every frame at 100 and 64; frames take `cols` and adapt (`glow.ts:52` — `narrow = cols < 80`). Widths clamp with `Math.min(target, w)`.

---

## Use this vocabulary

The reusable devices. Recipes are exact — port the numbers, not the vibe.

### Color semantics

| token | means |
|---|---|
| `borderActive` | **the human** — semantically "the active one", distinct from chrome in every theme (`glow.ts:53-55`; idColor can collide with primary, borderActive can't) |
| `primary` | machine chrome and live things — run headers, cursor, the rule above the deck |
| `success` / `error` | verdicts — "212 pass", "done", the deny key |
| `warning` | heat and decisions — asks, context pressure |
| `info` | thinking |
| `muted` | chatter — timestamps, metadata, quiet tools |
| `idColor(t, key)` | identity for projects/agents — FNV-1a hash into the theme's own accent set (`ui.ts:26-33`), same family as `agent-identity.ts` so the deck predicts real behavior |

### Devices

- **grad** (`glow.ts:14-22`) — per-character gradient text, chunked every 2 chars to keep span count sane. Reads perfectly smooth at cell scale.
- **fadeRule** (`glow.ts:25-28`) — a rule that dissolves: `grad("─".repeat(width), color, mix(color, t.bg ?? t.muted, 0.92))`. The only horizontal structure in the design.
- **sink** (`glow.ts:48-49`) — collapsed output cooling in two steps: body-tail at `mix(t.muted, t.bg ?? t.muted, 0.32)`, the "n more" whisper at `0.6`. The body of a thought stays readable; only the tail fades.
- **bleed** (`glow.ts:33-43`) — diff-row washes: row bg strongest at the left, gone by `width`. 3-cell steps at `0.16` tint — 6-cell chunks band visibly on pure-black themes. Transparent themes skip it entirely.
- **kinetic busy sentence** (`glow.ts:129`) — the tail of the sentence glows hotter than its head: `grad(text, mix(agent, t.bg ?? t.muted, 0.55), agent, bold)`. Static cells that read as motion.

### Typography

- All lowercase, everywhere — chrome, labels, product copy.
- Bold is reserved for three things: the human's words, object titles (`token.ts`), and verdict words (`212 pass`, `done`, `bash wants to run`).
- Status is words-in-color, never glyphs: "84% full · compact soon" in warning, not a meter.
- Banned: box-drawing chrome, chips/badges, studs/meters as glyphs (`ui.ts` studs/chips/dots are legacy from earlier directions — do not port), spinner glyphs.
- The only block glyph in the design is the cursor `█` — bare and bright (`glow.ts:86-87`; a "pool of light" under it was tried and reads as selection residue).

### Layout

- Indent rhythm: content at 2, nested output at 4. Nothing at 0 except the turn summary's right whisper.
- Air is structure: blank lines around loud objects (edit, run, asks); quiet lines pack together.
- Right-edge whispers for metadata: timestamps, `+9 −3`, `esc to stop`, cost — dim, right-aligned, trailing two spaces (`glow.ts:60,74,78,83,129`).
- Fade-rule widths: 28 under the human's message, 20 after "thinking", 34 under ask/question titles, 56 above the cursor — always clamped to available width.

---

## Obey these laws

- **The bottom edge is sacred.** The last four lines are always: fade rule → cursor → status whisper → blank. Nothing else may claim them.
- **One glow at a time.** When an ask fires, the busy line cools to `hunting the race in token.ts · paused` in sink tone and the ask takes the heat (`glow.ts:133-140`). The eye always has exactly one hot spot.
- **The return glance.** Coming back to a finished session, the answer sits right above the cursor: `done — changed token.ts, 212 pass · 31s · $0.04` (`glow.ts:152-157`). Verdict word bold in success; everything else a dim whisper. You should never have to scroll to learn what happened.
- **The context meter is a decision instrument.** It answers "should I start a fresh wave", not "here is a number". Words over glyphs: warning color + `compact soon` past 70, error past 90 (thresholds per `ui.ts:40-45`, presentation per `glow.ts:130`).
- **History cools.** Finished turns render in ember tones — sink for collapsed output, dim for chatter. Only the live edge glows.
- **Quiet/loud tool hierarchy.** read/grep/glob collapse to one dim line with `·` separators (`glow.ts:72`). edit/run/write/asks/deliverables are objects: colored header word, bold title, right whisper, indented body, air above and below (`glow.ts:74-81`).

---

## Build these surfaces

Deck frames are the visual source of truth; descriptions here are just anchors.

- **Session turn** (`sessionD`, `glow.ts:51-92`) — human's line bold in borderActive with a dissolving rule under it; assistant body plain text at indent 2; thinking as info label + fading rule with sunk body; quiet tools one line; edit object with bleed-washed diff rows; run object with verdict; right-aligned turn summary; then the sacred bottom edge.
- **The deck's five states** (`asksD`, `glow.ts:118-161`) — idle (rule, cursor, whisper), busy (kinetic sentence + meter + `esc to stop`), ask (work cools to `· paused`, warning title + rule, command at 4, `enter yes · a always · d no` keyed in success/info/error), question (bold question, info rule, options with recommended bright / others dim / last sunk), return glance.
- **Home** (`homeD`, `glow.ts:94-116`) — letter-spaced gradient wordmark with a fade rule, one dim status sentence, project rows (idColor name warmed `0.15` toward text, title, age whisper), `type to start` sunk. No menu chrome.

### Design these next (open)

Not yet designed — explicitly open. Each goes through the deck first (new frame, verify, render, look) before any TUI code:

agents/spawn/tombstone/presence · waves route · toasts · timeline · export.

Landed in the first port wave: dialogs, the commands palette, and the sidebar (fate resolved: kept, borderless, sectioned).

---

## Map to the code

Pointers only — the deck stays the living spec. Change a frame, re-verify, re-render, then port.

| surface | files |
|---|---|
| session turns | `routes/session/index.tsx` — part renderers + `PART_MAPPING` (≈1898) |
| the deck (prompt + states) | `component/prompt/index.tsx` |
| home | `routes/home.tsx` |
| dialogs | `ui/dialog*.tsx` |
| tokens | `context/theme.tsx` — **untouched**, it is the token source |

Known bugs fixed on the way through:

- `routes/session/mailbox-message.tsx:205` — expand toggle missing stopPropagation. **Fixed**: stable onMouseUp handler; no-overflow and active-selection clicks still propagate (copy-on-select preserved), otherwise stopPropagation then toggle.
- `routes/session/subagent-footer.tsx:28` — `AGENT_TITLE_RE` (`/@(\w+) subagent/`) expected the legacy task-tool title format, so v2 children rendered as generic "Subagent". **Fixed**: `AGENT_TITLE_V2_RE` (`/\(@(\w+)\)$/`) parses v2 nickname titles; the legacy regex is kept as a documented v1 fallback; color lookup keys on `session.agent` (the real agent_type) instead of the parsed name.
- `tool/agent-spawn/agent-spawn.ts:59-65` — `model` / `reasoning_effort` params were declared but never forwarded. **Wired**: validated against the provider registry + the model's variants at spawn, threaded through `SpawnAgentInput.model` → `Session.create` → the child's first-turn model selection in prompt.ts.
- `routes/session/footer.tsx` — dead code, nothing imported it. **Deleted**.

---

## Run the loop

The process that produced this direction, and that continues for every open surface:

1. Edit the frame in `design/deck/frames/`.
2. `bun design/deck/verify.ts` — geometry + zero-hex across every theme/mode/width.
3. `bun design/deck/render-html.ts` — writes `design/deck/out/sheet.html`.
4. agent-browser screenshot of the sheet → look at it.
5. Iterate until it's right, then port.

Deck frames double as reference renders during implementation review — a ported surface is done when it matches its frame under toybox-noir, lucent-orng, and at 64 cols.
