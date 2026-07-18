import { createStore } from "solid-js/store"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { RGBA, TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useProject } from "../../context/project"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { Keybind } from "@/util/keybind"
import { inlineSafe } from "../../util/inline-safe"
import { Global } from "@opencode-ai/core/global"
import { ShellID } from "@/tool/shell/id"
import { useDialog } from "../../ui/dialog"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../context/tui-config"
import { clampRule, fadeRule, RULE, Spans, type GlowSpan } from "@tui/ui/glow"

type PermissionStage = "permission" | "always" | "reject"

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = Global.Path.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use ~ or absolute
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => (props.request.metadata?.filepath as string) ?? "")
  const diff = createMemo(() => (props.request.metadata?.diff as string) ?? "")

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
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
        </scrollbox>
      </Show>
      <Show when={!diff()}>
        <text fg={theme.textMuted}>no diff provided</text>
      </Show>
    </box>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest }) {
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  // the tool speaking for this ask, dug out of the same tool part as
  // input() — titles like "read wants to leave the project" need it.
  const toolName = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return undefined
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID) return part.tool
    }
    return undefined
  })

  const { theme } = useTheme()

  const reject = () => {
    if (session()?.parentID) {
      setStore("stage", "reject")
      return
    }
    void sdk.client.permission.reply({
      reply: "reject",
      requestID: props.request.id,
      workspace: project.workspace.current(),
    })
  }

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <AlwaysAsk
          request={props.request}
          onConfirm={() => {
            setStore("stage", "permission")
            void sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
              workspace: project.workspace.current(),
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            void sdk.client.permission.reply({
              reply: "reject",
              requestID: props.request.id,
              message: message || undefined,
              workspace: project.workspace.current(),
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const info = () => {
            const permission = props.request.permission
            const data = input()

            if (permission === "edit") {
              const raw = props.request.metadata?.filepath
              const filepath = typeof raw === "string" ? raw : ""
              const base = filepath ? path.basename(filepath) : ""
              return {
                title: base ? `edit wants to change ${base}` : "edit wants to change a file",
                body: <EditBody request={props.request} />,
              }
            }

            if (permission === "read") {
              const raw = data.filePath
              const filePath = typeof raw === "string" ? raw : ""
              const base = filePath ? path.basename(filePath) : ""
              return {
                title: base ? `read wants to open ${base}` : "read wants to open a file",
                body: (
                  <Show when={filePath}>
                    <text fg={theme.textMuted}>
                      <span style={{ fg: theme.textMuted }}>path</span>{" "}
                      <span style={{ fg: theme.text }}>{normalizePath(filePath)}</span>
                    </text>
                  </Show>
                ),
              }
            }

            if (permission === "glob") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                title: "glob wants to search",
                body: (
                  <Show when={pattern}>
                    <text fg={theme.textMuted}>
                      <span style={{ fg: theme.textMuted }}>pattern</span>{" "}
                      <span style={{ fg: theme.text }}>{pattern}</span>
                    </text>
                  </Show>
                ),
              }
            }

            if (permission === "grep") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                title: "grep wants to search",
                body: (
                  <Show when={pattern}>
                    <text fg={theme.textMuted}>
                      <span style={{ fg: theme.textMuted }}>pattern</span>{" "}
                      <span style={{ fg: theme.text }}>{pattern}</span>
                    </text>
                  </Show>
                ),
              }
            }

            if (permission === "list") {
              const raw = data.path
              const dir = typeof raw === "string" ? raw : ""
              return {
                title: dir ? `list wants to browse ${normalizePath(dir)}` : "list wants to browse",
                body: (
                  <Show when={dir}>
                    <text fg={theme.textMuted}>
                      <span style={{ fg: theme.textMuted }}>path</span>{" "}
                      <span style={{ fg: theme.text }}>{normalizePath(dir)}</span>
                    </text>
                  </Show>
                ),
              }
            }

            if (permission === ShellID.ToolID) {
              const description = typeof data.description === "string" && data.description ? data.description : ""
              // the bash permission key is shared by the whole SHELL_TOOLS
              // group (GOTCHAS: permission-key-collapse…) — legacy shell
              // passes `command`, codex-parity exec_command passes `cmd`.
              const command =
                typeof data.command === "string" ? data.command : typeof data.cmd === "string" ? data.cmd : ""
              return {
                title: "bash wants to run",
                body: (
                  <>
                    <Show when={command}>
                      <text fg={theme.text}>{command}</text>
                    </Show>
                    <Show when={description}>
                      <text fg={theme.textMuted}>{description}</text>
                    </Show>
                  </>
                ),
              }
            }

            if (permission === "task") {
              const type = typeof data.subagent_type === "string" ? data.subagent_type : ""
              const desc = typeof data.description === "string" ? data.description : ""
              return {
                title: type ? `task wants to spawn ${type.toLowerCase()}` : "task wants to spawn an agent",
                body: (
                  <Show when={desc}>
                    <text fg={theme.text}>{desc}</text>
                  </Show>
                ),
              }
            }

            if (permission === "webfetch") {
              const url = typeof data.url === "string" ? data.url : ""
              const host = (() => {
                if (!url) return ""
                try {
                  return new URL(url).host
                } catch {
                  return ""
                }
              })()
              return {
                title: host ? `webfetch wants to load ${host}` : "webfetch wants to load a url",
                body: (
                  <Show when={url}>
                    <text fg={theme.textMuted}>
                      <span style={{ fg: theme.textMuted }}>url</span> <span style={{ fg: theme.text }}>{url}</span>
                    </text>
                  </Show>
                ),
              }
            }

            if (permission === "websearch") {
              const query = typeof data.query === "string" ? data.query : ""
              return {
                title: "websearch wants to search",
                body: (
                  <Show when={query}>
                    <text fg={theme.textMuted}>
                      <span style={{ fg: theme.textMuted }}>query</span> <span style={{ fg: theme.text }}>{query}</span>
                    </text>
                  </Show>
                ),
              }
            }

            if (permission === "external_directory") {
              const meta = props.request.metadata ?? {}
              const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
              const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
              const pattern = props.request.patterns?.[0]
              const derived =
                typeof pattern === "string" ? (pattern.includes("*") ? path.dirname(pattern) : pattern) : undefined

              const raw = parent ?? filepath ?? derived
              const dir = normalizePath(raw)
              const patterns = (props.request.patterns ?? []).filter((p): p is string => typeof p === "string")

              return {
                title: `${toolName() ?? "a tool"} wants to leave the project`,
                body: (
                  <>
                    <Show when={dir}>
                      <text fg={theme.textMuted}>
                        <span style={{ fg: theme.textMuted }}>directory</span>{" "}
                        <span style={{ fg: theme.text }}>{dir}</span>
                      </text>
                    </Show>
                    <Show when={patterns.length > 0}>
                      <box gap={1}>
                        <text fg={theme.textMuted}>patterns</text>
                        <box>
                          <For each={patterns}>{(p) => <text fg={theme.text}>{p}</text>}</For>
                        </box>
                      </box>
                    </Show>
                  </>
                ),
              }
            }

            if (permission === "doom_loop") {
              return {
                title: "doom loop detected",
                body: <text fg={theme.textMuted}>this keeps the session running despite repeated failures.</text>,
              }
            }

            return {
              title: `${permission} wants to run`,
              body: (
                <text fg={theme.textMuted}>
                  <span style={{ fg: theme.textMuted }}>tool</span> <span style={{ fg: theme.text }}>{permission}</span>
                </text>
              ),
            }
          }

          const current = info()

          return (
            <PermissionAsk
              title={current.title}
              body={current.body}
              onOnce={() => {
                void sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                  workspace: project.workspace.current(),
                })
              }}
              onAlways={() => setStore("stage", "always")}
              onReject={reject}
            />
          )
        })()}
      </Match>
    </Switch>
  )
}

// the shared ask chrome, per the asksD frame (design/deck/frames/glow.ts:137-140):
// air → bold title in the heat color → dissolving rule → body at +2 → keyed
// action line. no borders, no glyphs — structure is made of fades.
function AskLayout(props: {
  title: string
  color: RGBA
  body?: JSX.Element
  actions: GlowSpan[]
  expanded?: boolean
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  // RULE.ask wide, clamped to the room left inside the route's 4 cols of
  // horizontal padding. rebuilt only when width or theme moves.
  const ruleSpans = createMemo(() => fadeRule(theme, props.color, clampRule(RULE.ask, dimensions().width - 4)))

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      {...(props.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" as const }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative" as const,
          })}
    >
      {/* air above the title instead of a rule */}
      <box height={1} flexShrink={0} />
      <text flexShrink={0}>
        <span style={{ fg: props.color, bold: true }}>{inlineSafe(props.title)}</span>
      </text>
      <text wrapMode="none" flexShrink={0} selectable={false}>
        <Spans spans={ruleSpans()} />
      </text>
      <box paddingLeft={2} flexGrow={1} flexShrink={1}>
        {props.body}
      </box>
      <text wrapMode="none" flexShrink={0}>
        <Spans spans={props.actions} />
      </text>
      {/* air below the ask so the keyed line never sits on the bottom
          edge's rule — loud objects breathe (spec: air is structure). */}
      <box height={1} flexShrink={0} />
    </box>
  )
}

// stage "permission" — direct keys instead of option cycling: enter allows
// once, a opens the always flow, d (or esc) opens the reject flow, ctrl+f
// toggles the fullscreen diff.
function PermissionAsk(props: {
  title: string
  body: JSX.Element
  onOnce: () => void
  onAlways: () => void
  onReject: () => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dialog = useDialog()
  const diffKey = Keybind.parse("ctrl+f")[0]
  const [store, setStore] = createStore({ expanded: false })

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (evt.name === "return") {
      evt.preventDefault()
      props.onOnce()
      return
    }
    if (evt.name === "a" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      props.onAlways()
      return
    }
    if (evt.name === "d" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      props.onReject()
      return
    }
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onReject()
      return
    }
    if (diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const actions = createMemo<GlowSpan[]>(() => [
    { text: "enter", fg: theme.success, bold: true },
    { text: " yes · ", fg: theme.textMuted },
    { text: "a", fg: theme.info, bold: true },
    { text: " always · ", fg: theme.textMuted },
    { text: "d", fg: theme.error, bold: true },
    { text: " no", fg: theme.textMuted },
    { text: store.expanded ? " · ctrl+f minimize" : " · ctrl+f expand", fg: theme.textMuted },
  ])

  const content = () => (
    <AskLayout
      title={props.title}
      color={theme.warning}
      body={props.body}
      actions={actions()}
      expanded={store.expanded}
    />
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}

// stage "always" — confirm the pattern grant.
function AlwaysAsk(props: { request: PermissionRequest; onConfirm: () => void; onCancel: () => void }) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (evt.name === "return") {
      evt.preventDefault()
      props.onConfirm()
      return
    }
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onCancel()
    }
  })

  const actions = createMemo<GlowSpan[]>(() => [
    { text: "enter", fg: theme.success, bold: true },
    { text: " confirm · ", fg: theme.textMuted },
    { text: "esc", fg: theme.error, bold: true },
    { text: " cancel", fg: theme.textMuted },
  ])

  return (
    <AskLayout
      title="always allow"
      color={theme.warning}
      body={
        <Switch>
          <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
            <text fg={theme.textMuted}>
              this will allow {props.request.permission} until opencode is restarted.
            </text>
          </Match>
          <Match when={true}>
            <text fg={theme.textMuted}>allows these patterns until opencode is restarted</text>
            <For each={props.request.always}>{(pattern) => <text fg={theme.textMuted}>{pattern}</text>}</For>
          </Match>
        </Switch>
      }
      actions={actions()}
    />
  )
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const keybind = useKeybind()
  const textareaKeybindings = useTextareaKeybindings()
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      props.onConfirm(input.plainText)
    }
  })

  const actions = createMemo<GlowSpan[]>(() => [
    { text: "enter", fg: theme.success, bold: true },
    { text: " send · ", fg: theme.textMuted },
    { text: "esc", fg: theme.error, bold: true },
    { text: " cancel", fg: theme.textMuted },
  ])

  return (
    <AskLayout
      title="reject — say why"
      color={theme.error}
      body={
        <textarea
          ref={(val: TextareaRenderable) => {
            input = val
            val.traits = { status: "REJECT" }
          }}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          keyBindings={textareaKeybindings()}
        />
      }
      actions={actions()}
    />
  )
}
