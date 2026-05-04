import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useWave } from "@tui/context/wave"
import type { State, WaveRow, RowStatus } from "@/wave/state"
import { useToast } from "@tui/ui/toast"

// Wave campaign dashboard.
//
// Layout:
//   header            campaign id + plan source + executor agent/model + counts
//   loop strip        loop_state + wave_status compact summary
//   table             one row per wave: # / status / session / commit / notes
//   footer            keybind hints (compact, single line)
//
// Empty state (no active campaign) prompts the user to start one via /wave plan.
// Loose attach mode: if AppRuntime is unavailable (TUI is attached to a remote
// server without the wave service), the wave context's `available` is false
// and we render a stub.

const TABLE_HEADER = "  #   status      session              commit    notes" as const

const STATUS_COLORS = (theme: ReturnType<typeof useTheme>["theme"]) =>
  ({
    pending: theme.textMuted,
    running: theme.primary,
    complete: theme.success,
    failed: theme.error,
    cancelled: theme.warning,
  }) as Record<RowStatus, ReturnType<typeof useTheme>["theme"]["text"]>

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const padRight = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))

export function Wave() {
  const route = useRoute()
  const wave = useWave()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const toast = useToast()
  const [cursor, setCursor] = createSignal(0)

  const rows = createMemo<ReadonlyArray<WaveRow>>(() => wave.data.state?.waves ?? [])
  const state = createMemo<State | null>(() => wave.data.state)
  const colors = createMemo(() => STATUS_COLORS(theme))

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

  useKeyboard((evt) => {
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
      case "escape":
        route.navigate({ type: "home" })
        return
      case "f5":
        void wave.refresh()
        return
    }
  })

  const noteWidth = createMemo(() => Math.max(20, dims().width - 50))

  const renderRow = (row: WaveRow, idx: number) => {
    const c = colors()
    const isCursor = idx === cursor()
    const sessionDisplay = row.session_id ? row.session_id.slice(0, 16) + "…" : "—"
    const commitDisplay = row.commit_sha ?? "—"
    const noteDisplay = truncate(row.notes, noteWidth())
    return (
      <box flexDirection="row" paddingLeft={2} paddingRight={2} backgroundColor={isCursor ? theme.backgroundElement : undefined}>
        <text fg={theme.textMuted}>{isCursor ? "▸ " : "  "}</text>
        <text fg={isCursor ? theme.text : theme.textMuted}>{padRight(String(row.n), 4)}</text>
        <text fg={c[row.status]}>{padRight(row.status, 11)}</text>
        <text fg={theme.textMuted}>{padRight(sessionDisplay, 20)}</text>
        <text fg={theme.textMuted}>{padRight(commitDisplay, 9)}</text>
        <text fg={isCursor ? theme.text : theme.textMuted}>{noteDisplay}</text>
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
                  <For each={wave.data.campaigns}>{(id) => <text fg={theme.textMuted}>  • {id}</text>}</For>
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
                <Show when={s().active_session_id}>
                  <text fg={theme.textMuted}>·</text>
                  <text fg={theme.textMuted}>session</text>
                  <text fg={theme.textMuted}>{s().active_session_id?.slice(0, 16)}…</text>
                </Show>
              </box>
            </box>

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
        <text fg={theme.textMuted}>
          ↑↓ nav · ↵ open · n next · r run · ␣ pause · i interrupt · s stop · esc back · f5 refresh
        </text>
      </box>
    </box>
  )
}

const normalizeStatus = (s: State["wave_status"]): RowStatus => {
  if (s === "all_complete") return "complete"
  return s
}
