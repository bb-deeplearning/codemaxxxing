// afterglow vocabulary — the reusable devices from design/deck/frames/glow.ts
// ported onto real theme tokens. information has temperature: live things
// glow, finished things cool to embers, failures burn. structure is made of
// fades, never borders.
//
// contract (specs/tui-redesign.md):
//   - every color is a theme token or an interpolation between two tokens.
//     zero hex literals — the gauntlet test greps this file.
//   - transparent themes (background.a === 0) degrade every bg-dependent
//     device to fg-only; fades target textMuted instead of background.
//   - spans always render inside a SINGLE <text> per line (GOTCHAS:
//     opentui-multi-text-node-vs-single-baseline-cap). call sites memoize
//     the span arrays — they are static per (width, colors).

import { RGBA } from "@opentui/core"
import { For } from "solid-js"
import type { JSX } from "@opentui/solid"
import { tint } from "@tui/context/theme"

// the minimal token surface the devices need. the reactive theme proxy from
// useTheme() satisfies this; tests can pass plain objects.
export interface GlowTokens {
  background: RGBA
  text: RGBA
  textMuted: RGBA
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
  info: RGBA
}

export interface GlowSpan {
  text: string
  fg?: RGBA
  bg?: RGBA
  bold?: boolean
}

// deck semantics: mix(from, to, k). tint() has the same argument order and
// interpolation; re-exported under the deck's name so recipes read 1:1.
export const mix = tint

// the deck's `t.bg === undefined` becomes `background.a === 0` here —
// resolveTheme maps "transparent"/"none" to RGBA(0,0,0,0), and mixing toward
// that blends toward black, not the terminal's real background.
export const hasBg = (t: GlowTokens): boolean => t.background.a > 0

// fade target: the deck's `t.bg ?? t.muted`.
export const fadeTarget = (t: GlowTokens): RGBA => (hasBg(t) ? t.background : t.textMuted)

// per-character gradient text. chunked every 2 chars to keep span count
// sane; reads perfectly smooth at cell scale. (glow.ts:14-22)
export function grad(text: string, from: RGBA, to: RGBA, bold?: boolean): GlowSpan[] {
  const chars = [...text]
  const out: GlowSpan[] = []
  for (let i = 0; i < chars.length; i += 2) {
    const k = chars.length <= 2 ? 0 : i / (chars.length - 1)
    out.push({ text: chars.slice(i, i + 2).join(""), fg: mix(from, to, k), bold })
  }
  return out
}

// a rule that dissolves: color fades toward the page over its length.
// (glow.ts:25-28) width must already be clamped by the caller.
export function fadeRule(t: GlowTokens, color: RGBA, width: number): GlowSpan[] {
  if (width <= 0) return []
  return grad("─".repeat(width), color, mix(color, fadeTarget(t), 0.92))
}

// collapsed output sinking into the dark: the body of a thought stays
// readable, the tail dims, the "n more" whisper is almost gone. (glow.ts:48)
export const sinkColor = (t: GlowTokens, depth: number): RGBA =>
  mix(t.textMuted, fadeTarget(t), depth >= 2 ? 0.6 : 0.32)

// a wash that bleeds out: row bg strongest at the left, gone by `width`.
// 3-cell steps at low tint — 6-cell chunks band visibly on pure-black
// themes. transparent themes skip the wash entirely. (glow.ts:33-43)
export function bleed(t: GlowTokens, text: string, fg: RGBA, tintColor: RGBA, width: number): GlowSpan[] {
  if (!hasBg(t)) return [{ text, fg }]
  const chars = [...text.padEnd(width)]
  const out: GlowSpan[] = []
  for (let i = 0; i < chars.length; i += 3) {
    const k = Math.min(1, i / width)
    const bg = mix(mix(t.background, tintColor, 0.16), t.background, k)
    out.push({ text: chars.slice(i, i + 3).join(""), fg, bg })
  }
  return out
}

// kinetic busy sentence: the tail of the sentence glows hotter than its
// head — static cells that read as motion. (glow.ts:129)
export const kinetic = (t: GlowTokens, text: string, hot: RGBA): GlowSpan[] =>
  grad(text, mix(hot, fadeTarget(t), 0.55), hot, true)

// the live form: a soft pulse of brightness travels head→tail over the
// kinetic ramp. phase ∈ [0,1). this is THE one animated line the perf
// budget allows (spec #3: motion ≤ cursor + one live line) — the caller
// ticks phase only while busy and only when animations are enabled.
export function kineticLive(t: GlowTokens, text: string, hot: RGBA, phase: number): GlowSpan[] {
  const chars = [...text]
  const cool = mix(hot, fadeTarget(t), 0.55)
  const out: GlowSpan[] = []
  for (let i = 0; i < chars.length; i += 2) {
    const k = chars.length <= 2 ? 0 : i / (chars.length - 1)
    // base ramp toward the hot tail + a traveling crest that lifts each
    // chunk toward full heat as the pulse passes through it.
    const crest = Math.pow(Math.max(0, Math.cos((k - phase) * Math.PI * 2)), 3) * 0.45
    out.push({ text: chars.slice(i, i + 2).join(""), fg: mix(mix(cool, hot, k), hot, crest), bold: true })
  }
  return out
}

// stable identity color for projects — FNV-1a into the theme's own accent
// set, same construction as the deck (design/deck/ui.ts:26-33). agents keep
// local.agent.color (it honors user overrides); this is for identity keys
// that have no agent config, e.g. home rows.
export function idColor(t: GlowTokens, key: string): RGBA {
  const set = [t.primary, t.secondary, t.accent, t.success, t.warning, t.error, t.info]
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return set[h % set.length]!
}

// the context meter as a decision instrument: words over glyphs.
// thresholds match the legacy ContextBar tiers (>90 error, >70 warning).
export function contextWords(t: GlowTokens, pct: number): { text: string; fg: RGBA } | undefined {
  if (pct > 90) return { text: `${pct}% full · compact now`, fg: t.error }
  if (pct > 70) return { text: `${pct}% full · compact soon`, fg: t.warning }
  return undefined
}

// display form of a model id for whispers and summaries — the deck writes
// "fable-5", not "claude-fable-5". vendor prefixes are chrome; drop them.
export const modelWord = (id: string): string => id.replace(/^claude-/, "")

// deck rule widths (glow.ts:62,67,138,146,85) — always clamp to available width.
export const RULE = {
  human: 28,
  thinking: 20,
  ask: 34,
  deck: 56,
} as const

export const clampRule = (target: number, available: number): number => Math.max(0, Math.min(target, available))

// render a span array inside a parent <text>. one <text> per line stays the
// caller's responsibility; this only emits the <span> children.
export function Spans(props: { spans: GlowSpan[] }): JSX.Element {
  return (
    <For each={props.spans}>
      {(s) => <span style={{ fg: s.fg, bg: s.bg, bold: s.bold }}>{s.text}</span>}
    </For>
  )
}
