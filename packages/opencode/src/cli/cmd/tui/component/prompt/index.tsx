import { BoxRenderable, RGBA, TextareaRenderable, MouseEvent, PasteEvent, decodePasteBytes } from "@opentui/core"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match } from "solid-js"
import "opentui-spinner/solid"
import path from "path"
import { fileURLToPath } from "url"
import { Filesystem } from "@/util/filesystem"
import { useLocal } from "@tui/context/local"
import { tint, useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "@tui/context/editor"
import { MessageID, PartID } from "@/session/schema"
import { createStore, produce, unwrap } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { computePromptTraits } from "./traits"
import { assign } from "./part"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { useExit } from "../../context/exit"
import * as Clipboard from "../../util/clipboard"
import { needsConvert, toJpeg, ConvertError } from "../../util/image-convert"
import type { AssistantMessage, FilePart, UserMessage } from "@opencode-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { SP_FALLBACK } from "../spinner"
import { createTurboColors, createTurboFrames } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn } from "../../util/signal"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { DialogSkill } from "../dialog-skill"
import { DialogWorkspaceCreate, restoreWorkspaceSession } from "../dialog-workspace-create"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { useArgs } from "@tui/context/args"

export type PromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

// Context usage bar. 6-cell width matches the turbo spinner exactly so the
// two are visually balanced when both share the status row (spinner left,
// bar right). Half-height: uses `▄` (LOWER HALF BLOCK) so the bar reads as
// a thin band along the bottom of the row — visually lighter than a full-
// height ▌▎ bar, more present than a single line ─.
//
// Fills RIGHT-TO-LEFT: the filled portion grows from the right edge inward
// as usage rises. Reads as "how much of the limit have I consumed", with
// the right edge being the limit. Empty (unconsumed) capacity sits on the
// left in muted border color.
//
// Single uniform color per render, tier-based:
//   < 70%: theme.textMuted (calm chrome)
//   70-90%: theme.warning  (yellow)
//   > 90%:  theme.error    (red)
//
// Performance:
//   - Single pre-built lookup table (BAR_LINE[N]) shared by filled +
//     unfilled spans. Per-render cost is two array lookups + two spans.
//   - Color is one tier check per pct change (memoized). No interpolation.
const BAR_WIDTH = 6
const BAR_LINE: readonly string[] = Object.freeze(Array.from({ length: BAR_WIDTH + 1 }, (_, i) => "▄".repeat(i)))

function ContextBar(props: { pct: number }) {
  const { theme } = useTheme()
  // Round UP for any non-zero pct so a 1% reading still shows one filled
  // cell — without it the bar would render empty for the entire 0-16%
  // range (6-cell granularity = 16.67% per cell), which is misleading.
  const filled = createMemo(() => {
    if (props.pct <= 0) return 0
    return Math.max(1, Math.min(BAR_WIDTH, Math.ceil((props.pct / 100) * BAR_WIDTH)))
  })
  const fillColor = createMemo(() => {
    if (props.pct > 90) return theme.error
    if (props.pct > 70) return theme.warning
    return theme.textMuted
  })
  return (
    <text wrapMode="none" flexShrink={0}>
      <span style={{ fg: theme.border }}>{BAR_LINE[BAR_WIDTH - filled()]}</span>
      <span style={{ fg: fillColor() }}>{BAR_LINE[filled()]}</span>
    </text>
  )
}

// (Old 8-cell ■/□ UsageMeter removed — usage now renders as plain
// `tokens · pct% · cost` text on the identity row, with ContextBar pinned
// to the right side of the status row, same width as the turbo spinner.)

// Hoisted to module scope: frames are pure data with no theme/runtime
// dependency, so building them per Prompt mount allocated 28 fresh strings
// for nothing. The colour ramp DOES depend on the theme/agent and stays
// per-component.
const TURBO_FRAMES = createTurboFrames()
const TURBO_INTERVAL_MS = 50

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const args = useArgs()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const [editorContextHover, setEditorContextHover] = createSignal(false)
  let lastSubmittedEditorSelectionKey: string | undefined
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  // Lower-cased provider label memoized — the JSX read previously called
  // .toLowerCase() per render, allocating a fresh string each time.
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const currentProviderLabelLower = createMemo(() => currentProviderLabel().toLowerCase())
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  // Usage strip — split into independent primitive memos so a streaming
  // delta only invalidates the field that actually moved (typically tokens
  // and pct; cost only commits on completion). Previously this was a single
  // memo returning a fresh 7-field object → every `<Show when={u().X}>`
  // downstream re-evaluated per delta because object identity changed.
  //
  // Single fold over messages once per delta produces the source primitives.
  // Display formatting then sits behind per-field memos so Locale/money
  // format calls fire only when their input number actually changes.
  const usageSource = createMemo(() => {
    if (!props.sessionID) return undefined
    const list = sync.data.message[props.sessionID]
    if (!list || list.length === 0) return undefined
    let last: AssistantMessage | undefined
    let cost = 0
    for (const item of list) {
      if (item.role !== "assistant") continue
      cost += item.cost
      if (item.tokens.output > 0) last = item
    }
    if (!last) return cost > 0 ? { tokens: 0, model: undefined, cost, providerID: "", modelID: "" } : undefined
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    return { tokens, providerID: last.providerID, modelID: last.modelID, cost, model: undefined as unknown }
  })

  // Token total (number). Equality short-circuits identical values.
  const usageTokens = createMemo(() => usageSource()?.tokens ?? 0)

  // Context limit — only changes when the model changes (rare during a turn).
  const usageLimit = createMemo<number | undefined>(() => {
    const src = usageSource()
    if (!src || !src.providerID) return undefined
    return sync.data.provider.find((p) => p.id === src.providerID)?.models[src.modelID]?.limit.context
  })

  const usagePct = createMemo<number | undefined>(() => {
    const t = usageTokens()
    const limit = usageLimit()
    if (!limit || t <= 0) return undefined
    return Math.round((t / limit) * 100)
  })

  const usageTokensFormatted = createMemo(() => {
    const t = usageTokens()
    return t > 0 ? Locale.number(t) : ""
  })

  // (Old usageContext memo removed — the strip now renders tokens, pct,
  // and cost as separate fields rather than a combined `tokens (pct%)`
  // string. Saves a memo + a `Locale.number()` call per delta.)

  const usageCost = createMemo<string | undefined>(() => {
    const c = usageSource()?.cost ?? 0
    return c > 0 ? money.format(c) : undefined
  })

  const hasUsage = createMemo(() => usageTokens() > 0 || usageCost() !== undefined)

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        // Keep command line --agent if specified.
        if (!args.agent) local.agent.set(msg.agent)
        if (msg.model) {
          local.model.set(msg.model)
          local.model.variant.set(msg.model.variant)
        }
      }
    }
  })

  command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        keybind: "input_submit",
        category: "Prompt",
        hidden: true,
        onSelect: async (dialog) => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        value: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        onSelect: (dialog) => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "Prompt",
        hidden: true,
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
      {
        title: "Skills",
        value: "prompt.skills",
        category: "Prompt",
        slash: {
          name: "skills",
        },
        onSelect: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = computePromptTraits({
      mode: store.mode,
      disabled: !!props.disabled,
      autocompleteVisible: !!auto()?.visible,
    })
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  async function submit() {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (autocomplete?.visible) return false
    if (!store.prompt.input) return false
    const agent = local.agent.current()
    if (!agent) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            dialog.replace(() => (
              <DialogWorkspaceCreate
                onSelect={(nextWorkspaceID) =>
                  restoreWorkspaceSession({
                    dialog,
                    sdk,
                    sync,
                    project,
                    toast,
                    workspaceID: nextWorkspaceID,
                    sessionID: props.sessionID!,
                  })
                }
              />
            ))
          }}
        />
      ))
      return false
    }

    const variant = local.model.variant.current()
    let sessionID = props.sessionID
    if (sessionID == null) {
      const res = await sdk.client.session.create({
        workspace: props.workspaceID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          variant,
        },
      })

      if (res.error) {
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    const messageID = MessageID.ascending()
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const editorSelection = editorContext()
    const currentEditorSelectionKey = editorSelectionKey(editorSelection)
    const editorParts =
      editorSelection && currentEditorSelectionKey !== lastSubmittedEditorSelectionKey
        ? [
            {
              id: PartID.ascending(),
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []

    if (store.mode === "shell") {
      void sdk.client.session.shell({
        sessionID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      void sdk.client.session.command({
        sessionID,
        command: command.slice(1),
        arguments: args,
        agent: agent.name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        messageID,
        variant,
        parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: PartID.ascending(),
            ...x,
          })),
      })
    } else {
      sdk.client.session
        .prompt({
          sessionID,
          ...selectedModel,
          messageID,
          agent: agent.name,
          model: selectedModel,
          variant,
          parts: [
            ...editorParts,
            {
              id: PartID.ascending(),
              type: "text",
              text: inputText,
            },
            ...nonTextParts.map(assign),
          ],
        })
        .catch(() => {})
      lastSubmittedEditorSelectionKey = currentEditorSelectionKey
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    input.clear()
    return true
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    if (needsConvert(file.mime)) {
      try {
        const out = await toJpeg({ mime: file.mime, content: file.content, filename: file.filename })
        file = { ...file, mime: out.mime, content: out.content, filename: out.filename ?? file.filename }
      } catch (err) {
        const msg = err instanceof ConvertError ? err.message : `Failed to convert ${file.mime}`
        toast.show({ message: msg, variant: "error", duration: 5000 })
        return
      }
    }
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.agent.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.agent.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  // borderHighlight = tint of theme.border toward highlight() (which is the
  // state-driven color: agent / shell-mode primary / leader-dim border).
  // Used on the 1-cell ● accent at the start of the textarea so the prompt's
  // affordance carries state.
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  // Turbo spool spinner. Six cells: two braille turbines (compressor +
  // turbine wheel, phase-offset 180°) and a boost gauge that fills as
  // pressure builds. Cycle: idle → smoothstep spool-up → peak with bloom
  // flash → linear bleed off. Rotation speed is proportional to current
  // boost so turbines visibly accelerate under load. ~1.4s per cycle.
  // See ui/spinner.ts createTurboFrames / createTurboColors. Frame strings
  // are hoisted to module scope (TURBO_FRAMES); only the agent-tinted
  // colour ramp recomputes per agent change.
  const sparkColor = createMemo(() => {
    const agent = local.agent.current()
    return agent ? local.agent.color(agent.name) : theme.border
  })
  const turboColors = createMemo(() => createTurboColors(sparkColor()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return "$ shell mode — be careful"
      return `$ ${shell()[store.placeholder % shell().length]}`
    }
    if (!list().length) return "what's the move"
    return list()[store.placeholder % list().length]
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          autocomplete = r
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false}>
        {/* Input row. The ● accent at col 4 absolute (session paddingLeft 2 +
            this paddingLeft 2) is the agent-color state indicator. Single
            character, color is the affordance — replaces the previous
            ▎ thin block which read as a structural rule rather than an
            accent. Textarea content sits immediately after at col 5,
            aligning column-for-column with the message body indent.
            alignItems=flex-start keeps the dot pinned to the first row
            when textarea grows multi-line. */}
        <box paddingLeft={2} paddingRight={0} paddingTop={1} flexShrink={0} flexDirection="row" alignItems="flex-start">
          <text fg={borderHighlight()} flexShrink={0} marginRight={1}>
            ●
          </text>
          <box flexGrow={1} flexShrink={1}>
            <textarea
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={keybind.leader ? theme.textMuted : theme.text}
              focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                syncExtmarksWithPromptParts()
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                // Check clipboard for images before terminal-handled paste runs.
                // This helps terminals that forward Ctrl+V to the app; Windows
                // Terminal 1.25+ usually handles Ctrl+V before this path.
                if (keybind.match("input_paste", e)) {
                  const content = await Clipboard.read()
                  if (content?.mime.startsWith("image/")) {
                    e.preventDefault()
                    await pasteAttachment({
                      filename: "clipboard",
                      mime: content.mime,
                      content: content.data,
                    })
                    return
                  }
                  // If no image, let the default paste behavior continue
                }
                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }
                if (e.name === "!" && input.visualCursor.offset === 0) {
                  setStore("placeholder", randomIndex(shell().length))
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    setStore("mode", "normal")
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("mode", item.mode ?? "normal")
                      restoreExtmarksFromParts(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.cursorOffset = input.plainText.length
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.cursorOffset = input.plainText.length
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  command.trigger("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                const filepath = iife(() => {
                  const raw = pastedContent.replace(/^['"]+|['"]+$/g, "")
                  if (raw.startsWith("file://")) {
                    try {
                      return fileURLToPath(raw)
                    } catch {}
                  }
                  if (process.platform === "win32") return raw
                  return raw.replace(/\\(.)/g, "$1")
                })
                const isUrl = /^(https?):\/\//.test(filepath)
                if (!isUrl) {
                  try {
                    const mime = await Filesystem.mimeType(filepath)
                    const filename = path.basename(filepath)
                    // Handle SVG as raw text content, not as base64 image
                    if (mime === "image/svg+xml") {
                      const content = await Filesystem.readText(filepath).catch(() => {})
                      if (content) {
                        pasteText(content, `[SVG: ${filename ?? "image"}]`)
                        return
                      }
                    }
                    if (mime.startsWith("image/") || mime === "application/pdf") {
                      const content = await Filesystem.readArrayBuffer(filepath)
                        .then((buffer) => Buffer.from(buffer).toString("base64"))
                        .catch(() => {})
                      if (content) {
                        await pasteAttachment({
                          filename,
                          filepath,
                          mime,
                          content,
                        })
                        return
                      }
                    }
                  } catch {}
                }

                const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
                if (
                  (lineCount >= 3 || pastedContent.length > 150) &&
                  kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
                ) {
                  pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
                  return
                }

                input.insertText(normalizedText)

                // Force layout update and render for the pasted content
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.getLayoutNode().markDirty()
                  renderer.requestRender()
                }, 0)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              cursorColor={theme.text}
              syntaxStyle={syntax()}
            />
          </box>
        </box>
        {/* Breathing row between input and identity strip — so the meta below
            doesn't crowd the bottom of the textarea. */}
        <box height={1} flexShrink={0} />
        {/* Identity row. Stable position. agent · model · variant on left,
            meter + cost + plugin slot on right. paddingLeft=3 puts content
            at col 5 absolute (matches message body indent). paddingRight=0
            so it extends to the same right edge as message bodies above.
            Wraps to multiple lines on narrow widths — never hides info. */}
        <box
          paddingLeft={3}
          paddingRight={0}
          flexDirection="row"
          justifyContent="space-between"
          alignItems="flex-start"
          gap={3}
          flexShrink={0}
          flexWrap="wrap"
        >
          <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            <Show when={local.agent.current()} fallback={<text fg={theme.textMuted}>—</text>}>
              {(agent) => (
                <>
                  <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                    {store.mode === "shell" ? "shell" : agent().name}
                  </text>
                  <Show when={store.mode === "normal"}>
                    <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                    <text
                      flexShrink={0}
                      fg={fadeColor(keybind.leader ? theme.textMuted : theme.text, modelMetaAlpha())}
                    >
                      {local.model.parsed().modelID}
                    </text>
                    <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                    <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>{currentProviderLabelLower()}</text>
                    <Show when={showVariant()}>
                      <text fg={fadeColor(theme.textMuted, variantMetaAlpha())}>·</text>
                      <text>
                        <span style={{ fg: fadeColor(theme.warning, variantMetaAlpha()), bold: true }}>
                          {local.model.variant.current()}
                        </span>
                      </text>
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {/* Right side of identity row: token-count · pct · cost. The
                visual bar lives in the row BELOW (where the breathing
                row used to be) so this strip stays a clean text band.
                Spacing is tight (gap={1} + a single ` · ` between
                chunks) — no parentheses around the percentage. */}
            <Show when={hasUsage()}>
              <Show
                when={usageLimit() && usagePct() !== undefined}
                fallback={<text fg={theme.textMuted}>{usageTokensFormatted()}</text>}
              >
                <text fg={theme.textMuted}>
                  {usageTokensFormatted()} <span style={{ fg: theme.textMuted }}>·</span> {usagePct()}%
                </text>
              </Show>
              <Show when={usageCost()}>
                <text fg={theme.textMuted}>
                  <span style={{ fg: theme.textMuted }}>·</span> {usageCost()}
                </text>
              </Show>
            </Show>
            <Show when={hasRightContent()}>
              <box flexDirection="row" gap={1} alignItems="center">
                {props.right}
              </box>
            </Show>
          </box>
        </box>
        {/* Breathing row between identity and status so they read as paired
            but distinct surfaces. The bar moved to the status row's right
            side (next to the turbo spinner) for visual symmetry. */}
        <box height={1} flexShrink={0} />
        {/* Status row. Spark spinner + state on the LEFT when busy/retry,
            keybind hints when idle. Editor file context pinned RIGHT when
            present. Reserves 1 row min so identity above doesn't jump. */}
        <box
          paddingLeft={3}
          paddingRight={0}
          flexDirection="row"
          justifyContent="space-between"
          alignItems="flex-start"
          gap={3}
          flexShrink={0}
          minHeight={1}
          flexWrap="wrap"
        >
          <Show
            when={status().type !== "idle"}
            fallback={
              <Switch>
                <Match when={store.mode === "normal"}>
                  <text fg={theme.border} flexShrink={0}>
                    {keybind.print("agent_cycle")} agents · {keybind.print("command_list")} commands
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.border} flexShrink={0}>
                    esc exit shell mode
                  </text>
                </Match>
              </Switch>
            }
          >
            <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
              <Show when={kv.get("animations_enabled", true)} fallback={<text fg={sparkColor()}>{SP_FALLBACK}</text>}>
                <spinner color={turboColors()} frames={TURBO_FRAMES} interval={TURBO_INTERVAL_MS} />
              </Show>
              <box flexDirection="row" gap={1} flexShrink={0}>
                {(() => {
                  const retry = createMemo(() => {
                    const s = status()
                    if (s.type !== "retry") return
                    return s
                  })
                  const message = createMemo(() => {
                    const r = retry()
                    if (!r) return
                    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                      return "gemini is way too hot right now"
                    if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                    return r.message
                  })
                  const isTruncated = createMemo(() => {
                    const r = retry()
                    if (!r) return false
                    return r.message.length > 120
                  })
                  const [seconds, setSeconds] = createSignal(0)
                  onMount(() => {
                    const timer = setInterval(() => {
                      const next = retry()?.next
                      if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                    }, 1000)

                    onCleanup(() => {
                      clearInterval(timer)
                    })
                  })
                  const handleMessageClick = () => {
                    const r = retry()
                    if (!r) return
                    if (isTruncated()) {
                      void DialogAlert.show(dialog, "Retry Error", r.message)
                    }
                  }

                  const retryText = () => {
                    const r = retry()
                    if (!r) return ""
                    const baseMessage = message()
                    const truncatedHint = isTruncated() ? " (click to expand)" : ""
                    const duration = formatDuration(seconds())
                    const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                    return baseMessage + truncatedHint + retryInfo
                  }

                  return (
                    <Show when={retry()}>
                      <box onMouseUp={handleMessageClick}>
                        <text fg={theme.error}>{retryText()}</text>
                      </box>
                    </Show>
                  )
                })()}
              </box>
              <text>
                <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.text }}>esc</span>
                <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                  {store.interrupt > 0 ? " again to interrupt" : " interrupt"}
                </span>
              </text>
            </box>
          </Show>
          <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
            <Show when={editorFileLabelDisplay()}>
              {(file) => (
                <text
                  fg={theme.secondary}
                  onMouseOver={() => setEditorContextHover(true)}
                  onMouseOut={() => setEditorContextHover(false)}
                  onMouseUp={dismissEditorContext}
                >
                  {editorContextHover() ? `x ${file()}` : file()}
                </text>
              )}
            </Show>
            {/* Context bar pinned RIGHT, same row + width as the turbo
                spinner (6 cells + brackets) for visual symmetry. Hidden
                if no usage data (no model bound or no context limit
                known). */}
            <Show when={hasUsage() && usageLimit() && usagePct() !== undefined}>
              <ContextBar pct={usagePct()!} />
            </Show>
          </box>
        </box>
      </box>
    </>
  )
}
