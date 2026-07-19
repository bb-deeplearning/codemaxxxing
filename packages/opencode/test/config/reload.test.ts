/* config hot-reload, end to end: real watcher, real layers, real files in
   the preload's isolated XDG config dir. no mocks — the pipeline under test
   is exactly what a serve runs. */

import { afterAll, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { computeChangedSlices } from "@/config/reload"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { AppRuntime } from "@/effect/app-runtime"
import { FileWatcher } from "@/file/watcher"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/* ---- slice diffing, pure ---- */

test("computeChangedSlices: core keys flag core only", () => {
  expect(computeChangedSlices({ username: "a" }, { username: "b" })).toEqual({ core: true, gated: [] })
})

test("computeChangedSlices: mcp slice is gated, not core", () => {
  expect(computeChangedSlices({ mcp: { a: { type: "local", command: ["x"] } } } as never, {} as never)).toEqual({
    core: false,
    gated: ["mcp"],
  })
})

test("computeChangedSlices: plugin_origins maps to the plugin gate", () => {
  expect(computeChangedSlices({ plugin_origins: [{ spec: "x" }] } as never, {} as never)).toEqual({
    core: false,
    gated: ["plugin"],
  })
})

test("computeChangedSlices: identical configs change nothing", () => {
  const cfg = { username: "same", mcp: { a: { type: "local" } } } as never
  expect(computeChangedSlices(cfg, cfg)).toEqual({ core: false, gated: [] })
})

test("computeChangedSlices: mixed edit flags both", () => {
  expect(
    computeChangedSlices({ username: "a" }, { username: "b", lsp: { ts: { command: ["x"] } } } as never),
  ).toEqual({ core: true, gated: ["lsp"] })
})

/* ---- the real pipeline ---- */

/* opencode.jsonc merges LAST in loadGlobal, so it wins against any
   config.json / opencode.json leftovers other suites wrote into the shared
   temp config dir. writing anything else here makes this test order-
   dependent inside the full suite. */
const globalConfigFile = path.join(Global.Path.config, "opencode.jsonc")

const poll = async <T>(fn: () => Promise<T>, ok: (value: T) => boolean, ms: number) => {
  const until = Date.now() + ms
  let last: T = await fn()
  while (Date.now() < until) {
    if (ok(last)) return last
    await Bun.sleep(150)
    last = await fn()
  }
  return last
}

afterAll(async () => {
  await fs.rm(globalConfigFile, { force: true })
  await disposeAllInstances()
})

test.skipIf(!FileWatcher.hasNativeBinding())(
  "config file edits hot-reload live instances and publish config.updated",
  async () => {
    const dir = (await tmpdir()).path
    const frames: { directory?: string; type?: string; changed?: unknown }[] = []
    const onFrame = (frame: {
      directory?: string
      payload?: { type?: string; properties?: { changed?: unknown } }
    }) => {
      if (frame.payload?.type !== "config.updated") return
      frames.push({ directory: frame.directory, type: frame.payload.type, changed: frame.payload.properties?.changed })
    }
    GlobalBus.on("event", onFrame)

    try {
      // a live instance whose config-derived caches should flush
      await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory: dir })))
      const before = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide({ directory: dir }, Config.Service.use((config) => config.get())),
        ),
      )
      expect(before.username).not.toBe("hot-reload-proof")

      // 1. clean edit propagates without any restart
      await fs.writeFile(globalConfigFile, JSON.stringify({ username: "hot-reload-proof" }))
      const reloaded = await poll(
        () =>
          AppRuntime.runPromise(
            InstanceStore.Service.use((store) =>
              store.provide({ directory: dir }, Config.Service.use((config) => config.get())),
            ),
          ),
        (cfg) => cfg.username === "hot-reload-proof",
        30_000,
      )
      expect(reloaded.username).toBe("hot-reload-proof")
      expect(frames.some((f) => f.directory === dir)).toBe(true)

      // 2. a broken file mid-edit never downgrades the live config
      const framesBeforeBroken = frames.length
      await fs.writeFile(globalConfigFile, "{ this is not jsonc")
      await Bun.sleep(1500)
      const afterBroken = await AppRuntime.runPromise(Config.Service.use((config) => config.getGlobal()))
      expect(afterBroken.username).toBe("hot-reload-proof")
      expect(frames.length).toBe(framesBeforeBroken)

      // 3. fixing the file resumes reloads
      await fs.writeFile(globalConfigFile, JSON.stringify({ username: "fixed" }))
      const fixed = await poll(
        () => AppRuntime.runPromise(Config.Service.use((config) => config.getGlobal())),
        (cfg) => cfg.username === "fixed",
        30_000,
      )
      expect(fixed.username).toBe("fixed")
    } finally {
      GlobalBus.off("event", onFrame)
    }
  },
  90_000,
)
