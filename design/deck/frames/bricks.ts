// direction c — bricks on a table. the page is flat: prose flows plain,
// lowercase, air everywhere. artifacts are physical objects: your
// request, an edit, a run, an ask, the input field — fitted surface
// bricks with a chunky paint stripe and a hard half-block drop shadow.
// status is a lowercase word in color, never a glyph. quiet tools stay
// flat one-liners; only things with consequence get mass.

import { line, blank, span, mix, type Line } from "../paint"
import type { Palette } from "../theme"
import { dim, body, acc, idColor, brick, diffAdd, diffDel } from "../ui"

export function sessionC(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  const you = idColor(t, "you")
  const add = diffAdd(t)
  const del = diffDel(t)
  const L: Line[] = []

  L.push(blank())
  // your request: the first object placed on the table.
  L.push(
    ...brick(
      t,
      [
        [
          span(narrow ? "fix the refresh token race" : "fix the refresh token race, concurrent", t.text, undefined, true),
          dim(t, narrow ? "" : "   12:02"),
        ],
        ...(narrow ? [] : [[span("requests drop the new token", t.text, undefined, true)]]),
      ],
      { stripe: you },
    ),
  )
  L.push(blank())
  L.push(line([body(t, "   looking at the refresh path. the token store swaps before the")]))
  L.push(line([body(t, "   write lock releases, so the second request reads a dead token.")]))
  L.push(blank())
  L.push(line([dim(t, "   thinking · the swap is optimistic, two readers can hold the stale")]))
  L.push(line([dim(t, "   ref if the second acquire lands inside the window · 12 more lines")]))
  L.push(blank())
  L.push(line([dim(t, "   read "), body(t, "src/auth/token.ts"), dim(t, " 120–208   ·   grep "), body(t, "refreshToken("), dim(t, " 9 sites")]))
  L.push(blank())
  // the edit: an object. diff rows tinted inside the brick.
  L.push(
    ...brick(
      t,
      [
        [span("token.ts", t.text, undefined, true), dim(t, "   two lines")],
        [span("store.swap(key, fresh)", del.fg, del.bg)],
        [span("await store.swapLocked(lock, fresh)", add.fg, add.bg)],
      ],
      { stripe: t.secondary },
    ),
  )
  L.push(blank())
  // the run: an object. "212 pass" is a word wearing its color.
  L.push(
    ...brick(
      t,
      [
        [span(narrow ? "bun test" : "bun test packages/api", t.text, undefined, true), span("   212 pass", t.success, undefined, true), dim(t, " · 4.2s")],
        [dim(t, "418 expect() across 14 files · 46 more lines")],
      ],
      { stripe: t.primary },
    ),
  )
  L.push(blank())
  L.push(line([], [dim(t, "build · fable-5 · 31s · $0.04  ")]))
  L.push(blank())
  // the input field: the biggest brick on the table.
  L.push(
    ...brick(
      t,
      [
        [span("█", t.primary), span("")],
        [dim(t, narrow ? "fable-5 · 61% full · $0.83" : "fable-5 · context 61% full · $0.83 today")],
      ],
      { stripe: t.primary, min: cols - 12 },
    ),
  )
  L.push(blank())

  return L
}

export function homeC(t: Palette, cols: number): Line[] {
  const L: Line[] = []
  const x1 = t.set[0]!
  const x2 = t.set[2]!
  const x3 = t.set[6]!
  const sh = t.bg ?? t.panel ? mix(t.bg ?? t.panel!, { r: 0, g: 0, b: 0 }, t.mode === "dark" ? 0.5 : 0.35) : undefined
  const mark = "c o d e m a "
  const xs = "x x x "
  const tail = "i n g"

  L.push(blank())
  L.push(blank())
  L.push(
    line([
      span("   "),
      span(mark, t.text, undefined, true),
      span("x ", x1, undefined, true),
      span("x ", x2, undefined, true),
      span("x ", x3, undefined, true),
      span(tail, t.text, undefined, true),
    ]),
  )
  // the wordmark casts a shadow: it's an object too.
  if (sh) L.push(line([span("    "), span("▀".repeat([...mark].length + [...xs].length + [...tail].length), sh)]))
  L.push(blank())
  L.push(line([dim(t, "   saturday. dev is clean. fable-5 is up.")]))
  L.push(blank())
  L.push(
    ...brick(t, [[span("clauseo-api", idColor(t, "clauseo-api"), undefined, true), body(t, "  refresh token race"), dim(t, "   2m")]], {
      stripe: idColor(t, "clauseo-api"),
    }),
  )
  L.push(
    ...brick(t, [[span("cmx", idColor(t, "cmx"), undefined, true), body(t, "  tui overhaul, design deck"), dim(t, "   1h")]], {
      stripe: idColor(t, "cmx"),
    }),
  )
  L.push(
    ...brick(t, [[span("blog", idColor(t, "blog"), undefined, true), body(t, "  f1 preseason images"), dim(t, "   3d")]], {
      stripe: idColor(t, "blog"),
    }),
  )
  L.push(blank())
  L.push(line([dim(t, "   type to start")]))
  L.push(blank())

  return L
}

export function asksC(t: Palette, cols: number): Line[] {
  const agent = idColor(t, "build")
  const L: Line[] = []

  L.push(blank())
  L.push(line([dim(t, "   busy — the field tells you what it's doing")]))
  L.push(blank())
  L.push(
    ...brick(
      t,
      [
        [span("hunting the race in token.ts", agent, undefined, true), dim(t, " · 12s")],
        [dim(t, "esc to stop · fable-5 · 61% full")],
      ],
      { stripe: agent, min: cols - 12 },
    ),
  )
  L.push(blank())
  L.push(blank())
  L.push(line([dim(t, "   permission — the ask is an object you act on")]))
  L.push(blank())
  L.push(
    ...brick(
      t,
      [
        [span("bash wants to run", t.warning, undefined, true)],
        [body(t, "rm -rf node_modules && bun install")],
        [span("enter", t.success, undefined, true), dim(t, " yes · "), span("a", t.info, undefined, true), dim(t, " always · "), span("d", t.error, undefined, true), dim(t, " no")],
      ],
      { stripe: t.warning },
    ),
  )
  L.push(blank())
  L.push(blank())
  L.push(line([dim(t, "   question")]))
  L.push(blank())
  L.push(
    ...brick(
      t,
      [
        [span("which migration path?", t.text, undefined, true)],
        [span("1", t.primary, undefined, true), body(t, " drizzle generate"), dim(t, " · recommended")],
        [dim(t, "2 hand-write sql")],
        [dim(t, "3 skip for now")],
      ],
      { stripe: t.info },
    ),
  )
  L.push(blank())

  return L
}
