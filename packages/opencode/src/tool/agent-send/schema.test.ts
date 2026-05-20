import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "../../util/effect-zod"

import { AgentSendTool, ID, Parameters, PermissionKey } from "./agent-send"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("send_message parameters", () => {
  test("declares target and message as required fields", () => {
    const json = toJsonSchema(Parameters) as { required: string[]; properties: Record<string, unknown> }
    // toJsonSchema sorts required alphabetically; assert by set membership.
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
    expect(parse(Parameters, { target: "worker", message: "hi" })).toEqual({
      target: "worker",
      message: "hi",
    })
  })

  test("rejects missing target", () => {
    expect(accepts(Parameters, { message: "hi" })).toBe(false)
  })

  test("rejects missing message", () => {
    expect(accepts(Parameters, { target: "worker" })).toBe(false)
  })

  test("rejects non-string target", () => {
    expect(accepts(Parameters, { target: 42, message: "hi" })).toBe(false)
  })

  test("rejects non-string message", () => {
    expect(accepts(Parameters, { target: "worker", message: 42 })).toBe(false)
  })

  test("accepts an optional correlation_id when supplied", () => {
    expect(parse(Parameters, { target: "worker", message: "hi", correlation_id: "req-1" })).toEqual({
      target: "worker",
      message: "hi",
      correlation_id: "req-1",
    })
  })

  test("correlation_id is OPTIONAL (omitting still parses)", () => {
    expect(parse(Parameters, { target: "worker", message: "hi" })).toEqual({
      target: "worker",
      message: "hi",
    })
  })
})

describe("send_message description teaches the operational decisions", () => {
  // Loading the actual tool definition exposes the description string the
  // model will receive at function-calling time. The description must teach
  // the model when to use this tool, when to reach for followup_task
  // instead, and how the mailbox actually works.
  const description = (
    Bun.file(
      new URL("./agent-send.txt", import.meta.url).pathname,
    )
  ).text()

  test("describes the queue / fire-and-forget semantics", async () => {
    const text = (await description).toLowerCase()
    const queueLike =
      text.includes("queue") || text.includes("queued") || text.includes("fire-and-forget")
    expect(queueLike).toBe(true)
  })

  test("teaches that the recipient is NOT triggered / woken", async () => {
    const text = (await description).toLowerCase()
    const triggerLike = text.includes("trigger") || text.includes("wake")
    expect(triggerLike).toBe(true)
  })

  test("points the model at followup_task for the trigger-a-turn case", async () => {
    expect(await description).toContain("followup_task")
  })

  test("explains the next-turn / drain semantics", async () => {
    const text = (await description).toLowerCase()
    const turnLike = text.includes("next turn") || text.includes("drain")
    expect(turnLike).toBe(true)
  })
})

describe("send_message tool ID + permission constants", () => {
  test("ID matches the codex tool name string verbatim", () => {
    expect(ID).toBe("send_message")
  })

  test("PermissionKey matches the tool name (per MESSAGE_SHAPES.md convention)", () => {
    expect(PermissionKey).toBe("task")
  })

  test("AgentSendTool exposes the same id under .id for the tool registry", () => {
    expect(AgentSendTool.id).toBe("send_message")
  })
})
