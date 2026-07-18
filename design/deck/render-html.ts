// renders deck frames to an html contact sheet so the design can be SEEN
// (browser screenshot → image review), not just geometry-verified. same
// compose() path as the ansi renderer — identical cells, real theme
// tokens, maple mono. transparent themes sit on a simulated terminal
// black, labeled as such.
//
//   bun design/deck/render-html.ts   →  design/deck/out/sheet.html

import { compose, type Line, type Rgb, type Span } from "./paint"
import { loadPalettes, type Palette } from "./theme"




import { sessionD, homeD, asksD } from "./frames/glow"

const MAPLE = "/Users/rohan/Documents/Personal/personal-blog/personal-blog/fonts/MapleMono-Woff2"
const TERMINAL_BLACK = "#161210" // simulated terminal bg for transparent themes

const css = (c?: Rgb) => (c ? `rgb(${c.r},${c.g},${c.b})` : undefined)
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function spanHtml(s: Span): string {
  const styles: string[] = []
  if (s.fg) styles.push(`color:${css(s.fg)}`)
  if (s.bg) styles.push(`background:${css(s.bg)}`)
  if (s.bold) styles.push(`font-weight:700`)
  return styles.length > 0 ? `<span style="${styles.join(";")}">${esc(s.text)}</span>` : esc(s.text)
}

function windowHtml(label: string, t: Palette, lines: Line[], cols: number): string {
  const bg = css(t.bg) ?? TERMINAL_BLACK
  const rows = lines.map((l) => compose(l, cols).map(spanHtml).join("")).join("\n")
  const note = t.bg ? "" : " · transparent (simulated bg)"
  return `
  <figure>
    <figcaption>${esc(label)}${note}</figcaption>
    <pre style="background:${bg};color:${css(t.text)}">${rows}</pre>
  </figure>`
}

const themes = await loadPalettes("dark")
const by = (name: string): Palette => {
  const t = themes.find((x) => x.name === name)
  if (!t) throw new Error(`theme missing: ${name}`)
  return t
}

const cells: string[] = [
  windowHtml("session·glow — toybox-noir (daily driver)", by("toybox-noir"), sessionD(by("toybox-noir"), 100), 100),
  windowHtml("asks·glow — toybox-noir · the deck's states", by("toybox-noir"), asksD(by("toybox-noir"), 100), 100),
  windowHtml("home·glow — toybox-noir", by("toybox-noir"), homeD(by("toybox-noir"), 100), 100),
  windowHtml("session·glow — toybox-noir · phone 64", by("toybox-noir"), sessionD(by("toybox-noir"), 64), 64),
  windowHtml("session·glow — lucent-orng (transparent proof)", by("lucent-orng"), sessionD(by("lucent-orng"), 100), 100),
  windowHtml("session·glow — toybox (purple proof)", by("toybox"), sessionD(by("toybox"), 100), 100),
]

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: "Maple Mono"; src: url("file://${MAPLE}/MapleMono-Regular.ttf.woff2") format("woff2"); font-weight: 400; }
  @font-face { font-family: "Maple Mono"; src: url("file://${MAPLE}/MapleMono-Bold.ttf.woff2") format("woff2"); font-weight: 700; }
  body { background: #0b0908; margin: 0; padding: 28px; display: grid; grid-template-columns: repeat(auto-fit, minmax(900px, 1fr)); gap: 28px; }
  figure { margin: 0; }
  figcaption { color: #8a7f76; font: 500 13px/1 "Maple Mono", ui-monospace, monospace; margin: 0 0 10px 2px; }
  pre { margin: 0; padding: 22px 18px; border-radius: 10px; font: 400 12.5px/1.32 "Maple Mono", ui-monospace, monospace; overflow: hidden; width: fit-content; min-width: calc(100% - 36px); }
</style>
${cells.join("\n")}
`

await Bun.write(new URL("./out/sheet.html", import.meta.url).pathname, html)
console.log("wrote design/deck/out/sheet.html")
