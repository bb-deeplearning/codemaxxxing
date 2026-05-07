import { createStore } from "solid-js/store"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { LabeledRule, Rule } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useDialog } from "../../ui/dialog"
import { inlineSafe } from "../../util/inline-safe"

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const bindings = useTextareaKeybindings()

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1)) // questions + confirm tab (no confirm for single select)
  const [tabHover, setTabHover] = createSignal<number | "confirm" | null>(null)
  const [optionHover, setOptionHover] = createSignal<number | null>(null)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    selected: 0,
    editing: false,
  })

  let textarea: TextareaRenderable | undefined

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    void sdk.client.question.reply({
      requestID: props.request.id,
      answers,
    })
  }

  function reject() {
    void sdk.client.question.reject({
      requestID: props.request.id,
    })
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      void sdk.client.question.reply({
        requestID: props.request.id,
        answers: [[answer]],
      })
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("selected", 0)
  }

  function selectOption() {
    if (other()) {
      if (!multi()) {
        setStore("editing", true)
        return
      }
      const value = input()
      if (value && customPicked()) {
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const dialog = useDialog()

  useKeyboard((evt) => {
    // Skip processing if a dialog (e.g., command palette) is open
    if (dialog.stack.length > 0) return

    // When editing custom answer textarea
    if (store.editing && !confirm()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setStore("editing", false)
        return
      }
      if (keybind.match("input_clear", evt)) {
        evt.preventDefault()
        const text = textarea?.plainText ?? ""
        if (!text) {
          setStore("editing", false)
          return
        }
        textarea?.setText("")
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        const text = textarea?.plainText?.trim() ?? ""
        const prev = store.custom[store.tab]

        if (!text) {
          if (prev) {
            const inputs = [...store.custom]
            inputs[store.tab] = ""
            setStore("custom", inputs)

            const answers = [...store.answers]
            answers[store.tab] = (answers[store.tab] ?? []).filter((x) => x !== prev)
            setStore("answers", answers)
          }
          setStore("editing", false)
          return
        }

        if (multi()) {
          const inputs = [...store.custom]
          inputs[store.tab] = text
          setStore("custom", inputs)

          const existing = store.answers[store.tab] ?? []
          const next = [...existing]
          if (prev) {
            const index = next.indexOf(prev)
            if (index !== -1) next.splice(index, 1)
          }
          if (!next.includes(text)) next.push(text)
          const answers = [...store.answers]
          answers[store.tab] = next
          setStore("answers", answers)
          setStore("editing", false)
          return
        }

        pick(text, true)
        setStore("editing", false)
        return
      }
      // Let textarea handle all other keys
      return
    }

    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      selectTab((store.tab - 1 + tabs()) % tabs())
    }

    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      selectTab((store.tab + 1) % tabs())
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const direction = evt.shift ? -1 : 1
      selectTab((store.tab + direction + tabs()) % tabs())
    }

    if (confirm()) {
      if (evt.name === "return") {
        evt.preventDefault()
        submit()
      }
      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        reject()
      }
    } else {
      const opts = options()
      const total = opts.length + (custom() ? 1 : 0)
      const max = Math.min(total, 9)
      const digit = Number(evt.name)

      if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
        evt.preventDefault()
        const index = digit - 1
        moveTo(index)
        selectOption()
        return
      }

      if (evt.name === "up" || evt.name === "k") {
        evt.preventDefault()
        moveTo((store.selected - 1 + total) % total)
      }

      if (evt.name === "down" || evt.name === "j") {
        evt.preventDefault()
        moveTo((store.selected + 1) % total)
      }

      if (evt.name === "return") {
        evt.preventDefault()
        selectOption()
      }

      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        reject()
      }
    }
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      {/* top interruption rule */}
      <Rule color={theme.accent} />
      <box paddingTop={1} paddingLeft={1} paddingRight={1} gap={1}>
        <Show when={!single()}>
          <box flexDirection="row" gap={2}>
            <For each={questions()}>
              {(q, index) => {
                const isActive = () => index() === store.tab
                const isAnswered = () => (store.answers[index()]?.length ?? 0) > 0
                const isHover = () => tabHover() === index()
                const labelFg = () => {
                  if (isActive()) return theme.accent
                  if (isHover()) return theme.text
                  if (isAnswered()) return theme.text
                  return theme.textMuted
                }
                return (
                  <box
                    onMouseOver={() => setTabHover(index())}
                    onMouseOut={() => setTabHover(null)}
                    onMouseUp={() => selectTab(index())}
                  >
                    <text>
                      <span style={{ fg: labelFg(), bold: isActive() }}>
                        {isActive() ? "▸ " : "  "}
                        {/* Sanitize via inlineSafe — header is LLM-supplied
                            and lands inside a flex-row tab strip. Multi-
                            line / multi-KB content would trip opentui's
                            flex layout-budget freeze. See
                            specs/tui-render-freeze.md. */}
                        {inlineSafe(q.header, 60)}
                      </span>
                    </text>
                  </box>
                )
              }}
            </For>
            <box
              onMouseOver={() => setTabHover("confirm")}
              onMouseOut={() => setTabHover(null)}
              onMouseUp={() => selectTab(questions().length)}
            >
              <text>
                <span
                  style={{
                    fg: confirm() ? theme.accent : tabHover() === "confirm" ? theme.text : theme.textMuted,
                    bold: confirm(),
                  }}
                >
                  {confirm() ? "▸ " : "  "}confirm
                </span>
              </text>
            </box>
          </box>
        </Show>

        <Show when={!confirm()}>
          <box gap={1}>
            <text fg={theme.text}>
              {question()?.question}
              {multi() ? (
                <>
                  <span style={{ fg: theme.textMuted }}> · select all that apply</span>
                </>
              ) : (
                ""
              )}
            </text>
            <box>
              <For each={options()}>
                {(opt, i) => {
                  const active = () => i() === store.selected
                  const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                  const hover = () => optionHover() === i()
                  const numFg = () => (active() ? theme.secondary : hover() ? theme.text : theme.textMuted)
                  const labelFg = () => {
                    if (active()) return theme.secondary
                    if (picked()) return theme.success
                    return theme.text
                  }
                  return (
                    <box
                      flexDirection="row"
                      onMouseOver={() => {
                        setOptionHover(i())
                        moveTo(i())
                      }}
                      onMouseOut={() => setOptionHover(null)}
                      onMouseDown={() => moveTo(i())}
                      onMouseUp={() => selectOption()}
                    >
                      <text flexShrink={0}>
                        <span style={{ fg: active() ? theme.secondary : theme.textMuted, bold: active() }}>
                          {active() ? "▸ " : "  "}
                        </span>
                        <span style={{ fg: numFg() }}>{i() + 1}.</span>{" "}
                        <span style={{ fg: labelFg(), bold: active() }}>
                          {/* Both label and description are LLM-supplied
                              and land inside this flex-row option strip.
                              Sanitize via inlineSafe to keep the row
                              measurement bounded — see
                              specs/tui-render-freeze.md. Cap is generous
                              (200) because options are user-facing
                              actionable text and short truncation hurts UX
                              more than it costs to keep the layout stable. */}
                          {multi() ? `[${picked() ? "✓" : " "}] ${inlineSafe(opt.label, 200)}` : inlineSafe(opt.label, 200)}
                        </span>
                        <Show when={!multi() && picked()}>
                          <span style={{ fg: theme.success }}> ✓</span>
                        </Show>
                        <Show when={opt.description}>
                          <span style={{ fg: theme.textMuted }}> · {inlineSafe(opt.description, 200)}</span>
                        </Show>
                      </text>
                    </box>
                  )
                }}
              </For>
              <Show when={custom()}>
                <box
                  onMouseOver={() => {
                    setOptionHover(options().length)
                    moveTo(options().length)
                  }}
                  onMouseOut={() => setOptionHover(null)}
                  onMouseDown={() => moveTo(options().length)}
                  onMouseUp={() => selectOption()}
                >
                  <box flexDirection="row">
                    <text flexShrink={0}>
                      <span style={{ fg: other() ? theme.secondary : theme.textMuted, bold: other() }}>
                        {other() ? "▸ " : "  "}
                      </span>
                      <span
                        style={{
                          fg: other()
                            ? theme.secondary
                            : optionHover() === options().length
                              ? theme.text
                              : theme.textMuted,
                        }}
                      >
                        {options().length + 1}.
                      </span>{" "}
                      <span
                        style={{
                          fg: other() ? theme.secondary : customPicked() ? theme.success : theme.text,
                          bold: other(),
                        }}
                      >
                        {multi() ? `[${customPicked() ? "✓" : " "}] type your own answer` : "type your own answer"}
                      </span>
                      <Show when={!multi() && customPicked()}>
                        <span style={{ fg: theme.success }}> ✓</span>
                      </Show>
                    </text>
                  </box>
                  <Show when={store.editing}>
                    <box paddingLeft={5}>
                      <textarea
                        ref={(val: TextareaRenderable) => {
                          textarea = val
                          val.traits = { status: "ANSWER" }
                          queueMicrotask(() => {
                            val.focus()
                            val.gotoLineEnd()
                          })
                        }}
                        initialValue={input()}
                        placeholder="type your own answer"
                        placeholderColor={theme.textMuted}
                        minHeight={1}
                        maxHeight={6}
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        cursorColor={theme.primary}
                        keyBindings={bindings()}
                      />
                    </box>
                  </Show>
                  <Show when={!store.editing && input()}>
                    <box paddingLeft={5}>
                      <text fg={theme.textMuted}>{input()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </Show>

        <Show when={confirm() && !single()}>
          <text fg={theme.textMuted}>r e v i e w</text>
          <Rule />
          <box gap={0}>
            <For each={questions()}>
              {(q, index) => {
                const value = () => store.answers[index()]?.join(", ") ?? ""
                const answered = () => Boolean(value())
                return (
                  <text>
                    <span style={{ fg: theme.textMuted }}>{q.header}</span>{" "}
                    <span style={{ fg: answered() ? theme.text : theme.error }}>
                      {answered() ? value() : "(not answered)"}
                    </span>
                  </text>
                )
              }}
            </For>
          </box>
        </Show>
      </box>
      {/* bottom interruption rule + keybind hints */}
      <LabeledRule
        color={theme.accent}
        right={
          <box flexDirection="row" gap={2} flexShrink={0}>
            <Show when={!single()}>
              <text>
                <span style={{ fg: theme.text }}>tab</span> <span style={{ fg: theme.textMuted }}>switch</span>
              </text>
            </Show>
            <Show when={!confirm()}>
              <text>
                <span style={{ fg: theme.text }}>↑↓</span> <span style={{ fg: theme.textMuted }}>select</span>
              </text>
            </Show>
            <text>
              <span style={{ fg: theme.text }}>enter</span>{" "}
              <span style={{ fg: theme.textMuted }}>
                {confirm() ? "submit" : multi() ? "toggle" : single() ? "submit" : "confirm"}
              </span>
            </text>
            <text>
              <span style={{ fg: theme.text }}>esc</span> <span style={{ fg: theme.textMuted }}>dismiss</span>
            </text>
          </box>
        }
      />
    </box>
  )
}
