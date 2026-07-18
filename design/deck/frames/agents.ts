// screen 5 — a session that passes through agents. spawn = the agent's
// chip arrives in the transcript. deliverable = same chip returns with ←.
// death = a tombstone line, not silence. presence lives in the deck row:
// colored state dots you can read without leaving the prompt. agents are
// a state a session passes through, not the app's center of gravity.

import { line, blank, span, type Line } from "../paint"
import type { Palette } from "../theme"
import { chip, dim, body, contextStuds, cardRow, strip, collapse, idColor, DOT } from "../ui"

export function agents(t: Palette, cols: number): Line[] {
  const narrow = cols < 80
  const you = idColor(t, "you")
  const agent = idColor(t, "build")
  const love = idColor(t, "lovelace")
  const noe = idColor(t, "noether")
  const L: Line[] = []

  L.push(blank())
  L.push(line([span(" "), chip(t, "you", you), body(t, narrow ? " split the parser rewrite" : " split the parser rewrite across two agents")], [dim(t, "14:20 ")]))
  L.push(blank())

  // spawn — chip + type + model. live status right.
  L.push(line([span("   "), chip(t, "lovelace", love), dim(t, " explore · fable-5")], [span(`${DOT.live} `, love), dim(t, "12s ")]))
  L.push(line([span("     "), dim(t, '"map every call site of parseClause, return file:line"')]))
  L.push(blank())

  // deliverable — same chip returns.
  L.push(line([span("   "), chip(t, "noether", noe), dim(t, " general · fable-5")], [span(`${DOT.done} `, t.success), dim(t, "2m 8s · $0.06 ")]))
  L.push(line([span("     "), span("← ", noe, undefined, true), body(t, "delivered"), dim(t, " · 4 tools · ↯ woke you")]))
  L.push(cardRow(t, [body(t, "call sites: parser.ts:88, intake.ts:141, brief.ts:57,")], 5))
  L.push(cardRow(t, [body(t, "citations.ts:203. the intake one re-parses on every…")], 5))
  L.push(line([span("     "), collapse(t, 21)]))
  L.push(blank())

  // a killed agent leaves a tombstone, not silence.
  L.push(line([span("   "), span(`${DOT.dead} `, t.muted), dim(t, "curie · closed by you · was running · 41s of work kept")]))
  L.push(blank())
  L.push(line([], [span(`${DOT.done} `, agent), dim(t, "build · fable-5 · 3m · $0.31 ")]))
  L.push(blank())

  // deck with presence cluster: one dot per live agent, in their colors.
  L.push(strip(t, [span(" ❯ ", t.primary, undefined, true), span("█", t.text)]))
  L.push(
    strip(
      t,
      [
        span(" "),
        chip(t, "build", agent),
        span(" "),
        dim(t, "fable-5  "),
        span(DOT.live, love),
        span(DOT.live, noe),
        span(`${DOT.wait} `, t.muted),
        dim(t, "2 live · ^xa"),
      ],
      [...contextStuds(t, 54), dim(t, " · $1.12 ")],
    ),
  )

  return L
}
