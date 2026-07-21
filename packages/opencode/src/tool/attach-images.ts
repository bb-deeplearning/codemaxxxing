// Shell-family tools narrate screenshots in prose — "Screenshot saved to
// /tmp/shot.png" from agent-browser, simctl, or any other CLI — and the
// pixels never reach the transcript. This helper scans a tool's output
// text for freshly written image files and returns them as FilePart
// attachments so clients render the image and the model sees what it
// shot without a follow-up read.
//
// Guards, in order (all must pass):
// 1. absolute POSIX path with an image extension in the text
// 2. file exists, non-empty, under the size cap
// 3. mtime inside the command's run window (pre-existing files that merely
//    get MENTIONED — a `find ~ -name '*.png'` haul — never attach)
// 4. magic bytes match a supported image type (extension lies are dropped;
//    see GOTCHAS `image-header-parsers-must-validate-magic-bytes`)
// Oversized dimensions go through the same ImageResize gate every other
// attachment path uses so a retina screenshot cannot brick the session.

import { Effect } from "effect"
import type { MessageV2 } from "../session/message-v2"
import { sniffAttachmentMime } from "@/util/media"
import * as ImageResize from "@/util/image-resize"

const IMAGE_PATH_RE = /(?:^|[\s"'`(=])((?:\/[^\s"'`()[\]:]+)+\.(?:png|jpe?g|webp|gif))/gim
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const MAX_ATTACHMENTS = 3
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
// clock fuzz between the command's start stamp and the filesystem
const MTIME_SLACK_MS = 2_000

export type ImageAttachment = Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">

export const collectImageAttachments = (input: {
  /** the text the model sees: command + captured output */
  text: string
  /** when the command started — only files written after this attach */
  sinceMs: number
}): Effect.Effect<ImageAttachment[]> =>
  Effect.promise(async () => {
    const seen = new Set<string>()
    const out: ImageAttachment[] = []
    for (const match of input.text.matchAll(IMAGE_PATH_RE)) {
      if (out.length >= MAX_ATTACHMENTS) break
      const filepath = match[1]
      if (!filepath || seen.has(filepath)) continue
      seen.add(filepath)
      const file = Bun.file(filepath)
      const stat = await file.stat().catch(() => undefined)
      if (!stat?.isFile() || stat.size === 0 || stat.size > MAX_SOURCE_BYTES) continue
      if (stat.mtimeMs < input.sinceMs - MTIME_SLACK_MS) continue
      const bytes = await file
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer))
        .catch(() => undefined)
      if (!bytes || bytes.length === 0) continue
      const mime = sniffAttachmentMime(bytes.subarray(0, 16), "")
      if (!SUPPORTED_IMAGE_MIMES.has(mime)) continue
      const resized = await ImageResize.resizeIfOversized({ bytes, mime }).catch(() => undefined)
      if (!resized) continue
      out.push({
        type: "file" as const,
        mime: resized.mime,
        filename: filepath.split("/").at(-1),
        url: `data:${resized.mime};base64,${Buffer.from(resized.bytes).toString("base64")}`,
      })
    }
    return out
  })
