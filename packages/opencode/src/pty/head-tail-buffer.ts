// Symmetric head/tail output buffer ported from codex's
// codex-rs/core/src/unified_exec/head_tail_buffer.rs (commit at the time of
// porting; see .wave/campaigns/codex-parity-2026-05-13/plan/REFERENCES.md).
//
// Half the budget is reserved for the prefix ("head"); the rest for the
// suffix ("tail"). Once the head fills, new bytes go to the tail; when the
// tail exceeds its budget, the oldest tail bytes are dropped first. The
// algorithm matches codex byte-for-byte so the unified_exec tool surface in
// later waves produces output identical to codex's reference behaviour.

const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024 // 1 MiB; codex unified_exec/mod.rs:67

export class HeadTailBuffer {
  private readonly maxBytes: number
  private readonly headBudget: number
  private readonly tailBudget: number
  private head: Uint8Array[] = []
  private tail: Uint8Array[] = []
  private headBytesCount = 0
  private tailBytesCount = 0
  private omittedBytesCount = 0

  constructor(maxBytes: number = UNIFIED_EXEC_OUTPUT_MAX_BYTES) {
    this.maxBytes = maxBytes
    this.headBudget = Math.floor(maxBytes / 2)
    this.tailBudget = maxBytes - this.headBudget
  }

  /** Total bytes currently retained (head + tail). */
  retainedBytes(): number {
    return this.headBytesCount + this.tailBytesCount
  }

  /** Total bytes dropped from the middle since the last drain. Monotonic across pushes. */
  omittedBytes(): number {
    return this.omittedBytesCount
  }

  /**
   * Append `chunk` to the buffer. Bytes fill the head first, then spill into
   * the tail; older tail bytes are dropped to keep within `maxBytes`.
   */
  pushChunk(chunk: Uint8Array): void {
    if (this.maxBytes === 0) {
      this.omittedBytesCount += chunk.length
      return
    }

    if (this.headBytesCount < this.headBudget) {
      const remainingHead = this.headBudget - this.headBytesCount
      if (chunk.length <= remainingHead) {
        this.headBytesCount += chunk.length
        this.head.push(chunk)
        return
      }
      // Split: prefix into head, suffix into tail. remainingHead is > 0 here
      // (the outer guard ensures headBytesCount < headBudget), so the head
      // part is never empty.
      const headPart = chunk.subarray(0, remainingHead)
      const tailPart = chunk.subarray(remainingHead)
      this.headBytesCount += headPart.length
      this.head.push(headPart)
      this.pushToTail(tailPart)
      return
    }

    this.pushToTail(chunk)
  }

  /** Snapshot retained chunks: head chunks then tail chunks (no separator). */
  snapshotChunks(): Uint8Array[] {
    return [...this.head, ...this.tail]
  }

  /** Concatenate head + tail into a single Uint8Array. Omitted middle is not represented. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.retainedBytes())
    let off = 0
    for (const chunk of this.head) {
      out.set(chunk, off)
      off += chunk.length
    }
    for (const chunk of this.tail) {
      out.set(chunk, off)
      off += chunk.length
    }
    return out
  }

  /** Drain all retained chunks (head then tail) and reset buffer state to empty. */
  drainChunks(): Uint8Array[] {
    const out = [...this.head, ...this.tail]
    this.head = []
    this.tail = []
    this.headBytesCount = 0
    this.tailBytesCount = 0
    this.omittedBytesCount = 0
    return out
  }

  private pushToTail(chunk: Uint8Array): void {
    // tailBudget is only ever 0 when maxBytes is 0, which pushChunk handles
    // before reaching here, so we do not guard against tailBudget === 0.

    if (chunk.length >= this.tailBudget) {
      // The chunk alone is at least as large as the entire tail budget.
      // Discard everything currently in the tail and keep only the last
      // `tailBudget` bytes of this chunk.
      const start = chunk.length - this.tailBudget
      const kept = chunk.subarray(start)
      this.omittedBytesCount += this.tailBytesCount + start
      this.tail = [kept]
      this.tailBytesCount = kept.length
      return
    }

    this.tailBytesCount += chunk.length
    this.tail.push(chunk)
    this.trimTailToBudget()
  }

  private trimTailToBudget(): void {
    let excess = this.tailBytesCount - this.tailBudget
    while (excess > 0) {
      // Invariant: excess > 0 ⇒ tail has bytes ⇒ tail.length >= 1, so the
      // entry at index 0 is always defined here.
      const front = this.tail[0]
      if (excess >= front.length) {
        excess -= front.length
        this.tailBytesCount -= front.length
        this.omittedBytesCount += front.length
        this.tail.shift()
        continue
      }
      this.tail[0] = front.subarray(excess)
      this.tailBytesCount -= excess
      this.omittedBytesCount += excess
      break
    }
  }
}
