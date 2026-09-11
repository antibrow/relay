import { describe, expect, it } from 'vitest'
import { ByteReader } from '../src/core/bytes'
import { buildRequestBytes, readUpstreamResponse } from '../src/core/legacy-response'

const enc = new TextEncoder()

/** Feeds the response in caller-chosen slices, because a chunk-size line
 *  landing across a read boundary is exactly what breaks naive deframing. */
function streamOfStrings(...parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p))
      c.close()
    },
  })
}

async function drain(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  let out = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  return out
}

/** Like drain, but for bodies expected to error partway through: captures whatever
 *  content arrived before the error instead of letting it propagate out of the test. */
async function drainAllowingError(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  let out = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return { out, errored: false }
      out += new TextDecoder().decode(value)
    }
  } catch {
    return { out, errored: true }
  }
}

describe('buildRequestBytes', () => {
  it('uses origin form when talking straight to the origin', () => {
    const bytes = buildRequestBytes({
      method: 'GET', target: new URL('http://a.example/p?q=1'),
      headers: new Headers({ 'user-agent': 'x' }), absoluteForm: false,
    })
    const text = new TextDecoder().decode(bytes)
    expect(text.split('\r\n')[0]).toBe('GET /p?q=1 HTTP/1.1')
    expect(text).toContain('Host: a.example')
  })

  it('uses absolute form when talking to an http proxy, with credentials', () => {
    const bytes = buildRequestBytes({
      method: 'GET', target: new URL('http://a.example/p'), headers: new Headers(),
      absoluteForm: true, upstreamAuth: 'pu:pp',
    })
    const text = new TextDecoder().decode(bytes)
    expect(text.split('\r\n')[0]).toBe('GET http://a.example/p HTTP/1.1')
    expect(text).toContain(`Proxy-Authorization: Basic ${btoa('pu:pp')}`)
  })

  // The edge re-processes Content-Encoding on whatever we stream back, so a br or
  // gzip body passed through arrives with its header stripped and its bytes still
  // compressed. Asking the upstream for identity keeps that in one place.
  it('forces identity encoding and drops hop-by-hop headers', () => {
    const bytes = buildRequestBytes({
      method: 'GET', target: new URL('http://a.example/'),
      headers: new Headers({
        'accept-encoding': 'br, gzip', 'proxy-authorization': 'Basic zzz',
        'x-proxy-target': 'http://a.example/', connection: 'keep-alive', 'x-keep': 'yes',
      }),
      absoluteForm: false,
    })
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('Accept-Encoding: identity')
    expect(text.toLowerCase()).not.toContain('br, gzip')
    expect(text.toLowerCase()).not.toContain('basic zzz')
    expect(text.toLowerCase()).not.toContain('x-proxy-target')
    expect(text).toContain('x-keep: yes')
  })
})

describe('readUpstreamResponse', () => {
  it('reads a Content-Length body', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'))
    const res = await readUpstreamResponse(r)
    expect(res.status).toBe(200)
    expect(res.statusText).toBe('OK')
    expect(res.headers.get('content-length')).toBe('5')
    expect(await drain(res.body)).toBe('hello')
  })

  it('deframes a chunked body', async () => {
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      '5\r\nhello\r\n', '6\r\n world\r\n', '0\r\n\r\n',
    ))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('hello world')
    // Chunk framing is consumed, so the response we hand on must not advertise it.
    expect(res.headers.get('transfer-encoding')).toBeNull()
  })

  it('deframes when a chunk-size line is split across reads', async () => {
    // Chunk sizes are hex, so a 10-byte chunk is size token "0a": split before the
    // second digit lands the boundary inside the size line itself.
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      '0', 'a\r\n0123456789\r\n', '0\r\n\r\n',
    ))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('0123456789')
  })

  it('handles a chunk-size line with extensions', async () => {
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      '5;name=value\r\nhello\r\n0\r\n\r\n',
    ))
    expect(await drain((await readUpstreamResponse(r)).body)).toBe('hello')
  })

  it('reads until close when there is neither length nor chunking', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 200 OK\r\nX: y\r\n\r\n', 'abc', 'def'))
    expect(await drain((await readUpstreamResponse(r)).body)).toBe('abcdef')
  })

  it('handles body bytes that arrived with the header block', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n'))
    const res = await readUpstreamResponse(r)
    expect(res.status).toBe(204)
    expect(await drain(res.body)).toBe('')
  })

  it('rejects a malformed status line', async () => {
    const r = new ByteReader(streamOfStrings('garbage\r\n\r\n'))
    await expect(readUpstreamResponse(r)).rejects.toThrow()
  })

  it('reassembles chunk data that arrives across three separate reads', async () => {
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      'c\r\nhel', 'lo wor', 'ld!\r\n0\r\n\r\n',
    ))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('hello world!')
  })

  it('stops a chunked body at the zero chunk, not swallowing a trailer into it', async () => {
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      '5\r\nhello\r\n', '0\r\nX-Trailer: value\r\n\r\n',
    ))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('hello')
  })

  it('errors instead of closing quietly when the stream ends mid-chunk', async () => {
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      'a\r\nhello',
    ))
    const res = await readUpstreamResponse(r)
    const result = await drainAllowingError(res.body)
    expect(result.errored).toBe(true)
    expect(result.out).toBe('')
  })

  // RFC 7230 3.3.3: Content-Length must not survive alongside Transfer-Encoding.
  // We have already consumed the chunk framing, so a stale length here is the
  // response-smuggling shape: a consumer trusting it disagrees with the real body.
  it('drops a stray Content-Length when Transfer-Encoding is chunked', async () => {
    const r = new ByteReader(streamOfStrings(
      'HTTP/1.1 200 OK\r\nContent-Length: 999\r\nTransfer-Encoding: chunked\r\n\r\n',
      '5\r\nhello\r\n0\r\n\r\n',
    ))
    const res = await readUpstreamResponse(r)
    expect(res.headers.get('content-length')).toBeNull()
    expect(await drain(res.body)).toBe('hello')
  })

  it('delivers the bytes that arrived before failing a truncated Content-Length body', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n', 'hello'))
    const res = await readUpstreamResponse(r)
    const result = await drainAllowingError(res.body)
    expect(result.out).toBe('hello')
    expect(result.errored).toBe(true)
  })

  // A non-numeric length used to leave `remaining` as NaN: fixedBody's Math.min(NaN, 65536)
  // is NaN, readAtLeast(NaN) returns immediately, and the stream never closes or errors.
  it('reads until close when Content-Length is not a number', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\n', 'hello', ' world'))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('hello world')
  })

  it('reads until close when Content-Length is negative', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 200 OK\r\nContent-Length: -5\r\n\r\n', 'hello'))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('hello')
  })

  it('reads until close when Content-Length is empty', async () => {
    const r = new ByteReader(streamOfStrings('HTTP/1.1 200 OK\r\nContent-Length: \r\n\r\n', 'hello'))
    const res = await readUpstreamResponse(r)
    expect(await drain(res.body)).toBe('hello')
  })
})
