import { describe, expect, test } from "bun:test"
import { loadPermissionConfig, loadScannerCorpus } from "./load-config"

const FIXTURE_NAMES = [
  "empty-config",
  "allow-all-bash",
  "deny-all-bash",
  "git-allow-rest-ask",
  "task-explore-allow",
  "task-explore-deny",
  "deny-all-task",
  "mixed-permissions",
  "tools-bash-false",
  "tools-task-false",
  "agent-overrides-deny-bash",
]

describe("permission config fixtures", () => {
  for (const name of FIXTURE_NAMES) {
    test(`loads ${name}`, async () => {
      const cfg = await loadPermissionConfig(name)
      expect(cfg).toBeDefined()
      expect(typeof cfg).toBe("object")
      expect(cfg).not.toBeNull()
    })
  }
})

describe("scanner corpus", () => {
  test("loads and is well-formed", async () => {
    const corpus = await loadScannerCorpus()
    expect(Array.isArray(corpus)).toBe(true)
    expect(corpus.length).toBeGreaterThanOrEqual(50)
    for (const entry of corpus) {
      expect(typeof entry.cmd).toBe("string")
      expect(Array.isArray(entry.expected_patterns)).toBe(true)
      expect(Array.isArray(entry.expected_always)).toBe(true)
      expect(Array.isArray(entry.expected_dirs)).toBe(true)
      for (const p of entry.expected_patterns) expect(typeof p).toBe("string")
      for (const a of entry.expected_always) expect(typeof a).toBe("string")
      for (const d of entry.expected_dirs) expect(typeof d).toBe("string")
    }
  })
})
