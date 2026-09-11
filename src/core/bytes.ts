export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

export function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/**
 * Buffered reader over a byte stream. Every proxy handshake in this codebase
 * needs it for the same reason: the reply and the first payload bytes can share
 * one TCP segment, so whatever is read past the handshake must be handed back
 * rather than dropped.
 */
export class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private buf: Uint8Array = new Uint8Array(0)
  private done = false

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader()
  }

  private async pull(): Promise<boolean> {
    const { value, done } = await this.reader.read()
    if (done) { this.done = true; return false }
    if (value) this.buf = concat([this.buf, value])
    return true
  }

  async readAtLeast(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.pull())) throw new Error('stream ended before enough bytes')
    }
    return this.buf
  }

  async readUntilSeq(needle: Uint8Array, limit: number): Promise<{ head: Uint8Array; rest: Uint8Array }> {
    for (;;) {
      const at = indexOfSeq(this.buf, needle)
      if (at >= 0) {
        const cut = at + needle.length
        const head = this.buf.subarray(0, cut)
        const rest = this.buf.subarray(cut)
        this.buf = new Uint8Array(0)
        return { head: new Uint8Array(head), rest: new Uint8Array(rest) }
      }
      if (this.buf.length > limit) throw new Error('terminator not found within limit')
      if (!(await this.pull())) throw new Error('stream ended before terminator')
    }
  }

  take(n: number): Uint8Array {
    const out = new Uint8Array(this.buf.subarray(0, n))
    this.buf = new Uint8Array(this.buf.subarray(n))
    return out
  }

  leftover(): Uint8Array {
    const out = this.buf
    this.buf = new Uint8Array(0)
    return out
  }

  release(): void {
    this.reader.releaseLock()
  }

  /** Puts bytes back at the front. A socks5 or CONNECT handshake can read past
   *  its own terminator, and those bytes are the start of the response. */
  unshift(prefix: Uint8Array): void {
    this.buf = concat([prefix, this.buf])
  }
}
