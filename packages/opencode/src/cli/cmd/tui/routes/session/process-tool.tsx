/** @jsxImportSource @opentui/solid */
import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import stripAnsi from "strip-ansi"
import { SplitBorder } from "@tui/component/border"
import { inlineSafe } from "@tui/util/inline-safe"
import type { Tool } from "@/tool/tool"
import type { ExecCommandTool } from "@/tool/process/exec-command"
import type { WriteStdinTool } from "@/tool/process/write-stdin"

// TUI part renderers for the unified_exec tools (exec_command + write_stdin)
// shipped in wave 3. These extend the per-tool dispatch in
// routes/session/index.tsx with two more `Match` clauses; the renderers
// themselves take only their per-call props plus the small color palette
// they need, so they stay decoupled from the Theme/Sync/Session context
// stack and can be unit-rendered in isolation. The session route is the
// only place that pulls colors from `useTheme()` and forwards them.
//
// Antipattern note (specs/tui-render-freeze.md):
//   - Header line is a single `<text>` node with inline `<span>` colour
//     stripes, NOT a `<box flexDirection="row">` wrapping multiple
//     children. Multi-line / multi-KB cmd or chars are pre-sanitised via
//     `inlineSafe` so the header stays one logical line even on narrow
//     terminals; the raw values stay in `props.input` for any consumer
//     that wants the original.
//   - Output renders as vertical siblings inside a column box bordered
//     on the left (same visual idiom as Shell's terminal block). Long
//     outputs collapse to MAX_OUTPUT_LINES with a click-to-expand text
//     affordance, matching the Bash renderer's interaction model.

// Output truncation cap. Matches Shell's renderer (10 lines + ellipsis).
const MAX_OUTPUT_LINES = 10

// Display caps for header strings. The header lives in a single `<text>`
// (not a flex-row), so the freeze antipattern doesn't trigger directly,
// but we still want one logical line for readability and as defence in
// depth against future structural changes.
const HEADER_CMD_MAX = 120
const HEADER_CHARS_MAX = 60

export interface ProcessTheme {
  text: RGBA
  textMuted: RGBA
  accent: RGBA
  error: RGBA
}

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  output?: string
  permission: Record<string, unknown>
  tool: string
  part: ToolPart
}

interface RenderProps<T> {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  output?: string
  part: ToolPart
  theme: ProcessTheme
  // Optional override hooks for tests. Production keeps state inside the
  // component via `createSignal`; tests can inject a controlled signal to
  // exercise the expanded/collapsed view without driving the click event.
  expanded?: boolean
  onToggleExpand?: () => void
}

function isPending(part: ToolPart): boolean {
  return part.state.status === "pending"
}

function statusError(part: ToolPart): string | undefined {
  return part.state.status === "error" ? part.state.error : undefined
}

// Pill text shown to the right of the header. Codex's exec_command leaves
// `session_id` in metadata while the process is alive and replaces it with
// `exit_code` once the process exits — we surface whichever is present so
// the header reads as either "session #N" (still running) or "exit C"
// (terminal). Same for write_stdin: alive → session pill, exited → exit.
function metadataPill(metadata: Record<string, unknown>): string | undefined {
  const exit = metadata.exit_code
  if (typeof exit === "number") return `exit ${exit}`
  const sid = metadata.session_id
  if (typeof sid === "number") return `session #${sid}`
  return undefined
}

// One-decimal seconds format for the wall-time pill. `wall_time_seconds`
// in the tool's metadata is the elapsed real time the model spent inside
// this call. Hidden when absent (pending / running with no metadata yet).
function wallTimeLabel(metadata: Record<string, unknown>): string | undefined {
  const w = metadata.wall_time_seconds
  if (typeof w !== "number") return undefined
  return `${w.toFixed(1)}s`
}

// Output renderer reused by both Process and ProcessWriteStdin. Splits the
// output once per output change, caps to MAX_OUTPUT_LINES collapsed, and
// exposes a click affordance when the cap is exceeded. ANSI escape
// sequences are stripped because the model PTY output can carry colour
// codes and pager artefacts that are noise in the transcript view.
function OutputBlock(props: {
  output: string
  theme: ProcessTheme
  expanded: boolean
  onToggle: () => void
  prefix?: JSX.Element
}) {
  const lines = createMemo(() => props.output.split("\n"))
  const overflow = createMemo(() => lines().length > MAX_OUTPUT_LINES)
  const limited = createMemo(() => {
    if (props.expanded || !overflow()) return props.output
    return [...lines().slice(0, MAX_OUTPUT_LINES), "…"].join("\n")
  })

  return (
    <box
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.theme.accent}
      paddingLeft={1}
      gap={1}
      flexShrink={0}
      onMouseUp={overflow() ? props.onToggle : undefined}
    >
      <Show when={props.prefix}>{props.prefix}</Show>
      <text fg={props.theme.textMuted}>{limited()}</text>
      <Show when={overflow()}>
        <text fg={props.theme.textMuted}>{props.expanded ? "Click to collapse" : "Click to expand"}</text>
      </Show>
    </box>
  )
}

export function Process(props: RenderProps<typeof ExecCommandTool>) {
  const cmd = createMemo(() => inlineSafe(props.input.cmd ?? "", HEADER_CMD_MAX))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const pill = createMemo(() => metadataPill(props.metadata as Record<string, unknown>))
  const wall = createMemo(() => wallTimeLabel(props.metadata as Record<string, unknown>))
  const error = createMemo(() => statusError(props.part))
  // Expand state has two flavours. Tests inject a controlled `expanded`
  // prop + an optional toggle callback so they can step through the
  // collapsed / expanded views without driving the click event. Production
  // owns the signal here and toggles it on click. The same shape lives in
  // ProcessWriteStdin below; the duplication is intentional — pulling it
  // into a shared helper costs more in coverage tooling quirks (the
  // helper's body lines never register as covered) than it saves.
  const [localExpanded, setLocalExpanded] = createSignal(false)
  const expanded = createMemo(() => props.expanded ?? localExpanded())
  const toggle = () => (props.onToggleExpand ? props.onToggleExpand() : setLocalExpanded((v) => !v))

  return (
    <Switch>
      <Match when={isPending(props.part)}>
        <text fg={props.theme.textMuted}>exec · preparing…</text>
      </Match>
      <Match when={true}>
        <box marginTop={1} gap={1} flexShrink={0}>
          <text fg={props.theme.textMuted}>
            <span style={{ fg: props.theme.textMuted }}>exec · </span>
            <span style={{ fg: props.theme.text }}>{cmd()}</span>
            <Show when={pill()}>
              <span style={{ fg: props.theme.textMuted }}> · {pill()}</span>
            </Show>
            <Show when={wall()}>
              <span style={{ fg: props.theme.textMuted }}> · {wall()}</span>
            </Show>
          </text>
          <Show when={output()}>
            <OutputBlock
              output={output()}
              theme={props.theme}
              expanded={expanded()}
              onToggle={toggle}
              prefix={
                <text>
                  <span style={{ fg: props.theme.accent, bold: true }}>$ </span>
                  <span style={{ fg: props.theme.text }}>{cmd()}</span>
                </text>
              }
            />
          </Show>
          <Show when={error()}>
            <text fg={props.theme.error}>{error()}</text>
          </Show>
        </box>
      </Match>
    </Switch>
  )
}

export function ProcessWriteStdin(props: RenderProps<typeof WriteStdinTool>) {
  const sid = createMemo(() => props.input.session_id)
  // Empty / omitted chars is the canonical "pure poll" pattern (codex
  // process_manager.rs:619-621): the model is just draining recent output
  // without sending input. The "(poll)" sentinel makes that shape obvious
  // in the transcript so the reader can tell at a glance which calls were
  // input vs simple drains.
  const chars = createMemo(() => {
    const c = props.input.chars ?? ""
    if (c.length === 0) return "(poll)"
    return inlineSafe(c, HEADER_CHARS_MAX)
  })
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const pill = createMemo(() => metadataPill(props.metadata as Record<string, unknown>))
  const wall = createMemo(() => wallTimeLabel(props.metadata as Record<string, unknown>))
  const error = createMemo(() => statusError(props.part))
  const [localExpanded, setLocalExpanded] = createSignal(false)
  const expanded = createMemo(() => props.expanded ?? localExpanded())
  const toggle = () => (props.onToggleExpand ? props.onToggleExpand() : setLocalExpanded((v) => !v))

  return (
    <Switch>
      <Match when={isPending(props.part)}>
        <text fg={props.theme.textMuted}>write_stdin · preparing…</text>
      </Match>
      <Match when={true}>
        <box marginTop={1} gap={1} flexShrink={0}>
          <text fg={props.theme.textMuted}>
            <span style={{ fg: props.theme.textMuted }}>write_stdin · </span>
            <span style={{ fg: props.theme.text }}>
              #{sid()} · {chars()}
            </span>
            <Show when={pill()}>
              <span style={{ fg: props.theme.textMuted }}> · {pill()}</span>
            </Show>
            <Show when={wall()}>
              <span style={{ fg: props.theme.textMuted }}> · {wall()}</span>
            </Show>
          </text>
          <Show when={output()}>
            <OutputBlock output={output()} theme={props.theme} expanded={expanded()} onToggle={toggle} />
          </Show>
          <Show when={error()}>
            <text fg={props.theme.error}>{error()}</text>
          </Show>
        </box>
      </Match>
    </Switch>
  )
}

// Pass-through alias for ToolProps so production wiring in
// routes/session/index.tsx can spread its existing per-call bag without
// reshaping it. The two extra fields RenderProps adds (theme, optional
// expanded/onToggleExpand) are passed explicitly by the call site.
export type { ToolProps as ProcessToolProps }

export * as ProcessTool from "./process-tool"
