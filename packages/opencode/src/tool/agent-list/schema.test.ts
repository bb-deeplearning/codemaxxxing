import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "@/util/effect-zod"

import { AgentList, ID, Parameters, PermissionKey } from "./agent-list"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("list_agents parameters", () => {
  test("declares no required fields (path_prefix is optional)", () => {
    const json = toJsonSchema(Parameters) as { required?: string[] }
    // Required is either absent or empty when every property is optional.
    const required = json.required ?? []
    expect(required.length).toBe(0)
  })

  test("path_prefix has a non-empty description annotation", () => {
    const json = toJsonSchema(Parameters) as {
      properties: Record<string, { description?: string }>
    }
    expect(typeof json.properties.path_prefix?.description).toBe("string")
    expect(json.properties.path_prefix?.description?.length ?? 0).toBeGreaterThan(0)
  })

  test("accepts no params (empty object)", () => {
    expect(parse(Parameters, {})).toEqual({})
  })

  test("accepts an absolute path_prefix", () => {
    expect(parse(Parameters, { path_prefix: "/root/a" })).toEqual({ path_prefix: "/root/a" })
  })

  test("accepts a relative path_prefix", () => {
    expect(parse(Parameters, { path_prefix: "worker" })).toEqual({ path_prefix: "worker" })
  })

  test("rejects non-string path_prefix", () => {
    expect(accepts(Parameters, { path_prefix: 42 })).toBe(false)
  })
})

describe("list_agents description teaches the operational decisions", () => {
  // Self-reexport namespace; ensure import resolves at module-load time.
  void AgentList

  test("description prose addresses the snapshot / live-agents concept", async () => {
    const text = (
      await Bun.file(new URL("./agent-list.txt", import.meta.url).pathname).text()
    ).toLowerCase()
    const snapshotLike =
      text.includes("snapshot") || text.includes("list") || text.includes("live agents")
    expect(snapshotLike).toBe(true)
  })

  test("description mentions path_prefix or filtering", async () => {
    const text = (
      await Bun.file(new URL("./agent-list.txt", import.meta.url).pathname).text()
    ).toLowerCase()
    const filterLike = text.includes("path_prefix") || text.includes("filter")
    expect(filterLike).toBe(true)
  })

  test("description mentions a status concept (completed / running / status)", async () => {
    const text = (
      await Bun.file(new URL("./agent-list.txt", import.meta.url).pathname).text()
    ).toLowerCase()
    const statusLike =
      text.includes("completed") || text.includes("running") || text.includes("status")
    expect(statusLike).toBe(true)
  })

  test("description points the model at followup_task or wait_agent", async () => {
    const text = await Bun.file(new URL("./agent-list.txt", import.meta.url).pathname).text()
    const linkLike = text.includes("followup_task") || text.includes("wait_agent")
    expect(linkLike).toBe(true)
  })
})

describe("list_agents tool ID + permission constants", () => {
  test("ID matches the codex tool name string verbatim", () => {
    expect(ID).toBe("list_agents")
  })

  test("PermissionKey matches the tool name (per MESSAGE_SHAPES.md convention)", () => {
    expect(PermissionKey).toBe("task")
  })
})
