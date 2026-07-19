import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { GlobalFsError, listGlobalDirs } from "../../src/server/global-fs"
import { GlobalRoutes } from "../../src/server/routes/global"
import * as Log from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

async function fixtureTree() {
  return tmpdir({
    init: async (dir) => {
      await mkdir(path.join(dir, "beta"))
      await mkdir(path.join(dir, "alpha"))
      await mkdir(path.join(dir, ".hidden"))
      await writeFile(path.join(dir, "file.txt"), "not a dir")
      await symlink(path.join(dir, "alpha"), path.join(dir, "linked-dir"))
      await symlink(path.join(dir, "file.txt"), path.join(dir, "linked-file"))
      await symlink(path.join(dir, "gone"), path.join(dir, "broken-link"))
    },
  })
}

describe("listGlobalDirs", () => {
  test("lists only directories, visible first, hidden flagged and last", async () => {
    await using tmp = await fixtureTree()
    const listing = await listGlobalDirs(tmp.path)

    expect(listing.path).toBe(tmp.path)
    expect(listing.parent).toBe(path.dirname(tmp.path))
    expect(listing.home).toBe(os.homedir())
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "beta", "linked-dir", ".hidden"])
    expect(listing.entries.at(-1)?.hidden).toBe(true)
    expect(listing.entries[0]).toEqual({
      name: "alpha",
      absolute: path.join(tmp.path, "alpha"),
      hidden: false,
    })
  })

  test("defaults to home and expands ~", async () => {
    const bare = await listGlobalDirs()
    expect(bare.path).toBe(os.homedir())

    const tilde = await listGlobalDirs("~")
    expect(tilde.path).toBe(os.homedir())
  })

  test("expands ~/nested against home", async () => {
    await expect(listGlobalDirs("~/definitely-not-real-" + Math.random().toString(36).slice(2))).rejects.toThrow(
      GlobalFsError,
    )
    // the error path proves expansion happened: message carries the absolute path
    const name = "definitely-not-real"
    const error = await listGlobalDirs(`~/${name}`).catch((e) => e as GlobalFsError)
    expect(error).toBeInstanceOf(GlobalFsError)
    expect((error as GlobalFsError).message).toContain(path.join(os.homedir(), name))
  })

  test("root has a null parent", async () => {
    const listing = await listGlobalDirs("/")
    expect(listing.parent).toBeNull()
  })

  test("rejects relative paths", async () => {
    await expect(listGlobalDirs("Documents")).rejects.toThrow(GlobalFsError)
  })

  test("rejects missing directories and files", async () => {
    await using tmp = await fixtureTree()
    await expect(listGlobalDirs(path.join(tmp.path, "gone"))).rejects.toThrow("no such directory")
    await expect(listGlobalDirs(path.join(tmp.path, "file.txt"))).rejects.toThrow(GlobalFsError)
  })
})

describe("GET /global/fs (hono)", () => {
  const app = new Hono().route("/global", GlobalRoutes())

  test("returns the listing", async () => {
    await using tmp = await fixtureTree()
    const response = await app.request(`/global/fs?path=${encodeURIComponent(tmp.path)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { path: string; entries: { name: string }[] }
    expect(body.path).toBe(tmp.path)
    expect(body.entries.map((e) => e.name)).toEqual(["alpha", "beta", "linked-dir", ".hidden"])
  })

  test("maps GlobalFsError to 400", async () => {
    const response = await app.request("/global/fs?path=relative/nope")
    expect(response.status).toBe(400)
    const body = (await response.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain("path must be absolute")
  })
})
