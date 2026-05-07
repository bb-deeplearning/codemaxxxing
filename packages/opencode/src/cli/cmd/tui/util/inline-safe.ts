// Sanitizer for any string that lands inside a `<text>` node inside a flex-
// row. Two protections, both load-bearing per specs/tui-render-freeze.md:
//
//   1. Collapse runs of whitespace (newlines, tabs, multi-spaces) into a
//      single space — kills the literal-newline antipattern.
//   2. Cap length so the resulting `<text>` stays one logical line on
//      typical terminals — kills the wrap-induced antipattern (a long
//      single-line string would still wrap to many rows on narrow widths
//      and trip the same opentui flex-row layout-budget freeze).
//
// The actual data on disk / in memory is untouched; this is purely for
// display strings that have to inline-render. Use raw value when you can
// guarantee a column-flex parent and unbounded display height.
//
// Default cap is 120 chars: comfortably one line on a 100-col terminal,
// fits inside the typical sidebar width (40 cols) when wrapped to two
// lines, and short enough that even pathologically wide MCP tool args
// can't blow the layout budget.
export function inlineSafe(value: string | undefined, max = 120): string {
  if (!value) return ""
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return normalized.slice(0, max - 1) + "…"
}
