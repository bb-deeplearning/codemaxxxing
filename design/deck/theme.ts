// real opencode theme loading for the design deck. frames never see hex
// values — they see the same semantic tokens the tui exposes (background,
// backgroundPanel, backgroundElement, border, text, textMuted, primary,
// secondary, accent, success, warning, error, info, diff*). the deck's
// entire design has to survive any theme json, including transparent
// backgrounds (lucent-orng) — that constraint is enforced here by making
// every background OPTIONAL. a frame that assumes a bg fill exists will
// not compile against this shape.
//
// resolver mirrors context/theme.tsx resolveColor: defs → theme-key refs →
// {dark,light} variants → hex (6 or 8 digit, 8-digit alpha is pre-blended
// onto the resolved background for preview purposes) → "transparent"/
// "none" → undefined.

import { rgb, mix, type Rgb } from "./paint"

type ThemeValue = string | { dark: string; light: string }

export interface ThemeJson {
  defs?: Record<string, string>
  theme: Record<string, ThemeValue>
}

export type Mode = "dark" | "light"

export interface Palette {
  name: string
  mode: Mode
  // backgrounds are optional: transparent themes leave them undefined and
  // the terminal's own background shows through.
  bg?: Rgb
  panel?: Rgb
  element?: Rgb
  border: Rgb
  borderSubtle: Rgb
  borderActive: Rgb
  text: Rgb
  muted: Rgb
  primary: Rgb
  secondary: Rgb
  accent: Rgb
  success: Rgb
  warning: Rgb
  error: Rgb
  info: Rgb
  diffAdded: Rgb
  diffRemoved: Rgb
  diffAddedBg?: Rgb
  diffRemovedBg?: Rgb
  // identity palette for hashing agents/projects — same construction as
  // buildNicknamePalette in agent-tool-mount.tsx.
  set: Rgb[]
  // fg used on top of accent-filled chips. theme bg when it exists, else
  // a near-terminal default per mode.
  chipFg: Rgb
}

function resolveRaw(json: ThemeJson, key: string, mode: Mode, depth: number): string | undefined {
  if (depth > 10) return undefined
  const value: ThemeValue | string | undefined = json.theme[key] ?? json.defs?.[key]
  if (value === undefined) return key.startsWith("#") || key === "transparent" || key === "none" ? key : undefined
  if (typeof value === "object") return resolveRaw(json, value[mode], mode, depth + 1)
  if (value.startsWith("#") || value === "transparent" || value === "none") return value
  return resolveRaw(json, value, mode, depth + 1)
}

function color(json: ThemeJson, key: string, mode: Mode, base: Rgb | undefined): Rgb | undefined {
  const raw = typeof key === "string" && key.startsWith("#") ? key : resolveRaw(json, key, mode, 0)
  if (!raw || raw === "transparent" || raw === "none") return undefined
  if (raw.length === 9) {
    // 8-digit hex: pre-blend alpha onto the base for preview.
    const alpha = parseInt(raw.slice(7, 9), 16) / 255
    const under = base ?? (mode === "dark" ? rgb("#101010") : rgb("#fafafa"))
    return mix(under, rgb(raw.slice(0, 7)), alpha)
  }
  return rgb(raw)
}

const FALLBACK = { dark: rgb("#808080"), light: rgb("#808080") }

export function resolve(name: string, json: ThemeJson, mode: Mode): Palette {
  const bg = color(json, "background", mode, undefined)
  const c = (key: string, fallback?: Rgb): Rgb => color(json, key, mode, bg) ?? fallback ?? FALLBACK[mode]
  const opt = (key: string): Rgb | undefined => color(json, key, mode, bg)
  const text = c("text")
  const primary = c("primary")
  const p: Palette = {
    name,
    mode,
    bg,
    panel: opt("backgroundPanel") ?? opt("backgroundMenu"),
    element: opt("backgroundElement"),
    border: c("border"),
    borderSubtle: c("borderSubtle"),
    borderActive: c("borderActive"),
    text,
    muted: c("textMuted"),
    primary,
    secondary: c("secondary", primary),
    accent: c("accent", primary),
    success: c("success"),
    warning: c("warning"),
    error: c("error"),
    info: c("info"),
    diffAdded: c("diffAdded"),
    diffRemoved: c("diffRemoved"),
    diffAddedBg: opt("diffAddedBg"),
    diffRemovedBg: opt("diffRemovedBg"),
    set: [],
    chipFg: bg ?? (mode === "dark" ? rgb("#0e0e0e") : rgb("#fafafa")),
  }
  p.set = [p.primary, p.secondary, p.accent, p.success, p.warning, p.error, p.info]
  return p
}

// theme files come from the repo's bundled set AND the user's custom dir —
// the deck renders through whatever actually exists on this machine.
const REPO_DIR = new URL("../../packages/opencode/src/cli/cmd/tui/context/theme/", import.meta.url).pathname
const USER_DIR = `${process.env["HOME"]}/.config/opencode/themes/`

// order = the gauntlet: the daily driver first, then the rest of the
// toybox family, the transparent stress case, defaults, one busy theme.
const LINEUP = ["toybox-noir", "lucent-orng", "toybox", "nightbox", "playground", "orng", "opencode", "gruvbox"]

export async function loadPalettes(mode: Mode): Promise<Palette[]> {
  const out: Palette[] = []
  for (const name of LINEUP) {
    for (const dir of [USER_DIR, REPO_DIR]) {
      const file = Bun.file(`${dir}${name}.json`)
      if (!(await file.exists())) continue
      out.push(resolve(name, (await file.json()) as ThemeJson, mode))
      break
    }
  }
  return out
}

export * as Theme from "./theme"
