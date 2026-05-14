import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "@/util/effect-zod"

import { AgentSpawn, errorTagFor, ID, Parameters, PermissionKey } from "./agent-spawn"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("spawn_agent parameters", () => {
  test("required = message + task_name", () => {
    const json = toJsonSchema(Parameters)
    expect((json.required ?? []).slice().sort()).toEqual(["message", "task_name"])
  })

  test("each parameter has a non-empty description annotation", () => {
    const json = toJsonSchema(Parameters) as { properties: Record<string, { description?: string }> }
    for (const key of ["message", "task_name", "agent_type", "fork_turns", "model", "reasoning_effort"]) {
      expect(typeof json.properties[key]?.description).toBe("string")
      expect(json.properties[key]?.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("accepts message + task_name only", () => {
    expect(parse(Parameters, { message: "do x", task_name: "worker" })).toEqual({
      message: "do x",
      task_name: "worker",
    })
  })

  test("accepts all optional fields", () => {
    const parsed = parse(Parameters, {
      message: "do x",
      task_name: "worker",
      agent_type: "explore",
      fork_turns: "3",
      model: "claude-x",
      reasoning_effort: "high",
    })
    expect(parsed.agent_type).toBe("explore")
    expect(parsed.fork_turns).toBe("3")
    expect(parsed.model).toBe("claude-x")
    expect(parsed.reasoning_effort).toBe("high")
  })

  test("rejects missing message", () => {
    expect(accepts(Parameters, { task_name: "worker" })).toBe(false)
  })

  test("rejects missing task_name", () => {
    expect(accepts(Parameters, { message: "do x" })).toBe(false)
  })

  test("rejects non-string message", () => {
    expect(accepts(Parameters, { message: 42, task_name: "worker" })).toBe(false)
  })

  test("rejects non-string task_name", () => {
    expect(accepts(Parameters, { message: "do x", task_name: 42 })).toBe(false)
  })
})

describe("spawn_agent description teaches the operational decisions", () => {
  const def = AgentSpawn // self-reexport namespace; ensure import resolves
  void def

  test("description prose length is at least 1500 chars (operational ground)", async () => {
    const text = await Bun.file(new URL("./agent-spawn.txt", import.meta.url).pathname).text()
    expect(text.length).toBeGreaterThanOrEqual(1500)
  })

  test("covers key operational concepts (delegate, parallel, /root, task_name, wait_agent, concurrent, depth)", async () => {
    const text = (await Bun.file(new URL("./agent-spawn.txt", import.meta.url).pathname).text()).toLowerCase()
    expect(text).toContain("delegate")
    expect(text).toContain("parallel")
    expect(text).toContain("/root")
    expect(text).toContain("task_name")
    expect(text).toContain("wait_agent")
    expect(text).toContain("concurrent")
    expect(text).toContain("depth")
  })

  test("mentions at least one of explorer/worker", async () => {
    const text = (await Bun.file(new URL("./agent-spawn.txt", import.meta.url).pathname).text()).toLowerCase()
    expect(text).toMatch(/explorer|worker/)
  })

  test("mentions at least one of cost/budget", async () => {
    const text = (await Bun.file(new URL("./agent-spawn.txt", import.meta.url).pathname).text()).toLowerCase()
    expect(text).toMatch(/cost|budget/)
  })
})

describe("tool ID + permission constants", () => {
  test("ID matches codex string 'spawn_agent'", () => {
    expect(ID).toBe("spawn_agent")
  })
  test("PermissionKey is the 'spawn_agent' string (matches tool name)", () => {
    expect(PermissionKey).toBe("spawn_agent")
  })
})

describe("errorTagFor maps every typed SpawnError tag", () => {
  test("AgentDepthExceededError → depth_exceeded", () => {
    expect(errorTagFor({ _tag: "AgentDepthExceededError" })).toBe("depth_exceeded")
  })
  test("AgentLimitReachedError → limit_reached", () => {
    expect(errorTagFor({ _tag: "AgentLimitReachedError" })).toBe("limit_reached")
  })
  test("AgentPathInvalidError → path_invalid", () => {
    expect(errorTagFor({ _tag: "AgentPathInvalidError" })).toBe("path_invalid")
  })
  test("PathAlreadyExistsError → path_exists", () => {
    expect(errorTagFor({ _tag: "PathAlreadyExistsError" })).toBe("path_exists")
  })
  test("NoNicknameAvailableError → no_nickname", () => {
    expect(errorTagFor({ _tag: "NoNicknameAvailableError" })).toBe("no_nickname")
  })
})
