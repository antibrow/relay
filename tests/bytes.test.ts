import { describe, expect, it } from 'vitest'
import { ByteReader, concat, indexOfSeq } from '../src/core/bytes'

const streamOf = (...chunks: number[][]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new Uint8Array(chunk))
      c.close()
    },
  })

const CRLF2 = new TextEncoder().encode('\r\n\r\n')

describe('indexOfSeq', () => {
  it('finds a sequence that spans the middle', () => {
    expect(indexOfSeq(new Uint8Array([1, 2, 3, 4]), new Uint8Array([2, 3]))).toBe(1)
  })

  it('returns -1 when absent', () => {
    expect(indexOfSeq(new Uint8Array([1, 2]), new Uint8Array([3]))).toBe(-1)
  })
})

describe('ByteReader', () => {
  it('accumulates across chunk boundaries', async () => {
    const r = new ByteReader(streamOf([1, 2], [3, 4]))
    expect(await r.readAtLeast(3)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('throws when the stream ends before n bytes', async () => {
    const r = new ByteReader(streamOf([1]))
    await expect(r.readAtLeast(2)).rejects.toThrow()
  })

  // The reason this class exists: a proxy handshake reply and the first bytes of
  // tunnel payload routinely arrive in the same TCP segment. Dropping the tail
  // shows up much later as a stalled TLS handshake.
  it('hands back the bytes that followed the terminator', async () => {
    const head = new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n')
    const r = new ByteReader(streamOf([...head, 9, 9, 9]))
    const { head: h, rest } = await r.readUntilSeq(CRLF2, 8192)
    expect(new TextDecoder().decode(h)).toBe('HTTP/1.1 200 OK\r\n\r\n')
    expect(rest).toEqual(new Uint8Array([9, 9, 9]))
  })

  it('gives up past the limit instead of buffering forever', async () => {
    const r = new ByteReader(streamOf(Array(100).fill(0x41)))
    await expect(r.readUntilSeq(CRLF2, 10)).rejects.toThrow()
  })

  it('takes an exact count and keeps the remainder', async () => {
    const r = new ByteReader(streamOf([1, 2, 3, 4]))
    await r.readAtLeast(4)
    expect(r.take(2)).toEqual(new Uint8Array([1, 2]))
    expect(r.leftover()).toEqual(new Uint8Array([3, 4]))
  })
})

describe('concat', () => {
  it('joins chunks', () => {
    expect(concat([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(new Uint8Array([1, 2, 3]))
  })
})
