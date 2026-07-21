import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectImageAttachments } from "../../src/tool/attach-images"

// Minimal valid PNG: signature + IHDR carrying 1x1 dimensions. The sniffer
// checks magic bytes; the resize gate reads IHDR and passes small images
// through unchanged.
function makePng(): Uint8Array {
  const bytes = new Uint8Array(33)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < sig.length; i++) bytes[i] = sig[i]
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes[12] = 0x49
  bytes[13] = 0x48
  bytes[14] = 0x44
  bytes[15] = 0x52
  view.setUint32(16, 1)
  view.setUint32(20, 1)
  return bytes
}

const dir = mkdtempSync(path.join(tmpdir(), "attach-images-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (input: { text: string; sinceMs: number }) => Effect.runPromise(collectImageAttachments(input))

describe("collectImageAttachments", () => {
  test("a freshly written png named in output attaches as a data url", async () => {
    const file = path.join(dir, "shot.png")
    const before = Date.now()
    writeFileSync(file, makePng())
    const out = await run({
      text: `Screenshot saved to ${file}`,
      sinceMs: before,
    })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("file")
    expect(out[0].mime).toBe("image/png")
    expect(out[0].filename).toBe("shot.png")
    expect(out[0].url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("a pre-existing file merely mentioned never attaches", async () => {
    const file = path.join(dir, "old.png")
    writeFileSync(file, makePng())
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)
    const out = await run({
      text: `found ${file} lying around`,
      sinceMs: Date.now(),
    })
    expect(out).toHaveLength(0)
  })

  test("an extension lie is dropped by magic bytes", async () => {
    const file = path.join(dir, "liar.png")
    writeFileSync(file, "just text wearing a png extension")
    const out = await run({ text: file, sinceMs: Date.now() - 1000 })
    expect(out).toHaveLength(0)
  })

  test("nonexistent and empty paths never attach", async () => {
    const empty = path.join(dir, "empty.png")
    writeFileSync(empty, new Uint8Array(0))
    const out = await run({
      text: `${path.join(dir, "ghost.png")} and ${empty}`,
      sinceMs: 0,
    })
    expect(out).toHaveLength(0)
  })

  test("attachments cap at three and dedupe repeats", async () => {
    const before = Date.now()
    const files = [1, 2, 3, 4].map((n) => {
      const file = path.join(dir, `cap-${n}.png`)
      writeFileSync(file, makePng())
      return file
    })
    const out = await run({
      text: [...files, files[0]].join("\n"),
      sinceMs: before,
    })
    expect(out).toHaveLength(3)
    expect(new Set(out.map((a) => a.filename)).size).toBe(3)
  })

  test("quoted and parenthesized paths still match", async () => {
    const before = Date.now()
    const file = path.join(dir, "quoted.png")
    writeFileSync(file, makePng())
    const out = await run({
      text: `wrote "${file}" (see above)`,
      sinceMs: before,
    })
    expect(out).toHaveLength(1)
  })
})
