// screen 4 — the deck's states, stacked with labels: idle, busy (spinner
// verb + interrupt), permission ask, question. asks are cards with keyed
// choices — chips make the decision tactile, not a wall of prose.

import { line, blank, span, type Line } from "../paint"
import type { Palette } from "../theme"
import { chip, dim, body, acc, contextStuds, cardRow, strip, idColor, DOT } from "../ui"

export function asks(t: Palette, cols: number): Line[] {
  const agent = idColor(t, "build")
  const label = (s: string) => line([span("  "), span(s, t.borderActive, undefined, true)])
  const L: Line[] = []

  L.push(blank())
  L.push(label("idle"))
  L.push(strip(t, [span(" ❯ ", t.primary, undefined, true), span("█", t.text)]))
  L.push(strip(t, [span(" "), chip(t, "build", agent), span(" "), dim(t, "fable-5")], [...contextStuds(t, 38), dim(t, " · $0.21 ")]))
  L.push(blank())

  L.push(label("busy · what it's doing, not a spinner riddle"))
  L.push(strip(t, [span(` ${DOT.live} `, agent, undefined, true), body(t, "hunting the race in token.ts…"), dim(t, " 12s")], [dim(t, "esc interrupt ")]))
  L.push(strip(t, [span(" "), chip(t, "build", agent), span(" "), dim(t, "fable-5")], [...contextStuds(t, 61), dim(t, " · $0.83 ")]))
  L.push(blank())

  L.push(label("permission"))
  L.push(line([span("  "), chip(t, "bash", t.warning), body(t, " wants to run")]))
  L.push(cardRow(t, [span("❯ ", t.warning, undefined, true), body(t, "rm -rf node_modules && bun install")], 2))
  L.push(
    line([
      span("  "),
      chip(t, "⏎ once", t.success),
      span(" "),
      chip(t, "a always", t.info),
      span(" "),
      chip(t, "d deny", t.error),
      dim(t, "  esc dismiss"),
    ]),
  )
  L.push(blank())

  L.push(label("question"))
  L.push(line([span("  "), chip(t, "question", t.info), body(t, " which migration path?")]))
  L.push(cardRow(t, [acc("● 1 ", t.primary, true), body(t, "drizzle generate"), dim(t, " · recommended")], 2))
  L.push(cardRow(t, [dim(t, "  2 hand-write sql")], 2))
  L.push(cardRow(t, [dim(t, "  3 skip for now")], 2))
  L.push(blank())

  return L
}
