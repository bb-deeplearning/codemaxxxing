import { $ } from "bun"
import { afterEach, describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Worktree.defaultLayer, CrossSpawnSpawner.defaultLayer))
const wintest = process.platform !== "win32" ? it.live : it.live.skip

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

async function waitReady() {
  const { GlobalBus } = await import("../../src/bus/global")

  return await new Promise<{ name: string; branch?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error("timed out waiting for worktree.ready"))
    }, 10_000)

    function on(evt: { directory?: string; payload: { type: string; properties: { name: string; branch?: string } } }) {
      if (evt.payload.type !== Worktree.Event.Ready.type) return
      clearTimeout(timer)
      GlobalBus.off("event", on)
      resolve(evt.payload.properties)
    }

    GlobalBus.on("event", on)
  })
}

async function waitFailed() {
  const { GlobalBus } = await import("../../src/bus/global")

  return await new Promise<{ message: string; log?: string; directory?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error("timed out waiting for worktree.failed"))
    }, 15_000)

    function on(evt: {
      directory?: string
      payload: { type: string; properties: { message: string; log?: string } }
    }) {
      if (evt.payload.type !== Worktree.Event.Failed.type) return
      clearTimeout(timer)
      GlobalBus.off("event", on)
      resolve({ ...evt.payload.properties, directory: evt.directory })
    }

    GlobalBus.on("event", on)
  })
}

async function readyFlag() {
  const { GlobalBus } = await import("../../src/bus/global")
  const flag = { fired: false }
  function on(evt: { payload: { type: string } }) {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    flag.fired = true
  }
  GlobalBus.on("event", on)
  return { flag, stop: () => GlobalBus.off("event", on) }
}

describe("Worktree", () => {
  afterEach(() => disposeAllInstances())

  describe("makeWorktreeInfo", () => {
    it.live("returns info with name, branch, and directory", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo()

            expect(info.name).toBeDefined()
            expect(typeof info.name).toBe("string")
            expect(info.branch).toBe(`opencode/${info.name}`)
            expect(info.directory).toContain(info.name)
          }),
        { git: true },
      ),
    )

    it.live("uses provided name as base", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo({ name: "my-feature" })

            expect(info.name).toBe("my-feature")
            expect(info.branch).toBe("opencode/my-feature")
          }),
        { git: true },
      ),
    )

    it.live("slugifies the provided name", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" })

            expect(info.name).toBe("my-feature-branch")
          }),
        { git: true },
      ),
    )

    it.live("throws NotGitError for non-git directories", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const exit = yield* Effect.exit(svc.makeWorktreeInfo())

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
        }),
      ),
    )
  })

  describe("create + remove lifecycle", () => {
    it.live("create returns worktree info and remove cleans up", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.create()

            expect(info.name).toBeDefined()
            expect(info.branch).toStartWith("opencode/")
            expect(info.directory).toBeDefined()

            yield* Effect.promise(() => Bun.sleep(1000))

            const ok = yield* svc.remove({ directory: info.directory })
            expect(ok).toBe(true)
          }),
        { git: true },
      ),
    )

    it.live("create returns after setup and fires Event.Ready after bootstrap", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()

            expect(info.name).toBeDefined()
            expect(info.branch).toStartWith("opencode/")

            const text = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(dir).quiet().text())
            const next = yield* Effect.promise(() => fs.realpath(info.directory).catch(() => info.directory))
            expect(normalize(text)).toContain(normalize(next))

            const props = yield* Effect.promise(() => ready)
            expect(props.name).toBe(info.name)
            expect(info.branch).toBeDefined()
            expect(props.branch).toBe(info.branch!)

            yield* Effect.promise(() =>
              WithInstance.provide({
                directory: info.directory,
                fn: () => InstanceRuntime.disposeInstance(Instance.current),
              }),
            )
            yield* Effect.promise(() => Bun.sleep(100))
            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )

    it.live("create with custom name", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create({ name: "test-workspace" })

            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("opencode/test-workspace")

            yield* Effect.promise(() => ready)
            yield* Effect.promise(() =>
              WithInstance.provide({
                directory: info.directory,
                fn: () => InstanceRuntime.disposeInstance(Instance.current),
              }),
            )
            yield* Effect.promise(() => Bun.sleep(100))
            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )
  })

  describe("createFromInfo", () => {
    wintest("creates and bootstraps git worktree", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" })
            yield* svc.createFromInfo(info)

            const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(dir).quiet().text())
            const normalizedList = list.replace(/\\/g, "/")
            const normalizedDir = info.directory.replace(/\\/g, "/")
            expect(normalizedList).toContain(normalizedDir)

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )
  })

  describe("remove edge cases", () => {
    it.live("remove non-existent directory succeeds silently", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ok = yield* svc.remove({ directory: path.join(dir, "does-not-exist") })
            expect(ok).toBe(true)
          }),
        { git: true },
      ),
    )

    it.live("throws NotGitError for non-git directories", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const exit = yield* Effect.exit(svc.remove({ directory: "/tmp/fake" }))

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
        }),
      ),
    )

    it.live("remove disposes the worktree's live instance (the orphan-watcher bug)", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()
            yield* Effect.promise(() => ready)

            const listener = yield* Effect.promise(async () => {
              const { GlobalBus } = await import("../../src/bus/global")
              const box = { resolve: (_: string) => {} }
              const promise = new Promise<string>((resolve, reject) => {
                box.resolve = resolve
                setTimeout(() => reject(new Error("timed out waiting for server.instance.disposed")), 10_000)
              })
              function on(evt: { payload: { type: string; properties?: { directory?: string } } }) {
                if (evt.payload.type !== "server.instance.disposed") return
                if (evt.payload.properties?.directory !== info.directory) return
                GlobalBus.off("event", on)
                box.resolve(info.directory)
              }
              GlobalBus.on("event", on)
              // holder, not the promise itself: returning a thenable from an
              // async fn would adopt (await) it and deadlock before remove runs
              return { promise }
            })

            yield* svc.remove({ directory: info.directory })
            const disposed = yield* Effect.promise(() => listener.promise)
            expect(disposed).toBe(info.directory)
          }),
        { git: true },
      ),
    )
  })

  describe("readiness contract: ready means alive", () => {
    it.live("ready fires only after start scripts finish", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const marker = path.join(dir, `marker-${Math.random().toString(36).slice(2)}`)
            const ready = waitReady()
            const info = yield* svc.create({ startCommand: `sleep 0.5 && touch "${marker}"` })

            // create answers fast: the start script is still sleeping.
            const early = yield* Effect.promise(() =>
              fs.access(marker).then(
                () => true,
                () => false,
              ),
            )
            expect(early).toBe(false)

            yield* Effect.promise(() => ready)

            // ready arrived, so the script MUST have completed.
            const late = yield* Effect.promise(() =>
              fs.access(marker).then(
                () => true,
                () => false,
              ),
            )
            expect(late).toBe(true)

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )

    it.live("start failure emits worktree.failed with the log tail, ready never fires", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = yield* Effect.promise(() => readyFlag())
            const failed = waitFailed()
            const info = yield* svc.create({ startCommand: "echo doom >&2; exit 1" })

            const evt = yield* Effect.promise(() => failed)
            expect(evt.message).toBe("worktree start command failed")
            expect(evt.log).toContain("doom")
            expect(evt.directory).toBe(info.directory)

            yield* Effect.promise(() => Bun.sleep(200))
            expect(ready.flag.fired).toBe(false)
            ready.stop()

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )

    it.live("start commands time out instead of hanging forever", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            process.env["OPENCODE_WORKTREE_START_TIMEOUT_MS"] = "500"
            const svc = yield* Worktree.Service
            const failed = waitFailed()
            const info = yield* svc.create({ startCommand: "sleep 30" })

            const evt = yield* Effect.promise(() => failed).pipe(
              Effect.ensuring(Effect.sync(() => delete process.env["OPENCODE_WORKTREE_START_TIMEOUT_MS"])),
            )
            expect(evt.message).toBe("worktree start command failed")
            expect(evt.log).toContain("timed out")

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )
  })

  describe(".worktreeinclude", () => {
    it.live("copies matching ignored files into the fresh checkout, nothing else", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(dir, ".gitignore"), ".env\nnode_modules/\ncache.log\n")
              await fs.writeFile(path.join(dir, ".worktreeinclude"), ".env\nnode_modules/\n")
              await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n")
              await fs.mkdir(path.join(dir, "node_modules", "dep"), { recursive: true })
              await fs.writeFile(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 1\n")
              await fs.writeFile(path.join(dir, "cache.log"), "stale\n")
            })

            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()
            yield* Effect.promise(() => ready)

            const env = yield* Effect.promise(() => fs.readFile(path.join(info.directory, ".env"), "utf8"))
            expect(env).toBe("SECRET=1\n")
            const dep = yield* Effect.promise(() =>
              fs.readFile(path.join(info.directory, "node_modules", "dep", "index.js"), "utf8"),
            )
            expect(dep).toContain("module.exports")
            const cacheCopied = yield* Effect.promise(() =>
              fs.access(path.join(info.directory, "cache.log")).then(
                () => true,
                () => false,
              ),
            )
            expect(cacheCopied).toBe(false)

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )
  })

  describe("list", () => {
    it.live("lists live worktrees with branches, primary excluded, removed ones gone", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const empty = yield* svc.list()
            expect(empty).toEqual([])

            const ready = waitReady()
            const info = yield* svc.create({ name: "listed" })
            yield* Effect.promise(() => ready)

            const listed = yield* svc.list()
            const entry = listed.find((item) => item.directory === info.directory)
            expect(entry).toBeDefined()
            expect(entry!.branch).toBe(info.branch!)
            expect(entry!.name).toBe("listed")

            yield* svc.remove({ directory: info.directory })
            const after = yield* svc.list()
            expect(after.find((item) => item.directory === info.directory)).toBeUndefined()
          }),
        { git: true },
      ),
    )
  })

  describe("detached worktrees", () => {
    wintest("carry no branch through info, list, and ready", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo({ detached: true })
            expect(info.branch).toBeUndefined()

            const ready = waitReady()
            yield* svc.createFromInfo(info)
            const props = yield* Effect.promise(() => ready)
            expect(props.branch).toBeUndefined()

            const text = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(dir).quiet().text())
            expect(normalize(text)).toContain(normalize(info.directory))
            expect(text).toContain("detached")

            const listed = yield* svc.list()
            const entry = listed.find((item) => item.directory === info.directory)
            expect(entry).toBeDefined()
            expect(entry!.branch).toBeUndefined()

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )
  })

  describe("disk ceiling", () => {
    it.live("refuses the 16th checkout for a project", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const probe = yield* svc.makeWorktreeInfo()
            const root = path.dirname(probe.directory)

            yield* Effect.promise(async () => {
              for (const n of Array.from({ length: 15 }, (_, i) => i)) {
                await fs.mkdir(path.join(root, `dummy-${n}`), { recursive: true })
              }
            })

            const exit = yield* Effect.exit(svc.makeWorktreeInfo()).pipe(
              Effect.ensuring(Effect.promise(() => fs.rm(root, { recursive: true, force: true }))),
            )
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const cause = Cause.squash(exit.cause)
              expect(cause).toBeInstanceOf(Worktree.CreateRefusedError)
              expect((cause as InstanceType<typeof Worktree.CreateRefusedError>).data.message).toContain("15")
            }
          }),
        { git: true },
      ),
    )
  })

  describe("review path: diff, merge, discard", () => {
    wintest("diff reports the branch delta and merge lands it on the default branch", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create({ name: "feature" })
            yield* Effect.promise(() => ready)

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(info.directory, "feature.txt"), "line one\nline two\n")
              await $`git add feature.txt`.cwd(info.directory).quiet()
              await $`git commit -m "feature"`.cwd(info.directory).quiet()
            })

            const diff = yield* svc.diff({ directory: info.directory })
            expect(diff.branch).toBe(info.branch!)
            expect(diff.commits).toBe(1)
            expect(diff.dirty).toBe(false)
            expect(diff.files.length).toBe(1)
            expect(diff.files[0].path).toBe("feature.txt")
            expect(diff.files[0].status).toBe("added")
            expect(diff.additions).toBe(2)
            expect(diff.deletions).toBe(0)
            expect(diff.diff).toContain("+line one")
            expect(diff.truncated).toBe(false)
            if (diff.mergeable !== undefined) expect(diff.mergeable).toBe(true)

            const result = yield* svc.merge({ directory: info.directory })
            expect(result.merged).toBe(true)
            expect(result.commit).toMatch(/^[0-9a-f]{40}$/)

            const content = yield* Effect.promise(() => fs.readFile(path.join(dir, "feature.txt"), "utf8"))
            expect(content).toContain("line one")

            const listed = yield* svc.list()
            expect(listed.find((item) => item.directory === info.directory)).toBeUndefined()
            const branches = yield* Effect.promise(() => $`git branch --list ${info.branch!}`.cwd(dir).quiet().text())
            expect(branches.trim()).toBe("")
          }),
        { git: true },
      ),
    )

    wintest("merge refuses a dirty checkout", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()
            yield* Effect.promise(() => ready)

            yield* Effect.promise(() => fs.writeFile(path.join(info.directory, "wip.txt"), "not committed\n"))

            const exit = yield* Effect.exit(svc.merge({ directory: info.directory }))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.MergeFailedError)
            }

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )

    wintest("merge conflicts abort cleanly and surface as MergeConflictError", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()
            yield* Effect.promise(() => ready)

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(info.directory, "conflict.txt"), "worktree side\n")
              await $`git add conflict.txt`.cwd(info.directory).quiet()
              await $`git commit -m "worktree side"`.cwd(info.directory).quiet()
              await fs.writeFile(path.join(dir, "conflict.txt"), "main side\n")
              await $`git add conflict.txt`.cwd(dir).quiet()
              await $`git commit -m "main side"`.cwd(dir).quiet()
            })

            const exit = yield* Effect.exit(svc.merge({ directory: info.directory }))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const cause = Cause.squash(exit.cause)
              expect(cause).toBeInstanceOf(Worktree.MergeConflictError)
            }

            // the abort left the primary checkout clean
            const status = yield* Effect.promise(() => $`git status --porcelain`.cwd(dir).quiet().text())
            expect(status.trim()).toBe("")

            yield* svc.remove({ directory: info.directory })
          }),
        { git: true },
      ),
    )

    wintest("discard snapshots the state to a dangling commit, then removes everything", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()
            yield* Effect.promise(() => ready)

            yield* Effect.promise(() => fs.writeFile(path.join(info.directory, "junk.txt"), "almost lost\n"))

            const result = yield* svc.discard({ directory: info.directory })
            expect(result.discarded).toBe(true)
            expect(result.snapshot).toMatch(/^[0-9a-f]{40}$/)

            // the snapshot commit is reachable in the shared object store
            const shown = yield* Effect.promise(() =>
              $`git show ${result.snapshot!}:junk.txt`.cwd(dir).quiet().text(),
            )
            expect(shown).toBe("almost lost\n")

            // checkout and branch are gone
            const exists = yield* Effect.promise(() =>
              fs.access(info.directory).then(
                () => true,
                () => false,
              ),
            )
            expect(exists).toBe(false)
            const branches = yield* Effect.promise(() => $`git branch --list ${info.branch!}`.cwd(dir).quiet().text())
            expect(branches.trim()).toBe("")
          }),
        { git: true },
      ),
    )

    wintest("discard of a clean unchanged checkout returns no snapshot", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create()
            yield* Effect.promise(() => ready)

            const result = yield* svc.discard({ directory: info.directory })
            expect(result.discarded).toBe(true)
            expect(result.snapshot).toBeUndefined()
          }),
        { git: true },
      ),
    )

    wintest("merge scoped to the worktree's OWN instance still removes checkout and branch (live-drive bug 2026-07-22)", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service
            const ready = waitReady()
            const info = yield* svc.create({ name: "scoped" })
            yield* Effect.promise(() => ready)

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(info.directory, "scoped.txt"), "one\n")
              await $`git add scoped.txt`.cwd(info.directory).quiet()
              await $`git commit -m scoped`.cwd(info.directory).quiet()
            })

            // boxbox scopes review verbs to the CHECKOUT's directory (it is
            // the proven-live instance). remove()'s git ops must anchor at
            // the primary or `git branch -D` runs from a deleted cwd.
            const ambient = yield* InstanceState.context
            const result = yield* svc.merge({ directory: info.directory }).pipe(
              Effect.provideService(InstanceRef, {
                directory: info.directory,
                worktree: info.directory,
                project: ambient.project,
              }),
            )
            expect(result.merged).toBe(true)

            const content = yield* Effect.promise(() => fs.readFile(path.join(dir, "scoped.txt"), "utf8"))
            expect(content).toBe("one\n")
            const branches = yield* Effect.promise(() => $`git branch --list ${info.branch!}`.cwd(dir).quiet().text())
            expect(branches.trim()).toBe("")
            const exists = yield* Effect.promise(() =>
              fs.access(info.directory).then(
                () => true,
                () => false,
              ),
            )
            expect(exists).toBe(false)
          }),
        { git: true },
      ),
    )
  })
})
