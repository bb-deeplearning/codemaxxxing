import { platform } from "os"
import { tmpdir } from "os"
import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"
import { Filesystem } from "../../../../util/filesystem"
import { Process } from "../../../../util/process"
import { which } from "../../../../util/which"

// MIME types Anthropic (and most multimodal providers) accept directly.
const SUPPORTED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

// Formats we know how to convert. HEIC/HEIF cover iPhone screenshots/photos,
// which is the common case where HEIC sneaks in.
const CONVERTIBLE = new Set(["image/heic", "image/heif"])

export interface ConvertResult {
  mime: string
  // base64-encoded image data
  content: string
  filename?: string
}

export interface ConvertInput {
  mime: string
  // base64-encoded image data
  content: string
  filename?: string
}

export class ConvertError extends Error {
  constructor(
    public sourceMime: string,
    message: string,
  ) {
    super(message)
  }
}

export function needsConvert(mime: string) {
  return CONVERTIBLE.has(mime.toLowerCase())
}

export function isSupported(mime: string) {
  return SUPPORTED.has(mime.toLowerCase())
}

// Converts an image to JPEG using whatever native tool is available on the host.
// Throws ConvertError if no converter exists or conversion fails.
export async function toJpeg(input: ConvertInput): Promise<ConvertResult> {
  const id = randomUUID()
  const src = path.join(tmpdir(), `opencode-img-${id}.bin`)
  const dst = path.join(tmpdir(), `opencode-img-${id}.jpg`)

  await fs.writeFile(src, Buffer.from(input.content, "base64"))

  try {
    const tool = pick()
    if (!tool) {
      throw new ConvertError(
        input.mime,
        `Cannot convert ${input.mime}: no image converter found. ` +
          `Install one of: sips (macOS), magick/convert (ImageMagick), or heif-convert (libheif).`,
      )
    }

    const out = await Process.run(tool(src, dst), { nothrow: true })
    if (out.code !== 0) {
      throw new ConvertError(
        input.mime,
        `Image conversion failed (${path.basename(tool(src, dst)[0]!)}): ${out.stderr.toString().trim() || "unknown error"}`,
      )
    }

    const buf = await Filesystem.readBytes(dst)
    return {
      mime: "image/jpeg",
      content: buf.toString("base64"),
      filename: input.filename ? swapExt(input.filename, ".jpg") : undefined,
    }
  } finally {
    await fs.rm(src, { force: true }).catch(() => {})
    await fs.rm(dst, { force: true }).catch(() => {})
  }
}

function pick(): ((src: string, dst: string) => string[]) | undefined {
  if (platform() === "darwin" && which("sips")) {
    return (src, dst) => ["sips", "-s", "format", "jpeg", src, "--out", dst]
  }
  if (which("magick")) return (src, dst) => ["magick", src, dst]
  if (which("convert")) return (src, dst) => ["convert", src, dst]
  if (which("heif-convert")) return (src, dst) => ["heif-convert", src, dst]
  return undefined
}

function swapExt(name: string, ext: string) {
  const dir = path.dirname(name)
  const base = path.basename(name, path.extname(name))
  return dir && dir !== "." ? path.join(dir, base + ext) : base + ext
}
