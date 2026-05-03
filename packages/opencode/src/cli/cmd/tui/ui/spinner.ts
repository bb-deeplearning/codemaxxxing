import type { ColorInput } from "@opentui/core"
import { RGBA } from "@opentui/core"
import type { ColorGenerator } from "opentui-spinner"

interface AdvancedGradientOptions {
  colors: ColorInput[]
  trailLength: number
  defaultColor?: ColorInput
  direction?: "forward" | "backward" | "bidirectional"
  holdFrames?: { start?: number; end?: number }
  enableFading?: boolean
  minAlpha?: number
}

interface ScannerState {
  activePosition: number
  isHolding: boolean
  holdProgress: number
  holdTotal: number
  movementProgress: number
  movementTotal: number
  isMovingForward: boolean
}

function getScannerState(
  frameIndex: number,
  totalChars: number,
  options: Pick<AdvancedGradientOptions, "direction" | "holdFrames">,
): ScannerState {
  const { direction = "forward", holdFrames = {} } = options

  if (direction === "bidirectional") {
    const forwardFrames = totalChars
    const holdEndFrames = holdFrames.end ?? 0
    const backwardFrames = totalChars - 1

    if (frameIndex < forwardFrames) {
      // Moving forward
      return {
        activePosition: frameIndex,
        isHolding: false,
        holdProgress: 0,
        holdTotal: 0,
        movementProgress: frameIndex,
        movementTotal: forwardFrames,
        isMovingForward: true,
      }
    } else if (frameIndex < forwardFrames + holdEndFrames) {
      // Holding at end
      return {
        activePosition: totalChars - 1,
        isHolding: true,
        holdProgress: frameIndex - forwardFrames,
        holdTotal: holdEndFrames,
        movementProgress: 0,
        movementTotal: 0,
        isMovingForward: true,
      }
    } else if (frameIndex < forwardFrames + holdEndFrames + backwardFrames) {
      // Moving backward
      const backwardIndex = frameIndex - forwardFrames - holdEndFrames
      return {
        activePosition: totalChars - 2 - backwardIndex,
        isHolding: false,
        holdProgress: 0,
        holdTotal: 0,
        movementProgress: backwardIndex,
        movementTotal: backwardFrames,
        isMovingForward: false,
      }
    } else {
      // Holding at start
      return {
        activePosition: 0,
        isHolding: true,
        holdProgress: frameIndex - forwardFrames - holdEndFrames - backwardFrames,
        holdTotal: holdFrames.start ?? 0,
        movementProgress: 0,
        movementTotal: 0,
        isMovingForward: false,
      }
    }
  } else if (direction === "backward") {
    return {
      activePosition: totalChars - 1 - (frameIndex % totalChars),
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frameIndex % totalChars,
      movementTotal: totalChars,
      isMovingForward: false,
    }
  } else {
    return {
      activePosition: frameIndex % totalChars,
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frameIndex % totalChars,
      movementTotal: totalChars,
      isMovingForward: true,
    }
  }
}

function calculateColorIndex(
  frameIndex: number,
  charIndex: number,
  totalChars: number,
  options: Pick<AdvancedGradientOptions, "direction" | "holdFrames" | "trailLength">,
  state?: ScannerState,
): number {
  const { trailLength } = options
  const { activePosition, isHolding, holdProgress, isMovingForward } =
    state ?? getScannerState(frameIndex, totalChars, options)

  // Calculate directional distance (positive means trailing behind)
  const directionalDistance = isMovingForward
    ? activePosition - charIndex // For forward: trail is to the left (lower indices)
    : charIndex - activePosition // For backward: trail is to the right (higher indices)

  // Handle hold frame fading: keep the lead bright, fade the trail
  if (isHolding) {
    // Shift the color index by how long we've been holding
    return directionalDistance + holdProgress
  }

  // Normal movement - show gradient trail only behind the movement direction
  if (directionalDistance > 0 && directionalDistance < trailLength) {
    return directionalDistance
  }

  // At the active position, show the brightest color
  if (directionalDistance === 0) {
    return 0
  }

  return -1
}

function createKnightRiderTrail(options: AdvancedGradientOptions): ColorGenerator {
  const { colors, defaultColor, enableFading = true, minAlpha = 0 } = options

  // Use the provided defaultColor if it's an RGBA instance, otherwise convert/default
  // We use RGBA.fromHex for the fallback to ensure we have an RGBA object.
  // Note: If defaultColor is a string, we convert it once here.
  const defaultRgba = defaultColor instanceof RGBA ? defaultColor : RGBA.fromHex((defaultColor as string) || "#000000")

  // Store the base alpha from the inactive factor
  const baseInactiveAlpha = defaultRgba.a

  let cachedFrameIndex = -1
  let cachedState: ScannerState | null = null

  return (frameIndex: number, charIndex: number, _totalFrames: number, totalChars: number) => {
    if (frameIndex !== cachedFrameIndex) {
      cachedFrameIndex = frameIndex
      cachedState = getScannerState(frameIndex, totalChars, options)
    }

    const state = cachedState!

    const index = calculateColorIndex(frameIndex, charIndex, totalChars, options, state)

    // Calculate global fade for inactive dots during hold or movement
    const { isHolding, holdProgress, holdTotal, movementProgress, movementTotal } = state

    let fadeFactor = 1.0
    if (enableFading) {
      if (isHolding && holdTotal > 0) {
        // Fade out linearly to minAlpha
        const progress = Math.min(holdProgress / holdTotal, 1)
        fadeFactor = Math.max(minAlpha, 1 - progress * (1 - minAlpha))
      } else if (!isHolding && movementTotal > 0) {
        // Fade in linearly from minAlpha during movement
        const progress = Math.min(movementProgress / Math.max(1, movementTotal - 1), 1)
        fadeFactor = minAlpha + progress * (1 - minAlpha)
      }
    }

    // Combine base inactive alpha with the fade factor
    // This ensures inactiveFactor is respected while still allowing fading animation
    defaultRgba.a = baseInactiveAlpha * fadeFactor

    if (index === -1) {
      return defaultRgba
    }

    return colors[index] ?? defaultRgba
  }
}

/**
 * Derives a gradient of tail colors from a single bright color using alpha falloff
 * @param brightColor The brightest color (center/head of the scanner)
 * @param steps Number of gradient steps (default: 6)
 * @returns Array of RGBA colors with alpha-based trail fade (background-independent)
 */
export function deriveTrailColors(brightColor: ColorInput, steps: number = 6): RGBA[] {
  const baseRgba = brightColor instanceof RGBA ? brightColor : RGBA.fromHex(brightColor as string)

  const colors: RGBA[] = []

  for (let i = 0; i < steps; i++) {
    // Alpha-based falloff with optional bloom effect
    let alpha: number
    let brightnessFactor: number

    if (i === 0) {
      // Lead position: full brightness and opacity
      alpha = 1.0
      brightnessFactor = 1.0
    } else if (i === 1) {
      // Slight bloom/glare effect: brighten color but reduce opacity slightly
      alpha = 0.9
      brightnessFactor = 1.15
    } else {
      // Exponential alpha decay for natural-looking trail fade
      alpha = Math.pow(0.65, i - 1)
      brightnessFactor = 1.0
    }

    const r = Math.min(1.0, baseRgba.r * brightnessFactor)
    const g = Math.min(1.0, baseRgba.g * brightnessFactor)
    const b = Math.min(1.0, baseRgba.b * brightnessFactor)

    colors.push(RGBA.fromValues(r, g, b, alpha))
  }

  return colors
}

/**
 * Derives the inactive/default color from a bright color using alpha
 * @param brightColor The brightest color (center/head of the scanner)
 * @param factor Alpha factor for inactive color (default: 0.2, range: 0-1)
 * @returns The same color with reduced alpha for background-independent dimming
 */
export function deriveInactiveColor(brightColor: ColorInput, factor: number = 0.2): RGBA {
  const baseRgba = brightColor instanceof RGBA ? brightColor : RGBA.fromHex(brightColor as string)

  // Use the full color brightness but adjust alpha for background-independent dimming
  return RGBA.fromValues(baseRgba.r, baseRgba.g, baseRgba.b, factor)
}

export type KnightRiderStyle = "blocks" | "diamonds"

export interface KnightRiderOptions {
  width?: number
  style?: KnightRiderStyle
  holdStart?: number
  holdEnd?: number
  colors?: ColorInput[]
  /** Single color to derive trail from (alternative to providing colors array) */
  color?: ColorInput
  /** Number of trail steps when using single color (default: 6) */
  trailSteps?: number
  defaultColor?: ColorInput
  /** Alpha factor for inactive color when using single color (default: 0.2, range: 0-1) */
  inactiveFactor?: number
  /** Enable fading of inactive dots during hold and movement (default: true) */
  enableFading?: boolean
  /** Minimum alpha value when fading (default: 0, range: 0-1) */
  minAlpha?: number
}

/**
 * Creates frame strings for a Knight Rider style scanner animation
 * @param options Configuration options for the Knight Rider effect
 * @returns Array of frame strings
 */
export function createFrames(options: KnightRiderOptions = {}): string[] {
  const width = options.width ?? 8
  const style = options.style ?? "diamonds"
  const holdStart = options.holdStart ?? 30
  const holdEnd = options.holdEnd ?? 9

  const colors =
    options.colors ??
    (options.color
      ? deriveTrailColors(options.color, options.trailSteps)
      : [
          RGBA.fromHex("#ff0000"), // Brightest Red (Center)
          RGBA.fromHex("#ff5555"), // Glare/Bloom
          RGBA.fromHex("#dd0000"), // Trail 1
          RGBA.fromHex("#aa0000"), // Trail 2
          RGBA.fromHex("#770000"), // Trail 3
          RGBA.fromHex("#440000"), // Trail 4
        ])

  const defaultColor =
    options.defaultColor ??
    (options.color ? deriveInactiveColor(options.color, options.inactiveFactor) : RGBA.fromHex("#330000"))

  const trailOptions = {
    colors,
    trailLength: colors.length,
    defaultColor,
    direction: "bidirectional" as const,
    holdFrames: { start: holdStart, end: holdEnd },
    enableFading: options.enableFading,
    minAlpha: options.minAlpha,
  }

  // Bidirectional cycle: Forward (width) + Hold End + Backward (width-1) + Hold Start
  const totalFrames = width + holdEnd + (width - 1) + holdStart

  // Generate dynamic frames where inactive pixels are dots and active ones are blocks
  const frames = Array.from({ length: totalFrames }, (_, frameIndex) => {
    return Array.from({ length: width }, (_, charIndex) => {
      const index = calculateColorIndex(frameIndex, charIndex, width, trailOptions)

      if (style === "diamonds") {
        const shapes = ["⬥", "◆", "⬩", "⬪"]
        if (index >= 0 && index < trailOptions.colors.length) {
          return shapes[Math.min(index, shapes.length - 1)]
        }
        return "·"
      }

      // Default to blocks
      // It's active if we have a valid color index that is within our colors array
      const isActive = index >= 0 && index < trailOptions.colors.length
      return isActive ? "■" : "⬝"
    }).join("")
  })

  return frames
}

/**
 * Creates a color generator function for Knight Rider style scanner animation
 * @param options Configuration options for the Knight Rider effect
 * @returns ColorGenerator function
 */
export function createColors(options: KnightRiderOptions = {}): ColorGenerator {
  const holdStart = options.holdStart ?? 30
  const holdEnd = options.holdEnd ?? 9

  const colors =
    options.colors ??
    (options.color
      ? deriveTrailColors(options.color, options.trailSteps)
      : [
          RGBA.fromHex("#ff0000"), // Brightest Red (Center)
          RGBA.fromHex("#ff5555"), // Glare/Bloom
          RGBA.fromHex("#dd0000"), // Trail 1
          RGBA.fromHex("#aa0000"), // Trail 2
          RGBA.fromHex("#770000"), // Trail 3
          RGBA.fromHex("#440000"), // Trail 4
        ])

  const defaultColor =
    options.defaultColor ??
    (options.color ? deriveInactiveColor(options.color, options.inactiveFactor) : RGBA.fromHex("#330000"))

  const trailOptions = {
    colors,
    trailLength: colors.length,
    defaultColor,
    direction: "bidirectional" as const,
    holdFrames: { start: holdStart, end: holdEnd },
    enableFading: options.enableFading,
    minAlpha: options.minAlpha,
  }

  return createKnightRiderTrail(trailOptions)
}

// ── Turbo spool spinner ───────────────────────────────────────────────────
//
// Six cells: compressor pair + turbine pair + 2-cell boost gauge. Inspired
// by a snail-style turbocharger spooling up under load, peaking, then
// bleeding off on lift.
//
// CELLS 0,1 — Compressor wheel: 2-cell motion-blur rotation. Each cell
//   shows a successive frame of the 10-step braille spinner so within the
//   wheel itself you see a leading edge + trailing afterimage.
//
// CELLS 2,3 — Turbine wheel: same 2-cell motion-blur rotation, phase-
//   offset 5 frames (180°) so the two wheels never line up — feels like
//   real twin-rotor hardware.
//
// All four rotation cells use the 10-frame braille arc OR'd with dots 7,8
// (⣋⣙⣹⣸⣼⣴⣦⣧⣇⣏) so every frame has a permanent bottom-row baseline.
// This is the height-match trick: bottom-row dots align the rotation with
// the gauge's bottom-anchored fill so all six cells share a visual floor.
//
// CELLS 4,5 — Boost gauge: 9-level vertical fill in 2 cells using full
//   8-dot braille (⣀..⣿). Always shows at least the bottom baseline at
//   idle, fills upward as pressure builds.
//
// Angular velocity is proportional to current boost: rotors crawl at idle,
// spin ~4× faster at peak.
//
// CYCLE (28 frames @ 50ms ≈ 1.4s):
//   - Idle (4f):    boost=0, rotors crawl
//   - Spool (14f):  smoothstep 0→8, rotors accelerate, gauge fills
//   - Peak (2f):    boost=8, BLOOM FLASH on all 6 cells (overshoot 1.15×)
//   - Bleed (8f):   linear 8→0, rotors spin down, gauge drains
//
// Color is the agent color; only alpha + brightness vary. Background-
// independent (alpha-only fade).

const TURBO_WIDTH = 6
const TURBO_TOTAL_FRAMES = 28
const TURBO_PEAK_START = 18
const TURBO_PEAK_END = 19
// Standard 10-frame braille spinner OR'd with dots 7,8 (⣀) for permanent
// bottom-row baseline — matches gauge floor so all cells share a visual base.
const TURBO_ROTATION = ["⣋", "⣙", "⣹", "⣸", "⣼", "⣴", "⣦", "⣧", "⣇", "⣏"]
// 9-level 2-cell gauge, bottom-up fill, always anchored at bottom row.
const TURBO_GAUGE_LEFT = ["⣀", "⣤", "⣤", "⣶", "⣶", "⣷", "⣷", "⣿", "⣿"]
const TURBO_GAUGE_RIGHT = ["⣀", "⣀", "⣤", "⣤", "⣶", "⣶", "⣷", "⣷", "⣿"]
const TURBO_GAUGE_MAX = TURBO_GAUGE_LEFT.length - 1

function turboBoost(frame: number): number {
  const f = frame % TURBO_TOTAL_FRAMES
  if (f < 4) return 0
  if (f < TURBO_PEAK_START) {
    // Smoothstep ease 0→8 over 14 frames
    const t = (f - 4) / 13
    return TURBO_GAUGE_MAX * t * t * (3 - 2 * t)
  }
  if (f <= TURBO_PEAK_END) return TURBO_GAUGE_MAX
  // Linear bleed 8→0 over 8 frames
  return TURBO_GAUGE_MAX * (1 - (f - TURBO_PEAK_END) / 8)
}

function turboIsPeak(frame: number): boolean {
  const f = frame % TURBO_TOTAL_FRAMES
  return f === TURBO_PEAK_START || f === TURBO_PEAK_END
}

// Precomputed cumulative angular position per wheel (closed-form would be
// messy because rotation speed depends on the non-linear boost curve).
// a0 drives compressor pair, a1 drives turbine pair (5-frame / 180° offset).
const TURBO_ANGLES = (() => {
  const a0: number[] = []
  const a1: number[] = []
  let acc0 = 0
  let acc1 = 5 // 180° phase offset (10-frame rotation, half = 5)
  for (let f = 0; f < TURBO_TOTAL_FRAMES; f++) {
    a0.push(acc0)
    a1.push(acc1)
    const speed = 1 + turboBoost(f) * 0.4 // 1.0 idle → ~4.2 at peak
    acc0 += speed
    acc1 += speed
  }
  return { a0, a1 }
})()

export function createV12Frames(): string[] {
  const N = TURBO_ROTATION.length
  return Array.from({ length: TURBO_TOTAL_FRAMES }, (_, f) => {
    const a0 = Math.floor(TURBO_ANGLES.a0[f])
    const a1 = Math.floor(TURBO_ANGLES.a1[f])
    // Compressor: cell 0 leads, cell 1 trails by 1 frame (motion blur)
    const c0 = TURBO_ROTATION[a0 % N]
    const c1 = TURBO_ROTATION[(a0 + 1) % N]
    // Turbine: same trick, phase-offset by 5 (180°)
    const t0 = TURBO_ROTATION[a1 % N]
    const t1 = TURBO_ROTATION[(a1 + 1) % N]
    // Gauge: 2-cell vertical fill
    const g = Math.min(TURBO_GAUGE_MAX, Math.round(turboBoost(f)))
    return c0 + c1 + t0 + t1 + TURBO_GAUGE_LEFT[g] + TURBO_GAUGE_RIGHT[g]
  })
}

export function createV12Colors(brightColor: ColorInput): ColorGenerator {
  const baseRgba = brightColor instanceof RGBA ? brightColor : RGBA.fromHex(brightColor as string)
  return (frame: number, cell: number) => {
    const f = frame % TURBO_TOTAL_FRAMES
    const boost = turboBoost(f) / TURBO_GAUGE_MAX // 0..1

    if (turboIsPeak(f)) {
      // Bloom flash on all six cells: alpha pinned + brightness overshoot
      return RGBA.fromValues(
        Math.min(1, baseRgba.r * 1.15),
        Math.min(1, baseRgba.g * 1.15),
        Math.min(1, baseRgba.b * 1.15),
        1,
      )
    }

    // Rotors stay visible at idle; gauge starts dim and rises with pressure
    const isGauge = cell >= 4
    const alpha = isGauge ? 0.3 + boost * 0.7 : 0.55 + boost * 0.4

    return RGBA.fromValues(baseRgba.r, baseRgba.g, baseRgba.b, alpha)
  }
}
