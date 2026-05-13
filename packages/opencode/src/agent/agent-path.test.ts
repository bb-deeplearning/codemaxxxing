import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { AgentPath, AgentPathInvalidError } from "./agent-path"

const runResult = <A>(eff: Effect.Effect<A, AgentPathInvalidError>) =>
  Effect.runSync(Effect.result(eff))

describe("AgentPath constants", () => {
  test("ROOT static is the literal '/root'", () => {
    expect(String(AgentPath.ROOT)).toBe("/root")
  })

  test("root() returns ROOT", () => {
    expect(String(AgentPath.root())).toBe("/root")
  })

  test("isRoot returns true for the root path", () => {
    expect(AgentPath.isRoot(AgentPath.root())).toBe(true)
  })

  test("isRoot returns false for any nested path", () => {
    const child = Effect.runSync(AgentPath.from("/root/worker"))
    expect(AgentPath.isRoot(child)).toBe(false)
  })
})

describe("AgentPath.from accepts valid absolute paths", () => {
  test("decodes /root", () => {
    const result = runResult(AgentPath.from("/root"))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(String(result.success)).toBe("/root")
  })

  test("decodes /root/a", () => {
    const result = runResult(AgentPath.from("/root/a"))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(String(result.success)).toBe("/root/a")
  })

  test("decodes /root/a/b/c", () => {
    const result = runResult(AgentPath.from("/root/a/b/c"))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(String(result.success)).toBe("/root/a/b/c")
  })

  test("decodes segments containing underscores and digits", () => {
    const result = runResult(AgentPath.from("/root/_x_/task_42"))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(String(result.success)).toBe("/root/_x_/task_42")
  })
})

describe("AgentPath.from rejects invalid paths", () => {
  test("rejects the empty string", () => {
    const result = runResult(AgentPath.from(""))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AgentPathInvalidError)
      expect(result.failure.input).toBe("")
    }
  })

  test("rejects trailing slash", () => {
    const result = runResult(AgentPath.from("/root/"))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toMatch(/trailing|empty/i)
    }
  })

  test("rejects double slash inside path", () => {
    const result = runResult(AgentPath.from("/root//x"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects uppercase characters in a segment", () => {
    const result = runResult(AgentPath.from("/root/Worker"))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toMatch(/lowercase|character/i)
    }
  })

  test("rejects hyphen in a segment", () => {
    const result = runResult(AgentPath.from("/root/a-b"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects path that does not start at /root", () => {
    const result = runResult(AgentPath.from("/foo"))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toMatch(/root/i)
    }
  })

  test("rejects path missing the leading slash", () => {
    const result = runResult(AgentPath.from("root"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects '.' as a segment", () => {
    const result = runResult(AgentPath.from("/root/."))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects '..' as a segment", () => {
    const result = runResult(AgentPath.from("/root/.."))
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("AgentPath.parent", () => {
  test("returns null for root", () => {
    expect(AgentPath.parent(AgentPath.root())).toBeNull()
  })

  test("returns root for /root/a", () => {
    const child = Effect.runSync(AgentPath.from("/root/a"))
    const par = AgentPath.parent(child)
    expect(par).not.toBeNull()
    expect(String(par)).toBe("/root")
  })

  test("returns the prefix for a nested path", () => {
    const grand = Effect.runSync(AgentPath.from("/root/a/b/c"))
    const par = AgentPath.parent(grand)
    expect(String(par)).toBe("/root/a/b")
  })
})

describe("AgentPath.join", () => {
  test("appends a valid leaf to root", () => {
    const child = Effect.runSync(AgentPath.join(AgentPath.root(), "worker"))
    expect(String(child)).toBe("/root/worker")
  })

  test("appends a valid leaf to a nested path", () => {
    const base = Effect.runSync(AgentPath.from("/root/a"))
    const result = Effect.runSync(AgentPath.join(base, "b"))
    expect(String(result)).toBe("/root/a/b")
  })

  test("rejects an empty leaf", () => {
    const result = runResult(AgentPath.join(AgentPath.root(), ""))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects a leaf containing '/'", () => {
    const result = runResult(AgentPath.join(AgentPath.root(), "a/b"))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toMatch(/slash|\//i)
    }
  })

  test("rejects an uppercase leaf", () => {
    const result = runResult(AgentPath.join(AgentPath.root(), "Worker"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects a hyphenated leaf", () => {
    const result = runResult(AgentPath.join(AgentPath.root(), "a-b"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects '.' or '..' as a leaf", () => {
    expect(Result.isFailure(runResult(AgentPath.join(AgentPath.root(), ".")))).toBe(true)
    expect(Result.isFailure(runResult(AgentPath.join(AgentPath.root(), "..")))).toBe(true)
  })
})

describe("AgentPath.resolve relative references", () => {
  test("relative leaf resolves against current", () => {
    const current = Effect.runSync(AgentPath.from("/root/a"))
    const out = Effect.runSync(AgentPath.resolve(current, "task_x"))
    expect(String(out)).toBe("/root/a/task_x")
  })

  test("multi-segment relative reference resolves left-to-right", () => {
    const current = Effect.runSync(AgentPath.from("/root/a"))
    const out = Effect.runSync(AgentPath.resolve(current, "b/c"))
    expect(String(out)).toBe("/root/a/b/c")
  })

  test("relative leaf from root resolves under root", () => {
    const out = Effect.runSync(AgentPath.resolve(AgentPath.root(), "worker"))
    expect(String(out)).toBe("/root/worker")
  })
})

describe("AgentPath.resolve canonical references", () => {
  test("absolute canonical path is returned verbatim", () => {
    const current = Effect.runSync(AgentPath.from("/root/a"))
    const out = Effect.runSync(AgentPath.resolve(current, "/root/x/y"))
    expect(String(out)).toBe("/root/x/y")
  })

  test("absolute root reference returns root", () => {
    const current = Effect.runSync(AgentPath.from("/root/a"))
    const out = Effect.runSync(AgentPath.resolve(current, "/root"))
    expect(String(out)).toBe("/root")
  })

  test("invalid absolute reference fails", () => {
    const current = Effect.runSync(AgentPath.from("/root"))
    const result = runResult(AgentPath.resolve(current, "/foo"))
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("AgentPath.resolve traversal with '..'", () => {
  test("'..' from /root/a/b returns /root/a", () => {
    const current = Effect.runSync(AgentPath.from("/root/a/b"))
    const out = Effect.runSync(AgentPath.resolve(current, ".."))
    expect(String(out)).toBe("/root/a")
  })

  test("'../sibling' walks up then down", () => {
    const current = Effect.runSync(AgentPath.from("/root/a/b"))
    const out = Effect.runSync(AgentPath.resolve(current, "../sibling"))
    expect(String(out)).toBe("/root/a/sibling")
  })

  test("multiple '..' segments walk up multiple levels", () => {
    const current = Effect.runSync(AgentPath.from("/root/a/b/c"))
    const out = Effect.runSync(AgentPath.resolve(current, "../../x"))
    expect(String(out)).toBe("/root/a/x")
  })

  test("'..' that escapes root errors", () => {
    const result = runResult(AgentPath.resolve(AgentPath.root(), ".."))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toMatch(/escape|root/i)
    }
  })

  test("'../..' from /root/a errors because the second step escapes root", () => {
    const current = Effect.runSync(AgentPath.from("/root/a"))
    const result = runResult(AgentPath.resolve(current, "../.."))
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("AgentPath.resolve errors", () => {
  test("empty reference errors", () => {
    const result = runResult(AgentPath.resolve(AgentPath.root(), ""))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("reference with empty segments errors", () => {
    const result = runResult(AgentPath.resolve(AgentPath.root(), "a//b"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("reference with invalid leaf errors", () => {
    const result = runResult(AgentPath.resolve(AgentPath.root(), "Bad"))
    expect(Result.isFailure(result)).toBe(true)
  })

  test("trailing slash on relative reference errors", () => {
    const result = runResult(AgentPath.resolve(AgentPath.root(), "a/"))
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("AgentPath as a Schema field", () => {
  const Wrapper = Schema.Struct({ path: AgentPath })

  test("decodes a valid path inside a schema", () => {
    const result = Schema.decodeUnknownResult(Wrapper)({ path: "/root/a" })
    expect(Result.isSuccess(result)).toBe(true)
  })

  test("rejects an invalid path inside a schema", () => {
    const result = Schema.decodeUnknownResult(Wrapper)({ path: "/foo" })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("encodes back to the underlying string", () => {
    const value = Effect.runSync(AgentPath.from("/root/a"))
    const result = Schema.encodeUnknownSync(Wrapper)({ path: value })
    expect(result).toEqual({ path: "/root/a" })
  })
})

describe("AgentPathInvalidError shape", () => {
  test("carries the input and reason", () => {
    const err = new AgentPathInvalidError({ input: "bad", reason: "no good" })
    expect(err._tag).toBe("AgentPathInvalidError")
    expect(err.input).toBe("bad")
    expect(err.reason).toBe("no good")
    expect(err.message).toContain("bad")
    expect(err.message).toContain("no good")
  })
})
