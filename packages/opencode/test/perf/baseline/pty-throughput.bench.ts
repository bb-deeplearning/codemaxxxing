import { bench, type BenchResult } from "../../lib/perf"

// Wave 0 baseline: per-chunk cost of the buffer accumulation that pty/index.ts
// runs inside `proc.onData`. The bench is synthetic — it duplicates the
// algorithm so each sample is deterministic and free of native PTY scheduling
// noise. Wave 1 (head/tail buffer port) and Wave 2 (Pty.Service extensions)
// compare their replacements against this number.
//
// Algorithm matches src/pty/index.ts L231-255 verbatim:
//   session.cursor += chunk.length
//   session.buffer += chunk
//   if buffer.length > BUFFER_LIMIT: drop the leading excess and bump bufferCursor

const BUFFER_LIMIT = 1024 * 1024 * 2 // mirrors src/pty/index.ts:18
const CHUNK = "X".repeat(4096)
const CHUNKS_PER_SAMPLE = 100

export const benchPtyThroughput = async (): Promise<Record<string, BenchResult>> => {
  const result = await bench(
    { samples: 200, warmup: 20, label: "pty.push.4kb" },
    () => {
      let buffer = ""
      let cursor = 0
      let bufferCursor = 0
      for (let i = 0; i < CHUNKS_PER_SAMPLE; i++) {
        cursor += CHUNK.length
        buffer += CHUNK
        if (buffer.length <= BUFFER_LIMIT) continue
        const excess = buffer.length - BUFFER_LIMIT
        buffer = buffer.slice(excess)
        bufferCursor += excess
      }
      // Force the engine to retain the result so the loop body isn't elided.
      // Reading a property is enough — string concat output is consumed.
      if (buffer.length === -1 || cursor === -1 || bufferCursor === -1) throw new Error("unreachable")
    },
  )
  return { "pty.push.4kb": result }
}
