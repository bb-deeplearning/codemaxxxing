/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { testRender, useKeyboard } from "@opentui/solid"
import { Keybind } from "../../../../src/util/keybind"
import * as Clipboard from "../../../../src/cli/cmd/tui/util/clipboard"

test("a dialog keyboard listener pastes into its focused input", async () => {
  let input: TextareaRenderable | undefined
  const handle = await testRender(
    () => {
      useKeyboard(async (evt: KeyEvent) => {
        if (!Keybind.parse("ctrl+v").some((bind) => Keybind.match(bind, Keybind.fromParsedKey(evt)))) return
        evt.preventDefault()
        evt.stopPropagation()
        await Clipboard.pasteText(input!, async () => ({ data: "api-key-from-clipboard", mime: "text/plain" }))
      })
      return <textarea ref={(value: TextareaRenderable) => (input = value)} />
    },
    { kittyKeyboard: true, width: 60, height: 10 },
  )

  try {
    input?.focus()
    handle.mockInput.pressKey("v", { ctrl: true })
    await handle.renderOnce()

    const start = Date.now()
    while (input?.plainText !== "api-key-from-clipboard") {
      if (Date.now() - start > 2000) throw new Error("timed out waiting for paste")
      await Bun.sleep(10)
    }
    expect(input.plainText).toBe("api-key-from-clipboard")
  } finally {
    handle.renderer.destroy()
  }
})
