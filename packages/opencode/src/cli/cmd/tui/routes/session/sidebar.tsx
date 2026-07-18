import { useProject } from "@tui/context/project"
import { Session } from "@/session/session"
import { useSync } from "@tui/context/sync"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { inlineSafe } from "../../util/inline-safe"
import { clampRule, fadeRule, fadeTarget, mix, RULE, Spans } from "@tui/ui/glow"
import { SidebarSection, SIDEBAR_INNER } from "@tui/component/sidebar-section"

import { getScrollAcceleration } from "../../util/scroll"

// Module-scope frozen empty sentinel — `?? EMPTY_MESSAGES` keeps reference
// identity stable when no messages exist yet, so the messages() memo
// downstream doesn't invalidate consumers with a fresh `[]` per call.
const EMPTY_MESSAGES: readonly Message[] = Object.freeze([]) as readonly Message[]

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// afterglow sidebar: no left border, no rules-as-boxes. the panel separates
// from the main column with air plus a backgroundPanel fill when the theme
// has one (token .a > 0); transparent themes degrade to air + the sections'
// own dissolving rules (specs/tui-redesign.md, transparent degradation).
export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? (EMPTY_MESSAGES as Message[]))

  const workspaceConnected = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return false
    return project.workspace.status(workspaceID) === "connected"
  }
  const workspaceLabel = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "unknown"
    const info = project.workspace.get(workspaceID)
    if (!info) return "unknown"
    return `${info.type}: ${info.name}`
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  // Session stats — split into two memos and gated against streaming so the
  // sidebar doesn't pay per-delta cost.
  //
  // The previous shape (single memo returning a fresh 7-field object) had
  // two problems vs upstream (which renders no stats at all):
  //   1. Walked the full message list per streaming delta even when nothing
  //      visible changed (duration only ticks when complete; pct only moves
  //      when the message ends).
  //   2. Object identity changed every recomputation, so all 5 downstream
  //      <Show when={s().X}> reads invalidated together even when only one
  //      field's value actually changed.
  //
  // Fix:
  //   - `streaming` short-circuits — if there's a pending assistant the live
  //     stats panel only updates `messages` count (cheap O(1)) and freezes
  //     the rest until the turn lands. The values were stale-anyway during
  //     streaming because token totals only commit on completion.
  //   - Each derived field is its own `createMemo` returning a primitive,
  //     so Solid's value-equality short-circuits unchanged fields and only
  //     the field that actually moved invalidates downstream.

  // ── streaming detection ────────────────────────────────────────────
  // True while the latest message is an assistant in flight. Single tail
  // read; this is the ONLY message-list memo allowed to fire per delta.
  // Every other derived stat short-circuits below when streaming() is
  // true so the sidebar pays zero work per chunk.
  const streaming = createMemo(() => {
    const list = messages()
    const last = list[list.length - 1]
    return last?.role === "assistant" && !last.time?.completed
  })

  // Cheap O(1) per turn — message count freezes during streaming so the
  // displayed value bumps once per turn (when the assistant message lands)
  // instead of staying at "current count" mid-stream. Visually identical
  // for the user but eliminates the per-delta invalidation.
  const messageCount = createMemo<number>((prev) => {
    if (streaming()) return prev
    return messages().length
  }, 0)

  // Last assistant message that has actually committed token output. Memoized
  // by id so downstream consumers compare against the same object identity
  // until the next turn finishes. Returns undefined while only streaming
  // assistants exist. Walks backward + breaks on first match (O(1) common
  // case) — upstream's findLast was O(1); a forward loop without break was
  // O(N) per recompute.
  const settledTokenAssistant = createMemo<AssistantMessage | undefined>((prev) => {
    if (streaming()) return prev
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (item.role === "assistant" && item.tokens.output > 0 && item.time?.completed) {
        return item as AssistantMessage
      }
    }
    return undefined
  })

  // First user message creation time. Walks forward + breaks on first.
  // Frozen during streaming — the answer never changes mid-turn (a user
  // message can't appear during an in-flight assistant), so freezing
  // eliminates per-delta invalidation cost.
  const firstUserCreated = createMemo<number | undefined>((prev) => {
    if (streaming()) return prev
    const list = messages()
    for (let i = 0; i < list.length; i++) {
      if (list[i].role === "user") return list[i].time?.created
    }
    return prev
  })

  // Last assistant completion time. Walks backward + breaks on first
  // completed assistant. Only updates between turns.
  const lastAssistantCompleted = createMemo<number | undefined>((prev) => {
    if (streaming()) return prev
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (item.role === "assistant" && item.time?.completed) return item.time.completed
    }
    return prev
  })

  // Total session cost. Updates only when a turn lands. Re-walks the list
  // because cost is summed across all assistants (no incremental signal
  // from the store), but we gate on streaming so the walk fires once per
  // turn-completion, not per delta.
  const cost = createMemo<number>((prev) => {
    if (streaming()) return prev
    let total = 0
    for (const item of messages()) {
      if (item.role === "assistant") total += item.cost
    }
    return total
  }, 0)

  // Token count from the last settled assistant — primitive number, equality
  // short-circuits when unchanged.
  const tokenCount = createMemo<number>(() => {
    const a = settledTokenAssistant()
    if (!a) return 0
    return a.tokens.input + a.tokens.output + a.tokens.reasoning + a.tokens.cache.read + a.tokens.cache.write
  })

  // Provider id → provider Map. Built once per provider-list change
  // (effectively never during streaming) so per-token-update consumers
  // can do an O(1) lookup instead of `sync.data.provider.find(...)` per
  // call.
  const providerByID = createMemo(() => {
    const out = new Map<string, (typeof sync.data.provider)[number]>()
    for (const p of sync.data.provider) out.set(p.id, p)
    return out
  })

  // Percentage of context used. Number | undefined; only invalidates when
  // tokens or model change.
  const tokenPct = createMemo<number | undefined>(() => {
    const a = settledTokenAssistant()
    if (!a) return undefined
    const t = tokenCount()
    if (t === 0) return undefined
    // Provider Map lookup. Walking sync.data.provider linearly per token
    // update was N×P per turn; this is N + per-token O(1) Map lookups.
    // The Map itself is rebuilt only when the provider list changes
    // (effectively never during streaming).
    const providers = providerByID()
    const model = providers.get(a.providerID)?.models[a.modelID]
    if (!model?.limit.context) return undefined
    return Math.round((t / model.limit.context) * 100)
  })

  // Pre-formatted display strings — Intl format calls fire only when the
  // underlying primitive changes, not per delta.
  const tokenDisplay = createMemo<string | undefined>(() => {
    const t = tokenCount()
    return t > 0 ? Locale.number(t) : undefined
  })
  const costDisplay = createMemo<string | undefined>(() => {
    const c = cost()
    return c > 0 ? money.format(c) : undefined
  })
  const durationDisplay = createMemo<string | undefined>(() => {
    const a = lastAssistantCompleted()
    const u = firstUserCreated()
    if (!a || !u) return undefined
    const d = a - u
    return d > 0 ? Locale.duration(d) : undefined
  })

  // Sidebar visibility gate — when there are no messages we render nothing.
  // Cheap primitive check; doesn't allocate.
  const hasStats = createMemo(() => messageCount() > 0)

  // the title's dissolving rule — primary heat, the head of the panel.
  // memoized span array; rebuilt only when the theme moves (width is fixed
  // by the 42-col contract).
  const titleRule = createMemo(() => fadeRule(theme, theme.primary, clampRule(RULE.human, SIDEBAR_INNER)))

  // the footer's rule cools to the section tone — same recipe as
  // SidebarSection so the pinned edge reads as one more quiet section.
  const footerRule = createMemo(() =>
    fadeRule(theme, mix(theme.primary, fadeTarget(theme), 0.5), clampRule(20, SIDEBAR_INNER)),
  )

  // surfaces yes, borders no: the panel fill is allowed chrome, but a
  // transparent theme (panel token a === 0) degrades to air + rules.
  const panelFill = () => (theme.backgroundPanel.a > 0 ? theme.backgroundPanel : undefined)

  return (
    <Show when={session()}>
      <box
        width={42}
        height="100%"
        position={props.overlay ? "absolute" : "relative"}
        flexShrink={0}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={panelFill()}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: panelFill() ?? theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} paddingRight={1} gap={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box flexShrink={0}>
                <text fg={theme.text} wrapMode="none" flexShrink={0}>
                  <b>
                    {Session.isDefaultTitle(session()!.title)
                      ? "new session"
                      : inlineSafe(session()!.title, 40).toLowerCase()}
                  </b>
                </text>
                <text wrapMode="none" flexShrink={0} selectable={false}>
                  <Spans spans={titleRule()} />
                </text>
                {/* dim facts whisper under the title — indent rhythm puts
                    section content at +2. */}
                <box paddingLeft={2}>
                  <Show when={InstallationChannel !== "latest"}>
                    <box flexDirection="row" justifyContent="space-between" gap={1}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                        id
                      </text>
                      <text fg={theme.text} wrapMode="none" flexShrink={1}>
                        {props.sessionID}
                      </text>
                    </box>
                  </Show>
                  <Show when={session()!.workspaceID}>
                    <box flexDirection="row" justifyContent="space-between" gap={1}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                        workspace
                      </text>
                      {/* status is the word's temperature, not a glyph: a
                          connected workspace sits in plain text, a broken
                          one burns (failed state = the name in error). */}
                      <text fg={workspaceConnected() ? theme.text : theme.error} wrapMode="none" flexShrink={1}>
                        {inlineSafe(workspaceLabel())}
                      </text>
                    </box>
                  </Show>
                  <Show when={session()!.share?.url}>
                    <box flexDirection="row" justifyContent="space-between" gap={1}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                        shared
                      </text>
                      <text fg={theme.text} wrapMode="none" flexShrink={1}>
                        {session()!.share!.url}
                      </text>
                    </box>
                  </Show>
                </box>
              </box>
            </TuiPluginRuntime.Slot>

            {/* Session stats — only shown when there are messages. Each
                field is its own primitive memo so a streaming delta only
                invalidates the field that actually moved (typically just
                messageCount; tokens/cost/duration freeze during streaming
                and unfreeze on completion). */}
            <Show when={hasStats()}>
              <box flexShrink={0}>
                <SidebarSection t={theme} label="session" />
                <box paddingLeft={2}>
                  <box flexDirection="row" justifyContent="space-between" gap={1}>
                    <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                      messages
                    </text>
                    <text fg={theme.text} wrapMode="none" flexShrink={1}>
                      {messageCount()}
                    </text>
                  </box>
                  <Show when={tokenDisplay()}>
                    <box flexDirection="row" justifyContent="space-between" gap={1}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                        tokens
                      </text>
                      <text wrapMode="none" flexShrink={1}>
                        <span style={{ fg: theme.text }}>{tokenDisplay()}</span>
                        <Show when={tokenPct() !== undefined}>
                          <span style={{ fg: theme.textMuted }}> {tokenPct()}%</span>
                        </Show>
                      </text>
                    </box>
                  </Show>
                  <Show when={costDisplay()}>
                    <box flexDirection="row" justifyContent="space-between" gap={1}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                        cost
                      </text>
                      <text fg={theme.text} wrapMode="none" flexShrink={1}>
                        {costDisplay()}
                      </text>
                    </box>
                  </Show>
                  <Show when={durationDisplay()}>
                    <box flexDirection="row" justifyContent="space-between" gap={1}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                        duration
                      </text>
                      <text fg={theme.text} wrapMode="none" flexShrink={1}>
                        {durationDisplay()}
                      </text>
                    </box>
                  </Show>
                </box>
              </box>
            </Show>

            {/* plugin sections stack as siblings inside this box — gap={1}
                is the "one blank row between sections" rule, applied here
                once instead of per-plugin padding. */}
            <box flexShrink={0} gap={1}>
              <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
            </box>
          </box>
        </scrollbox>

        <box flexShrink={0} paddingTop={1}>
          <text wrapMode="none" flexShrink={0} selectable={false}>
            <Spans spans={footerRule()} />
          </text>
          <box paddingTop={1}>
            <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
              <text fg={theme.textMuted} wrapMode="none">
                <b>codema</b>
                <span style={{ fg: theme.text }}>
                  <b>xxx</b>
                </span>
                <b>ing</b> <span style={{ fg: theme.textMuted }}>· clauseo</span>
              </text>
            </TuiPluginRuntime.Slot>
          </box>
        </box>
      </box>
    </Show>
  )
}
