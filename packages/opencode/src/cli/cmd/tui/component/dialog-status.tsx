import { TextAttributes, type RGBA } from "@opentui/core"
import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { For, Match, Switch, Show, createMemo, type JSX } from "solid-js"
import { Rule } from "./border"

// Tracked small caps section header. Spaces between letters convey
// hierarchy without pulling weight into the chrome.
function tracked(label: string) {
  return label.split("").join(" ")
}

function Section(props: { label: string; count: number; empty?: string; children?: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>{tracked(props.label)}</text>
        <text fg={theme.text}>{String(props.count)}</text>
      </box>
      <Show
        when={props.count > 0}
        fallback={
          <Show when={props.empty}>
            <box paddingTop={1}>
              <text fg={theme.textMuted}>{props.empty}</text>
            </box>
          </Show>
        }
      >
        <box paddingTop={1} gap={0}>
          {props.children}
        </box>
      </Show>
    </box>
  )
}

function Row(props: { label: JSX.Element; value: JSX.Element; valueFg?: RGBA }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <box flexShrink={1} overflow="hidden">
        <text fg={theme.text} wrapMode="none">
          {props.label}
        </text>
      </box>
      <box flexShrink={0}>
        <text fg={props.valueFg ?? theme.textMuted}>{props.value}</text>
      </box>
    </box>
  )
}

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp))

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <Rule color={theme.borderActive} />
      </box>
      <box paddingLeft={3} paddingRight={3} paddingBottom={1}>
        <Section label="m c p" count={mcpEntries().length} empty="no mcp servers">
          <For each={mcpEntries()}>
            {([key, item]) => {
              const fg = (
                {
                  connected: theme.success,
                  failed: theme.error,
                  disabled: theme.textMuted,
                  needs_auth: theme.warning,
                  needs_client_registration: theme.error,
                } as Record<string, typeof theme.success>
              )[item.status]
              return (
                <Row
                  label={
                    <>
                      <span style={{ fg: theme.text, bold: true }}>{key}</span>
                      <span style={{ fg: theme.textMuted }}>
                        {"  "}
                        <Switch fallback={item.status}>
                          <Match when={item.status === "connected"}>connected</Match>
                          <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                          <Match when={item.status === "disabled"}>disabled in configuration</Match>
                          <Match when={(item.status as string) === "needs_auth"}>
                            needs authentication (run: opencode mcp auth {key})
                          </Match>
                          <Match when={(item.status as string) === "needs_client_registration" && item}>
                            {(val) => (val() as { error: string }).error}
                          </Match>
                        </Switch>
                      </span>
                    </>
                  }
                  value={item.status}
                  valueFg={fg}
                />
              )
            }}
          </For>
        </Section>
        <Section label="l s p" count={sync.data.lsp.length} empty="no lsp servers">
          <For each={sync.data.lsp}>
            {(item) => {
              const fg = ({ connected: theme.success, error: theme.error } as Record<string, typeof theme.success>)[
                item.status
              ]
              return (
                <Row
                  label={
                    <>
                      <span style={{ fg: theme.text, bold: true }}>{item.id}</span>
                      <span style={{ fg: theme.textMuted }}>{"  " + item.root}</span>
                    </>
                  }
                  value={item.status}
                  valueFg={fg}
                />
              )
            }}
          </For>
        </Section>
        <Section label="f o r m a t t e r s" count={enabledFormatters().length} empty="no formatters">
          <For each={enabledFormatters()}>
            {(item) => (
              <Row
                label={<span style={{ fg: theme.text, bold: true }}>{item.name}</span>}
                value="enabled"
                valueFg={theme.success}
              />
            )}
          </For>
        </Section>
        <Section label="p l u g i n s" count={plugins().length} empty="no plugins">
          <For each={plugins()}>
            {(item) => (
              <Row
                label={<span style={{ fg: theme.text, bold: true }}>{item.name}</span>}
                value={item.version ? `@${item.version}` : "loaded"}
                valueFg={item.version ? theme.textMuted : theme.success}
              />
            )}
          </For>
        </Section>
      </box>
      <Rule color={theme.borderActive} />
      <box
        flexDirection="row"
        justifyContent="flex-end"
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={theme.text}>
          esc <span style={{ fg: theme.textMuted }}>close</span>
        </text>
      </box>
    </box>
  )
}
