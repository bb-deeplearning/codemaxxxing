/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { bench, type BenchResult } from "../../lib/perf"

// Wave 0 baseline: opentui render-cycle cost. Two metrics —
// first_paint (cold mount + render) and steady (per-update reactive render).
// Wave 4 (process tool TUI part) and Wave 11 (subagent TUI enhancements)
// compare their changes against these numbers.

interface RenderHandle {
  renderer: { destroy(): void }
  renderOnce: () => Promise<void>
}

const mountSimpleText = async (initial: string) => {
  const [text, setText] = createSignal(initial)
  const handle = (await testRender(() => <text>{text()}</text>, { width: 100, height: 40 })) as RenderHandle
  await handle.renderOnce()
  return { handle, setText }
}

export const benchSessionRender = async (): Promise<Record<string, BenchResult>> => {
  // First paint: cold mount + first render. Each iteration creates a fresh
  // renderer and tears it down to keep memory bounded.
  const firstPaint = await bench(
    { samples: 30, warmup: 3, label: "session.render.first_paint" },
    async () => {
      const { handle } = await mountSimpleText("first")
      handle.renderer.destroy()
    },
  )

  // Steady state: per-update render after the first paint. One persistent
  // renderer; each sample bumps a signal and forces one render cycle.
  const { handle, setText } = await mountSimpleText("0")
  let counter = 0
  const steady = await bench(
    { samples: 100, warmup: 10, label: "session.render.steady" },
    async () => {
      counter++
      setText(`update ${counter}`)
      await handle.renderOnce()
    },
  )
  handle.renderer.destroy()

  return {
    "session.render.first_paint": firstPaint,
    "session.render.steady": steady,
  }
}
