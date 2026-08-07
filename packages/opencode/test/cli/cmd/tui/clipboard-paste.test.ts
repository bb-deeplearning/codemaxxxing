import { describe, expect, test } from "bun:test"
import * as Clipboard from "../../../../src/cli/cmd/tui/util/clipboard"

describe("clipboard text insertion", () => {
  test("normalizes and inserts clipboard text", async () => {
    const inserted: string[] = []
    const result = await Clipboard.pasteText(
      { insertText: (text) => inserted.push(text) },
      async () => ({ data: "first\r\nsecond\rthird", mime: "text/plain" }),
    )

    expect(result).toBe(true)
    expect(inserted).toEqual(["first\nsecond\nthird"])
  })

  test("ignores non-text and empty clipboards", async () => {
    const inserted: string[] = []
    const input = { insertText: (text: string) => inserted.push(text) }

    expect(await Clipboard.pasteText(input, async () => ({ data: "image", mime: "image/png" }))).toBe(false)
    expect(await Clipboard.pasteText(input, async () => ({ data: "", mime: "text/plain" }))).toBe(false)
    expect(await Clipboard.pasteText(input, async () => undefined)).toBe(false)
    expect(inserted).toEqual([])
  })
})
