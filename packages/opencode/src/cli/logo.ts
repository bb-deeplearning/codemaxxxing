// codemaxxxing logo, left/right shape for upstream's animated Logo component.
// left renders "CODE" (4 letters, 19 cells wide — same font as upstream's "CODE").
// right renders "MAXXXING" (8 letters, 39 cells wide — using existing M/A/X/I/N/G shapes).
export const logo = {
  left: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
  right: [
    "                                       ",
    "█▀▄▀█ █▀▀█ █▄▄█ █▄▄█ █▄▄█ ▀██▀ █▀▀▄ █▀▀▀",
    "█_▀_█ █^^█ _██_ _██_ _██_ _██_ █__█ █_▀█",
    "▀   ▀ ▀  ▀ █▀▀█ █▀▀█ █▀▀█ ▄██▄ ▀~~▀ ▀▀▀▀",
  ],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
