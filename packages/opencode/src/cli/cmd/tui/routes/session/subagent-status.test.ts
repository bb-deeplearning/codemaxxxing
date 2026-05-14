import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { deriveSubagentStatus, formatSubagentStatus } from "./subagent-status"

// Wave 11: status derivation for the subagent footer + dialog.
//
// Per the wave brief: extend the existing session_status pipeline minimally
// rather than threading AgentControl's richer per-agent status through sync.
// The four user-facing labels (running / waiting / completed / errored) are
// derivable from session_status (busy/retry/idle) plus the latest assistant
// message's `finish` and `error` fields — no new event plumbing needed.

const user = (overrides: Partial<UserMessage> = {}): UserMessage => ({
  id: "msg_user_1",
  sessionID: "ses_test",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "anthropic", modelID: "x" },
  ...overrides,
})

const assistant = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "msg_asst_1",
  sessionID: "ses_test",
  role: "assistant",
  time: { created: 2 },
  parentID: "msg_user_1",
  modelID: "x",
  providerID: "anthropic",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...overrides,
})

describe("deriveSubagentStatus", () => {
  test("busy session_status maps to running regardless of message state", () => {
    const status: SessionStatus = { type: "busy" }
    expect(deriveSubagentStatus(status, [user(), assistant()])).toBe("running")
    expect(deriveSubagentStatus(status, [])).toBe("running")
  })

  test("retry session_status also maps to running", () => {
    const status: SessionStatus = { type: "retry", attempt: 1, message: "rate-limited", next: 1000 }
    expect(deriveSubagentStatus(status, [user()])).toBe("running")
  })

  test("idle with last assistant carrying finish reports completed", () => {
    const msgs: Message[] = [user(), assistant({ finish: "stop", time: { created: 2, completed: 3 } })]
    expect(deriveSubagentStatus({ type: "idle" }, msgs)).toBe("completed")
  })

  test("idle with last assistant carrying error reports errored", () => {
    const msgs: Message[] = [
      user(),
      assistant({ error: { name: "UnknownError", data: { message: "boom" } } as AssistantMessage["error"] }),
    ]
    expect(deriveSubagentStatus({ type: "idle" }, msgs)).toBe("errored")
  })

  test("idle with last assistant carrying MessageAbortedError still reports errored", () => {
    const msgs: Message[] = [
      user(),
      assistant({ error: { name: "MessageAbortedError", data: {} } as AssistantMessage["error"] }),
    ]
    expect(deriveSubagentStatus({ type: "idle" }, msgs)).toBe("errored")
  })

  test("idle with no assistant yet (fresh sibling) reports waiting", () => {
    expect(deriveSubagentStatus({ type: "idle" }, [user()])).toBe("waiting")
  })

  test("idle with no messages at all reports waiting", () => {
    expect(deriveSubagentStatus({ type: "idle" }, [])).toBe("waiting")
  })

  test("undefined session_status defaults to idle behavior (waiting)", () => {
    expect(deriveSubagentStatus(undefined, [])).toBe("waiting")
  })

  test("idle with the latest assistant unfinished (mid-stream pause) reports waiting", () => {
    // Streaming halted but no finish/error landed — covers the in-between
    // moment between `bus.publish(idle)` and the next message append.
    const msgs: Message[] = [user(), assistant()]
    expect(deriveSubagentStatus({ type: "idle" }, msgs)).toBe("waiting")
  })

  test("only the most recent assistant matters for completed/errored discrimination", () => {
    // A prior errored turn followed by a successful one reports completed.
    const msgs: Message[] = [
      user(),
      assistant({ id: "msg_asst_1", error: { name: "UnknownError", data: {} } as AssistantMessage["error"] }),
      user({ id: "msg_user_2", time: { created: 3 } }),
      assistant({ id: "msg_asst_2", parentID: "msg_user_2", finish: "stop", time: { created: 4, completed: 5 } }),
    ]
    expect(deriveSubagentStatus({ type: "idle" }, msgs)).toBe("completed")
  })

  test("assistant with finish AND error reports errored (error wins)", () => {
    const msgs: Message[] = [
      user(),
      assistant({
        finish: "error",
        error: { name: "UnknownError", data: {} } as AssistantMessage["error"],
      }),
    ]
    expect(deriveSubagentStatus({ type: "idle" }, msgs)).toBe("errored")
  })
})

describe("formatSubagentStatus", () => {
  test("renders human-readable labels for each variant", () => {
    expect(formatSubagentStatus("running")).toBe("running")
    expect(formatSubagentStatus("waiting")).toBe("waiting")
    expect(formatSubagentStatus("completed")).toBe("completed")
    expect(formatSubagentStatus("errored")).toBe("errored")
  })
})
