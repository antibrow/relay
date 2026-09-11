import { ByteReader } from './bytes'

const enc = new TextEncoder()
const dec = new TextDecoder()
const CRLF = enc.encode('\r\n')
const CRLF2 = enc.encode('\r\n\r\n')
const HEAD_LIMIT = 65536

/** Headers that describe this hop, not the request, plus the two this relay
 *  uses for its own routing and must never leak upstream. */
export const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'accept-encoding',
  'x-proxy-target',
]

export function buildRequestBytes(opts: {
  method: string
  target: URL
  headers: Headers
  absoluteForm: boolean
  upstreamAuth?: string
}): Uint8Array {
  const path = opts.absoluteForm ? opts.target.toString() : `${opts.target.pathname}${opts.target.search}`
  const lines = [`${opts.method} ${path} HTTP/1.1`, `Host: ${opts.target.host}`]
  // forEach, not for..of: this project's lib list omits DOM.Iterable, so Headers
  // has no Symbol.iterator under strict tsc even though it does at runtime.
  opts.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) lines.push(`${k}: ${v}`)
  })
  lines.push('Accept-Encoding: identity')
  if (opts.upstreamAuth) lines.push(`Proxy-Authorization: Basic ${btoa(opts.upstreamAuth)}`)
  lines.push('Connection: close')
  return enc.encode(`${lines.join('\r\n')}\r\n\r\n`)
}

export interface UpstreamResponse {
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array>
}

export async function readUpstreamResponse(reader: ByteReader): Promise<UpstreamResponse> {
  const { head, rest } = await reader.readUntilSeq(CRLF2, HEAD_LIMIT)
  // readUntilSeq hands back everything it already pulled past the terminator,
  // including the start of the body when it shared a read with the headers.
  reader.unshift(rest)
  const lines = dec.decode(head).split('\r\n')
  const statusLine = (lines.shift() ?? '').split(' ')
  const status = Number(statusLine[1])
  if (!statusLine[0]?.startsWith('HTTP/') || !Number.isFinite(status)) {
    throw new Error('upstream sent a malformed status line')
  }
  const statusText = statusLine.slice(2).join(' ')

  const headers = new Headers()
  let chunked = false
  let length: number | undefined
  for (const line of lines) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    const lower = name.toLowerCase()
    if (lower === 'transfer-encoding') {
      chunked = value.toLowerCase().includes('chunked')
      continue
    }
    if (lower === 'content-length') {
      // value is already trimmed, so Number('') would silently read as 0 - guard the
      // empty case explicitly rather than let it pass as a valid zero length.
      const parsed = value === '' ? NaN : Number(value)
      // An unparseable length is not a length. Falling through to the read-to-close
      // path is what RFC 7230 asks for, and it is what keeps NaN out of fixedBody's
      // arithmetic, where it would otherwise produce an endless stream of empty chunks.
      length = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }
    if (lower === 'connection' || lower === 'keep-alive') continue
    headers.append(name, value)
  }
  // RFC 7230: a Content-Length arriving alongside chunked framing must not survive.
  // We have consumed the framing, so a declared length would describe bytes that no
  // longer exist - and a consumer trusting it is the smuggling case.
  if (chunked) headers.delete('content-length')

  const body = chunked ? chunkedBody(reader) : fixedBody(reader, length)
  return { status, statusText, headers, body }
}

function chunkedBody(reader: ByteReader): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { head, rest } = await reader.readUntilSeq(CRLF, 1024)
        reader.unshift(rest)
        // The size line may carry extensions after a semicolon.
        const sizeText = dec.decode(head).split(';')[0]?.trim() ?? ''
        const size = parseInt(sizeText, 16)
        if (!Number.isFinite(size)) throw new Error('upstream sent a bad chunk size')
        if (size === 0) {
          controller.close()
          reader.release()
          return
        }
        await reader.readAtLeast(size + 2)
        controller.enqueue(reader.take(size))
        reader.take(2)
      } catch (e) {
        controller.error(e)
      }
    },
    cancel() {
      reader.release()
    },
  })
}

function fixedBody(reader: ByteReader, length: number | undefined): ReadableStream<Uint8Array> {
  let remaining = length
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        controller.close()
        reader.release()
        return
      }
      try {
        const want = remaining === undefined ? 1 : Math.min(remaining, 65536)
        await reader.readAtLeast(want)
        const piece = reader.take(remaining === undefined ? Number.MAX_SAFE_INTEGER : want)
        controller.enqueue(piece)
        if (remaining !== undefined) remaining -= piece.length
      } catch (e) {
        // A declared length the connection never delivered is a truncated response,
        // not the end of an unbounded one. Pass on what arrived, then fail, so a
        // caller can never mistake truncation for completeness.
        const tail = reader.leftover()
        if (tail.length) controller.enqueue(tail)
        reader.release()
        if (remaining === undefined) controller.close()
        else controller.error(e)
      }
    },
    cancel() {
      reader.release()
    },
  })
}
