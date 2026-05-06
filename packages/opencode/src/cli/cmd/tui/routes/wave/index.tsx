import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useWave } from "@tui/context/wave"
import type { State, WaveRow, RowStatus, FailureKind, SessionKind } from "@/wave/state"
import { useToast } from "@tui/ui/toast"

// Wave campaign dashboard.
//
// Layout:
//   header            campaign id + plan source + executor agent/model + counts
//   loop strip        loop_state + wave_status + failure_kind + retry/verify counts
//                     + active session kind (executor vs verifier) + elapsed
//   awaiting banner   prominent USER ATTENTION block when wave_status=awaiting_user
//   table             one row per wave: # / status / session / commit / notes
//   footer            keybind hints (state-contextual)
//   notes overlay     full-screen NOTES.md viewer when `v` pressed on a row
//
// All OpenTUI primitives — box, text, position="absolute" for overlay. No CSS.

const TABLE_HEADER = "  #   status      session              commit    notes" as const

const STATUS_COLORS = (theme: ReturnType<typeof useTheme>["theme"]) =>
  ({
    pending: theme.textMuted,
    running: theme.primary,
    complete: theme.success,
    failed: theme.error,
    undoable: theme.error,
    paused: theme.warning,
    cancelled: theme.warning,
  }) as Record<RowStatus, ReturnType<typeof useTheme>["theme"]["text"]>

const FAILURE_LABEL: Record<Exclude<FailureKind, "">, string> = {
  transient: "transient",
  undoable: "spec broken",
  crash: "crashed",
  cancelled: "cancelled by user",
}

const SESSION_LABEL: Record<Exclude<SessionKind, "">, string> = {
  executor: "executor running",
  verifier: "verifier running",
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const padRight = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))

const formatElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function Wave() {
  const route = useRoute()
  const wave = useWave()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const toast = useToast()
  const [cursor, setCursor] = createSignal(0)

  // Notes overlay state. notesContent !== null implies overlay is open.
  const [notesContent, setNotesContent] = createSignal<string | null>(null)
  const [notesWaveN, setNotesWaveN] = createSignal<number | null>(null)
  const [notesScroll, setNotesScroll] = createSignal(0)

  // Elapsed-time tracking for the active session. We can't read session
  // start time over HTTP cheaply, so we record client-side when we observe
  // active_session_id change. nowTick re-renders the elapsed display.
  const [sessionStartedAt, setSessionStartedAt] = createSignal<number | null>(null)
  const [trackedSessionId, setTrackedSessionId] = createSignal<string | null>(null)
  const [nowTick, setNowTick] = createSignal(Date.now())

  onMount(() => {
    void wave.refresh()
  })
  onCleanup(() => {
    wave.release()
  })

  const rows = createMemo<ReadonlyArray<WaveRow>>(() => wave.data.state?.waves ?? [])
  const state = createMemo<State | null>(() => wave.data.state)
  const colors = createMemo(() => STATUS_COLORS(theme))

  // When active_session_id changes, reset start time. When it's cleared,
  // forget the tracked id.
  createEffect(() => {
    const sid = state()?.active_session_id ?? null
    if (sid !== trackedSessionId()) {
      batch(() => {
        setTrackedSessionId(sid)
        setSessionStartedAt(sid ? Date.now() : null)
      })
    }
  })

  // Tick every second while a session is running so the elapsed display
  // refreshes without waiting on the 2s polling cycle.
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const running = !!state()?.active_session_id
    if (running && !elapsedTimer) {
      elapsedTimer = setInterval(() => setNowTick(Date.now()), 1000)
    } else if (!running && elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = undefined
    }
  })
  onCleanup(() => {
    if (elapsedTimer) clearInterval(elapsedTimer)
  })

  const move = (delta: number) => {
    const total = rows().length
    if (total === 0) return
    setCursor((c) => Math.max(0, Math.min(total - 1, c + delta)))
  }

  const openSelected = () => {
    const row = rows()[cursor()]
    if (!row?.session_id) {
      toast.show({ variant: "info", title: "no session", message: "this wave has not been spawned" })
      return
    }
    route.navigate({ type: "session", sessionID: row.session_id })
  }

  const openNotes = async () => {
    const s = state()
    if (!s) return
    const row = rows()[cursor()]
    if (!row) return
    const text = await wave.readNotes(s.campaign_id, row.n)
    if (text === null) {
      toast.show({
        variant: "info",
        title: "no notes",
        message: `wave ${row.n} has no NOTES.md (only failed/undoable/paused waves write notes)`,
      })
      return
    }
    batch(() => {
      setNotesContent(text)
      setNotesWaveN(row.n)
      setNotesScroll(0)
    })
  }

  const closeNotes = () =>
    batch(() => {
      setNotesContent(null)
      setNotesWaveN(null)
      setNotesScroll(0)
    })

  useKeyboard((evt) => {
    // When the notes overlay is open, route keys to it instead of the dashboard.
    if (notesContent() !== null) {
      switch (evt.name) {
        case "escape":
        case "q":
          closeNotes()
          return
        case "up":
        case "k":
          setNotesScroll((s) => Math.max(0, s - 1))
          return
        case "down":
        case "j":
          setNotesScroll((s) => s + 1)
          return
        case "pageup":
          setNotesScroll((s) => Math.max(0, s - 10))
          return
        case "pagedown":
          setNotesScroll((s) => s + 10)
          return
      }
      return
    }
    switch (evt.name) {
      case "up":
      case "k":
        move(-1)
        return
      case "down":
      case "j":
        move(1)
        return
      case "return":
        openSelected()
        return
      case "n":
        void wave.next()
        return
      case "r":
        if (state()?.loop_state === "paused") void wave.resume()
        else void wave.arm()
        return
      case "space":
        void wave.pause()
        return
      case "i":
        void wave.interrupt()
        return
      case "s":
        void wave.stop()
        return
      case "c":
        if (state()?.failure_kind === "cancelled") void wave.clearCancelled()
        return
      case "q":
        if (state()?.wave_status === "awaiting_user") void wave.clearQuestion()
        return
      case "v":
        void openNotes()
        return
      case "escape":
        route.navigate({ type: "home" })
        return
      case "f5":
        void wave.refresh()
        return
    }
  })

  const noteWidth = createMemo(() => Math.max(20, dims().width - 50))

  const elapsedDisplay = createMemo(() => {
    const startedAt = sessionStartedAt()
    if (!startedAt) return null
    return formatElapsed(nowTick() - startedAt)
  })

  // Contextual keybind hint string built from current state.
  const hints = createMemo(() => {
    const s = state()
    const parts: string[] = ["↑↓ nav", "↵ open", "esc back", "f5 refresh"]
    if (s) {
      if (s.wave_status === "awaiting_user") parts.push("q dismiss question")
      if (s.failure_kind === "cancelled") parts.push("c clear cancelled")
      if (s.loop_state === "paused") parts.push("r resume")
      else if (s.wave_status !== "awaiting_user" && s.wave_status !== "all_complete") parts.push("r arm/run")
      if (s.active_session_id) parts.push("␣ pause", "i interrupt", "s stop")
      else parts.push("n next")
      parts.push("v notes")
    }
    return parts.join(" · ")
  })

  const renderRow = (row: WaveRow, idx: number) => {
    const c = colors()
    const isCursor = () => idx === cursor()
    const sessionDisplay = row.session_id ? row.session_id.slice(0, 16) + "…" : "—"
    const commitDisplay = row.commit_sha ?? "—"
    return (
      <box
        flexDirection="row"
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={isCursor() ? theme.backgroundElement : undefined}
      >
        <text fg={theme.textMuted}>{isCursor() ? "▸ " : "  "}</text>
        <text fg={isCursor() ? theme.text : theme.textMuted}>{padRight(String(row.n), 4)}</text>
        <text fg={c[row.status]}>{padRight(row.status, 11)}</text>
        <text fg={theme.textMuted}>{padRight(sessionDisplay, 20)}</text>
        <text fg={theme.textMuted}>{padRight(commitDisplay, 9)}</text>
        <text fg={isCursor() ? theme.text : theme.textMuted}>{truncate(row.notes, noteWidth())}</text>
      </box>
    )
  }

  return (
    <box flexGrow={1} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Wave Dashboard
        </text>
      </box>

      <Show when={!wave.available()}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.error}>wave service unavailable in this TUI mode</text>
        </box>
      </Show>

      <Show
        when={state()}
        fallback={
          <Show when={wave.available()}>
            <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
              <text fg={theme.textMuted}>no active campaign.</text>
              <text fg={theme.textMuted}>start one with /wave plan</text>
              <text fg={theme.textMuted}>or run wave_plan agent on a plan file.</text>
              <Show when={wave.data.campaigns.length > 0}>
                <box paddingTop={1} gap={1}>
                  <text fg={theme.text}>archived campaigns:</text>
                  <For each={wave.data.campaigns}>{(id) => <text fg={theme.textMuted}> • {id}</text>}</For>
                </box>
              </Show>
            </box>
          </Show>
        }
      >
        {(s) => (
          <>
            <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
              <box flexDirection="row" gap={2}>
                <text fg={theme.textMuted}>campaign</text>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {s().campaign_id}
                </text>
                <text fg={theme.textMuted}>
                  {s().session_count}/{s().total_waves} done
                </text>
              </box>
              <box flexDirection="row" gap={2}>
                <text fg={theme.textMuted}>plan</text>
                <text fg={theme.textMuted}>{s().plan_source}</text>
              </box>
              <box flexDirection="row" gap={2}>
                <text fg={theme.textMuted}>executor</text>
                <text fg={theme.text}>{s().executor_agent}</text>
                <text fg={theme.textMuted}>·</text>
                <text fg={theme.textMuted}>{s().executor_model}</text>
                <Show when={s().executor_variant}>
                  <text fg={theme.textMuted}>· {s().executor_variant}</text>
                </Show>
              </box>
              <box flexDirection="row" gap={2}>
                <text fg={theme.textMuted}>loop</text>
                <text
                  fg={
                    s().loop_state === "armed"
                      ? theme.success
                      : s().loop_state === "paused"
                        ? theme.warning
                        : theme.textMuted
                  }
                >
                  {s().loop_state}
                </text>
                <text fg={theme.textMuted}>·</text>
                <text fg={theme.textMuted}>wave</text>
                <text fg={colors()[normalizeStatus(s().wave_status)]}>{s().wave_status}</text>
                <Show when={s().failure_kind !== ""}>
                  <text fg={theme.textMuted}>·</text>
                  <text
                    fg={s().failure_kind === "cancelled" ? theme.warning : theme.error}
                    attributes={TextAttributes.BOLD}
                  >
                    {FAILURE_LABEL[s().failure_kind as Exclude<FailureKind, "">]}
                  </text>
                </Show>
                <Show when={s().retry_count > 0}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.warning}>retry {s().retry_count}/3</text>
                </Show>
                <Show when={s().verify_count > 0}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={s().verify_count >= 2 ? theme.warning : theme.textMuted}>
                    verify {s().verify_count}/3
                  </text>
                </Show>
              </box>
              <Show when={s().active_session_id && s().active_session_kind !== ""}>
                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted}>session</text>
                  <text
                    fg={s().active_session_kind === "verifier" ? theme.warning : theme.primary}
                    attributes={TextAttributes.BOLD}
                  >
                    {SESSION_LABEL[s().active_session_kind as Exclude<SessionKind, "">]}
                  </text>
                  <Show when={elapsedDisplay()}>
                    <text fg={theme.textMuted}>· {elapsedDisplay()}</text>
                  </Show>
                  <text fg={theme.textMuted}>· {s().active_session_id?.slice(0, 16)}…</text>
                </box>
              </Show>
            </box>

            <Show when={s().wave_status === "awaiting_user" && s().user_question}>
              <box
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                marginTop={1}
                marginLeft={2}
                marginRight={2}
                backgroundColor={theme.backgroundElement}
                flexDirection="column"
                gap={1}
              >
                <text fg={theme.warning} attributes={TextAttributes.BOLD}>
                  USER ATTENTION NEEDED
                </text>
                <text fg={theme.text}>{s().user_question}</text>
                <text fg={theme.textMuted}>
                  Open the most recent wave session (↵ on the row below) to read full context and respond. Or press q to
                  dismiss the question and mark cancelled.
                </text>
              </box>
            </Show>

            <box paddingTop={1} paddingLeft={2} paddingRight={2}>
              <text fg={theme.textMuted}>{TABLE_HEADER}</text>
            </box>

            <box flexGrow={1} minHeight={0} paddingTop={1}>
              <For each={rows()}>{(row, idx) => renderRow(row, idx())}</For>
            </box>
          </>
        )}
      </Show>

      <box width="100%" flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>{hints()}</text>
      </box>

      <Show when={notesContent() !== null}>
        <NotesOverlay
          content={notesContent() ?? ""}
          waveN={notesWaveN() ?? 0}
          scroll={notesScroll()}
          dims={dims()}
        />
      </Show>
    </box>
  )
}

function NotesOverlay(props: {
  content: string
  waveN: number
  scroll: number
  dims: { width: number; height: number }
}) {
  const { theme } = useTheme()
  // Naive paged display: split lines, slice from scroll. Bounds aren't
  // tightly clamped — out-of-bounds just renders an empty area.
  const lines = createMemo(() => props.content.split("\n"))
  const visibleHeight = createMemo(() => Math.max(5, props.dims.height - 6))
  const window = createMemo(() => lines().slice(props.scroll, props.scroll + visibleHeight()))
  const total = createMemo(() => lines().length)
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      backgroundColor={theme.background}
      flexDirection="column"
    >
      <box
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="row"
        gap={2}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          NOTES — wave {props.waveN}
        </text>
        <text fg={theme.textMuted}>
          line {props.scroll + 1}–{Math.min(props.scroll + visibleHeight(), total())} of {total()}
        </text>
        <text fg={theme.textMuted}>· ↑↓ scroll · pgup/pgdn jump · esc close</text>
      </box>
      <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="column">
        <For each={window()}>{(line) => <text fg={theme.text}>{line || " "}</text>}</For>
      </box>
    </box>
  )
}

const normalizeStatus = (s: State["wave_status"]): RowStatus => {
  if (s === "all_complete") return "complete"
  if (s === "plan_undoable") return "undoable"
  if (s === "awaiting_user") return "paused"
  return s
}
