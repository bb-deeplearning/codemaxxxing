// Wave 14 e2e — final perf audit.
//
// Aggregates every per-wave perf JSON written across the campaign, plus
// the wave-0 baseline, into a single human-readable report at
// `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md`.
//
// For every baseline metric: finds the latest wave file that re-measured
// it, computes delta vs baseline (p50, p95, p99), applies the 5/10/15
// regression budget from PERF.md. Lists pass/fail per metric.
//
// For wave-introduced metrics (those without a baseline entry): records
// current values without a budget check.
//
// This test fails if any baseline-shared metric exceeds its budget.

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, it } from "bun:test"

interface BenchResult {
  label: string
  samples: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
}

interface PerfFile {
  captured_at: string
  git_sha: string
  bun_version?: string
  metrics: Record<string, BenchResult>
}

const BUDGET = { p50: 5, p95: 10, p99: 15 } as const

const ARTIFACTS_DIR = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  ".wave",
  "campaigns",
  "codex-parity-2026-05-13",
  "artifacts",
)
const BASELINE = path.join(ARTIFACTS_DIR, "baseline-perf.json")
const PERF_DIR = path.join(ARTIFACTS_DIR, "perf")
const REPORT = path.join(ARTIFACTS_DIR, "perf-final-report.md")

function deltaPct(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY
  return ((current - baseline) / baseline) * 100
}

function fmtNs(ns: number): string {
  if (ns < 1_000) return `${ns}ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}\u00b5s`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`
  return `${(ns / 1_000_000_000).toFixed(2)}s`
}

function fmtPct(p: number): string {
  const sign = p > 0 ? "+" : ""
  return `${sign}${p.toFixed(1)}%`
}

const HOT_PATH_GROUPS: ReadonlyArray<{ name: string; prefixes: ReadonlyArray<string> }> = [
  { name: "TUI render", prefixes: ["session.render", "process.render"] },
  { name: "runLoop", prefixes: ["runloop"] },
  { name: "Pty push / read", prefixes: ["pty"] },
  { name: "Permission", prefixes: ["permission"] },
  { name: "EventV2 / Bus", prefixes: ["eventv2", "bus"] },
  { name: "Snapshot", prefixes: ["snapshot"] },
  { name: "Mailbox", prefixes: ["mailbox"] },
  { name: "Multi-agent v2", prefixes: ["agentControl", "registry.", "head-tail", "process.exec", "process.write", "e2e"] },
]

function groupFor(label: string): string {
  for (const g of HOT_PATH_GROUPS) {
    if (g.prefixes.some((p) => label.startsWith(p))) return g.name
  }
  return "Other"
}

describe("e2e: final perf audit", () => {
  it(
    "every baseline metric stays within budget vs the latest wave that re-measured it",
    async () => {
      const baseline = (await Bun.file(BASELINE).json()) as PerfFile
      const waveFiles = (await fs.readdir(PERF_DIR))
        .filter((name) => /^wave_\d+\.json$/.test(name))
        .sort((a, b) => {
          const na = parseInt(a.match(/(\d+)/)![1]!, 10)
          const nb = parseInt(b.match(/(\d+)/)![1]!, 10)
          return na - nb
        })

      // metric -> latest wave file containing it
      const latestByMetric = new Map<string, { wave: string; value: BenchResult }>()
      const introducedByWave = new Map<string, BenchResult[]>()

      for (const file of waveFiles) {
        const wave = file.replace(".json", "")
        const data = (await Bun.file(path.join(PERF_DIR, file)).json()) as PerfFile
        for (const [name, value] of Object.entries(data.metrics)) {
          latestByMetric.set(name, { wave, value })
          if (!baseline.metrics[name]) {
            const list = introducedByWave.get(wave) ?? []
            list.push(value)
            introducedByWave.set(wave, list)
          }
        }
      }

      interface Row {
        metric: string
        baseline: BenchResult
        current: BenchResult
        wave: string
        d50: number
        d95: number
        d99: number
        passed: boolean
        reasons: string[]
      }

      const rows: Row[] = []
      for (const [name, base] of Object.entries(baseline.metrics)) {
        const re = latestByMetric.get(name)
        if (!re) continue
        const d50 = deltaPct(base.p50, re.value.p50)
        const d95 = deltaPct(base.p95, re.value.p95)
        const d99 = deltaPct(base.p99, re.value.p99)
        const reasons: string[] = []
        if (d50 > BUDGET.p50) reasons.push(`p50 ${fmtPct(d50)} > ${BUDGET.p50}%`)
        if (d95 > BUDGET.p95) reasons.push(`p95 ${fmtPct(d95)} > ${BUDGET.p95}%`)
        if (d99 > BUDGET.p99) reasons.push(`p99 ${fmtPct(d99)} > ${BUDGET.p99}%`)
        rows.push({
          metric: name,
          baseline: base,
          current: re.value,
          wave: re.wave,
          d50,
          d95,
          d99,
          passed: reasons.length === 0,
          reasons,
        })
      }

      const failed = rows.filter((r) => !r.passed)
      const passed = rows.filter((r) => r.passed)

      // Group rows by hot-path category for the summary section.
      const byGroup = new Map<string, Row[]>()
      for (const r of rows) {
        const g = groupFor(r.metric)
        const list = byGroup.get(g) ?? []
        list.push(r)
        byGroup.set(g, list)
      }

      const lines: string[] = []
      lines.push("# Codex Parity — Final Performance Audit")
      lines.push("")
      lines.push(`**Generated:** ${new Date().toISOString()}`)
      lines.push(`**Baseline:** wave_0 (${baseline.git_sha}, captured ${baseline.captured_at})`)
      lines.push(`**Budget:** p50 \u2264 ${BUDGET.p50}%, p95 \u2264 ${BUDGET.p95}%, p99 \u2264 ${BUDGET.p99}%`)
      lines.push("")
      lines.push("## Summary")
      lines.push("")
      lines.push(`- Baseline metrics tracked: **${rows.length}**`)
      lines.push(`- Within budget: **${passed.length}**`)
      lines.push(`- Over budget: **${failed.length}**`)
      lines.push(`- Wave-introduced metrics (no baseline; informational): **${[...introducedByWave.values()].reduce((acc, list) => acc + list.length, 0)}**`)
      lines.push("")
      lines.push(failed.length === 0 ? "**Result:** PASS \u2014 no regressions beyond budget." : `**Result:** FAIL \u2014 ${failed.length} metric(s) exceeded budget.`)
      lines.push("")

      if (failed.length > 0) {
        lines.push("## Failures")
        lines.push("")
        lines.push("| Metric | Wave | p50 | p95 | p99 | Reasons |")
        lines.push("|---|---|---|---|---|---|")
        for (const r of failed) {
          lines.push(
            `| \`${r.metric}\` | ${r.wave} | ${fmtPct(r.d50)} | ${fmtPct(r.d95)} | ${fmtPct(r.d99)} | ${r.reasons.join("; ")} |`,
          )
        }
        lines.push("")
      }

      lines.push("## Hot-path summary")
      lines.push("")
      for (const g of HOT_PATH_GROUPS) {
        const list = byGroup.get(g.name) ?? []
        if (list.length === 0) continue
        lines.push(`### ${g.name}`)
        lines.push("")
        lines.push("| Metric | Wave | Baseline p50 | Current p50 | \u0394p50 | \u0394p95 | \u0394p99 | Status |")
        lines.push("|---|---|---|---|---|---|---|---|")
        for (const r of list) {
          lines.push(
            `| \`${r.metric}\` | ${r.wave} | ${fmtNs(r.baseline.p50)} | ${fmtNs(r.current.p50)} | ${fmtPct(r.d50)} | ${fmtPct(r.d95)} | ${fmtPct(r.d99)} | ${r.passed ? "OK" : "FAIL"} |`,
          )
        }
        lines.push("")
      }

      // Wave-introduced metrics (no baseline comparison)
      const introWaves = [...introducedByWave.keys()].sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)![1]!, 10)
        const nb = parseInt(b.match(/(\d+)/)![1]!, 10)
        return na - nb
      })
      if (introWaves.length > 0) {
        lines.push("## Wave-introduced metrics (no baseline comparison)")
        lines.push("")
        lines.push("These metrics were added by individual waves and have no wave-0 reference. Recorded for future regression checks; budget cannot be applied retroactively.")
        lines.push("")
        for (const wave of introWaves) {
          const list = introducedByWave.get(wave)!
          lines.push(`### ${wave}`)
          lines.push("")
          lines.push("| Metric | Samples | p50 | p95 | p99 | min | max |")
          lines.push("|---|---|---|---|---|---|---|")
          for (const m of list.sort((a, b) => a.label.localeCompare(b.label))) {
            lines.push(
              `| \`${m.label}\` | ${m.samples} | ${fmtNs(m.p50)} | ${fmtNs(m.p95)} | ${fmtNs(m.p99)} | ${fmtNs(m.min)} | ${fmtNs(m.max)} |`,
            )
          }
          lines.push("")
        }
      }

      lines.push("## All baseline metrics (alphabetical)")
      lines.push("")
      lines.push("| Metric | Wave | Baseline p50 | Current p50 | \u0394p50 | Baseline p99 | Current p99 | \u0394p99 | Status |")
      lines.push("|---|---|---|---|---|---|---|---|---|")
      for (const r of [...rows].sort((a, b) => a.metric.localeCompare(b.metric))) {
        lines.push(
          `| \`${r.metric}\` | ${r.wave} | ${fmtNs(r.baseline.p50)} | ${fmtNs(r.current.p50)} | ${fmtPct(r.d50)} | ${fmtNs(r.baseline.p99)} | ${fmtNs(r.current.p99)} | ${fmtPct(r.d99)} | ${r.passed ? "OK" : "FAIL"} |`,
        )
      }
      lines.push("")

      // Baseline metrics NOT covered by any wave file (informational)
      const notRemeasured = Object.keys(baseline.metrics).filter((m) => !latestByMetric.has(m))
      if (notRemeasured.length > 0) {
        lines.push("## Baseline metrics not re-measured by any wave")
        lines.push("")
        lines.push("These baseline metrics had no wave-side bench file re-measure them. Their wave-0 captures stand as the reference; if a regression on these surfaces in production, future waves should add a corresponding bench.")
        lines.push("")
        for (const name of notRemeasured.sort()) {
          const m = baseline.metrics[name]!
          lines.push(`- \`${name}\` (p50=${fmtNs(m.p50)}, p99=${fmtNs(m.p99)})`)
        }
        lines.push("")
      }

      await Bun.write(REPORT, lines.join("\n"))

      // Assertion: no failures.
      expect(failed.map((r) => r.metric)).toEqual([])
    },
    30_000,
  )
})
