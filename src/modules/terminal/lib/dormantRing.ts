const DEFAULT_BYTE_CAP = 256 * 1024;
const DEFAULT_CHUNK_CAP = 256;

export class DormantRing {
  private chunks: (Uint8Array | null)[] = [];
  private head = 0;
  private size = 0;
  private total = 0;
  private didOverflow = false;

  constructor(
    private readonly byteCap = DEFAULT_BYTE_CAP,
    private readonly chunkCap = DEFAULT_CHUNK_CAP,
  ) {}

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes.length >= this.byteCap) {
      this.chunks = [bytes.subarray(bytes.length - this.byteCap)];
      this.head = 0;
      this.size = 1;
      this.total = this.byteCap;
      this.didOverflow = true;
      return;
    }
    this.chunks.push(bytes);
    this.size++;
    this.total += bytes.length;
    while (
      (this.total > this.byteCap || this.size > this.chunkCap) &&
      this.size > 1
    ) {
      const dropped = this.chunks[this.head]!;
      this.chunks[this.head] = null;
      this.head++;
      this.size--;
      this.total -= dropped.length;
      this.didOverflow = true;
    }
    if (this.head > 1024 && this.head > this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  /** Whether any buffered output was dropped while dormant. The tail that
   *  remains then starts mid-stream and can't be replayed into a coherent
   *  screen, so the reattach path discards it and triggers a live repaint
   *  (SIGWINCH) instead of writing garbled bytes. Cleared by drain(). */
  overflowed(): boolean {
    return this.didOverflow;
  }

  drain(write: (bytes: Uint8Array) => void): void {
    const end = this.head + this.size;
    for (let i = this.head; i < end; i++) {
      const c = this.chunks[i];
      if (c) write(c);
    }
    this.chunks = [];
    this.head = 0;
    this.size = 0;
    this.total = 0;
    this.didOverflow = false;
  }

  byteLength(): number {
    return this.total;
  }
}
