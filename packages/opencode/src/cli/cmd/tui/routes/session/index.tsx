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
const dlog = (msg: string, extra?: Record<string, any>) => {
  if (RENDER_DEBUG && renderLog) renderLog.info(msg, extra)
}
import { useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { SplitBorder, Rule, LabeledRule } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { selectedForeground, useTheme } from "@tui/context/theme"
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
import { SubagentFooter } from "./subagent-footer.tsx"
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
  // Upstream `children()` (root + direct children sorted) — single walk
  // over sync.data.session. Used for the prompt/permission rollup. Most
  // sessions have no subagents, in which case this is the entire chain.
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
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
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
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
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) {
      navigate({
        type: "session",
        sessionID: next.id,
      })
    }
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) {
      navigate({
        type: "session",
        sessionID: sessions[next].id,
      })
    }
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
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
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
                            <Rule color={hover() ? theme.borderActive : theme.border} />
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
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))

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

  // Marginalia counter: nth user message in this session. O(1) lookup
  // against the route-level message_meta cache (single O(N) pass per
  // messages-list change). Previously this re-walked the entire messages
  // list per render — combined with N user messages all doing the same,
  // O(N²) per streaming chunk.
  const userIndex = createMemo(() => ctx.message_meta().user.get(props.message.id) ?? 1)

  return (
    <>
      <Show when={text()}>
        {/* Marginalia 'u·N' as an absolutely-positioned overlay in the
            left gutter — same pattern as AssistantMessage. paddingLeft
            reserves the gutter; the marginalia <text> sits in it via
            position="absolute" so it doesn't participate in flex flow.
            See AssistantMessage for full rationale (flex-row + tall
            content = opentui layout blowup). */}
        <box
          id={props.message.id}
          marginTop={props.index === 0 ? 0 : 1}
          flexShrink={0}
          paddingLeft={5}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={props.onMouseUp}
        >
          <text position="absolute" left={0} top={0} fg={hover() ? theme.text : theme.textMuted}>
            u<span style={{ fg: color() }}>·</span>
            {userIndex()}
          </text>
          <box flexDirection="row" justifyContent="space-between" gap={1}>
            <text fg={theme.text} flexShrink={1} wrapMode="word">
              {text()}
            </text>
            <Show when={queued()}>
              <text flexShrink={0}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> queued </span>
              </text>
            </Show>
            <Show when={!queued() && ctx.showTimestamps()}>
              <text flexShrink={0} fg={theme.textMuted}>
                {Locale.todayTimeOrDateTime(props.message.time.created)}
              </text>
            </Show>
          </box>
          <Show when={files().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => {
                  const bg = createMemo(() => {
                    if (file.mime.startsWith("image/")) return theme.accent
                    if (file.mime === "application/pdf") return theme.primary
                    return theme.secondary
                  })
                  return (
                    <text fg={theme.text}>
                      <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                      <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
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

  // Marginalia counter: nth assistant message in this session. O(1)
  // lookup against the route-level message_meta cache. See UserMessage.
  const assistantIndex = createMemo(() => ctx.message_meta().assistant.get(props.message.id) ?? 1)
  // Only the first assistant message of a turn shows marginalia. Continuation
  // assistants (subsequent tool-call rounds within the same turn) skip it
  // so the gutter doesn't repeat `a·N a·N a·N` down the page.
  const showMarginalia = createMemo(() => ctx.message_meta().first_in_turn.has(props.message.id))

  const agentColor = createMemo(() => local.agent.color(props.message.agent))
  const aborted = createMemo(() => props.message.error?.name === "MessageAbortedError")
  // Memoized so the `<Show>` for "view subagents" hint doesn't re-walk the
  // parts array on every streaming delta. Was previously inline
  // `props.parts.some(...)` → O(P) per delta × N assistant messages mounted.
  const hasTaskTool = createMemo(() => props.parts.some((x) => x.type === "tool" && x.tool === "task"))
  // Memoized error-display predicate. Was inline in the JSX → re-evaluated
  // the error name on every reactive read.
  const hasUserError = createMemo(() => !!props.message.error && props.message.error.name !== "MessageAbortedError")

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
    | { kind: "task" }
    | { kind: "error" }
    | { kind: "summary" }
  const renderable = createMemo<RenderItem[]>(() => {
    const items: RenderItem[] = []
    const parts = props.parts
    for (let i = 0; i < parts.length; i++) {
      items.push({ kind: "part", part: parts[i], last: i === parts.length - 1 })
    }
    if (hasTaskTool()) items.push({ kind: "task" })
    if (hasUserError()) items.push({ kind: "error" })
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
      {/* Marginalia 'a·N' as an absolutely-positioned overlay in the
          left gutter. The outer column gets paddingLeft={5} to reserve
          the gutter; the marginalia <text> is position="absolute" so it
          doesn't participate in flex flow.

          Why not flex-row + fixed-width child: opentui can't lay out a
          flex-row whose body cell contains very tall content (e.g. a
          write tool's syntax-highlighted multi-KB file rendered as
          hundreds of rows). Once that body cell exceeds opentui's
          internal measurement budget the row's layout breaks and every
          subsequent sibling stops painting — visually the render
          "freezes" mid-message and no later message ever appears.
          Absolute positioning sidesteps the flex pass entirely so tall
          children never trigger the layout blowup. */}
      <box paddingLeft={5} flexShrink={0} marginTop={1}>
        <Show when={showMarginalia()}>
          {/* top={1}, not top={0}, because every part component
              (TextPart/ToolPart/ReasoningPart) has its own
              marginTop={1} pushing the first part to internal row 1.
              UserMessage's first child is a row box with no marginTop,
              so it can use top={0}; AssistantMessage's first child is
              always a part-component with leading marginTop, so we
              shift the marginalia down 1 to match. */}
          <text position="absolute" left={0} top={1} fg={theme.textMuted}>
            a<span style={{ fg: agentColor() }}>·</span>
            {assistantIndex()}
          </text>
        </Show>
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
                  <span style={{ fg: theme.textMuted }}>{props.message.modelID}</span>
                  <Show when={duration()}>
                    <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
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

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        paddingLeft={1}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
      >
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={subtleSyntax()}
          content={"_Thinking:_ " + content()}
          conceal={ctx.conceal()}
          fg={theme.textMuted}
        />
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
        <InlineTool label={props.tool} pending="Writing command..." complete={true} part={props.part}>
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
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
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
  spinner?: boolean
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
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={fg()}>
            {props.label} · {props.children}
          </Spinner>
        </Match>
        <Match when={true}>
          <text fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
            <Show fallback={<>{props.pending}</>} when={props.complete}>
              {props.label} · {props.children}
            </Show>
          </text>
        </Match>
      </Switch>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

// Header line builder for BlockTool. Returns a plain string that opentui
// can paint in a single text node — no nested span fan-out per render.
function headerLine(props: { label: string; target?: string }): string {
  return props.target ? `${props.label} · ${props.target}` : props.label
}

function BlockTool(props: {
  label: string
  target?: string
  meta?: JSX.Element
  children?: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))

  // Single fg memo (was two: dotColor + labelFg). Same color was used for
  // both — collapsing eliminates one memo invalidation per hover toggle.
  const headerFg = createMemo(() => (hover() && props.onClick ? theme.text : theme.textMuted))

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
      {/* Header collapsed to a single <text> with inline spans (was 5
          separate text/box children). One reactive read per render
          instead of N. Middle-dot separators are inlined; <Show> guards
          let opentui skip rendering missing slots without splitting the
          row. */}
      <box flexDirection="row" alignItems="center" flexShrink={0} flexWrap="wrap">
        <Show when={props.spinner} fallback={<text fg={headerFg()}>{headerLine(props)}</text>}>
          <Spinner color={headerFg()}>{headerLine(props)}</Spinner>
        </Show>
        <Show when={props.meta}>
          <text fg={headerFg()}>{" · "}</text>
          <text>{props.meta}</text>
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

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          label="shell"
          target={description()}
          part={props.part}
          spinner={isRunning()}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          {/* Verbatim terminal block. Native border-left as the gutter — same
              visual language as the sidebar but without the 240-char string
              that opentui had to lay out, measure, and clip on every render
              of every shell tool in the session. */}
          <box
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.accent}
            paddingLeft={1}
            gap={1}
            flexShrink={0}
          >
            {/* Default char-wrap (no `wrapMode` prop) for both command and
                output — opentui's word-wrap is a per-render width measure
                pass that scales with output size, and shell output streams
                live (each metadata delta extends the string). Char-wrap
                handles long lines fine and matches upstream's behavior. */}
            <text>
              <span style={{ fg: theme.accent, bold: true }}>$ </span>
              <span style={{ fg: theme.text }}>{props.input.command}</span>
            </text>
            <Show when={output()}>
              <text fg={theme.textMuted}>{limited()}</text>
            </Show>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="shell" pending="Writing command..." complete={props.input.command} part={props.part}>
          <span style={{ fg: theme.accent, bold: true }}>$ </span>
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
        <BlockTool label="wrote" target={normalizePath(props.input.filePath!)} part={props.part}>
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
        <InlineTool label="write" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool label="glob" pending="Finding files..." complete={props.input.pattern} part={props.part}>
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
      <InlineTool
        label="read"
        pending="Reading file..."
        complete={props.input.filePath}
        spinner={isRunning()}
        part={props.part}
      >
        {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool label="grep" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool label="webfetch" pending="Fetching from the web..." complete={props.input.url} part={props.part}>
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
          <text fg={theme.textMuted}>Click to collapse</text>
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
          <text fg={theme.textMuted}>Click to view results</text>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="websearch" pending="Searching web..." complete={input.query} part={props.part}>
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
    let content = [`${Locale.titlecase(props.input.subagent_type ?? "General")} Task — ${props.input.description}`]

    if (isRunning() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      label="task"
      spinner={isRunning()}
      complete={props.input.description}
      pending="Delegating..."
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

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

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
          target={normalizePath(props.input.filePath!)}
          meta={
            hasMeta() ? (
              <>
                <Show when={additions() > 0}>
                  <span style={{ fg: theme.diffAdded }}>+{additions()}</span>
                </Show>
                <Show when={additions() > 0 && deletions() > 0}> </Show>
                <Show when={deletions() > 0}>
                  <span style={{ fg: theme.diffRemoved }}>-{deletions()}</span>
                </Show>
              </>
            ) : undefined
          }
          part={props.part}
        >
          <diff
            diff={diffContent()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode={ctx.diffWrapMode()}
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool label="edit" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <diff
        diff={p.diff}
        view={view()}
        filetype={filetype(p.filePath)}
        syntaxStyle={syntax()}
        showLineNumbers={true}
        width="100%"
        wrapMode={ctx.diffWrapMode()}
        fg={theme.text}
        addedBg={theme.diffAddedBg}
        removedBg={theme.diffRemovedBg}
        contextBg={theme.diffContextBg}
        addedSignColor={theme.diffHighlightAdded}
        removedSignColor={theme.diffHighlightRemoved}
        lineNumberFg={theme.diffLineNumber}
        lineNumberBg={theme.diffContextBg}
        addedLineNumberBg={theme.diffAddedLineNumberBg}
        removedLineNumberBg={theme.diffRemovedLineNumberBg}
      />
    )
  }

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
            <BlockTool label={fileLabel(file)} target={fileTarget(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.patch} filePath={file.filePath} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool label="patch" pending="Preparing patch..." complete={false} part={props.part}>
          Patch
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
        <InlineTool label="todos" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
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
        <InlineTool label="question" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool label="skill" pending="Loading skill..." complete={props.input.name} part={props.part}>
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
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
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
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
