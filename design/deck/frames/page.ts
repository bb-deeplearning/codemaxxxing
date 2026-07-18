// direction b — the page. no tui vernacular at all: no state glyphs, no
// studs, no chips, no box edges, no ❯. structure comes from a wide left
// margin (tool names live there as quiet sidenotes, tufte-style), from
// whitespace rhythm, and from full-bleed color washes (your words sit on
// a faint primary band; diff lines are add/remove bands across the whole
// width). the prompt is a bare cursor on a clean field with one muted
// sentence under it. metadata is a far-right whisper, prose not pills.
//
// works themeless: washes derive from the theme's own bg/panel; on fully
// transparent themes they fall away and weight is carried by color alone.

import { line, blank, span, mix, type Line, type Rgb } from "../paint"
import type { Palette } from "../theme"
import { dim, body, idColor } from "../ui"

const MARGIN = 9

// wash: a faint full-bleed band tinted toward `color`. undefined when the
// theme gives us no base to tint (fully transparent) — callers degrade to
// plain colored text.
const wash = (t: Palette, color: Rgb, alpha: number): Rgb | undefined => {
  const base = t.bg ?? t.panel
  return base ? mix(base, color, alpha) : undefined
}

// a row with a right-aligned sidenote word in the margin, then content.
const note = (t: Palette, word: string, spans: ReturnType<typeof span>[]): Line =>
  line([dim(t, word.padStart(MARGIN - 2) + "  "), ...spans])

const flow = (t: Palette, spans: ReturnType<typeof span>[]): Line => line([span(" ".repeat(MARGIN)), ...spans])

export function sessionB(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  const you = idColor(t, "you")
  const youWash = wash(t, you, 0.13)
  const addWash = wash(t, t.diffAdded, 0.14)
  const delWash = wash(t, t.diffRemoved, 0.14)
  const ind = " ".repeat(MARGIN)
  const L: Line[] = []

  L.push(blank())
  // your words: a full-bleed band in your color. transparent themes drop
  // the band and keep the bold colored text.
  L.push(line([span(ind), span(narrow ? "fix the refresh token race" : "fix the refresh token race, concurrent requests", you, youWash, true)], [span("12:02  ", t.muted, youWash)], youWash))
  if (!narrow) L.push(line([span(ind), span("drop the new token", you, youWash, true)], undefined, youWash))
  L.push(blank())
  L.push(blank())
  L.push(flow(t, [body(t, "looking at the refresh path. the token store swaps before the")]))
  L.push(flow(t, [body(t, "write lock releases, so the second request reads a dead token.")]))
  L.push(blank())
  L.push(note(t, "thinking", [dim(t, "the swap is optimistic. two readers can hold the stale")]))
  L.push(flow(t, [dim(t, "ref if the second acquire lands inside the swap window")]))
  L.push(flow(t, [dim(t, "…12 more lines")]))
  L.push(blank())
  L.push(note(t, "read", [body(t, "src/auth/token.ts"), dim(t, "  120–208")]))
  L.push(note(t, "grep", [body(t, "refreshToken("), dim(t, "  9 call sites")]))
  L.push(blank())
  L.push(note(t, "edit", [body(t, "src/auth/token.ts"), dim(t, "  two lines")]))
  L.push(line([span(ind), span("store.swap(key, fresh)", delWash ? t.text : t.diffRemoved, delWash)], undefined, delWash))
  L.push(line([span(ind), span("await store.swapLocked(lock, fresh)", addWash ? t.text : t.diffAdded, addWash)], undefined, addWash))
  L.push(blank())
  L.push(note(t, "run", [body(t, narrow ? "bun test — 212 pass, 4.2s" : "bun test packages/api — 212 pass, 0 fail, 4.2s")]))
  L.push(flow(t, [dim(t, "…46 more lines")]))
  L.push(blank())
  L.push(blank())
  L.push(line([], [dim(t, "build · fable-5 · 31s · $0.04  ")]))
  L.push(blank())
  L.push(blank())
  L.push(line([span(ind), span("█", t.primary)]))
  L.push(flow(t, [dim(t, narrow ? "fable-5 · 61% · $0.83" : "fable-5 · 61% of context · $0.83 today")]))
  L.push(blank())

  return L
}

export function homeB(t: Palette, cols: number): Line[] {
  const ind = " ".repeat(MARGIN)
  const x1 = t.set[0]!
  const x2 = t.set[2]!
  const x3 = t.set[6]!
  const row = (name: string, title: string, age: string) =>
    line([span(ind), span(name.padEnd(15), idColor(t, name), undefined, true), body(t, title)], [dim(t, `${age}  `)])
  const L: Line[] = []

  L.push(blank())
  L.push(blank())
  L.push(blank())
  L.push(
    line([
      span(ind),
      span("c o d e m a ", t.text, undefined, true),
      span("x ", x1, undefined, true),
      span("x ", x2, undefined, true),
      span("x ", x3, undefined, true),
      span("i n g", t.text, undefined, true),
    ]),
  )
  L.push(blank())
  L.push(flow(t, [dim(t, "saturday. dev is clean. fable-5 is up.")]))
  L.push(blank())
  L.push(blank())
  L.push(row("clauseo-api", "refresh token race", "2m"))
  L.push(row("cmx", "tui overhaul, design deck", "1h"))
  L.push(row("blog", "f1 preseason images", "3d"))
  L.push(blank())
  L.push(blank())
  L.push(flow(t, [dim(t, "type to start")]))
  L.push(blank())

  return L
}
