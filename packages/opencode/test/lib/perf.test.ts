import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import {
  bench,
  benchEffect,
  BenchBudgetExceededError,
  compareToBaseline,
  DEFAULT_BUDGET,
  percentiles,
  writeBenchReport,
} from "./perf"
import type { BenchResult } from "./perf"

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  return undefined
}

function asBudgetError(value: unknown): BenchBudgetExceededError {
  if (!(value instanceof BenchBudgetExceededError)) {
    throw new Error("expected BenchBudgetExceededError")
  }
  return value
}

function asError(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error("expected Error")
  return value
}

describe("percentiles", () => {
  test("computes nearest-rank percentiles for 1..100", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    const out = percentiles(samples)
    expect(out.p50).toBe(50)
    expect(out.p95).toBe(95)
    expect(out.p99).toBe(99)
    expect(out.min).toBe(1)
    expect(out.max).toBe(100)
    expect(out.mean).toBe(50.5)
  })

  test("handles single-sample input", () => {
    const out = percentiles([42])
    expect(out.p50).toBe(42)
    expect(out.p95).toBe(42)
    expect(out.p99).toBe(42)
    expect(out.min).toBe(42)
    expect(out.max).toBe(42)
    expect(out.mean).toBe(42)
  })

  test("does not mutate input array", () => {
    const samples = [9, 1, 7, 3, 5]
    const original = [...samples]
    percentiles(samples)
    expect(samples).toEqual(original)
  })
})

describe("bench", () => {
  test("runs the configured sample count and returns valid stats", async () => {
    const result = await bench({ samples: 50, warmup: 5, label: "no-op" }, () => {})
    expect(result.label).toBe("no-op")
    expect(result.samples).toBe(50)
    expect(result.p50).toBeGreaterThanOrEqual(0)
    expect(result.p95).toBeGreaterThanOrEqual(result.p50)
    expect(result.p99).toBeGreaterThanOrEqual(result.p95)
    expect(result.min).toBeLessThanOrEqual(result.p50)
    expect(result.max).toBeGreaterThanOrEqual(result.p99)
    expect(result.mean).toBeGreaterThanOrEqual(0)
  })

  test("excludes warmup runs from the sample count", async () => {
    let calls = 0
    const result = await bench({ samples: 10, warmup: 3, label: "count" }, () => {
      calls++
    })
    expect(calls).toBe(13)
    expect(result.samples).toBe(10)
  })

  test("awaits async functions", async () => {
    let calls = 0
    await bench({ samples: 5, warmup: 0, label: "async" }, async () => {
      await Promise.resolve()
      calls++
    })
    expect(calls).toBe(5)
  })
})

describe("benchEffect", () => {
  test("runs the configured sample count inside Effect", async () => {
    let calls = 0
    const result = await Effect.runPromise(
      benchEffect({ samples: 8, warmup: 2, label: "eff" }, () =>
        Effect.sync(() => {
          calls++
        }),
      ),
    )
    expect(calls).toBe(10)
    expect(result.label).toBe("eff")
    expect(result.samples).toBe(8)
    expect(result.p50).toBeGreaterThanOrEqual(0)
  })
})

describe("writeBenchReport", () => {
  test("writes the bench results JSON and is idempotent on re-write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perf-test-"))
    try {
      const file = path.join(dir, "out.json")
      const a: BenchResult = { label: "a", samples: 1, p50: 1, p95: 2, p99: 3, min: 1, max: 3, mean: 2 }
      const b: BenchResult = { label: "b", samples: 2, p50: 4, p95: 5, p99: 6, min: 4, max: 6, mean: 5 }
      await writeBenchReport([a, b], file)
      const first = JSON.parse(await Bun.file(file).text())
      expect(first.results).toEqual([a, b])
      // overwrite with new payload
      await writeBenchReport([b], file)
      const second = JSON.parse(await Bun.file(file).text())
      expect(second.results).toEqual([b])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("DEFAULT_BUDGET", () => {
  test("matches the campaign regression budget", () => {
    expect(DEFAULT_BUDGET).toEqual({ p50_max_pct: 5, p95_max_pct: 10, p99_max_pct: 15 })
  })
})

describe("compareToBaseline", () => {
  const baseline: BenchResult = {
    label: "thing",
    samples: 1000,
    p50: 100,
    p95: 200,
    p99: 300,
    min: 50,
    max: 350,
    mean: 150,
  }

  async function withBaselineFile<T>(payload: unknown, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perf-baseline-"))
    const file = path.join(dir, "baseline.json")
    await Bun.write(file, JSON.stringify(payload))
    try {
      return await fn(file)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  test("returns a passing report when current is within budget", async () => {
    await withBaselineFile({ metrics: { thing: baseline } }, async (file) => {
      const current: BenchResult = { ...baseline, p50: 102, p95: 210, p99: 330 }
      const report = await compareToBaseline(current, file, "thing")
      expect(report.metric).toBe("thing")
      expect(report.passed).toBe(true)
      expect(report.reasons).toEqual([])
      expect(report.delta_p50_pct).toBeCloseTo(2, 5)
      expect(report.delta_p95_pct).toBeCloseTo(5, 5)
      expect(report.delta_p99_pct).toBeCloseTo(10, 5)
      expect(report.baseline).toEqual(baseline)
      expect(report.current).toEqual(current)
    })
  })

  test("returns a passing report when current is faster than baseline", async () => {
    await withBaselineFile({ metrics: { thing: baseline } }, async (file) => {
      const current: BenchResult = { ...baseline, p50: 50, p95: 80, p99: 120 }
      const report = await compareToBaseline(current, file, "thing")
      expect(report.passed).toBe(true)
      expect(report.delta_p50_pct).toBeLessThan(0)
    })
  })

  test("throws BenchBudgetExceededError when p50 exceeds budget", async () => {
    await withBaselineFile({ metrics: { thing: baseline } }, async (file) => {
      const current: BenchResult = { ...baseline, p50: 110, p95: 210, p99: 330 }
      const err = asBudgetError(await captureThrow(() => compareToBaseline(current, file, "thing")))
      expect(err.metric).toBe("thing")
      expect(err.reasons.some((r) => r.includes("p50"))).toBe(true)
    })
  })

  test("throws BenchBudgetExceededError when p95 exceeds budget", async () => {
    await withBaselineFile({ metrics: { thing: baseline } }, async (file) => {
      const current: BenchResult = { ...baseline, p50: 102, p95: 230, p99: 330 }
      const err = asBudgetError(await captureThrow(() => compareToBaseline(current, file, "thing")))
      expect(err.reasons.some((r) => r.includes("p95"))).toBe(true)
    })
  })

  test("throws BenchBudgetExceededError when p99 exceeds budget", async () => {
    await withBaselineFile({ metrics: { thing: baseline } }, async (file) => {
      const current: BenchResult = { ...baseline, p50: 102, p95: 210, p99: 360 }
      const err = asBudgetError(await captureThrow(() => compareToBaseline(current, file, "thing")))
      expect(err.reasons.some((r) => r.includes("p99"))).toBe(true)
    })
  })

  test("respects a custom budget", async () => {
    await withBaselineFile({ metrics: { thing: baseline } }, async (file) => {
      const current: BenchResult = { ...baseline, p50: 110, p95: 210, p99: 330 }
      // p50 went up 10% — exceeds default 5% but inside this generous custom budget
      const report = await compareToBaseline(current, file, "thing", {
        p50_max_pct: 20,
        p95_max_pct: 20,
        p99_max_pct: 20,
      })
      expect(report.passed).toBe(true)
    })
  })

  test("throws when the metric is missing from the baseline", async () => {
    await withBaselineFile({ metrics: {} }, async (file) => {
      const current: BenchResult = { ...baseline }
      const err = asError(await captureThrow(() => compareToBaseline(current, file, "missing")))
      expect(err.message).toContain("missing")
    })
  })

  test("throws when the baseline payload has no metrics object", async () => {
    await withBaselineFile({}, async (file) => {
      const current: BenchResult = { ...baseline }
      const err = asError(await captureThrow(() => compareToBaseline(current, file, "thing")))
      expect(err).toBeInstanceOf(Error)
    })
  })

  test("treats zero baseline values as 0% delta when current is also zero", async () => {
    const zero: BenchResult = { label: "z", samples: 1, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 }
    await withBaselineFile({ metrics: { z: zero } }, async (file) => {
      const report = await compareToBaseline(zero, file, "z")
      expect(report.passed).toBe(true)
      expect(report.delta_p50_pct).toBe(0)
      expect(report.delta_p95_pct).toBe(0)
      expect(report.delta_p99_pct).toBe(0)
    })
  })

  test("treats nonzero current against zero baseline as infinite regression", async () => {
    const zero: BenchResult = { label: "z", samples: 1, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 }
    const current: BenchResult = { label: "z", samples: 1, p50: 1, p95: 1, p99: 1, min: 1, max: 1, mean: 1 }
    await withBaselineFile({ metrics: { z: zero } }, async (file) => {
      const err = asBudgetError(await captureThrow(() => compareToBaseline(current, file, "z")))
      expect(err.delta_p50_pct).toBe(Number.POSITIVE_INFINITY)
    })
  })
})

describe("BenchBudgetExceededError", () => {
  test("formats a useful message", () => {
    const err = new BenchBudgetExceededError({
      metric: "x",
      delta_p50_pct: 7,
      delta_p95_pct: 0,
      delta_p99_pct: 0,
      budget: DEFAULT_BUDGET,
      reasons: ["p50 +7.0% > 5%"],
    })
    expect(err.message).toContain("x")
    expect(err.message).toContain("p50")
    expect(err._tag).toBe("BenchBudgetExceededError")
  })
})
