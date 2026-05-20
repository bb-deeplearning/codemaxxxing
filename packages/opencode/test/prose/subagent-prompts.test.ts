// Wave 1 — prose grep harness for subagent prompt surfaces.
//
// Asserts the post-Wave-1 prose invariants without shelling out: read
// each prompt .txt as a string and use expect(...).toContain /
// .not.toContain. Plain bun:test (no Effect) because this is pure text
// I/O. The canonical spec for these invariants lives in the campaign
// plan's prompt-surfaces doc.
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
// Phrase wording is inlined here (not loaded from the plan spec)
// so the test is durable across plan edits: only deliberate prompt
// changes can break it, and any change to the canonical phrase list
// requires updating BOTH this file and the spec.

import { describe, expect, test } from "bun:test"

const anthropicPath = new URL("../../src/agent/prompt/general/anthropic.txt", import.meta.url).pathname
const geminiPath = new URL("../../src/agent/prompt/general/gemini.txt", import.meta.url).pathname
const explorePath = new URL("../../src/agent/prompt/explore.txt", import.meta.url).pathname
const subagentHintPath = new URL("../../src/agent/prompt/multi-agent-subagent.txt", import.meta.url).pathname
const rootHintPath = new URL("../../src/agent/prompt/multi-agent-root.txt", import.meta.url).pathname

// Forbidden phrases per the plan spec § "Forbidden phrases".
// These imply text-is-deliverable framing that contradicts the
// delivery contract; the contract is authoritative, base prompts
// must defer.
const FORBIDDEN_PHRASES = [
  "your text response IS the deliverable",
  "your response goes to the parent agent",
  "the parent agent reads your output",
] as const

// Required phrase per the plan spec § "Required phrases".
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

// Wave 2 — INV-D-06 regression. Pins the unicast doctrine in both the
// root prompt (D7 + D8 — unicast + no broadcast) and the subagent prompt
// (D7 mirror sentence Wave 1 landed). The traceability slug
// `ses_1d84f236bffe` ties this block to diagnostic-session-2 (Demo 2:
// The People v. Frankfurter), where prosecutor and defense both filed
// to /root and idled waiting for each other's reply. The runtime IS
// unicast (locked by INV-D-06-regression-ses_1d84f236bffe in the
// integration suite); the bug was prose — the prompts did not tell the
// model to address peers directly. This block keeps that prose pin.
describe("Wave 2 — INV-D-06 regression: unicast doctrine pinned (ses_1d84f236bffe Demo 2)", () => {
  test("multi-agent-root.txt contains 'unicast'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("unicast")
  })

  test("multi-agent-root.txt contains 'no broadcast'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("no broadcast")
  })

  test("multi-agent-subagent.txt contains 'unicast'", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("unicast")
  })
})

// Wave 3 — Phase 2A. Mandatory-timeout doctrine and wait_for_reply variant
// land in the root + subagent prompts. The root prompt owns the full
// "Wait timeouts" doctrine; the subagent prompt mirrors with a single bullet
// pointing at wait_for_reply. Grep-asserts pin the prose so a future prompt
// rewrite that drops the doctrine fails this test.
describe("Wave 3 — mandatory-timeout doctrine + wait_for_reply variant", () => {
  test("multi-agent-root.txt contains '## Wait timeouts' section header", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("## Wait timeouts")
  })

  test("multi-agent-root.txt mentions wait_for_reply", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("wait_for_reply")
  })

  test("multi-agent-root.txt 'Wait timeouts' section states 'Every wait MUST'", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("Every wait MUST")
  })

  test("multi-agent-root.txt mentions missing_timeout warning tag", async () => {
    const text = await Bun.file(rootHintPath).text()
    expect(text).toContain("missing_timeout")
  })

  test("multi-agent-subagent.txt mentions wait_for_reply", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("wait_for_reply")
  })

  test("multi-agent-subagent.txt mentions correlation_id (mirror sentence references the parameter)", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("correlation_id")
  })
})

// Wave 4 — D11 ABORT protocol prose. The capability hint
// multi-agent-subagent.txt owns the full ABORT section: header, format
// string, and the six official reasons. The 3 base prompts (anthropic,
// gemini, explore) carry a brief reference so model fork choice still
// surfaces ABORT existence regardless of agent_type. Grep-asserts pin
// the prose so a future rewrite that drops the doctrine fails this
// test. Mirrors the structure of T2's runtime parser and T3's prose
// landings; the integration tests INV-D-12..14 exercise the runtime
// side.
describe("Wave 4 — ABORT protocol prose", () => {
  test("multi-agent-subagent.txt contains '## ABORT' section header", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("## ABORT")
  })

  test("multi-agent-subagent.txt contains literal 'ABORT(<reason>):' format string", async () => {
    const text = await Bun.file(subagentHintPath).text()
    expect(text).toContain("ABORT(<reason>):")
  })

  const ABORT_REASONS = [
    "spec_wrong",
    "transient_tool_error",
    "out_of_scope",
    "context_full",
    "approach_failed",
    "user_question",
  ] as const

  for (const reason of ABORT_REASONS) {
    test(`multi-agent-subagent.txt contains reason: ${reason}`, async () => {
      const text = await Bun.file(subagentHintPath).text()
      expect(text).toContain(reason)
    })
  }

  for (const prompt of BASE_PROMPTS) {
    test(`${prompt.name} contains brief ABORT reference (substring 'ABORT(')`, async () => {
      const text = await Bun.file(prompt.path).text()
      expect(text).toContain("ABORT(")
    })
  }
})
