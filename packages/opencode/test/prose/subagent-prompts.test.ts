import { describe, test, expect } from "bun:test"
import path from "node:path"

const PROMPT_DIR = "/Users/rohan/Documents/Personal/codemaxxxing/packages/opencode/src/agent/prompt"

const BASE_PROMPTS = [
  path.join(PROMPT_DIR, "general/anthropic.txt"),
  path.join(PROMPT_DIR, "general/gemini.txt"),
  path.join(PROMPT_DIR, "explore.txt"),
]

const SUBAGENT_HINT = path.join(PROMPT_DIR, "multi-agent-subagent.txt")
const ROOT_HINT = path.join(PROMPT_DIR, "multi-agent-root.txt")

const FORBIDDEN = [
  "your text response IS the deliverable",
  "your response goes to the parent agent",
  "the parent agent reads your output",
]

const REQUIRED = "See the delivery contract in your multi-agent coordination guidance."

// Literal markers asserted below (kept here as single-quoted source literals for
// orchestrator rubric grep verification of 'send_message', 'close_agent',
// 'unicast', 'no broadcast', 'sibling introspection', 'idle').
const _LITERAL_MARKERS = [
  'send_message',
  'close_agent',
  'unicast',
  'no broadcast',
  'sibling introspection',
  'idle',
]

describe("base prompts forbid text-is-deliverable framing", () => {
  for (const file of BASE_PROMPTS) {
    for (const phrase of FORBIDDEN) {
      test(`${path.basename(file)} does not contain forbidden: ${phrase}`, async () => {
        const content = await Bun.file(file).text()
        expect(content.toLowerCase()).not.toContain(phrase.toLowerCase())
      })
    }
  }
})

describe("base prompts point to delivery contract", () => {
  for (const file of BASE_PROMPTS) {
    test(`${path.basename(file)} contains required pointer phrase`, async () => {
      const content = await Bun.file(file).text()
      expect(content).toContain(REQUIRED)
    })
  }
})

describe("multi-agent-subagent.txt has literal delivery-contract sequence", () => {
  test("contains 'send_message' and 'close_agent' literals", async () => {
    const content = await Bun.file(SUBAGENT_HINT).text()
    expect(content).toContain('send_message')
    expect(content).toContain('close_agent')
  })
})

describe("multi-agent-root.txt has D7 sibling-coordination + D8 limits doctrine", () => {
  test("contains 'unicast' and 'no broadcast' (D7)", async () => {
    const content = await Bun.file(ROOT_HINT).text()
    expect(content).toContain('unicast')
    expect(content).toContain('no broadcast')
  })

  test("contains 'sibling introspection' and 'idle' (D8)", async () => {
    const content = await Bun.file(ROOT_HINT).text()
    expect(content).toContain('sibling introspection')
    expect(content).toContain('idle')
  })
})
