// Wave 1 — bash AST scan + permission-derivation, lifted out of `tool/shell.ts`.
//
// Public API: `scanCommand(input)` parses + walks a shell command and returns
// a `Scan { dirs, patterns, always }`. `askForScan(ctx, scan, extra?)` issues
// the canonical `external_directory` then `bash` permission asks in that
// fixed order. Both are pure refactors of code formerly inlined in
// `tool/shell.ts`; behavior is byte-identical (verified by Wave 1's
// scanner-corpus.json differential test).
//
// Wave 2 wires this into `exec_command` so saved `permission.bash: { "git *":
// "allow" }` rules transparently auto-allow `exec_command(cmd: "git status")`.
// The `extraAlways` slot in `askForScan` is how `exec_command` appends its
// `pid:<n>` always-rule onto the bash ask payload.

import { Effect } from "effect"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Language, type Node } from "web-tree-sitter"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { lazy } from "@/util/lazy"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { Shell } from "@/shell/shell"
import { BashArity } from "@/permission/arity"
import * as Tool from "../tool"
import { ShellID } from "./id"

export const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
export const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
export const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
export const FLAGS = new Set(["-destination", "-literalpath", "-path"])
export const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

export type Part = {
  type: string
  text: string
}

export type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

export function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

export function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

export function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

export function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

export function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

export function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

export function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

export function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

export function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

export function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const parse = Effect.fn("ShellScan.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

export const cygpath = Effect.fn("ShellScan.cygpath")(function* (shell: string, text: string) {
  const spawner = yield* ChildProcessSpawner
  const lines = yield* spawner
    .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  const file = lines[0]?.trim()
  if (!file) return
  return AppFileSystem.normalizePath(file)
})

export const resolvePath = Effect.fn("ShellScan.resolvePath")(function* (text: string, root: string, shell: string) {
  if (process.platform === "win32") {
    if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
      const file = yield* cygpath(shell, text)
      if (file) return file
    }
    return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
  }
  return path.resolve(root, text)
})

export const argPath = Effect.fn("ShellScan.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
  const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
  const file = text && prefix(text)
  if (!file || dynamic(file, ps)) return
  const next = ps ? provider(file) : file
  if (!next) return
  return yield* resolvePath(next, cwd, shell)
})

export const collect = Effect.fn("ShellScan.collect")(function* (
  root: Node,
  cwd: string,
  ps: boolean,
  shell: string,
  instance: InstanceContext,
) {
  const fs = yield* AppFileSystem.Service
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }
  const shellKind = ShellID.toKind(Shell.name(shell))

  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

    if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
      for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
        const resolved = yield* argPath(arg, cwd, ps, shell)
        if (!resolved || containsPath(resolved, instance)) continue
        const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }
    }

    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }
  }

  return scan
})

export const scanCommand = Effect.fn("ShellScan.scan")(function* (input: {
  command: string
  shell: string
  cwd: string
  instance: InstanceContext
}) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const ps = Shell.ps(input.shell)
      const tree = yield* Effect.acquireRelease(parse(input.command, ps), (t) => Effect.sync(() => t.delete()))
      const scan = yield* collect(tree.rootNode, input.cwd, ps, input.shell, input.instance)
      if (!containsPath(input.cwd, input.instance)) scan.dirs.add(input.cwd)
      return scan
    }),
  )
})

export const askForScan = Effect.fn("ShellScan.askForScan")(function* (
  ctx: Tool.Context,
  scan: Scan,
  extra?: { extraAlways?: string[]; metadata?: Record<string, unknown> },
) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: [...Array.from(scan.always), ...(extra?.extraAlways ?? [])],
    metadata: extra?.metadata ?? {},
  })
})

export * as ShellScan from "./scan"
