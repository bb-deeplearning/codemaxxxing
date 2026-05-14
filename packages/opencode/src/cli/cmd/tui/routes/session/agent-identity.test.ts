import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  AgentIdentity as AgentIdentityNS,
  displayNickname,
  displayPath,
  formatAgentIdentity,
  pickPaletteColor,
  _hashString,
} from "./agent-identity"

// Pure-helper tests. No JSX, no provider stack — just verifies the
// formatting + hashing behavior the agent-tool views and the mailbox
// chrome both depend on.

describe("displayNickname", () => {
  test("titlecases a lowercase nickname", () => {
    expect(displayNickname("lovelace")).toBe("Lovelace")
    expect(displayNickname("turing")).toBe("Turing")
  })

  test("returns undefined for missing or empty input", () => {
    expect(displayNickname(undefined)).toBeUndefined()
    expect(displayNickname("")).toBeUndefined()
  })

  test("preserves multi-word nicknames (the 2nd, the 3rd suffix overflow)", () => {
    // The registry pool may suffix repeated nicknames as "Lovelace the 2nd".
    // Locale.titlecase capitalizes each word boundary's first character;
    // the "2" of "2nd" is the boundary, "nd" stays lowercase.
    expect(displayNickname("lovelace the 2nd")).toBe("Lovelace The 2nd")
  })
})

describe("displayPath", () => {
  test("strips a leading slash", () => {
    expect(displayPath("/root/git_historian")).toBe("root/git_historian")
  })

  test("returns the path unchanged when there's no leading slash", () => {
    expect(displayPath("root/git_historian")).toBe("root/git_historian")
  })

  test("returns undefined for missing input", () => {
    expect(displayPath(undefined)).toBeUndefined()
  })

  test("handles a path that's just '/'", () => {
    expect(displayPath("/")).toBe("")
  })
})

describe("formatAgentIdentity", () => {
  test("nickname + agent_type → 'Nickname type'", () => {
    expect(formatAgentIdentity({ nickname: "lovelace", agent_type: "explore" })).toBe("Lovelace explore")
  })

  test("nickname only → 'Nickname'", () => {
    expect(formatAgentIdentity({ nickname: "newton" })).toBe("Newton")
  })

  test("path only → display path with slash stripped", () => {
    expect(formatAgentIdentity({ path: "/root/worker_a" })).toBe("root/worker_a")
  })

  test("path + agent_type without nickname falls back to path (type is ignored)", () => {
    // Type-without-nickname is rare — only happens at validation-error
    // time when we have agent_type from input but no nickname yet.
    // The path is the more specific identifier so we use it alone.
    expect(formatAgentIdentity({ path: "/root/worker_a", agent_type: "explore" })).toBe("root/worker_a")
  })

  test("empty identity → 'agent' fallback", () => {
    expect(formatAgentIdentity({})).toBe("agent")
  })
})

describe("pickPaletteColor", () => {
  const PALETTE = [
    RGBA.fromHex("#ff0000"),
    RGBA.fromHex("#00ff00"),
    RGBA.fromHex("#0000ff"),
    RGBA.fromHex("#ffff00"),
    RGBA.fromHex("#ff00ff"),
  ]

  test("returns a stable color per nickname (same input → same output)", () => {
    const a = pickPaletteColor(PALETTE, { nickname: "lovelace" })
    const b = pickPaletteColor(PALETTE, { nickname: "lovelace" })
    expect(a).toBe(b)
  })

  test("different nicknames in the same palette pick from the palette", () => {
    // Don't assert distinct colors (palette is small, hash may collide) —
    // assert they're members of the palette and the function is total.
    const a = pickPaletteColor(PALETTE, { nickname: "lovelace" })
    const b = pickPaletteColor(PALETTE, { nickname: "newton" })
    expect(PALETTE).toContain(a)
    expect(PALETTE).toContain(b)
  })

  test("falls back to path when nickname is absent", () => {
    const a = pickPaletteColor(PALETTE, { path: "/root/git_historian" })
    expect(PALETTE).toContain(a)
  })

  test("uses the 'agent' literal when both nickname and path are absent", () => {
    const a = pickPaletteColor(PALETTE, {})
    expect(PALETTE).toContain(a)
  })

  test("throws on an empty palette", () => {
    expect(() => pickPaletteColor([], { nickname: "lovelace" })).toThrow(/empty palette/)
  })

  test("single-color palette returns that color regardless of input", () => {
    const single = [RGBA.fromHex("#abcdef")]
    expect(pickPaletteColor(single, { nickname: "lovelace" })).toBe(single[0])
    expect(pickPaletteColor(single, { nickname: "newton" })).toBe(single[0])
    expect(pickPaletteColor(single, {})).toBe(single[0])
  })
})

describe("_hashString (FNV-1a)", () => {
  test("returns the same hash for the same input", () => {
    expect(_hashString("lovelace")).toBe(_hashString("lovelace"))
  })

  test("returns a non-negative 32-bit integer", () => {
    const h = _hashString("any string here")
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(2 ** 32)
  })

  test("empty string hashes to the FNV offset basis", () => {
    expect(_hashString("")).toBe(0x811c9dc5)
  })

  test("differs for closely-related inputs (basic dispersion sanity)", () => {
    expect(_hashString("a")).not.toBe(_hashString("b"))
    expect(_hashString("lovelace")).not.toBe(_hashString("Lovelace"))
  })
})

describe("namespace projection", () => {
  test("AgentIdentity namespace re-exports the public surface", () => {
    expect(AgentIdentityNS.displayNickname).toBe(displayNickname)
    expect(AgentIdentityNS.displayPath).toBe(displayPath)
    expect(AgentIdentityNS.formatAgentIdentity).toBe(formatAgentIdentity)
    expect(AgentIdentityNS.pickPaletteColor).toBe(pickPaletteColor)
  })
})
