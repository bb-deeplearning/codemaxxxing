import { InputRenderable, type RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, For, Show, type JSX, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { Keybind } from "@/util/keybind"
import { Locale } from "@/util/locale"
import { Rule } from "@tui/component/border"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../context/tui-config"

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

// tracked small caps for grouped category headers, e.g. "session" -> "s e s s i o n"
function spaceLetters(input: string): string {
  return input.split("").join(" ")
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
    // Each non-empty category contributes: label row + rule row + optional spacer row.
    const headers = grouped().reduce((acc, [category], i) => {
      if (!category) return acc
      // label + rule (+ leading blank when not first)
      return acc + (i > 0 ? 3 : 2)
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

  return (
    <box>
      {/* Header strip */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingTop={1}>
        <Rule color={theme.borderActive} />
      </box>
      {/* Filter input */}
      <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <input
          onInput={(e) => {
            batch(() => {
              setStore("filter", e)
              props.onFilter?.(e)
            })
          }}
          cursorColor={theme.text}
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
      <Rule color={theme.border} />
      <Show
        when={grouped().length > 0}
        fallback={
          <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1}>
            <text fg={theme.textMuted}>no results</text>
          </box>
        }
      >
        <box paddingTop={1} paddingBottom={1}>
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
                    <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3} paddingRight={3}>
                      <Show
                        when={options[0]?.categoryView}
                        fallback={<text fg={theme.textMuted}>{spaceLetters(category.toLowerCase())}</text>}
                      >
                        {options[0]?.categoryView}
                      </Show>
                    </box>
                    <box paddingLeft={3} paddingRight={3}>
                      <Rule color={theme.border} />
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
                          // Active row gets a one-step bg lift so selection is unmistakeable
                          // when scanning long lists. The ▸ marker + bold alone proved too
                          // subtle in practice. We lift to backgroundElement (NOT primary)
                          // to keep the surface readable and not loud.
                          backgroundColor={active() ? (option.bg ?? theme.backgroundElement) : undefined}
                          paddingLeft={2}
                          paddingRight={3}
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
        </box>
      </Show>
      <Rule color={theme.border} />
      <Show when={keybinds().length} fallback={<box flexShrink={0} paddingBottom={1} />}>
        <box
          paddingLeft={3}
          paddingRight={3}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
        >
          <box flexDirection="row" gap={2}>
            <For each={left()}>
              {(item) => (
                <text>
                  <span style={{ fg: theme.text, bold: true }}>{Keybind.toString(item.keybind)}</span>{" "}
                  <span style={{ fg: theme.textMuted }}>{item.title}</span>
                </text>
              )}
            </For>
          </box>
          <box flexDirection="row" gap={2}>
            <For each={right()}>
              {(item) => (
                <text>
                  <span style={{ fg: theme.text, bold: true }}>{Keybind.toString(item.keybind)}</span>{" "}
                  <span style={{ fg: theme.textMuted }}>{item.title}</span>
                </text>
              )}
            </For>
          </box>
        </box>
      </Show>
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

  // Marker column: ▸ when active, ● when current (but not active), gutter if provided, else blank.
  return (
    <>
      <text flexShrink={0} fg={props.active ? theme.text : props.current ? theme.primary : theme.textMuted}>
        {props.active ? "▸" : props.current ? "●" : " "}
      </text>
      <Show when={!props.current && !props.active && props.gutter}>
        <box flexShrink={0}>{props.gutter?.()}</box>
      </Show>
      <text
        flexGrow={1}
        fg={props.active ? theme.text : props.current ? theme.primary : theme.text}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
      >
        {Locale.truncate(props.title, 61)}
        <Show when={props.description}>
          <span style={{ fg: theme.textMuted }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
