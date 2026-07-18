// screen 6 — waves. the run-all-waves.sh soul, kept: wave numbers, green
// done, red failed, live wave breathing at the top. studs for campaign
// progress, a sparkline for activity, one row per wave with its cost.

import { line, blank, span, type Line } from "../paint"
import type { Palette } from "../theme"
import { chip, dim, body, acc, studs, spark, DOT } from "../ui"

export function waves(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  const L: Line[] = []
  const row = (n: string, state: keyof typeof DOT, color: typeof t.text, title: string, meta: string) =>
    line([span("   "), dim(t, n.padEnd(4)), span(`${DOT[state]} `, color), body(t, title)], [dim(t, `${meta} `)])

  L.push(blank())
  L.push(line([span("   "), chip(t, "waves", t.primary), body(t, " tui-overhaul"), dim(t, narrow ? "" : " · running w4 of 12")]))
  L.push(blank())
  L.push(line([span("   "), ...studs(t, 3, 12, t.success), dim(t, "  3 done · 1 live · 8 ahead")]))
  L.push(line([span("   "), dim(t, "activity "), spark(t, [2, 5, 3, 7, 8, 4, 2, 6, 3, 1], t.info), dim(t, "  tokens "), spark(t, [1, 2, 4, 3, 6, 8, 5, 7, 4, 2], t.warning)]))
  L.push(blank())
  L.push(row("w1", "done", t.success, "tokens + paint", "2m · $0.31"))
  L.push(row("w2", "done", t.success, "session frame", "6m · $0.88"))
  L.push(row("w3", "done", t.success, "home + palette", "4m · $0.52"))
  L.push(line([span("   "), dim(t, "w4".padEnd(4)), span(`${DOT.live} `, t.primary), span("asks + agents", t.text, undefined, true), dim(t, " · verifying")], [acc("1m… ", t.primary)]))
  L.push(row("w5", "wait", t.muted, "waves route", ""))
  L.push(row("w6", "wait", t.muted, "polish gauntlet", ""))
  L.push(blank())
  L.push(line([span("   "), dim(t, "awaiting_user "), body(t, "none"), dim(t, " · one wave, one commit · ^xw open")]))
  L.push(blank())

  return L
}
