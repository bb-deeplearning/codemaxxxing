import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { createMemo, createSignal, Show } from "solid-js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { win32FlushInputBuffer } from "../win32"
import { getScrollAcceleration } from "../util/scroll"

const FILL = "─".repeat(500)

export function ErrorComponent(props: {
  error: Error
  reset: () => void
  onBeforeExit?: () => Promise<void>
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  const handleExit = async () => {
    await props.onBeforeExit?.()
    renderer.setTerminalTitle("")
    renderer.destroy()
    win32FlushInputBuffer()
    await props.onExit()
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      void handleExit()
    }
  })
  const [copied, setCopied] = createSignal(false)
  const [hover, setHover] = createSignal<"copy" | "reset" | "exit" | null>(null)

  const issueURL = new URL("https://github.com/anomalyco/opencode/issues/new?template=bug-report.yml")

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    border: isLight ? "#cccccc" : "#3a3a3a",
    error: isLight ? "#c0382b" : "#e06c75",
  }

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("opencode-version", InstallationVersion)

  const copyIssueURL = () => {
    void Clipboard.copy(issueURL.toString()).then(() => {
      setCopied(true)
    })
  }

  const stackHeight = createMemo(() => Math.floor(term().height * 0.6))

  return (
    <box flexDirection="column">
      {/* top error rule */}
      <box flexShrink={0} overflow="hidden">
        <text fg={colors.error} wrapMode="none">
          {FILL}
        </text>
      </box>
      {/* header */}
      <box flexDirection="row" gap={1} paddingTop={1} paddingLeft={1} flexShrink={0}>
        <text fg={colors.error}>△</text>
        <text fg={colors.text} attributes={TextAttributes.BOLD}>
          error
        </text>
      </box>
      {/* error message */}
      <box paddingLeft={3} paddingTop={1} flexShrink={0}>
        <text fg={colors.text}>{props.error.message}</text>
      </box>
      {/* stack */}
      <box paddingLeft={3} paddingTop={1} paddingRight={1} flexShrink={1}>
        <scrollbox height={stackHeight()} scrollAcceleration={getScrollAcceleration()}>
          <text fg={colors.muted}>{props.error.stack}</text>
        </scrollbox>
      </box>
      {/* actions divider */}
      <box flexShrink={0} overflow="hidden" paddingTop={1}>
        <text fg={colors.border} wrapMode="none">
          {FILL}
        </text>
      </box>
      {/* actions */}
      <box flexDirection="row" gap={3} paddingTop={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <box onMouseOver={() => setHover("copy")} onMouseOut={() => setHover(null)} onMouseUp={copyIssueURL}>
          <text>
            <span style={{ fg: hover() === "copy" ? colors.text : colors.muted, bold: hover() === "copy" }}>
              {hover() === "copy" ? "▸ " : "  "}copy issue url
            </span>
          </text>
        </box>
        <box onMouseOver={() => setHover("reset")} onMouseOut={() => setHover(null)} onMouseUp={props.reset}>
          <text>
            <span style={{ fg: hover() === "reset" ? colors.text : colors.muted, bold: hover() === "reset" }}>
              {hover() === "reset" ? "▸ " : "  "}reset tui
            </span>
          </text>
        </box>
        <box onMouseOver={() => setHover("exit")} onMouseOut={() => setHover(null)} onMouseUp={() => void handleExit()}>
          <text>
            <span style={{ fg: hover() === "exit" ? colors.text : colors.muted, bold: hover() === "exit" }}>
              {hover() === "exit" ? "▸ " : "  "}exit
            </span>
          </text>
        </box>
        <Show when={copied()}>
          <text fg={colors.muted}>· copied</text>
        </Show>
      </box>
      {/* bottom error rule */}
      <box flexShrink={0} overflow="hidden">
        <text fg={colors.error} wrapMode="none">
          {FILL}
        </text>
      </box>
    </box>
  )
}
