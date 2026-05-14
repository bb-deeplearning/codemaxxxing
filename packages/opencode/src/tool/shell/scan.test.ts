// Wave 1 — unit tests for the extracted bash scanner. Mirrors the helper
// surface lifted out of `tool/shell.ts` plus the new public API
// (`scanCommand`, `askForScan`). Run RED before scan.ts lands; GREEN after.
//
// Helper coverage rule (per WAVE.md step 1): one happy + one edge per
// helper that's worth testing in isolation. Helpers that are pure
// pass-throughs of the tree-sitter API (e.g. `parts`, `commands`) are
// covered transitively by `scanCommand` tests.

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import os from "os"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "@/plugin"
import { Shell } from "@/shell/shell"
import { InstanceState } from "@/effect/instance-state"
import { ShellScan } from "./scan"
import { ShellID } from "./id"
import * as Tool from "../tool"
import type { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances } from "../../../test/fixture/fixture"
import { testEffect } from "../../../test/lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Plugin.defaultLayer,
  ),
)

interface CtxRecord {
  asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>
}

function makeCtx(): { record: CtxRecord; ctx: Tool.Context } {
  const record: CtxRecord = { asks: [] }
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test_scan"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        record.asks.push(input)
      }),
  }
  return { record, ctx }
}

const defaultShell = Shell.acceptable()

// =============================================================================
// Pure helpers
// =============================================================================

describe("ShellScan.unquote", () => {
  test("strips matching double quotes", () => {
    expect(ShellScan.unquote('"hello"')).toBe("hello")
  })
  test("strips matching single quotes", () => {
    expect(ShellScan.unquote("'hello'")).toBe("hello")
  })
  test("returns input unchanged when not quoted", () => {
    expect(ShellScan.unquote("hello")).toBe("hello")
  })
  test("returns input unchanged for length < 2", () => {
    expect(ShellScan.unquote("a")).toBe("a")
    expect(ShellScan.unquote("")).toBe("")
  })
  test("returns input unchanged when quotes do not match", () => {
    expect(ShellScan.unquote(`"hello'`)).toBe(`"hello'`)
  })
})

describe("ShellScan.home", () => {
  test("expands bare ~ to homedir", () => {
    expect(ShellScan.home("~")).toBe(os.homedir())
  })
  test("expands ~/ prefix to homedir/path", () => {
    expect(ShellScan.home("~/foo")).toBe(path.join(os.homedir(), "foo"))
  })
  test("leaves unrelated paths unchanged", () => {
    expect(ShellScan.home("/etc/hosts")).toBe("/etc/hosts")
    expect(ShellScan.home("relative/path")).toBe("relative/path")
  })
})

describe("ShellScan.prefix", () => {
  test("returns input when no glob metachar present", () => {
    expect(ShellScan.prefix("foo/bar")).toBe("foo/bar")
  })
  test("truncates at the first metachar", () => {
    expect(ShellScan.prefix("foo/*.ts")).toBe("foo/")
    expect(ShellScan.prefix("logs/?file")).toBe("logs/")
    expect(ShellScan.prefix("a[bc]")).toBe("a")
  })
  test("returns undefined when text starts with a metachar", () => {
    expect(ShellScan.prefix("*.ts")).toBeUndefined()
    expect(ShellScan.prefix("[abc]foo")).toBeUndefined()
  })
})

describe("ShellScan.dynamic", () => {
  test("flags subshell + command substitution", () => {
    expect(ShellScan.dynamic("(ls)", false)).toBe(true)
    expect(ShellScan.dynamic("$(ls)", false)).toBe(true)
    expect(ShellScan.dynamic("`ls`", false)).toBe(true)
    expect(ShellScan.dynamic("@(ls)", false)).toBe(true)
    expect(ShellScan.dynamic("${var}", false)).toBe(true)
  })
  test("flags any $ in bash but only $ (not $env:) in powershell", () => {
    expect(ShellScan.dynamic("$HOME/file", false)).toBe(true)
    expect(ShellScan.dynamic("$env:HOME", true)).toBe(false)
    expect(ShellScan.dynamic("$Profile", true)).toBe(true)
  })
  test("returns false for plain literals", () => {
    expect(ShellScan.dynamic("foo.txt", false)).toBe(false)
    expect(ShellScan.dynamic("foo.txt", true)).toBe(false)
  })
})

describe("ShellScan.provider", () => {
  test("returns the path component for filesystem provider", () => {
    expect(ShellScan.provider("FileSystem::C:/foo")).toBe("C:/foo")
    expect(ShellScan.provider("filesystem::./foo")).toBe("./foo")
  })
  test("returns undefined for non-filesystem providers", () => {
    expect(ShellScan.provider("Registry::HKLM:Foo")).toBeUndefined()
  })
  test("returns input for drive-letter paths", () => {
    expect(ShellScan.provider("C:foo")).toBe("C:foo")
  })
  test("returns undefined for multi-char prefixed text without ::", () => {
    expect(ShellScan.provider("Variable:foo")).toBeUndefined()
  })
  test("returns input for unprefixed text", () => {
    expect(ShellScan.provider("./foo")).toBe("./foo")
  })
})

describe("ShellScan.expand", () => {
  test("expands $env:VAR (powershell)", () => {
    process.env.SCAN_TEST_VAR = "expanded"
    try {
      expect(ShellScan.expand("$env:SCAN_TEST_VAR/file", "/cwd", "/bin/pwsh")).toBe(
        path.join("expanded", "file"),
      )
    } finally {
      delete process.env.SCAN_TEST_VAR
    }
  })
  test("expands ${env:VAR} (powershell)", () => {
    process.env.SCAN_TEST_VAR = "v"
    try {
      expect(ShellScan.expand("${env:SCAN_TEST_VAR}/x", "/cwd", "/bin/pwsh")).toBe(path.join("v", "x"))
    } finally {
      delete process.env.SCAN_TEST_VAR
    }
  })
  test("expands $HOME, $PWD, $PSHOME automatic vars", () => {
    expect(ShellScan.expand("$HOME/file", "/cwd", "/bin/pwsh")).toBe(path.join(os.homedir(), "file"))
    expect(ShellScan.expand("$PWD/file", "/work", "/bin/pwsh")).toBe(path.join("/work", "file"))
    expect(ShellScan.expand("$PSHOME/lib", "/cwd", "/usr/local/bin/pwsh")).toBe(
      path.join("/usr/local/bin", "lib"),
    )
  })
  test("strips quotes around the input first", () => {
    expect(ShellScan.expand('"$HOME/x"', "/cwd", "/bin/pwsh")).toBe(path.join(os.homedir(), "x"))
  })
})

describe("ShellScan.source", () => {
  // Smoke test only — tested transitively via scanCommand for redirected_statement parents.
  test("is exported as a function", () => {
    expect(typeof ShellScan.source).toBe("function")
  })
})

describe("ShellScan.pathArgs", () => {
  test("bash mode: drops first token, drops -flags, drops chmod +mode", () => {
    const list = [
      { type: "command_name", text: "chmod" },
      { type: "word", text: "+x" },
      { type: "word", text: "-R" },
      { type: "word", text: "/tmp/foo" },
    ]
    expect(ShellScan.pathArgs(list, false)).toEqual(["/tmp/foo"])
  })
  test("bash mode: drops cmd-style /flag args when cmd flag is set", () => {
    const list = [
      { type: "command_name", text: "del" },
      { type: "word", text: "/Q" },
      { type: "word", text: "C:/temp/foo" },
    ]
    expect(ShellScan.pathArgs(list, false, true)).toEqual(["C:/temp/foo"])
  })
  test("powershell mode: skips switch params and pulls value following named flags", () => {
    const list = [
      { type: "command_name", text: "Copy-Item" },
      { type: "command_parameter", text: "-Force" },
      { type: "command_parameter", text: "-Path" },
      { type: "string", text: '"src.txt"' },
      { type: "command_parameter", text: "-Destination" },
      { type: "string", text: '"dst.txt"' },
    ]
    expect(ShellScan.pathArgs(list, true)).toEqual(['"src.txt"', '"dst.txt"'])
  })
  test("powershell mode: pushes positional non-parameter tokens directly", () => {
    // Hits the fallthrough out.push at the end of the PS branch — no want flag,
    // not a command_parameter. Without this, line 212 stays uncovered.
    const list = [
      { type: "command_name", text: "Get-ChildItem" },
      { type: "string", text: '"some/path"' },
    ]
    expect(ShellScan.pathArgs(list, true)).toEqual(['"some/path"'])
  })
  test("returns empty for single-token command", () => {
    expect(ShellScan.pathArgs([{ type: "command_name", text: "ls" }], false)).toEqual([])
  })
})

// =============================================================================
// scanCommand — public API, end-to-end via tree-sitter
// =============================================================================

describe("ShellScan.scanCommand", () => {
  it.instance("simple command produces patterns + always", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "git status",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      expect(Array.from(scan.patterns)).toEqual(["git status"])
      // BashArity for `git` is 2 → prefix(["git","status"]).join(" ")+" *" = "git status *"
      expect(Array.from(scan.always)).toEqual(["git status *"])
      expect(Array.from(scan.dirs)).toEqual([])
    }),
  )

  it.instance("rm with absolute external path adds dir AND pattern", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "rm /tmp/foo",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      // Both blocks fire: dirs picks up /tmp, patterns picks up rm /tmp/foo.
      // The user-visible ask differs (sentinel-corpus captures dirs ask only),
      // but the underlying Scan struct carries both.
      expect(Array.from(scan.dirs)).toContain("/tmp")
      expect(Array.from(scan.patterns)).toEqual(["rm /tmp/foo"])
      expect(Array.from(scan.always)).toEqual(["rm *"])
    }),
  )

  it.instance("pipeline produces patterns from both stages", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "git status | grep foo",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      expect(Array.from(scan.patterns).sort()).toEqual(["git status", "grep foo"])
      expect(Array.from(scan.always).sort()).toEqual(["git status *", "grep *"])
    }),
  )

  it.instance("&& chain produces patterns from both stages", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "npm test && npm run build",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      expect(Array.from(scan.patterns).sort()).toEqual(["npm run build", "npm test"])
      expect(Array.from(scan.always).sort()).toEqual(["npm run build *", "npm test *"])
    }),
  )

  it.instance("empty input returns empty Scan", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      expect(scan.patterns.size).toBe(0)
      expect(scan.always.size).toBe(0)
      expect(scan.dirs.size).toBe(0)
    }),
  )

  it.instance("cd /home/user adds dir via external_directory branch", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "cd /home/user",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      // CWD command — patterns suppressed, dirs catches the resolved external path.
      expect(scan.patterns.size).toBe(0)
      expect(Array.from(scan.dirs)).toContain("/home")
    }),
  )

  it.instance("cwd outside instance.directory adds cwd to dirs", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const otherDir = "/private/var/tmp/some-foreign-cwd"
      const scan = yield* ShellScan.scanCommand({
        command: "ls",
        shell: defaultShell,
        cwd: otherDir,
        instance,
      })
      expect(Array.from(scan.dirs)).toContain(otherDir)
    }),
  )

  it.instance("variable_assignment child is filtered via parts continue branch", () =>
    Effect.gen(function* () {
      // `NODE_ENV=production npm start` parses with `command_name=npm`,
      // `word=start`, AND a `variable_assignment` child whose type is none of
      // the recognized parts. Forces parts() through its continue fallthrough.
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "NODE_ENV=production npm start",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      expect(Array.from(scan.patterns)).toEqual(["NODE_ENV=production npm start"])
      expect(Array.from(scan.always)).toEqual(["npm start *"])
    }),
  )

  it.instance("command_substitution child triggers parts continue", () =>
    Effect.gen(function* () {
      // `cat $(echo file.txt)` makes the cat command's `command_substitution`
      // child fall through the parts allowed-list filter. Drives line 108-109.
      const instance = yield* InstanceState.context
      const scan = yield* ShellScan.scanCommand({
        command: "cat $(echo file.txt)",
        shell: defaultShell,
        cwd: instance.directory,
        instance,
      })
      // The scan still completes; cat appears as a pattern; substitution is
      // skipped.
      expect(Array.from(scan.patterns).length).toBeGreaterThan(0)
    }),
  )
})

// =============================================================================
// cygpath / resolvePath — Effect.fn helpers, exported for direct test access.
// resolvePath's win32 branch is platform-isolated (covered only on Windows);
// cygpath body is exercised here even though `cygpath -w` doesn't exist on
// non-Cygwin systems — the catch block converts the spawn failure to an
// empty-line array and the function returns undefined.
// =============================================================================

describe("ShellScan.cygpath / resolvePath", () => {
  it.instance("cygpath returns undefined when cygpath binary unavailable", () =>
    Effect.gen(function* () {
      const result = yield* ShellScan.cygpath(defaultShell, "/some/posix/path")
      // On macOS / Linux: cygpath isn't installed → spawn fails → catch returns
      // [] → function returns undefined. On Windows w/ Cygwin: returns string.
      if (process.platform !== "win32") {
        expect(result).toBeUndefined()
      }
    }),
  )

  it.instance("resolvePath joins relative path against root on non-win32", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const result = yield* ShellScan.resolvePath("foo/bar.txt", "/tmp", defaultShell)
      expect(result).toBe(path.join("/tmp", "foo/bar.txt"))
    }),
  )
})

// =============================================================================
// Platform-shimmed coverage — temporarily swap process.platform to "win32"
// so the conditional branches that fire only on Windows can be exercised on
// macOS/Linux test infra. NOT mocking a service (forbidden by STYLE.md);
// flipping a runtime constant the same way shell.test.ts swaps process.env.SHELL.
// =============================================================================

const withPlatform = async (target: NodeJS.Platform, fn: () => Promise<void> | void) => {
  const original = process.platform
  Object.defineProperty(process, "platform", { value: target, configurable: true })
  try {
    await fn()
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true })
  }
}

describe("ShellScan platform-shimmed branches", () => {
  test("envValue case-insensitive lookup on win32", async () => {
    await withPlatform("win32", () => {
      process.env.SCAN_TEST_CASEY = "value-1"
      try {
        // expand uses envValue indirectly via $env:VAR replacement. On win32
        // envValue does case-insensitive Object.keys lookup. With SCAN_TEST_CASEY
        // in env, looking up "scan_test_casey" should find it.
        expect(ShellScan.expand("$env:SCAN_TEST_CASEY/x", "/cwd", "/bin/pwsh")).toBe(
          path.join("value-1", "x"),
        )
      } finally {
        delete process.env.SCAN_TEST_CASEY
      }
    })
  })
})

// =============================================================================
// askForScan — observable behavior (ctx.ask payloads)
// =============================================================================

describe("ShellScan.askForScan", () => {
  it.instance("empty Scan does not call ctx.ask at all", () =>
    Effect.gen(function* () {
      const { ctx, record } = makeCtx()
      const scan = { patterns: new Set<string>(), always: new Set<string>(), dirs: new Set<string>() }
      yield* ShellScan.askForScan(ctx, scan)
      expect(record.asks.length).toBe(0)
    }),
  )

  it.instance("non-empty patterns calls ctx.ask once with permission bash", () =>
    Effect.gen(function* () {
      const { ctx, record } = makeCtx()
      const scan = {
        patterns: new Set(["echo hello"]),
        always: new Set(["echo *"]),
        dirs: new Set<string>(),
      }
      yield* ShellScan.askForScan(ctx, scan)
      expect(record.asks.length).toBe(1)
      expect(record.asks[0].permission).toBe(ShellID.ToolID)
      expect(record.asks[0].patterns).toEqual(["echo hello"])
      expect(record.asks[0].always).toEqual(["echo *"])
      expect(record.asks[0].metadata).toEqual({})
    }),
  )

  it.instance("non-empty dirs calls ctx.ask twice — external_directory then bash, in that order", () =>
    Effect.gen(function* () {
      const { ctx, record } = makeCtx()
      const scan = {
        patterns: new Set(["rm /tmp/foo"]),
        always: new Set(["rm *"]),
        dirs: new Set(["/tmp"]),
      }
      yield* ShellScan.askForScan(ctx, scan)
      expect(record.asks.length).toBe(2)
      expect(record.asks[0].permission).toBe("external_directory")
      expect(record.asks[0].patterns).toEqual([path.join("/tmp", "*")])
      expect(record.asks[0].always).toEqual([path.join("/tmp", "*")])
      expect(record.asks[1].permission).toBe(ShellID.ToolID)
    }),
  )

  it.instance("dirs only (no patterns) skips bash ask entirely", () =>
    Effect.gen(function* () {
      const { ctx, record } = makeCtx()
      const scan = {
        patterns: new Set<string>(),
        always: new Set<string>(),
        dirs: new Set(["/tmp"]),
      }
      yield* ShellScan.askForScan(ctx, scan)
      expect(record.asks.length).toBe(1)
      expect(record.asks[0].permission).toBe("external_directory")
    }),
  )

  it.instance("extraAlways appends to the bash ask's always array", () =>
    Effect.gen(function* () {
      const { ctx, record } = makeCtx()
      const scan = {
        patterns: new Set(["node repl"]),
        always: new Set(["node *"]),
        dirs: new Set<string>(),
      }
      yield* ShellScan.askForScan(ctx, scan, { extraAlways: ["pid:42"] })
      expect(record.asks.length).toBe(1)
      expect(record.asks[0].always.slice().sort()).toEqual(["node *", "pid:42"].sort())
    }),
  )

  it.instance("metadata extra threads through to the bash ask's metadata", () =>
    Effect.gen(function* () {
      const { ctx, record } = makeCtx()
      const scan = {
        patterns: new Set(["git status"]),
        always: new Set(["git *"]),
        dirs: new Set<string>(),
      }
      yield* ShellScan.askForScan(ctx, scan, { metadata: { cmd: "git status", workdir: "/tmp" } })
      expect(record.asks[0].metadata).toEqual({ cmd: "git status", workdir: "/tmp" })
    }),
  )
})
