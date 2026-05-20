import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "../../util/effect-zod"

import { ID, Parameters, PermissionKey } from "./agent-close"
import DESCRIPTION from "./agent-close.txt"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("close_agent parameters", () => {
  // D3 (actor-discipline-2026-05-20) — target is OPTIONAL. Omitting it
  // resolves to the caller's canonical path (self-close). Pre-D3 the
  // schema required target; this assertion is the regression-pin for the
  // optional shape.
  test("omits target from required list (D3 — self-close form)", () => {
    const json = toJsonSchema(Parameters)
    expect(json.required ?? []).not.toContain("target")
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

  test("accepts missing target (D3 — self-close)", () => {
    expect(accepts(Parameters, {})).toBe(true)
  })

  test("accepts explicit undefined target (D3 — same as omission)", () => {
    expect(accepts(Parameters, { target: undefined })).toBe(true)
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

  test("PermissionKey equals 'task' (Wave 3 collapsed)", () => {
    expect(PermissionKey).toBe("task")
  })
})
