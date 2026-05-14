/** @jsxImportSource @opentui/solid */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import {
  buildDialogSubagentOptions,
  type DialogSubagentTheme,
  type DialogSubagentDeps,
} from "./dialog-subagent"
import type { DialogSelectOption } from "@tui/ui/dialog-select"
import type { AssistantMessage, Message, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"

// Wave 11: subagent action dialog gains:
//   1. Live status display (running / waiting / completed / errored).
//   2. A "close" action that calls SDK to abort the sibling session.
// Both are pure-data choices on top of the existing "open" action.

const FAKE_THEME: DialogSubagentTheme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
}

const user = (overrides: Partial<UserMessage> = {}): UserMessage => ({
  id: "msg_u",
  sessionID: "ses_target",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "anthropic", modelID: "x" },
  ...overrides,
})

const assistant = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "msg_a",
  sessionID: "ses_target",
  role: "assistant",
  time: { created: 2 },
  parentID: "msg_u",
  modelID: "x",
  providerID: "anthropic",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...overrides,
})

const baseDeps = (overrides: Partial<DialogSubagentDeps> = {}): DialogSubagentDeps => ({
  sessionID: "ses_target",
  status: { type: "idle" },
  messages: [],
  navigate: () => {},
  abort: async () => {},
  ...overrides,
})

// Stub DialogContext for tests — DialogContext's surface is wider than
// what the option onSelect handlers actually use (clear only), so we cast
// through unknown to bypass the structural check rather than synthesizing
// the unused `replace`, `stack`, `size`, and `setSize` members.
function stubDialog(clear: () => void) {
  return { clear } as unknown as Parameters<NonNullable<DialogSelectOption<string>["onSelect"]>>[0]
}

describe("buildDialogSubagentOptions", () => {
  test("always includes the open action", () => {
    const deps = baseDeps()
    const opts = buildDialogSubagentOptions(deps)
    expect(opts.find((o) => o.value === "subagent.view")).toBeDefined()
  })

  test("includes a close action with the running status reflected in description", () => {
    const opts = buildDialogSubagentOptions(baseDeps({ status: { type: "busy" } }))
    const close = opts.find((o) => o.value === "subagent.close")
    expect(close).toBeDefined()
    expect(close!.description).toContain("running")
  })

  test("close description reflects waiting status when idle and no completion", () => {
    const opts = buildDialogSubagentOptions(baseDeps({ status: { type: "idle" }, messages: [] }))
    const close = opts.find((o) => o.value === "subagent.close")
    expect(close!.description).toContain("waiting")
  })

  test("close description reflects completed when latest assistant has finish", () => {
    const msgs: Message[] = [user(), assistant({ finish: "stop", time: { created: 2, completed: 3 } })]
    const opts = buildDialogSubagentOptions(baseDeps({ status: { type: "idle" }, messages: msgs }))
    const close = opts.find((o) => o.value === "subagent.close")
    expect(close!.description).toContain("completed")
  })

  test("close description reflects errored when latest assistant has error", () => {
    const msgs: Message[] = [
      user(),
      assistant({ error: { name: "UnknownError", data: { message: "boom" } } as AssistantMessage["error"] }),
    ]
    const opts = buildDialogSubagentOptions(baseDeps({ status: { type: "idle" }, messages: msgs }))
    const close = opts.find((o) => o.value === "subagent.close")
    expect(close!.description).toContain("errored")
  })

  test("open onSelect navigates to the target session and clears the dialog", () => {
    let navigated: { type: string; sessionID: string } | undefined
    let cleared = 0
    const opts = buildDialogSubagentOptions(
      baseDeps({
        navigate: (route) => {
          if (route.type === "session") navigated = { type: route.type, sessionID: route.sessionID }
        },
      }),
    )
    const open = opts.find((o) => o.value === "subagent.view")!
    open.onSelect!(stubDialog(() => cleared++))
    expect(navigated).toEqual({ type: "session", sessionID: "ses_target" })
    expect(cleared).toBe(1)
  })

  test("close onSelect calls abort with the session id and clears the dialog", async () => {
    let abortedID: string | undefined
    let cleared = 0
    const opts = buildDialogSubagentOptions(
      baseDeps({
        abort: async (id) => {
          abortedID = id
        },
      }),
    )
    const close = opts.find((o) => o.value === "subagent.close")!
    await close.onSelect!(stubDialog(() => cleared++))
    expect(abortedID).toBe("ses_target")
    expect(cleared).toBe(1)
  })

  test("close onSelect swallows abort failures so the dialog still clears", async () => {
    let cleared = 0
    const opts = buildDialogSubagentOptions(
      baseDeps({
        abort: async () => {
          throw new Error("network down")
        },
      }),
    )
    const close = opts.find((o) => o.value === "subagent.close")!
    await close.onSelect!(stubDialog(() => cleared++))
    expect(cleared).toBe(1)
  })

  test("close action is disabled when the agent is already in a final state", () => {
    const completedMsgs: Message[] = [user(), assistant({ finish: "stop", time: { created: 2, completed: 3 } })]
    const erroredMsgs: Message[] = [
      user(),
      assistant({ error: { name: "UnknownError", data: {} } as AssistantMessage["error"] }),
    ]
    expect(
      buildDialogSubagentOptions(baseDeps({ status: { type: "idle" }, messages: completedMsgs })).find(
        (o) => o.value === "subagent.close",
      )?.disabled,
    ).toBe(true)
    expect(
      buildDialogSubagentOptions(baseDeps({ status: { type: "idle" }, messages: erroredMsgs })).find(
        (o) => o.value === "subagent.close",
      )?.disabled,
    ).toBe(true)
  })

  test("close action is enabled while the agent is running or waiting", () => {
    expect(
      buildDialogSubagentOptions(baseDeps({ status: { type: "busy" } })).find(
        (o) => o.value === "subagent.close",
      )?.disabled,
    ).toBeFalsy()
    expect(
      buildDialogSubagentOptions(baseDeps({ status: { type: "idle" }, messages: [user()] })).find(
        (o) => o.value === "subagent.close",
      )?.disabled,
    ).toBeFalsy()
  })

  test("retry session_status counts as running for close-enable purposes", () => {
    const status: SessionStatus = { type: "retry", attempt: 1, message: "rate-limited", next: 1000 }
    const opts = buildDialogSubagentOptions(baseDeps({ status }))
    const close = opts.find((o) => o.value === "subagent.close")
    expect(close?.disabled).toBeFalsy()
    expect(close!.description).toContain("running")
  })
})

describe("Production wiring in dialog-subagent-mount.tsx", () => {
  // Same pattern as process-tool.test.tsx: assert the wrapper file pulls
  // the helper + view together, since mounting under all the dialog
  // contexts in unit tests is heavyweight.
  test("DialogSubagent wrapper sources options via buildDialogSubagentOptions and uses DialogSelect", async () => {
    const file = path.resolve(import.meta.dir, "dialog-subagent-mount.tsx")
    const source = await fs.readFile(file, "utf8")
    expect(source).toContain("buildDialogSubagentOptions")
    expect(source).toContain("DialogSelect")
    expect(source).toContain("session.abort")
  })
})

describe("DialogSubagent rendering smoke", () => {
  // Render the helper-built options into a stub <DialogSelect>-style box
  // to verify the view shape is sane (titles + descriptions + values
  // present). Avoids mounting the real DialogSelect (which needs
  // dialog/keybind/theme/tui-config providers).
  test("each option carries a non-empty title and description", () => {
    const msgs: Message[] = [user(), assistant({ finish: "stop", time: { created: 2, completed: 3 } })]
    const opts = buildDialogSubagentOptions(baseDeps({ messages: msgs, status: { type: "idle" } }))
    expect(opts.length).toBe(2)
    for (const o of opts) {
      expect(typeof o.title).toBe("string")
      expect(o.title.length).toBeGreaterThan(0)
      expect(typeof o.description).toBe("string")
      expect((o.description ?? "").length).toBeGreaterThan(0)
    }
  })

  // Even though we don't mount DialogSelect, FAKE_THEME exists so the
  // production wiring keeps the same prop interface as the view it
  // delegates to. testRender below provides a smoke check that a
  // text-rendered approximation of the view doesn't throw.
  test("renders a smoke approximation of the option list with the theme", async () => {
    const opts = buildDialogSubagentOptions(baseDeps({ status: { type: "busy" } }))
    const handle = await testRender(
      () => (
        <box flexDirection="column">
          {opts.map((opt) => (
            <text fg={FAKE_THEME.text}>
              {opt.title} <span style={{ fg: FAKE_THEME.textMuted }}>{opt.description}</span>
            </text>
          ))}
        </box>
      ),
      { width: 80, height: 8 },
    )
    try {
      await handle.renderOnce()
      const frame = handle.captureCharFrame()
      expect(frame).toContain("open")
      expect(frame).toContain("close")
      expect(frame).toContain("running")
    } finally {
      handle.renderer.destroy()
    }
  })
})
