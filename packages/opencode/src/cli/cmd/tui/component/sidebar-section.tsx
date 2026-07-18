import { createMemo, Show } from "solid-js"
import { clampRule, fadeRule, fadeTarget, mix, sinkColor, Spans, type GlowTokens } from "@tui/ui/glow"

// afterglow sidebar section header: a lowercase word sunk toward the page
// with a short dissolving rule under it. no chevrons, no chips — the
// collapse affordance is a dim whisper after the word (words, never
// glyphs), and the whole header stays a click target so the legacy
// toggle behavior survives the reskin.
//
// works for both worlds: routes pass the reactive theme proxy from
// useTheme(); feature-plugins pass props.api.theme.current (the same
// proxy, re-exposed) — either way token reads inside the memo stay
// reactive because solid turns the `t` prop into a getter.

// the sidebar width contract is fixed at 42 cols; content inside the
// scrollbox nets out to 36. rules always clamp against that.
export const SIDEBAR_INNER = 36

export function SidebarSection(props: {
  t: GlowTokens
  label: string
  // dim tail after the word — e.g. "· 4" while collapsed
  whisper?: string
  onMouseDown?: () => void
}) {
  const rule = createMemo(() =>
    fadeRule(props.t, mix(props.t.primary, fadeTarget(props.t), 0.5), clampRule(20, SIDEBAR_INNER)),
  )
  return (
    <box flexShrink={0} onMouseDown={props.onMouseDown}>
      <text wrapMode="none" flexShrink={0}>
        <span style={{ fg: sinkColor(props.t, 1) }}>{props.label}</span>
        <Show when={props.whisper}>
          <span style={{ fg: sinkColor(props.t, 2) }}> {props.whisper}</span>
        </Show>
      </text>
      <text wrapMode="none" flexShrink={0} selectable={false}>
        <Spans spans={rule()} />
      </text>
    </box>
  )
}
