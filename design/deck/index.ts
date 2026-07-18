// the design deck. full mock screens for the tui overhaul, painted with
// real cells through real opencode theme files — including transparent
// ones. this is a drawing board, not a prototype: argue with a screen,
// edit its frame, run again.
//
//   bun design/deck/index.ts            interactive
//   keys: ←/→ screens · t theme · m dark/light · w width · q quit
//
//   bun design/deck/index.ts --print --frame 1 --theme toybox --cols 72
//                                       dump one frame (vhs / ci / review)

import { render, type Line } from "./paint"
import { loadPalettes, type Mode, type Palette } from "./theme"
import { session } from "./frames/session"
import { home } from "./frames/home"
import { palette } from "./frames/palette"
import { asks } from "./frames/asks"
import { agents } from "./frames/agents"
import { waves } from "./frames/waves"
import { sessionB, homeB } from "./frames/page"
import { sessionC, homeC, asksC } from "./frames/bricks"
import { sessionD, homeD, asksD } from "./frames/glow"

const FRAMES: { name: string; build: (t: Palette, cols: number) => Line[] }[] = [
  { name: "session·glow", build: sessionD },
  { name: "home·glow", build: homeD },
  { name: "asks·glow", build: asksD },
  { name: "session·bricks", build: sessionC },
  { name: "home·bricks", build: homeC },
  { name: "asks·bricks", build: asksC },
  { name: "session·page", build: sessionB },
  { name: "home·page", build: homeB },
  { name: "session·tui", build: session },
  { name: "home·tui", build: home },
  { name: "commands", build: palette },
  { name: "asks", build: asks },
  { name: "agents", build: agents },
  { name: "waves", build: waves },
]

const WIDTHS = [100, 64]

function draw(frame: number, themes: Palette[], theme: number, widthIdx: number) {
  const t = themes[theme]!
  const cols = Math.min(WIDTHS[widthIdx]!, (process.stdout.columns ?? 120) - 2)
  const margin = " ".repeat(Math.max(0, Math.floor(((process.stdout.columns ?? cols) - cols) / 2)))
  const f = FRAMES[frame]!
  const out: string[] = ["\x1b[2J\x1b[H\x1b[?25l"]
  for (const l of f.build(t, cols)) out.push(margin + render(l, cols))
  out.push("")
  out.push(
    margin +
      `\x1b[2m deck ${frame + 1}/${FRAMES.length} ${f.name} · ←→ screens · t ${t.name} (${t.mode}) · w ${cols}co · q quit\x1b[0m`,
  )
  process.stdout.write(out.join("\r\n") + "\r\n")
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }

  if (args.includes("--print")) {
    const mode = (flag("mode") ?? "dark") as Mode
    const themes = await loadPalettes(mode)
    const name = flag("theme") ?? themes[0]!.name
    const t = themes.find((x) => x.name === name)
    if (!t) throw new Error(`theme not loaded: ${name} (have: ${themes.map((x) => x.name).join(", ")})`)
    const cols = Number(flag("cols") ?? 100)
    const frame = FRAMES[Number(flag("frame") ?? 0)]
    if (!frame) throw new Error(`frame out of range`)
    for (const l of frame.build(t, cols)) process.stdout.write(render(l, cols) + "\n")
    return
  }

  let mode: Mode = "dark"
  let themes = await loadPalettes(mode)
  let frame = 0
  let theme = 0
  let widthIdx = 0

  process.stdin.setRawMode(true)
  process.stdin.resume()
  const redraw = () => draw(frame, themes, theme, widthIdx)
  process.stdout.on("resize", redraw)
  redraw()

  process.stdin.on("data", async (buf: Buffer) => {
    const k = buf.toString()
    if (k === "q" || k === "\x03") {
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H")
      process.exit(0)
    }
    if (k === "\x1b[C" || k === "l" || k === " ") frame = (frame + 1) % FRAMES.length
    if (k === "\x1b[D" || k === "h") frame = (frame - 1 + FRAMES.length) % FRAMES.length
    if (k === "t") theme = (theme + 1) % themes.length
    if (k === "w") widthIdx = (widthIdx + 1) % WIDTHS.length
    if (k === "m") {
      mode = mode === "dark" ? "light" : "dark"
      themes = await loadPalettes(mode)
      theme = Math.min(theme, themes.length - 1)
    }
    redraw()
  })
}

void main()
