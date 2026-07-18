/** @jsxImportSource @opentui/solid */
import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import stripAnsi from "strip-ansi"
import { inlineSafe } from "@tui/util/inline-safe"
import { mix } from "@tui/ui/glow"
import type { Tool } from "@/tool/tool"
import type { ExecCommandTool } from "@/tool/process/exec-command"
import type { WriteStdinTool } from "@/tool/process/write-stdin"

// TUI part renderers for the unified_exec tools (exec_command + write_stdin),
// afterglow edition: exec_command is a loud "run" object — colored header
// word, bold command title, verdict whisper on the right edge; write_stdin
// is quiet chatter — one dim line. Output cools into the dark (dim body,
// sunk tail, "n more" whisper) instead of a bordered terminal block.
//
// The renderers take only their per-call props plus the small color
// palette they need, so they stay decoupled from the Theme/Sync/Session
// context stack and can be unit-rendered in isolation. The session route
// is the only place that pulls colors from `useTheme()` and forwards them.
//
// Antipattern note (specs/tui-render-freeze.md):
//   - The header is a flex-row justify-between of exactly two SINGLE-LINE
//     `<text>` nodes (wrapMode="none", cmd pre-sanitised via `inlineSafe`)
//     — the sanctioned right-whisper shape. Never put a wrappable child in
//     that row.
//   - Output renders as vertical siblings inside a column box.

// Output truncation cap. Matches the Shell renderer (10 lines).
const MAX_OUTPUT_LINES = 10

// Display caps for header strings.
const HEADER_CMD_MAX = 120
const HEADER_CHARS_MAX = 60

export interface ProcessTheme {
  text: RGBA
  textMuted: RGBA
  background: RGBA
  primary: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
}

// the sink tones from glow, computed against the injected palette so the
// renderers stay context-free. transparent backgrounds (a === 0) degrade
// to textMuted — the same rule as glow.fadeTarget.
function sink(theme: ProcessTheme, depth: number): RGBA {
  const target = theme.background.a > 0 ? theme.background : theme.textMuted
  return mix(theme.textMuted, target, depth >= 2 ? 0.6 : 0.32)
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

// Verdict for the right whisper. Codex's exec_command leaves `session_id`
// in metadata while the process is alive and replaces it with `exit_code`
// once it exits — alive reads as a dim "session #N", terminal reads as a
// bold verdict word ("done" / "exit C").
function verdict(theme: ProcessTheme, metadata: Record<string, unknown>): { word: string; fg: RGBA; bold: boolean } | undefined {
  const exit = metadata.exit_code
  if (typeof exit === "number") {
    if (exit === 0) return { word: "done", fg: theme.success, bold: true }
    return { word: `exit ${exit}`, fg: theme.error, bold: true }
  }
  const sid = metadata.session_id
  if (typeof sid === "number") return { word: `session #${sid}`, fg: theme.textMuted, bold: false }
  return undefined
}

// One-decimal seconds format for the wall-time whisper. `wall_time_seconds`
// in the tool's metadata is the elapsed real time the model spent inside
// this call. Hidden when absent (pending / running with no metadata yet).
function wallTimeLabel(metadata: Record<string, unknown>): string | undefined {
  const w = metadata.wall_time_seconds
  if (typeof w !== "number") return undefined
  return `${w.toFixed(1)}s`
}

// Output cooling into the dark, reused by both renderers: dim body at +2
// indent, last visible line sinks, the "n more" whisper is almost gone.
// ANSI escape sequences are stripped because the model PTY output can
// carry colour codes and pager artefacts that are noise in the transcript.
function OutputBlock(props: { output: string; theme: ProcessTheme; expanded: boolean; onToggle: () => void }) {
  const lines = createMemo(() => props.output.split("\n"))
  const overflow = createMemo(() => lines().length > MAX_OUTPUT_LINES)

  return (
    <box paddingLeft={2} flexShrink={0} onMouseUp={overflow() ? props.onToggle : undefined}>
      <Show
        when={overflow() && !props.expanded}
        fallback={<text fg={props.theme.textMuted}>{props.output}</text>}
      >
        <text fg={props.theme.textMuted}>{lines().slice(0, MAX_OUTPUT_LINES - 1).join("\n")}</text>
        <text fg={sink(props.theme, 1)} wrapMode="none">
          {lines()[MAX_OUTPUT_LINES - 1]}
        </text>
        <text fg={sink(props.theme, 2)}>{lines().length - MAX_OUTPUT_LINES} more</text>
      </Show>
    </box>
  )
}

export function Process(props: RenderProps<typeof ExecCommandTool>) {
  const cmd = createMemo(() => inlineSafe(props.input.cmd ?? "", HEADER_CMD_MAX))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const state = createMemo(() => verdict(props.theme, props.metadata as Record<string, unknown>))
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
        <text fg={props.theme.textMuted}>preparing a command...</text>
      </Match>
      <Match when={true}>
        <box marginTop={1} gap={1} flexShrink={0}>
          <box flexDirection="row" justifyContent="space-between" gap={2} alignItems="flex-start" flexShrink={0}>
            <text wrapMode="none" flexShrink={1}>
              <span style={{ fg: props.theme.primary }}>run</span>
              <span style={{ fg: props.theme.text, bold: true }}> {cmd()}</span>
            </text>
            <Show when={state() || wall()}>
              <text wrapMode="none" flexShrink={0}>
                <Show when={state()}>
                  {(v) => <span style={{ fg: v().fg, bold: v().bold }}>{v().word}</span>}
                </Show>
                <Show when={wall()}>
                  <span style={{ fg: props.theme.textMuted }}>{state() ? " · " : ""}{wall()}</span>
                </Show>
              </text>
            </Show>
          </box>
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

export function ProcessWriteStdin(props: RenderProps<typeof WriteStdinTool>) {
  const sid = createMemo(() => props.input.session_id)
  // Empty / omitted chars is the canonical "pure poll" pattern (codex
  // process_manager.rs:619-621): the model is just draining recent output
  // without sending input. The "poll" word makes that shape obvious in
  // the transcript so the reader can tell which calls were input vs drains.
  const chars = createMemo(() => {
    const c = props.input.chars ?? ""
    if (c.length === 0) return "poll"
    return inlineSafe(c, HEADER_CHARS_MAX)
  })
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const state = createMemo(() => verdict(props.theme, props.metadata as Record<string, unknown>))
  const wall = createMemo(() => wallTimeLabel(props.metadata as Record<string, unknown>))
  const error = createMemo(() => statusError(props.part))
  const [localExpanded, setLocalExpanded] = createSignal(false)
  const expanded = createMemo(() => props.expanded ?? localExpanded())
  const toggle = () => (props.onToggleExpand ? props.onToggleExpand() : setLocalExpanded((v) => !v))

  return (
    <Switch>
      <Match when={isPending(props.part)}>
        <text fg={props.theme.textMuted}>watching a process...</text>
      </Match>
      <Match when={true}>
        <box flexShrink={0}>
          {/* quiet chatter: one dim line — label dim, payload in text tone */}
          <text wrapMode="none" fg={props.theme.textMuted}>
            <span style={{ fg: props.theme.textMuted }}>stdin </span>
            <span style={{ fg: props.theme.text }}>
              #{sid()} {chars()}
            </span>
            <Show when={state()}>
              {(v) => <span style={{ fg: props.theme.textMuted }}> · {v().word}</span>}
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
