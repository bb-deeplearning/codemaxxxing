import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { toJsonSchema } from "../../util/effect-zod"

import { Parameters as ExecCommandParameters } from "./exec-command"
import { Parameters as WriteStdinParameters } from "./write-stdin"
import { EXEC_COMMAND_PROMPT, WRITE_STDIN_PROMPT } from "./prompt"
import { ExecCommandID, PermissionKey, WriteStdinID, pidPattern } from "./id"
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_TTY,
  DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  PROCESS_ID_RANGE_MAX,
  PROCESS_ID_RANGE_MIN,
  UNIFIED_EXEC_ENV,
  approxTokenCount,
  clampEmptyPollYieldTime,
  clampWriteYieldTime,
} from "./constants"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

describe("exec_command parameters", () => {
  test("includes cmd as required, all other params optional", () => {
    const json = toJsonSchema(ExecCommandParameters)
    expect(json.required).toEqual(["cmd"])
    expect(typeof json.properties).toBe("object")
  })

  test("decode strips unknown additional properties (effect schema default; matches existing tools)", () => {
    // Effect Schema's Struct silently strips unknown fields on decode rather
    // than rejecting them — matches the rest of the opencode tool surface
    // (shell, edit, write, etc all behave this way). Codex's spec uses
    // additionalProperties: false to reject; we get the same observable
    // behaviour because the model's extras don't reach the executor.
    const decoded = Schema.decodeUnknownSync(ExecCommandParameters)({ cmd: "ls", made_up_field: 42 } as never)
    expect(decoded.cmd).toBe("ls")
    expect((decoded as Record<string, unknown>).made_up_field).toBeUndefined()
  })

  test("each parameter has a description annotation", () => {
    const json = toJsonSchema(ExecCommandParameters) as { properties: Record<string, { description?: string }> }
    for (const key of ["cmd", "workdir", "shell", "tty", "yield_time_ms", "max_output_tokens"]) {
      expect(typeof json.properties[key]?.description).toBe("string")
      expect(json.properties[key]?.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("accepts cmd-only", () => {
    expect(parse(ExecCommandParameters, { cmd: "ls" })).toEqual({ cmd: "ls" })
  })

  test("accepts all optional fields", () => {
    const parsed = parse(ExecCommandParameters, {
      cmd: "node",
      workdir: "/tmp",
      shell: "/bin/zsh",
      tty: true,
      yield_time_ms: 5000,
      max_output_tokens: 8000,
    })
    expect(parsed.cmd).toBe("node")
    expect(parsed.tty).toBe(true)
    expect(parsed.yield_time_ms).toBe(5000)
  })

  test("rejects missing cmd", () => {
    expect(accepts(ExecCommandParameters, {})).toBe(false)
  })

  test("rejects non-string cmd", () => {
    expect(accepts(ExecCommandParameters, { cmd: 42 })).toBe(false)
  })
})

describe("write_stdin parameters", () => {
  test("includes session_id as required", () => {
    const json = toJsonSchema(WriteStdinParameters)
    expect(json.required).toEqual(["session_id"])
  })

  test("decode strips unknown additional properties (effect schema default)", () => {
    const decoded = Schema.decodeUnknownSync(WriteStdinParameters)({ session_id: 1234, made_up: "x" } as never)
    expect(decoded.session_id).toBe(1234)
    expect((decoded as Record<string, unknown>).made_up).toBeUndefined()
  })

  test("each parameter has a description annotation", () => {
    const json = toJsonSchema(WriteStdinParameters) as { properties: Record<string, { description?: string }> }
    for (const key of ["session_id", "chars", "yield_time_ms", "max_output_tokens"]) {
      expect(typeof json.properties[key]?.description).toBe("string")
      expect(json.properties[key]?.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("accepts session_id-only", () => {
    expect(parse(WriteStdinParameters, { session_id: 1234 })).toEqual({ session_id: 1234 })
  })

  test("accepts all optional fields", () => {
    const parsed = parse(WriteStdinParameters, {
      session_id: 5000,
      chars: "hello\n",
      yield_time_ms: 250,
      max_output_tokens: 8000,
    })
    expect(parsed.session_id).toBe(5000)
    expect(parsed.chars).toBe("hello\n")
  })

  test("rejects missing session_id", () => {
    expect(accepts(WriteStdinParameters, { chars: "hi" })).toBe(false)
  })

  test("rejects non-numeric session_id", () => {
    expect(accepts(WriteStdinParameters, { session_id: "1234" })).toBe(false)
  })
})

describe("exec_command description teaches the operational decisions", () => {
  // The prose isn't snapshotted (over-fixates on wording) but the key
  // operational concepts MUST be addressed. If a future edit drops one of
  // these, the model loses important guidance and the test fails.
  test("addresses persistence (vs one-shot)", () => {
    expect(EXEC_COMMAND_PROMPT.toLowerCase()).toContain("persistent")
  })
  test("mentions REPL use case", () => {
    expect(EXEC_COMMAND_PROMPT.toLowerCase()).toMatch(/repl/)
  })
  test("explains the tty: true requirement for write_stdin", () => {
    expect(EXEC_COMMAND_PROMPT.toLowerCase()).toContain("tty")
    expect(EXEC_COMMAND_PROMPT).toContain("write_stdin")
  })
  test("describes session_id round-trip semantics", () => {
    expect(EXEC_COMMAND_PROMPT).toContain("session_id")
  })
  test("communicates the yield_time_ms clamp range", () => {
    expect(EXEC_COMMAND_PROMPT).toMatch(/250/)
    expect(EXEC_COMMAND_PROMPT).toMatch(/30000|30,000|30s|30 sec/)
  })
  test("documents the head/tail truncation behaviour", () => {
    expect(EXEC_COMMAND_PROMPT.toLowerCase()).toMatch(/head.{0,5}tail|head\+tail|head and tail/)
  })
  test("warns that session_id does not survive opencode restart", () => {
    expect(EXEC_COMMAND_PROMPT.toLowerCase()).toContain("restart")
  })
  test("documents the LRU pool cap", () => {
    expect(EXEC_COMMAND_PROMPT).toMatch(/64/)
  })
  test("contrasts with bash/shell tool", () => {
    expect(EXEC_COMMAND_PROMPT.toLowerCase()).toMatch(/bash|shell/)
  })
})

describe("write_stdin description teaches the operational decisions", () => {
  test("addresses empty-poll discipline", () => {
    expect(WRITE_STDIN_PROMPT.toLowerCase()).toMatch(/empty|pure poll|poll/)
  })
  test("documents the 5000ms minimum poll floor", () => {
    expect(WRITE_STDIN_PROMPT).toMatch(/5000|5 sec|5s\b|5-second/)
  })
  test("documents the tty requirement for non-empty chars", () => {
    expect(WRITE_STDIN_PROMPT.toLowerCase()).toContain("tty")
  })
  test("mentions session_id semantics", () => {
    expect(WRITE_STDIN_PROMPT).toContain("session_id")
  })
  test("explains both modes (poll vs interactive write)", () => {
    expect(WRITE_STDIN_PROMPT.toLowerCase()).toMatch(/poll/)
    expect(WRITE_STDIN_PROMPT.toLowerCase()).toMatch(/write|interactive|input|stdin/)
  })
  test("warns about Unknown session_id outcomes", () => {
    expect(WRITE_STDIN_PROMPT.toLowerCase()).toMatch(/unknown|re-spawn|respawn/)
  })
})

describe("tool ID + permission constants", () => {
  test("ExecCommandID.ToolID matches codex string", () => {
    expect(ExecCommandID.ToolID).toBe("exec_command")
  })
  test("WriteStdinID.ToolID matches codex string", () => {
    expect(WriteStdinID.ToolID).toBe("write_stdin")
  })
  test("PermissionKey is the shared 'exec_command' string", () => {
    expect(PermissionKey).toBe("exec_command")
  })
  test("pidPattern formats as pid:<id>", () => {
    expect(pidPattern(1234)).toBe("pid:1234")
    expect(pidPattern(99_999)).toBe("pid:99999")
  })
})

describe("constants module", () => {
  test("yield-time bounds match codex", () => {
    expect(MIN_YIELD_TIME_MS).toBe(250)
    expect(MAX_YIELD_TIME_MS).toBe(30_000)
    expect(MIN_EMPTY_YIELD_TIME_MS).toBe(5_000)
  })
  test("per-tool defaults match codex", () => {
    expect(DEFAULT_EXEC_YIELD_TIME_MS).toBe(10_000)
    expect(DEFAULT_WRITE_STDIN_YIELD_TIME_MS).toBe(250)
    expect(DEFAULT_TTY).toBe(false)
  })
  test("process id range matches codex", () => {
    expect(PROCESS_ID_RANGE_MIN).toBe(1_000)
    expect(PROCESS_ID_RANGE_MAX).toBe(100_000)
  })
  test("UNIFIED_EXEC_ENV matches codex except for OPENCODE_CI rename", () => {
    const map = new Map(UNIFIED_EXEC_ENV)
    expect(map.get("NO_COLOR")).toBe("1")
    expect(map.get("TERM")).toBe("dumb")
    expect(map.get("LANG")).toBe("C.UTF-8")
    expect(map.get("LC_CTYPE")).toBe("C.UTF-8")
    expect(map.get("LC_ALL")).toBe("C.UTF-8")
    expect(map.get("COLORTERM")).toBe("")
    expect(map.get("PAGER")).toBe("cat")
    expect(map.get("GIT_PAGER")).toBe("cat")
    expect(map.get("GH_PAGER")).toBe("cat")
    expect(map.get("OPENCODE_CI")).toBe("1")
    // Confirm the rename: codex's CODEX_CI is NOT present.
    expect(map.has("CODEX_CI")).toBe(false)
  })
  test("approxTokenCount mirrors codex bytes/4", () => {
    expect(approxTokenCount("")).toBe(0)
    expect(approxTokenCount("a")).toBe(1)
    expect(approxTokenCount("a".repeat(100))).toBe(25)
    // Multi-byte: "é" is 2 bytes UTF-8 → 1 token (ceil(2/4) = 1).
    expect(approxTokenCount("é")).toBe(1)
  })
  describe("clampWriteYieldTime", () => {
    test("zero/negative floors to MIN_YIELD_TIME_MS", () => {
      expect(clampWriteYieldTime(0)).toBe(250)
      expect(clampWriteYieldTime(-100)).toBe(250)
    })
    test("between 250 and 30000 passes through", () => {
      expect(clampWriteYieldTime(1_000)).toBe(1_000)
      expect(clampWriteYieldTime(15_000)).toBe(15_000)
    })
    test("over MAX_YIELD_TIME_MS caps at 30000", () => {
      expect(clampWriteYieldTime(60_000)).toBe(30_000)
    })
  })
  describe("clampEmptyPollYieldTime", () => {
    test("under 5000 floors to MIN_EMPTY_YIELD_TIME_MS", () => {
      expect(clampEmptyPollYieldTime(0)).toBe(5_000)
      expect(clampEmptyPollYieldTime(250)).toBe(5_000)
      expect(clampEmptyPollYieldTime(4_999)).toBe(5_000)
    })
    test("between 5000 and the cap passes through", () => {
      expect(clampEmptyPollYieldTime(5_000)).toBe(5_000)
      expect(clampEmptyPollYieldTime(60_000)).toBe(60_000)
    })
    test("over the cap saturates at the cap", () => {
      expect(clampEmptyPollYieldTime(600_000)).toBe(300_000)
    })
    test("custom cap parameter is honoured (test-only injection)", () => {
      expect(clampEmptyPollYieldTime(20_000, 10_000)).toBe(10_000)
      expect(clampEmptyPollYieldTime(7_000, 10_000)).toBe(7_000)
    })
  })
})
