import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"

// codemaxxxing render-bug instrumentation. Gated on OPENCODE_DEBUG_RENDER=1
// so it's free in production. Logs to the same opencode log file
// ($XDG_DATA_HOME/opencode/log/<timestamp>.log or dev.log).
//
// Diagnostic harness used to chase the streaming-rendering regression.
// Kept in place at near-zero cost (env-var gate evaluated at module load,
// dead `if (false) {}` blocks at every call site). The Log.create call is
// also conditionalized so the no-debug path doesn't even build the logger
// instance — Log.create() touches a Map and constructs closures that we
// don't need in production.
const RENDER_DEBUG = !!process.env.OPENCODE_DEBUG_RENDER
const renderLog = RENDER_DEBUG ? Log.create({ service: "tui-render" }) : undefined
const sessionLog = Log.create({ service: "tui.session" })
const dlog = (msg: string, extra?: Record<string, any>) => {
  if (RENDER_DEBUG && renderLog) renderLog.info(msg, extra)
}
import { useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { useTheme } from "@tui/context/theme"
import { bleed, clampRule, fadeRule, fadeTarget, mix, modelWord, RULE, sinkColor, Spans } from "@tui/ui/glow"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage,
  Message,
  Part,
  Provider,
  Session as SessionType,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import { inlineSafe } from "@tui/util/inline-safe"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { ShellTool } from "@/tool/shell"
import { ShellID } from "@/tool/shell/id"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { WebSearchTool } from "@/tool/websearch"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useEditorContext } from "@tui/context/editor"
import { useCommandDialog } from "@tui/component/dialog-command"
import type { DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer-mount.tsx"
import { isMailboxPart, MailboxMessage } from "./mailbox-message"
import { Process, ProcessWriteStdin } from "./process-tool"
import { AgentToolMount, isAgentTool } from "./agent-tool-mount"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import * as Clipboard from "../../util/clipboard"
import { errorMessage } from "@/util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import * as Editor from "../../util/editor"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@opencode-ai/core/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { DialogGoUpsell } from "../../component/dialog-go-upsell"
import { SessionRetry } from "@/session/retry"
import { getRevertDiffFiles } from "../../util/revert-diff"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
  // Pre-computed message ordinals + per-turn metadata for marginalia and the
  // closing-summary footer. Built once per messages-list change in the route
  // component, O(1) lookup per render. Replaces per-message createMemo scans
  // that were O(N) each → O(N²) total on every streaming chunk.
  //
  // `lastInTurn` is the set of assistant message ids that are the highest-id
  // assistant under their `parentID` (= last sibling in the turn). The
  // closing-summary footer ("build · model · duration") is gated on this so
  // that mid-turn assistant messages don't carry it once a newer sibling has
  // appeared.
  message_meta: () => {
    user: ReadonlyMap<string, number>
    assistant: ReadonlyMap<string, number>
    // Direct id→user-message lookup. Used by AssistantMessage.duration()
    // to find its parent user message in O(1) instead of walking the
    // whole list per assistant per render.
    user_by_id: ReadonlyMap<string, UserMessage>
    // Set of assistant message ids that are the FIRST assistant of their
    // turn — only these render the marginalia pill in the gutter.
    first_in_turn: ReadonlySet<string>
  }
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

// Module-scope frozen empty arrays. Reused across renders so that "no
// data yet" branches don't allocate fresh arrays each call — a fresh `[]`
// breaks Solid's value-equality short-circuit in downstream memos and
// re-keys <For> children unnecessarily. Frozen so any accidental mutation
// throws loudly in dev.
const EMPTY_SESSIONS: readonly SessionType[] = Object.freeze([]) as readonly SessionType[]
const EMPTY_PARTS: readonly Part[] = Object.freeze([]) as readonly Part[]
const EMPTY_MESSAGES: readonly Message[] = Object.freeze([]) as readonly Message[]

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  // Direct children of the CURRENT session (not the root). Single walk
  // over sync.data.session. Used by `session_child_first` so users can
  // drill into a subagent's own subagents at any nesting level — earlier
  // this resolved to "root + root's direct children", which silently
  // capped descent at depth 1 regardless of where you were in the tree.
  const children = createMemo(() => {
    const id = session()?.id
    if (!id) return EMPTY_SESSIONS
    return sync.data.session
      .filter((x) => x.parentID === id)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  // Sessions sharing the current session's parent (i.e. its siblings).
  // Used by `session_child_cycle` / _reverse so left/right cycling works
  // at every depth, not just at depth 1 where "siblings of a depth-1
  // subagent" happened to equal "root's direct children".
  const siblings = createMemo(() => {
    const parentID = session()?.parentID
    if (!parentID) return EMPTY_SESSIONS
    return sync.data.session
      .filter((x) => x.parentID === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  // codemaxxxing addition: nested-subagent (>1 level deep) descendants for
  // permission/question rollup. Detects in the SAME single walk whether
  // any deeper-than-one-level nesting exists; if not, returns the direct
  // children (identical to upstream's `children()` cost). Only the rare
  // multi-level case pays the BFS cost.
  const descendants = createMemo(() => {
    const root = session()
    if (!root) return EMPTY_SESSIONS
    const rootID = root.parentID ?? root.id
    const sessions = sync.data.session
    const direct: typeof sessions = []
    let hasDeepNesting = false
    for (const s of sessions) {
      if (s.id === rootID || s.parentID === rootID) {
        direct.push(s)
        continue
      }
      // A session whose parent isn't us and isn't a root means there's a
      // grandchild somewhere in the workspace. We don't yet know if it's
      // ours, but the deep walk below is the only way to know.
      if (s.parentID) hasDeepNesting = true
    }
    if (!hasDeepNesting) {
      return direct.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
    // Deep walk only fires when grandchildren exist somewhere.
    const childrenByParent = new Map<string, string[]>()
    for (const s of sessions) {
      if (!s.parentID) continue
      let arr = childrenByParent.get(s.parentID)
      if (!arr) childrenByParent.set(s.parentID, (arr = []))
      arr.push(s.id)
    }
    const seen = new Set<string>([rootID])
    const stack: string[] = [rootID]
    while (stack.length) {
      const id = stack.pop()!
      const kids = childrenByParent.get(id)
      if (!kids) continue
      for (const k of kids) {
        if (seen.has(k)) continue
        seen.add(k)
        stack.push(k)
      }
    }
    return sessions.filter((x) => seen.has(x.id))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  // Single O(N) pass to derive marginalia ordinals + per-turn last-sibling
  // ids. Per-message components read these as O(1) lookups instead of
  // re-scanning the whole list (which was O(N²) across N children on every
  // streaming chunk).
  // Single O(N) pass to derive marginalia ordinals + user-by-id index.
  // Per-message components read these as O(1) lookups.
  //
  // CRITICAL OPTIMIZATION: only rebuild when the message list LENGTH
  // changes. Messages are id-ordered and append-only — parts streaming
  // in mutates message contents in place but never reorders or appends
  // new messages, so the ordinals stay stable until a new message
  // boundary lands. Returning the same Map references when length is
  // unchanged means downstream `userIndex`/`assistantIndex` memos see
  // the same `message_meta()` reference per delta, their reactive
  // tracking short-circuits at the OUTER comparison, and their closures
  // never re-run during streaming.
  //
  // Length-tracker is its own memo so the O(1) `messages().length` read
  // is what's tracked per delta — message_meta only re-runs when the
  // length number actually changes.
  const messageCount = createMemo(() => messages().length)
  const message_meta = createMemo<{
    user: Map<string, number>
    assistant: Map<string, number>
    user_by_id: Map<string, UserMessage>
    // Set of assistant message ids that are the FIRST assistant of their
    // turn (i.e. the message immediately following a user prompt). Only
    // these get marginalia; later assistants in the same turn (tool-call
    // continuations, multi-step responses) render without to avoid
    // visual repetition like `a·1 a·1 a·1 a·1` down the gutter.
    first_in_turn: Set<string>
  }>(() => {
    void messageCount()
    const list = messages()
    const user = new Map<string, number>()
    const assistant = new Map<string, number>()
    const user_by_id = new Map<string, UserMessage>()
    const first_in_turn = new Set<string>()
    let turn = 0
    let lastRole: string | undefined
    for (const m of list) {
      if (m.role === "user") {
        turn++
        user.set(m.id, turn)
        user_by_id.set(m.id, m as UserMessage)
      } else if (m.role === "assistant") {
        // Inherit the turn of the user that started this thread.
        const parent = m.parentID
        const fromParent = parent ? user.get(parent) : undefined
        assistant.set(m.id, fromParent ?? turn)
        // First assistant after a user (or after a non-assistant role) is
        // first-in-turn. Sequential assistants within the same turn are
        // continuations and skip the marginalia.
        if (lastRole !== "assistant") first_in_turn.add(m.id)
      }
      lastRole = m.role
    }
    return { user, assistant, user_by_id, first_in_turn }
  })
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return descendants().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return descendants().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  // the prompt stays mounted during asks — the sacred bottom edge (fade
  // rule → cursor → whisper) never leaves the screen; asks render above it
  // and `disabled` moves the heat (specs/tui-redesign.md, "one glow at a
  // time" + "the bottom edge is sacred").
  const visible = createMemo(() => !session()?.parentID)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  // Single fold over messages produces both `pending` (id of in-flight
  // assistant) and `lastAssistant` (most recent assistant overall).
  // Walks BACKWARD and breaks on first assistant — O(1) when the tail is
  // an assistant (the common case mid-stream and immediately post-turn).
  // Upstream's two separate findLasts are O(1) each but it does both;
  // we do one. Worst case (no assistants at all) is O(N), same as upstream.
  const messageTail = createMemo(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.role !== "assistant") continue
      const ass = m as AssistantMessage
      const pending = ass.time.completed ? undefined : ass.id
      return { pending, lastAssistant: ass }
    }
    return { pending: undefined, lastAssistant: undefined as AssistantMessage | undefined }
  })

  const pending = createMemo(() => messageTail().pending)
  const lastAssistant = createMemo(() => messageTail().lastAssistant)

  // ── afterglow: the live line + return glance ──────────────────────────
  // the working sentence: verb + target of the newest meaningful part on
  // the in-flight assistant. walks backward and returns on the first
  // meaningful part, so the common mid-stream case is O(1) per delta; the
  // string result lets Solid's memo equality swallow repeat values.
  const busyInfo = createMemo(() => {
    const id = pending()
    if (!id) return undefined
    const startedAt = lastAssistant()?.time.created
    const parts = sync.data.part[id] ?? (EMPTY_PARTS as Part[])
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (part.type === "tool") {
        const state = (part as ToolPart).state
        if (state.status === "running" || state.status === "pending")
          return { text: busySentence(part as ToolPart), startedAt }
        return { text: "working", startedAt }
      }
      if (part.type === "reasoning") return { text: "thinking", startedAt }
      if (part.type === "text") return { text: "writing", startedAt }
    }
    return { text: "working", startedAt }
  })

  // the return glance: verdict + dim detail for the line above the rule.
  // only computed while idle — the early return keeps part reads untracked
  // during streaming so deltas never invalidate this.
  const glance = createMemo(() => {
    if (pending()) return undefined
    const last = lastAssistant()
    if (!last?.time.completed) return undefined
    const list = messages()
    const changed: string[] = []
    let cost = 0
    let userCreated: number | undefined
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.role === "user") {
        userCreated = m.time.created
        break
      }
      const ass = m as AssistantMessage
      cost += ass.cost
      for (const part of sync.data.part[m.id] ?? (EMPTY_PARTS as Part[])) {
        if (part.type !== "tool") continue
        const tool = (part as ToolPart).tool
        if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") continue
        const state = (part as ToolPart).state
        if (state.status !== "completed") continue
        const file = "input" in state ? (state.input as Record<string, any>)?.filePath : undefined
        const name = typeof file === "string" ? path.basename(file) : undefined
        if (name && !changed.includes(name)) changed.push(name)
      }
    }
    const aborted = last.error?.name === "MessageAbortedError"
    const failed = last.error !== undefined && !aborted
    const detail: string[] = []
    if (changed.length > 0)
      detail.push(`changed ${changed.slice(0, 2).join(", ")}${changed.length > 2 ? ` +${changed.length - 2}` : ""}`)
    if (userCreated && last.time.completed > userCreated) detail.push(Locale.duration(last.time.completed - userCreated))
    if (cost > 0) detail.push(`$${cost.toFixed(2)}`)
    return {
      verdict: failed ? "failed" : aborted ? "stopped" : "done",
      tone: (failed ? "error" : aborted ? "warning" : "success") as "error" | "warning" | "success",
      detail: detail.length > 0 ? detail.join(" · ") : undefined,
    }
  })
  // (note: there used to be a `lastAssistantID` memo here that fed
  // `last={…}` to every AssistantMessage. That prop was removed —
  // closing-summary now gates on `final() || aborted()` so it doesn't
  // need to know which message is "currently last". Eliminates a
  // per-delta memo + a per-message reactive prop comparison.)

  // ── instrumentation: route-level streaming signals ──────────────────
  // pending = id of the currently-streaming assistant (drives queued())
  // lastAssistant = drives the closing-summary `last` prop on every msg
  // Flips here mid-stream cascade into mount/unmount and re-keying below.
  if (RENDER_DEBUG) {
    let lastPending: string | undefined | null = null
    let lastLastAss: string | undefined | null = null
    createEffect(() => {
      const p = pending()
      if (lastPending !== p) {
        dlog("route.pending change", {
          sessionID: route.sessionID,
          from: lastPending === null ? "(init)" : (lastPending ?? "(none)"),
          to: p ?? "(none)",
          msgCount: messages().length,
        })
        lastPending = p
      }
    })
    createEffect(() => {
      const id = lastAssistant()?.id
      if (lastLastAss !== id) {
        dlog("route.lastAssistant change", {
          sessionID: route.sessionID,
          from: lastLastAss === null ? "(init)" : (lastLastAss ?? "(none)"),
          to: id ?? "(none)",
          msgCount: messages().length,
        })
        lastLastAss = id
      }
    })
    // Track messages array length and identity of last entry. A re-keying
    // event (last entry id changing without an append) signals the trim.
    let lastMsgLen = -1
    let lastTailID: string | undefined
    createEffect(() => {
      const list = messages()
      const tail = list.at(-1)?.id
      if (lastMsgLen !== list.length || lastTailID !== tail) {
        dlog("route.messages change", {
          sessionID: route.sessionID,
          prevLen: lastMsgLen,
          nextLen: list.length,
          prevTail: lastTailID ?? "(none)",
          nextTail: tail ?? "(none)",
          // reKey = length unchanged but tail id changed → we're swapping
          // items in place, which is the trim-at-100 path.
          reKey: lastMsgLen === list.length && lastTailID !== tail ? "YES" : "no",
        })
        lastMsgLen = list.length
        lastTailID = tail
      }
    })
  }

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()

  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = project.workspace.current()
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keybind = useKeybind()
  const dialog = useDialog()
  const renderer = useRenderer()

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (evt.properties.status.message !== SessionRetry.GO_UPSELL_MESSAGE) return
    if (dialog.stack.length > 0) return

    const seen = kv.get(GO_UPSELL_LAST_SEEN_AT)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(GO_UPSELL_DONT_SHOW)) return

    void DialogGoUpsell.show(dialog).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(GO_UPSELL_DONT_SHOW, true)
      kv.set(GO_UPSELL_LAST_SEEN_AT, Date.now())
    })
  })

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    return exit.message.set(
      [
        ``,
        `  █▄▄█ █▄▄█ █▄▄█  ${UI.Style.TEXT_DIM}${title}${UI.Style.TEXT_NORMAL}`,
        `   ██   ██   ██   ${UI.Style.TEXT_DIM}codemaxxxing -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        `  █▀▀█ █▀▀█ █▀▀█  `,
      ].join("\n"),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      void exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function moveFirstChild() {
    const list = children()
    if (list.length === 0) return
    navigate({
      type: "session",
      sessionID: list[0].id,
    })
  }

  function moveChild(direction: number) {
    const list = siblings()
    if (list.length <= 1) return
    const idx = list.findIndex((x) => x.id === session()?.id)
    if (idx === -1) return
    // direction semantic preserved from upstream (commit aa2d753e7e):
    // session_child_cycle = +1 = previous-index, session_child_cycle_reverse = -1 = next-index.
    let next = idx - direction
    if (next >= list.length) next = 0
    if (next < 0) next = list.length - 1
    navigate({
      type: "session",
      sessionID: list[next].id,
    })
  }

  function childSessionHandler(func: (dialog: DialogContext) => void) {
    return (dialog: DialogContext) => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func(dialog)
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        const copy = (url: string) =>
          Clipboard.copy(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") {
          sessionLog.info("session abort fired from messages_undo", { sessionID: route.sessionID })
          await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        }
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      onSelect: (dialog) => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      keybind: "session_child_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveFirstChild()
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(1)
        dialog.clear()
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(-1)
        dialog.clear()
      }),
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        diffWrapMode,
        providers,
        sync,
        tui: tuiConfig,
        message_meta,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={session()}>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: showScrollbar() ? 1 : 0,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: showScrollbar(),
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
            >
              <box height={1} />
              <For each={messages()}>
                {(message, index) => (
                  <Switch>
                    <Match when={message.id === revert()?.messageID}>
                      {(function () {
                        const command = useCommandDialog()
                        const [hover, setHover] = createSignal(false)
                        const dialog = useDialog()

                        const handleUnrevert = async () => {
                          const confirmed = await DialogConfirm.show(
                            dialog,
                            "Confirm Redo",
                            "Are you sure you want to restore the reverted messages?",
                          )
                          if (confirmed) {
                            command.trigger("session.redo")
                          }
                        }

                        return (
                          <box
                            onMouseOver={() => setHover(true)}
                            onMouseOut={() => setHover(false)}
                            onMouseUp={handleUnrevert}
                            marginTop={1}
                            flexShrink={0}
                          >
                            <box
                              flexDirection="row"
                              justifyContent="space-between"
                              alignItems="center"
                              paddingLeft={1}
                              paddingRight={1}
                            >
                              <text fg={hover() ? theme.text : theme.textMuted}>reverted</text>
                              <text fg={theme.textMuted}>
                                {revert()!.reverted.length} message{revert()!.reverted.length !== 1 ? "s" : ""}
                              </text>
                            </box>
                            <box paddingTop={1} paddingBottom={1} paddingLeft={3} flexShrink={0}>
                              <text fg={theme.textMuted}>
                                <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to
                                restore
                              </text>
                              <Show when={revert()!.diffFiles?.length}>
                                <box paddingTop={1}>
                                  <For each={revert()!.diffFiles}>
                                    {(file) => (
                                      <text fg={theme.text}>
                                        {file.filename}
                                        <Show when={file.additions > 0}>
                                          <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                        </Show>
                                        <Show when={file.deletions > 0}>
                                          <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                        </Show>
                                      </text>
                                    )}
                                  </For>
                                </box>
                              </Show>
                            </box>
                            <text wrapMode="none" flexShrink={0} selectable={false}>
                              <Spans
                                spans={fadeRule(
                                  theme,
                                  hover() ? theme.borderActive : theme.border,
                                  clampRule(RULE.deck, contentWidth()),
                                )}
                              />
                            </text>
                          </box>
                        )
                      })()}
                    </Match>
                    <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                      <></>
                    </Match>
                    <Match when={message.role === "user"}>
                      <UserMessage
                        index={index()}
                        onMouseUp={() => {
                          if (renderer.getSelection()?.getSelectedText()) return
                          dialog.replace(() => (
                            <DialogMessage
                              messageID={message.id}
                              sessionID={route.sessionID}
                              setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                            />
                          ))
                        }}
                        message={message as UserMessage}
                        parts={sync.data.part[message.id] ?? (EMPTY_PARTS as Part[])}
                        pending={pending()}
                      />
                    </Match>
                    <Match when={message.role === "assistant"}>
                      <AssistantMessage
                        message={message as AssistantMessage}
                        parts={sync.data.part[message.id] ?? (EMPTY_PARTS as Part[])}
                      />
                    </Match>
                  </Switch>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0}>
              {/* one glow at a time: while an ask is up, the work cools to
                  "… · paused" in sink tone right above the ask, which takes
                  the heat (asksD frame, glow.ts:133-140). */}
              <Show when={disabled() && busyInfo()}>
                {(busy) => (
                  <text wrapMode="none" fg={sinkColor(theme, 1)}>
                    {busy().text} · paused
                  </text>
                )}
              </Show>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Show when={session()?.parentID}>
                <SubagentFooter />
              </Show>
              <Show when={visible()}>
                <TuiPluginRuntime.Slot
                  name="session_prompt"
                  mode="replace"
                  session_id={route.sessionID}
                  visible={visible()}
                  disabled={disabled()}
                  on_submit={toBottom}
                  ref={bind}
                >
                  <Prompt
                    visible={visible()}
                    ref={bind}
                    disabled={disabled()}
                    onSubmit={() => {
                      toBottom()
                    }}
                    sessionID={route.sessionID}
                    busyText={busyInfo()?.text}
                    busyStartedAt={busyInfo()?.startedAt}
                    glance={glance()}
                    width={contentWidth()}
                    right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                  />
                </TuiPluginRuntime.Slot>
              </Show>
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} overlay />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  // Wave 11: cross-agent mailbox messages — synthetic text parts injected
  // by Wave 9's runLoop, discriminated by metadata.from. The body memo
  // already filters synthetic parts out so they don't appear as real user
  // input; here we surface them via the dedicated MailboxMessage chrome.
  const mail = createMemo(() => props.parts.filter((x) => isMailboxPart(x as TextPart)) as TextPart[])
  const { theme } = useTheme()
  const keybind = useKeybind()
  const flushKey = createMemo(() => keybind.print("session_flush_queued"))
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  // ── instrumentation: queueing window ────────────────────────────────
  if (RENDER_DEBUG) {
    dlog("UserMessage mount", {
      id: props.message.id,
      pending: props.pending ?? "(none)",
      queued: queued(),
      partsLen: props.parts.length,
    })
    onCleanup(() => dlog("UserMessage UNMOUNT", { id: props.message.id, partsLen: props.parts.length }))
    let lastPending: string | undefined | null = null
    let lastQueued: boolean | string | undefined
    createEffect(() => {
      const p = props.pending
      const q = queued()
      if (lastPending !== p || lastQueued !== q) {
        dlog("UserMessage pending/queued change", {
          id: props.message.id,
          pendingFrom: lastPending === null ? "(init)" : (lastPending ?? "(none)"),
          pendingTo: p ?? "(none)",
          queuedFrom: String(lastQueued),
          queuedTo: String(q),
        })
        lastPending = p
        lastQueued = q
      }
    })
  }

  // the human is borderActive — semantically "the active one", distinct
  // from chrome in every theme. bold words + a dissolving rule instead of
  // gutter ordinals (afterglow: structure is made of fades).
  const ruleSpans = createMemo(() => fadeRule(theme, theme.borderActive, clampRule(RULE.human, ctx.width)))

  return (
    <>
      <Show when={text() || mail().length > 0}>
        {/* Body text, files, mailbox messages, and queued/timestamp stack
            vertically as siblings in this column box. They are NOT
            wrapped in a flexDirection="row" — opentui can't lay out a
            flex row whose body cell contains very tall content (a
            multi-KB pasted block wraps to many rows; a forwarded sibling
            tool-output the same). Once the row's measurement blows past
            opentui's internal budget, paint stalls past the row and the
            rest of the session appears frozen until a later layout pass
            releases it. Queued/timestamp render as their own
            right-aligned row at the bottom, mirroring the pattern
            AssistantMessage uses for its closing summary. */}
        <box id={props.message.id} marginTop={props.index === 0 ? 0 : 1} flexShrink={0} onMouseUp={props.onMouseUp}>
          <Show when={text()}>
            <text fg={theme.borderActive} attributes={TextAttributes.BOLD}>
              {text()}
            </text>
          </Show>
          <Show when={files().length}>
            <For each={files()}>
              {(file) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {MIME_BADGE[file.mime] ?? file.mime} · {file.filename}
                </text>
              )}
            </For>
          </Show>
          <Show when={mail().length}>
            <For each={mail()}>
              {(part) => (
                <MailboxMessage
                  part={part}
                  theme={theme}
                  agentColor={color()}
                  triggerTurn={part.metadata?.["trigger_turn"] === true}
                />
              )}
            </For>
          </Show>
          <text wrapMode="none" flexShrink={0} selectable={false}>
            <Spans spans={ruleSpans()} />
          </text>
          <Show when={queued()}>
            <box flexDirection="row" justifyContent="flex-end" gap={1}>
              <Show when={flushKey()}>
                <text flexShrink={0} fg={theme.textMuted}>
                  {flushKey()} to flush ·
                </text>
              </Show>
              <text flexShrink={0}>
                <span style={{ fg: color(), bold: true }}>queued</span>
              </text>
            </box>
          </Show>
          <Show when={!queued() && ctx.showTimestamps()}>
            <box flexDirection="row" justifyContent="flex-end">
              <text flexShrink={0} fg={theme.textMuted}>
                {Locale.todayTimeOrDateTime(props.message.time.created).toLowerCase()}
              </text>
            </box>
          </Show>
        </box>
      </Show>
      <Show when={compaction()}>
        <box marginTop={1} flexShrink={0}>
          <text fg={theme.textMuted}>context compacted</text>
          <text wrapMode="none" flexShrink={0} selectable={false}>
            <Spans spans={ruleSpans()} />
          </text>
        </box>
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[] }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  // (note: there used to be a `model` memo here that ran Model.name on every
  // theme/provider change. The closing-summary now renders props.message.modelID
  // directly per the new design, so the memo was dead. Removed.)

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  // Duration uses the route-level user_by_id index (O(1)) instead of
  // messages().find() (O(N)). With N assistant messages mounted that
  // dropped a per-render O(N²) scan to O(N).
  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const parentID = props.message.parentID
    if (!parentID) return 0
    const user = ctx.message_meta().user_by_id.get(parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const keybind = useKeybind()

  const agentColor = createMemo(() => local.agent.color(props.message.agent))
  const aborted = createMemo(() => props.message.error?.name === "MessageAbortedError")
  // Memoized so the `<Show>` for "view subagents" hint doesn't re-walk the
  // parts array on every streaming delta. Was previously inline
  // `props.parts.some(...)` → O(P) per delta × N assistant messages mounted.
  const hasTaskTool = createMemo(() => props.parts.some((x) => x.type === "tool" && x.tool === "task"))
  // Memoized error-display predicate. Was inline in the JSX → re-evaluated
  // the error name on every reactive read.
  const hasUserError = createMemo(() => !!props.message.error && props.message.error.name !== "MessageAbortedError")
  // A turn that finished with `content-filter` produces only step-start /
  // step-finish parts (no text/tool/reasoning) and carries no error, so nothing
  // visible renders and the turn looks like a silent "no response". Surface it
  // explicitly instead. (`finish` is a free-form string in the schema.)
  const blocked = createMemo(() => props.message.finish === "content-filter")

  // Combined render array — parts plus the trailing slots (task hint,
  // user error, closing summary). Rendered as a single <For> in the
  // body so order is stable against opentui's late-mount quirks (see
  // the JSX comment in the body for the full rationale).
  //
  // Type discriminator on the union ensures each item knows what to
  // render. We use a tagged-union shape rather than a Symbol/sentinel
  // so it's serializable and easy to debug.
  type RenderItem =
    | { kind: "part"; part: Part; last: boolean }
    | { kind: "quiet"; parts: ToolPart[] }
    | { kind: "task" }
    | { kind: "error" }
    | { kind: "blocked" }
    | { kind: "summary" }
  const renderable = createMemo<RenderItem[]>(() => {
    const items: RenderItem[] = []
    const parts = props.parts
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      // quiet tools (read/grep/glob) that finished cleanly coalesce into
      // one dim chatter line (afterglow: quiet/loud tool hierarchy).
      // anything still running, denied, or errored renders standalone so
      // its heat stays visible. invisible parts (step-start/step-finish/
      // snapshot — everything PART_MAPPING renders as null) sit between
      // tool rounds; they must not break a run.
      if (isQuietPart(part)) {
        const run: ToolPart[] = [part as ToolPart]
        let j = i + 1
        while (j < parts.length) {
          const next = parts[j]
          if (isQuietPart(next)) {
            run.push(next as ToolPart)
            i = j
            j++
            continue
          }
          if (!(next.type in PART_MAPPING)) {
            // invisible — peek past it, but only consume it if the run
            // actually continues on the other side.
            let k = j + 1
            while (k < parts.length && !(parts[k].type in PART_MAPPING)) k++
            if (k < parts.length && isQuietPart(parts[k])) {
              run.push(parts[k] as ToolPart)
              i = k
              j = k + 1
              continue
            }
          }
          break
        }
        items.push({ kind: "quiet", parts: run })
        continue
      }
      items.push({ kind: "part", part, last: i === parts.length - 1 })
    }
    if (hasTaskTool()) items.push({ kind: "task" })
    if (hasUserError()) items.push({ kind: "error" })
    if (blocked()) items.push({ kind: "blocked" })
    if (final() || aborted()) items.push({ kind: "summary" })
    return items
  })
  // NOTE: previously this body was wrapped in <Show when={hasVisibleParts()}>
  // where hasVisibleParts checked for text|tool|reasoning. Streaming assistant
  // messages always start with a `step-start` part (which doesn't qualify),
  // so the entire body — including the streaming <code> element that owns the
  // markdown-streaming buffer — stayed UNMOUNTED for ~500ms-2s until the
  // first reasoning/text/tool part arrived. Then the body mounted with the
  // accumulated parts already populated and painted them in one frame instead
  // of streaming them in. From the user's POV: "stops streaming, send a new
  // message, suddenly a chunk that wasn't streamed appears."
  //
  // Fix: render the body unconditionally (matches upstream). The marginalia
  // pill renders next to a possibly-empty body for a beat — that's fine; the
  // streaming <code> element keeps its incremental state across deltas.

  // ── instrumentation ────────────────────────────────────────────────────
  if (RENDER_DEBUG) {
    dlog("AssistantMessage mount", {
      id: props.message.id,
      sessionID: props.message.sessionID,
      partsLen: props.parts.length,
      partTypes: props.parts.map((p) => p.type).join(","),
      finish: props.message.finish ?? "(streaming)",
    })
    onCleanup(() =>
      dlog("AssistantMessage UNMOUNT", {
        id: props.message.id,
        partsLen: props.parts.length,
        finish: props.message.finish ?? "(streaming)",
      }),
    )
    // Track parts-array reference identity. If this fires while finish is
    // still undefined, the streaming array reference is being swapped under
    // us — that breaks <For> identity for in-flight parts.
    let lastRef: Part[] | undefined
    createEffect(() => {
      const arr = props.parts
      if (lastRef !== arr) {
        dlog("AssistantMessage parts ref changed", {
          id: props.message.id,
          prevLen: lastRef?.length ?? -1,
          nextLen: arr.length,
          prevTypes: lastRef?.map((p) => p.type).join(",") ?? "",
          nextTypes: arr.map((p) => p.type).join(","),
          finish: props.message.finish ?? "(streaming)",
        })
        lastRef = arr
      }
    })
  }

  return (
    <>
      <box flexShrink={0} marginTop={1}>
        {/* Single <For> renders parts + the trailing slots (task hint,
            user error, closing summary) so order is determined by array
            index — not by mount timing. opentui's late-mount ordering
            for sibling <For>/<Switch>/<Show> is unreliable when items
            mount asynchronously (parts streaming, summary flipping
            visible mid-stream): late children can land BEFORE earlier
            ones in the rendered output, producing the
            "summary-above-text" bug.

            Combining everything into one <For> over a derived array
            makes opentui's reconciliation key-stable: the array index
            IS the order, and items are added/removed at their array
            position. */}
        <For each={renderable()}>
          {(item) => {
            if (item.kind === "part") {
              const component = PART_MAPPING[item.part.type as keyof typeof PART_MAPPING]
              if (!component) return null
              return <Dynamic last={item.last} component={component} part={item.part as any} message={props.message} />
            }
            if (item.kind === "quiet") return <QuietRun parts={item.parts} />
            if (item.kind === "task")
              return (
                <box paddingTop={1}>
                  <text fg={theme.text}>
                    {keybind.print("session_child_first")}
                    <span style={{ fg: theme.textMuted }}> view subagents</span>
                  </text>
                </box>
              )
            if (item.kind === "error")
              return (
                <box paddingTop={1} flexShrink={0}>
                  <text fg={theme.error}>{props.message.error?.data.message}</text>
                </box>
              )
            if (item.kind === "blocked")
              return (
                <box paddingTop={1} flexShrink={0}>
                  <text fg={theme.warning}>
                    {
                      "response blocked by the model's content filter (finish: content-filter). you may still be billed for context processing — try another model or rephrase."
                    }
                  </text>
                </box>
              )
            // item.kind === "summary"
            return (
              <box flexDirection="row" justifyContent="flex-end" marginTop={1} flexShrink={0} flexWrap="wrap">
                <text>
                  <span
                    style={{
                      fg: aborted() ? theme.textMuted : agentColor(),
                      bold: !aborted(),
                    }}
                  >
                    {props.message.mode}
                  </span>
                  <span style={{ fg: theme.textMuted }}> · </span>
                  <span style={{ fg: theme.textMuted }}>{modelWord(props.message.modelID)}</span>
                  <Show when={duration()}>
                    <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
                  </Show>
                  <Show when={props.message.cost > 0}>
                    <span style={{ fg: theme.textMuted }}> · ${props.message.cost.toFixed(2)}</span>
                  </Show>
                  <Show when={aborted()}>
                    <span style={{ fg: theme.textMuted }}> · interrupted</span>
                  </Show>
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

// how many thinking lines stay readable once a thought has cooled; the
// rest sinks into the dark behind an "n more" whisper (afterglow sink).
const THINKING_COLLAPSE = 3

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  // the live edge glows: while the thought streams it stays fully visible;
  // once time.end lands it cools and collapses.
  const streaming = createMemo(() => props.part.time?.end === undefined)
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => content().split("\n"))
  const overflow = createMemo(() => lines().length > THINKING_COLLAPSE)
  const headSpans = createMemo(() =>
    fadeRule(theme, mix(theme.info, fadeTarget(theme), 0.5), clampRule(RULE.thinking, ctx.width - 9)),
  )
  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          if (overflow() && !streaming()) setExpanded((v) => !v)
        }}
      >
        <text wrapMode="none" flexShrink={0} selectable={false}>
          <span style={{ fg: theme.info }}>thinking </span>
          <Spans spans={headSpans()} />
        </text>
        <box paddingLeft={2} flexShrink={0}>
          <Switch>
            <Match when={streaming() || expanded() || !overflow()}>
              <code
                filetype="markdown"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={subtleSyntax()}
                content={content()}
                conceal={ctx.conceal()}
                fg={theme.textMuted}
              />
            </Match>
            <Match when={true}>
              <text fg={theme.textMuted}>{lines().slice(0, THINKING_COLLAPSE - 1).join("\n")}</text>
              <text fg={sinkColor(theme, 1)} wrapMode="none">
                {lines()[THINKING_COLLAPSE - 1]}
              </text>
              <text fg={sinkColor(theme, 2)}>{lines().length - THINKING_COLLAPSE + 1} more</text>
            </Match>
          </Switch>
        </box>
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  if (RENDER_DEBUG) {
    dlog("TextPart mount", {
      msgID: props.message.id,
      partID: props.part.id,
      textLen: props.part.text.length,
      preview: props.part.text.slice(-40),
    })
    onCleanup(() =>
      dlog("TextPart UNMOUNT", {
        msgID: props.message.id,
        partID: props.part.id,
        textLen: props.part.text.length,
      }),
    )
    let lastLen = -1
    createEffect(() => {
      const len = props.part.text.length
      if (lastLen !== len) {
        // Only log on length changes that aren't trivial deltas to keep log
        // volume sane. Log first chunk and every 200-char milestone.
        if (lastLen === -1 || Math.floor(len / 200) !== Math.floor(lastLen / 200)) {
          dlog("TextPart len", {
            msgID: props.message.id,
            partID: props.part.id,
            len,
            tail: props.part.text.slice(-40),
          })
        }
        lastLen = len
      }
    })
  }
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
            />
          </Match>
          <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()
  // Theme is read once at ToolPart construction so the wave-3 unified_exec
  // renderers (Process / ProcessWriteStdin) can take colors as props
  // rather than calling useTheme() themselves. Keeping them context-free
  // means they can be unit-rendered in isolation without booting the
  // Theme/Sync/Session provider stack — see process-tool.test.tsx.
  const { theme } = useTheme()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === ShellID.ToolID}>
          <Shell {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={props.part.tool === "exec_command"}>
          <Process {...toolprops} theme={theme} />
        </Match>
        <Match when={props.part.tool === "write_stdin"}>
          <ProcessWriteStdin {...toolprops} theme={theme} />
        </Match>
        {/* Wave-8 multi-agent v2 tool dispatch. AgentToolMount internally
            routes to the right view (SpawnView, WaitView, SendView,
            FollowupView, ListView, CloseView). One Match here keeps the
            top-level switch readable; per-tool dispatch + memoization
            lives in agent-tool-mount.tsx. */}
        <Match when={isAgentTool(props.part.tool)}>
          <AgentToolMount {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const maxLines = 3
  const overflow = createMemo(() => lines().length > maxLines)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, maxLines), "…"].join("\n")
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool label={props.tool} pending="running..." complete={true} part={props.part}>
          {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        label={props.tool}
        target={input(props.input)}
        part={props.part}
        onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "collapse" : `${lines().length - maxLines} more`}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  label: string
  complete: any
  pending: string
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  // Single fg memo (was two: labelFg + bodyFg). Both downstream
  // call sites used the same color for label and body in 100% of cases,
  // and the only difference was that bodyFg considered `props.complete`.
  // Render them with one color choice — rolls 2 memos into 1, removes
  // 2 spans per inline tool render.
  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <text fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show fallback={<>{props.pending}</>} when={props.complete}>
          {props.label} · {props.children}
        </Show>
      </text>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

// quiet tools that finished cleanly — read/grep/glob — coalesce into one
// dim chatter line with `·` separators (glow.ts:72). label dim, target in
// text, counts dim.
const QUIET_TOOLS = new Set(["read", "grep", "glob"])

function isQuietPart(part: Part): boolean {
  return part.type === "tool" && QUIET_TOOLS.has(part.tool) && part.state.status === "completed"
}

function quietSegment(part: ToolPart): { label: string; target: string; detail?: string } {
  const args = ("input" in part.state ? (part.state.input ?? {}) : {}) as Record<string, any>
  const metadata = (part.state.status === "completed" ? (part.state.metadata ?? {}) : {}) as Record<string, any>
  switch (part.tool) {
    case "read": {
      const offset = typeof args.offset === "number" ? args.offset : undefined
      const limit = typeof args.limit === "number" ? args.limit : undefined
      const detail =
        offset !== undefined && limit !== undefined
          ? `${offset}–${offset + limit}`
          : offset !== undefined
            ? `from ${offset}`
            : undefined
      return { label: "read", target: normalizePath(args.filePath), detail }
    }
    case "grep": {
      const matches = typeof metadata.matches === "number" ? metadata.matches : undefined
      return {
        label: "grep",
        target: inlineSafe(String(args.pattern ?? ""), 40),
        detail: matches !== undefined ? `${matches} ${matches === 1 ? "match" : "matches"}` : undefined,
      }
    }
    case "glob": {
      const count = typeof metadata.count === "number" ? metadata.count : undefined
      return {
        label: "glob",
        target: inlineSafe(String(args.pattern ?? ""), 40),
        detail: count !== undefined ? `${count} ${count === 1 ? "match" : "matches"}` : undefined,
      }
    }
    default:
      return { label: part.tool, target: "" }
  }
}

function QuietRun(props: { parts: ToolPart[] }) {
  const ctx = use()
  const { theme } = useTheme()
  return (
    <Show when={ctx.showDetails()}>
      <box marginTop={1} flexShrink={0}>
        <text fg={theme.textMuted} wrapMode="none">
          <For each={props.parts}>
            {(part, i) => {
              const seg = createMemo(() => quietSegment(part))
              return (
                <>
                  <Show when={i() > 0}>
                    <span style={{ fg: theme.textMuted }}> · </span>
                  </Show>
                  <span style={{ fg: theme.textMuted }}>{seg().label} </span>
                  <span style={{ fg: theme.text }}>{seg().target}</span>
                  <Show when={seg().detail}>
                    <span style={{ fg: theme.textMuted }}> {seg().detail}</span>
                  </Show>
                </>
              )
            }}
          </For>
        </text>
      </box>
    </Show>
  )
}

function BlockTool(props: {
  label: string
  target?: string
  color?: RGBA
  meta?: JSX.Element
  children?: JSX.Element
  onClick?: () => void
  part?: ToolPart
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))

  // afterglow loud object: colored header word + bold title, metadata as a
  // dim right-edge whisper. hover brightens the header word as the click
  // affordance.
  const labelFg = createMemo(() => (hover() && props.onClick ? theme.text : (props.color ?? theme.textMuted)))

  return (
    <box
      marginTop={1}
      gap={1}
      flexShrink={0}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      {/* Header: one <text> left (label span + bold title span), one
          <text> right (whisper). Both single-line (inlineSafe / short),
          so the justify-between flex-row is safe per
          specs/tui-render-freeze.md. */}
      <box flexDirection="row" justifyContent="space-between" gap={2} alignItems="flex-start" flexShrink={0}>
        <text wrapMode="none" flexShrink={1}>
          <span style={{ fg: labelFg() }}>{props.label}</span>
          <Show when={props.target}>
            <span style={{ fg: theme.text, bold: true }}> {inlineSafe(props.target)}</span>
          </Show>
        </text>
        <Show when={props.meta}>
          <text wrapMode="none" flexShrink={0}>
            {props.meta}
          </text>
        </Show>
      </box>
      {/* Children render DIRECTLY in the outer box — no extra wrapper.
          The fork previously wrapped children in <box paddingLeft={2}
          flexShrink={0}>, which broke layout for tall children like
          Write's <code> element rendering a multi-KB file (hundreds of
          rows). opentui's flex pass on deeply-nested flexShrink={0}
          boxes with massive intrinsic content silently truncates past
          some internal measurement budget — subsequent siblings (the
          next BlockTool / next AssistantMessage) then never paint
          either, which is the "render frozen at markdownImage JSON"
          bug. Upstream renders children directly inside the outer box;
          we now do the same. */}
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps<typeof ShellTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const description = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return desc
    if (desc.includes(wd)) return desc
    return `${desc} in ${wd}`
  })

  // verdict whisper for the run object: bold verdict word + dim timing.
  const durationText = createMemo(() => {
    const time = "time" in props.part.state ? props.part.state.time : undefined
    if (!time?.start) return undefined
    const end = "end" in time && typeof time.end === "number" ? time.end : undefined
    if (!end) return undefined
    const ms = end - time.start
    return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : Locale.duration(ms)
  })
  const verdict = createMemo<{ word: string; fg: RGBA } | undefined>(() => {
    if (isRunning()) return undefined
    const exit = props.metadata.exit
    if (exit === 0) return { word: "done", fg: theme.success }
    if (typeof exit === "number") return { word: `exit ${exit}`, fg: theme.error }
    if (props.part.state.status === "completed") return { word: "stopped", fg: theme.warning }
    return undefined
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          label="run"
          color={theme.primary}
          target={props.input.command}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
          meta={
            <Show when={verdict()}>
              {(v) => (
                <>
                  <span style={{ fg: v().fg, bold: true }}>{v().word}</span>
                  <Show when={durationText()}>
                    <span style={{ fg: theme.textMuted }}> · {durationText()}</span>
                  </Show>
                </>
              )}
            </Show>
          }
        >
          {/* output at nested indent, cooling into the dark: body dim, the
              last visible line sinks, the "n more" whisper is almost gone. */}
          <Show when={output()}>
            <box paddingLeft={2} flexShrink={0}>
              <Show when={overflow() && !expanded()} fallback={<text fg={theme.textMuted}>{limited()}</text>}>
                <text fg={theme.textMuted}>{lines().slice(0, 9).join("\n")}</text>
                <text fg={sinkColor(theme, 1)} wrapMode="none">
                  {lines()[9]}
                </text>
                <text fg={sinkColor(theme, 2)}>{lines().length - 10} more</text>
              </Show>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="run" pending="writing a command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          label="wrote"
          color={theme.secondary}
          target={normalizePath(props.input.filePath!)}
          part={props.part}
        >
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="write" pending="preparing write..." complete={props.input.filePath} part={props.part}>
          {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool label="glob" pending="finding files..." complete={props.input.pattern} part={props.part}>
      "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool label="read" pending="reading..." complete={props.input.filePath} part={props.part}>
        {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool label="grep" pending="searching..." complete={props.input.pattern} part={props.part}>
      "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool label="webfetch" pending="fetching..." complete={props.input.url} part={props.part}>
      {props.input.url}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<typeof WebSearchTool>) {
  const { theme } = useTheme()
  const input = props.input as any
  // Cheap presence check — avoids running the full regex parse pipeline
  // until the output is actually finalized AND we have something. The
  // expensive memo only fires once per real change to the output string,
  // not per streaming delta of an in-flight assistant turn.
  const hasOutput = createMemo(() => {
    const o = props.output
    return typeof o === "string" && o.trim().length > 0
  })
  // Result count from a single regex against the raw output. O(N) over
  // the output string but no per-result allocation, no .match() x4 per
  // chunk. Used by the collapsed branch so we can show "(N results)"
  // without parsing the whole structure.
  const resultCount = createMemo(() => {
    if (!hasOutput()) return 0
    const o = props.output as string
    let count = 0
    for (let i = 0; i < o.length; ) {
      const idx = o.indexOf("Title:", i)
      if (idx === -1) break
      // Match only when at line start
      if (idx === 0 || o.charCodeAt(idx - 1) === 10) count++
      i = idx + 6
    }
    return count
  })
  const [expanded, setExpanded] = createSignal(false)
  // Heavy parse — only runs when expanded. Single string read inside the
  // closure so reactivity correctly tracks the output once.
  const results = createMemo(() => {
    if (!expanded()) return EMPTY_RESULTS
    const o = props.output ?? ""
    return parseWebsearchResults(o)
  })

  return (
    <Switch>
      <Match when={resultCount() && expanded()}>
        <BlockTool
          label="websearch"
          target={`"${input.query}"`}
          meta={<span style={{ fg: theme.textMuted }}>{resultCount()} results</span>}
          part={props.part}
          onClick={() => setExpanded(false)}
        >
          <box gap={1}>
            <For each={results()}>
              {(r, i) => (
                <box>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{String(i() + 1).padStart(2, " ")}. </span>
                    <span style={{ fg: theme.text }}>{r.title}</span>
                  </text>
                  <text fg={theme.textMuted}>
                    {"    "}
                    {r.domain}
                    {r.date ? ` · ${r.date}` : ""}
                    {r.author ? ` · ${r.author}` : ""}
                  </text>
                </box>
              )}
            </For>
          </box>
          <text fg={theme.textMuted}>collapse</text>
        </BlockTool>
      </Match>
      <Match when={resultCount()}>
        <BlockTool
          label="websearch"
          target={`"${input.query}"`}
          meta={<span style={{ fg: theme.textMuted }}>{resultCount()} results</span>}
          part={props.part}
          onClick={() => setExpanded(true)}
        >
          <text fg={theme.textMuted}>{resultCount()} results — click to open</text>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="websearch" pending="searching the web..." complete={input.query} part={props.part}>
          "{input.query}"
        </InlineTool>
      </Match>
    </Switch>
  )
}

interface WebsearchResult {
  title: string
  url: string
  domain: string
  author?: string
  date?: string
}
const EMPTY_RESULTS: readonly WebsearchResult[] = Object.freeze([]) as readonly WebsearchResult[]
const TITLE_RE = /^Title: (.+)/m
const URL_RE = /^URL: (.+)/m
const AUTHOR_RE = /^Author: (.+)/m
const DATE_RE = /^Published Date: (.+)/m
const DOMAIN_RE = /^https?:\/\/(?:www\.)?([^/]+)/
const SPLIT_RE = /(?=^Title: )/m
function parseWebsearchResults(output: string): WebsearchResult[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  const out: WebsearchResult[] = []
  for (const chunk of trimmed.split(SPLIT_RE)) {
    const title = chunk.match(TITLE_RE)?.[1]?.trim()
    const url = chunk.match(URL_RE)?.[1]?.trim()
    if (!title || !url) continue
    const domain = url.match(DOMAIN_RE)?.[1] ?? url
    const author = chunk.match(AUTHOR_RE)?.[1]?.trim() || undefined
    const date = chunk.match(DATE_RE)?.[1]?.trim()?.split("T")[0]
    out.push({ title, url, domain, author, date })
  }
  return out
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { navigate } = useRoute()
  const sync = useSync()

  onMount(() => {
    if (props.metadata.sessionId && !sync.data.message[props.metadata.sessionId]?.length)
      void sync.session.sync(props.metadata.sessionId)
  })

  const messages = createMemo(() => sync.data.message[props.metadata.sessionId ?? ""] ?? (EMPTY_MESSAGES as Message[]))

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? (EMPTY_PARTS as Part[]))
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const isRunning = createMemo(() => props.part.state.status === "running")

  // Single pass over the subagent's messages — was previously
  // .find() + .findLast() = two full walks per render. With a long subagent
  // session and per-delta invalidation that's O(2N) per chunk; this is O(N).
  const duration = createMemo(() => {
    let first: number | undefined
    let assistant: number | undefined
    for (const m of messages()) {
      if (m.role === "user" && first === undefined) first = m.time?.created
      if (m.role === "assistant" && m.time?.completed) assistant = m.time.completed
    }
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    if (!props.input.description) return ""
    let content = [`${(props.input.subagent_type ?? "general").toLowerCase()} — ${props.input.description}`]

    if (isRunning() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`  ${current()!.tool.toLowerCase()} ${title ?? ""}`)
      } else content.push(`  ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(`  ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      label="task"
      complete={props.input.description}
      pending="delegating..."
      part={props.part}
      onClick={() => {
        if (props.metadata.sessionId) {
          navigate({ type: "session", sessionID: props.metadata.sessionId })
        }
      }}
    >
      {content()}
    </InlineTool>
  )
}

// ── bleed diff ──────────────────────────────────────────────────────────
// the edit object's diff rows carry a wash that bleeds out: row bg
// strongest at the left, gone by the wash width (glow.ts:33-43). replaces
// the native <diff> element — the wash can't be expressed through its
// uniform addedBg/removedBg props, and the deck drops line numbers /
// split view / diff syntax highlighting for this surface anyway.
type BleedRow = { kind: "add" | "del" | "ctx"; text: string }

function parseUnifiedDiff(diff: string): BleedRow[] {
  const rows: BleedRow[] = []
  for (const line of diff.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    )
      continue
    const text = line.slice(1).replace(/\t/g, "  ")
    if (line.startsWith("+")) rows.push({ kind: "add", text })
    else if (line.startsWith("-")) rows.push({ kind: "del", text })
    else rows.push({ kind: "ctx", text: line.replace(/\t/g, "  ") })
  }
  while (rows.length > 0 && rows[0].kind === "ctx" && !rows[0].text.trim()) rows.shift()
  while (rows.length > 0 && rows[rows.length - 1].kind === "ctx" && !rows[rows.length - 1].text.trim()) rows.pop()
  return rows
}

// collapsed: only the changed rows (capped) — finished work cools; the
// full diff with context is one click away.
const BLEED_COLLAPSE = 12

function BleedDiff(props: { diff: string }) {
  const ctx = use()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const rows = createMemo(() => parseUnifiedDiff(props.diff))
  const changed = createMemo(() => rows().filter((r) => r.kind !== "ctx"))
  const overflow = createMemo(() => changed().length > BLEED_COLLAPSE)
  const washWidth = createMemo(() => Math.max(12, Math.min(52, ctx.width - 4)))
  const visible = createMemo<BleedRow[]>(() => {
    if (expanded()) return rows()
    return changed().slice(0, BLEED_COLLAPSE)
  })
  // one memo builds every row's span array — rebuilds only when the diff,
  // width, theme, or expansion changes; never per stream delta.
  const rowSpans = createMemo(() =>
    visible().map((row) => {
      if (row.kind === "ctx") return [{ text: row.text, fg: theme.textMuted }]
      const fg = row.kind === "add" ? theme.diffAdded : theme.diffRemoved
      return bleed(theme, row.text, fg, fg, washWidth())
    }),
  )
  const hidden = createMemo(() => (expanded() ? 0 : changed().length - visible().length))
  return (
    <box
      paddingLeft={2}
      flexShrink={0}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (rows().length > visible().length || expanded()) setExpanded((v) => !v)
      }}
    >
      <For each={rowSpans()}>
        {(spans) => (
          <text wrapMode="none" flexShrink={0}>
            <Spans spans={spans} />
          </text>
        )}
      </For>
      <Show when={hidden() > 0}>
        <text fg={sinkColor(theme, 2)}>{hidden()} more</text>
      </Show>
    </box>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const { theme } = useTheme()

  const diffContent = createMemo(() => props.metadata.diff)

  // Primitive memos — Solid value-equality short-circuits when adds/dels
  // don't actually change. Previously this was a single createMemo
  // returning JSX, so even a no-change recompute swapped the meta JSX
  // identity per reactive recheck and tore down the inner spans.
  const additions = createMemo(() => {
    const fd = props.metadata.filediff as { additions?: number; deletions?: number } | undefined
    return fd?.additions ?? 0
  })
  const deletions = createMemo(() => {
    const fd = props.metadata.filediff as { additions?: number; deletions?: number } | undefined
    return fd?.deletions ?? 0
  })
  const hasMeta = createMemo(() => additions() > 0 || deletions() > 0)

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool
          label="edit"
          color={theme.secondary}
          target={normalizePath(props.input.filePath!)}
          meta={
            hasMeta() ? (
              <>
                <Show when={additions() > 0}>
                  <span style={{ fg: theme.diffAdded }}>+{additions()}</span>
                </Show>
                <Show when={additions() > 0 && deletions() > 0}> </Show>
                <Show when={deletions() > 0}>
                  <span style={{ fg: theme.diffRemoved }}>−{deletions()}</span>
                </Show>
              </>
            ) : undefined
          }
          part={props.part}
        >
          <BleedDiff diff={diffContent() ?? ""} />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="edit" pending="preparing edit..." complete={props.input.filePath} part={props.part}>
          {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const { theme } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  function fileLabel(file: { type: string }) {
    if (file.type === "delete") return "deleted"
    if (file.type === "add") return "created"
    if (file.type === "move") return "moved"
    return "patched"
  }

  function fileTarget(file: { type: string; relativePath: string; filePath: string }) {
    if (file.type === "move") return `${normalizePath(file.filePath)} → ${file.relativePath}`
    return file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool label={fileLabel(file)} color={theme.secondary} target={fileTarget(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    −{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <BleedDiff diff={file.patch} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool label="patch" pending="preparing patch..." complete={false} part={props.part}>
          patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool label="todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="todos" pending="planning..." complete={false} part={props.part}>
          planning...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool label="questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="question" pending="asking..." complete={count()} part={props.part}>
          asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool label="skill" pending="loading skill..." complete={props.input.name} part={props.part}>
      "{props.input.name}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics?: Record<string, Record<string, any>[]>; filePath: string }) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use absolute
  return absolute
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  // String values are sanitized via the shared `inlineSafe` helper because
  // this string lands inside a `<text>` node inside a flex container —
  // either InlineTool body or BlockTool header. Multi-line / multi-KB MCP
  // tool args (e.g. `chrome-devtools_evaluate_script`'s `function`) would
  // otherwise wrap to many rows and trip opentui's flex layout-budget
  // freeze. See specs/tui-render-freeze.md.
  return `[${primitives
    .map(([key, value]) => (typeof value === "string" ? `${key}=${inlineSafe(value)}` : `${key}=${value}`))
    .join(", ")}]`
}

// the working sentence for the kinetic busy line — verb + target, all
// lowercase, single-line (inlineSafe), kept short so it never wraps.
function busySentence(part: ToolPart): string {
  const input = ("input" in part.state ? (part.state.input ?? {}) : {}) as Record<string, any>
  const base = (p: unknown) => (typeof p === "string" && p ? path.basename(p) : undefined)
  const pick = (v: unknown, max = 44) => (typeof v === "string" && v ? inlineSafe(v, max) : undefined)
  switch (part.tool) {
    case ShellID.ToolID:
    case "exec_command": {
      const target = pick(input.description)?.toLowerCase() ?? pick(input.command) ?? pick(input.cmd)
      return target ? `running ${target}` : "running a command"
    }
    case "write_stdin":
      return "watching a process"
    case "edit":
      return base(input.filePath) ? `editing ${base(input.filePath)}` : "editing"
    case "apply_patch":
      return "patching"
    case "write":
      return base(input.filePath) ? `writing ${base(input.filePath)}` : "writing"
    case "read":
      return base(input.filePath) ? `reading ${base(input.filePath)}` : "reading"
    case "grep":
      return pick(input.pattern, 32) ? `hunting ${pick(input.pattern, 32)}` : "searching"
    case "glob":
      return "finding files"
    case "webfetch":
      return pick(input.url, 40) ? `fetching ${pick(input.url, 40)}` : "fetching"
    case "websearch":
      return "searching the web"
    case "todowrite":
      return "planning"
    case "question":
      return "asking"
    case "skill":
      return pick(input.name, 32) ? `loading ${pick(input.name, 32)}` : "loading a skill"
    case "task":
      return "delegating"
    default:
      return part.tool.replace(/_/g, " ")
  }
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
