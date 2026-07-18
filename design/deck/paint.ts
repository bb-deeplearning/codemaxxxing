// truecolor cell painter for the design deck. zero deps, static frames only.
// frames are arrays of Line; a Line is left spans + optional right-aligned
// spans + optional full-row background fill. render() clips/pads to an
// exact column count so every frame is a perfect rectangle of cells.

export interface Rgb {
  r: number
  g: number
  b: number
}

export const rgb = (hex: string): Rgb => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
})

// linear blend a→b. used for bg tints (diff rows, subtle fills).
export const mix = (a: Rgb, b: Rgb, alpha: number): Rgb => ({
  r: Math.round(a.r + (b.r - a.r) * alpha),
  g: Math.round(a.g + (b.g - a.g) * alpha),
  b: Math.round(a.b + (b.b - a.b) * alpha),
})

export interface Span {
  text: string
  fg?: Rgb
  bg?: Rgb
  bold?: boolean
}

export const span = (text: string, fg?: Rgb, bg?: Rgb, bold?: boolean): Span => ({ text, fg, bg, bold })

export interface Line {
  left: Span[]
  right?: Span[]
  bg?: Rgb
}

export const line = (left: Span[], right?: Span[], bg?: Rgb): Line => ({ left, right, bg })
export const blank = (bg?: Rgb): Line => ({ left: [], bg })

const cells = (s: string): number => [...s].length

const spanWidth = (spans: Span[]): number => spans.reduce((n, s) => n + cells(s.text), 0)

const sgr = (s: Span, rowBg: Rgb | undefined): string => {
  const codes: string[] = []
  if (s.bold) codes.push("1")
  if (s.fg) codes.push(`38;2;${s.fg.r};${s.fg.g};${s.fg.b}`)
  const bg = s.bg ?? rowBg
  if (bg) codes.push(`48;2;${bg.r};${bg.g};${bg.b}`)
  return codes.length > 0 ? `\x1b[${codes.join(";")}m` : ""
}

const paint = (spans: Span[], rowBg: Rgb | undefined): string =>
  spans.map((s) => `${sgr(s, rowBg)}${s.text}\x1b[0m`).join("")

// clip spans to a max cell width, preserving styling.
function clip(spans: Span[], max: number): Span[] {
  const out: Span[] = []
  let used = 0
  for (const s of spans) {
    const w = cells(s.text)
    if (used + w <= max) {
      out.push(s)
      used += w
      continue
    }
    const room = max - used
    if (room > 0) out.push({ ...s, text: [...s.text].slice(0, room).join("") })
    return out
  }
  return out
}

// compose a line into its final padded span list at exactly `cols` cells.
// shared by the ansi renderer below and the html renderer (render-html.ts)
// so both surfaces paint identical cells.
export function compose(l: Line, cols: number): Span[] {
  const right = l.right ?? []
  const rightW = Math.min(spanWidth(right), cols)
  const leftMax = right.length > 0 ? cols - rightW - 1 : cols
  const left = clip(l.left, Math.max(0, leftMax))
  const gap = cols - spanWidth(left) - rightW
  const out: Span[] = [...left]
  if (gap > 0) out.push({ text: " ".repeat(gap), bg: l.bg })
  out.push(...clip(right, cols))
  return out.map((s) => (s.bg || !l.bg ? s : { ...s, bg: l.bg }))
}

// render one line to exactly `cols` columns of styled cells.
export function render(l: Line, cols: number): string {
  return compose(l, cols)
    .map((s) => `${sgr(s, l.bg)}${s.text}\x1b[0m`)
    .join("")
}

export * as Paint from "./paint"
