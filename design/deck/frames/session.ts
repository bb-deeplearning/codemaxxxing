// screen 1 — the everyday session. no agents anywhere: one user, one
// model, real work. this is the frame that has to win, because 90% of
// hours in the tool look like this.
//
// grammar on display:
//   user turn    = identity chip + message, meta hugging the right edge
//   quiet tools  = one dim line each, state dot is the only color
//   loud tools   = cards (edit diff, test run) with collapse chips
//   thinking     = ✱ line + dim preview, collapsible
//   closing meta = right-aligned whisper with the agent's dot
//   the deck     = 2-row strip: input + identity/telemetry

import { line, blank, span, type Line } from "../paint"
import type { Palette } from "../theme"
import { chip, dim, body, acc, contextStuds, pill, collapse, cardRow, strip, idColor, DOT, diffAdd, diffDel } from "../ui"

export function session(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  const you = idColor(t, "you")
  const agent = idColor(t, "build")
  const L: Line[] = []

  L.push(blank())
  L.push(
    line(
      [span(" "), chip(t, "you", you), body(t, narrow ? " fix the refresh token race" : " fix the refresh token race, concurrent requests drop the new token")],
      [dim(t, "12:02 ")],
    ),
  )
  L.push(blank())
  L.push(line([body(t, "   looking at the refresh path. the token store swaps before the")]))
  L.push(line([body(t, "   write lock releases, so the second request reads a dead token.")]))
  L.push(blank())

  // thinking — visible, quiet, collapsible.
  L.push(line([span("   ✱ ", t.info), dim(t, "thinking · 4.1s ")], [collapse(t, 12), span(" ")]))
  L.push(cardRow(t, [dim(t, "the swap is optimistic. two readers can hold the stale ref if")], 3))
  L.push(cardRow(t, [dim(t, "the second acquire lands inside the swap window…")], 3))
  L.push(blank())

  // quiet tools — one line each.
  L.push(line([span(`   ${DOT.done} `, t.success), dim(t, "read "), body(t, "src/auth/token.ts"), dim(t, " 120–208")]))
  L.push(line([span(`   ${DOT.done} `, t.success), dim(t, "grep "), body(t, "refreshToken("), dim(t, " · 9 matches")]))
  L.push(blank())

  // edit card — diff rows as filled cells when the theme has them.
  const add = diffAdd(t)
  const del = diffDel(t)
  L.push(line([span("   ▸ ", t.warning, undefined, true), dim(t, "edit "), body(t, "src/auth/token.ts")], [acc("+9 ", t.diffAdded), acc("−3 ", t.diffRemoved)]))
  L.push(cardRow(t, [dim(t, "141 "), body(t, "  const lock = await store.acquire(key)")], 3))
  L.push(cardRow(t, [span("142 ", t.muted, del.bg), span("− store.swap(key, fresh)", del.fg, del.bg)], 3))
  L.push(cardRow(t, [span("142 ", t.muted, add.bg), span("+ await store.swapLocked(lock, fresh)", add.fg, add.bg)], 3))
  L.push(blank())

  // terminal card — ❯ anchor, exit pill, output block, collapse chip.
  L.push(
    line(
      [span("   ❯ ", t.primary, undefined, true), body(t, narrow ? "bun test pkg/api" : "bun test packages/api --filter auth")],
      [...pill(t, true, "0", "4.2s"), span(" ")],
    ),
  )
  L.push(cardRow(t, [dim(t, "212 pass · 0 fail · 418 expect()")], 3))
  L.push(cardRow(t, [dim(t, "ran 212 tests across 14 files [3.91s]")], 3))
  L.push(line([span("   "), collapse(t, 46)]))
  L.push(blank())

  // closing meta — a whisper, right-aligned.
  L.push(line([], [span(`${DOT.done} `, agent), dim(t, "build · fable-5 · 31s · $0.04 ")]))
  L.push(blank())

  // the deck.
  L.push(strip(t, [span(" ❯ ", t.primary, undefined, true), span("█", t.text)]))
  L.push(
    strip(
      t,
      [span(" "), chip(t, "build", agent), span(" "), dim(t, "fable-5")],
      [...contextStuds(t, 61), dim(t, " · $0.83 ")],
    ),
  )

  return L
}
