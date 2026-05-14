/** @jsxImportSource @opentui/solid */
import { createMemo, onMount, Show, Switch, Match } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import type { Tool } from "@/tool/tool"
import type { AgentSpawnTool } from "@/tool/agent-spawn/agent-spawn"
import type { AgentWaitTool } from "@/tool/agent-wait/agent-wait"
import type { AgentSendTool } from "@/tool/agent-send/agent-send"
import type { AgentFollowupTool } from "@/tool/agent-followup/agent-followup"
import type { AgentListTool } from "@/tool/agent-list/agent-list"
import type { AgentCloseTool } from "@/tool/agent-close/agent-close"
import {
  SpawnView,
  WaitView,
  SendView,
  FollowupView,
  ListView,
  CloseView,
  type SpawnBackLink,
  type AgentToolTheme,
} from "./agent-tool"
import { pickPaletteColor } from "./agent-identity"
import { deriveSubagentStatus } from "./subagent-status"

// Production wrappers for the wave-8 multi-agent v2 tool renderers. Wires
// the heavy provider hooks (theme, sync, route) → derived signals → the
// pure-prop views in `agent-tool.tsx`. Lives in a separate file so the
// view file's helpers stay 100% line-coverable in isolation
// (per GOTCHAS L933 `tui-component-coverage-needs-mount-split`).
//
// Each mount wrapper takes the same `ToolProps` shape that
// routes/session/index.tsx hands to every tool renderer — input,
// metadata, output, part, tool, permission. Theme is read once at
// construction. Sync data is read reactively only by SpawnMount (which
// derives the back-link from the spawned child's session). The other
// mounts are pure passthroughs that exist only to read the theme.

// Module-scope frozen sentinels so reactive memos never see a fresh
// empty array per render — that would re-key downstream <For> children
// and break Solid's value-equality short-circuit. Same pattern as
// EMPTY_MESSAGES / EMPTY_PARTS in routes/session/index.tsx.
const EMPTY_MESSAGES: readonly Message[] = Object.freeze([]) as readonly Message[]
const EMPTY_PARTS: readonly Part[] = Object.freeze([]) as readonly Part[]

// Per-tool prop shape mirrors what index.tsx's ToolPart match block hands
// the existing renderers. Repeated locally rather than imported so the
// mount file isn't coupled to the index.tsx ToolProps signature (which
// is a private type there).
type AgentToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  output?: string
  permission: Record<string, unknown>
  tool: string
  part: ToolPart
}

// Build the AgentToolTheme palette the views accept. The view's theme
// surface is intentionally narrow — only the fields the views actually
// use — so an opentui-side theme refactor (e.g. renaming a color key)
// only breaks one line of the mount wrapper, not every view.
function buildAgentToolTheme(theme: ReturnType<typeof useTheme>["theme"]): AgentToolTheme {
  return {
    text: theme.text,
    textMuted: theme.textMuted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
  }
}

// Per-nickname color palette. Same color set local.agent.color() uses for
// per-agent-type coloring (theme.tsx pattern), but here we hash by
// nickname so each spawned instance gets a stable distinct color even
// when two siblings share the same agent_type.
function buildNicknamePalette(theme: ReturnType<typeof useTheme>["theme"]) {
  return [
    theme.secondary,
    theme.accent,
    theme.success,
    theme.warning,
    theme.primary,
    theme.error,
    theme.info,
  ]
}

// Pure: detect whether a permission prompt is currently open for this
// tool call. Mirrors InlineTool's permission lookup in
// routes/session/index.tsx — first item in the session's permission
// queue is the one being asked about, and we highlight when its callID
// matches ours.
function permissionPendingForCall(
  permissionQueue: ReadonlyArray<{ tool?: { callID?: string } }>,
  callID: string,
): boolean {
  const head = permissionQueue.at(0)
  return head?.tool?.callID === callID
}

// ─── spawn ─────────────────────────────────────────────────────────────

export function SpawnMount(props: AgentToolProps<typeof AgentSpawnTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const { navigate } = useRoute()

  const themeForView = createMemo(() => buildAgentToolTheme(theme))

  // Per-instance color hashed off the nickname (or path / "agent" when
  // missing). Memoized so a re-render that doesn't change identity
  // doesn't recompute the hash + palette index.
  const nicknameColor = createMemo(() => {
    const nickname = (props.metadata as { nickname?: string }).nickname
    const path = (props.metadata as { task_name?: string }).task_name ?? props.input.task_name
    const palette = buildNicknamePalette(theme)
    return pickPaletteColor(palette, { nickname, path })
  })

  // Permission highlight — peek the head of the session's permission queue.
  // Reuses the existing pattern from InlineTool (index.tsx ≈ line 2128).
  const sessionID = createMemo(() => props.part.sessionID)
  const permissionPending = createMemo(() => {
    const queue = sync.data.permission[sessionID()] ?? []
    return permissionPendingForCall(queue, props.part.callID)
  })

  // Spawn-result back-link. Reads sync.data.session_status +
  // sync.data.message for the spawned child. Same approach Task uses for
  // its inline summary (index.tsx ≈ line 2599) — gracefully degrades to
  // undefined when the child's data hasn't synced yet, so the back-link
  // line just doesn't render rather than showing stale or partial info.
  const childSessionID = createMemo<string | undefined>(() => {
    const id = (props.metadata as { child_session_id?: string }).child_session_id
    return typeof id === "string" && id.length > 0 ? id : undefined
  })

  // Trigger an opportunistic sync of the child's session messages on
  // mount. Same pattern as the Task renderer — the child may have been
  // spawned in a different process and its messages aren't preloaded.
  // The sync is one-shot per mount; if data is already present it's a
  // no-op. Mosh consideration: this is at most one fetch per spawn
  // call, not per render.
  onMount(() => {
    const cid = childSessionID()
    if (cid && !(sync.data.message[cid]?.length ?? 0)) {
      void sync.session.sync(cid)
    }
  })

  const childMessages = createMemo<readonly Message[]>(() => {
    const cid = childSessionID()
    if (!cid) return EMPTY_MESSAGES
    return sync.data.message[cid] ?? EMPTY_MESSAGES
  })

  const childStatus = createMemo(() => {
    const cid = childSessionID()
    if (!cid) return undefined
    return sync.data.session_status?.[cid]
  })

  const backlink = createMemo<SpawnBackLink | undefined>(() => {
    const cid = childSessionID()
    if (!cid) return undefined
    const msgs = childMessages()
    // Only show the back-link once the child has at least one message.
    // This avoids a flash of "waiting" the moment a spawn lands but
    // before the child's runLoop has produced its first user/assistant
    // message in the local sync cache.
    if (msgs.length === 0) return undefined

    const status = deriveSubagentStatus(childStatus(), msgs)

    // STREAMING PERF: this memo fires on every child message delta —
    // including every text token the child streams while running. The
    // O(messages × parts) walk below would compound badly across a
    // long-running child's stream (per-delta walk over a growing
    // message store, on the parent's spawn row, in the parent's
    // visible message list).
    //
    // Mitigation: only walk when the child has reached terminal
    // status. Non-terminal back-links (running/waiting) provide little
    // information the user can't see by reading the spawn row itself,
    // and the user can navigate IN to the child to see live progress
    // (ctrl+x down). The walk-cost is paid ONCE on the terminal
    // transition, not per text-delta.
    if (status !== "completed" && status !== "errored") return undefined

    // Walk the child's parts in a SINGLE pass: count tool parts +
    // capture the first user message time + the most-recently-completed
    // assistant time. O(N) per back-link recompute; the memo only fires
    // on actual sync data change AFTER the terminal-status gate.
    let toolCount = 0
    let firstUserMs: number | undefined
    let lastCompletedAssistantMs: number | undefined
    for (const m of msgs) {
      if (m.role === "user" && firstUserMs === undefined) firstUserMs = m.time?.created
      if (m.role === "assistant" && m.time?.completed) lastCompletedAssistantMs = m.time.completed
      const parts = sync.data.part[m.id] ?? (EMPTY_PARTS as Part[])
      for (const p of parts) {
        if (p.type === "tool") toolCount++
      }
    }
    const durationMs =
      firstUserMs && lastCompletedAssistantMs ? Math.max(0, lastCompletedAssistantMs - firstUserMs) : 0

    return { status, toolCount, durationMs }
  })

  const onOpenChild = createMemo(() => {
    const cid = childSessionID()
    if (!cid) return undefined
    return () => navigate({ type: "session", sessionID: cid })
  })

  return (
    <SpawnView
      theme={themeForView()}
      part={props.part}
      input={props.input}
      metadata={props.metadata}
      nicknameColor={nicknameColor()}
      backlink={backlink()}
      permissionPending={permissionPending()}
      onOpenChild={onOpenChild()}
    />
  )
}

// ─── wait ──────────────────────────────────────────────────────────────

export function WaitMount(props: AgentToolProps<typeof AgentWaitTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const themeForView = createMemo(() => buildAgentToolTheme(theme))
  const permissionPending = createMemo(() => {
    const queue = sync.data.permission[props.part.sessionID] ?? []
    return permissionPendingForCall(queue, props.part.callID)
  })
  return (
    <WaitView
      theme={themeForView()}
      part={props.part}
      input={props.input}
      metadata={props.metadata}
      permissionPending={permissionPending()}
    />
  )
}

// ─── send ──────────────────────────────────────────────────────────────

export function SendMount(props: AgentToolProps<typeof AgentSendTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const themeForView = createMemo(() => buildAgentToolTheme(theme))
  const permissionPending = createMemo(() => {
    const queue = sync.data.permission[props.part.sessionID] ?? []
    return permissionPendingForCall(queue, props.part.callID)
  })
  return (
    <SendView
      theme={themeForView()}
      part={props.part}
      input={props.input}
      metadata={props.metadata}
      permissionPending={permissionPending()}
    />
  )
}

// ─── followup ──────────────────────────────────────────────────────────

export function FollowupMount(props: AgentToolProps<typeof AgentFollowupTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const themeForView = createMemo(() => buildAgentToolTheme(theme))
  const permissionPending = createMemo(() => {
    const queue = sync.data.permission[props.part.sessionID] ?? []
    return permissionPendingForCall(queue, props.part.callID)
  })
  return (
    <FollowupView
      theme={themeForView()}
      part={props.part}
      input={props.input}
      metadata={props.metadata}
      permissionPending={permissionPending()}
    />
  )
}

// ─── list ──────────────────────────────────────────────────────────────

export function ListMount(props: AgentToolProps<typeof AgentListTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const themeForView = createMemo(() => buildAgentToolTheme(theme))
  const permissionPending = createMemo(() => {
    const queue = sync.data.permission[props.part.sessionID] ?? []
    return permissionPendingForCall(queue, props.part.callID)
  })
  return (
    <ListView
      theme={themeForView()}
      part={props.part}
      input={props.input}
      metadata={props.metadata}
      output={props.output}
      permissionPending={permissionPending()}
    />
  )
}

// ─── close ─────────────────────────────────────────────────────────────

export function CloseMount(props: AgentToolProps<typeof AgentCloseTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const themeForView = createMemo(() => buildAgentToolTheme(theme))
  const permissionPending = createMemo(() => {
    const queue = sync.data.permission[props.part.sessionID] ?? []
    return permissionPendingForCall(queue, props.part.callID)
  })
  return (
    <CloseView
      theme={themeForView()}
      part={props.part}
      input={props.input}
      metadata={props.metadata}
      permissionPending={permissionPending()}
    />
  )
}

// Convenience dispatch used by routes/session/index.tsx. Saves the
// caller from importing each Mount one by one and keeps the Match block
// readable with a single dynamic case for "any agent tool".
//
// Accepts a wide prop shape (input / metadata typed as any) because the
// caller's `toolprops` is structurally typed for the union of every
// tool's schema — narrowing to a single tool's params here would force
// every other tool's branch to fail typing. Each inner Mount re-casts to
// its own per-tool ToolProps before handing to the view, which restores
// the precise types in the leaf components.
export function AgentToolMount(props: {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  permission: Record<string, unknown>
  tool: string
  part: ToolPart
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.tool === "spawn_agent"}>
        <SpawnMount {...(props as unknown as AgentToolProps<typeof AgentSpawnTool>)} />
      </Match>
      <Match when={props.tool === "wait_agent"}>
        <WaitMount {...(props as unknown as AgentToolProps<typeof AgentWaitTool>)} />
      </Match>
      <Match when={props.tool === "send_message"}>
        <SendMount {...(props as unknown as AgentToolProps<typeof AgentSendTool>)} />
      </Match>
      <Match when={props.tool === "followup_task"}>
        <FollowupMount {...(props as unknown as AgentToolProps<typeof AgentFollowupTool>)} />
      </Match>
      <Match when={props.tool === "list_agents"}>
        <ListMount {...(props as unknown as AgentToolProps<typeof AgentListTool>)} />
      </Match>
      <Match when={props.tool === "close_agent"}>
        <CloseMount {...(props as unknown as AgentToolProps<typeof AgentCloseTool>)} />
      </Match>
    </Switch>
  )
}

// Pure: discriminator the index.tsx Match block uses to decide whether
// to route through AgentToolMount. Exported so the test suite can verify
// the dispatch covers every wave-8 tool ID.
export const AGENT_TOOL_IDS = [
  "spawn_agent",
  "wait_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "close_agent",
] as const
export type AgentToolID = (typeof AGENT_TOOL_IDS)[number]

export function isAgentTool(tool: string): tool is AgentToolID {
  return (AGENT_TOOL_IDS as readonly string[]).includes(tool)
}
