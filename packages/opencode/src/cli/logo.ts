// codemaxxxing — figlet `slant` italic ASCII wordmark, single line.
//
//   "codemaxxxing"  →  6 rows × 69 cells (fits the 75-cell home box w/ 6 cells slack)
//
// Font-independent: only / \ _ ( ) , ` characters — every monospace terminal
// font ships these. The italic lean is geometric (figlet slant tilts every
// stroke right by ~10°), not a TextAttributes.ITALIC instruction (which would
// depend on the user's terminal font shipping italic glyphs). Brand identity
// lives in the glyphs we draw, not in the user's font choice.
//
// Three ink zones per row (split at exact figlet letter boundaries):
//   codema (cols  0–40) → text       full theme foreground
//   xxx    (cols 40–55) → primary    brand stress, ignition flash + idle breathe
//   ing    (cols 55–69) → text       full theme foreground
//
// `text` is used (not `textMuted`) so the wordmark stays legible on low-
// contrast themes where textMuted ≈ background.

export type ColorRole = "primary" | "secondary" | "accent" | "text" | "textMuted" | "primaryPeak" | "border"

export type Segment = { chars: string; ink: ColorRole }

export type LogoShape = { rows: Segment[][] }

export const logo: LogoShape = {
  rows: [
    // row 0 — top of d (codema), top of i (ing)
    [
      { chars: "                  __                    ", ink: "text" },
      { chars: "               ", ink: "primary" },
      { chars: " _            ", ink: "text" },
    ],
    // row 1 — letter tops
    [
      { chars: "  _________  ____/ /__  ____ ___  ____ _", ink: "text" },
      { chars: "_  ___  ___  __", ink: "primary" },
      { chars: "(_)___  ____ _", ink: "text" },
    ],
    // row 2 — italic forward-slash strokes
    [
      { chars: " / ___/ __ \\/ __  / _ \\/ __ `__ \\/ __ `/", ink: "text" },
      { chars: " |/_/ |/_/ |/_/", ink: "primary" },
      { chars: " / __ \\/ __ `/", ink: "text" },
    ],
    // row 3 — descender row (g hook + x crosses)
    [
      { chars: "/ /__/ /_/ / /_/ /  __/ / / / / / /_/ />", ink: "text" },
      { chars: "  <_>  <_>  </ ", ink: "primary" },
      { chars: "/ / / / /_/ / ", ink: "text" },
    ],
    // row 4 — italic backslash baselines
    [
      { chars: "\\___/\\____/\\__,_/\\___/_/ /_/ /_/\\__,_/_/", ink: "text" },
      { chars: "|_/_/|_/_/|_/_/", ink: "primary" },
      { chars: "_/ /_/\\__, /  ", ink: "text" },
    ],
    // row 5 — g descender tail
    [
      { chars: "                                        ", ink: "text" },
      { chars: "               ", ink: "primary" },
      { chars: "     /____/   ", ink: "text" },
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
