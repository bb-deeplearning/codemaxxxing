/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import {
  AgentTool as AgentToolNS,
  buildListBody,
  CloseView,
  formatBackLink,
  formatDuration,
  formatTimeout,
  FollowupView,
  isErrorMetadata,
  ListView,
  parseListAgentsOutput,
  previewMessage,
  SendView,
  SpawnView,
  statusColor,
  WaitView,
  type AgentToolTheme,
  type SpawnBackLink,
} from "./agent-tool"

// Pure-view tests for the wave-8 multi-agent v2 tool renderers. Mirrors
// the testing pattern in subagent-footer.test.tsx + mailbox-message.test.tsx
// — pure helpers verified directly, view components mounted via testRender
// against a fake theme.

const FAKE_THEME: AgentToolTheme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  accent: RGBA.fromHex("#00aaff"),
  success: RGBA.fromHex("#00ff00"),
  warning: RGBA.fromHex("#ffaa00"),
  error: RGBA.fromHex("#ff0000"),
}

const ACCENT = RGBA.fromHex("#00ffff")

const completedPart = (overrides: Partial<ToolPart> = {}): ToolPart =>
  ({
    id: "prt_tool_1",
    sessionID: "ses_root",
    messageID: "msg_assistant_1",
    type: "tool",
    callID: "call_1",
    tool: "spawn_agent",
    state: { status: "completed", title: "spawn_agent" },
    ...overrides,
  } as unknown as ToolPart)

const pendingPart = (overrides: Partial<ToolPart> = {}): ToolPart =>
  ({
    id: "prt_tool_p",
    sessionID: "ses_root",
    messageID: "msg_assistant_1",
    type: "tool",
    callID: "call_p",
    tool: "spawn_agent",
    state: { status: "pending" },
    ...overrides,
  } as unknown as ToolPart)

const erroredPart = (overrides: Partial<ToolPart> = {}): ToolPart =>
  ({
    id: "prt_tool_e",
    sessionID: "ses_root",
    messageID: "msg_assistant_1",
    type: "tool",
    callID: "call_e",
    tool: "spawn_agent",
    state: { status: "error", error: "Permission denied" },
    ...overrides,
  } as unknown as ToolPart)

async function captureFrame(node: () => any) {
  const handle = await testRender(node, { width: 120, height: 24 })
  await handle.renderOnce()
  const frame = handle.captureCharFrame()
  return { frame, destroy: () => handle.renderer.destroy() }
}

// ─── pure helpers ──────────────────────────────────────────────────────

describe("isErrorMetadata", () => {
  test("true when metadata.error is a string", () => {
    expect(isErrorMetadata({ error: "path_invalid" })).toBe(true)
  })

  test("false when metadata.error is missing", () => {
    expect(isErrorMetadata({})).toBe(false)
  })

  test("false when metadata.error is non-string (number, null, etc)", () => {
    expect(isErrorMetadata({ error: 42 as unknown })).toBe(false)
    expect(isErrorMetadata({ error: null as unknown })).toBe(false)
  })
})

describe("formatDuration", () => {
  test("ms format under 1 second", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(350)).toBe("350ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("delegates to Locale.duration for >= 1 second", () => {
    // The exact formatting is Locale's responsibility; just assert the
    // boundary is right and the result isn't "0s" (which would indicate
    // a routing bug).
    const result = formatDuration(8000)
    expect(result).not.toBe("0s")
    expect(result).not.toMatch(/ms/)
  })

  test("clamps negative durations to 0s", () => {
    expect(formatDuration(-100)).toBe("0s")
  })
})

describe("formatTimeout", () => {
  test("integer seconds drop the trailing .0", () => {
    expect(formatTimeout(1000)).toBe("1s")
    expect(formatTimeout(30000)).toBe("30s")
    expect(formatTimeout(600000)).toBe("600s")
  })

  test("non-integer seconds keep one decimal", () => {
    expect(formatTimeout(1500)).toBe("1.5s")
    expect(formatTimeout(2500)).toBe("2.5s")
  })

  test("sub-second timeouts render as ms", () => {
    expect(formatTimeout(0)).toBe("0ms")
    expect(formatTimeout(500)).toBe("500ms")
    expect(formatTimeout(999)).toBe("999ms")
  })
})

describe("previewMessage", () => {
  test("returns empty string for missing input", () => {
    expect(previewMessage(undefined)).toBe("")
    expect(previewMessage("")).toBe("")
  })

  test("collapses newlines into a single space", () => {
    expect(previewMessage("line one\nline two\n\nline three")).toBe("line one line two line three")
  })

  test("trims surrounding whitespace", () => {
    expect(previewMessage("   hello   ")).toBe("hello")
  })

  test("respects the cap argument", () => {
    const long = "x".repeat(1000)
    const out = previewMessage(long, 50)
    expect(out.length).toBeLessThanOrEqual(50)
  })

  // Streaming-perf regression guard. The implementation pre-truncates
  // the input to max*2 BEFORE running the newline regex so per-delta
  // work stays O(max) rather than O(body length). If a future refactor
  // removes the pre-truncate, this test still passes (output is right)
  // but the implementation's per-delta cost regresses to O(N²) over a
  // streaming session. This test is the bounded-output invariant; the
  // perf invariant is documented in the previewMessage comment block.
  test("very large inputs are bounded by max (no unbounded regex scan)", () => {
    const huge = "x".repeat(100_000)
    expect(previewMessage(huge, 200).length).toBeLessThanOrEqual(200)
    expect(previewMessage(huge, 50).length).toBeLessThanOrEqual(50)
  })

  test("pre-truncate doesn't change the output for inputs that already fit", () => {
    // The optimization must be invisible to callers passing normal-sized
    // bodies. If the slice point falls inside content that fits within
    // max*2, the result must equal what we'd get without the slice.
    const body = "hello world " + "x".repeat(50)
    expect(previewMessage(body, 200)).toBe("hello world " + "x".repeat(50))
  })
})

describe("statusColor", () => {
  test("running maps to accent", () => {
    expect(statusColor(FAKE_THEME, "running")).toBe(FAKE_THEME.accent)
  })

  test("completed and 'done' map to success", () => {
    expect(statusColor(FAKE_THEME, "completed")).toBe(FAKE_THEME.success)
    expect(statusColor(FAKE_THEME, "done")).toBe(FAKE_THEME.success)
  })

  test("errored / failed / interrupted map to error", () => {
    expect(statusColor(FAKE_THEME, "errored")).toBe(FAKE_THEME.error)
    expect(statusColor(FAKE_THEME, "failed")).toBe(FAKE_THEME.error)
    expect(statusColor(FAKE_THEME, "interrupted")).toBe(FAKE_THEME.error)
  })

  test("waiting / pending_init / shutdown / unknown map to muted", () => {
    expect(statusColor(FAKE_THEME, "waiting")).toBe(FAKE_THEME.textMuted)
    expect(statusColor(FAKE_THEME, "pending_init")).toBe(FAKE_THEME.textMuted)
    expect(statusColor(FAKE_THEME, "shutdown")).toBe(FAKE_THEME.textMuted)
    expect(statusColor(FAKE_THEME, "anything_else_unrecognized")).toBe(FAKE_THEME.textMuted)
  })
})

describe("formatBackLink", () => {
  const baseDone: SpawnBackLink = { status: "completed", toolCount: 1, durationMs: 4000 }

  test("completed → 'done' verb with tool count + duration", () => {
    const out = formatBackLink(baseDone)
    expect(out).toMatch(/^└ done · 1 tool/)
  })

  test("plural 'tools' for >1 tool count", () => {
    expect(formatBackLink({ ...baseDone, toolCount: 4 })).toMatch(/4 tools/)
  })

  test("errored → 'failed' verb", () => {
    expect(formatBackLink({ ...baseDone, status: "errored" })).toMatch(/^└ failed/)
  })

  test("running → keeps the verb literal", () => {
    expect(formatBackLink({ ...baseDone, status: "running" })).toMatch(/^└ running/)
  })

  test("waiting with no tools and no duration is just the verb", () => {
    expect(formatBackLink({ status: "waiting", toolCount: 0, durationMs: 0 })).toBe("└ waiting")
  })

  test("zero tool count and zero duration omit those segments", () => {
    expect(formatBackLink({ status: "completed", toolCount: 0, durationMs: 0 })).toBe("└ done")
  })
})

describe("parseListAgentsOutput", () => {
  test("returns [] for missing or unparseable output", () => {
    expect(parseListAgentsOutput(undefined)).toEqual([])
    expect(parseListAgentsOutput("")).toEqual([])
    expect(parseListAgentsOutput("not json at all")).toEqual([])
  })

  test("returns [] when the JSON shape is wrong", () => {
    expect(parseListAgentsOutput('{"not_agents": []}')).toEqual([])
    expect(parseListAgentsOutput('{"agents": "not an array"}')).toEqual([])
  })

  test("parses the wave-8 list_agents output shape", () => {
    const out = JSON.stringify({
      agents: [
        { agent_name: "/root/worker_a", agent_status: "running", last_task_message: "compute X" },
        { agent_name: "/root/worker_b", agent_status: { completed: "ok" }, last_task_message: null },
      ],
    })
    const parsed = parseListAgentsOutput(out)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({
      agent_name: "/root/worker_a",
      agent_status: "running",
      last_task_message: "compute X",
    })
    expect(parsed[1]).toEqual({
      agent_name: "/root/worker_b",
      agent_status: "completed",
      last_task_message: null,
    })
  })

  test("collapses { errored: ... } status to 'errored'", () => {
    const out = JSON.stringify({
      agents: [{ agent_name: "/root/x", agent_status: { errored: "boom" }, last_task_message: null }],
    })
    expect(parseListAgentsOutput(out)[0]?.agent_status).toBe("errored")
  })

  test("filters non-object entries silently", () => {
    const out = JSON.stringify({
      agents: [null, "string entry", 42, { agent_name: "/root/x", agent_status: "running" }],
    })
    const parsed = parseListAgentsOutput(out)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.agent_name).toBe("/root/x")
  })

  test("normalizes missing fields to empty string / null", () => {
    const out = JSON.stringify({ agents: [{}] })
    expect(parseListAgentsOutput(out)[0]).toEqual({
      agent_name: "",
      agent_status: "unknown",
      last_task_message: null,
    })
  })
})

describe("buildListBody", () => {
  test("returns empty string for no agents", () => {
    expect(buildListBody([])).toBe("")
  })

  test("renders each agent as a single padded line", () => {
    const out = buildListBody([
      { agent_name: "/root/git_historian", agent_status: "running", last_task_message: "scanning" },
      { agent_name: "/root/wave_review", agent_status: "completed", last_task_message: null },
    ])
    expect(out).toContain("↳ root/git_historian")
    expect(out).toContain("running")
    expect(out).toContain("scanning")
    expect(out).toContain("root/wave_review")
    expect(out).toContain("completed")
    // Two rows = exactly one newline.
    expect(out.split("\n")).toHaveLength(2)
  })

  test("inlineSafe-caps overlong last_task_message strings", () => {
    const long = "x".repeat(500)
    const out = buildListBody([{ agent_name: "/root/x", agent_status: "running", last_task_message: long }])
    // The body line should be way shorter than the input × 5.
    expect(out.length).toBeLessThan(long.length)
  })
})

// ─── view components ──────────────────────────────────────────────────

describe("SpawnView", () => {
  test("success: renders nickname + agent_type chrome and the message preview", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <SpawnView
        theme={FAKE_THEME}
        part={completedPart()}
        input={{
          task_name: "git_historian",
          agent_type: "explore",
          message: "Use the shell tool to run `git log --oneline -5` from the workspace root",
        }}
        metadata={{
          task_name: "/root/git_historian",
          nickname: "lovelace",
          child_session_id: "ses_child_1",
        }}
        nicknameColor={ACCENT}
      />
    ))
    try {
      expect(frame).toContain("spawn")
      expect(frame).toContain("Lovelace")
      expect(frame).toContain("explore")
      expect(frame).toContain("/root/git_historian")
      // Message preview line under the chrome.
      expect(frame).toMatch(/↳/)
      expect(frame).toContain("Use the shell tool")
      // No raw JSON payload visible — the model-facing JSON should not leak.
      expect(frame).not.toContain('{"task_name"')
    } finally {
      destroy()
    }
  })

  test("failure: renders the requested name + error tag + reason footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <SpawnView
        theme={FAKE_THEME}
        part={completedPart()}
        input={{
          task_name: "git-historian",
          agent_type: "explore",
          message: "anything",
        }}
        metadata={{
          error: "path_invalid",
          reason: "segment must use only lowercase letters, digits, and underscores",
          task_name: "git-historian",
        }}
      />
    ))
    try {
      expect(frame).toContain("spawn")
      expect(frame).toContain("git-historian")
      expect(frame).toContain("explore")
      expect(frame).toContain("path_invalid")
      expect(frame).toMatch(/└ failed/)
      expect(frame).toContain("lowercase letters")
      // Failed spawns must NOT show the message preview line — failure
      // info dominates.
      expect(frame).not.toMatch(/↳ "anything"/)
    } finally {
      destroy()
    }
  })

  test("success + back-link: appends 'done' footer with tool count + duration", async () => {
    const backlink: SpawnBackLink = { status: "completed", toolCount: 1, durationMs: 4000 }
    const { frame, destroy } = await captureFrame(() => (
      <SpawnView
        theme={FAKE_THEME}
        part={completedPart()}
        input={{ task_name: "git_historian", agent_type: "explore", message: "scan" }}
        metadata={{
          task_name: "/root/git_historian",
          nickname: "lovelace",
          child_session_id: "ses_child_1",
        }}
        nicknameColor={ACCENT}
        backlink={backlink}
      />
    ))
    try {
      expect(frame).toMatch(/└ done/)
      expect(frame).toMatch(/1 tool\b/)
    } finally {
      destroy()
    }
  })

  test("pending: still renders without crashing on missing metadata", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <SpawnView
        theme={FAKE_THEME}
        part={pendingPart()}
        input={{ task_name: "x", agent_type: "explore", message: "do thing" }}
        metadata={{}}
      />
    ))
    try {
      expect(frame).toContain("spawn")
      expect(frame).toContain("explore")
    } finally {
      destroy()
    }
  })
})

describe("WaitView", () => {
  test("completed: shows timeout suffix and 'completed' footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <WaitView
        theme={FAKE_THEME}
        part={completedPart({ tool: "wait_agent" })}
        input={{ timeout_ms: 30000 }}
        metadata={{ timeout_ms: 30000, timed_out: false, message: "Wait completed." }}
      />
    ))
    try {
      expect(frame).toContain("wait")
      expect(frame).toContain("30s")
      expect(frame).toMatch(/└ completed/)
      // No raw JSON.
      expect(frame).not.toContain('"timed_out"')
    } finally {
      destroy()
    }
  })

  test("timed out: shows 'timed out' footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <WaitView
        theme={FAKE_THEME}
        part={completedPart({ tool: "wait_agent" })}
        input={{ timeout_ms: 30000 }}
        metadata={{ timeout_ms: 30000, timed_out: true, message: "Wait timed out." }}
      />
    ))
    try {
      expect(frame).toMatch(/└ timed out/)
    } finally {
      destroy()
    }
  })

  test("invalid timeout: shows failed footer with reason", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <WaitView
        theme={FAKE_THEME}
        part={completedPart({ tool: "wait_agent" })}
        input={{ timeout_ms: 0 }}
        metadata={{ error: "invalid_timeout", reason: "timeout_ms must be greater than zero" }}
      />
    ))
    try {
      expect(frame).toMatch(/└ failed/)
      expect(frame).toContain("greater than zero")
    } finally {
      destroy()
    }
  })

  test("running: renders a spinner glyph before the label", async () => {
    const running = pendingPart({ tool: "wait_agent", state: { status: "running" } as any })
    const { frame, destroy } = await captureFrame(() => (
      <WaitView theme={FAKE_THEME} part={running} input={{ timeout_ms: 30000 }} metadata={{}} />
    ))
    try {
      expect(frame).toContain("wait")
      expect(frame).toContain("30s")
      // The spinner glyph (…) should be present before the label.
      expect(frame).toMatch(/…/)
    } finally {
      destroy()
    }
  })
})

describe("SendView", () => {
  test("queued: shows target + message preview", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <SendView
        theme={FAKE_THEME}
        part={completedPart({ tool: "send_message" })}
        input={{ target: "newton", message: "results look good, integrate them" }}
        metadata={{ target: "newton", target_session_id: "ses_x", queued: true }}
      />
    ))
    try {
      expect(frame).toContain("send")
      expect(frame).toContain("→")
      expect(frame).toContain("newton")
      expect(frame).toContain("results look good")
    } finally {
      destroy()
    }
  })

  test("error: shows failed footer with reason", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <SendView
        theme={FAKE_THEME}
        part={completedPart({ tool: "send_message" })}
        input={{ target: "ghost", message: "hi" }}
        metadata={{ error: "target_not_found", reason: "no agent at /root/ghost", target: "ghost" }}
      />
    ))
    try {
      expect(frame).toMatch(/└ failed/)
      expect(frame).toContain("no agent")
    } finally {
      destroy()
    }
  })
})

describe("FollowupView", () => {
  test("queued: shows target + message preview + 'will trigger' footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <FollowupView
        theme={FAKE_THEME}
        part={completedPart({ tool: "followup_task" })}
        input={{ target: "newton", message: "now review the wave 6 changes" }}
        metadata={{ target: "newton", target_session_id: "ses_y", trigger_turn: true, queued: true }}
      />
    ))
    try {
      expect(frame).toContain("followup")
      expect(frame).toContain("↯")
      expect(frame).toContain("newton")
      expect(frame).toContain("review the wave 6 changes")
      expect(frame).toMatch(/└ will trigger next turn/)
    } finally {
      destroy()
    }
  })

  test("error: shows failed footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <FollowupView
        theme={FAKE_THEME}
        part={completedPart({ tool: "followup_task" })}
        input={{ target: "/root", message: "hi" }}
        metadata={{ error: "root_target", target: "/root" }}
      />
    ))
    try {
      expect(frame).toMatch(/└ failed/)
      expect(frame).toContain("root_target")
    } finally {
      destroy()
    }
  })
})

describe("ListView", () => {
  test("renders agent count suffix and one row per child as a single text node", async () => {
    const output = JSON.stringify({
      agents: [
        { agent_name: "/root/worker_a", agent_status: "running", last_task_message: "scanning" },
        { agent_name: "/root/worker_b", agent_status: "completed", last_task_message: null },
        { agent_name: "/root/worker_c", agent_status: { errored: "boom" }, last_task_message: null },
      ],
    })
    const { frame, destroy } = await captureFrame(() => (
      <ListView
        theme={FAKE_THEME}
        part={completedPart({ tool: "list_agents" })}
        input={{}}
        metadata={{ agent_count: 3 }}
        output={output}
      />
    ))
    try {
      expect(frame).toContain("list")
      expect(frame).toContain("3 live")
      expect(frame).toContain("root/worker_a")
      expect(frame).toContain("running")
      expect(frame).toContain("scanning")
      expect(frame).toContain("root/worker_b")
      expect(frame).toContain("completed")
      expect(frame).toContain("root/worker_c")
      expect(frame).toContain("errored")
    } finally {
      destroy()
    }
  })

  test("error: shows failed footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <ListView
        theme={FAKE_THEME}
        part={completedPart({ tool: "list_agents" })}
        input={{ path_prefix: "bogus" }}
        metadata={{ error: "invalid_prefix", reason: "no such prefix" }}
        output={undefined}
      />
    ))
    try {
      expect(frame).toMatch(/└ failed/)
      expect(frame).toContain("no such prefix")
    } finally {
      destroy()
    }
  })

  test("empty live count: omits the suffix", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <ListView
        theme={FAKE_THEME}
        part={completedPart({ tool: "list_agents" })}
        input={{}}
        metadata={{ agent_count: 0 }}
        output={JSON.stringify({ agents: [] })}
      />
    ))
    try {
      expect(frame).toContain("list")
      expect(frame).not.toContain("0 live")
    } finally {
      destroy()
    }
  })
})

describe("CloseView", () => {
  test("success: shows target + 'was <prev_status>' suffix", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <CloseView
        theme={FAKE_THEME}
        part={completedPart({ tool: "close_agent" })}
        input={{ target: "newton" }}
        metadata={{ target: "newton", target_session_id: "ses_n", previous_status: "running" }}
      />
    ))
    try {
      expect(frame).toContain("close")
      expect(frame).toContain("newton")
      expect(frame).toContain("was running")
    } finally {
      destroy()
    }
  })

  test("rich previous_status: { completed } collapses to 'was completed'", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <CloseView
        theme={FAKE_THEME}
        part={completedPart({ tool: "close_agent" })}
        input={{ target: "newton" }}
        metadata={{ target: "newton", previous_status: { completed: "ok" } as unknown as string }}
      />
    ))
    try {
      expect(frame).toContain("was completed")
    } finally {
      destroy()
    }
  })

  test("error: root target shows failed footer", async () => {
    const { frame, destroy } = await captureFrame(() => (
      <CloseView
        theme={FAKE_THEME}
        part={completedPart({ tool: "close_agent" })}
        input={{ target: "/root" }}
        metadata={{ error: "root_target", target: "/root" }}
      />
    ))
    try {
      expect(frame).toMatch(/└ failed/)
      expect(frame).toContain("root_target")
    } finally {
      destroy()
    }
  })
})

// ─── runtime-error branch (state.status === "error") ──────────────────

describe("runtime-error rendering", () => {
  test("permission denial strikes through and suppresses the red error block", async () => {
    const denied = erroredPart({ state: { status: "error", error: "QuestionRejectedError: user dismissed" } as any })
    const { frame, destroy } = await captureFrame(() => (
      <SpawnView
        theme={FAKE_THEME}
        part={denied}
        input={{ task_name: "x", agent_type: "explore", message: "do" }}
        metadata={{}}
      />
    ))
    try {
      // Strike-through is an attribute, not a glyph — assert the error
      // string is NOT shown as red text below the row.
      expect(frame).not.toContain("QuestionRejectedError")
    } finally {
      destroy()
    }
  })

  test("non-denial runtime error renders below the row in error color", async () => {
    const failed = erroredPart({ state: { status: "error", error: "Network timeout" } as any })
    const { frame, destroy } = await captureFrame(() => (
      <SpawnView
        theme={FAKE_THEME}
        part={failed}
        input={{ task_name: "x", agent_type: "explore", message: "do" }}
        metadata={{}}
      />
    ))
    try {
      expect(frame).toContain("Network timeout")
    } finally {
      destroy()
    }
  })
})

// ─── namespace projection ──────────────────────────────────────────────

describe("namespace projection", () => {
  test("AgentTool namespace re-exports the public surface", () => {
    expect(AgentToolNS.SpawnView).toBe(SpawnView)
    expect(AgentToolNS.WaitView).toBe(WaitView)
    expect(AgentToolNS.SendView).toBe(SendView)
    expect(AgentToolNS.FollowupView).toBe(FollowupView)
    expect(AgentToolNS.ListView).toBe(ListView)
    expect(AgentToolNS.CloseView).toBe(CloseView)
  })
})
