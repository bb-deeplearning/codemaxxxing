// codemaxxxing — figlet `slant` italic ASCII wordmark, single line.
//
//   "codemaxxxing"  →  6 rows × 80 cells, generated with `figlet -f slant -k`
//
// `-k` (kerning) keeps every letter glyph fully separated — adjacent letters
// don't share columns, so each glyph stands on its own. This fixes the
// previous build's bleed where slant's italic lean made the leftmost `x`
// share columns with `a` and the rightmost `x` share columns with `i`,
// causing the primary-tinted xxx zone to land partly on `a` and `i`.
//
// Font-independent: only / \ _ ( ) , ` | < > characters — every monospace
// terminal font ships these. The italic lean is geometric (figlet slant
// tilts every stroke right by ~10°), not a TextAttributes.ITALIC
// instruction (which would depend on the user's terminal font shipping
// italic glyphs). Brand identity lives in the glyphs we draw, not in the
// user's font choice.
//
// Three ink zones per row, with a DIFFERENT split column per row because
// the italic lean shifts each glyph's bounding box differently across rows:
//
//                row 0   row 1   row 2   row 3   row 4   row 5
//   codema ends  44      44      44      43      42      —
//   xxx zone     —       45-63   45-62   44-61   43-60   —
//   ing starts   65      64      63      62      61      —
//
// Rows 0 and 5 contain no xxx cells (just the i top dot and g descender
// tail respectively), so their split column is placed in the middle of
// the empty xxx region for visual continuity.
//
// `text` is used (not `textMuted`) so the wordmark stays legible on low-
// contrast themes where textMuted ≈ background.

export type ColorRole = "primary" | "secondary" | "accent" | "text" | "textMuted" | "primaryPeak" | "border"

export type Segment = { chars: string; ink: ColorRole }

export type LogoShape = { rows: Segment[][] }

export const logo: LogoShape = {
  rows: [
    // row 0 — top of d (codema) + top of i (ing); no xxx cells
    [
      { chars: "                    __                       ", ink: "text" },
      { chars: "                  ", ink: "primary" },
      { chars: "  _              ", ink: "text" },
    ],
    // row 1 — letter tops; xxx tops are `_  __` × 3 with kern gaps
    [
      { chars: "  _____ ____   ____/ /___   ____ ___   ____ _", ink: "text" },
      { chars: " _  __ _  __ _  __ ", ink: "primary" },
      { chars: "(_)____   ____ _", ink: "text" },
    ],
    // row 2 — italic forward-slash strokes; xxx verticals are `| |/_/` × 3
    [
      { chars: " / ___// __ \\ / __  // _ \\ / __ `__ \\ / __ `/", ink: "text" },
      { chars: "| |/_/| |/_/| |/_/", ink: "primary" },
      { chars: "/ // __ \\ / __ `/", ink: "text" },
    ],
    // row 3 — descender row; xxx crosses are `_>  <` × 3 with kern gaps
    [
      { chars: "/ /__ / /_/ // /_/ //  __// / / / / // /_/ /", ink: "text" },
      { chars: "_>  < _>  < _>  < ", ink: "primary" },
      { chars: "/ // / / // /_/ / ", ink: "text" },
    ],
    // row 4 — italic backslash baselines; xxx baselines are `/_/|_|` × 3
    [
      { chars: "\\___/ \\____/ \\__,_/ \\___//_/ /_/ /_/ \\__,_/", ink: "text" },
      { chars: "/_/|_|/_/|_|/_/|_|", ink: "primary" },
      { chars: "/_//_/ /_/ \\__, /  ", ink: "text" },
    ],
    // row 5 — g descender tail; no xxx cells
    [
      { chars: "                                             ", ink: "text" },
      { chars: "                  ", ink: "primary" },
      { chars: "        /____/   ", ink: "text" },
    ],
  ],
}

// GO splash — tiny "GO" used in the upsell dialog (kept simple, no zone coloring).
export const go: LogoShape = {
  rows: [
    [
      { chars: "    ", ink: "text" },
      { chars: " ", ink: "text" },
      { chars: "    ", ink: "text" },
    ],
    [
      { chars: "█▀▀▀", ink: "text" },
      { chars: " ", ink: "text" },
      { chars: "█▀▀█", ink: "text" },
    ],
    [
      { chars: "█_^█", ink: "text" },
      { chars: " ", ink: "text" },
      { chars: "█__█", ink: "text" },
    ],
    [
      { chars: "▀▀▀▀", ink: "text" },
      { chars: " ", ink: "text" },
      { chars: "▀▀▀▀", ink: "text" },
    ],
  ],
}

// CLI wordmark — used by ui.ts for the terminal banner (old left/right format kept
// for the ANSI fallback; the TUI uses the segmented `logo` above).
export const wordmark = {
  left: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
  right: [
    "                                       ",
    "█▀▄▀█ █▀▀█ █▄▄█ █▄▄█ █▄▄█ ▀██▀ █▀▀▄ █▀▀▀",
    "█_▀_█ █^^█ _██_ _██_ _██_ _██_ █__█ █_▀█",
    "▀   ▀ ▀  ▀ █▀▀█ █▀▀█ █▀▀█ ▄██▄ ▀~~▀ ▀▀▀▀",
  ],
}

export const marks = "_^~,"
