import { describe, expect, test } from "bun:test"
import { AGENT_NAMES } from "./agent-names"

// Sanity tests for the nickname pool. The actual nickname-allocation logic
// lives in registry.ts; these checks just guard the static list so a typo or
// a duplicate doesn't produce a degraded reservation experience.

describe("AGENT_NAMES list", () => {
  test("is non-empty", () => {
    expect(AGENT_NAMES.length).toBeGreaterThan(0)
  })

  test("has at least 100 entries so pool resets are rare", () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(100)
  })

  test("has no duplicates", () => {
    const set = new Set(AGENT_NAMES)
    expect(set.size).toBe(AGENT_NAMES.length)
  })

  test("every entry is a non-empty string", () => {
    for (const name of AGENT_NAMES) {
      expect(typeof name).toBe("string")
      expect(name.length).toBeGreaterThan(0)
    }
  })

  test("every entry uses a sane character set (letters, optionally separated by single spaces)", () => {
    const ALLOWED = /^[A-Za-z]+( [A-Za-z]+)*$/
    for (const name of AGENT_NAMES) {
      expect(name).toMatch(ALLOWED)
    }
  })

  test("no entry has leading or trailing whitespace", () => {
    for (const name of AGENT_NAMES) {
      expect(name).toBe(name.trim())
    }
  })
})
