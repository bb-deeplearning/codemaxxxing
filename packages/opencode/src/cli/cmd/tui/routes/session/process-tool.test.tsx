/** @jsxImportSource @opentui/solid */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Match, Switch, createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import type { ToolPart, ToolStateCompleted, ToolStateError, ToolStatePending, ToolStateRunning } from "@opencode-ai/sdk/v2"
import { Process, ProcessWriteStdin, type ProcessTheme } from "./process-tool"

// Wave 4: TUI part renderers for the unified_exec tools (exec_command +
// write_stdin) shipped in wave 3. These tests exercise the renderers in
// isolation with a fixed RGBA theme — no Theme/Sync/Session context, no
// reactive store. Components take theme as a prop so production wiring is
// the only place that pulls it from useTheme(); tests stay deterministic.

const FAKE_THEME: ProcessTheme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  accent: RGBA.fromHex("#00ff00"),
  error: RGBA.fromHex("#ff0000"),
}

function makeToolPart(input: {
  tool: string
  state: ToolStateCompleted | ToolStateRunning | ToolStatePending | ToolStateError
  callID?: string
}): ToolPart {
  return {
    id: "prt_test",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: input.callID ?? "call_test",
    tool: input.tool,
    state: input.state,
  }
}

function execToolProps(input: {
  cmd: string
  output?: string
  metadata?: Record<string, unknown>
  status?: "pending" | "running" | "completed" | "error"
}) {
  const status = input.status ?? "completed"
  const inputs = { cmd: input.cmd }
  const metadata = input.metadata ?? {}
  let state: ToolStateCompleted | ToolStateRunning | ToolStatePending | ToolStateError
  if (status === "completed") {
    state = {
      status: "completed",
      input: inputs,
      output: input.output ?? "",
      title: `exec ${input.cmd.split(" ")[0]}`,
      metadata,
      time: { start: 1, end: 2 },
    }
  } else if (status === "running") {
    state = { status: "running", input: inputs, metadata, time: { start: 1 } }
  } else if (status === "error") {
    state = { status: "error", input: inputs, error: "boom", metadata, time: { start: 1, end: 2 } }
  } else {
    state = { status: "pending", input: inputs, raw: "" }
  }
  const part = makeToolPart({ tool: "exec_command", state })
  return {
    input: inputs,
    metadata,
    output: status === "completed" ? input.output : undefined,
    permission: {} as Record<string, unknown>,
    tool: "exec_command",
    part,
  }
}

function writeStdinProps(input: {
  session_id: number
  chars?: string
  output?: string
  metadata?: Record<string, unknown>
  status?: "pending" | "running" | "completed" | "error"
}) {
  const status = input.status ?? "completed"
  const inputs = { session_id: input.session_id, chars: input.chars }
  const metadata = input.metadata ?? {}
  let state: ToolStateCompleted | ToolStateRunning | ToolStatePending | ToolStateError
  if (status === "completed") {
    state = {
      status: "completed",
      input: inputs,
      output: input.output ?? "",
      title: `write_stdin ${input.session_id}`,
      metadata,
      time: { start: 1, end: 2 },
    }
  } else if (status === "running") {
    state = { status: "running", input: inputs, metadata, time: { start: 1 } }
  } else if (status === "error") {
    state = { status: "error", input: inputs, error: "boom", metadata, time: { start: 1, end: 2 } }
  } else {
    state = { status: "pending", input: inputs, raw: "" }
  }
  const part = makeToolPart({ tool: "write_stdin", state })
  return {
    input: inputs,
    metadata,
    output: status === "completed" ? input.output : undefined,
    permission: {} as Record<string, unknown>,
    tool: "write_stdin",
    part,
  }
}

async function renderFrame(view: () => any): Promise<{ frame: string; destroy: () => void }> {
  const handle = await testRender(view, { width: 100, height: 40 })
  await handle.renderOnce()
  const frame = handle.captureCharFrame()
  return { frame, destroy: () => handle.renderer.destroy() }
}

describe("Process (exec_command renderer)", () => {
  test("shows command, output, and wall_time when completed", async () => {
    const props = execToolProps({
      cmd: "echo hi",
      output: "hello\nworld",
      metadata: { wall_time_seconds: 1.5, cmd: "echo hi" },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("exec")
      expect(frame).toContain("echo hi")
      expect(frame).toContain("hello")
      expect(frame).toContain("world")
      expect(frame).toContain("1.5s")
    } finally {
      destroy()
    }
  })

  test("shows session_id pill when process is still running (alive after read)", async () => {
    const props = execToolProps({
      cmd: "node repl.js",
      output: "ready",
      metadata: { wall_time_seconds: 0.2, session_id: 7 },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("session #7")
      expect(frame).not.toContain("exit ")
    } finally {
      destroy()
    }
  })

  test("shows exit_code pill when process has exited", async () => {
    const props = execToolProps({
      cmd: "ls",
      output: "file.txt",
      metadata: { wall_time_seconds: 0.05, exit_code: 0 },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("exit 0")
      expect(frame).not.toContain("session #")
    } finally {
      destroy()
    }
  })

  test("truncates long output to 10 lines with expand affordance", async () => {
    const longOutput = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n")
    const props = execToolProps({
      cmd: "seq 25",
      output: longOutput,
      metadata: { wall_time_seconds: 0.1, exit_code: 0 },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("line-0")
      expect(frame).toContain("line-9")
      // line-10 onwards should NOT render in collapsed view
      expect(frame).not.toContain("line-15")
      expect(frame).toContain("Click to expand")
    } finally {
      destroy()
    }
  })

  test("expanding the output reveals all lines and shows collapse affordance", async () => {
    const longOutput = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n")
    const props = execToolProps({
      cmd: "seq 25",
      output: longOutput,
      metadata: { wall_time_seconds: 0.1, exit_code: 0 },
    })
    const [expanded, setExpanded] = createSignal(false)
    const handle = await testRender(
      () => <Process {...props} theme={FAKE_THEME} expanded={expanded()} onToggleExpand={() => setExpanded(true)} />,
      { width: 100, height: 60 },
    )
    try {
      await handle.renderOnce()
      setExpanded(true)
      await handle.renderOnce()
      const frame = handle.captureCharFrame()
      expect(frame).toContain("line-15")
      expect(frame).toContain("line-24")
      expect(frame).toContain("Click to collapse")
    } finally {
      handle.renderer.destroy()
    }
  })

  test("strips ANSI escape sequences from output before rendering", async () => {
    const ansi = "\u001b[31mred\u001b[0m text"
    const props = execToolProps({
      cmd: "color",
      output: ansi,
      metadata: { wall_time_seconds: 0.01, exit_code: 0 },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("red text")
      expect(frame).not.toContain("\u001b[31m")
    } finally {
      destroy()
    }
  })

  test("renders an error state from the tool part", async () => {
    const props = execToolProps({
      cmd: "false",
      status: "error",
      metadata: { wall_time_seconds: 0.01 },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("boom")
    } finally {
      destroy()
    }
  })

  test("renders a pending placeholder before the tool runs", async () => {
    const props = execToolProps({
      cmd: "echo hi",
      status: "pending",
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("exec")
    } finally {
      destroy()
    }
  })

  test("clamps overlong commands so the header stays single-line", async () => {
    const longCmd = "node " + "a".repeat(200)
    const props = execToolProps({
      cmd: longCmd,
      output: "ok",
      metadata: { wall_time_seconds: 0.1, exit_code: 0 },
    })
    const { frame, destroy } = await renderFrame(() => <Process {...props} theme={FAKE_THEME} />)
    try {
      // Truncated header marker (ellipsis) appears; full 200-char string does not.
      expect(frame).toContain("…")
      expect(frame).not.toContain("a".repeat(200))
    } finally {
      destroy()
    }
  })
})

describe("ProcessWriteStdin (write_stdin renderer)", () => {
  test("shows session_id, chars preview, and output when completed", async () => {
    const props = writeStdinProps({
      session_id: 12,
      chars: "hello\n",
      output: "got:hello",
      metadata: { wall_time_seconds: 0.2, session_id: 12 },
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("write_stdin")
      expect(frame).toContain("#12")
      expect(frame).toContain("hello")
      expect(frame).toContain("got:hello")
    } finally {
      destroy()
    }
  })

  test("renders empty chars as the (poll) sentinel", async () => {
    const props = writeStdinProps({
      session_id: 3,
      chars: "",
      output: "still running",
      metadata: { wall_time_seconds: 5.0, session_id: 3 },
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("(poll)")
    } finally {
      destroy()
    }
  })

  test("treats omitted chars as a poll", async () => {
    const props = writeStdinProps({
      session_id: 9,
      output: "tick",
      metadata: { wall_time_seconds: 5.0, session_id: 9 },
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("(poll)")
    } finally {
      destroy()
    }
  })

  test("truncates long chars to a short preview", async () => {
    const long = "x".repeat(200)
    const props = writeStdinProps({
      session_id: 1,
      chars: long,
      output: "ok",
      metadata: { wall_time_seconds: 0.1, session_id: 1 },
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("…")
      expect(frame).not.toContain("x".repeat(200))
    } finally {
      destroy()
    }
  })

  test("shows exit_code pill when the process has exited", async () => {
    const props = writeStdinProps({
      session_id: 4,
      chars: "q\n",
      output: "bye",
      metadata: { wall_time_seconds: 0.1, exit_code: 2 },
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("exit 2")
    } finally {
      destroy()
    }
  })

  test("renders a friendly message when the session is unknown", async () => {
    const props = writeStdinProps({
      session_id: 99,
      chars: "x",
      output: "Unknown process id 99",
      metadata: { session_id: 99, error: "unknown_session" },
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("Unknown process id 99")
    } finally {
      destroy()
    }
  })

  test("renders an error state from the tool part", async () => {
    const props = writeStdinProps({
      session_id: 1,
      chars: "x",
      status: "error",
      metadata: {},
    })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("boom")
    } finally {
      destroy()
    }
  })

  test("renders a pending placeholder before the tool runs", async () => {
    const props = writeStdinProps({ session_id: 1, chars: "x", status: "pending" })
    const { frame, destroy } = await renderFrame(() => <ProcessWriteStdin {...props} theme={FAKE_THEME} />)
    try {
      expect(frame).toContain("write_stdin")
    } finally {
      destroy()
    }
  })

  test("expanding long output reveals all lines and shows collapse affordance", async () => {
    const longOutput = Array.from({ length: 25 }, (_, i) => `out-${i}`).join("\n")
    const props = writeStdinProps({
      session_id: 1,
      chars: "ping",
      output: longOutput,
      metadata: { wall_time_seconds: 0.1, exit_code: 0 },
    })
    const [expanded, setExpanded] = createSignal(false)
    const handle = await testRender(
      () => (
        <ProcessWriteStdin
          {...props}
          theme={FAKE_THEME}
          expanded={expanded()}
          onToggleExpand={() => setExpanded(true)}
        />
      ),
      { width: 100, height: 60 },
    )
    try {
      await handle.renderOnce()
      setExpanded(true)
      await handle.renderOnce()
      const frame = handle.captureCharFrame()
      expect(frame).toContain("out-15")
      expect(frame).toContain("out-24")
      expect(frame).toContain("Click to collapse")
    } finally {
      handle.renderer.destroy()
    }
  })
})

describe("Switch routing", () => {
  // The production Switch in routes/session/index.tsx dispatches by tool
  // name to the per-tool renderer and falls through to GenericTool for
  // anything not matched. This in-test Switch mirrors the production
  // wiring (same predicates, same fallback shape) so we can verify the
  // routing contract end-to-end without booting the full session route.
  function TestSwitch(p: { tool: string; execProps: any; writeProps: any }) {
    return (
      <Switch>
        <Match when={p.tool === "exec_command"}>
          <Process {...p.execProps} theme={FAKE_THEME} />
        </Match>
        <Match when={p.tool === "write_stdin"}>
          <ProcessWriteStdin {...p.writeProps} theme={FAKE_THEME} />
        </Match>
        <Match when={true}>
          <text>GENERIC_FALLBACK_SENTINEL</text>
        </Match>
      </Switch>
    )
  }

  test("routes exec_command tool name to the Process renderer", async () => {
    const exec = execToolProps({ cmd: "ls", output: "file", metadata: { wall_time_seconds: 0.01, exit_code: 0 } })
    const writeStdin = writeStdinProps({ session_id: 1 })
    const { frame, destroy } = await renderFrame(() => (
      <TestSwitch tool="exec_command" execProps={exec} writeProps={writeStdin} />
    ))
    try {
      expect(frame).toContain("exec")
      expect(frame).not.toContain("GENERIC_FALLBACK_SENTINEL")
    } finally {
      destroy()
    }
  })

  test("routes write_stdin tool name to the ProcessWriteStdin renderer", async () => {
    const exec = execToolProps({ cmd: "ls", output: "file", metadata: { wall_time_seconds: 0.01, exit_code: 0 } })
    const writeStdin = writeStdinProps({
      session_id: 5,
      chars: "x",
      output: "ok",
      metadata: { wall_time_seconds: 0.01, session_id: 5 },
    })
    const { frame, destroy } = await renderFrame(() => (
      <TestSwitch tool="write_stdin" execProps={exec} writeProps={writeStdin} />
    ))
    try {
      expect(frame).toContain("write_stdin")
      expect(frame).not.toContain("GENERIC_FALLBACK_SENTINEL")
    } finally {
      destroy()
    }
  })

  test("falls through to the GenericTool fallback for unknown tool names", async () => {
    const exec = execToolProps({ cmd: "ls", output: "file", metadata: { wall_time_seconds: 0.01, exit_code: 0 } })
    const writeStdin = writeStdinProps({ session_id: 1 })
    const { frame, destroy } = await renderFrame(() => (
      <TestSwitch tool="foobar" execProps={exec} writeProps={writeStdin} />
    ))
    try {
      expect(frame).toContain("GENERIC_FALLBACK_SENTINEL")
    } finally {
      destroy()
    }
  })
})

describe("Production wiring in routes/session/index.tsx", () => {
  // Belt-and-suspenders against an accidental Switch reorder. Reads the
  // real session route source and asserts the new Match clauses sit
  // BEFORE the `Match when={true}` GenericTool fallback. Combined with
  // the routing tests above (which exercise the predicates), this
  // protects "unknown tool falls back to GenericTool" from regressing
  // even though we can't mount the production Switch directly without
  // the full session context tree.
  test("exec_command and write_stdin Match clauses are dispatched before the GenericTool fallback", async () => {
    const file = path.resolve(import.meta.dir, "index.tsx")
    const source = await fs.readFile(file, "utf8")
    const execIdx = source.indexOf('props.part.tool === "exec_command"')
    const writeIdx = source.indexOf('props.part.tool === "write_stdin"')
    const fallbackIdx = source.indexOf("<GenericTool {...toolprops} />")
    expect(execIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(-1)
    expect(fallbackIdx).toBeGreaterThan(-1)
    expect(execIdx).toBeLessThan(fallbackIdx)
    expect(writeIdx).toBeLessThan(fallbackIdx)
  })
})
