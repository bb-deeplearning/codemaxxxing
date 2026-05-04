#!/usr/bin/env bun
// Materialise a dummy wave campaign for VHS demos / manual TUI inspection.
//
// Usage:
//   bun script/wave-demo-fixture.ts <target-directory>
//
// Creates target/.wave/active + target/.wave/campaigns/<id>/ with a populated
// STATE.md showing a mid-flight campaign (16 done, 17 running, 18+ pending).
// Idempotent — overwrites whatever exists.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const target = process.argv[2]
if (!target) {
  console.error("usage: bun script/wave-demo-fixture.ts <target-directory>")
  process.exit(1)
}

const id = "marketing-rebuild-2026-04-23"
const root = join(target, ".wave")
const campaign = join(root, "campaigns", id)
const planDir = join(campaign, "plan")
const wavesDir = join(planDir, "waves")

mkdirSync(wavesDir, { recursive: true })
mkdirSync(join(campaign, "artifacts"), { recursive: true })

writeFileSync(join(root, "active"), `${id}\n`)

writeFileSync(
  join(planDir, "AGENT_INSTRUCTIONS.md"),
  `# Agent Entry Point — Wave Executor

## Start Here

1. Read STATE.md (one level up from this file).
2. If wave_status: all_complete → print WAVES DONE and stop.
3. Read OVERVIEW.md.
4. Read waves/wave_{current_wave}/WAVE.md.
5. Execute. Verify. Commit. Update STATE.md.

(Demo fixture — not a real campaign.)
`,
)

writeFileSync(
  join(planDir, "OVERVIEW.md"),
  `# Demo Campaign — Marketing Rebuild

This is a fixture used by the wave-dashboard VHS tape. It exists so
the dashboard has something interesting to render.
`,
)

const waves = [
  { n: 0, status: "complete", session: "ses_01H1abc1abc1abc", commit: "a1b2c3d", note: "foundation fixes" },
  { n: 1, status: "complete", session: "ses_01H2def2def2def", commit: "e4f5g6h", note: "master plan page" },
  { n: 2, status: "complete", session: "ses_01H3ghi3ghi3ghi", commit: "i7j8k9l", note: "home page rebuild" },
  { n: 3, status: "complete", session: "ses_01H4jkl4jkl4jkl", commit: "m1n2o3p", note: "about page rebuild" },
  { n: 4, status: "complete", session: "ses_01H5mno5mno5mno", commit: "q4r5s6t", note: "auth surface rebuild" },
  { n: 5, status: "complete", session: "ses_01H6pqr6pqr6pqr", commit: "u7v8w9x", note: "first audit pass" },
  {
    n: 6,
    status: "running",
    session: "ses_01H7stu7stu7stu",
    commit: null,
    note: "remediation: dark-mode oxblood + cp-h2 sizing + tnum whitespace",
  },
  { n: 7, status: "pending", session: null, commit: null, note: "pricing page rebuild" },
  { n: 8, status: "pending", session: null, commit: null, note: "demo gallery + detail" },
  { n: 9, status: "pending", session: null, commit: null, note: "showcase polish" },
  { n: 10, status: "pending", session: null, commit: null, note: "footer + navbar polish" },
  { n: 11, status: "pending", session: null, commit: null, note: "section-level typography" },
  { n: 12, status: "pending", session: null, commit: null, note: "second audit pass" },
  { n: 13, status: "pending", session: null, commit: null, note: "wave 12 remediation" },
  { n: 14, status: "pending", session: null, commit: null, note: "cross-surface verify + a11y + OG" },
  { n: 15, status: "pending", session: null, commit: null, note: "final audit pass" },
] as const

for (const w of waves) {
  const dir = join(wavesDir, `wave_${w.n}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "WAVE.md"), `# Wave ${w.n}\n\nGoal: ${w.note}\n`)
}

const tableRow = (w: (typeof waves)[number]) =>
  `| ${w.n} | ${w.status.padEnd(8)} | ${w.session ?? "—"} | ${w.commit ?? "—"} | ${w.note} |`

const state = `# Wave State

## Status

\`\`\`yaml
campaign_id: ${id}
plan_source: .opencode/plans/marketing-rebuild.md
executor_agent: caveman
executor_model: anthropic/claude-opus-4-7
executor_variant: 
current_wave: 6
wave_status: running
loop_state: armed
active_session_id: ses_01H7stu7stu7stu
total_waves: ${waves.length}
session_count: 6
created: 2026-04-23
last_updated: 2026-04-26
\`\`\`

## Wave Progress

| Wave | Status   | Session                | Commit  | Notes |
|------|----------|------------------------|---------|-------|
${waves.map(tableRow).join("\n")}
`

writeFileSync(join(campaign, "STATE.md"), state)

console.log(`wave demo fixture written to ${root}`)
console.log(`active campaign: ${id}`)
