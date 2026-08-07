/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender, useKeyboard } from "@opentui/solid"
import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { Keybind } from "../../../../src/util/keybind"

// Replicates the Ctrl+V keydown paste branch of the prompt component
// (src/cli/cmd/tui/component/prompt/index.tsx) with Clipboard.read stubbed.
// Terminals that forward Ctrl+V to the app (Windows Terminal 1.25+ with the
// kitty keyboard protocol active) never emit a bracketed paste, so the text
// must be inserted from the keydown handler directly.
//
// `commands` feeds a global keypress listener that mirrors the CommandProvider
// loop in dialog-command.tsx: a registered command whose keybind matches the
// keypress calls evt.preventDefault(), which makes opentui's emitWithPriority
// skip the focused renderable's onKeyDown. The prompt.paste command used to
// register `keybind: "input_paste"` (→ ctrl+v), which is exactly how a
// forwarded Ctrl+V got swallowed before the textarea branch could run.
async function mount(clipboardText: string | undefined, commands: { keybind?: string }[] = []) {
  let input: TextareaRenderable | undefined
  let pasteCount = 0
  let listenerMatched = 0

  const handle = await testRender(
    () => {
      useKeyboard((evt: KeyEvent) => {
        if (evt.defaultPrevented) return
        for (const option of commands) {
          if (
            option.keybind &&
            Keybind.parse(option.keybind).some((b) => Keybind.match(b, Keybind.fromParsedKey(evt)))
          ) {
            listenerMatched++
            evt.preventDefault()
            return
          }
        }
      })
      return (
        <textarea
          ref={(r: TextareaRenderable) => {
            input = r
          }}
          onKeyDown={async (e: KeyEvent) => {
            const binds = Keybind.parse("ctrl+v")
            const info = Keybind.fromParsedKey(e)
            if (binds.some((b) => Keybind.match(b, info))) {
              const content = clipboardText === undefined ? undefined : { data: clipboardText, mime: "text/plain" }
              if (content?.mime.startsWith("text/") && content.data.length > 0) {
                e.preventDefault()
                const normalizedText = content.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                input?.insertText(normalizedText)
                pasteCount++
                return
              }
            }
          }}
        />
      )
    },
    { kittyKeyboard: true, width: 60, height: 10 },
  )

  input?.focus()
  return {
    handle,
    get textarea() {
      return input
    },
    get pasteCount() {
      return pasteCount
    },
    get listenerMatched() {
      return listenerMatched
    },
  }
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

describe("prompt Ctrl+V keydown paste", () => {
  test("inserts clipboard text from a forwarded Ctrl+V without double-insert", async () => {
    const ctx = await mount("line1\nline2\nline3")

    try {
      ctx.handle.mockInput.pressKey("v", { ctrl: true })
      await ctx.handle.renderOnce()
      await wait(() => ctx.textarea!.plainText === "line1\nline2\nline3")

      expect(ctx.pasteCount).toBe(1)
      expect(ctx.textarea!.plainText).toBe("line1\nline2\nline3")

      // A following plain keypress must insert a single character, proving the
      // pasted text was not echoed twice by the textarea's default handling.
      ctx.handle.mockInput.pressKey("x")
      await ctx.handle.renderOnce()
      await wait(() => ctx.textarea!.plainText === "line1\nline2\nline3x")
      expect(ctx.textarea!.plainText).toBe("line1\nline2\nline3x")
    } finally {
      ctx.handle.renderer.destroy()
    }
  })

  test("renders the pasted text without an extra layout flush", async () => {
    const { handle, textarea } = await mount("alpha\nbeta\ngamma")

    try {
      handle.mockInput.pressKey("v", { ctrl: true })
      await handle.renderOnce()
      await wait(() => textarea!.plainText === "alpha\nbeta\ngamma")

      await handle.renderOnce()
      const frame = handle.captureCharFrame()
      expect(frame).toContain("alpha")
      expect(frame).toContain("beta")
      expect(frame).toContain("gamma")
    } finally {
      handle.renderer.destroy()
    }
  })

  test("does nothing for an empty clipboard", async () => {
    const ctx = await mount(undefined)

    try {
      ctx.handle.mockInput.pressKey("v", { ctrl: true })
      await ctx.handle.renderOnce()
      await Bun.sleep(30)

      expect(ctx.pasteCount).toBe(0)
      expect(ctx.textarea!.plainText).toBe("")
    } finally {
      ctx.handle.renderer.destroy()
    }
  })

  test("does not treat a plain keypress as a paste", async () => {
    const ctx = await mount("text")

    try {
      ctx.handle.mockInput.pressKey("v")
      await ctx.handle.renderOnce()
      await Bun.sleep(30)

      expect(ctx.pasteCount).toBe(0)
      expect(ctx.textarea!.plainText).toBe("v")
    } finally {
      ctx.handle.renderer.destroy()
    }
  })

  test("a command that claims Ctrl+V shadows the textarea paste", async () => {
    // Pre-fix production state: prompt.paste registered `keybind: "input_paste"`
    // (→ ctrl+v), so the CommandProvider listener matched a forwarded Ctrl+V,
    // called preventDefault(), and opentui skipped the focused textarea's
    // onKeyDown — the paste branch never ran.
    const ctx = await mount("shadowed", [{ keybind: "ctrl+v" }])

    try {
      ctx.handle.mockInput.pressKey("v", { ctrl: true })
      await ctx.handle.renderOnce()
      await Bun.sleep(30)

      expect(ctx.listenerMatched).toBe(1)
      expect(ctx.pasteCount).toBe(0)
      expect(ctx.textarea!.plainText).toBe("")
    } finally {
      ctx.handle.renderer.destroy()
    }
  })

  test("forwarded Ctrl+V reaches the textarea when no command claims the paste keybind", async () => {
    // Fixed state: prompt.paste stays triggerable via command.trigger() but
    // registers no keybind, so the (still-armed) CommandProvider listener never
    // matches Ctrl+V and the keydown paste branch runs.
    const ctx = await mount("pasted-text", [])

    try {
      ctx.handle.mockInput.pressKey("v", { ctrl: true })
      await ctx.handle.renderOnce()
      await wait(() => ctx.textarea!.plainText === "pasted-text")

      expect(ctx.listenerMatched).toBe(0)
      expect(ctx.pasteCount).toBe(1)
      expect(ctx.textarea!.plainText).toBe("pasted-text")
    } finally {
      ctx.handle.renderer.destroy()
    }
  })
})
