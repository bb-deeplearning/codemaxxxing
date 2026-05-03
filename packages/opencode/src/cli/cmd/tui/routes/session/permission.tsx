import { createStore } from "solid-js/store"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { LabeledRule, Rule } from "../../component/border"
import { useSync } from "../../context/sync"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useProject } from "../../context/project"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { Keybind } from "@/util/keybind"
import { Locale } from "@/util/locale"
import { Global } from "@opencode-ai/core/global"
import { ShellID } from "@/tool/shell/id"
import { useDialog } from "../../ui/dialog"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../context/tui-config"

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

function TextBody(props: { title: string; description?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <text fg={theme.textMuted}>{props.title}</text>
      <Show when={props.description}>
        <text fg={theme.text}>{props.description}</text>
      </Show>
    </>
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

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="always allow"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={"this will allow " + props.request.permission + " until opencode is restarted."} />
              </Match>
              <Match when={true}>
                <box gap={1}>
                  <text fg={theme.textMuted}>this will allow the following patterns until opencode is restarted</text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.text}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "confirm", cancel: "cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            void sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
              workspace: project.workspace.current(),
            })
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
              return {
                label: "edit",
                target: normalizePath(filepath),
                body: <EditBody request={props.request} />,
              }
            }

            if (permission === "read") {
              const raw = data.filePath
              const filePath = typeof raw === "string" ? raw : ""
              return {
                label: "read",
                target: normalizePath(filePath),
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
                label: "glob",
                target: pattern,
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
                label: "grep",
                target: pattern,
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
                label: "list",
                target: normalizePath(dir),
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
              const description =
                typeof data.description === "string" && data.description ? data.description : "shell command"
              const command = typeof data.command === "string" ? data.command : ""
              return {
                label: "shell",
                target: description,
                body: (
                  <Show when={command}>
                    <text fg={theme.text}>$ {command}</text>
                  </Show>
                ),
              }
            }

            if (permission === "task") {
              const type = typeof data.subagent_type === "string" ? data.subagent_type : "unknown"
              const desc = typeof data.description === "string" ? data.description : ""
              return {
                label: "task",
                target: Locale.titlecase(type),
                body: (
                  <Show when={desc}>
                    <text fg={theme.text}>{desc}</text>
                  </Show>
                ),
              }
            }

            if (permission === "webfetch") {
              const url = typeof data.url === "string" ? data.url : ""
              return {
                label: "webfetch",
                target: url,
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
                label: "websearch",
                target: query,
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
                label: "external_directory",
                target: dir,
                body: (
                  <Show when={patterns.length > 0}>
                    <box gap={1}>
                      <text fg={theme.textMuted}>patterns</text>
                      <box>
                        <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
                      </box>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "doom_loop") {
              return {
                label: "doom_loop",
                target: "continue after repeated failures",
                body: <text fg={theme.textMuted}>this keeps the session running despite repeated failures.</text>,
              }
            }

            return {
              label: "tool",
              target: permission,
              body: (
                <text fg={theme.textMuted}>
                  <span style={{ fg: theme.textMuted }}>tool</span> <span style={{ fg: theme.text }}>{permission}</span>
                </text>
              ),
            }
          }

          const current = info()

          const header = () => (
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg={theme.warning}>{"△"}</text>
              <text fg={theme.text}>permission required</text>
            </box>
          )

          return (
            <Prompt
              title="permission required"
              header={header()}
              targetLabel={current.label}
              targetValue={current.target}
              body={current.body}
              options={{ once: "allow once", always: "allow always", reject: "reject" }}
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  void sdk.client.permission.reply({
                    reply: "reject",
                    requestID: props.request.id,
                    workspace: project.workspace.current(),
                  })
                  return
                }
                void sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                  workspace: project.workspace.current(),
                })
              }}
            />
          )
        })()}
      </Match>
    </Switch>
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

  return (
    <box flexDirection="column" flexShrink={0}>
      <Rule color={theme.error} />
      <box paddingTop={1} paddingLeft={1} paddingRight={1} paddingBottom={1} gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>reject permission</text>
        </box>
        <box paddingLeft={3}>
          <text fg={theme.textMuted}>tell opencode what to do differently</text>
        </box>
        <box paddingLeft={3} paddingTop={1}>
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
        </box>
      </box>
      <LabeledRule
        color={theme.error}
        right={
          <box flexDirection="row" gap={2} flexShrink={0}>
            <text>
              <span style={{ fg: theme.text }}>enter</span> <span style={{ fg: theme.textMuted }}>confirm</span>
            </text>
            <text>
              <span style={{ fg: theme.text }}>esc</span> <span style={{ fg: theme.textMuted }}>cancel</span>
            </text>
          </box>
        }
      />
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  header?: JSX.Element
  targetLabel?: string
  targetValue?: string
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const diffKey = Keybind.parse("ctrl+f")[0]
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (evt.name === "left" || evt.name == "h") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx - 1 + keys.length) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "right" || evt.name == "l") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx + 1) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      props.onSelect(store.selected)
    }

    if (props.escapeKey && (evt.name === "escape" || keybind.match("app_exit", evt))) {
      evt.preventDefault()
      props.onSelect(props.escapeKey)
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))
  useRenderer()

  const content = () => (
    <box
      flexDirection="column"
      flexShrink={0}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      {/* top interruption rule */}
      <Rule color={theme.warning} />
      <box paddingTop={1} paddingLeft={1} paddingRight={1} flexGrow={1} gap={1}>
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg={theme.warning}>{"△"}</text>
              <text fg={theme.text}>{props.title}</text>
            </box>
          }
        >
          {props.header}
        </Show>
        <Show when={props.targetLabel}>
          <LabeledRule
            color={theme.border}
            left={<text fg={theme.textMuted}>{props.targetLabel}</text>}
            right={<Show when={props.targetValue}>{(t) => <text fg={theme.text}>{t()}</text>}</Show>}
          />
        </Show>
        <box paddingLeft={3} flexGrow={1} flexShrink={1} gap={1}>
          {props.body}
        </box>
      </box>
      {/* bottom interruption rule + actions */}
      <LabeledRule
        color={theme.warning}
        right={
          <box flexDirection="row" gap={2} flexShrink={0}>
            <For each={keys}>
              {(option) => (
                <box
                  onMouseOver={() => setStore("selected", option)}
                  onMouseUp={() => {
                    setStore("selected", option)
                    props.onSelect(option)
                  }}
                >
                  <text>
                    <span
                      style={{
                        fg: option === store.selected ? theme.warning : theme.textMuted,
                        bold: option === store.selected,
                      }}
                    >
                      {option === store.selected ? "▸ " : "  "}
                      {props.options[option]}
                    </span>
                  </text>
                </box>
              )}
            </For>
            <text fg={theme.border}>│</text>
            <Show when={props.fullscreen}>
              <text>
                <span style={{ fg: theme.text }}>ctrl+f</span> <span style={{ fg: theme.textMuted }}>{hint()}</span>
              </text>
            </Show>
            <text>
              <span style={{ fg: theme.text }}>←→</span> <span style={{ fg: theme.textMuted }}>select</span>
            </text>
            <text>
              <span style={{ fg: theme.text }}>enter</span> <span style={{ fg: theme.textMuted }}>confirm</span>
            </text>
          </box>
        }
      />
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
