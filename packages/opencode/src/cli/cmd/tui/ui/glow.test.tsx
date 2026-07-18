/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import {
  bleed,
  clampRule,
  contextWords,
  fadeRule,
  fadeTarget,
  grad,
  hasBg,
  idColor,
  kinetic,
  mix,
  sinkColor,
  Spans,
  type GlowTokens,
} from "./glow"

const t: GlowTokens = {
  background: RGBA.fromInts(20, 18, 16, 255),
  text: RGBA.fromInts(230, 225, 220, 255),
  textMuted: RGBA.fromInts(140, 130, 120, 255),
  primary: RGBA.fromInts(255, 140, 60, 255),
  secondary: RGBA.fromInts(120, 200, 255, 255),
  accent: RGBA.fromInts(255, 90, 160, 255),
  success: RGBA.fromInts(120, 220, 120, 255),
  warning: RGBA.fromInts(250, 200, 90, 255),
  error: RGBA.fromInts(240, 90, 90, 255),
  info: RGBA.fromInts(150, 150, 255, 255),
}

// the canonical transparent case — lucent-orng resolves background to a=0.
const transparent: GlowTokens = { ...t, background: RGBA.fromInts(0, 0, 0, 0) }

const rgb = (c: RGBA) => [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
const flat = (spans: { text: string }[]) => spans.map((s) => s.text).join("")

describe("fadeTarget / hasBg", () => {
  test("solid theme targets background", () => {
    expect(hasBg(t)).toBe(true)
    expect(rgb(fadeTarget(t))).toEqual(rgb(t.background))
  })
  test("transparent theme degrades to textMuted, never black", () => {
    expect(hasBg(transparent)).toBe(false)
    expect(rgb(fadeTarget(transparent))).toEqual(rgb(t.textMuted))
  })
})

describe("grad", () => {
  test("chunks every 2 chars, endpoints match the deck recipe", () => {
    const spans = grad("0123456789", t.primary, t.accent)
    expect(spans.length).toBe(5)
    expect(flat(spans)).toBe("0123456789")
    expect(rgb(spans[0]!.fg!)).toEqual(rgb(mix(t.primary, t.accent, 0)))
    expect(rgb(spans[4]!.fg!)).toEqual(rgb(mix(t.primary, t.accent, 8 / 9)))
  })
  test("short text is a single span at the from color", () => {
    const spans = grad("ab", t.primary, t.accent, true)
    expect(spans.length).toBe(1)
    expect(rgb(spans[0]!.fg!)).toEqual(rgb(t.primary))
    expect(spans[0]!.bold).toBe(true)
  })
})

describe("fadeRule", () => {
  test("exact width, dissolves toward the page at 0.92", () => {
    const spans = fadeRule(t, t.warning, 34)
    expect(flat(spans)).toBe("─".repeat(34))
    const last = spans[spans.length - 1]!
    const target = mix(t.warning, t.background, 0.92)
    expect(rgb(mix(t.warning, target, 32 / 33))).toEqual(rgb(last.fg!))
  })
  test("width 0 renders nothing", () => {
    expect(fadeRule(t, t.warning, 0)).toEqual([])
  })
  test("transparent theme fades toward textMuted", () => {
    const spans = fadeRule(transparent, t.warning, 20)
    const last = spans[spans.length - 1]!
    const target = mix(t.warning, t.textMuted, 0.92)
    expect(rgb(mix(t.warning, target, 18 / 19))).toEqual(rgb(last.fg!))
  })
})

describe("sink", () => {
  test("two cooling steps: body tail 0.32, whisper 0.6", () => {
    expect(rgb(sinkColor(t, 1))).toEqual(rgb(mix(t.textMuted, t.background, 0.32)))
    expect(rgb(sinkColor(t, 2))).toEqual(rgb(mix(t.textMuted, t.background, 0.6)))
  })
  test("transparent theme sinks toward textMuted (stays visible)", () => {
    expect(rgb(sinkColor(transparent, 2))).toEqual(rgb(mix(t.textMuted, t.textMuted, 0.6)))
  })
})

describe("bleed", () => {
  test("3-cell chunks, wash strongest left and gone by width", () => {
    const spans = bleed(t, "store.swap(key, fresh)", t.error, t.error, 30)
    expect(flat(spans).length).toBe(30)
    expect(rgb(spans[0]!.bg!)).toEqual(rgb(mix(t.background, t.error, 0.16)))
    const last = spans[spans.length - 1]!
    expect(rgb(last.bg!)).toEqual(rgb(mix(mix(t.background, t.error, 0.16), t.background, Math.min(1, 27 / 30))))
    for (const s of spans) expect(rgb(s.fg!)).toEqual(rgb(t.error))
  })
  test("transparent theme skips the wash entirely — one plain span", () => {
    const spans = bleed(transparent, "await store.swapLocked(lock, fresh)", t.success, t.success, 30)
    expect(spans.length).toBe(1)
    expect(spans[0]!.bg).toBeUndefined()
    expect(spans[0]!.text).toBe("await store.swapLocked(lock, fresh)")
  })
})

describe("kinetic", () => {
  test("burns toward the leading edge: head cooled 0.55, tail hot, bold", () => {
    const spans = kinetic(t, "hunting the race in token.ts", t.accent)
    expect(rgb(spans[0]!.fg!)).toEqual(rgb(mix(t.accent, t.background, 0.55)))
    for (const s of spans) expect(s.bold).toBe(true)
  })
})

describe("idColor", () => {
  test("stable, and always a member of the theme accent set", () => {
    const set = [t.primary, t.secondary, t.accent, t.success, t.warning, t.error, t.info].map(rgb)
    for (const key of ["clauseo-api", "cmx", "blog", "build"]) {
      const a = idColor(t, key)
      expect(rgb(a)).toEqual(rgb(idColor(t, key)))
      expect(set).toContainEqual(rgb(a))
    }
  })
  test("distinguishes the deck's own example keys", () => {
    expect(rgb(idColor(t, "clauseo-api"))).not.toEqual(rgb(idColor(t, "cmx")))
  })
})

describe("contextWords", () => {
  test("silent below 70, warning past 70, error past 90 — words not glyphs", () => {
    expect(contextWords(t, 61)).toBeUndefined()
    expect(contextWords(t, 84)).toEqual({ text: "84% full · compact soon", fg: t.warning })
    expect(contextWords(t, 95)).toEqual({ text: "95% full · compact now", fg: t.error })
  })
})

describe("clampRule", () => {
  test("clamps to available width and never negative", () => {
    expect(clampRule(56, 96)).toBe(56)
    expect(clampRule(56, 40)).toBe(40)
    expect(clampRule(28, -2)).toBe(0)
  })
})

describe("Spans", () => {
  test("renders inside a single <text> line", async () => {
    const handle = await testRender(
      () => (
        <text>
          <Spans spans={fadeRule(t, t.primary, 12)} />
        </text>
      ),
      { width: 20, height: 4 },
    )
    try {
      await handle.renderOnce()
      expect(handle.captureCharFrame()).toContain("─".repeat(12))
    } finally {
      handle.renderer.destroy()
    }
  })
})
