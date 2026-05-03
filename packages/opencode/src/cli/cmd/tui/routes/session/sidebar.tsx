import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { Rule } from "@tui/component/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"

import { getScrollAcceleration } from "../../util/scroll"

// Tracked small caps section header. Spaces between letters convey
// hierarchy without pulling weight into the chrome.
function tracked(label: string) {
  return label.split("").join(" ")
}

const VERTICAL_FILL = "│".repeat(240)

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const workspaceStatus = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "error"
    return project.workspace.status(workspaceID) ?? "error"
  }
  const workspaceLabel = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "unknown"
    const info = project.workspace.get(workspaceID)
    if (!info) return "unknown"
    return `${info.type}: ${info.name}`
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  // Session stats — labeled value rows. Each computed from the current
  // message list so they stay live as the conversation streams.
  const stats = createMemo(() => {
    const msg = messages()
    if (msg.length === 0) return undefined

    const userCount = msg.filter((m) => m.role === "user").length
    const assistantCount = msg.filter((m) => m.role === "assistant").length

    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    const tokens = last
      ? last.tokens.input +
        last.tokens.output +
        last.tokens.reasoning +
        last.tokens.cache.read +
        last.tokens.cache.write
      : 0
    const model = last ? sync.data.provider.find((p) => p.id === last.providerID)?.models[last.modelID] : undefined
    const pct = model?.limit.context && tokens > 0 ? Math.round((tokens / model.limit.context) * 100) : undefined

    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)

    // Duration = first user message → last assistant completion (when complete)
    const firstUser = msg.find((m) => m.role === "user")?.time.created
    const lastAssistant = msg.findLast((m): m is AssistantMessage => m.role === "assistant")?.time.completed
    const duration = firstUser && lastAssistant ? lastAssistant - firstUser : 0

    return {
      messages: msg.length,
      userCount,
      assistantCount,
      tokens: tokens > 0 ? Locale.number(tokens) : undefined,
      pct,
      cost: cost > 0 ? money.format(cost) : undefined,
      duration: duration > 0 ? Locale.duration(duration) : undefined,
    }
  })

  return (
    <Show when={session()}>
      <box
        flexDirection="row"
        width={42}
        height="100%"
        position={props.overlay ? "absolute" : "relative"}
        flexShrink={0}
      >
        {/* 1-col left rule separates sidebar from content. The rule is the
            sidebar's only "edge" — there's no panel fill, so the rule is what
            says "this column belongs to the sidebar". */}
        <box
          width={1}
          height="100%"
          overflow="hidden"
          backgroundColor={props.overlay ? theme.backgroundPanel : undefined}
        >
          <text fg={theme.border} wrapMode="none">
            {VERTICAL_FILL}
          </text>
        </box>
        <box
          flexGrow={1}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={props.overlay ? theme.backgroundPanel : undefined}
        >
          <scrollbox
            flexGrow={1}
            scrollAcceleration={scrollAcceleration()}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: theme.background,
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
                  <text fg={theme.text}>
                    <b>{session()!.title}</b>
                  </text>
                  <Rule />
                  <Show when={InstallationChannel !== "latest"}>
                    <box paddingTop={1} flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>id</text>
                      <text fg={theme.text} wrapMode="none">
                        {props.sessionID}
                      </text>
                    </box>
                  </Show>
                  <Show when={session()!.workspaceID}>
                    <box paddingTop={1} flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>workspace</text>
                      <text wrapMode="none">
                        <span style={{ fg: theme.text }}>{workspaceLabel()}</span>{" "}
                        <span style={{ fg: workspaceStatus() === "connected" ? theme.success : theme.error }}>●</span>
                      </text>
                    </box>
                  </Show>
                  <Show when={session()!.share?.url}>
                    <box paddingTop={1} flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>shared</text>
                      <text fg={theme.text} wrapMode="none">
                        {session()!.share!.url}
                      </text>
                    </box>
                  </Show>
                </box>
              </TuiPluginRuntime.Slot>

              {/* Session stats — only shown when there are messages. Tracked
                  small-caps header + rule + right-pinned labeled values. */}
              <Show when={stats()}>
                {(s) => (
                  <box flexShrink={0}>
                    <text fg={theme.textMuted}>{tracked("session")}</text>
                    <Rule />
                    <box paddingTop={1} flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>messages</text>
                      <text fg={theme.text}>{s().messages}</text>
                    </box>
                    <Show when={s().tokens}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>tokens</text>
                        <text wrapMode="none">
                          <span style={{ fg: theme.text }}>{s().tokens}</span>
                          <Show when={s().pct !== undefined}>
                            <span style={{ fg: theme.textMuted }}> ({s().pct}%)</span>
                          </Show>
                        </text>
                      </box>
                    </Show>
                    <Show when={s().cost}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>cost</text>
                        <text fg={theme.text}>{s().cost}</text>
                      </box>
                    </Show>
                    <Show when={s().duration}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>duration</text>
                        <text fg={theme.text}>{s().duration}</text>
                      </box>
                    </Show>
                  </box>
                )}
              </Show>

              <box flexShrink={0}>
                <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
              </box>
            </box>
          </scrollbox>

          <box flexShrink={0} paddingTop={1}>
            <Rule />
            <box paddingTop={1}>
              <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
                <text fg={theme.textMuted}>
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
      </box>
    </Show>
  )
}
