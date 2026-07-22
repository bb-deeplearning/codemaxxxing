import z from "zod"
import { NamedError } from "@opencode-ai/core/util/error"
import { Global } from "@opencode-ai/core/global"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { ProjectTable } from "../project/project.sql"
import type { ProjectID } from "../project/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Slug } from "@opencode-ai/core/util/slug"
import { errorMessage } from "../util/error"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Effect, Layer, Path, Schema, Scope, Context, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { BootstrapRuntime } from "@/effect/bootstrap-runtime"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceState } from "@/effect/instance-state"
import { zod as effectZod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const log = Log.create({ service: "worktree" })

export const Event = {
  Ready: BusEvent.define(
    "worktree.ready",
    Schema.Struct({
      name: Schema.String,
      branch: Schema.optional(Schema.String),
    }),
  ),
  Failed: BusEvent.define(
    "worktree.failed",
    Schema.Struct({
      message: Schema.String,
      log: Schema.optional(Schema.String),
    }),
  ),
}

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
})
  .annotate({ identifier: "Worktree" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
})
  .annotate({ identifier: "WorktreeCreateInput" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
})
  .annotate({ identifier: "WorktreeRemoveInput" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
})
  .annotate({ identifier: "WorktreeResetInput" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export const DiffQuery = Schema.Struct({
  directory: Schema.String,
})
  .annotate({ identifier: "WorktreeDiffQuery" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type DiffQuery = Schema.Schema.Type<typeof DiffQuery>

export const DiffFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "deleted", "modified"]),
  additions: Schema.Number,
  deletions: Schema.Number,
}).annotate({ identifier: "WorktreeDiffFile" })
export type DiffFile = Schema.Schema.Type<typeof DiffFile>

export const Diff = Schema.Struct({
  branch: Schema.optional(Schema.String),
  base: Schema.String,
  baseRef: Schema.String,
  commits: Schema.Number,
  dirty: Schema.Boolean,
  mergeable: Schema.optional(Schema.Boolean),
  additions: Schema.Number,
  deletions: Schema.Number,
  files: Schema.Array(DiffFile),
  diff: Schema.String,
  truncated: Schema.Boolean,
})
  .annotate({ identifier: "WorktreeDiff" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type Diff = Schema.Schema.Type<typeof Diff>

export const MergeInput = Schema.Struct({
  directory: Schema.String,
})
  .annotate({ identifier: "WorktreeMergeInput" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type MergeInput = Schema.Schema.Type<typeof MergeInput>

export const MergeResult = Schema.Struct({
  merged: Schema.Boolean,
  commit: Schema.String,
})
  .annotate({ identifier: "WorktreeMergeResult" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type MergeResult = Schema.Schema.Type<typeof MergeResult>

export const DiscardInput = Schema.Struct({
  directory: Schema.String,
})
  .annotate({ identifier: "WorktreeDiscardInput" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type DiscardInput = Schema.Schema.Type<typeof DiscardInput>

export const DiscardResult = Schema.Struct({
  discarded: Schema.Boolean,
  snapshot: Schema.optional(Schema.String),
})
  .annotate({ identifier: "WorktreeDiscardResult" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type DiscardResult = Schema.Schema.Type<typeof DiscardResult>

export const NotGitError = NamedError.create(
  "WorktreeNotGitError",
  z.object({
    message: z.string(),
  }),
)

export const NameGenerationFailedError = NamedError.create(
  "WorktreeNameGenerationFailedError",
  z.object({
    message: z.string(),
  }),
)

export const CreateFailedError = NamedError.create(
  "WorktreeCreateFailedError",
  z.object({
    message: z.string(),
  }),
)

export const CreateRefusedError = NamedError.create(
  "WorktreeCreateRefusedError",
  z.object({
    message: z.string(),
  }),
)

export const RemoveFailedError = NamedError.create(
  "WorktreeRemoveFailedError",
  z.object({
    message: z.string(),
  }),
)

export const ResetFailedError = NamedError.create(
  "WorktreeResetFailedError",
  z.object({
    message: z.string(),
  }),
)

export const ListFailedError = NamedError.create(
  "WorktreeListFailedError",
  z.object({
    message: z.string(),
  }),
)

export const DiffFailedError = NamedError.create(
  "WorktreeDiffFailedError",
  z.object({
    message: z.string(),
  }),
)

export const MergeFailedError = NamedError.create(
  "WorktreeMergeFailedError",
  z.object({
    message: z.string(),
  }),
)

export const MergeConflictError = NamedError.create(
  "WorktreeMergeConflictError",
  z.object({
    message: z.string(),
    files: z.array(z.string()).optional(),
  }),
)

export const DiscardFailedError = NamedError.create(
  "WorktreeDiscardFailedError",
  z.object({
    message: z.string(),
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void>
  readonly create: (input?: CreateInput) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  /** Worktrees of an arbitrary primary checkout, no instance context needed
   * (the unified project index enriches every git project through this). */
  readonly listAt: (primaryCwd: string) => Effect.Effect<Info[]>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean>
  readonly diff: (input: DiffQuery) => Effect.Effect<Diff>
  readonly merge: (input: MergeInput) => Effect.Effect<MergeResult>
  readonly discard: (input: DiscardInput) => Effect.Effect<DiscardResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

export const layer: Layer.Layer<
  Service,
  never,
  | AppFileSystem.Service
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Git.Service
  | Project.Service
  | InstanceStore.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* AppFileSystem.Service
    const pathSvc = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service

    const command = Effect.fnUntraced(
      function* (bin: string, args: string[], opts?: { cwd?: string }) {
        const handle = yield* spawner.spawn(
          ChildProcess.make(bin, args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        const [text, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        const code = yield* handle.exitCode
        return { code, text, stderr } satisfies GitResult
      },
      Effect.scoped,
      Effect.catch((e) =>
        Effect.succeed({ code: 1, text: "", stderr: e instanceof Error ? e.message : String(e) } satisfies GitResult),
      ),
    )

    const git = (args: string[], opts?: { cwd?: string }) => command("git", args, opts)

    const MAX_WORKTREES_PER_PROJECT = 15
    const MIN_FREE_BYTES = 5 * 1024 ** 3
    const MIN_FREE_RATIO = 0.1

    const freeDisk = Effect.fnUntraced(function* (target: string) {
      const viaStatfs = yield* Effect.promise(() =>
        import("fs/promises").then((fsp) =>
          fsp.statfs(target).then((s) => ({
            available: Number(s.bavail) * Number(s.bsize),
            total: Number(s.blocks) * Number(s.bsize),
          })),
        ),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (viaStatfs && Number.isFinite(viaStatfs.available) && Number.isFinite(viaStatfs.total)) return viaStatfs
      const df = yield* command("df", ["-Pk", target])
      if (df.code !== 0) return undefined
      const cols = df.text.trim().split("\n").at(-1)?.split(/\s+/) ?? []
      const total = Number(cols[1]) * 1024
      const available = Number(cols[3]) * 1024
      if (!Number.isFinite(total) || !Number.isFinite(available)) return undefined
      return { available, total }
    })

    // The disk ceiling is a backstop against runaway fan-out, not a manager:
    // steady state is bounded by review flow (clean/merged/discarded worktrees
    // all remove themselves). Refuse create when the host is at 15 checkouts
    // for this project, or under max(5GB, 10%) free disk.
    const ceiling = Effect.fnUntraced(function* (root: string) {
      const entries = yield* fs.readDirectoryEntries(root).pipe(Effect.catch(() => Effect.succeed([])))
      const existing = entries.filter((entry) => entry.type === "directory").length
      if (existing >= MAX_WORKTREES_PER_PROJECT) {
        throw new CreateRefusedError({
          message: `This project already has ${existing} checkouts on this host (limit ${MAX_WORKTREES_PER_PROJECT}). Merge or discard some first.`,
        })
      }

      const disk = yield* freeDisk(root)
      if (!disk) return
      const floor = Math.max(MIN_FREE_BYTES, disk.total * MIN_FREE_RATIO)
      if (disk.available < floor) {
        const gb = (disk.available / 1024 ** 3).toFixed(1)
        throw new CreateRefusedError({
          message: `Host disk is low (${gb}GB free). Not creating another checkout.`,
        })
      }
    })

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      base?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.base ? (attempt === 0 ? input.base : `${input.base}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `opencode/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) } satisfies Info
      }
      throw new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (options?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        throw new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      // Canonicalize once so Info.directory, the ready/failed envelopes, the
      // instance-store key, and list() all speak the same path form (macOS
      // tmp symlinks: /var vs /private/var). Clients join on these strings.
      const realRoot = yield* canonical(root)
      yield* ceiling(realRoot)

      const base = options?.name ? slugify(options.name) : ""
      return yield* candidate({ root: realRoot, base: base || undefined, detached: options?.detached })
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        {
          cwd: ctx.worktree,
        },
      )
      if (created.code !== 0) {
        throw new CreateFailedError({ message: created.stderr || created.text || "Failed to create git worktree" })
      }

      yield* project.addSandbox(ctx.project.id, info.directory).pipe(Effect.catch(() => Effect.void))
    })

    const cowCopy = Effect.fnUntraced(function* (source: string, dest: string) {
      yield* fs.makeDirectory(pathSvc.dirname(dest), { recursive: true }).pipe(Effect.orDie)
      if (process.platform === "darwin") {
        // apfs clonefile: node_modules costs milliseconds. Falls through to a
        // plain copy on non-apfs volumes.
        const cloned = yield* command("cp", ["-c", "-R", source, dest])
        if (cloned.code === 0) return true
      }
      if (process.platform === "linux") {
        const linked = yield* command("cp", ["-R", "--reflink=auto", source, dest])
        if (linked.code === 0) return true
      }
      return yield* Effect.promise(() =>
        import("fs/promises").then((fsp) => fsp.cp(source, dest, { recursive: true, force: true })),
      ).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            log.error("worktreeinclude copy failed", { source, dest, message: errorMessage(error) })
            return false
          }),
        ),
      )
    })

    const INCLUDE_FILE = ".worktreeinclude"

    // A bare `worktree add` brings tracked files only; a checkout's life support
    // (.env, node_modules, gitignored local docs) is IGNORED by definition. The
    // repo declares what a live checkout needs in .worktreeinclude (gitignore
    // syntax, the claude-code/codex convention) and git's own matcher resolves
    // it: untracked paths matching the patterns, ignored dirs collapsed to one
    // entry each. Copy failures degrade to a slower first install, never a
    // failed create.
    const copyIncluded = Effect.fnUntraced(function* (parent: string, target: string) {
      const has = yield* fs.exists(pathSvc.join(parent, INCLUDE_FILE)).pipe(Effect.orDie)
      if (!has) return
      const listed = yield* git(
        ["ls-files", "--others", "--ignored", "--directory", "-z", `--exclude-from=${INCLUDE_FILE}`],
        { cwd: parent },
      )
      if (listed.code !== 0) {
        log.error("worktreeinclude listing failed", { parent, message: listed.stderr || listed.text })
        return
      }
      const entries = listed.text.split("\0").filter(Boolean)
      yield* Effect.forEach(
        entries,
        (entry) => {
          const rel = entry.replace(/\/+$/, "")
          if (!rel || rel === ".git" || rel.startsWith(".git/")) return Effect.void
          return cowCopy(pathSvc.join(parent, rel), pathSvc.join(target, rel)).pipe(Effect.asVoid)
        },
        { concurrency: 4 },
      )
      if (entries.length) log.info("worktreeinclude copied", { target, entries: entries.length })
    })

    const failedEmit = Effect.fnUntraced(function* (directory: string, message: string, logTail?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      log.error("worktree boot failed", { directory, message })
      GlobalBus.emit("event", {
        directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Failed.type,
          properties: { message, ...(logTail ? { log: logTail } : {}) },
        },
      })
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        yield* failedEmit(info.directory, populated.stderr || populated.text || "Failed to populate worktree")
        return
      }

      // Life support lands BEFORE the instance boots so .env and node_modules
      // exist from frame one.
      yield* copyIncluded(ctx.worktree, info.directory)

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) => failedEmit(info.directory, errorMessage(error)).pipe(Effect.as(false))),
      )
      if (!booted) return

      // Ready means ALIVE: populate + include copy + instance boot + start
      // scripts all finished. A start failure is a worktree.failed event with
      // the log tail attached, never a silent log line.
      const started = yield* runStartScripts(info.directory, { projectID, extra })
      if (!started.ok) {
        yield* failedEmit(info.directory, `${started.kind} start command failed`, started.log)
        return
      }

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* boot(info, startCommand)
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* setup(info)
      yield* boot(info, input?.startCommand).pipe(
        Effect.catchCause((cause) => Effect.sync(() => log.error("worktree bootstrap failed", { cause }))),
        Effect.forkIn(scope),
      )
      return info
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const listAt = Effect.fn("Worktree.listAt")(function* (primaryCwd: string) {
      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: primaryCwd })
      if (result.code !== 0) {
        throw new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(primaryCwd)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          } satisfies Info
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return [] as Info[]
      return yield* listAt(ctx.project.worktree)
    })

    function stopFsmonitor(target: string) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void)),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.promise(() =>
        import("fs/promises")
          .then((fsp) => fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
          .catch((error) => {
            const message = errorMessage(error)
            throw new RemoveFailedError({ message: message || "Failed to remove git worktree directory" })
          }),
      )
    }

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        throw new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      // Anchor every git op at the PRIMARY checkout: a remove request scoped
      // to the worktree's own instance would otherwise run `git branch -D`
      // from a directory that no longer exists (caught on the 2026-07-22
      // live drive — merge landed, dir gone, branch left behind, 500).
      const primaryCwd = ctx.project.worktree

      const directory = yield* canonical(input.directory)

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(primaryCwd))) yield* store.disposeDirectory(input.directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: primaryCwd })
      if (list.code !== 0) {
        throw new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie)
        if (directoryExists) {
          yield* stopFsmonitor(directory)
          yield* cleanDirectory(directory)
        }
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: primaryCwd })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: primaryCwd })
        if (next.code !== 0) {
          throw new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          throw new RemoveFailedError({ message: removed.stderr || removed.text || "Failed to remove git worktree" })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: primaryCwd })
        if (deleted.code !== 0) {
          throw new RemoveFailedError({
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
        }
      }

      return true
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) throw error(result)
      return result
    })

    const START_TIMEOUT_FALLBACK_MS = 600_000

    const startTimeoutMs = () => {
      const raw = Number(process.env["OPENCODE_WORKTREE_START_TIMEOUT_MS"])
      return Number.isFinite(raw) && raw > 0 ? raw : START_TIMEOUT_FALLBACK_MS
    }

    const runStartCommand = Effect.fnUntraced(function* (directory: string, cmd: string) {
      const timeoutMs = startTimeoutMs()
      const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
      return yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(shell, args, { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        const [, stderr] = yield* Effect.all(
          [Stream.runDrain(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        ).pipe(Effect.orDie)
        const code = yield* handle.exitCode
        return { code, stderr }
      }).pipe(
        Effect.scoped,
        Effect.timeout(timeoutMs),
        Effect.catchTag("TimeoutError", () =>
          Effect.succeed({ code: 1, stderr: `Start command timed out after ${timeoutMs / 1000}s` }),
        ),
        Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
      )
    })

    const logTail = (text: string, max = 4000) => (text.length > max ? text.slice(-max) : text)

    const runStartScript = Effect.fnUntraced(function* (
      directory: string,
      cmd: string,
      kind: "project" | "worktree",
    ) {
      const text = cmd.trim()
      if (!text) return { ok: true as const }
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return { ok: true as const }
      log.error("worktree start command failed", { kind, directory, message: result.stderr })
      return { ok: false as const, kind, log: logTail(result.stderr.trim() || `exit ${result.code}`) }
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectID; extra?: string },
    ) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, input.projectID)).get()),
      )
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const first = yield* runStartScript(directory, startup, "project")
      if (!first.ok) return first
      return yield* runStartScript(directory, input.extra ?? "", "worktree")
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        throw new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      // Primary-anchored for the same reason as remove(): a reset request
      // scoped to the worktree's own instance must not run primary-side git
      // from the target directory.
      const primaryCwd = ctx.project.worktree

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(primaryCwd)
      if (directory === primary) {
        throw new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: primaryCwd })
      if (list.code !== 0) {
        throw new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        throw new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(primaryCwd)
      if (!base) {
        throw new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: primaryCwd },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        throw new ResetFailedError({ message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree" })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        throw new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        throw new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.flatMap((started) =>
          started.ok ? Effect.void : failedEmit(worktreePath, `${started.kind} start command failed`, started.log),
        ),
        Effect.catchCause((cause) => Effect.sync(() => log.error("worktree start task failed", { cause }))),
        Effect.forkIn(scope),
      )

      return true
    })

    // -----------------------------------------------------------------------
    // Review path: diff / merge / discard. Merge is LOCAL, in the primary
    // checkout on whatever machine owns it; push stays with the owner machine
    // where creds live. Conflicts are never resolved here: they go back to the
    // agent as a typed error.
    // -----------------------------------------------------------------------

    const mergeTarget = Effect.fnUntraced(function* (primaryCwd: string) {
      const base = yield* gitSvc.defaultBranch(primaryCwd)
      if (!base) return undefined
      const local = yield* git(["show-ref", "--verify", "--quiet", `refs/heads/${base.name}`], { cwd: primaryCwd })
      return { name: base.name, ref: local.code === 0 ? base.name : base.ref, local: local.code === 0 }
    })

    const locate = Effect.fnUntraced(function* (
      primaryCwd: string,
      directory: string,
      onError: (message: string) => Error,
    ) {
      const listed = yield* git(["worktree", "list", "--porcelain"], { cwd: primaryCwd })
      if (listed.code !== 0) throw onError(listed.stderr || listed.text || "Failed to read git worktrees")
      const entry = yield* locateWorktree(parseWorktreeList(listed.text), directory)
      if (!entry?.path) throw onError("Worktree not found")
      return { path: entry.path, branch: entry.branch }
    })

    const diff = Effect.fn("Worktree.diff")(function* (input: DiffQuery) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        throw new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      const primaryCwd = ctx.project.worktree
      const directory = yield* canonical(input.directory)
      if (directory === (yield* canonical(primaryCwd))) {
        throw new DiffFailedError({ message: "Cannot diff the primary checkout" })
      }
      const entry = yield* locate(primaryCwd, directory, (message) => new DiffFailedError({ message }))
      const target = yield* mergeTarget(primaryCwd)
      if (!target) throw new DiffFailedError({ message: "Default branch not found" })

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      const range = `${target.ref}...HEAD`

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: entry.path })
      const dirty = status.code === 0 && status.text.trim().length > 0

      const counted = yield* git(["rev-list", "--count", `${target.ref}..HEAD`], { cwd: entry.path })
      const commits = counted.code === 0 ? Number(counted.text.trim()) || 0 : 0

      const items = yield* gitSvc.diff(entry.path, range)
      const stats = yield* gitSvc.stats(entry.path, range)
      const statByFile = new Map(stats.map((stat) => [stat.file, stat]))
      const files = items.map((item) => ({
        path: item.file,
        status: item.status,
        additions: statByFile.get(item.file)?.additions ?? 0,
        deletions: statByFile.get(item.file)?.deletions ?? 0,
      }))

      const patch = yield* gitSvc.patchAll(entry.path, range, { maxOutputBytes: 4_000_000 })

      const head = yield* git(["rev-parse", "HEAD"], { cwd: entry.path })
      const probe = yield* (head.code === 0
        ? git(["merge-tree", "--write-tree", target.ref, head.text.trim()], { cwd: primaryCwd })
        : Effect.succeed(undefined))
      const mergeable = probe === undefined ? undefined : probe.code === 0 ? true : probe.code === 1 ? false : undefined

      return {
        ...(branch ? { branch } : {}),
        base: target.name,
        baseRef: target.ref,
        commits,
        dirty,
        ...(mergeable === undefined ? {} : { mergeable }),
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        files,
        diff: patch.text,
        truncated: patch.truncated,
      } satisfies Diff
    })

    const merge = Effect.fn("Worktree.merge")(function* (input: MergeInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        throw new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      const primaryCwd = ctx.project.worktree
      const directory = yield* canonical(input.directory)
      if (directory === (yield* canonical(primaryCwd))) {
        throw new MergeFailedError({ message: "Cannot merge the primary checkout into itself" })
      }
      const entry = yield* locate(primaryCwd, directory, (message) => new MergeFailedError({ message }))

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: entry.path })
      if (status.code !== 0) {
        throw new MergeFailedError({ message: status.stderr || status.text || "Failed to read worktree status" })
      }
      if (status.text.trim()) {
        throw new MergeFailedError({ message: "The checkout has uncommitted changes. Commit or discard them first." })
      }

      const target = yield* mergeTarget(primaryCwd)
      if (!target) throw new MergeFailedError({ message: "Default branch not found" })
      if (!target.local) throw new MergeFailedError({ message: `No local ${target.name} branch to merge into` })

      const current = yield* gitSvc.branch(primaryCwd)
      if (current !== target.name) {
        throw new MergeFailedError({
          message: `The primary checkout is on ${current ?? "a detached HEAD"}, not ${target.name}`,
        })
      }

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      const head = yield* git(["rev-parse", "HEAD"], { cwd: entry.path })
      if (head.code !== 0) {
        throw new MergeFailedError({ message: head.stderr || head.text || "Failed to resolve worktree HEAD" })
      }
      const ref = branch ?? head.text.trim()

      const counted = yield* git(["rev-list", "--count", `${target.name}..${ref}`], { cwd: primaryCwd })
      if (counted.code === 0 && (Number(counted.text.trim()) || 0) === 0) {
        throw new MergeFailedError({ message: "Nothing to merge: the branch has no commits ahead" })
      }

      // A dirty primary is not pre-refused: git itself aborts only when the
      // merge would overwrite local changes, which is the honest boundary.
      const merged = yield* git(["merge", "--no-edit", ref], { cwd: primaryCwd })
      if (merged.code !== 0) {
        const conflicted = /CONFLICT/.test(merged.text) || /CONFLICT/.test(merged.stderr)
        if (conflicted) {
          yield* git(["merge", "--abort"], { cwd: primaryCwd })
          const files = merged.text
            .split("\n")
            .map((line) => line.match(/^CONFLICT \([^)]+\): Merge conflict in (.+)$/)?.[1])
            .filter((file): file is string => !!file)
          throw new MergeConflictError({
            message: `${target.name} moved since the branch forked. It needs a rebase in its own checkout before it can merge.`,
            ...(files.length ? { files } : {}),
          })
        }
        throw new MergeFailedError({ message: merged.stderr || merged.text || "Merge failed" })
      }

      const commit = yield* git(["rev-parse", "HEAD"], { cwd: primaryCwd })

      // Merged means the checkout is done carrying anything: it removes itself,
      // branch included. The merge commit is the surviving artifact.
      yield* remove({ directory: entry.path })

      return { merged: true, commit: commit.code === 0 ? commit.text.trim() : "" } satisfies MergeResult
    })

    const snapshotState = Effect.fnUntraced(function* (worktreePath: string) {
      const added = yield* git(["add", "-A", "."], { cwd: worktreePath })
      if (added.code !== 0) return undefined
      const tree = yield* git(["write-tree"], { cwd: worktreePath })
      if (tree.code !== 0) return undefined
      const head = yield* git(["rev-parse", "HEAD"], { cwd: worktreePath })
      if (head.code !== 0) return undefined
      const commit = yield* git(
        ["commit-tree", tree.text.trim(), "-p", head.text.trim(), "-m", `snapshot before discard (${new Date().toISOString()})`],
        { cwd: worktreePath },
      )
      if (commit.code !== 0) return undefined
      return commit.text.trim()
    })

    const discard = Effect.fn("Worktree.discard")(function* (input: DiscardInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        throw new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      const primaryCwd = ctx.project.worktree
      const directory = yield* canonical(input.directory)
      if (directory === (yield* canonical(primaryCwd))) {
        throw new DiscardFailedError({ message: "Cannot discard the primary checkout" })
      }
      const entry = yield* locate(primaryCwd, directory, (message) => new DiscardFailedError({ message }))

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: entry.path })
      const dirty = status.code === 0 && status.text.trim().length > 0
      const target = yield* mergeTarget(primaryCwd)
      const counted = yield* (target
        ? git(["rev-list", "--count", `${target.ref}..HEAD`], { cwd: entry.path })
        : Effect.succeed(undefined))
      const ahead = counted && counted.code === 0 ? Number(counted.text.trim()) || 0 : 0

      // Snapshot the checkout's final state into a DANGLING commit before
      // deletion (grok-build's snapshot-to-ref move, minus the ref): a
      // destructive control driven from a phone stays recoverable via
      // `git branch rescue <sha>` until gc prunes the object, with zero
      // litter surface. Snapshot failure never blocks the discard.
      const snapshot = dirty || ahead > 0 ? yield* snapshotState(entry.path) : undefined

      yield* remove({ directory: entry.path })
      return { discarded: true, ...(snapshot ? { snapshot } : {}) } satisfies DiscardResult
    })

    return Service.of({ makeWorktreeInfo, createFromInfo, create, list, listAt, remove, reset, diff, merge, discard })
  }),
)

export const appLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
)

export const defaultLayer = appLayer.pipe(Layer.provide(InstanceLayer.layer))

export * as Worktree from "."
