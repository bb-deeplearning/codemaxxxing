import { Effect, Schema } from "effect"

// STATE.md format — canonical single source of truth for a campaign.
//
// Two parts: a fenced ```yaml block under "## Status" with FSM cursor + config,
// and a markdown table under "## Wave Progress" with one row per wave.
//
// Both the wave executor agent (in a separate process per wave) and the TUI
// controller read + edit this file. Coordination: TUI writes only between
// waves (when wave_status is pending/complete), agent writes only during its
// turn (when wave_status is running). No concurrent writers.

export const WaveStatus = Schema.Literals(["pending", "running", "complete", "failed", "all_complete"])
export type WaveStatus = Schema.Schema.Type<typeof WaveStatus>

export const LoopState = Schema.Literals(["idle", "armed", "paused"])
export type LoopState = Schema.Schema.Type<typeof LoopState>

export const RowStatus = Schema.Literals(["pending", "running", "complete", "failed", "cancelled"])
export type RowStatus = Schema.Schema.Type<typeof RowStatus>

const ROW_STATUSES = ["pending", "running", "complete", "failed", "cancelled"] as const

export class WaveRow extends Schema.Class<WaveRow>("@opencode/WaveRow")({
  n: Schema.Number,
  status: RowStatus,
  session_id: Schema.NullOr(Schema.String),
  commit_sha: Schema.NullOr(Schema.String),
  notes: Schema.String,
}) {}

export class State extends Schema.Class<State>("@opencode/WaveState")({
  campaign_id: Schema.String,
  plan_source: Schema.String,
  executor_agent: Schema.String,
  executor_model: Schema.String,
  executor_variant: Schema.String,
  current_wave: Schema.Number,
  wave_status: WaveStatus,
  loop_state: LoopState,
  active_session_id: Schema.NullOr(Schema.String),
  total_waves: Schema.Number,
  session_count: Schema.Number,
  created: Schema.String,
  last_updated: Schema.String,
  waves: Schema.Array(WaveRow),
}) {}

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("@opencode/WaveStateParseError", {
  reason: Schema.String,
}) {}

const YAML_BLOCK_RE = /## Status\s*\n+```ya?ml\n([\s\S]*?)\n```/
const TABLE_RE = /## Wave Progress\s*\n+\|[^\n]+\|\s*\n\|[-:\s|]+\|\s*\n((?:\|[^\n]+\|\s*\n?)+)/
const REQUIRED_KEYS = [
  "campaign_id",
  "plan_source",
  "executor_agent",
  "executor_model",
  "current_wave",
  "wave_status",
  "total_waves",
  "created",
] as const

const stripQuotes = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1)
    : raw

const parseYaml = (block: string): Record<string, string> =>
  Object.fromEntries(
    block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .flatMap((line) => {
        const idx = line.indexOf(":")
        if (idx < 0) return []
        return [[line.slice(0, idx).trim(), stripQuotes(line.slice(idx + 1).trim())]] as const
      }),
  )

const isRowStatus = (s: string): s is RowStatus => (ROW_STATUSES as readonly string[]).includes(s)

// Split a table row on unescaped `|` so cells containing `\|` survive parse.
const splitCells = (line: string): string[] => {
  const cells: string[] = []
  let buf = ""
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === "\\" && line[i + 1] === "|") {
      buf += "|"
      i += 2
      continue
    }
    if (ch === "|") {
      cells.push(buf.trim())
      buf = ""
      i += 1
      continue
    }
    buf += ch
    i += 1
  }
  cells.push(buf.trim())
  return cells
}

const parseTable = (block: string): WaveRow[] =>
  block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .flatMap((line) => {
      const cells = splitCells(line.slice(1, line.endsWith("|") ? -1 : undefined))
      if (cells.length < 5) return []
      const n = Number(cells[0])
      if (!Number.isFinite(n)) return []
      return [
        new WaveRow({
          n,
          status: isRowStatus(cells[1]) ? cells[1] : "pending",
          session_id: cells[2] === "—" || cells[2] === "" ? null : cells[2],
          commit_sha: cells[3] === "—" || cells[3] === "" ? null : cells[3],
          notes: cells[4],
        }),
      ]
    })
    .sort((a, b) => a.n - b.n)

const serializeYaml = (state: State) =>
  [
    `campaign_id: ${state.campaign_id}`,
    `plan_source: ${state.plan_source}`,
    `executor_agent: ${state.executor_agent}`,
    `executor_model: ${state.executor_model}`,
    `executor_variant: ${state.executor_variant}`,
    `current_wave: ${state.current_wave}`,
    `wave_status: ${state.wave_status}`,
    `loop_state: ${state.loop_state}`,
    `active_session_id: ${state.active_session_id ?? "null"}`,
    `total_waves: ${state.total_waves}`,
    `session_count: ${state.session_count}`,
    `created: ${state.created}`,
    `last_updated: ${state.last_updated}`,
  ].join("\n")

const escapeCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ")

const serializeTable = (rows: ReadonlyArray<WaveRow>) =>
  [
    "| Wave | Status   | Session | Commit | Notes |",
    "|------|----------|---------|--------|-------|",
    ...rows.map(
      (r) =>
        `| ${r.n} | ${r.status.padEnd(8)} | ${r.session_id ?? "—"} | ${r.commit_sha ?? "—"} | ${escapeCell(r.notes)} |`,
    ),
  ].join("\n")

export const parse = (text: string) =>
  Effect.gen(function* () {
    const yamlMatch = text.match(YAML_BLOCK_RE)
    if (!yamlMatch) return yield* new ParseError({ reason: "missing fenced yaml block under '## Status'" })
    const yaml = parseYaml(yamlMatch[1])

    const missing = REQUIRED_KEYS.find((k) => yaml[k] === undefined)
    if (missing) return yield* new ParseError({ reason: `missing required key: ${missing}` })

    const tableMatch = text.match(TABLE_RE)
    const session = yaml["active_session_id"]
    return new State({
      campaign_id: yaml["campaign_id"]!,
      plan_source: yaml["plan_source"]!,
      executor_agent: yaml["executor_agent"]!,
      executor_model: yaml["executor_model"] ?? "",
      executor_variant: yaml["executor_variant"] ?? "",
      current_wave: Number(yaml["current_wave"]),
      wave_status: yaml["wave_status"] as WaveStatus,
      loop_state: (yaml["loop_state"] as LoopState) ?? "idle",
      active_session_id: !session || session === "null" || session === "—" ? null : session,
      total_waves: Number(yaml["total_waves"]),
      session_count: Number(yaml["session_count"] ?? "0"),
      created: yaml["created"]!,
      last_updated: yaml["last_updated"] ?? yaml["created"]!,
      waves: tableMatch ? parseTable(tableMatch[1]) : [],
    })
  })

// Roundtrips through parse() — preserves the "# Wave State" frontispiece and
// any additional sections the agent has appended. Updates the YAML block +
// table in place; everything else stays.
export const serialize = (state: State, previous?: string) => {
  const yamlBody = serializeYaml(state)
  const tableBody = serializeTable(state.waves)
  if (previous) {
    return previous
      .replace(YAML_BLOCK_RE, `## Status\n\n\`\`\`yaml\n${yamlBody}\n\`\`\``)
      .replace(TABLE_RE, `## Wave Progress\n\n${tableBody}\n`)
  }
  return [
    "# Wave State",
    "",
    "## Status",
    "",
    "```yaml",
    yamlBody,
    "```",
    "",
    "## Wave Progress",
    "",
    tableBody,
    "",
  ].join("\n")
}

export * as WaveState from "./state"
