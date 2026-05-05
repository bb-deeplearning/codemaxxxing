import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import path from "path"
import { mkdir, writeFile } from "node:fs/promises"
import { State, WaveRow, serialize } from "../../src/wave/state"
import { Wave } from "../../src/wave/wave"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Wave.defaultLayer)

const sampleState = (overrides: Partial<State> = {}) =>
  new State({
    campaign_id: "demo-2026-05-04",
    plan_source: ".opencode/plans/demo.md",
    executor_agent: "caveman",
    executor_model: "anthropic/claude-opus-4-7",
    executor_variant: "",
    current_wave: 1,
    wave_status: "pending",
    failure_kind: "",
    retry_count: 0,
    verify_count: 0,
    user_question: "",
    loop_state: "idle",
    active_session_id: null,
    total_waves: 2,
    session_count: 1,
    created: "2026-05-04",
    last_updated: "2026-05-04",
    waves: [
      new WaveRow({ n: 0, status: "complete", session_id: "ses_a", commit_sha: "abc1234", notes: "first" }),
      new WaveRow({ n: 1, status: "pending", session_id: null, commit_sha: null, notes: "second" }),
    ],
    ...overrides,
  })

const writeCampaignFile = (dir: string, id: string, text: string) =>
  Effect.promise(async () => {
    const campaign = path.join(dir, ".wave", "campaigns", id)
    await mkdir(campaign, { recursive: true })
    await writeFile(path.join(campaign, "STATE.md"), text)
  })

describe("Wave service", () => {
  it.instance("listCampaigns is empty when no .wave/", () =>
    Effect.gen(function* () {
      const wave = yield* Wave.Service
      const list = yield* wave.listCampaigns()
      expect(list).toEqual([])
    }),
  )

  it.instance("listCampaigns returns ids that have STATE.md, sorted", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeCampaignFile(test.directory, "alpha", serialize(sampleState({ campaign_id: "alpha" })))
      yield* writeCampaignFile(test.directory, "beta", serialize(sampleState({ campaign_id: "beta" })))
      const empty = path.join(test.directory, ".wave", "campaigns", "no-state")
      yield* Effect.promise(() => mkdir(empty, { recursive: true }))

      const wave = yield* Wave.Service
      const list = yield* wave.listCampaigns()
      expect(list).toEqual(["alpha", "beta"])
    }),
  )

  it.instance("getActive returns None when active file missing", () =>
    Effect.gen(function* () {
      const wave = yield* Wave.Service
      const active = yield* wave.getActive()
      expect(Option.isNone(active)).toBe(true)
    }),
  )

  it.instance("setActive + getActive roundtrip; setActive(null) clears", () =>
    Effect.gen(function* () {
      const wave = yield* Wave.Service
      yield* wave.setActive("alpha")
      const some = yield* wave.getActive()
      expect(Option.isSome(some)).toBe(true)
      expect(Option.getOrNull(some)).toBe("alpha")

      yield* wave.setActive(null)
      const none = yield* wave.getActive()
      expect(Option.isNone(none)).toBe(true)
    }),
  )

  it.instance("read fails with CampaignNotFound when STATE.md missing", () =>
    Effect.gen(function* () {
      const wave = yield* Wave.Service
      const exit = yield* Effect.exit(wave.read("nope"))
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("read parses STATE.md", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeCampaignFile(test.directory, "alpha", serialize(sampleState({ campaign_id: "alpha" })))
      const wave = yield* Wave.Service
      const state = yield* wave.read("alpha")
      expect(state.campaign_id).toBe("alpha")
      expect(state.waves.length).toBe(2)
    }),
  )

  it.instance("readActive composes getActive + read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeCampaignFile(test.directory, "alpha", serialize(sampleState({ campaign_id: "alpha" })))
      const wave = yield* Wave.Service
      yield* wave.setActive("alpha")
      const opt = yield* wave.readActive()
      expect(Option.isSome(opt)).toBe(true)
      expect(Option.getOrNull(opt)?.campaign_id).toBe("alpha")
    }),
  )

  it.instance("readActive returns None when active points at a missing campaign", () =>
    Effect.gen(function* () {
      const wave = yield* Wave.Service
      yield* wave.setActive("ghost")
      const opt = yield* wave.readActive()
      expect(Option.isNone(opt)).toBe(true)
    }),
  )

  it.instance("write updates STATE.md and preserves the surrounding markdown", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const original = serialize(sampleState({ campaign_id: "alpha" }))
      const withTrailer = `${original}\n## Notes\n\nhand-written agent notes\n`
      yield* writeCampaignFile(test.directory, "alpha", withTrailer)

      const wave = yield* Wave.Service
      yield* wave.write(
        "alpha",
        sampleState({ campaign_id: "alpha", current_wave: 5, wave_status: "running" }),
      )

      const text = yield* Effect.promise(() =>
        Bun.file(path.join(test.directory, ".wave", "campaigns", "alpha", "STATE.md")).text(),
      )
      expect(text).toContain("current_wave: 5")
      expect(text).toContain("wave_status: running")
      expect(text).toContain("hand-written agent notes")
    }),
  )

  it.instance("update applies a function over the current state", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeCampaignFile(test.directory, "alpha", serialize(sampleState({ campaign_id: "alpha" })))
      const wave = yield* Wave.Service
      const next = yield* wave.update("alpha", (s) => new State({ ...s, loop_state: "armed" }))
      expect(next.loop_state).toBe("armed")
      const reread = yield* wave.read("alpha")
      expect(reread.loop_state).toBe("armed")
    }),
  )
})
