/** @jsxImportSource @opentui/solid */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import {
  MailboxMessage,
  isMailboxPart,
  stripMailboxPrefix,
  formatMailboxAuthor,
  type MailboxMessageTheme,
} from "./mailbox-message"
import type { TextPart } from "@opencode-ai/sdk/v2"

// Wave 11: cross-agent message rendering.
//
// Wave 9's runLoop drains queued mailbox messages from siblings into a
// synthetic user turn. Each one becomes a TextPart with synthetic=true,
// metadata.from set to the sender's AgentPath, metadata.sent_at, and
// metadata.trigger_turn. The body is prefixed with "[from <author>]: " so
// the model sees the source even without metadata. The TUI renders the
// part with explicit chrome instead of as a normal user text part — the
// chrome is what tells the human reader who sent it.

const FAKE_THEME: MailboxMessageTheme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  border: RGBA.fromHex("#444444"),
}

const AGENT_COLOR = RGBA.fromHex("#00ff00")

const mailboxPart = (overrides: Partial<TextPart> = {}): TextPart => ({
  id: "prt_mail_1",
  sessionID: "ses_recipient",
  messageID: "msg_user_1",
  type: "text",
  text: "[from /root/explorers/worker_1]: hello there",
  synthetic: true,
  metadata: {
    from: "/root/explorers/worker_1",
    sent_at: 1,
    trigger_turn: false,
  },
  ...overrides,
})

describe("isMailboxPart", () => {
  test("recognizes a synthetic text part with metadata.from set", () => {
    expect(isMailboxPart(mailboxPart())).toBe(true)
  })

  test("rejects a non-text part", () => {
    expect(isMailboxPart({ ...mailboxPart(), type: "file" } as unknown as TextPart)).toBe(false)
  })

  test("rejects a non-synthetic text part (real user input)", () => {
    expect(isMailboxPart(mailboxPart({ synthetic: false }))).toBe(false)
    expect(isMailboxPart(mailboxPart({ synthetic: undefined }))).toBe(false)
  })

  test("rejects a synthetic text part missing metadata.from", () => {
    expect(isMailboxPart(mailboxPart({ metadata: {} }))).toBe(false)
    expect(isMailboxPart(mailboxPart({ metadata: undefined }))).toBe(false)
  })

  test("rejects a synthetic text part where metadata.from is not a string", () => {
    expect(isMailboxPart(mailboxPart({ metadata: { from: 42 as unknown as string } }))).toBe(false)
  })
})

describe("stripMailboxPrefix", () => {
  test("strips the [from <author>]: prefix", () => {
    expect(stripMailboxPrefix("[from /root/explorers/worker_1]: hello there", "/root/explorers/worker_1")).toBe(
      "hello there",
    )
  })

  test("returns the body untouched when the prefix is absent", () => {
    expect(stripMailboxPrefix("hello there", "/root/explorers/worker_1")).toBe("hello there")
  })

  test("strips a generic [from <anything>]: prefix even when author doesn't match", () => {
    // Defensive: if the prefix author and metadata.from drift (shouldn't,
    // but tools could change), still strip the boilerplate so the user
    // doesn't see "[from X]: [from X]: ..." double-prefixed.
    expect(stripMailboxPrefix("[from someone_else]: body", "/root/me")).toBe("body")
  })

  test("preserves leading whitespace in the body after stripping", () => {
    expect(stripMailboxPrefix("[from a]:    indented body", "a")).toBe("   indented body")
  })

  test("returns empty string when input is empty or only the prefix", () => {
    expect(stripMailboxPrefix("", "a")).toBe("")
    expect(stripMailboxPrefix("[from a]: ", "a")).toBe("")
  })
})

describe("formatMailboxAuthor", () => {
  test("strips the leading slash and produces a display-safe label", () => {
    expect(formatMailboxAuthor("/root/explorers/worker_1")).toBe("root/explorers/worker_1")
  })

  test("returns a fallback when author is empty or undefined", () => {
    expect(formatMailboxAuthor("")).toBe("sibling")
    expect(formatMailboxAuthor(undefined)).toBe("sibling")
  })

  test("collapses runaway whitespace and caps length via inlineSafe", () => {
    const long = "/root/" + "a".repeat(500)
    const out = formatMailboxAuthor(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("MailboxMessage view", () => {
  async function renderFrame(part: TextPart, opts: { triggerTurn?: boolean } = {}) {
    const handle = await testRender(
      () => (
        <MailboxMessage
          part={part}
          theme={FAKE_THEME}
          agentColor={AGENT_COLOR}
          triggerTurn={opts.triggerTurn ?? false}
        />
      ),
      { width: 100, height: 20 },
    )
    await handle.renderOnce()
    const frame = handle.captureCharFrame()
    return { frame, destroy: () => handle.renderer.destroy() }
  }

  test("renders the from-author chrome line and the body without the prefix", async () => {
    const { frame, destroy } = await renderFrame(mailboxPart())
    try {
      expect(frame).toContain("from")
      expect(frame).toContain("root/explorers/worker_1")
      expect(frame).toContain("hello there")
      // The "[from ...]: " prefix should not appear in the rendered body.
      expect(frame).not.toContain("[from /root/explorers/worker_1]:")
    } finally {
      destroy()
    }
  })

  test("renders multi-line body bodies (defaults to character wrap, no flex-row)", async () => {
    const part = mailboxPart({
      text: "[from /root/worker]: line one\nline two\nline three",
      metadata: { from: "/root/worker", sent_at: 1, trigger_turn: false },
    })
    const { frame, destroy } = await renderFrame(part)
    try {
      expect(frame).toContain("line one")
      expect(frame).toContain("line two")
      expect(frame).toContain("line three")
    } finally {
      destroy()
    }
  })

  test("renders very long single-line content without truncating the body", async () => {
    // Mailbox messages can carry tool output one sibling forwards to
    // another (multi-KB realistic). The body must wrap naturally — and
    // not be inlineSafe-capped, because the user wants to read the full
    // forwarded payload.
    const long = "x".repeat(2000)
    const part = mailboxPart({
      text: `[from /root/worker]: ${long}`,
      metadata: { from: "/root/worker", sent_at: 1, trigger_turn: false },
    })
    const { frame, destroy } = await renderFrame(part)
    try {
      // Some prefix of the long body should be visible in the frame.
      expect(frame).toContain("xxxxxxxxxx")
    } finally {
      destroy()
    }
  })

  test("strips ANSI escapes from the rendered body", async () => {
    const ansi = "\u001b[31mred\u001b[0m text"
    const part = mailboxPart({
      text: `[from /root/worker]: ${ansi}`,
      metadata: { from: "/root/worker", sent_at: 1, trigger_turn: false },
    })
    const { frame, destroy } = await renderFrame(part)
    try {
      expect(frame).toContain("red text")
      expect(frame).not.toContain("\u001b[31m")
    } finally {
      destroy()
    }
  })

  test("falls back to the sibling label when metadata.from is missing", async () => {
    // Defensive: should never happen in production (the dispatch path
    // always sets metadata.from), but we don't want to crash on a
    // malformed part.
    const part = mailboxPart({ metadata: { sent_at: 1, trigger_turn: false } })
    const { frame, destroy } = await renderFrame(part)
    try {
      expect(frame).toContain("sibling")
      expect(frame).toContain("hello there")
    } finally {
      destroy()
    }
  })

  test("marks trigger_turn messages distinctly so the user can spot wakeups", async () => {
    const triggering = mailboxPart({
      metadata: { from: "/root/worker", sent_at: 1, trigger_turn: true },
    })
    const { frame, destroy } = await renderFrame(triggering, { triggerTurn: true })
    try {
      // The exact mark is implementation detail — just assert SOMETHING
      // in the chrome distinguishes a trigger from a queue.
      expect(frame).toContain("from")
      expect(frame).toMatch(/wake|notify|trigger|↯|⚡|→/i)
    } finally {
      destroy()
    }
  })
})

describe("Production wiring in routes/session/index.tsx", () => {
  // Belt-and-suspenders against a refactor that drops the MailboxMessage
  // import or stops routing mailbox parts to it. Reads the real session
  // route source and asserts the UserMessage component imports +
  // dispatches mailbox parts via MailboxMessage. Same pattern as
  // process-tool.test.tsx's "Production wiring" test — verifies the
  // contract that we can't easily mount in isolation.
  test("UserMessage imports MailboxMessage and isMailboxPart and renders mailbox parts", async () => {
    const file = path.resolve(import.meta.dir, "index.tsx")
    const source = await fs.readFile(file, "utf8")
    expect(source).toContain('from "./mailbox-message"')
    expect(source).toContain("isMailboxPart")
    expect(source).toContain("<MailboxMessage")
    expect(source).toContain("trigger_turn")
  })
})
