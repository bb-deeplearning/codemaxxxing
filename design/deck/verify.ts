// executable proof that the design is theme-agnostic:
//   1. every frame renders under EVERY theme json on this machine (bundled
//      + ~/.config/opencode/themes), both modes, both deck widths, without
//      throwing — including transparent-background themes.
//   2. every rendered line is exactly `cols` visible cells (no layout
//      drift under any palette).
//   3. frames contain zero hex literals — color can only enter through
//      theme tokens (checked against the frame sources).
//
//   bun design/deck/verify.ts

import { render } from "./paint"
import { loadPalettes, type Mode } from "./theme"
import { session } from "./frames/session"
import { home } from "./frames/home"
import { palette } from "./frames/palette"
import { asks } from "./frames/asks"
import { agents } from "./frames/agents"
import { waves } from "./frames/waves"
import { sessionB, homeB } from "./frames/page"
import { sessionC, homeC, asksC } from "./frames/bricks"
import { sessionD, homeD, asksD } from "./frames/glow"

const FRAMES = { sessionD, homeD, asksD, sessionC, homeC, asksC, sessionB, homeB, session, home, palette, asks, agents, waves }
const WIDTHS = [100, 64]
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

let checks = 0
const failures: string[] = []

for (const mode of ["dark", "light"] as Mode[]) {
  const themes = await loadPalettes(mode)
  if (themes.length === 0) failures.push(`no themes loaded for mode=${mode}`)
  for (const t of themes) {
    for (const [name, build] of Object.entries(FRAMES)) {
      for (const cols of WIDTHS) {
        checks++
        try {
          for (const [i, l] of build(t, cols).entries()) {
            const visible = [...render(l, cols).replace(ANSI, "")].length
            if (visible !== cols)
              failures.push(`${t.name}/${mode}/${name}@${cols}: line ${i} is ${visible} cells, want ${cols}`)
          }
        } catch (e) {
          failures.push(`${t.name}/${mode}/${name}@${cols}: threw ${e}`)
        }
      }
    }
  }
  console.log(`mode=${mode}: ${themes.map((t) => t.name).join(", ")}`)
}

const frameSources = ["session", "home", "palette", "asks", "agents", "waves", "page", "bricks", "glow"]
for (const f of frameSources) {
  const src = await Bun.file(new URL(`./frames/${f}.ts`, import.meta.url).pathname).text()
  const hexes = src.match(/#[0-9a-fA-F]{6}/g)
  if (hexes) failures.push(`frames/${f}.ts hardcodes colors: ${hexes.join(", ")}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failures across ${checks} frame renders:`)
  for (const f of failures.slice(0, 30)) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`✓ ${checks} frame renders across all themes/modes/widths hold exact geometry, zero hardcoded colors`)
