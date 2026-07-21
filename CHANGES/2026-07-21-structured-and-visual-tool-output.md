# Changes: Structured + visual tool output

**Date**: 2026-07-21

Two tool-output enrichments: search tools ship structured metadata alongside prose so clients render designed cards instead of parsing text, and shell-family tools attach freshly written images so screenshots narrated in prose become pixels on the tool part.

## Structured hits on grep/glob metadata (`c1baa52433`)

- **`grep`** ships `hits: [{path, line, text}]` in tool metadata — post-sort, post-cap, with display-identical truncation, so the structured view never diverges from the prose view.
- **`glob`** ships `files: []` in exact output order.
- The `matches`/count fields are untouched — 5 existing consumers read them as numbers.
- Tests: `test/tool/{grep,glob}.test.ts` (+82 lines combined).

## Shell-family tools attach freshly written images (`fbb2b766fc`)

Screenshots narrated in prose ("Screenshot saved to /tmp/x.png" — agent-browser, simctl, any CLI) previously reached the model only as a path. Now `bash`, `exec_command`, and `write_stdin` scan command + output for absolute image paths and attach them as FileParts on the tool part.

- **`src/tool/attach-images.ts` (NEW, 67 lines).** Attach iff: file exists, mtime falls inside the run window (stale files from earlier runs never attach), and **magic bytes** match a supported type — extension lies are dropped. `ImageResize` gates dimensions; hard cap of 3 attachments per call.
- **Never attaches on range re-reads or aborts** (write_stdin `since_cursor` reads and user-aborted calls stay text-only).
- Tests: `test/tool/attach-images.test.ts` (101 lines).
