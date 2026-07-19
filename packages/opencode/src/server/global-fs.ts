import { readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/* host-scope directory listing for remote clients (boxbox et al) picking a
   directory without typing blind paths. read-only, directories only, no
   instance involved — this must stay on the /global router so browsing
   never spawns anything. shared by both server backends (hono + httpapi),
   which return it verbatim; keep this the single source of behavior. */

export interface GlobalFsEntry {
  name: string
  absolute: string
  hidden: boolean
}

export interface GlobalFsListing {
  path: string
  parent: string | null
  home: string
  entries: GlobalFsEntry[]
}

/** invalid request (relative path, missing dir, not a dir, unreadable):
    both backends map this to a 400 with the message verbatim. */
export class GlobalFsError extends Error {}

function resolveTarget(input: string | undefined, home: string): string {
  const raw = (input ?? "").trim()
  if (!raw || raw === "~") return home
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2))
  if (!path.isAbsolute(raw)) throw new GlobalFsError(`path must be absolute: ${raw}`)
  return path.normalize(raw)
}

export async function listGlobalDirs(input?: string): Promise<GlobalFsListing> {
  const home = os.homedir()
  const target = resolveTarget(input, home)

  const dirents = await readdir(target, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new GlobalFsError(`no such directory: ${target}`)
    if (error.code === "ENOTDIR") throw new GlobalFsError(`not a directory: ${target}`)
    if (error.code === "EACCES" || error.code === "EPERM") throw new GlobalFsError(`permission denied: ${target}`)
    throw new GlobalFsError(error.message)
  })

  const entries: GlobalFsEntry[] = []
  for (const dirent of dirents) {
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      // follow symlinks so linked project dirs are pickable; broken links skip
      isDirectory = await stat(path.join(target, dirent.name))
        .then((s) => s.isDirectory())
        .catch(() => false)
    }
    if (!isDirectory) continue
    entries.push({
      name: dirent.name,
      absolute: path.join(target, dirent.name),
      hidden: dirent.name.startsWith("."),
    })
  }

  // canonical order for pickers: visible dirs first, each block alphabetical
  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    entries,
  }
}
