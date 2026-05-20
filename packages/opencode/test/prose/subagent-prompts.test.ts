// Wave 1 — prose grep harness for subagent prompt surfaces.
//
// Asserts the post-Wave-1 invariants from PROMPT_SURFACES.md without
// shelling out: read each prompt .txt as a string and use
// expect(...).toContain / .not.toContain. Plain bun:test (no Effect)
// because this is pure text I/O.
//
// Targets:
// - general/anthropic.txt, general/gemini.txt, explore.txt: subagent
//   base prompts. Must NOT carry "text-is-deliverable" framing
//   (forbidden phrases), MUST carry a pointer to the delivery contract
//   capability hint (required phrase).
// - multi-agent-subagent.txt: subagent capability hint. Delivery
//   contract section must literally name the tool calls — send_message
//   and close_agent — so the model has unambiguous instructions.
// - multi-agent-root.txt: root capability hint. Must carry D7 sibling
//   coordination doctrine ("unicast") and D8 limits-of-actor-model
//   doctrine ("no broadcast", "sibling introspection", "idle").
//
// Phrase wording is inlined here (not loaded from PROMPT_SURFACES.md)
// so the test is durable across plan edits: only deliberate prompt
// changes can break it, and any change to the canonical phrase list
// requires updating BOTH this file and PROMPT_SURFACES.md.

import { describe, expect, test } from "bun:test"

const anthropicPath = new URL("../../src/agent/prompt/general/anthropic.txt", import.meta.url).pathname
const geminiPath = new URL("../../src/agent/prompt/general/gemini.txt", import.meta.url).pathname
const explorePath = new URL("../../src/agent/prompt/explore.txt", import.meta.url).pathname
const subagentHintPath = new URL("../../src/agent/prompt/multi-agent-subagent.txt", import.meta.url).pathname
const rootHintPath = new URL("../../src/agent/prompt/multi-agent-root.txt", import.meta.url).pathname

// Forbidden phrases per PROMPT_SURFACES.md § "Forbidden phrases".
// These imply text-is-deliverable framing that contradicts the
// delivery contract; the contract is authoritative, base prompts
// must defer.
const FORBIDDEN_PHRASES = [
  "your text response IS the deliverable",
  "your response goes to the parent agent",
  "the parent agent reads your output",
] as const

// Required phrase per PROMPT_SURFACES.md § "Required phrases".
// Every subagent base prompt acknowledges the contract's existence
// so the model does not ignore the later capability-hint layer.
const REQUIRED_PHRASE = "See the delivery contract in your multi-agent coordination guidance."

const BASE_PROMPTS = [
  { name: "general/anthropic.txt", path: anthropicPath },
  { name: "general/gemini.txt", path: geminiPath },
  { name: "explore.txt", path: explorePath },
] as const

describe("Wave 1 — subagent base prompts defer to delivery contract", () => {
  for (const prompt of BASE_PROMPTS) {
    for (const phrase of FORBIDDEN_PHRASES) {
      test(`${prompt.name} does NOT contain forbidden phrase: ${phrase}`, async () => {
        const text = await Bun.file(prompt.path).text()
        expect(text).not.toContain(phrase)
      })
    }

    test(`${prompt.name} contains required delivery-contract pointer`, async () => {
      const text = await Bun.file(prompt.path).text()
      expect(text).toContain(REQUIRED_PHRASE)
    })
  }
})

describe("Wave 1 — multi-agent-subagent.txt names the delivery contract tools", () => {
  test("multi-agent-subagent.txt contains literal 'send_message'", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("send_message")
  })

  test("multi-agent-subagent.txt contains literal 'close_agent'", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("close_agent")
  })
})

describe("Wave 1 — multi-agent-root.txt carries D7 sibling coordination + D8 limits doctrine", () => {
  // D7: sibling coordination — unicast doctrine. The send primitives
  // address one target each; reaching N peers requires N calls.
  test("multi-agent-root.txt contains D7 doctrine: 'unicast'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("unicast")
  })

  // D8: limits of actor model — explicit non-features. Each substring
  // asserts one of the four "the runtime does NOT do X" guarantees.
  test("multi-agent-root.txt contains D8 limit: 'no broadcast'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("no broadcast")
  })

  test("multi-agent-root.txt contains D8 limit: 'sibling introspection'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("sibling introspection")
  })

  test("multi-agent-root.txt contains D8 limit: 'idle'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("idle")
  })
})
