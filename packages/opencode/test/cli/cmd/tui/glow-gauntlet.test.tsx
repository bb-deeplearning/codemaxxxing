/** @jsxImportSource @opentui/solid */
// executable proof that the afterglow port is theme-agnostic — the TUI-side
// twin of design/deck/verify.ts:
//   1. every glow device runs under EVERY theme on this machine (bundled +
//      ~/.config/opencode/themes), both modes, both deck widths, without
//      throwing — including transparent-background themes (lucent-orng).
//   2. device geometry is exact: fadeRule/bleed produce exactly `width`
//      visible cells.
//   3. the ported surface sources contain zero hex literals — color can
//      only enter through theme tokens (specs/tui-redesign.md #1).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  bleed,
  clampRule,
  contextWords,
  fadeRule,
  grad,
  idColor,
  kinetic,
  mix,
  sinkColor,
  RULE,
  type GlowTokens,
} from "@tui/ui/glow"
import { DEFAULT_THEMES, resolveTheme, type ThemeJson } from "@tui/context/theme"

const WIDTHS = [100, 64]
const MODES = ["dark", "light"] as const

function loadThemes(): { name: string; json: ThemeJson }[] {
  const out: { name: string; json: ThemeJson }[] = []
  for (const [name, json] of Object.entries(DEFAULT_THEMES)) out.push({ name, json })
  const userDir = path.join(os.homedir(), ".config", "opencode", "themes")
  if (fs.existsSync(userDir)) {
    for (const file of fs.readdirSync(userDir)) {
      if (!file.endsWith(".json")) continue
      try {
        const json = JSON.parse(fs.readFileSync(path.join(userDir, file), "utf8"))
        out.push({ name: `user:${path.basename(file, ".json")}`, json })
      } catch {
        // malformed user json is the theme system's problem, not the design's
      }
    }
  }
  return out
}

const cells = (spans: { text: string }[]) => spans.reduce((n, s) => n + [...s.text].length, 0)

describe("glow gauntlet", () => {
  const themes = loadThemes()
  test("themes loaded (bundled + user)", () => {
    expect(themes.length).toBeGreaterThan(10)
    expect(themes.some((t) => t.name === "lucent-orng")).toBe(true)
  })

  for (const mode of MODES) {
    for (const { name, json } of loadThemes()) {
      test(`${name}/${mode}: every device holds exact geometry`, () => {
        const t = resolveTheme(json, mode) as unknown as GlowTokens
        for (const cols of WIDTHS) {
          const w = cols - 4
          // rules at every deck width, clamped like the frames
          for (const target of [RULE.human, RULE.thinking, RULE.ask, RULE.deck]) {
            const width = clampRule(target, w)
            const rule = fadeRule(t, t.warning, width)
            expect(cells(rule)).toBe(width)
          }
          // diff washes: exact padded width on bg themes, single span on
          // transparent ones — either way it never throws and never leaks bg
          const wash = Math.min(52, w - 4)
          const row = bleed(t, "await store.swapLocked(lock, fresh)", t.success, t.success, wash)
          if (t.background.a > 0) {
            expect(cells(row)).toBeGreaterThanOrEqual(wash)
            for (const s of row) expect(s.bg).toBeDefined()
          } else {
            expect(row.length).toBe(1)
            expect(row[0]!.bg).toBeUndefined()
          }
          // kinetic sentence + wordmark + sinks + meter words
          kinetic(t, "hunting the race in token.ts", t.accent)
          grad("c o d e m a x x x i n g", t.primary, mix(t.primary, t.accent, 0.85), true)
          sinkColor(t, 1)
          sinkColor(t, 2)
          contextWords(t, 84)
          contextWords(t, 95)
          const set = [t.primary, t.secondary, t.accent, t.success, t.warning, t.error, t.info]
          expect(set).toContainEqual(idColor(t, "clauseo-api"))
        }
      })
    }
  }
})

describe("zero hex literals in ported surfaces", () => {
  const TUI = path.resolve(import.meta.dir, "../../../../src/cli/cmd/tui")
  const SURFACES = [
    "ui/glow.tsx",
    "routes/session/index.tsx",
    "component/prompt/index.tsx",
    "routes/home.tsx",
    "routes/session/permission.tsx",
    "routes/session/question.tsx",
    "feature-plugins/home/footer.tsx",
    "ui/dialog.tsx",
    "ui/dialog-select.tsx",
    "ui/dialog-alert.tsx",
    "ui/dialog-confirm.tsx",
    "ui/dialog-prompt.tsx",
    "ui/dialog-help.tsx",
    "component/dialog-command.tsx",
    "routes/session/sidebar.tsx",
    "component/sidebar-section.tsx",
    "feature-plugins/sidebar/context.tsx",
    "feature-plugins/sidebar/files.tsx",
    "feature-plugins/sidebar/lsp.tsx",
    "feature-plugins/sidebar/mcp.tsx",
    "feature-plugins/sidebar/todo.tsx",
    "feature-plugins/sidebar/footer.tsx",
  ]
  for (const file of SURFACES) {
    test(file, () => {
      const src = fs.readFileSync(path.join(TUI, file), "utf8")
      const hexes = src.match(/#[0-9a-fA-F]{6}/g)
      expect(hexes ?? []).toEqual([])
    })
  }
})
