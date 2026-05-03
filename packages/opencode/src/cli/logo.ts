// codemaxxxing — F1 instrument panel logo for the TUI.
// Layout (9 rows × 75 cells outer / 73 cells inner — matches the prompt input box):
//   row 0: top border w/ title
//   row 1: tach bar with needle pinned past redline
//   row 2: RPM scale numbers (0K → REDLINE → MAXXXING zone)
//   row 3: D's tail (just the ▄ char above the wordmark D)
//   rows 4–6: BIG block-letter wordmark "CODEMAXXXING" (3 rows, 71 cells with 2-cell letter gaps)
//   row 7: cluster readout (gear, RPM, limiter, DRS, position)
//   row 8: bottom border
//
// Color roles (theme-driven, no hardcodes):
//   textMuted → cool / chrome   text → warm
//   primary   → hot / redline   primaryPeak → past-max overshoot
//   secondary, accent → variety stops to break monotony
//   border    → instrument-panel chrome
//
// Letter zones (within the 71-cell wordmark, 2-cell gaps between letters):
//   c o d e (cells 0-23)   → cool
//   m a     (cells 24-36)  → warm
//   x x x   (cells 37-54)  → hot (REDLINE)
//   i n g   (cells 55-70)  → peak (MAXXXING past-redline)

export type ColorRole = "primary" | "secondary" | "accent" | "text" | "textMuted" | "primaryPeak" | "border"

export type Segment = { chars: string; ink: ColorRole }

export type LogoShape = { rows: Segment[][] }

const CHROME: ColorRole = "border"

export const logo: LogoShape = {
  rows: [
    // row 0: top border + title — 75 cells
    [
      { chars: "╔════════════════════[ ", ink: CHROME },
      { chars: "codemaxxxing", ink: "primary" },
      { chars: " ", ink: CHROME },
      { chars: "•", ink: "accent" },
      { chars: " ", ink: CHROME },
      { chars: "redline pinned", ink: "primaryPeak" },
      { chars: " ]════════════════════╗", ink: CHROME },
    ],
    // row 1: tach bar with needle — 73 inner (1 leading + 71 bar + 1 trailing)
    [
      { chars: "║ ", ink: CHROME },
      { chars: "░░░░░░░░░░░░░░░░░░░░░░░░", ink: "textMuted" }, // 24 cells (cool, c/o/d/e zone)
      { chars: "▒▒▒▒▒▒▒▒▒▒▒▒▒", ink: "text" }, // 13 cells (warm, m/a)
      { chars: "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓", ink: "primary" }, // 18 cells (hot, xxx)
      { chars: "████████●▶▶▶▶▶▶▶", ink: "primaryPeak" }, // 16 cells (peak ing + needle ●▶)
      { chars: " ║", ink: CHROME },
    ],
    // row 2: scale numbers — 73 inner
    [
      { chars: "║ ", ink: CHROME },
      { chars: "0     2K    4K    6K    ", ink: "textMuted" }, // 24 cells, under c/o/d/e
      { chars: "8K    10K    ", ink: "text" }, // 13 cells, under m/a
      { chars: "12K   14K   16K   ", ink: "primary" }, // 18 cells, under xxx
      { chars: "REDLINE    MAX ▶", ink: "primaryPeak" }, // 16 cells, under ing
      { chars: " ║", ink: CHROME },
    ],
    // row 3: wordmark TOP — 71 cells, per-letter ink, custom chunky font (only █ + space, no half-blocks)
    [
      { chars: "║ ", ink: CHROME },
      { chars: "████  ", ink: "textMuted" }, // C
      { chars: "████  ", ink: "secondary" }, // O
      { chars: "████  ", ink: "text" }, // D
      { chars: "████  ", ink: "accent" }, // E
      { chars: "█   █  ", ink: "text" }, // M (5 wide)
      { chars: " ██   ", ink: "secondary" }, // A
      { chars: "█  █  ", ink: "primary" }, // X
      { chars: "█  █  ", ink: "accent" }, // X
      { chars: "█  █  ", ink: "primary" }, // X
      { chars: "████  ", ink: "primaryPeak" }, // I
      { chars: "█  █  ", ink: "secondary" }, // N
      { chars: "████", ink: "primaryPeak" }, // G
      { chars: " ║", ink: CHROME },
    ],
    // row 4: wordmark ROW 2
    [
      { chars: "║ ", ink: CHROME },
      { chars: "█     ", ink: "textMuted" }, // C
      { chars: "█  █  ", ink: "secondary" }, // O
      { chars: "█  █  ", ink: "text" }, // D
      { chars: "█     ", ink: "accent" }, // E
      { chars: "██ ██  ", ink: "text" }, // M (5 wide)
      { chars: "█  █  ", ink: "secondary" }, // A
      { chars: " ██   ", ink: "primary" }, // X
      { chars: " ██   ", ink: "accent" }, // X
      { chars: " ██   ", ink: "primary" }, // X
      { chars: " ██   ", ink: "primaryPeak" }, // I
      { chars: "██ █  ", ink: "secondary" }, // N
      { chars: "█   ", ink: "primaryPeak" }, // G
      { chars: " ║", ink: CHROME },
    ],
    // row 5: wordmark ROW 3
    [
      { chars: "║ ", ink: CHROME },
      { chars: "█     ", ink: "textMuted" }, // C
      { chars: "█  █  ", ink: "secondary" }, // O
      { chars: "█  █  ", ink: "text" }, // D
      { chars: "███   ", ink: "accent" }, // E (middle bar)
      { chars: "█ █ █  ", ink: "text" }, // M (5 wide, V-notch)
      { chars: "████  ", ink: "secondary" }, // A (crossbar)
      { chars: " ██   ", ink: "primary" }, // X
      { chars: " ██   ", ink: "accent" }, // X
      { chars: " ██   ", ink: "primary" }, // X
      { chars: " ██   ", ink: "primaryPeak" }, // I
      { chars: "█ ██  ", ink: "secondary" }, // N
      { chars: "█ ██", ink: "primaryPeak" }, // G (inward hook)
      { chars: " ║", ink: CHROME },
    ],
    // row 6: wordmark BOTTOM
    [
      { chars: "║ ", ink: CHROME },
      { chars: "████  ", ink: "textMuted" }, // C
      { chars: "████  ", ink: "secondary" }, // O
      { chars: "███   ", ink: "text" }, // D (right corner cut, suggests curve)
      { chars: "████  ", ink: "accent" }, // E
      { chars: "█   █  ", ink: "text" }, // M (5 wide)
      { chars: "█  █  ", ink: "secondary" }, // A
      { chars: "█  █  ", ink: "primary" }, // X
      { chars: "█  █  ", ink: "accent" }, // X
      { chars: "█  █  ", ink: "primary" }, // X
      { chars: "████  ", ink: "primaryPeak" }, // I
      { chars: "█  █  ", ink: "secondary" }, // N
      { chars: "████", ink: "primaryPeak" }, // G
      { chars: " ║", ink: CHROME },
    ],
    // row 7: cluster readout — labels muted, values in distinct brand colors — 73 inner
    [
      { chars: "║", ink: CHROME },
      { chars: " GEAR ", ink: "textMuted" },
      { chars: "[7]", ink: "primary" },
      { chars: "       RPM ", ink: "textMuted" },
      { chars: "18,547", ink: "accent" },
      { chars: "       LIMIT ", ink: "textMuted" },
      { chars: "●", ink: "secondary" },
      { chars: "       DRS ", ink: "textMuted" },
      { chars: "▶", ink: "primary" },
      { chars: "       P1 ", ink: "textMuted" },
      { chars: "+∞", ink: "primaryPeak" },
      { chars: "         ", ink: "textMuted" },
      { chars: "║", ink: CHROME },
    ],
    // row 8: bottom border
    [{ chars: "╚═════════════════════════════════════════════════════════════════════════╝", ink: CHROME }],
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
