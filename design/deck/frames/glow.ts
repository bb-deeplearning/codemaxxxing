// direction d — afterglow. information has temperature: live things glow,
// finished things cool to embers, failures burn. no hard edges anywhere —
// no borders, blocks, bars, or badges. structure is made of fades: rules
// dissolve, diff washes bleed out, collapsed output sinks into the dark,
// the cursor sits in a pool of light. gradients are always interpolations
// between the theme's own tokens, so any palette keeps working.

import { line, blank, span, mix, type Line, type Rgb, type Span } from "../paint"
import type { Palette } from "../theme"
import { dim, body, idColor } from "../ui"

// per-character gradient text. chunked every 2 chars to keep span count
// sane; reads perfectly smooth at cell scale.
function grad(text: string, from: Rgb, to: Rgb, bold?: boolean): Span[] {
  const chars = [...text]
  const out: Span[] = []
  for (let i = 0; i < chars.length; i += 2) {
    const k = chars.length <= 2 ? 0 : i / (chars.length - 1)
    out.push(span(chars.slice(i, i + 2).join(""), mix(from, to, k), undefined, bold))
  }
  return out
}

// a rule that dissolves: color fades toward the page over its length.
function fadeRule(t: Palette, color: Rgb, width: number): Span[] {
  const target = t.bg ?? t.muted
  return grad("─".repeat(width), color, mix(color, target, 0.92))
}

// a wash that bleeds out: row bg strongest at the left, gone by `width`.
// 3-cell steps at low tint — 6-cell chunks band visibly on pure-black
// themes. transparent themes skip it.
function bleed(t: Palette, text: string, fg: Rgb, tint: Rgb, width: number): Span[] {
  if (!t.bg) return [span(text, fg)]
  const chars = [...text.padEnd(width)]
  const out: Span[] = []
  for (let i = 0; i < chars.length; i += 3) {
    const k = Math.min(1, i / width)
    const bg = mix(mix(t.bg, tint, 0.16), t.bg, k)
    out.push(span(chars.slice(i, i + 3).join(""), fg, bg))
  }
  return out
}

// collapsed output sinking into the dark: only the tail fades — the body
// of a thought stays readable, the last visible line dims, the "n more"
// whisper is almost gone.
const sink = (t: Palette, text: string, depth: number): Span =>
  span(text, mix(t.muted, t.bg ?? t.muted, depth >= 2 ? 0.6 : 0.32))

export function sessionD(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  // the human is borderActive — semantically "the active one", distinct
  // from chrome in every theme (idColor can collide with primary).
  const you = t.borderActive
  const w = cols - 4
  const L: Line[] = []

  L.push(blank())
  L.push(line([span("  "), span(narrow ? "fix the refresh token race" : "fix the refresh token race, concurrent requests drop", t.text, undefined, true)], [dim(t, "12:02  ")]))
  if (!narrow) L.push(line([span("  "), span("the new token", t.text, undefined, true)]))
  L.push(line([span("  "), ...fadeRule(t, you, Math.min(28, w))]))
  L.push(blank())
  L.push(line([span("  "), body(t, "looking at the refresh path. the token store swaps before the")]))
  L.push(line([span("  "), body(t, "write lock releases, so the second request reads a dead token.")]))
  L.push(blank())
  L.push(line([span("  "), span("thinking ", t.info), ...fadeRule(t, mix(t.info, t.bg ?? t.muted, 0.5), Math.min(20, w - 9))]))
  L.push(line([span("    "), dim(t, "the swap is optimistic. two readers can hold the stale ref")]))
  L.push(line([span("    "), sink(t, "if the second acquire lands inside the swap window, the", 1)]))
  L.push(line([span("    "), sink(t, "12 more", 2)]))
  L.push(blank())
  L.push(line([span("  "), dim(t, "read "), body(t, "src/auth/token.ts"), dim(t, " 120–208 · grep "), body(t, "refreshToken("), dim(t, " 9 sites")]))
  L.push(blank())
  L.push(line([span("  "), span("edit ", t.secondary), body(t, "token.ts")], [span("+9 ", t.diffAdded), span("−3  ", t.diffRemoved)]))
  L.push(line([span("    "), ...bleed(t, "store.swap(key, fresh)", t.diffRemoved, t.diffRemoved, Math.min(52, w - 4))]))
  L.push(line([span("    "), ...bleed(t, "await store.swapLocked(lock, fresh)", t.diffAdded, t.diffAdded, Math.min(52, w - 4))]))
  L.push(blank())
  L.push(line([span("  "), span("run ", t.primary), body(t, narrow ? "bun test" : "bun test packages/api")], [span("212 pass", t.success, undefined, true), dim(t, " · 4.2s  ")]))
  L.push(line([span("    "), dim(t, "418 expect() across 14 files")]))
  L.push(line([span("    "), sink(t, "ran 212 tests, 0 fail [3.91s]", 1)]))
  L.push(line([span("    "), sink(t, "46 more", 2)]))
  L.push(blank())
  L.push(line([], [span("changed token.ts", t.text), dim(t, " · build · fable-5 · 31s · $0.04  ")]))
  L.push(blank())
  L.push(line([span("  "), ...fadeRule(t, mix(t.primary, t.bg ?? t.muted, 0.35), Math.min(56, w))]))
  // bare bright cursor. no pool — tried it, reads as selection residue.
  L.push(line([span("  "), span("█", t.primary)]))
  L.push(line([span("  "), dim(t, narrow ? "fable-5 · 61% · $0.83" : "fable-5 · context 61% · $0.83 today")]))
  L.push(blank())

  return L
}

export function homeD(t: Palette, cols: number): Line[] {
  const L: Line[] = []
  const row = (name: string, title: string, age: string) =>
    line([span("  "), span(name.padEnd(14), mix(idColor(t, name), t.text, 0.15), undefined, true), body(t, title)], [dim(t, `${age}  `)])

  L.push(blank())
  L.push(blank())
  L.push(line([span("  "), ...grad("c o d e m a x x x i n g", t.primary, mix(t.primary, t.accent, 0.85), true)]))
  L.push(line([span("  "), ...fadeRule(t, t.primary, 32)]))
  L.push(blank())
  L.push(line([span("  "), dim(t, "saturday. dev is clean. fable-5 is up.")]))
  L.push(blank())
  L.push(blank())
  L.push(row("clauseo-api", "refresh token race", "2m"))
  L.push(row("cmx", "tui overhaul, design deck", "1h"))
  L.push(row("blog", "f1 preseason images", "3d"))
  L.push(blank())
  L.push(blank())
  L.push(line([span("  "), sink(t, "type to start", 1)]))
  L.push(blank())

  return L
}

export function asksD(t: Palette, cols: number): Line[] {
  const agent = idColor(t, "build")
  const w = cols - 4
  const L: Line[] = []

  L.push(blank())
  L.push(line([span("  "), sink(t, "busy — the sentence burns toward its leading edge", 1)]))
  L.push(blank())
  // kinetic without animation: the tail of the sentence glows hotter
  // than its head. static cells that read as motion. the meter is a
  // decision instrument — it tells you when to reach for a fresh wave.
  L.push(line([span("  "), ...grad("hunting the race in token.ts", mix(agent, t.bg ?? t.muted, 0.55), agent, true), dim(t, " · 12s")], [dim(t, "esc to stop  ")]))
  L.push(line([span("  "), dim(t, "fable-5 · "), span("84% full · compact soon", t.warning), dim(t, " · $0.83")]))
  L.push(blank())
  L.push(blank())
  L.push(line([span("  "), sink(t, "ask — one glow at a time: the work cools, the ask burns", 1)]))
  L.push(blank())
  L.push(line([span("  "), sink(t, "hunting the race in token.ts · paused", 1)]))
  L.push(blank())
  L.push(line([span("  "), span("bash wants to run", t.warning, undefined, true)]))
  L.push(line([span("  "), ...fadeRule(t, t.warning, Math.min(34, w))]))
  L.push(line([span("    "), body(t, "rm -rf node_modules && bun install")]))
  L.push(line([span("  "), span("enter", t.success, undefined, true), dim(t, " yes · "), span("a", t.info, undefined, true), dim(t, " always · "), span("d", t.error, undefined, true), dim(t, " no")]))
  L.push(blank())
  L.push(blank())
  L.push(line([span("  "), sink(t, "question", 1)]))
  L.push(blank())
  L.push(line([span("  "), span("which migration path?", t.text, undefined, true)]))
  L.push(line([span("  "), ...fadeRule(t, t.info, Math.min(34, w))]))
  L.push(line([span("    "), span("1 ", t.primary, undefined, true), body(t, "drizzle generate"), dim(t, " · recommended")]))
  L.push(line([span("    "), dim(t, "2 hand-write sql")]))
  L.push(line([span("    "), sink(t, "3 skip for now", 1)]))
  L.push(blank())
  L.push(blank())
  L.push(line([span("  "), sink(t, "the return glance — you were out, this is the bottom of the screen", 1)]))
  L.push(blank())
  L.push(line([span("  "), span("done", t.success, undefined, true), dim(t, " — changed token.ts, 212 pass · 31s · $0.04")]))
  L.push(line([span("  "), ...fadeRule(t, mix(t.primary, t.bg ?? t.muted, 0.35), Math.min(56, w))]))
  L.push(line([span("  "), span("█", t.primary)]))
  L.push(line([span("  "), dim(t, "fable-5 · 61% · $0.83 today")]))
  L.push(blank())

  return L
}
