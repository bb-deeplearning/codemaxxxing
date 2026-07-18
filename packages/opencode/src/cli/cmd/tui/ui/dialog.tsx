import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, createMemo, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { MouseButton, Renderable, RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Selection from "@tui/util/selection"
import { clampRule, fadeRule, RULE, Spans } from "@tui/ui/glow"
import { inlineSafe } from "@tui/util/inline-safe"

export type DialogSize = "medium" | "large" | "xlarge"

// the afterglow dialog is a floating panel with no box borders — its shape
// is the panel fill (when the theme has one) plus fades and air inside.
export function dialogWidth(size: DialogSize): number {
  if (size === "xlarge") return 116
  if (size === "large") return 88
  return 60
}

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()

  let dismiss = false
  const width = () => dialogWidth(props.size ?? "medium")

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e) => {
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={dimensions().width - 2}
        // surfaces yes, borders no: the panel fill is allowed chrome, but a
        // transparent theme (panel token a === 0) degrades to fades + air.
        backgroundColor={theme.backgroundPanel.a > 0 ? theme.backgroundPanel : undefined}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element
      onClose?: () => void
    }[],
    size: "medium" as "medium" | "large" | "xlarge",
  })

  const renderer = useRenderer()

  useKeyboard((evt) => {
    if (store.stack.length === 0) return
    if (evt.defaultPrevented) return
    if ((evt.name === "escape" || (evt.ctrl && evt.name === "c")) && renderer.getSelection()?.getSelectedText()) return
    if (evt.name === "escape" || (evt.ctrl && evt.name === "c")) {
      if (renderer.getSelection()) {
        renderer.clearSelection()
      }
      const current = store.stack.at(-1)!
      current.onClose?.()
      setStore("stack", store.stack.slice(0, -1))
      evt.preventDefault()
      evt.stopPropagation()
      refocus()
    }
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  return {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", "medium")
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: any, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("size", "medium")
      setStore("stack", [
        {
          element: input,
          onClose,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt) => {
          if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!Selection.copy(renderer, toast)) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={
          !Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? () => Selection.copy(renderer, toast) : undefined
        }
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size}>
            {value.stack.at(-1)!.element}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}

// content cells available inside the standard dialog chrome (2 cols of
// horizontal padding each side), after the panel clamps to the terminal.
// callers clamp their fade rules against this.
export function useDialogInnerWidth(): () => number {
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  return createMemo(() => Math.max(0, Math.min(dialogWidth(dialog.size), dimensions().width - 2) - 4))
}

// the shared dialog head: bold lowercase title in theme.text with a dim
// clickable "esc" whisper at the right edge, over a dissolving rule in the
// dialog's heat color (warning for destructive confirms, primary otherwise).
// no box borders anywhere — structure is fades and air.
export function DialogHeader(props: { title: string; color?: RGBA }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const innerWidth = useDialogInnerWidth()
  const ruleSpans = createMemo(() => fadeRule(theme, props.color ?? theme.primary, clampRule(RULE.ask, innerWidth())))
  return (
    <>
      <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
        <text wrapMode="none" flexShrink={1}>
          <span style={{ fg: theme.text, bold: true }}>{inlineSafe(props.title).toLowerCase()}</span>
        </text>
        <text wrapMode="none" flexShrink={0} fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text wrapMode="none" flexShrink={0} selectable={false}>
        <Spans spans={ruleSpans()} />
      </text>
    </>
  )
}
