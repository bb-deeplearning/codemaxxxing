// screen 3 — the command palette. one sheet: chip title, ❯ filter, rows
// with the selected one lifted. on surface themes the sheet is a filled
// block; on transparent themes it holds shape through the ▏ edge and the
// selected-row accent alone. backdrop stays visible but muted.

import { line, blank, span, type Line } from "../paint"
import type { Palette } from "../theme"
import { chip, dim, cardRow } from "../ui"

export function palette(t: Palette, cols: number): Line[] {
  const w = Math.min(54, cols - 8)
  const pad = (s: string) => s + " ".repeat(Math.max(0, w - [...s].length))
  const L: Line[] = []

  L.push(blank())
  L.push(line([dim(t, "   looking at the refresh path. the token store swaps before")]))
  L.push(line([dim(t, "   the write lock releases, so the second request reads a…")]))
  L.push(blank())

  L.push(line([span("   "), chip(t, "commands", t.accent), dim(t, "  esc")]))
  L.push(cardRow(t, [span("❯ ", t.primary, undefined, true), span("th", t.text), span("█", t.muted), span(pad("").slice(4))], 3))
  L.push(cardRow(t, [span(pad(""), t.borderSubtle)], 3))
  // selected row: accent marker + raised bg when the theme has one.
  L.push(
    cardRow(
      t,
      [span("▸ ", t.primary, t.element, true), span(pad("themes            switch palette          ^xt").slice(2), t.text, t.element)],
      3,
    ),
  )
  L.push(cardRow(t, [dim(t, pad("  theme mode        dark · light · system"))], 3))
  L.push(cardRow(t, [dim(t, pad("  thinking          show · hide"))], 3))
  L.push(cardRow(t, [dim(t, pad("  thinking opacity  0.6"))], 3))
  L.push(cardRow(t, [span(pad(""))], 3))
  L.push(cardRow(t, [dim(t, pad("↑↓ move · ⏎ run · type to filter"))], 3))
  L.push(blank())

  L.push(line([dim(t, "   ❯ bun test packages/api --filter auth")]))
  L.push(blank())

  return L
}
