import { describe, expect, it } from "bun:test"
import { HeadTailBuffer } from "./head-tail-buffer"

// Tests ported from codex-rs/core/src/unified_exec/head_tail_buffer_tests.rs.
// Plus extra edge cases listed in the wave_1 plan: empty chunk, omitted-bytes
// monotonicity, snapshot/toBytes ordering, partial vs whole front-drain on
// tail trim. Every branch in the implementation is exercised below so coverage
// reaches 100% line + branch.

const enc = new TextEncoder()
const dec = new TextDecoder()
const u8 = (s: string) => enc.encode(s)
const str = (a: Uint8Array) => dec.decode(a)
const cat = (chunks: ReadonlyArray<Uint8Array>) => {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

describe("HeadTailBuffer", () => {
  it("new buffer reports retainedBytes === 0 and omittedBytes === 0", () => {
    const buf = new HeadTailBuffer(10)
    expect(buf.retainedBytes()).toBe(0)
    expect(buf.omittedBytes()).toBe(0)
    expect(buf.toBytes().length).toBe(0)
    expect(buf.snapshotChunks()).toEqual([])
  })

  it("default constructor uses 1 MiB max bytes", () => {
    const buf = new HeadTailBuffer()
    buf.pushChunk(new Uint8Array(1024 * 1024))
    expect(buf.retainedBytes()).toBe(1024 * 1024)
    expect(buf.omittedBytes()).toBe(0)
    buf.pushChunk(new Uint8Array(1))
    expect(buf.omittedBytes()).toBe(1)
  })

  it("pushChunk fills head before tail when below max_bytes", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("01"))
    buf.pushChunk(u8("234"))
    expect(str(buf.toBytes())).toBe("01234")
    expect(buf.retainedBytes()).toBe(5)
    expect(buf.omittedBytes()).toBe(0)
  })

  it("pushChunk continues into tail once head is exactly full", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("01234")) // fills head exactly (no split)
    buf.pushChunk(u8("567"))   // entirely to tail
    expect(str(buf.toBytes())).toBe("01234567")
    expect(buf.retainedBytes()).toBe(8)
    expect(buf.omittedBytes()).toBe(0)
  })

  it("pushChunk splits a single chunk across head and tail when crossing the budget", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789")) // 5 → head, 5 → tail
    expect(str(buf.toBytes())).toBe("0123456789")
    expect(buf.retainedBytes()).toBe(10)
    expect(buf.omittedBytes()).toBe(0)
  })

  it("pushChunk drops oldest tail chunks when exceeding tail budget", () => {
    const buf = new HeadTailBuffer(10)
    // Codex test `fills_head_then_tail_across_multiple_chunks`.
    buf.pushChunk(u8("01"))
    buf.pushChunk(u8("234"))
    buf.pushChunk(u8("567"))
    buf.pushChunk(u8("89"))
    expect(str(buf.toBytes())).toBe("0123456789")
    expect(buf.omittedBytes()).toBe(0)
    buf.pushChunk(u8("a"))
    // One byte trimmed from front of oldest tail chunk ("567" -> "67").
    expect(str(buf.toBytes())).toBe("012346789a")
    expect(buf.omittedBytes()).toBe(1)
  })

  it("pushChunk partial-drains a single front tail chunk when excess < front length", () => {
    // tail_budget = 4. Fill head (4), then load tail across 2 chunks, then push
    // a chunk whose excess only consumes part of the oldest tail chunk.
    const buf = new HeadTailBuffer(8)
    buf.pushChunk(u8("ABCD")) // fills head exactly (4 bytes)
    buf.pushChunk(u8("EFG"))  // 3 bytes → tail
    buf.pushChunk(u8("H"))    // 1 byte → tail; tail full (4 bytes)
    expect(str(buf.toBytes())).toBe("ABCDEFGH")
    expect(buf.omittedBytes()).toBe(0)
    buf.pushChunk(u8("IJ"))   // excess = 2: partial-drain front "EFG" -> "G"
    expect(str(buf.toBytes())).toBe("ABCDGHIJ")
    expect(buf.omittedBytes()).toBe(2)
  })

  it("pushChunk fully drains multiple front tail chunks when excess >= front length", () => {
    // Force the trim loop to drain two whole front chunks before exiting.
    // tail = ["A","B","CD"] (4 bytes; tail_budget=4). Push "EF" (2 bytes, < tail_budget).
    // excess=2: drain "A"(1) → excess=1, drain "B"(1) → excess=0, exit.
    const buf = new HeadTailBuffer(8)
    buf.pushChunk(u8("HEAD"))
    buf.pushChunk(u8("A"))
    buf.pushChunk(u8("B"))
    buf.pushChunk(u8("CD"))
    expect(str(buf.toBytes())).toBe("HEADABCD")
    buf.pushChunk(u8("EF"))
    expect(str(buf.toBytes())).toBe("HEADCDEF")
    expect(buf.omittedBytes()).toBe(2)
  })

  it("pushChunk mixes whole + partial front-drain in a single trim", () => {
    // tail = ["AB","CDEF"] (6 bytes), tail_budget=6. Push 3 more.
    // Excess=3: drain whole "AB"(2), then partial "CDEF" -> "DEF" (drain "C").
    const buf = new HeadTailBuffer(12)
    buf.pushChunk(u8("HEADER")) // head full (6 bytes; head_budget=6)
    buf.pushChunk(u8("AB"))     // tail bytes 2
    buf.pushChunk(u8("CDEF"))   // tail bytes 6
    expect(str(buf.toBytes())).toBe("HEADERABCDEF")
    buf.pushChunk(u8("XYZ"))
    expect(str(buf.toBytes())).toBe("HEADERDEFXYZ")
    expect(buf.omittedBytes()).toBe(3)
  })

  it("pushChunk handles a chunk larger than tail_budget by keeping only its last tail_budget bytes", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789"))
    buf.pushChunk(u8("ABCDEFGHIJK")) // 11 bytes > tail_budget(5): keep last 5
    expect(str(buf.toBytes())).toBe("01234GHIJK")
    // Old tail (5) + dropped prefix (11-5=6) = 11.
    expect(buf.omittedBytes()).toBe(11)
    expect(buf.retainedBytes()).toBe(10)
  })

  it("pushChunk handles a chunk larger than max_bytes — head untouched if already full, last tail bytes kept", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789"))     // head + tail full
    expect(buf.retainedBytes()).toBe(10)
    const big = new Uint8Array(20)
    for (let i = 0; i < big.length; i++) big[i] = 0x41 + (i % 26) // "ABCDEFGHIJKLMNOPQRST"
    buf.pushChunk(big)
    expect(buf.retainedBytes()).toBe(10)
    const out = str(buf.toBytes())
    expect(out.startsWith("01234")).toBe(true)
    expect(out.length).toBe(10)
    expect(out.slice(5)).toBe(str(big.subarray(15))) // last 5 bytes of `big`
  })

  it("pushChunk omits everything pushed when max_bytes === 0", () => {
    const buf = new HeadTailBuffer(0)
    buf.pushChunk(u8("abc"))
    expect(buf.retainedBytes()).toBe(0)
    expect(buf.omittedBytes()).toBe(3)
    expect(str(buf.toBytes())).toBe("")
    expect(buf.snapshotChunks()).toEqual([])
    buf.pushChunk(u8("def"))
    expect(buf.omittedBytes()).toBe(6)
  })

  it("pushChunk with max_bytes === 1 keeps only the last byte", () => {
    const buf = new HeadTailBuffer(1)
    buf.pushChunk(u8("abc"))
    expect(buf.retainedBytes()).toBe(1)
    expect(buf.omittedBytes()).toBe(2)
    expect(str(buf.toBytes())).toBe("c")
  })

  it("pushChunk with empty Uint8Array does not change retainedBytes, omittedBytes, or toBytes", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(new Uint8Array(0))
    expect(buf.retainedBytes()).toBe(0)
    expect(buf.omittedBytes()).toBe(0)
    expect(buf.toBytes().length).toBe(0)
    buf.pushChunk(u8("hi"))
    buf.pushChunk(new Uint8Array(0))
    expect(buf.retainedBytes()).toBe(2)
    expect(buf.omittedBytes()).toBe(0)
    expect(str(buf.toBytes())).toBe("hi")
  })

  it("pushChunk with empty Uint8Array when head is full leaves observable state unchanged", () => {
    // max_bytes=4 → head_budget=2, tail_budget=2. "HEAD" splits 2/2.
    const buf = new HeadTailBuffer(4)
    buf.pushChunk(u8("HEAD"))
    expect(str(buf.toBytes())).toBe("HEAD")
    buf.pushChunk(new Uint8Array(0)) // exercises the post-head-full path with empty chunk
    expect(buf.retainedBytes()).toBe(4)
    expect(buf.omittedBytes()).toBe(0)
    expect(str(buf.toBytes())).toBe("HEAD")
  })

  it("omittedBytes accumulates monotonically across pushes", () => {
    // Trace (max_bytes=6, head_budget=3, tail_budget=3):
    //   push "ABCDEF" -> head="ABC", tail=["DEF"]; omitted=0
    //   push "GH"     -> tail=["DEF","GH"](5); trim 2: partial "DEF"→"F"; tail=["F","GH"](3); omitted=2
    //   push "IJ"     -> tail=["F","GH","IJ"](5); trim 2: drain "F"(1, omit+1=3), partial "GH"→"H" (omit+1=4); tail=["H","IJ"](3)
    //   push "KLMNOPQRST" (10 > tail_budget): replace tail; omit += old tail(3)+dropped(7)=10; total=14
    //   final: head="ABC", tail=["RST"]; toBytes="ABCRST"
    const buf = new HeadTailBuffer(6)
    buf.pushChunk(u8("ABCDEF"))
    expect(buf.omittedBytes()).toBe(0)
    buf.pushChunk(u8("GH"))
    expect(buf.omittedBytes()).toBe(2)
    buf.pushChunk(u8("IJ"))
    expect(buf.omittedBytes()).toBe(4)
    buf.pushChunk(u8("KLMNOPQRST"))
    expect(buf.omittedBytes()).toBe(14)
    expect(str(buf.toBytes())).toBe("ABCRST")
  })

  it("snapshotChunks returns head chunks then tail chunks in insertion order", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("01"))
    buf.pushChunk(u8("23"))
    buf.pushChunk(u8("4"))   // head bytes 5
    buf.pushChunk(u8("56"))
    buf.pushChunk(u8("78"))
    buf.pushChunk(u8("9"))   // tail bytes 5
    const chunks = buf.snapshotChunks()
    expect(chunks.length).toBe(6)
    expect(str(cat(chunks))).toBe("0123456789")
    expect(str(chunks[0])).toBe("01")
    expect(str(chunks[1])).toBe("23")
    expect(str(chunks[2])).toBe("4")
    expect(str(chunks[3])).toBe("56")
    expect(str(chunks[4])).toBe("78")
    expect(str(chunks[5])).toBe("9")
  })

  it("toBytes concatenates head + tail with no separator and never includes omitted middle", () => {
    const buf = new HeadTailBuffer(8)
    buf.pushChunk(u8("ABCDEFGH")) // 4 head + 4 tail
    buf.pushChunk(u8("IJKL"))     // replace tail by last 4 of "IJKL" -> "IJKL"; omit old tail (4)
    expect(str(buf.toBytes())).toBe("ABCDIJKL")
    expect(buf.omittedBytes()).toBe(4)
  })

  it("drainChunks returns head-then-tail chunks and resets retained + omitted to 0", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789"))
    // After: head=["01234"], tail=["56789"]; retained=10, omitted=0.
    buf.pushChunk(u8("ab"))
    // tail becomes ["56789","ab"](7); trim excess=2 partial-drains "56789"→"789".
    // After: head=["01234"], tail=["789","ab"]; retained=10, omitted=2.
    expect(buf.omittedBytes()).toBe(2)
    expect(buf.retainedBytes()).toBe(10)
    const drained = buf.drainChunks()
    expect(drained.length).toBeGreaterThan(0)
    // Drained order is head first then tail; concatenation matches toBytes pre-drain.
    expect(str(cat(drained))).toBe("01234789ab")
    // Reset.
    expect(buf.retainedBytes()).toBe(0)
    expect(buf.omittedBytes()).toBe(0)
    expect(str(buf.toBytes())).toBe("")
    expect(buf.snapshotChunks()).toEqual([])
    // Reusable after drain.
    buf.pushChunk(u8("xy"))
    expect(str(buf.toBytes())).toBe("xy")
    expect(buf.omittedBytes()).toBe(0)
  })

  it("matches codex `keeps_prefix_and_suffix_when_over_budget` test", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789"))
    expect(buf.omittedBytes()).toBe(0)
    buf.pushChunk(u8("ab"))
    expect(buf.omittedBytes()).toBeGreaterThan(0)
    const out = str(buf.toBytes())
    expect(out.startsWith("01234")).toBe(true)
    expect(out.endsWith("89ab")).toBe(true)
  })

  it("matches codex `chunk_larger_than_tail_budget_keeps_only_tail_end` test", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789"))
    buf.pushChunk(u8("ABCDEFGHIJK"))
    const out = str(buf.toBytes())
    expect(out.startsWith("01234")).toBe(true)
    expect(out.endsWith("GHIJK")).toBe(true)
    expect(buf.omittedBytes()).toBeGreaterThan(0)
  })

  it("matches codex `draining_resets_state` test", () => {
    const buf = new HeadTailBuffer(10)
    buf.pushChunk(u8("0123456789"))
    buf.pushChunk(u8("ab"))
    const drained = buf.drainChunks()
    expect(drained.length).toBeGreaterThan(0)
    expect(buf.retainedBytes()).toBe(0)
    expect(buf.omittedBytes()).toBe(0)
    expect(str(buf.toBytes())).toBe("")
  })
})
