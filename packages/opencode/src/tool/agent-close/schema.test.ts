import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "../../util/effect-zod"

import { ID, Parameters, PermissionKey } from "./agent-close"
import DESCRIPTION from "./agent-close.txt"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("close_agent parameters", () => {
  test("includes target as required", () => {
    const json = toJsonSchema(Parameters)
    expect(json.required).toEqual(["target"])
  })

  test("target field has a non-empty description", () => {
    const json = toJsonSchema(Parameters) as {
      properties: Record<string, { description?: string }>
    }
    expect(typeof json.properties.target?.description).toBe("string")
    expect(json.properties.target?.description?.length ?? 0).toBeGreaterThan(0)
  })

  test("accepts a string target", () => {
    expect(accepts(Parameters, { target: "worker" })).toBe(true)
  })

  test("rejects missing target", () => {
    expect(accepts(Parameters, {})).toBe(false)
  })

  test("rejects non-string target", () => {
    expect(accepts(Parameters, { target: 42 })).toBe(false)
  })
})

describe("close_agent description teaches the operational decisions", () => {
  const lower = DESCRIPTION.toLowerCase()

  test("explains the close / shutdown action", () => {
    expect(lower).toMatch(/close|shut\s*down/)
  })

  test("explains cascade to descendants", () => {
    expect(lower).toMatch(/descendant|cascade|children/)
  })

  test("notes that root cannot be closed", () => {
    expect(lower).toContain("root")
  })

  test("documents the previous_status return", () => {
    expect(lower).toMatch(/previous[_ ]status/)
  })
})

describe("close_agent constants", () => {
  test("ID equals 'close_agent'", () => {
    expect(ID).toBe("close_agent")
  })

  test("PermissionKey equals 'close_agent'", () => {
    expect(PermissionKey).toBe("close_agent")
  })
})
