# Wave 4 — Process tool TUI part renderer

**Prior waves:** 0-3.
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `PERF.md`, `BACKWARD_COMPAT.md`, **`GOTCHAS.md` (you read this on entry)**, **`/Users/rohan/Documents/Personal/codemaxxxing/specs/tui-render-freeze.md`** (the long-form story behind the flex-row antipattern — read this BEFORE adding any opentui structure).
**Touch points:** `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — read lines 134-154, 163-170, 240-242 (perf-critical comments), and the existing tool-renderer Switch around lines 1995-2025 before adding anything.

## Goal

Surface model-spawned PTYs (from `exec_command` / `write_stdin`) in the TUI session transcript as a tool-part renderer. No new pane, no new sync store fields, no schema changes. Match the existing tool-renderer aesthetic (BlockTool / InlineTool patterns).

## Tasks

Sequential.

### 1. Read the existing tool renderers in context

Open `routes/session/index.tsx`. Find:
- `function GenericTool` (around line 2038) — the fallback renderer
- `function InlineTool` (around line 2077) — the small-output style
- The Switch around `Match when={props.part.tool === "..."}` (around lines 1995-2025) — where you'll add the new clause

Look at the existing `Bash` (shell) renderer — search for `Match when={props.part.tool === ShellID.ToolID}` (or similar). That's the closest analog: a command that produces an output stream, possibly truncated.

### 2. Tests first — render assertions

File: `packages/opencode/src/cli/cmd/tui/routes/session/process-tool.test.tsx`

opentui's headless render mode (or whatever Solid+opentui test pattern Wave 0 surfaced for `session-render.bench.ts`) is used here. Cover:

- `exec_command renderer shows command, output, wall_time` — synthetic tool part with `tool: "exec_command"`, state.completed, output: "hello\nworld"
- `exec_command renderer shows session_id when process is still running` — state.metadata.session_id is rendered visibly
- `exec_command renderer shows exit_code when finished`
- `exec_command renderer truncates long output to N lines with expand affordance` — match the Bash renderer's behavior
- `write_stdin renderer shows session_id, chars (truncated to short preview), output`
- `write_stdin renderer renders empty chars as "(poll)"` — visual signal for pure polls
- `renderer falls back to GenericTool for unknown tool names` — backward compat: any tool we don't have a custom renderer for still works

If the headless render harness from Wave 0 wasn't built (Wave 0 marked it as a gap), use a minimal Solid render-to-string approach: render the component, walk the JSX tree, assert structure. Don't use snapshot tests on the full output (too brittle for streaming UI).

### 3. Implement the renderer

Add to `routes/session/index.tsx`:

- A `function Process(props: ToolProps<typeof ExecCommandTool>)` near the existing `function Task` (around line 2556). Mirror the Bash renderer's structure.
- A `function ProcessWriteStdin(props: ToolProps<typeof WriteStdinTool>)` similarly.
- Two new `Match` clauses in the Switch:
  ```tsx
  <Match when={props.part.tool === "exec_command"}>
    <Process {...toolprops} />
  </Match>
  <Match when={props.part.tool === "write_stdin"}>
    <ProcessWriteStdin {...toolprops} />
  </Match>
  ```

Keep the renderers simple: command + output + metadata pill (session_id / exit_code / wall_time). Match the existing visual language.

### 4. Bench the render path

File: `packages/opencode/test/perf/process-render.bench.ts`

Drive 100 synthetic `exec_command` tool parts through the message store; measure render time. Compare to the `session.render.steady` baseline from Wave 0. Budget: must not regress beyond the standard 5/10/15 budget.

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_4.json`.

### 5. Verify backward compat

The new clauses in the Switch are additive. Verify with a test: `renderer for unknown tool name (e.g. "foobar") falls through to GenericTool`. This guards against accidental breakage of unrelated tools.

## Gotchas

1. **opentui flex-row + tall text = catastrophic freeze.** This bug class has hit the codebase 4 times. Do not introduce ANY `<box flexDirection="row">` whose primary cell can be tall. Read `GOTCHAS.md` § `[tui-flex-row-with-tall-text]` and `specs/tui-render-freeze.md` before writing any opentui JSX. Process command output and write_stdin output ARE potentially-tall content — the renderer must NOT wrap them in a flex-row.

2. **Don't add new memos in the hot path unless necessary.** `index.tsx` lines 134-154, 163-170, 240-242 are explicit about the perf landmines. The existing `createMemo`s in this file are tuned. Adding fresh memos per part increases reactivity work per chunk. If your renderer needs derived state, compute it inline in JSX or with a single `createMemo` per Process component instance — not per render.

2. **Reuse `EMPTY_PARTS` / `EMPTY_MESSAGES` sentinels.** The file already defines frozen empty arrays (line 168-170) for reference-stability. Don't allocate fresh `[]` inside reactive scopes.

3. **`opentui` text node recycling.** Long outputs scroll into a `ScrollBoxRenderable`. Make sure your output rendering uses the same containers as Bash so the renderer's text-node recycling kicks in. Read how the Bash renderer wraps its output.

4. **`ToolProps<T>` typing.** The existing `ToolProps` generic infers from the tool's metadata type. For the new tools, import the metadata types from `@/tool/process/exec-command` and `@/tool/process/write-stdin`. If types aren't exported from there, export them in Wave 3 (already covered).

5. **`stripAnsi` for truncated previews.** ANSI escape sequences from `bun -e` or other tools may be in the output. The TUI uses `stripAnsi` from `strip-ansi`. Use it on output previews.

6. **No backward-compat break to existing tool renderers.** Adding `Match` clauses before the `Match when={true}` fallback is safe; the order matters (first match wins). Verify with the GenericTool fallback test.

7. **Don't break sync data shape.** This wave should not touch `context/sync.tsx`. Tool parts already flow through `sync.data.part[messageID]`; we render them via the new component. No schema or store changes needed.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/cli/cmd/tui/routes/session/process-tool.test.tsx
bun test --coverage src/cli/cmd/tui/routes/session/process-tool.test.tsx  # 100% on the new functions

# perf bench within budget vs baseline
bun test test/perf/process-render.bench.ts
bun -e "
  const { compareToBaseline } = await import('./test/lib/perf.ts')
  const wave = JSON.parse(await Bun.file('../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_4.json').text())
  for (const m of ['process.render.steady']) {
    const r = compareToBaseline(wave.metrics[m], '../../.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json', 'session.render.steady')
    if (!r.passed) { console.error(r.reasons); process.exit(1) }
  }
"

# Existing tool renderers still work
bun test src/cli/cmd/tui/routes/session/  # all session route tests pass
```

All exit 0.

## Files

New:
- `packages/opencode/src/cli/cmd/tui/routes/session/process-tool.test.tsx`
- `packages/opencode/test/perf/process-render.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_4.json`

Modified:
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — add Process + ProcessWriteStdin functions and 2 Match clauses (~80-150 lines)
