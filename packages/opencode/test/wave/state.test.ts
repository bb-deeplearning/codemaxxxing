import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { State, WaveRow, parse, serialize } from "../../src/wave/state"

const sample = `# Wave State

## Status

\`\`\`yaml
campaign_id: marketing-rebuild-2026-04-23
plan_source: .opencode/plans/copy-audit.md
executor_agent: caveman
executor_model: anthropic/claude-opus-4-7
executor_variant: 
current_wave: 17
wave_status: pending
loop_state: armed
active_session_id: null
total_waves: 33
session_count: 16
created: 2026-04-23
last_updated: 2026-04-26
\`\`\`

## Wave Progress

| Wave | Status   | Session | Commit  | Notes              |
|------|----------|---------|---------|--------------------|
| 0    | complete | 01H..a  | a1b2c3d | foundation fixes   |
| 16   | complete | 01H..p  | f0e1d2c | doc-set rewrite    |
| 17   | pending  | —       | —       | foundation fixes 2 |
`

describe("wave state", () => {
  test("parse extracts yaml + table", async () => {
    const result = await Effect.runPromise(parse(sample))
    expect(result.campaign_id).toBe("marketing-rebuild-2026-04-23")
    expect(result.executor_agent).toBe("caveman")
    expect(result.current_wave).toBe(17)
    expect(result.wave_status).toBe("pending")
    expect(result.loop_state).toBe("armed")
    expect(result.active_session_id).toBeNull()
    expect(result.total_waves).toBe(33)
    expect(result.waves.length).toBe(3)
    expect(result.waves[0]?.n).toBe(0)
    expect(result.waves[0]?.status).toBe("complete")
    expect(result.waves[0]?.commit_sha).toBe("a1b2c3d")
    expect(result.waves[2]?.session_id).toBeNull()
  })

  test("serialize roundtrips through parse", async () => {
    const original = await Effect.runPromise(parse(sample))
    const serialized = serialize(original, sample)
    const reparsed = await Effect.runPromise(parse(serialized))
    expect(reparsed.campaign_id).toBe(original.campaign_id)
    expect(reparsed.current_wave).toBe(original.current_wave)
    expect(reparsed.waves.length).toBe(original.waves.length)
    expect(reparsed.waves[0]?.commit_sha).toBe(original.waves[0]?.commit_sha)
  })

  test("serialize from scratch produces parseable output", async () => {
    const built = new State({
      campaign_id: "test-2026-05-04",
      plan_source: ".opencode/plans/test.md",
      executor_agent: "build",
      executor_model: "anthropic/claude-opus-4-7",
      executor_variant: "",
      current_wave: 0,
      wave_status: "pending",
      loop_state: "idle",
      active_session_id: null,
      total_waves: 2,
      session_count: 0,
      created: "2026-05-04",
      last_updated: "2026-05-04",
      waves: [
        new WaveRow({ n: 0, status: "pending", session_id: null, commit_sha: null, notes: "first" }),
        new WaveRow({ n: 1, status: "pending", session_id: null, commit_sha: null, notes: "second" }),
      ],
    })
    const text = serialize(built)
    const parsed = await Effect.runPromise(parse(text))
    expect(parsed.campaign_id).toBe("test-2026-05-04")
    expect(parsed.waves.length).toBe(2)
    expect(parsed.waves[1]?.notes).toBe("second")
  })

  test("notes with pipes are escaped + recoverable on roundtrip", async () => {
    const built = new State({
      campaign_id: "x-2026-05-04",
      plan_source: "x.md",
      executor_agent: "build",
      executor_model: "p/m",
      executor_variant: "",
      current_wave: 0,
      wave_status: "pending",
      loop_state: "idle",
      active_session_id: null,
      total_waves: 1,
      session_count: 0,
      created: "2026-05-04",
      last_updated: "2026-05-04",
      waves: [new WaveRow({ n: 0, status: "pending", session_id: null, commit_sha: null, notes: "a | b" })],
    })
    const text = serialize(built)
    const parsed = await Effect.runPromise(parse(text))
    expect(parsed.waves[0]?.notes).toContain("a")
    expect(parsed.waves[0]?.notes).toContain("b")
  })

  test("missing required key returns ParseError", async () => {
    const broken = `# Wave State

## Status

\`\`\`yaml
campaign_id: x
\`\`\`
`
    const result = await Effect.runPromiseExit(parse(broken))
    expect(result._tag).toBe("Failure")
  })
})
