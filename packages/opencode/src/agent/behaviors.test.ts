import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  ABORT_REASONS,
  BehaviorContract,
  BehaviorViolation,
  DEFAULT_CONTRACTS,
  computeViolations,
  exploreSubagentV1,
  generalSubagentV1,
  generalSubagentV2,
  resolveContract,
} from "./behaviors"

// D16 (actor-discipline-2026-05-20 Wave 8) — unit tests for the pure
// behavior-contract surface in `behaviors.ts`. The module has no Effect
// runtime so plain `describe` + `test` blocks suffice (no `it.live`).
//
// Coverage target: 100% LINES on src/agent/behaviors.ts via single-file
// run `bun test --coverage src/agent/behaviors.test.ts`. Function
// coverage may stay <100% on Schema.Class instances per GOTCHA
// `schema-class-function-coverage`.

describe("ABORT_REASONS constant", () => {
  test("contains exactly six canonical reasons in declared order", () => {
    expect(ABORT_REASONS).toEqual([
      "spec_wrong",
      "transient_tool_error",
      "out_of_scope",
      "context_full",
      "approach_failed",
      "user_question",
    ])
    expect(ABORT_REASONS.length).toBe(6)
  })
})

describe("BehaviorContract schema", () => {
  test("decodes a minimal happy-path payload", () => {
    const decoded = Schema.decodeUnknownSync(BehaviorContract)({
      version: "subagent_v1",
      delivery: "send_message_required",
      termination: "self_close",
      declared_failure_modes: ["spec_wrong", "out_of_scope"],
    })
    expect(decoded.version).toBe("subagent_v1")
    expect(decoded.delivery).toBe("send_message_required")
    expect(decoded.termination).toBe("self_close")
    expect(decoded.declared_failure_modes).toEqual(["spec_wrong", "out_of_scope"])
    expect(decoded.expected_outputs).toBeUndefined()
    expect(decoded.exempt).toBeUndefined()
  })

  test("preserves optional expected_outputs + exempt fields when supplied", () => {
    const decoded = Schema.decodeUnknownSync(BehaviorContract)({
      version: "subagent_v2",
      delivery: "send_message_optional",
      termination: "either",
      declared_failure_modes: ["spec_wrong"],
      expected_outputs: { kind: "free_text" },
      exempt: true,
    })
    expect(decoded.expected_outputs?.kind).toBe("free_text")
    expect(decoded.exempt).toBe(true)
  })

  test("rejects an unknown version literal", () => {
    const result = Schema.decodeUnknownResult(BehaviorContract)({
      version: "subagent_v9",
      delivery: "send_message_required",
      termination: "self_close",
      declared_failure_modes: [],
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects an unknown delivery literal", () => {
    const result = Schema.decodeUnknownResult(BehaviorContract)({
      version: "subagent_v1",
      delivery: "fire_and_pray",
      termination: "self_close",
      declared_failure_modes: [],
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects a missing required field", () => {
    const result = Schema.decodeUnknownResult(BehaviorContract)({
      version: "subagent_v1",
      delivery: "send_message_required",
      termination: "self_close",
      // declared_failure_modes missing
    })
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("BehaviorViolation schema", () => {
  test("decodes a happy-path payload", () => {
    const decoded = Schema.decodeUnknownSync(BehaviorViolation)({
      kind: "missing_delivery",
      detail: "child did not call send_message",
    })
    expect(decoded.kind).toBe("missing_delivery")
    expect(decoded.detail).toBe("child did not call send_message")
  })

  test("rejects an unknown ViolationKind", () => {
    const result = Schema.decodeUnknownResult(BehaviorViolation)({
      kind: "ghost_in_the_shell",
      detail: "...",
    })
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("DEFAULT_CONTRACTS structure", () => {
  test("registers exactly the native subagent types: general + explore", () => {
    expect(Object.keys(DEFAULT_CONTRACTS).sort()).toEqual(["explore", "general"])
  })

  test("general carries both subagent_v1 and subagent_v2 with v1 as default", () => {
    const entry = DEFAULT_CONTRACTS["general"]
    expect(entry.default_version).toBe("subagent_v1")
    expect(Object.keys(entry.versions).sort()).toEqual(["subagent_v1", "subagent_v2"])
    expect(entry.versions["subagent_v1"]).toBe(generalSubagentV1)
    expect(entry.versions["subagent_v2"]).toBe(generalSubagentV2)
  })

  test("explore carries only subagent_v1 with v1 as default", () => {
    const entry = DEFAULT_CONTRACTS["explore"]
    expect(entry.default_version).toBe("subagent_v1")
    expect(Object.keys(entry.versions)).toEqual(["subagent_v1"])
    expect(entry.versions["subagent_v1"]).toBe(exploreSubagentV1)
  })

  test("generalSubagentV1 declares all six ABORT_REASONS", () => {
    expect([...generalSubagentV1.declared_failure_modes].sort()).toEqual([...ABORT_REASONS].sort())
  })

  test("exploreSubagentV1 declares five reasons EXCLUDING approach_failed", () => {
    expect(exploreSubagentV1.declared_failure_modes.length).toBe(5)
    expect(exploreSubagentV1.declared_failure_modes.includes("approach_failed")).toBe(false)
    expect(exploreSubagentV1.declared_failure_modes.includes("spec_wrong")).toBe(true)
  })

  test("generalSubagentV2 declares free_text expected_outputs", () => {
    expect(generalSubagentV2.version).toBe("subagent_v2")
    expect(generalSubagentV2.termination).toBe("either")
    expect(generalSubagentV2.expected_outputs?.kind).toBe("free_text")
  })
})

describe("resolveContract", () => {
  test("returns undefined when agent_type is undefined", () => {
    expect(resolveContract(undefined)).toBeUndefined()
  })

  test("returns undefined for an unknown agent_type", () => {
    expect(resolveContract("ghost_type")).toBeUndefined()
  })

  test("returns the default-version contract when version is omitted", () => {
    expect(resolveContract("general")).toBe(generalSubagentV1)
    expect(resolveContract("explore")).toBe(exploreSubagentV1)
  })

  test("returns the explicit-version contract when version is supplied", () => {
    expect(resolveContract("general", "subagent_v2")).toBe(generalSubagentV2)
    expect(resolveContract("general", "subagent_v1")).toBe(generalSubagentV1)
  })

  test("returns undefined when explicit version does not exist for the agent_type", () => {
    expect(resolveContract("explore", "subagent_v2")).toBeUndefined()
    expect(resolveContract("general", "subagent_v99")).toBeUndefined()
  })
})

describe("computeViolations", () => {
  test("returns [] when contract is undefined (no registered contract)", () => {
    expect(computeViolations(undefined, { delivered: false })).toEqual([])
  })

  test("returns [] when contract.exempt is true regardless of observed", () => {
    const exempt = new BehaviorContract({
      version: "subagent_v1",
      delivery: "send_message_required",
      termination: "self_close",
      declared_failure_modes: [],
      exempt: true,
    })
    expect(
      computeViolations(exempt, {
        delivered: false,
        abortReason: { reason: "ghost_reason", details: "..." },
      }),
    ).toEqual([])
  })

  test("raises missing_delivery when delivery=send_message_required AND !delivered", () => {
    const v = computeViolations(generalSubagentV1, { delivered: false })
    expect(v.length).toBe(1)
    expect(v[0].kind).toBe("missing_delivery")
  })

  test("does NOT raise missing_delivery when delivery=send_message_required AND delivered", () => {
    const v = computeViolations(generalSubagentV1, { delivered: true })
    expect(v).toEqual([])
  })

  test("does NOT raise missing_delivery when delivery=send_message_optional AND !delivered", () => {
    const optional = new BehaviorContract({
      version: "subagent_v1",
      delivery: "send_message_optional",
      termination: "self_close",
      declared_failure_modes: [...ABORT_REASONS],
    })
    expect(computeViolations(optional, { delivered: false })).toEqual([])
  })

  test("raises undeclared_failure_mode when abortReason is not in declared set", () => {
    const v = computeViolations(exploreSubagentV1, {
      delivered: true,
      abortReason: { reason: "approach_failed", details: "explore retried but quit" },
    })
    expect(v.length).toBe(1)
    expect(v[0].kind).toBe("undeclared_failure_mode")
    expect(v[0].detail).toContain("approach_failed")
  })

  test("does NOT raise undeclared_failure_mode when abortReason is in declared set", () => {
    const v = computeViolations(generalSubagentV1, {
      delivered: true,
      abortReason: { reason: "spec_wrong", details: "spec was wrong" },
    })
    expect(v).toEqual([])
  })

  test("raises BOTH missing_delivery AND undeclared_failure_mode when both fail", () => {
    const v = computeViolations(exploreSubagentV1, {
      delivered: false,
      abortReason: { reason: "approach_failed", details: "..." },
    })
    expect(v.length).toBe(2)
    const kinds = v.map((x) => x.kind).sort()
    expect(kinds).toEqual(["missing_delivery", "undeclared_failure_mode"])
  })
})
