import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { Database } from "@/storage/db"
import * as Log from "@opencode-ai/core/util/log"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
const testWorktreeMutations = process.platform === "win32" ? test.skip : test

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  return Server.Default().app
}

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function createSession(input?: Session.CreateInput) {
  return runSession(Session.Service.use((svc) => svc.create(input)))
}

async function waitReady(directory: string) {
  await waitGlobalBusEventPromise({
    message: "timed out waiting for worktree.ready",
    predicate: (event) => event.payload.type === Worktree.Event.Ready.type && event.directory === directory,
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  test("serves read-only experimental endpoints through Hono bridge", async () => {
    await using tmp = await tmpdir({
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    })

    const headers = { "x-opencode-directory": tmp.path }
    const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = await Promise.all([
      app().request(ExperimentalPaths.console, { headers }),
      app().request(ExperimentalPaths.consoleOrgs, { headers }),
      app().request(`${ExperimentalPaths.tool}?provider=opencode&model=gpt-5`, { headers }),
      app().request(ExperimentalPaths.toolIDs, { headers }),
      app().request(ExperimentalPaths.worktree, { headers }),
      app().request(ExperimentalPaths.resource, { headers }),
    ])

    expect(consoleState.status).toBe(200)
    expect(await consoleState.json()).toEqual({
      consoleManagedProviders: [],
      switchableOrgCount: 0,
    })

    expect(consoleOrgs.status).toBe(200)
    expect(await consoleOrgs.json()).toEqual({ orgs: [] })

    expect(toolList.status).toBe(200)
    // Wave 4 (replace-bash-task-2026-05-15) — `bash` is no longer in the
    // model-facing tool list (registry's builtin array drops `tool.shell`
    // + `tool.task`). The codex-ported `exec_command` takes its place
    // for shell-flavored work; the experimental tool list reflects that.
    expect(await toolList.json()).toContainEqual(
      expect.objectContaining({
        id: "exec_command",
        description: expect.any(String),
        parameters: expect.any(Object),
      }),
    )

    expect(toolIDs.status).toBe(200)
    const ids = await toolIDs.json()
    expect(ids).toContain("exec_command")
    expect(ids).not.toContain("bash")
    expect(ids).not.toContain("task")

    expect(worktrees.status).toBe(200)
    expect(await worktrees.json()).toEqual([])

    expect(resources.status).toBe(200)
    expect(await resources.json()).toEqual({})
  })

  test("serves Console org switch through Hono bridge", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    Database.Client()
      .$client.prepare(
        "INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "account-test",
        "test@example.com",
        "https://console.example.com",
        "access",
        "refresh",
        Date.now(),
        Date.now(),
      )

    const switched = await app().request(ExperimentalPaths.consoleSwitch, {
      method: "POST",
      headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
      body: JSON.stringify({ accountID: "account-test", orgID: "org-test" }),
    })

    expect(switched.status).toBe(200)
    expect(await switched.json()).toBe(true)
  })

  test("serves global session list through Hono bridge", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const first = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => createSession({ title: "page-one" }),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => createSession({ title: "page-two" }),
    })

    const headers = { "x-opencode-directory": tmp.path }
    const page = await app().request(
      `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.path, limit: "1" })}`,
      { headers },
    )
    expect(page.status).toBe(200)
    expect(page.headers.get("x-next-cursor")).toBeTruthy()

    const body = (await page.json()) as Session.GlobalInfo[]
    expect(body.map((session) => session.id)).toEqual([second.id])
    expect(body[0].project?.id).toBe(second.projectID)

    const next = await app().request(
      `${ExperimentalPaths.session}?${new URLSearchParams({
        directory: tmp.path,
        limit: "10",
        cursor: body[0].time.updated.toString(),
      })}`,
      { headers },
    )
    expect(next.status).toBe(200)
    expect(((await next.json()) as Session.GlobalInfo[]).map((session) => session.id)).toContain(first.id)
  })

  testWorktreeMutations("serves worktree mutations through Hono bridge", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const created = await app().request(ExperimentalPaths.worktree, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "api-test" }),
    })

    expect(created.status).toBe(200)
    const info = (await created.json()) as Worktree.Info
    expect(info).toMatchObject({ name: "api-test", branch: "opencode/api-test" })
    await waitReady(info.directory)

    const listed = await app().request(ExperimentalPaths.worktree, { headers })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toContainEqual(
      expect.objectContaining({ name: "api-test", directory: info.directory, branch: "opencode/api-test" }),
    )

    if (process.platform !== "win32") {
      const reset = await app().request(ExperimentalPaths.worktreeReset, {
        method: "POST",
        headers,
        body: JSON.stringify({ directory: info.directory }),
      })

      expect(reset.status).toBe(200)
      expect(await reset.json()).toBe(true)
    }

    const removed = await app().request(ExperimentalPaths.worktree, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ directory: info.directory }),
    })

    expect(removed.status).toBe(200)
    expect(await removed.json()).toBe(true)

    const afterRemove = await app().request(ExperimentalPaths.worktree, { headers })
    expect(afterRemove.status).toBe(200)
    expect(await afterRemove.json()).toEqual([])
  })

  testWorktreeMutations("serves worktree diff, merge, and discard through Hono bridge", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    // --- diff + merge ---
    const created = await app().request(ExperimentalPaths.worktree, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "review-test" }),
    })
    expect(created.status).toBe(200)
    const info = (await created.json()) as Worktree.Info
    await waitReady(info.directory)

    await Bun.write(`${info.directory}/feature.txt`, "line one\nline two\n")
    await $`git add feature.txt`.cwd(info.directory).quiet()
    await $`git commit -m feature`.cwd(info.directory).quiet()

    const diffed = await app().request(
      `${ExperimentalPaths.worktreeDiff}?${new URLSearchParams({ directory: info.directory })}`,
      { headers },
    )
    expect(diffed.status).toBe(200)
    const diff = (await diffed.json()) as Worktree.Diff
    expect(diff).toMatchObject({
      branch: "opencode/review-test",
      commits: 1,
      dirty: false,
      additions: 2,
      deletions: 0,
      truncated: false,
    })
    expect(diff.files).toEqual([{ path: "feature.txt", status: "added", additions: 2, deletions: 0 }])
    expect(diff.diff).toContain("+line one")

    const merged = await app().request(ExperimentalPaths.worktreeMerge, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: info.directory }),
    })
    expect(merged.status).toBe(200)
    const mergeResult = (await merged.json()) as Worktree.MergeResult
    expect(mergeResult.merged).toBe(true)
    expect(mergeResult.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(await Bun.file(`${tmp.path}/feature.txt`).text()).toContain("line one")

    const afterMerge = await app().request(ExperimentalPaths.worktree, { headers })
    expect(await afterMerge.json()).toEqual([])

    // --- discard ---
    const again = await app().request(ExperimentalPaths.worktree, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "discard-test" }),
    })
    expect(again.status).toBe(200)
    const second = (await again.json()) as Worktree.Info
    await waitReady(second.directory)

    await Bun.write(`${second.directory}/junk.txt`, "almost lost\n")

    const discarded = await app().request(ExperimentalPaths.worktreeDiscard, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: second.directory }),
    })
    expect(discarded.status).toBe(200)
    const discardResult = (await discarded.json()) as Worktree.DiscardResult
    expect(discardResult.discarded).toBe(true)
    expect(discardResult.snapshot).toMatch(/^[0-9a-f]{40}$/)

    // the snapshot commit stays recoverable from the shared object store
    const shown = await $`git show ${discardResult.snapshot}:junk.txt`.cwd(tmp.path).quiet().text()
    expect(shown).toBe("almost lost\n")

    const afterDiscard = await app().request(ExperimentalPaths.worktree, { headers })
    expect(await afterDiscard.json()).toEqual([])
  })
})
