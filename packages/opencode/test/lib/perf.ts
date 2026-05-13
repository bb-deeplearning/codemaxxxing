import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"

export interface BenchOptions {
  samples: number
  warmup: number
  label: string
}

export interface BenchResult {
  label: string
  samples: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
}

export interface RegressionBudget {
  p50_max_pct: number
  p95_max_pct: number
  p99_max_pct: number
}

export const DEFAULT_BUDGET: RegressionBudget = {
  p50_max_pct: 5,
  p95_max_pct: 10,
  p99_max_pct: 15,
}

export interface RegressionReport {
  metric: string
  baseline: BenchResult
  current: BenchResult
  delta_p50_pct: number
  delta_p95_pct: number
  delta_p99_pct: number
  passed: boolean
  reasons: string[]
}

export class BenchBudgetExceededError extends Schema.TaggedErrorClass<BenchBudgetExceededError>()(
  "BenchBudgetExceededError",
  {
    metric: Schema.String,
    delta_p50_pct: Schema.Number,
    delta_p95_pct: Schema.Number,
    delta_p99_pct: Schema.Number,
    budget: Schema.Struct({
      p50_max_pct: Schema.Number,
      p95_max_pct: Schema.Number,
      p99_max_pct: Schema.Number,
    }),
    reasons: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Bench '${this.metric}' exceeded regression budget: ${this.reasons.join("; ")}`
  }
}

export function percentiles(samples: ReadonlyArray<number>): Pick<BenchResult, "p50" | "p95" | "p99" | "min" | "max" | "mean"> {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  // Nearest-rank percentile: at quantile q, return sorted[ceil(q * n) - 1].
  // For n=100 this gives p50 = sorted[49] = 50, matching standard conventions.
  const at = (q: number) => sorted[Math.max(0, Math.min(n - 1, Math.ceil(q * n) - 1))]
  let sum = 0
  for (const s of sorted) sum += s
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
  }
}

export async function bench(opts: BenchOptions, fn: () => Promise<void> | void): Promise<BenchResult> {
  for (let i = 0; i < opts.warmup; i++) await fn()
  const samples = Array.from<number>({ length: opts.samples })
  for (let i = 0; i < opts.samples; i++) {
    const start = Bun.nanoseconds()
    await fn()
    samples[i] = Bun.nanoseconds() - start
  }
  return {
    label: opts.label,
    samples: opts.samples,
    ...percentiles(samples),
  }
}

// Effect-native variant. Avoids per-call `Effect.runPromise` entry cost so the
// measurement reflects what callers experience inside an existing Effect.
export const benchEffect = <E, R>(
  opts: BenchOptions,
  fn: () => Effect.Effect<void, E, R>,
): Effect.Effect<BenchResult, E, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < opts.warmup; i++) yield* fn()
    const samples = Array.from<number>({ length: opts.samples })
    for (let i = 0; i < opts.samples; i++) {
      const start = Bun.nanoseconds()
      yield* fn()
      samples[i] = Bun.nanoseconds() - start
    }
    return {
      label: opts.label,
      samples: opts.samples,
      ...percentiles(samples),
    }
  })

export async function writeBenchReport(results: ReadonlyArray<BenchResult>, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await Bun.write(outPath, JSON.stringify({ results }, null, 2))
}

function deltaPct(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY
  return ((current - baseline) / baseline) * 100
}

export async function compareToBaseline(
  current: BenchResult,
  baselinePath: string,
  metric: string,
  budget: RegressionBudget = DEFAULT_BUDGET,
): Promise<RegressionReport> {
  const raw = (await Bun.file(baselinePath).json()) as unknown as { metrics?: Record<string, BenchResult> }
  const baseline = raw.metrics?.[metric]
  if (!baseline) throw new Error(`Baseline metric '${metric}' missing from ${baselinePath}`)

  const delta_p50_pct = deltaPct(baseline.p50, current.p50)
  const delta_p95_pct = deltaPct(baseline.p95, current.p95)
  const delta_p99_pct = deltaPct(baseline.p99, current.p99)

  const reasons: string[] = []
  if (delta_p50_pct > budget.p50_max_pct) {
    reasons.push(`p50 +${delta_p50_pct.toFixed(1)}% > ${budget.p50_max_pct}%`)
  }
  if (delta_p95_pct > budget.p95_max_pct) {
    reasons.push(`p95 +${delta_p95_pct.toFixed(1)}% > ${budget.p95_max_pct}%`)
  }
  if (delta_p99_pct > budget.p99_max_pct) {
    reasons.push(`p99 +${delta_p99_pct.toFixed(1)}% > ${budget.p99_max_pct}%`)
  }

  const report: RegressionReport = {
    metric,
    baseline,
    current,
    delta_p50_pct,
    delta_p95_pct,
    delta_p99_pct,
    passed: reasons.length === 0,
    reasons,
  }

  if (!report.passed) {
    throw new BenchBudgetExceededError({
      metric,
      delta_p50_pct,
      delta_p95_pct,
      delta_p99_pct,
      budget,
      reasons,
    })
  }

  return report
}
