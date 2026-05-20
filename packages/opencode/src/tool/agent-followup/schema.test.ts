import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "../../util/effect-zod"

import { AgentFollowupTool, ID, Parameters, PermissionKey } from "./agent-followup"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("followup_task parameters", () => {
  test("declares target and message as required fields", () => {
    const json = toJsonSchema(Parameters) as { required: string[]; properties: Record<string, unknown> }
    // toJsonSchema sorts required alphabetically; assert by set membership +
    // length so ordering changes don't break this test.
    expect(json.required.includes("target")).toBe(true)
    expect(json.required.includes("message")).toBe(true)
    expect(json.required).toHaveLength(2)
  })

  test("each parameter has a non-empty description annotation", () => {
    const json = toJsonSchema(Parameters) as {
      properties: Record<string, { description?: string }>
    }
    for (const key of ["target", "message"]) {
      expect(typeof json.properties[key]?.description).toBe("string")
      expect(json.properties[key]?.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("accepts both required fields", () => {
    expect(parse(Parameters, { target: "worker", message: "do next" })).toEqual({
      target: "worker",
      message: "do next",
    })
  })

  test("rejects missing target", () => {
    expect(accepts(Parameters, { message: "do next" })).toBe(false)
  })

  test("rejects missing message", () => {
    expect(accepts(Parameters, { target: "worker" })).toBe(false)
  })

  test("rejects non-string target", () => {
    expect(accepts(Parameters, { target: 42, message: "do next" })).toBe(false)
  })

  test("rejects non-string message", () => {
    expect(accepts(Parameters, { target: "worker", message: 42 })).toBe(false)
  })

  test("accepts an optional correlation_id when supplied", () => {
    expect(parse(Parameters, { target: "worker", message: "do next", correlation_id: "req-1" })).toEqual({
      target: "worker",
      message: "do next",
      correlation_id: "req-1",
    })
  })

  test("correlation_id is OPTIONAL (omitting still parses)", () => {
    expect(parse(Parameters, { target: "worker", message: "do next" })).toEqual({
      target: "worker",
      message: "do next",
    })
  })
})

describe("followup_task description teaches the operational decisions", () => {
  // Loading the description prose from the .txt sidecar — same pattern as
  // agent-send and agent-spawn. The model reads this string at function
  // calling time; the assertions below pin the operational concepts that
  // MUST be taught (without snapshotting wording).
  const description = Bun.file(
    new URL("./agent-followup.txt", import.meta.url).pathname,
  ).text()

  test("teaches the wake / trigger semantics", async () => {
    const text = (await description).toLowerCase()
    const wakeLike =
      text.includes("trigger") || text.includes("wake") || text.includes("next turn")
    expect(wakeLike).toBe(true)
  })

  test("identifies itself as the followup tool (followup / follow-up / follow up)", async () => {
    const text = (await description).toLowerCase()
    const followupLike =
      text.includes("followup") || text.includes("follow-up") || text.includes("follow up")
    expect(followupLike).toBe(true)
  })

  test("contrasts with send_message so the model knows when to pick which", async () => {
    expect(await description).toContain("send_message")
  })

  test("explains the cannot-target-root rule", async () => {
    const text = (await description).toLowerCase()
    expect(text).toContain("root")
  })
})

describe("followup_task tool ID + permission constants", () => {
  test("ID matches the codex tool name string verbatim", () => {
    expect(ID).toBe("followup_task")
  })

  test("PermissionKey matches the tool name (per MESSAGE_SHAPES.md convention)", () => {
    expect(PermissionKey).toBe("task")
  })

  test("AgentFollowupTool exposes the same id under .id for the tool registry", () => {
    expect(AgentFollowupTool.id).toBe("followup_task")
  })
})
