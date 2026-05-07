import { platform } from "os"
import { tmpdir } from "os"
import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"
import { Process } from "./process"
import { which } from "./which"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "image-resize" })

// Anthropic enforces a hard cap of 8000px on the longest edge for any single
// image. When multiple images are sent in one request the cap drops to 2000px.
// We use 7500/1900 to leave a safety margin against any rounding the provider
// performs after re-decoding.
//
// We default to MAX_DIMENSION_MULTI for ingest-time resizing because we can't
// predict how many images will accumulate in a session (Chrome devtools /
// Playwright sessions easily reach the multi-image case after a few turns).
// Resizing to the safer cap up front avoids the "session bricked on turn 7"
// failure mode entirely.
//
// Other providers (OpenAI, Google, Bedrock) accept much larger images but
// charge per pixel — keeping things small is also a cost win.
export const MAX_DIMENSION_SINGLE = 7500
export const MAX_DIMENSION_MULTI = 1900
export const MAX_DIMENSION_DEFAULT = MAX_DIMENSION_MULTI

export interface Dimensions {
  width: number
  height: number
}

// Reads the intrinsic pixel dimensions from common image formats by parsing
// only the file header. No native deps, no shell-out for the dimension check.
// Returns undefined for formats we don't recognize (caller should treat as ok).
export function readDimensions(bytes: Uint8Array, mime: string): Dimensions | undefined {
  const m = mime.toLowerCase()
  if (m === "image/png") return readPngDimensions(bytes)
  if (m === "image/jpeg" || m === "image/jpg") return readJpegDimensions(bytes)
  if (m === "image/gif") return readGifDimensions(bytes)
  if (m === "image/webp") return readWebpDimensions(bytes)
  return undefined
}

function readPngDimensions(bytes: Uint8Array): Dimensions | undefined {
  // PNG: 8-byte signature, then IHDR chunk: 4 length, 4 type, 4 width, 4 height
  if (bytes.length < 24) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function readJpegDimensions(bytes: Uint8Array): Dimensions | undefined {
  // Walk JPEG markers until we hit a SOFn frame containing the dimensions.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 2
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return undefined
    let marker = bytes[i + 1]
    // Skip fill bytes (0xFF padding)
    while (marker === 0xff && i + 1 < bytes.length) {
      i++
      marker = bytes[i + 1]
    }
    i += 2
    // Standalone markers (no segment): SOI/EOI/RSTn/TEM
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (i + 2 > bytes.length) return undefined
    const segLen = view.getUint16(i)
    // SOFn frames: 0xC0..0xCF excluding 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > bytes.length) return undefined
      return { height: view.getUint16(i + 3), width: view.getUint16(i + 5) }
    }
    i += segLen
  }
  return undefined
}

function readGifDimensions(bytes: Uint8Array): Dimensions | undefined {
  // GIF: 6-byte signature ("GIF87a"/"GIF89a"), then logical screen descriptor: width LE, height LE
  if (bytes.length < 10) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function readWebpDimensions(bytes: Uint8Array): Dimensions | undefined {
  // WebP: "RIFF" .... "WEBP" then a chunk identifying the variant.
  if (bytes.length < 30) return undefined
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return undefined
  if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // VP8 (lossy): "VP8 " at 12, then chunk size, then 10 bytes of frame tag, then width/height (14 bits each, LE)
  if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
    const w = view.getUint16(26, true) & 0x3fff
    const h = view.getUint16(28, true) & 0x3fff
    return { width: w, height: h }
  }
  // VP8L (lossless): "VP8L" at 12, signature byte 0x2F at 20, then 14-bit width-1 and height-1
  if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
    if (bytes[20] !== 0x2f) return undefined
    const b = view.getUint32(21, true)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  // VP8X (extended): "VP8X" at 12, then 24-bit canvas width-1 and height-1 starting at byte 24
  if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
    const w = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1
    const h = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1
    return { width: w, height: h }
  }
  return undefined
}

export interface ResizeInput {
  bytes: Uint8Array
  mime: string
  // Maximum allowed pixel dimension on either edge. Defaults to MAX_DIMENSION_SINGLE.
  maxDimension?: number
}

export interface ResizeResult {
  bytes: Uint8Array
  mime: string
  // Whether the image was actually resized. False means the input was returned unchanged.
  resized: boolean
  // Original dimensions if we could read them.
  original?: Dimensions
  // Final dimensions if we resized successfully.
  final?: Dimensions
}

// Downscales an image so that no edge exceeds maxDimension. Returns the input
// unchanged if dimensions are within range, the format is unrecognized, or no
// converter tool is available on the host.
export async function resizeIfOversized(input: ResizeInput): Promise<ResizeResult> {
  const max = input.maxDimension ?? MAX_DIMENSION_DEFAULT
  const dims = readDimensions(input.bytes, input.mime)
  if (!dims) {
    log.debug("could not read dimensions, passing through", { mime: input.mime })
    return { bytes: input.bytes, mime: input.mime, resized: false }
  }
  if (dims.width <= max && dims.height <= max) {
    return { bytes: input.bytes, mime: input.mime, resized: false, original: dims }
  }

  const tool = pickResizer()
  if (!tool) {
    log.warn("image exceeds max dimension but no resizer is installed", {
      mime: input.mime,
      width: dims.width,
      height: dims.height,
      max,
    })
    return { bytes: input.bytes, mime: input.mime, resized: false, original: dims }
  }

  const id = randomUUID()
  const ext = extFor(input.mime)
  const src = path.join(tmpdir(), `opencode-resize-${id}${ext}`)
  // Always re-encode to JPEG: it's universally supported and small. The only
  // exception is PNG containing transparency we'd want to preserve; for the
  // sizes we care about (screenshots that broke the API) JPEG is correct.
  const dst = path.join(tmpdir(), `opencode-resize-${id}-out.jpg`)

  try {
    await fs.writeFile(src, input.bytes)
    const cmd = tool(src, dst, max)
    const result = await Process.run(cmd, { nothrow: true })
    if (result.code !== 0) {
      log.warn("image resize failed, passing through", {
        cmd: cmd[0],
        stderr: result.stderr.toString().trim(),
      })
      return { bytes: input.bytes, mime: input.mime, resized: false, original: dims }
    }

    const out = await fs.readFile(dst)
    const finalDims = readDimensions(out, "image/jpeg")
    log.info("resized oversized image", {
      from: `${dims.width}x${dims.height}`,
      to: finalDims ? `${finalDims.width}x${finalDims.height}` : "?",
      mime: input.mime,
    })
    return {
      bytes: out,
      mime: "image/jpeg",
      resized: true,
      original: dims,
      final: finalDims,
    }
  } catch (e) {
    log.warn("image resize threw, passing through", { error: e instanceof Error ? e.message : String(e) })
    return { bytes: input.bytes, mime: input.mime, resized: false, original: dims }
  } finally {
    await fs.rm(src, { force: true }).catch(() => {})
    await fs.rm(dst, { force: true }).catch(() => {})
  }
}

// Convenience wrapper for the common case: a base64-encoded data URL.
export async function resizeDataUrlIfOversized(
  dataUrl: string,
  options?: { maxDimension?: number },
): Promise<{ url: string; mime: string; resized: boolean }> {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/)
  if (!match || !match[2]) return { url: dataUrl, mime: match?.[1] ?? "", resized: false }
  const mime = match[1]
  const bytes = Buffer.from(match[3], "base64")
  const result = await resizeIfOversized({ bytes, mime, maxDimension: options?.maxDimension })
  if (!result.resized) return { url: dataUrl, mime, resized: false }
  return {
    url: `data:${result.mime};base64,${Buffer.from(result.bytes).toString("base64")}`,
    mime: result.mime,
    resized: true,
  }
}

// Synchronous oversized-check for a base64 data URL. Used to strip oversized
// images from message history without paying the cost of decoding/resizing.
// Returns the dimensions if oversized, undefined otherwise (including unknown
// formats — we can't tell, so we let it through).
export function checkDataUrlOversized(dataUrl: string, maxDimension = MAX_DIMENSION_DEFAULT): Dimensions | undefined {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) return undefined
  const mime = match[1]
  if (!mime.startsWith("image/")) return undefined
  // Only decode the first ~64 bytes — enough for any header we parse. JPEG SOF
  // can be anywhere though, so for JPEG we decode more.
  const headerLen = mime.toLowerCase().includes("jpeg") || mime.toLowerCase().includes("jpg") ? 64 * 1024 : 64
  // base64: every 4 chars -> 3 bytes. Slice the prefix proportionally.
  const b64Len = Math.min(match[2].length, Math.ceil((headerLen * 4) / 3))
  const bytes = Buffer.from(match[2].slice(0, b64Len), "base64")
  const dims = readDimensions(bytes, mime)
  if (!dims) return undefined
  if (dims.width > maxDimension || dims.height > maxDimension) return dims
  return undefined
}

function pickResizer(): ((src: string, dst: string, max: number) => string[]) | undefined {
  // sips ships on macOS by default and is the most reliable.
  if (platform() === "darwin" && which("sips")) {
    return (src, dst, max) => ["sips", "--resampleHeightWidthMax", String(max), "-s", "format", "jpeg", src, "--out", dst]
  }
  // ImageMagick covers Linux and any host where the user has installed it.
  if (which("magick")) {
    return (src, dst, max) => ["magick", src, "-resize", `${max}x${max}>`, dst]
  }
  if (which("convert")) {
    return (src, dst, max) => ["convert", src, "-resize", `${max}x${max}>`, dst]
  }
  return undefined
}

function extFor(mime: string): string {
  const m = mime.toLowerCase()
  if (m === "image/png") return ".png"
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg"
  if (m === "image/gif") return ".gif"
  if (m === "image/webp") return ".webp"
  return ".bin"
}
