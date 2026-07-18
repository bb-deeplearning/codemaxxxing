// the shared visual vocabulary. every frame builds only from Palette's
// semantic tokens, so the design survives any opencode theme:
//   chip     identity as a filled block — bg from the theme's accent set.
//   dot      state as glyph: ● done · ◉ live · ◌ waiting · ▲ failed · ✕ dead
//   studs    meters as lego studs ▪▪▪▫▫ — context, todos, wave progress.
//   card     tool output block. bg fill when the theme HAS surfaces;
//            transparent themes (lucent-orng) fall back to a ▏ edge — the
//            structure never depends on backgrounds existing.
//   collapse ⌄ N chips instead of "Click to expand" prose.
// voice: all lowercase. color lives at identity, state, meters. content
// stays theme.text.

import { line, span, type Span, type Line, type Rgb, mix } from "./paint"
import type { Palette } from "./theme"

export const DOT = { done: "●", live: "◉", wait: "◌", fail: "▲", dead: "✕" } as const

export const dim = (t: Palette, text: string): Span => span(text, t.muted)
export const body = (t: Palette, text: string): Span => span(text, t.text)
export const acc = (text: string, color: Rgb, bold?: boolean): Span => span(text, color, undefined, bold)

export const chip = (t: Palette, text: string, color: Rgb): Span => span(` ${text} `, t.chipFg, color, true)

// stable identity color from the theme's own accent set (same hash family
// as agent-identity.ts so the deck predicts real behavior).
export function idColor(t: Palette, key: string): Rgb {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return t.set[h % t.set.length]!
}

export function studs(t: Palette, filled: number, total: number, color: Rgb): Span[] {
  const f = Math.max(0, Math.min(filled, total))
  return [span("▪".repeat(f), color), span("▫".repeat(total - f), t.borderSubtle)]
}

export function contextStuds(t: Palette, pct: number): Span[] {
  const total = 10
  const filled = Math.round((pct / 100) * total)
  const color = pct > 90 ? t.error : pct > 70 ? t.warning : t.primary
  return [...studs(t, filled, total, color), dim(t, ` ${pct}%`)]
}

export function spark(t: Palette, values: number[], color: Rgb): Span {
  const glyphs = "▁▂▃▄▅▆▇█"
  const max = Math.max(...values, 1)
  return span(values.map((v) => glyphs[Math.min(7, Math.floor((v / max) * 7.99))]).join(""), color)
}

export function pill(t: Palette, ok: boolean, label: string, timing?: string): Span[] {
  const out: Span[] = [span(`${ok ? DOT.done : DOT.fail} ${label}`, ok ? t.success : t.error, undefined, true)]
  if (timing) out.push(dim(t, ` · ${timing}`))
  return out
}

export const collapse = (t: Palette, n: number): Span =>
  t.element ? span(` ⌄ ${n} `, t.muted, t.element) : span(`⌄ ${n}`, t.muted)

// card row: surface bg fill when the theme provides panels; ▏ edge glyph
// when backgrounds are transparent. `indent` cells lead the row either way.
export function cardRow(t: Palette, spans: Span[], indent: number, right?: Span[]): Line {
  const lead = " ".repeat(indent)
  if (t.panel) {
    const bgd = (s: Span): Span => ({ ...s, bg: s.bg ?? t.panel })
    return line([span(lead), bgd(span(" ")), ...spans.map(bgd)], right?.map(bgd), undefined)
  }
  return line([span(lead), span("▏", t.borderSubtle), span(" "), ...spans], right)
}

// full-width strip (the deck at the bottom of the session). fill when
// surfaces exist; hairline-topped open rows when transparent.
export function strip(t: Palette, spans: Span[], right?: Span[]): Line {
  if (t.panel) {
    const bgd = (s: Span): Span => ({ ...s, bg: s.bg ?? t.panel })
    return line(spans.map(bgd), right?.map(bgd), t.panel)
  }
  return line(spans, right)
}

export const rule = (t: Palette, cols: number): Line => line([span("─".repeat(cols), t.borderSubtle)])

export const diffAdd = (t: Palette): { fg: Rgb; bg?: Rgb } => ({
  fg: t.diffAddedBg ? t.text : t.diffAdded,
  bg: t.diffAddedBg ?? (t.panel ? mix(t.panel, t.diffAdded, 0.16) : undefined),
})
export const diffDel = (t: Palette): { fg: Rgb; bg?: Rgb } => ({
  fg: t.diffRemovedBg ? t.text : t.diffRemoved,
  bg: t.diffRemovedBg ?? (t.panel ? mix(t.panel, t.diffRemoved, 0.16) : undefined),
})

// ── bricks ────────────────────────────────────────────────────────────
// a brick is a physical object on the page: fitted surface block, chunky
// 2-cell paint stripe, hard half-block shadow offset down-right — the
// blog's layeredShadow translated to cell space. on fully transparent
// themes the surface and shadow fall away and the stripe alone carries
// the object (graceful, still not chrome).

const BLACK: Rgb = { r: 0, g: 0, b: 0 }

const shade = (t: Palette): Rgb | undefined => {
  const base = t.bg ?? t.panel
  return base ? mix(base, BLACK, t.mode === "dark" ? 0.5 : 0.35) : undefined
}

const vis = (spans: Span[]): number => spans.reduce((n, s) => n + [...s.text].length, 0)

export interface BrickOpts {
  stripe: Rgb
  indent?: number
  // minimum inner width; bricks otherwise fit their content.
  min?: number
}

export function brick(t: Palette, rows: Span[][], opts: BrickOpts): Line[] {
  const indent = " ".repeat(opts.indent ?? 3)
  const inner = Math.max(opts.min ?? 0, ...rows.map(vis))
  const surface = t.panel ?? t.element
  const sh = shade(t)
  const out: Line[] = []
  rows.forEach((row, i) => {
    const pad = inner - vis(row)
    const spans: Span[] = [
      span(indent),
      span("  ", undefined, opts.stripe),
      span(" ", undefined, surface),
      ...row.map((s) => ({ ...s, bg: s.bg ?? surface })),
      span(" ".repeat(pad + 1), undefined, surface),
    ]
    // right shadow: half-cell, skipping the first row (offset y=1).
    if (sh && i > 0) spans.push(span("▌", sh))
    out.push(line(spans))
  })
  // bottom shadow: half-cell row, offset one cell right.
  if (sh) out.push(line([span(indent + " "), span("▀".repeat(2 + 1 + inner + 1), sh)]))
  return out
}

export * as Ui from "./ui"
