import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "../../util/effect-zod"

import { AgentWaitTool, AgentWaitForReplyTool, ID, Parameters, PermissionKey, WaitForReplyID, WaitForReplyParameters } from "./agent-wait"
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  MIN_WAIT_TIMEOUT_MS,
  clampWaitTimeout,
} from "./constants"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("wait_agent parameters", () => {
  test("declares no required fields (timeout_ms is optional)", () => {
    const json = toJsonSchema(Parameters) as { required?: string[] }
    expect(json.required === undefined || json.required.length === 0).toBe(true)
  })

  test("timeout_ms has a non-empty description annotation", () => {
    const json = toJsonSchema(Parameters) as {
      properties: Record<string, { description?: string }>
    }
    expect(typeof json.properties["timeout_ms"]?.description).toBe("string")
    expect(json.properties["timeout_ms"]?.description?.length ?? 0).toBeGreaterThan(0)
  })

  test("accepts an empty object", () => {
    expect(parse(Parameters, {})).toEqual({})
  })

  test("accepts timeout_ms = 5000", () => {
    const decoded = parse(Parameters, { timeout_ms: 5000 })
    expect(decoded.timeout_ms).toBe(5000)
  })

  test("rejects timeout_ms as a string", () => {
    expect(accepts(Parameters, { timeout_ms: "not a number" })).toBe(false)
  })
})

describe("wait_agent description teaches the operational decisions", () => {
  const description = Bun.file(
    new URL("./agent-wait.txt", import.meta.url).pathname,
  ).text()

  test("mentions mailbox or update concept", async () => {
    const text = (await description).toLowerCase()
    const ok = text.includes("mailbox") || text.includes("update")
    expect(ok).toBe(true)
  })

  test("explains that result is a summary, not the actual mail body", async () => {
    const text = (await description).toLowerCase()
    const ok = text.includes("summary") || text.includes("summary, not")
    expect(ok).toBe(true)
  })

  test("teaches that the actual mail surfaces in the next turn", async () => {
    const text = (await description).toLowerCase()
    expect(text).toContain("next turn")
  })

  test("documents the timed_out / timeout outcome", async () => {
    const text = (await description).toLowerCase()
    const ok = text.includes("timed out") || text.includes("timeout")
    expect(ok).toBe(true)
  })

  test("warns that wait_agent blocks productive work", async () => {
    const text = (await description).toLowerCase()
    expect(text).toContain("block")
  })
})

describe("wait_agent tool ID + permission constants", () => {
  test("ID is the codex tool name string verbatim", () => {
    expect(ID).toBe("wait_agent")
  })

  test("PermissionKey matches the tool name (per MESSAGE_SHAPES.md convention)", () => {
    expect(PermissionKey).toBe("task")
  })

  test("AgentWaitTool exposes the same id under .id", () => {
    expect(AgentWaitTool.id).toBe("wait_agent")
  })
})

describe("wait_agent constants", () => {
  test("DEFAULT_WAIT_TIMEOUT_MS matches codex multi_agents_common.rs:32", () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(30_000)
  })

  test("MIN_WAIT_TIMEOUT_MS = 1_000 (DEFAULT_MULTI_AGENT_V2_MIN_WAIT_TIMEOUT_MS)", () => {
    expect(MIN_WAIT_TIMEOUT_MS).toBe(1_000)
  })

  test("MAX_WAIT_TIMEOUT_MS = 600_000 (10 min cap)", () => {
    expect(MAX_WAIT_TIMEOUT_MS).toBe(600_000)
  })

  describe("clampWaitTimeout", () => {
    test("below MIN floors to MIN_WAIT_TIMEOUT_MS", () => {
      expect(clampWaitTimeout(500)).toBe(1_000)
    })
    test("between MIN and MAX passes through", () => {
      expect(clampWaitTimeout(50_000)).toBe(50_000)
    })
    test("above MAX caps at MAX_WAIT_TIMEOUT_MS", () => {
      expect(clampWaitTimeout(700_000)).toBe(600_000)
    })
  })
})

describe("wait_for_reply parameters", () => {
  test("declares correlation_id as the only required field (timeout_ms optional)", () => {
    const json = toJsonSchema(WaitForReplyParameters) as { required?: string[] }
    expect(json.required).toEqual(["correlation_id"])
  })

  test("correlation_id has a non-empty description annotation", () => {
    const json = toJsonSchema(WaitForReplyParameters) as {
      properties: Record<string, { description?: string }>
    }
    expect(typeof json.properties["correlation_id"]?.description).toBe("string")
    expect(json.properties["correlation_id"]?.description?.length ?? 0).toBeGreaterThan(0)
  })

  test("accepts { correlation_id: 'req-1' }", () => {
    const decoded = parse(WaitForReplyParameters, { correlation_id: "req-1" })
    expect(decoded.correlation_id).toBe("req-1")
  })

  test("accepts { correlation_id: 'req-1', timeout_ms: 5000 }", () => {
    const decoded = parse(WaitForReplyParameters, { correlation_id: "req-1", timeout_ms: 5000 })
    expect(decoded.correlation_id).toBe("req-1")
    expect(decoded.timeout_ms).toBe(5000)
  })

  test("rejects missing correlation_id", () => {
    expect(accepts(WaitForReplyParameters, {})).toBe(false)
    expect(accepts(WaitForReplyParameters, { timeout_ms: 5000 })).toBe(false)
  })

  test("rejects non-string correlation_id", () => {
    expect(accepts(WaitForReplyParameters, { correlation_id: 42 })).toBe(false)
  })
})

describe("wait_for_reply tool ID constants", () => {
  test("WaitForReplyID is the literal 'wait_for_reply'", () => {
    expect(WaitForReplyID).toBe("wait_for_reply")
  })

  test("AgentWaitForReplyTool exposes the same id under .id", () => {
    expect(AgentWaitForReplyTool.id).toBe("wait_for_reply")
  })
})
