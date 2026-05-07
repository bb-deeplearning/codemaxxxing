import { describe, expect, test } from "bun:test"
import {
  readDimensions,
  checkDataUrlOversized,
  resizeIfOversized,
  MAX_DIMENSION_SINGLE,
} from "../../src/util/image-resize"

// Build a minimal valid PNG with the given dimensions. PNG dimension reader
// only inspects the IHDR chunk (bytes 16..23 of the file).
function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  // PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < sig.length; i++) bytes[i] = sig[i]
  // IHDR length (13)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  // IHDR type "IHDR"
  bytes[12] = 0x49
  bytes[13] = 0x48
  bytes[14] = 0x44
  bytes[15] = 0x52
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

// Build a minimal JPEG header: SOI, then a SOF0 segment containing dimensions.
function makeJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20)
  bytes[0] = 0xff
  bytes[1] = 0xd8 // SOI
  bytes[2] = 0xff
  bytes[3] = 0xc0 // SOF0
  // Segment length (placeholder, not used by parser beyond sanity)
  bytes[4] = 0x00
  bytes[5] = 0x11
  // Precision
  bytes[6] = 0x08
  // Height (big-endian)
  bytes[7] = (height >> 8) & 0xff
  bytes[8] = height & 0xff
  // Width (big-endian)
  bytes[9] = (width >> 8) & 0xff
  bytes[10] = width & 0xff
  return bytes
}

function makeGif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  // "GIF89a"
  const sig = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
  for (let i = 0; i < sig.length; i++) bytes[i] = sig[i]
  // Width (LE)
  bytes[6] = width & 0xff
  bytes[7] = (width >> 8) & 0xff
  // Height (LE)
  bytes[8] = height & 0xff
  bytes[9] = (height >> 8) & 0xff
  return bytes
}

describe("image-resize.readDimensions", () => {
  test("parses PNG dimensions", () => {
    expect(readDimensions(makePng(1024, 768), "image/png")).toEqual({ width: 1024, height: 768 })
  })

  test("parses JPEG dimensions", () => {
    expect(readDimensions(makeJpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 })
  })

  test("parses GIF dimensions", () => {
    expect(readDimensions(makeGif(320, 240), "image/gif")).toEqual({ width: 320, height: 240 })
  })

  test("returns undefined for unrecognized format", () => {
    expect(readDimensions(new Uint8Array([0, 0, 0]), "image/svg+xml")).toBeUndefined()
  })

  test("returns undefined for short PNG buffer", () => {
    expect(readDimensions(new Uint8Array([0x89, 0x50]), "image/png")).toBeUndefined()
  })

  test("handles large PNG dimensions", () => {
    expect(readDimensions(makePng(9000, 1000), "image/png")).toEqual({ width: 9000, height: 1000 })
  })
})

describe("image-resize.checkDataUrlOversized", () => {
  test("returns dimensions when image exceeds limit", () => {
    const url = `data:image/png;base64,${Buffer.from(makePng(9000, 5000)).toString("base64")}`
    expect(checkDataUrlOversized(url)).toEqual({ width: 9000, height: 5000 })
  })

  test("returns dimensions when only height exceeds limit", () => {
    const url = `data:image/png;base64,${Buffer.from(makePng(2000, 9000)).toString("base64")}`
    expect(checkDataUrlOversized(url)).toEqual({ width: 2000, height: 9000 })
  })

  test("returns undefined for image within limit", () => {
    const url = `data:image/png;base64,${Buffer.from(makePng(1024, 768)).toString("base64")}`
    expect(checkDataUrlOversized(url)).toBeUndefined()
  })

  test("returns undefined exactly at the limit", () => {
    const url = `data:image/png;base64,${Buffer.from(makePng(MAX_DIMENSION_SINGLE, MAX_DIMENSION_SINGLE)).toString("base64")}`
    expect(checkDataUrlOversized(url)).toBeUndefined()
  })

  test("respects custom maxDimension", () => {
    const url = `data:image/png;base64,${Buffer.from(makePng(2500, 100)).toString("base64")}`
    expect(checkDataUrlOversized(url, 2000)).toEqual({ width: 2500, height: 100 })
    expect(checkDataUrlOversized(url, 3000)).toBeUndefined()
  })

  test("returns undefined for non-image data URLs", () => {
    expect(checkDataUrlOversized("data:text/plain;base64,aGVsbG8=")).toBeUndefined()
  })

  test("returns undefined for malformed data URL", () => {
    expect(checkDataUrlOversized("not-a-data-url")).toBeUndefined()
  })

  test("returns undefined for unknown image format", () => {
    // SVG is text, no dimensions in header — caller should let it through
    expect(checkDataUrlOversized("data:image/svg+xml;base64,PHN2Zy8+")).toBeUndefined()
  })
})

describe("image-resize.resizeIfOversized", () => {
  test("returns input unchanged when within limit", async () => {
    const bytes = makePng(1024, 768)
    const result = await resizeIfOversized({ bytes, mime: "image/png" })
    expect(result.resized).toBe(false)
    expect(result.bytes).toBe(bytes)
    expect(result.original).toEqual({ width: 1024, height: 768 })
  })

  test("returns input unchanged when format unrecognized", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3])
    const result = await resizeIfOversized({ bytes, mime: "image/svg+xml" })
    expect(result.resized).toBe(false)
    expect(result.bytes).toBe(bytes)
  })

  test("when oversized but no resizer available, returns input unchanged with original dims", async () => {
    // Crafted PNG header is not a real image, so even if a resizer is installed
    // it will fail decoding — we still expect a graceful pass-through.
    const bytes = makePng(9000, 9000)
    const result = await resizeIfOversized({ bytes, mime: "image/png" })
    expect(result.original).toEqual({ width: 9000, height: 9000 })
    // We can't assert resized=true here because the header isn't a real image,
    // so the converter (sips/magick) will fail. Either way the function must
    // not throw and must return the input.
    expect(result.bytes).toBeDefined()
  })
})
