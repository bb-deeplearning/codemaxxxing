import { InputRenderable, type RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, For, Show, type JSX, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { DialogHeader, useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { Keybind } from "@/util/keybind"
import { Locale } from "@/util/locale"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../context/tui-config"
import { sinkColor, Spans, type GlowSpan } from "@tui/ui/glow"

export interface DialogSelectProps<T> {
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  flat?: boolean
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  keybind?: {
    keybind?: Keybind.Info
    title: string
    side?: "left" | "right"
    disabled?: boolean
    onTrigger: (option: DialogSelectOption<T>) => void
  }[]
  current?: T
  // verb for the enter key in the hint whisper — "run" for the palette,
  // "select" everywhere else. presentation only.
  selectLabel?: string
}

export interface DialogSelectOption<T = any> {
  title: string
  value: T
  description?: string
  footer?: JSX.Element | string
  category?: string
  categoryView?: JSX.Element
  disabled?: boolean
  bg?: RGBA
  gutter?: () => JSX.Element
  margin?: JSX.Element
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
  })

  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
          }
        }
      },
    ),
  )

  let input: InputRenderable

  const filtered = createMemo(() => {
    if (props.skipFilter) return props.options.filter((x) => x.disabled !== true)
    const needle = store.filter.toLowerCase()
    const options = pipe(
      props.options,
      filter((x) => x.disabled !== true),
    )
    if (!needle) return options

    // prioritize title matches (weight: 2) over category matches (weight: 1).
    // users typically search by the item name, and not its category.
    const result = fuzzysort
      .go(needle, options, {
        keys: ["title", "category"],
        scoreFn: (r) => r[0].score * 2 + r[1].score,
      })
      .map((x) => x.obj)

    return result
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard
  // that the mouseover event doesn't trigger when filtering.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
  })

  const flatten = createMemo(() => props.flat && store.filter.length > 0)

  const grouped = createMemo<[string, DialogSelectOption<T>[]][]>(() => {
    if (flatten()) return [["", filtered()]]
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
    )
    return result
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const rows = createMemo(() => {
    // Each non-empty category contributes: label row (+ leading blank when
    // not first). no rules inside the list — structure is air.
    const headers = grouped().reduce((acc, [category], i) => {
      if (!category) return acc
      return acc + (i > 0 ? 2 : 1)
    }, 0)
    return flat().length + headers
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => Math.min(rows(), Math.floor(dimensions().height / 2) - 6))

  const selected = createMemo(() => flat()[store.selected])

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true)
        } else if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            moveTo(currentIndex, true)
          }
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = flat().length - 1
    if (next >= flat().length) next = 0
    moveTo(next, true)
  }

  function moveTo(next: number, center = false) {
    setStore("selected", next)
    const option = selected()
    if (option) props.onMove?.(option)
    if (!scroll) return
    const target = scroll.getChildren().find((child) => {
      return child.id === JSON.stringify(selected()?.value)
    })
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
    } else {
      if (y >= scroll.height) {
        scroll.scrollBy(y - scroll.height + 1)
      }
      if (y < 0) {
        scroll.scrollBy(y)
        if (isDeepEqual(flat()[0].value, selected()?.value)) {
          scroll.scrollTo(0)
        }
      }
    }
  }

  const keybind = useKeybind()
  useKeyboard((evt) => {
    setStore("input", "keyboard")

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "home") moveTo(0)
    if (evt.name === "end") moveTo(flat().length - 1)

    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        if (option.onSelect) option.onSelect(dialog)
        props.onSelect?.(option)
      }
    }

    for (const item of props.keybind ?? []) {
      if (item.disabled || !item.keybind) continue
      if (Keybind.match(item.keybind, keybind.parse(evt))) {
        const s = selected()
        if (s) {
          evt.preventDefault()
          item.onTrigger(s)
        }
      }
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
  }
  props.ref?.(ref)

  const keybinds = createMemo(() => props.keybind?.filter((x) => !x.disabled && x.keybind) ?? [])
  const left = createMemo(() => keybinds().filter((item) => item.side !== "right"))
  const right = createMemo(() => keybinds().filter((item) => item.side === "right"))

  // the closing hint whisper: keys in theme.text, labels muted, " · "
  // separators. arrows are keyboard words, not status glyphs. memoized —
  // rebuilt only when the theme or the keybind set moves.
  const hintSpans = createMemo<GlowSpan[]>(() => {
    const spans: GlowSpan[] = [
      { text: "↑↓", fg: theme.text },
      { text: " move · ", fg: theme.textMuted },
      { text: "enter", fg: theme.text },
      { text: ` ${props.selectLabel ?? "select"} · `, fg: theme.textMuted },
      { text: "esc", fg: theme.text },
      { text: " close", fg: theme.textMuted },
    ]
    for (const item of left()) {
      spans.push({ text: " · ", fg: theme.textMuted })
      spans.push({ text: Keybind.toString(item.keybind!), fg: theme.text })
      spans.push({ text: ` ${item.title.toLowerCase()}`, fg: theme.textMuted })
    }
    return spans
  })
  const rightHintSpans = createMemo<GlowSpan[]>(() =>
    right().flatMap((item, i): GlowSpan[] => [
      ...(i > 0 ? [{ text: " · ", fg: theme.textMuted }] : []),
      { text: Keybind.toString(item.keybind!), fg: theme.text },
      { text: ` ${item.title.toLowerCase()}`, fg: theme.textMuted },
    ]),
  )

  return (
    <box paddingTop={1} paddingBottom={1}>
      {/* title block: bold lowercase title over a dissolving rule, search
          input directly under — the head of the dialog. */}
      <box paddingLeft={2} paddingRight={2} flexShrink={0}>
        <DialogHeader title={props.title} />
      </box>
      <box paddingLeft={2} paddingRight={2} flexShrink={0}>
        <input
          onInput={(e) => {
            batch(() => {
              setStore("filter", e)
              props.onFilter?.(e)
            })
          }}
          cursorColor={theme.primary}
          textColor={theme.text}
          focusedTextColor={theme.text}
          ref={(r) => {
            input = r
            input.traits = { status: "FILTER" }
            setTimeout(() => {
              if (!input) return
              if (input.isDestroyed) return
              input.focus()
            }, 1)
          }}
          placeholder={props.placeholder ?? "search"}
          placeholderColor={theme.textMuted}
        />
      </box>
      {/* air between the head and the list */}
      <box height={1} flexShrink={0} />
      <Show
        when={grouped().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={2}>
            <text fg={theme.textMuted}>no results</text>
          </box>
        }
      >
        <scrollbox
          scrollbarOptions={{ visible: false }}
          scrollAcceleration={scrollAcceleration()}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={grouped()}>
            {([category, options], index) => (
              <>
                <Show when={category}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={2} paddingRight={2}>
                    <Show
                      when={options[0]?.categoryView}
                      fallback={<text fg={sinkColor(theme, 1)}>{category.toLowerCase()}</text>}
                    >
                      {options[0]?.categoryView}
                    </Show>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => {
                    const active = createMemo(() => isDeepEqual(option.value, selected()?.value))
                    const current = createMemo(() => isDeepEqual(option.value, props.current))
                    return (
                      <box
                        id={JSON.stringify(option.value)}
                        flexDirection="row"
                        position="relative"
                        onMouseMove={() => {
                          setStore("input", "mouse")
                        }}
                        onMouseUp={() => {
                          option.onSelect?.(dialog)
                          props.onSelect?.(option)
                        }}
                        onMouseOver={() => {
                          if (store.input !== "mouse") return
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        onMouseDown={() => {
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        // selection without glyphs: the selected row is bold
                        // theme.text on a backgroundElement lift when the theme
                        // has one; transparent themes rely on bold alone.
                        // option.bg (e.g. an armed delete) wins regardless —
                        // failures burn.
                        backgroundColor={
                          active()
                            ? (option.bg ?? (theme.backgroundElement.a > 0 ? theme.backgroundElement : undefined))
                            : undefined
                        }
                        paddingLeft={4}
                        paddingRight={2}
                        gap={1}
                      >
                        <Show when={!current() && option.margin}>
                          <box position="absolute" left={1} flexShrink={0}>
                            {option.margin}
                          </box>
                        </Show>
                        <Option
                          title={option.title}
                          footer={flatten() ? (option.category ?? option.footer) : option.footer}
                          description={option.description !== category ? option.description : undefined}
                          active={active()}
                          current={current()}
                          gutter={option.gutter}
                        />
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      {/* air between the list and the hint whisper */}
      <box height={1} flexShrink={0} />
      <box
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        justifyContent="space-between"
        gap={2}
        flexShrink={0}
      >
        <text wrapMode="none" flexShrink={1}>
          <Spans spans={hintSpans()} />
        </text>
        <Show when={right().length > 0}>
          <text wrapMode="none" flexShrink={0}>
            <Spans spans={rightHintSpans()} />
          </text>
        </Show>
      </box>
    </box>
  )
}

function Option(props: {
  title: string
  description?: string
  active?: boolean
  current?: boolean
  footer?: JSX.Element | string
  gutter?: () => JSX.Element
  onMouseOver?: () => void
}) {
  const { theme } = useTheme()

  // no marker glyphs: the selected row is bold theme.text, unselected rows
  // are textMuted, the current value is words-in-color (primary).
  return (
    <>
      <Show when={props.gutter}>
        <box flexShrink={0}>{props.gutter?.()}</box>
      </Show>
      <text
        flexGrow={1}
        flexShrink={1}
        fg={props.active ? theme.text : props.current ? theme.primary : theme.textMuted}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
      >
        {Locale.truncate(props.title, 61)}
        <Show when={props.description}>
          <span style={{ fg: props.active ? theme.textMuted : sinkColor(theme, 1) }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text wrapMode="none" fg={props.active ? theme.textMuted : sinkColor(theme, 1)}>
            {props.footer}
          </text>
        </box>
      </Show>
    </>
  )
}
