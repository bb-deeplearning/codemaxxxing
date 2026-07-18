import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRoute, useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { Session } from "@/session/session"
import { useTerminalDimensions } from "@opentui/solid"
import { clampRule, fadeRule, grad, idColor, mix, modelWord, Spans } from "@tui/ui/glow"
import { inlineSafe } from "@tui/util/inline-safe"

let once = false
const placeholder = {
  normal: [
    "what's the move",
    "fire away",
    "go on, i'm listening",
    "the cursor blinks. the model waits.",
    "what should we cook today",
    "type something interesting (no pressure)",
    "make me work for it",
    "fix broken tests, maybe?",
    "explain this codebase to a 5 year old",
    "spit it out",
  ],
  shell: ["ls -la", "git status", "bun test", "pwd", "echo hi"],
}

// afterglow wordmark (design/deck/frames/glow.ts:101-102): letter-spaced
// gradient text over a dissolving rule. static paint only — this replaces
// the 16fps figlet ignition on purpose (mosh budget). Logo/GoLogo stay in
// component/logo.tsx for dialog-go-upsell.
function Wordmark() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const available = createMemo(() => Math.max(0, dimensions().width - 4))
  const mark = createMemo(() => grad("c o d e m a x x x i n g", theme.primary, mix(theme.primary, theme.accent, 0.85), true))
  const rule = createMemo(() => fadeRule(theme, theme.primary, clampRule(32, available())))
  return (
    <box flexShrink={0}>
      <text selectable={false}>
        <Spans spans={mark()} />
      </text>
      <text selectable={false}>
        <Spans spans={rule()} />
      </text>
    </box>
  )
}

// relative age whisper: "now", "2m", "1h", "3d". Locale has duration()
// ("3m 20s" style) but nothing this compact.
function age(updated: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - updated) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

type SessionInfo = ReturnType<typeof useSync>["data"]["session"][number]

// one recent session per row: warmed identity title on the left, dim age
// whisper on the right. right-alignment inside one <text> is not a thing,
// so this is the sanctioned two-single-line-texts flex-row (both wrapMode
// "none", left side shrinks) — safe per specs/tui-render-freeze.md.
function SessionRow(props: { session: SessionInfo }) {
  const { theme } = useTheme()
  const route = useRoute()
  // untitled sessions carry an ISO-stamped default title — render those as
  // a plain "new session" whisper instead of the raw timestamp string.
  const title = createMemo(() =>
    Session.isDefaultTitle(props.session.title) ? "new session" : inlineSafe(props.session.title, 48).toLowerCase(),
  )
  const fg = createMemo(() => mix(idColor(theme, props.session.id), theme.text, 0.15))
  return (
    <box
      flexDirection="row"
      width="100%"
      justifyContent="space-between"
      gap={2}
      onMouseUp={() => route.navigate({ type: "session", sessionID: props.session.id })}
    >
      <text fg={fg()} wrapMode="none" flexShrink={1}>
        <span style={{ fg: fg(), bold: true }}>{title()}</span>
      </text>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {age(props.session.time.updated)}
      </text>
    </box>
  )
}

export function Home() {
  const sync = useSync()
  const project = useProject()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const { theme } = useTheme()
  const local = useLocal()
  const dimensions = useTerminalDimensions()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  let sent = false

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  const status = createMemo(() => {
    const weekday = new Date().toLocaleDateString(undefined, { weekday: "long" }).toLowerCase()
    const model = modelWord(inlineSafe(local.model.parsed().modelID, 40).toLowerCase())
    if (!model) return `${weekday}.`
    return `${weekday}. ${model} is up.`
  })

  // up to 3 most recent root sessions; untitled ("new session …") ones all
  // read identically, so only the freshest untitled row earns a slot.
  const recent = createMemo(() => {
    const sorted = sync.data.session
      .filter((s) => s.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
    const out: typeof sorted = []
    let untitled = false
    for (const s of sorted) {
      if (Session.isDefaultTitle(s.title)) {
        if (untitled) continue
        untitled = true
      }
      out.push(s)
      if (out.length === 3) break
    }
    return out
  })

  return (
    <>
      <box flexGrow={1} paddingLeft={2} paddingRight={2} alignItems="center">
        <box flexGrow={2} minHeight={0} />
        {/* one composition: every home element lives in the same centered
            max-75 column, left-aligned within it — reads as an app's empty
            state on wide, vertical, and phone-width terminals alike.
            homeD rhythm (glow.ts:99-113): wordmark + rule → air → sentence
            → air ×2 → rows → air ×2 → the prompt's own bottom edge. */}
        <box width="100%" maxWidth={75} flexShrink={0}>
          <box flexShrink={0}>
            <TuiPluginRuntime.Slot name="home_logo" mode="replace">
              <Wordmark />
            </TuiPluginRuntime.Slot>
          </box>
          <box height={1} minHeight={0} flexShrink={1} />
          <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
            {status()}
          </text>
          <Show when={recent().length > 0}>
            <box width="100%" paddingTop={2} flexShrink={0}>
              <For each={recent()}>{(session) => <SessionRow session={session} />}</For>
            </box>
          </Show>
          <box width="100%" zIndex={1000} paddingTop={2} flexShrink={0}>
            <TuiPluginRuntime.Slot
              name="home_prompt"
              mode="replace"
              workspace_id={project.workspace.current()}
              ref={bind}
            >
              <Prompt
                ref={bind}
                workspaceID={project.workspace.current()}
                width={Math.min(75, dimensions().width - 4)}
                right={<TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />}
                placeholders={placeholder}
              />
            </TuiPluginRuntime.Slot>
          </box>
          <TuiPluginRuntime.Slot name="home_bottom" />
        </box>
        <box flexGrow={3} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
