// screen 2 — home. the logotype takes one accent per letter block from
// the THEME's own set (candy on toybox, orange family on lucent-orng —
// both coherent because the colors are the theme's, not ours). sessions
// are project-chipped rows whose state you can smell before opening.

import { line, blank, span, type Line } from "../paint"
import type { Palette } from "../theme"
import { chip, dim, body, acc, idColor } from "../ui"

export function home(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  const c1 = t.set[0]!
  const c2 = t.set[2]!
  const c3 = t.set[6]!
  const logoRow = (g: string) =>
    line([span("   "), span(g, c1, undefined, true), span(" "), span(g, c2, undefined, true), span(" "), span(g, c3, undefined, true)])
  const L: Line[] = []

  L.push(blank())
  L.push(logoRow("█▄▄█"))
  L.push(logoRow(" ██ "))
  L.push(logoRow("█▀▀█"))
  L.push(blank())
  L.push(line([span("   "), dim(t, "codemaxxxing · "), acc("dev ●", t.success), dim(t, " · fable-5")]))
  L.push(blank())
  L.push(line([span("   "), dim(t, "jump back in")]))
  L.push(blank())
  L.push(
    line(
      [span("   "), chip(t, "clauseo-api", idColor(t, "clauseo-api")), body(t, "  refresh token race")],
      [dim(t, narrow ? "2m " : "2m · $0.83 · dev ")],
    ),
  )
  L.push(
    line(
      [span("   "), chip(t, "cmx", idColor(t, "cmx")), body(t, "  tui overhaul, design deck")],
      [dim(t, narrow ? "1h " : "1h · $2.14 · dev ")],
    ),
  )
  L.push(
    line(
      [span("   "), chip(t, "blog", idColor(t, "blog")), body(t, "  f1 preseason post images")],
      [dim(t, narrow ? "3d " : "3d · $0.12 · main ")],
    ),
  )
  L.push(blank())
  L.push(line([span("   ❯ ", t.primary, undefined, true), dim(t, "type to start · ^k commands · ^xl sessions")]))
  L.push(blank())

  return L
}
