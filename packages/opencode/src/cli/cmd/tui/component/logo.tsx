import { RGBA } from "@opentui/core"
import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"
import { go, logo, type ColorRole, type LogoShape } from "@/cli/logo"

// Logo — figlet `slant` two-line italic ASCII wordmark for the codemaxxxing
// TUI home: `code` stacked above `maXXXing`, 12 rows × 48 cells.
//
// Replaces the previous F1-instrument-panel logo (chunky 4-row block letters
// inside a tach/cluster chrome box, ~9 rows × 75 cells, multi-zone color,
// always-on multi-layer animation: launchSweep, redlinePulse, needleBounce,
// wave/field/shimmer/pick/trace/bloom/idle, click-driven sound, subpixel
// sampling). All gone.
//
// Animation is a two-phase narrative — IGNITION then IDLE:
//
//   IGNITION (0 → IGNITION_END_MS, plays once on mount)
//     - 0–FADE_MS: every cell fades in from background → full colour
//     - FADE_MS–IGNITION_HOLD_MS: XXX cells flash bright, colour pinned at
//       primaryPeak (primary mixed toward white) for a visible ignition kick
//     - IGNITION_HOLD_MS–IGNITION_END_MS: XXX colour crossfades back from
//       primaryPeak to primary, into the idle breathe
//
//   IDLE (IGNITION_END_MS → ∞, continuous)
//     - Code, ma, ing cells: static at full colour
//     - XXX cells: alpha breathes BREATHE_MIN ↔ 1.0 on a single sin wave,
//       AND colour mildly pulses primary ↔ primaryPeak so the breathe is
//       visible as both brightness and colour shift, not just alpha
//
// Terminals don't blend FG alpha, so all "fade" / "breathe" effects are
// implemented by mixing the colour toward the theme background via
// tint(bg, colour, alpha). alpha=1 → full colour, alpha=0 → invisible.
//
// GoLogo passthrough preserved for the dialog upsell — when props.ink is
// set, the override colour is used for every cell with no animation.

const FADE_MS = 700 // visible boot fade-in
const IGNITION_PEAK_MS = 900 // XXX held at full primaryPeak through this point
const IGNITION_END_MS = 1700 // XXX settled into idle by this point
const BREATHE_PERIOD_MS = 2800 // faster than before so the pulse is felt
const BREATHE_MIN_ALPHA = 0.45 // deeper trough for visible swing
const BREATHE_MAX_ALPHA = 1.0
const BREATHE_PEAK_TINT = 0.35 // how far primary tints toward primaryPeak at breathe peak
const TICK_MS = 33 // ~30fps

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n))
}

function smoothstep(t: number): number {
  const x = clamp(t)
  return x * x * (3 - 2 * x)
}

function inkFor(role: ColorRole, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  if (role === "primary") return theme.primary
  if (role === "secondary") return theme.secondary
  if (role === "accent") return theme.accent
  if (role === "text") return theme.text
  if (role === "textMuted") return theme.textMuted
  if (role === "border") return theme.border
  return primaryPeak(theme)
}

// Push primary toward white by 35% — used as the ignition flash colour and
// as the breathe-peak colour shift on XXX cells.
function primaryPeak(theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  const p = theme.primary
  return RGBA.fromValues(
    Math.min(1, p.r + (1 - p.r) * 0.35),
    Math.min(1, p.g + (1 - p.g) * 0.35),
    Math.min(1, p.b + (1 - p.b) * 0.35),
    1,
  )
}

// Breathe sample at absolute time, normalised to 0..1.
function breatheSample(t: number): number {
  const phase = ((t % BREATHE_PERIOD_MS) / BREATHE_PERIOD_MS) * Math.PI * 2
  return (Math.sin(phase) + 1) / 2
}

// Resolve the XXX cell colour at a given time since mount. Returns the final
// colour to render (already alpha-blended toward bg, ignition tint applied).
function xxxColour(elapsed: number, primary: RGBA, peak: RGBA, bg: RGBA): RGBA {
  // 1. Fade-in alpha (one-shot, 0..FADE_MS).
  const fadeAlpha = clamp(elapsed / FADE_MS)

  if (elapsed < IGNITION_PEAK_MS) {
    // IGNITION HOLD — colour pinned at peak, alpha at full
    const c = peak
    return tint(bg, c, fadeAlpha)
  }

  if (elapsed < IGNITION_END_MS) {
    // IGNITION CROSSFADE — peak → primary; alpha → first idle sample
    const t = smoothstep((elapsed - IGNITION_PEAK_MS) / (IGNITION_END_MS - IGNITION_PEAK_MS))
    const idleAlpha = BREATHE_MIN_ALPHA + (BREATHE_MAX_ALPHA - BREATHE_MIN_ALPHA) * breatheSample(elapsed)
    const idleColour = tint(primary, peak, breatheSample(elapsed) * BREATHE_PEAK_TINT)
    const c = tint(peak, idleColour, t)
    const alpha = 1 + (idleAlpha - 1) * t
    return tint(bg, c, alpha * fadeAlpha)
  }

  // IDLE — continuous breathe, alpha + colour shift in sync
  const sample = breatheSample(elapsed)
  const alpha = BREATHE_MIN_ALPHA + (BREATHE_MAX_ALPHA - BREATHE_MIN_ALPHA) * sample
  const colour = tint(primary, peak, sample * BREATHE_PEAK_TINT)
  return tint(bg, colour, alpha)
}

// Resolve a static (non-XXX) cell — fades in once and stays at full colour.
function staticColour(elapsed: number, base: RGBA, bg: RGBA): RGBA {
  const fadeAlpha = clamp(elapsed / FADE_MS)
  return tint(bg, base, fadeAlpha)
}

export function Logo(props: { shape?: LogoShape; ink?: RGBA } = {}) {
  const shape = props.shape ?? logo
  const { theme } = useTheme()
  const [now, setNow] = createSignal(performance.now())
  const animated = !props.ink
  let mountedAt = performance.now()

  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    mountedAt = performance.now()
    if (!animated) return
    timer = setInterval(() => setNow(performance.now()), TICK_MS)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return (
    <box>
      <For each={shape.rows}>
        {(row) => (
          <box flexDirection="row">
            <For each={row}>
              {(seg) => {
                const base = props.ink ?? inkFor(seg.ink, theme)
                const peak = createMemo(() => primaryPeak(theme))
                const fg = createMemo(() => {
                  if (props.ink) return base
                  const elapsed = now() - mountedAt
                  if (seg.ink === "primary") {
                    return xxxColour(elapsed, base, peak(), theme.background)
                  }
                  return staticColour(elapsed, base, theme.background)
                })
                return (
                  <text fg={fg()} selectable={false}>
                    {seg.chars}
                  </text>
                )
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

export function GoLogo() {
  const { theme } = useTheme()
  const base = RGBA.fromValues(
    theme.background.r + (theme.text.r - theme.background.r) * 0.62,
    theme.background.g + (theme.text.g - theme.background.g) * 0.62,
    theme.background.b + (theme.text.b - theme.background.b) * 0.62,
    1,
  )
  return <Logo shape={go} ink={base} />
}
